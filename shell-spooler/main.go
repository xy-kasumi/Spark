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
		TimeAdded: toUnixTimestamp(job.TimeAdded),
	}
	if job.TimeStarted != nil {
		timeStarted := toUnixTimestamp(*job.TimeStarted)
		jobInfo.TimeStarted = &timeStarted
	}
	if job.TimeEnded != nil {
		timeEnded := toUnixTimestamp(*job.TimeEnded)
		jobInfo.TimeEnded = &timeEnded
	}
	return jobInfo
}

func mapPState(ps PStateWithTime) PStateRecord {
	kv := make(map[string]interface{})
	for _, k := range ps.PState.Keys() {
		v, _ := ps.PState.GetAny(k)
		kv[k] = v
	}
	return PStateRecord{
		Time: toUnixTimestamp(ps.Time),
		KV:   kv,
	}
}

func toUnixTimestamp(t time.Time) float64 {
	return float64(t.UnixNano()) / 1e9
}

type apiImpl struct {
	commInstance *comm.Comm
	jobSched     *JobSched

	tsDB *TSDB
	psDB *PSDB

	// line serialization
	lineMu      sync.Mutex
	nextLineNum int
	lineDB      *LineDB
	logger      *PayloadLogger

	initFileAbs string
}

func (h *apiImpl) PayloadSent(payload string, tm time.Time) {
	h.addLineAtomic("down", payload)
}

func (h *apiImpl) PayloadRecv(payload string, tm time.Time) {
	h.addLineAtomic("up", payload)
}

func (h *apiImpl) PStateRecv(ps comm.PState, tm time.Time) {
	for _, k := range ps.Keys() {
		v, _ := ps.GetAny(k)
		h.tsDB.Insert(ps.Tag+"."+k, tm, v)
	}
	h.psDB.AddPS(ps, tm)
}

func (h *apiImpl) addLineAtomic(dir string, payload string) {
	h.lineMu.Lock()
	defer h.lineMu.Unlock()

	lineNum := h.nextLineNum
	h.nextLineNum++

	h.lineDB.AddLine(lineNum, dir, payload)
	h.logger.AddLine(lineNum, dir, payload)
}

// SpoolerAPI implementation
func (h *apiImpl) WriteLine(req *WriteLineRequest) (*WriteLineResponse, error) {
	payload := req.Line
	if comm.IsSignal(payload) {
		h.commInstance.SendSignal(payload)
	} else {
		if h.jobSched.HasPendingJob() {
			return &WriteLineResponse{
				OK:   false,
				Time: toUnixTimestamp(time.Now()),
			}, nil
		}
		h.commInstance.WriteCommand(req.Line)
	}
	resp := WriteLineResponse{
		OK:   true,
		Time: toUnixTimestamp(time.Now()),
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
		Now:   toUnixTimestamp(time.Now()),
	}
	for i, l := range lines {
		resp.Lines[i] = LineInfo{
			LineNum: l.num,
			Dir:     l.dir,
			Content: l.content,
			Time:    toUnixTimestamp(l.time),
		}
	}
	return &resp, nil
}

func (h *apiImpl) Cancel(req *CancelRequest) (*CancelResponse, error) {
	ok := h.jobSched.CancelJob()
	if !ok {
		// Need to drain command queue ourselves
		h.commInstance.DrainCommandQueue()
	}
	h.commInstance.SendSignal("!")
	return &CancelResponse{}, nil
}

func (h *apiImpl) GetStatus(req *GetStatusRequest) (*GetStatusResponse, error) {
	numCommands := h.commInstance.CommandQueueLength()
	resp := GetStatusResponse{
		Busy:               numCommands > 0,
		NumPendingCommands: numCommands,
	}
	if jobID, ok := h.jobSched.FindRunningJobID(); ok {
		resp.RunningJob = &jobID
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
	// Convert Unix timestamps to time.Time
	tmStart := time.Unix(0, int64(req.Start*1e9))
	tmEnd := time.Unix(0, int64(req.End*1e9))
	step := time.Duration(int64(req.Step * 1e9))

	ts, valsMap := h.tsDB.QueryRanges(req.Query, tmStart, tmEnd, step)

	tsF64 := make([]float64, len(ts))
	for i, t := range ts {
		tsF64[i] = float64(t.UnixNano()) * 1e-9
	}
	jsonMap := make(map[string][]interface{})
	for k, vals := range valsMap {
		jsonVals := make([]interface{}, len(vals))
		for i, v := range vals {
			jsonVals[i] = v
		}
		jsonMap[k] = jsonVals
	}

	resp := &QueryTSResponse{
		Times:  tsF64,
		Values: jsonMap,
	}
	return resp, nil
}

func (h *apiImpl) GetPS(req *GetPSRequest) (*GetPSResponse, error) {
	count := 1
	if req.Count != nil {
		count = *req.Count
	}
	pss := h.psDB.GetLatestPS(req.Tag, count)

	records := make([]PStateRecord, len(pss))
	for i, ps := range pss {
		records[i] = mapPState(ps)
	}
	resp := &GetPSResponse{
		PStates: records,
	}
	return resp, nil
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
	lineDB := NewLineDB()
	tsDB := NewTSDB()
	psDB := NewPSDB()

	logger := NewPayloadLogger(logDirAbs)
	defer logger.Close()

	_, err = fetchInitLines(initFileAbs) // Prepare the file to detect path error early
	if err != nil {
		slog.Error("Init file error", "error", err)
		return
	}

	// Initialize communication & server impl.
	apiImpl := &apiImpl{
		lineDB:      lineDB,
		tsDB:        tsDB,
		psDB:        psDB,
		logger:      logger,
		nextLineNum: 1,
	}

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
