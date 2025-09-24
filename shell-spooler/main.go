// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later
package main

import (
	"flag"
	"fmt"
	"log/slog"
	"path/filepath"
	"regexp"
	"sync"
	"time"

	"shell-spooler/comm"
)

func mapJob(job Job) JobInfo {
	jobInfo := JobInfo{
		JobID:     job.ID,
		Status:    string(job.Status),
		TimeAdded: formatSpoolerTime(job.TimeAdded),
	}
	if job.TimeStarted != nil {
		timeStarted := formatSpoolerTime(*job.TimeStarted)
		jobInfo.TimeStarted = &timeStarted
	}
	if job.TimeEnded != nil {
		timeEnded := formatSpoolerTime(*job.TimeEnded)
		jobInfo.TimeEnded = &timeEnded
	}
	return jobInfo
}

type apiImpl struct {
	commInstance *comm.Comm
	jobSched     *JobSched

	// line serialization
	lineMu      sync.Mutex
	nextLineNum int
	lineDB      *LineDB
	logger      *PayloadLogger

	initFileAbs string
}

func (h *apiImpl) PayloadSent(payload string) {
	h.addLineAtomic("down", payload)
}

func (h *apiImpl) PayloadRecv(payload string) {
	h.addLineAtomic("up", payload)
}

func (h *apiImpl) PStateRecv(ps comm.PState) {
	// TBD
}

func (h *apiImpl) addLineAtomic(dir string, payload string) {
	h.lineMu.Lock()
	defer h.lineMu.Unlock()

	lineNum := h.nextLineNum
	h.nextLineNum++

	h.lineDB.AddLine(lineNum, dir, payload)
	h.logger.AddLine(lineNum, dir, payload)
}

func (h *apiImpl) Close() {
	h.logger.Close()
}

// SpoolerAPI implementation
func (h *apiImpl) WriteLine(req *WriteLineRequest) (*WriteLineResponse, error) {
	if h.jobSched.HasPendingJob() {
		return &WriteLineResponse{
			OK:   false,
			Time: formatSpoolerTime(time.Now()),
		}, nil
	}
	h.commInstance.Write(req.Line)
	resp := WriteLineResponse{
		OK:   true,
		Time: formatSpoolerTime(time.Now()),
	}
	return &resp, nil
}

func (h *apiImpl) QueryLines(req *QueryLinesRequest) (*QueryLinesResponse, error) {
	// Compile regex if provided
	var filterRegex *regexp.Regexp
	if req.FilterRegex != "" {
		filterRegex, _ = regexp.Compile(req.FilterRegex)
	}

	// Build query options
	opts := QueryOptions{
		FilterDir:   req.FilterDir,
		FilterRegex: filterRegex,
	}

	// Build scan range
	tailExists := req.Tail != nil
	rangeExists := req.FromLine != nil || req.ToLine != nil
	if tailExists {
		opts.Scan = TailScan{N: *req.Tail}
	} else if rangeExists {
		rangeScan := RangeScan{}
		if req.FromLine != nil {
			rangeScan.FromLine = req.FromLine
		}
		if req.ToLine != nil {
			rangeScan.ToLine = req.ToLine
		}
		opts.Scan = rangeScan
	}

	// Query lines from storage
	lines := h.lineDB.Query(opts)

	totalCount := len(lines)
	const maxLines = 1000 // Limit response to 1000 lines
	if len(lines) > maxLines {
		lines = lines[:maxLines]
	}

	// Convert to response format
	resp := QueryLinesResponse{
		Count: totalCount,
		Lines: make([]LineInfo, len(lines)),
		Now:   formatSpoolerTime(time.Now()),
	}
	for i, l := range lines {
		resp.Lines[i] = LineInfo{
			LineNum: l.num,
			Dir:     l.dir,
			Content: l.content,
			Time:    formatSpoolerTime(l.time),
		}
	}
	return &resp, nil
}

func (h *apiImpl) ClearQueue(req *ClearQueueRequest) (*ClearQueueResponse, error) {
	h.commInstance.DrainCommandQueue()
	// TODO: cancel running job
	return &ClearQueueResponse{}, nil
}

func (h *apiImpl) GetStatus(req *GetStatusRequest) (*GetStatusResponse, error) {
	resp := GetStatusResponse{
		Busy: h.commInstance.CommandQueueLength() > 0,
		CommandQueue: CommandQueue{
			Spooler: h.commInstance.CommandQueueLength(),
			Core:    0, // TBD: get from core
			Job:     0, // TBD: get from job system
		},
	}
	return &resp, nil
}

func (h *apiImpl) SetInit(req *SetInitRequest) (*SetInitResponse, error) {
	if err := writeInitLines(h.initFileAbs, req.Lines); err != nil {
		return nil, fmt.Errorf("failed to write init file: %w", err)
	}
	slog.Info("Init lines updated")
	return &SetInitResponse{}, nil
}

func (h *apiImpl) GetInit(req *GetInitRequest) (*GetInitResponse, error) {
	lines, err := fetchInitLines(h.initFileAbs)
	if err != nil {
		return nil, fmt.Errorf("failed to read init file: %w", err)
	}
	return &GetInitResponse{Lines: lines}, nil
}

func (h *apiImpl) AddJob(req *AddJobRequest) (*AddJobResponse, error) {
	jobID, ok := h.jobSched.AddJob(req.Commands, req.Signals)
	if !ok {
		return &AddJobResponse{
			OK:    false,
			JobID: nil,
		}, nil
	}

	return &AddJobResponse{
		OK:    true,
		JobID: &jobID,
	}, nil
}

func (h *apiImpl) ListJobs(req *ListJobsRequest) (*ListJobsResponse, error) {
	jobs := h.jobSched.ListJobs()
	jobInfos := make([]JobInfo, len(jobs))
	for i, job := range jobs {
		jobInfos[i] = mapJob(job)
	}

	return &ListJobsResponse{
		Jobs: jobInfos,
	}, nil
}

func (h *apiImpl) QueryTS(req *QueryTSRequest) (*QueryTSResponse, error) {
	return nil, fmt.Errorf("not implemented")
}

func main() {
	// Flag resolution
	portName := flag.String("port", "COM3", "Serial port name")
	baud := flag.Int("baud", 115200, "Serial port baud rate")
	addr := flag.String("addr", ":9000", "HTTP listen address")
	logDir := flag.String("log-dir", "logs", "Directory for log files (relative to current directory)")
	initFile := flag.String("init-file", "init.txt", "Init file path")
	verbose := flag.Bool("verbose", false, "Verbose logging")
	flag.Parse()

	if verbose != nil && *verbose {
		slog.SetLogLoggerLevel(slog.LevelDebug)
	}

	logDirAbs, err := filepath.Abs(*logDir)
	if err != nil {
		slog.Error("Failed to resolve log directory path", "logDir", *logDir, "error", err)
		return
	}

	initFileAbs, err := filepath.Abs(*initFile)
	if err != nil {
		slog.Error("Failed to resolve init file path", "initFile", *initFile, "error", err)
		return
	}

	slog.Info("Using log directory", "path", logDirAbs)
	slog.Info("Using init file", "path", initFileAbs)

	// Storage & payload loggers
	storage := NewLineDB()

	logger := NewPayloadLogger(logDirAbs)
	defer logger.Close()

	_, err = fetchInitLines(initFileAbs) // Prepare the file to detect path error early
	if err != nil {
		slog.Error("Init file error", "error", err)
		return
	}

	// Initialize communication & server impl.
	apiImpl := &apiImpl{
		lineDB:      storage,
		logger:      logger,
		nextLineNum: 1,
	}
	defer apiImpl.Close()

	commInstance, err := comm.InitComm(*portName, *baud, apiImpl)
	if err != nil {
		slog.Error("Failed to initialize comm", "port", portName, "baud", baud, "error", err)
		return
	}
	defer commInstance.Close()

	jobSched := InitJobSched(commInstance)

	apiImpl.commInstance = commInstance
	apiImpl.initFileAbs = initFileAbs
	apiImpl.jobSched = jobSched

	// Start HTTP server
	slog.Info("HTTP server starting", "port", *addr)
	if err := StartHTTPServer(*addr, apiImpl); err != nil {
		slog.Error("HTTP server error", "error", err)
	}
}
