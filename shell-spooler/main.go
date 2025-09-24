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

type JobStatus string

const (
	JobWaiting   JobStatus = "WAITING"
	JobRunning   JobStatus = "RUNNING"
	JobCompleted JobStatus = "COMPLETED"
	JobCanceled  JobStatus = "CANCELED"
)

type Job struct {
	ID          string
	Commands    []string
	Signals     map[string]float32
	Status      JobStatus
	TimeAdded   time.Time
	TimeStarted *time.Time
	TimeEnded   *time.Time
}

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
	lineDB *LineDB
	logger *PayloadLogger

	// line serialization
	lineNumMu   sync.Mutex
	nextLineNum int

	// job management
	jobsMu    sync.Mutex
	jobs      []Job
	nextJobID int

	// dependencies for SpoolerAPI
	commInstance *comm.Comm
	initFileAbs  string
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
	h.lineNumMu.Lock()
	defer h.lineNumMu.Unlock()

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
	if h.hasPendingJob() {
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
	h.jobsMu.Lock()
	defer h.jobsMu.Unlock()

	if h.hasPendingJob() || h.commInstance.CommandQueueLength() > 0 {
		return &AddJobResponse{
			OK:    false,
			JobID: nil,
		}, nil
	}

	// Generate job ID
	jobID := fmt.Sprintf("jb%d", h.nextJobID)
	h.nextJobID++

	// Create new job
	job := Job{
		ID:        jobID,
		Commands:  req.Commands,
		Signals:   req.Signals,
		Status:    JobWaiting,
		TimeAdded: time.Now(),
	}

	// Add to jobs list
	h.jobs = append(h.jobs, job)

	return &AddJobResponse{
		OK:    true,
		JobID: &jobID,
	}, nil
}

func (h *apiImpl) ListJobs(req *ListJobsRequest) (*ListJobsResponse, error) {
	h.jobsMu.Lock()
	defer h.jobsMu.Unlock()

	jobInfos := make([]JobInfo, len(h.jobs))
	for i, job := range h.jobs {
		jobInfos[i] = mapJob(job)
	}

	return &ListJobsResponse{
		Jobs: jobInfos,
	}, nil
}

func (h *apiImpl) QueryTS(req *QueryTSRequest) (*QueryTSResponse, error) {
	return nil, fmt.Errorf("not implemented")
}

func (h *apiImpl) hasPendingJob() bool {
	h.jobsMu.Lock()
	defer h.jobsMu.Unlock()

	for _, job := range h.jobs {
		if job.Status == JobWaiting || job.Status == JobRunning {
			return true
		}
	}
	return false
}

func (h *apiImpl) findWaitingJob() *Job {
	h.jobsMu.Lock()
	defer h.jobsMu.Unlock()

	for i := range h.jobs {
		if h.jobs[i].Status == JobWaiting {
			return &h.jobs[i]
		}
	}
	return nil
}

func (h *apiImpl) keepSendingSignals(signal string, value float32) {
	interval := time.Duration(value * float32(time.Second))
	for {
		time.Sleep(interval)
		h.commInstance.Write(signal)
	}
}

func (h *apiImpl) keepExecutingJobs() {
	for {
		// Wait until a job become runnable.
		var job *Job
		for {
			job = h.findWaitingJob()
			if job != nil && h.commInstance.CommandQueueLength() == 0 {
				break
			}
			time.Sleep(500 * time.Millisecond)
		}

		// Execute job
		tStart := time.Now().Local()
		job.Status = JobRunning
		job.TimeStarted = &tStart

		for signal, value := range job.Signals {
			go h.keepSendingSignals(signal, value)
		}
		for _, command := range job.Commands {
			h.commInstance.Write(command)
		}

		// Wait job completion (== cmd queue become empty)
		for {
			if h.commInstance.CommandQueueLength() == 0 {
				break
			}
			time.Sleep(100 * time.Millisecond)
		}

		// Mark job as completed
		tEnd := time.Now().Local()
		job.Status = JobCompleted
		job.TimeEnded = &tEnd
	}
}

func main() {
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

	// Resolve full paths
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

	storage := NewLineDB()

	logger := NewPayloadLogger(logDirAbs)
	defer logger.Close()

	apiImpl := &apiImpl{
		lineDB:      storage,
		logger:      logger,
		nextLineNum: 1,
		nextJobID:   1,
	}
	defer apiImpl.Close()

	commInstance, err := comm.InitComm(*portName, *baud, apiImpl)
	if err != nil {
		slog.Error("Failed to initialize comm", "port", portName, "baud", baud, "error", err)
		return
	}
	defer commInstance.Close()

	// Handle init file - always check and prepare init file so we can detect path error before starting server
	_, err = fetchInitLines(initFileAbs)
	if err != nil {
		slog.Error("Init file error", "error", err)
		return
	}

	// Initialize handler with dependencies
	apiImpl.commInstance = commInstance
	apiImpl.initFileAbs = initFileAbs

	// Start job execution goroutine
	go apiImpl.keepExecutingJobs()

	// Start HTTP server
	slog.Info("HTTP server starting", "port", *addr)
	if err := StartHTTPServer(*addr, apiImpl); err != nil {
		slog.Error("HTTP server error", "error", err)
	}
}
