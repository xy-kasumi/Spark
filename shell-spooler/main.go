// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later
package main

import (
	"flag"
	"fmt"
	"log/slog"
	"path/filepath"
	"sync/atomic"
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

// Session bundles the resources that exist only while the device is alive.
type Session struct {
	cm     *comm.Comm
	logger *PayloadLogger
}

// sessionHandler is the CommHandler attached to a session's Comm. It routes payloads
// to the per-session log and p-state updates to the cross-session databases.
type sessionHandler struct {
	logger   *PayloadLogger
	tsDB     *TSDB
	psDB     *PSDB
	jobSched *JobSched
}

func (sh *sessionHandler) PayloadSent(payload string, tm time.Time) {
	sh.logger.AddLine("down", payload)
}

func (sh *sessionHandler) PayloadRecv(payload string, tm time.Time) {
	sh.logger.AddLine("up", payload)
}

func (sh *sessionHandler) PStateRecv(ps comm.PState, tm time.Time) {
	for _, k := range ps.Keys() {
		v, _ := ps.GetAny(k)
		sh.tsDB.Insert(ps.Tag+"."+k, tm, v)
	}
	sh.psDB.AddPS(ps, tm)

	// A fault event means the device entered fault mode and silently ignores
	// writes; the session stays up, but any pending/running jobs can no longer
	// make progress, so fail them.
	if ps.Tag == "sys" {
		if ev, ok := ps.GetString("ev"); ok && ev == "fault" {
			sh.jobSched.FailRunningJobs()
		}
	}
}

type apiImpl struct {
	session atomic.Pointer[Session]

	jobSched *JobSched
	tsDB     *TSDB
	psDB     *PSDB

	initFileAbs string
}

// SpoolerAPI implementation
func (h *apiImpl) WriteLine(req *WriteLineRequest) (*WriteLineResponse, error) {
	s := h.session.Load()
	if s == nil {
		return &WriteLineResponse{OK: false, Time: toUnixTimestamp(time.Now())}, nil
	}
	if req.HighPrio {
		s.cm.SendImmediate(req.Line)
	} else {
		if h.jobSched.HasPendingJob() {
			return &WriteLineResponse{OK: false, Time: toUnixTimestamp(time.Now())}, nil
		}
		s.cm.WriteCommand(req.Line)
	}
	return &WriteLineResponse{OK: true, Time: toUnixTimestamp(time.Now())}, nil
}

func (h *apiImpl) Cancel(req *CancelRequest) (*CancelResponse, error) {
	s := h.session.Load()
	if s == nil {
		return &CancelResponse{}, nil
	}
	if !h.jobSched.CancelJob() {
		// Need to drain command queue ourselves
		s.cm.DrainCommandQueue()
	}
	s.cm.SendImmediate("!")
	return &CancelResponse{}, nil
}

func (h *apiImpl) GetStatus(req *GetStatusRequest) (*GetStatusResponse, error) {
	resp := GetStatusResponse{Time: toUnixTimestamp(time.Now())}
	s := h.session.Load()
	if s == nil {
		return &resp, nil
	}
	resp.DeviceAlive = true
	numCommands := s.cm.CommandQueueLength()
	resp.Busy = numCommands > 0
	resp.NumPendingCommands = numCommands
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
	jobID, ok := h.jobSched.AddJob(req.Commands, req.Polls)
	if !ok {
		return &AddJobResponse{OK: false, JobID: nil}, nil
	}
	return &AddJobResponse{OK: true, JobID: &jobID}, nil
}

func (h *apiImpl) ListJobs(req *ListJobsRequest) (*ListJobsResponse, error) {
	jobs := h.jobSched.ListJobs()
	jobInfos := make([]JobInfo, len(jobs))
	for i, job := range jobs {
		jobInfos[i] = mapJob(job)
	}
	return &ListJobsResponse{Jobs: jobInfos}, nil
}

func (h *apiImpl) QueryTS(req *QueryTSRequest) (*QueryTSResponse, error) {
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

	return &QueryTSResponse{Times: tsF64, Values: jsonMap}, nil
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
	return &GetPSResponse{PStates: records}, nil
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

	if _, err := fetchInitLines(initFileAbs); err != nil {
		slog.Error("Init file error", "error", err)
		return
	}

	// Cross-session resources
	tsDB := NewTSDB()
	psDB := NewPSDB()
	jobSched := InitJobSched()

	api := &apiImpl{
		jobSched:    jobSched,
		tsDB:        tsDB,
		psDB:        psDB,
		initFileAbs: initFileAbs,
	}

	tran, err := comm.OpenTransport(*portName, *baud)
	if err != nil {
		slog.Error("Failed to open serial transport", "port", *portName, "baud", *baud, "error", err)
		return
	}
	defer tran.Close()

	// HTTP server runs in parallel with the session loop.
	slog.Info("HTTP server starting", "addr", *addr)
	go func() {
		if err := StartHTTPServer(*addr, api); err != nil {
			slog.Error("HTTP server error", "error", err)
		}
	}()

	for {
		comm.WaitAlive(tran)

		slog.Info("Session started")
		logger := NewPayloadLogger(logDirAbs)
		handler := &sessionHandler{logger: logger, tsDB: tsDB, psDB: psDB, jobSched: jobSched}
		cm := comm.AttachComm(tran, handler)
		api.session.Store(&Session{cm: cm, logger: logger})
		jobSched.SetComm(cm)

		// Initialize the freshly-alive core with the init lines. Read from file
		// each session so /set-init edits take effect on the next session.
		if initLines, err := fetchInitLines(initFileAbs); err != nil {
			slog.Error("Failed to read init file; skipping core init", "error", err)
		} else if len(initLines) > 0 {
			for _, line := range initLines {
				cm.WriteCommand(line)
			}
			slog.Info("Sent init lines", "count", len(initLines))
		}

		cm.WaitDead()
		slog.Info("Session ended (device dead)")

		api.session.Store(nil)
		jobSched.SetComm(nil)
		jobSched.FailRunningJobs()
		cm.Close()
		logger.Close()
	}
}
