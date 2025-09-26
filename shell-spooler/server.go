// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"regexp"
	"shell-spooler/comm"
	"strings"
	"time"
)

// Model of spooler HTTP API.
// Since request passed into SpoolerAPI is valid, returning error here means internal server error.
type SpoolerAPI interface {
	WriteLine(req *WriteLineRequest) (*WriteLineResponse, error)
	QueryLines(req *QueryLinesRequest) (*QueryLinesResponse, error)
	Cancel(req *CancelRequest) (*CancelResponse, error)
	SetInit(req *SetInitRequest) (*SetInitResponse, error)
	GetInit(req *GetInitRequest) (*GetInitResponse, error)
	GetStatus(req *GetStatusRequest) (*GetStatusResponse, error)
	AddJob(req *AddJobRequest) (*AddJobResponse, error)
	ListJobs(req *ListJobsRequest) (*ListJobsResponse, error)
	QueryTS(req *QueryTSRequest) (*QueryTSResponse, error)
}

type LineInfo struct {
	LineNum int     `json:"line_num"`
	Dir     string  `json:"dir"`     // "up" for client->host, "down" for host->client
	Content string  `json:"content"` // content of the line, without newlines
	Time    float64 `json:"time"`    // Unix timestamp
}

type WriteLineRequest struct {
	Line string `json:"line"` // single line of command. cannot contain newline.
}

type WriteLineResponse struct {
	OK   bool    `json:"ok"`
	Time float64 `json:"time"`
}

func validateWriteLine(req *WriteLineRequest) error {
	if strings.Contains(req.Line, "\n") {
		return errors.New("payload cannot contain newline")
	}
	if len(req.Line) > 100 {
		return errors.New("payload must be <= 100 byte")
	}
	if req.Line == "" {
		return errors.New("payload cannot be empty")
	}
	return nil
}

type QueryLinesRequest struct {
	FromLine    *int   `json:"from_line,omitempty"`    // Optional: start from this line number (inclusive), 1-based
	ToLine      *int   `json:"to_line,omitempty"`      // Optional: up to this line number (exclusive), 1-based
	Tail        *int   `json:"tail,omitempty"`         // Optional: get last N lines (overrides from/to)
	FilterDir   string `json:"filter_dir,omitempty"`   // Optional: "up" or "down" direction filter
	FilterRegex string `json:"filter_regex,omitempty"` // Optional: regex filter (RE2 syntax)
}

type QueryLinesResponse struct {
	Count int        `json:"count"` // total number of matching lines
	Lines []LineInfo `json:"lines"` // actual lines (max 1000), ordered by line number (ascending)
	Now   float64    `json:"now"`   // current Unix timestamp
}

func validateQueryLines(req *QueryLinesRequest) error {
	tailExists := req.Tail != nil
	rangeExists := req.FromLine != nil || req.ToLine != nil

	// Validate range parameters
	if tailExists && rangeExists {
		return errors.New("tail: cannot be used together ranges (from_line, to_line)")
	}
	if rangeExists {
		if req.FromLine != nil && *req.FromLine < 1 {
			return errors.New("from_line: must be >= 1")
		}
		if req.ToLine != nil && *req.ToLine < 1 {
			return errors.New("to_line: must be >= 1")
		}
		if (req.FromLine != nil && req.ToLine != nil) && *req.ToLine < *req.FromLine {
			return errors.New("to_line must be >= from_line")
		}
	}
	if tailExists && *req.Tail < 1 {
		return errors.New("tail: must be >= 1")
	}

	// Validate tail value if provided
	if tailExists && *req.Tail <= 0 {
		return errors.New("tail: must be positive")
	}

	// Validate filter_dir
	if req.FilterDir != "" && req.FilterDir != "up" && req.FilterDir != "down" {
		return errors.New("filter_dir: must be 'up' or 'down'")
	}

	// Compile regex if provided
	if req.FilterRegex != "" {
		_, err := regexp.Compile(req.FilterRegex)
		if err != nil {
			return fmt.Errorf("filter_regex: invalid regex %v", err)
		}
	}
	return nil
}

type CancelRequest struct {
}

type CancelResponse struct {
}

func validateCancel(req *CancelRequest) error {
	return nil
}

type SetInitRequest struct {
	Lines []string `json:"lines"`
}

type SetInitResponse struct {
}

func validateSetInit(req *SetInitRequest) error {
	for _, line := range req.Lines {
		if strings.Contains(line, "\n") {
			return errors.New("lines: must not contain newline")
		}
	}
	return nil
}

type GetInitRequest struct {
}

type GetInitResponse struct {
	Lines []string `json:"lines"`
}

func validateGetInit(req *GetInitRequest) error {
	return nil
}

type GetStatusRequest struct {
}

type CommandQueue struct {
	Spooler int `json:"spooler"`
	Core    int `json:"core"`
	Job     int `json:"job"`
}

type GetStatusResponse struct {
	Busy         bool         `json:"busy"`
	CommandQueue CommandQueue `json:"command_queue"`
}

func validateGetStatus(req *GetStatusRequest) error {
	return nil
}

type AddJobRequest struct {
	Commands []string           `json:"commands"`
	Signals  map[string]float32 `json:"signals"`
}

type AddJobResponse struct {
	OK    bool    `json:"ok"`
	JobID *string `json:"job_id,omitempty"`
}

func validateAddJob(req *AddJobRequest) error {
	for _, command := range req.Commands {
		if strings.Contains(command, "\n") || command == "" || comm.IsSignal(command) {
			return errors.New("invalid command")
		}
	}
	for signal, interval := range req.Signals {
		if strings.Contains(signal, "\n") || !strings.HasPrefix(signal, "?") || !comm.IsSignal(signal) {
			return errors.New("invalid signal")
		}
		if interval <= 0 {
			return errors.New("signal interval: must be > 0")
		}
	}
	return nil
}

type ListJobsRequest struct {
}

type JobInfo struct {
	JobID       string   `json:"job_id"`
	Status      string   `json:"status"` // "WAITING", "RUNNING", "COMPLETED", "CANCELED"
	TimeAdded   float64  `json:"time_added"`
	TimeStarted *float64 `json:"time_started,omitempty"`
	TimeEnded   *float64 `json:"time_ended,omitempty"`
}

type ListJobsResponse struct {
	Jobs []JobInfo `json:"jobs"`
}

func validateListJobs(req *ListJobsRequest) error {
	return nil
}

type QueryTSRequest struct {
	Start float64  `json:"start"`
	End   float64  `json:"end"`
	Step  float32  `json:"step"`
	Query []string `json:"query"`
}

type QueryTSResponse struct {
	Times  []float64                `json:"times"`
	Values map[string][]interface{} `json:"values"`
}

func validateQueryTS(req *QueryTSRequest) error {
	if len(req.Query) == 0 {
		return errors.New("query: cannot be empty")
	}
	if req.Start < 0 {
		return errors.New("start: must be >= 0")
	}
	if req.End < 0 {
		return errors.New("end: must be >= 0")
	}
	if req.End < req.Start {
		return errors.New("end: must be >= start")
	}
	if req.Step <= 0 {
		return errors.New("step: must be > 0")
	}
	if (req.End-req.Start)/float64(req.Step) > 10000 {
		return errors.New("too many steps")
	}
	if len(req.Query) > 1000 {
		return errors.New("query: too many")
	}
	return nil
}

func registerJsonHandler[ReqT any, RespT any](path string, validate func(*ReqT) error, exec func(*ReqT) (*RespT, error)) {
	http.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {
		// Handle CORS and method validation
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}

		// Decode & validate
		var req ReqT
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			fmt.Fprintf(w, "invalid JSON: %v", err)
			return
		}

		err := validate(&req)
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			fmt.Fprintf(w, "invalid request: %v", err)
			return
		}

		// Execute
		slowTimer := time.AfterFunc(1*time.Second, func() {
			body, err := json.Marshal(req)
			dumpBody := "unknown"
			if err == nil {
				dumpBody = string(body)
			}
			slog.Warn("API exec taking more than 1 second", "path", path, "req", dumpBody)
		})
		resp, err := exec(&req)
		slowTimer.Stop()
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}

		// Send response as JSON
		w.WriteHeader(http.StatusOK)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	})
}

func StartHTTPServer(addr string, api SpoolerAPI) error {
	registerJsonHandler("/write-line", validateWriteLine, api.WriteLine)
	registerJsonHandler("/query-lines", validateQueryLines, api.QueryLines)
	registerJsonHandler("/cancel", validateCancel, api.Cancel)
	registerJsonHandler("/status", validateGetStatus, api.GetStatus)
	registerJsonHandler("/set-init", validateSetInit, api.SetInit)
	registerJsonHandler("/get-init", validateGetInit, api.GetInit)
	registerJsonHandler("/add-job", validateAddJob, api.AddJob)
	registerJsonHandler("/list-jobs", validateListJobs, api.ListJobs)
	registerJsonHandler("/query-ts", validateQueryTS, api.QueryTS)

	return http.ListenAndServe(addr, nil)
}
