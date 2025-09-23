// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later
package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// Line-based API
type writeLineRequest struct {
	Line string `json:"line"` // single line of command. cannot contain newline.
}

type writeLineResponse struct {
	Now string `json:"now"`
}

type queryLinesRequest struct {
	FromLine    *int   `json:"from_line,omitempty"`    // Optional: start from this line number (inclusive), 1-based
	ToLine      *int   `json:"to_line,omitempty"`      // Optional: up to this line number (exclusive), 1-based
	Tail        *int   `json:"tail,omitempty"`         // Optional: get last N lines (overrides from/to)
	FilterDir   string `json:"filter_dir,omitempty"`   // Optional: "up" or "down" direction filter
	FilterRegex string `json:"filter_regex,omitempty"` // Optional: regex filter (RE2 syntax)
}

type queryLinesResponse struct {
	Count int        `json:"count"` // total number of matching lines
	Lines []lineInfo `json:"lines"` // actual lines (max 1000), ordered by line number (ascending)
	Now   string     `json:"now"`   // current recognized time of spooler in format "2006-01-02 15:04:05.000" (local time)
}

type lineInfo struct {
	LineNum int    `json:"line_num"`
	Dir     string `json:"dir"`     // "up" for client->host, "down" for host->client
	Content string `json:"content"` // content of the line, without newlines
	Time    string `json:"time"`    // timestamp of the line in format "2006-01-02 15:04:05.000" (local time)
}

type getStatusRequest struct {
}

type getStatusResponse struct {
	Busy bool `json:"busy"`
}

type clearQueueRequest struct {
}

type clearQueueResponse struct {
}

type setInitRequest struct {
	Lines []string `json:"lines"`
}

type setInitResponse struct {
}

type getInitRequest struct {
}

type getInitResponse struct {
	Lines []string `json:"lines"`
}

// handleCommon returns true if caller should continue RPC processing.
func handleCommom(w http.ResponseWriter, r *http.Request) bool {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return false
	}
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return false
	}
	return true
}

func respondJson(w http.ResponseWriter, resp any) {
	w.WriteHeader(http.StatusOK)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

func fetchInitLines(filePath string) ([]string, error) {
	// Check if init file exists
	if _, err := os.Stat(filePath); os.IsNotExist(err) {
		// Create empty init file
		if err := os.WriteFile(filePath, []byte(""), 0644); err != nil {
			return nil, fmt.Errorf("failed to create init file: %w", err)
		}
		slog.Info("Created empty init file", "path", filePath)
	} else if err != nil {
		return nil, fmt.Errorf("failed to check init file: %w", err)
	}

	// Read init file
	content, err := os.ReadFile(filePath)
	if err != nil {
		return nil, fmt.Errorf("failed to read init file: %w", err)
	}

	// Parse lines from init file
	var initLines []string
	if len(content) > 0 {
		lines := strings.Split(string(content), "\n")
		for _, line := range lines {
			line = strings.TrimSpace(line)
			if line != "" {
				initLines = append(initLines, line)
			}
		}
	}
	return initLines, nil
}

func writeInitLines(filePath string, lines []string) error {
	content := strings.Join(lines, "\n")
	if err := os.WriteFile(filePath, []byte(content), 0644); err != nil {
		return fmt.Errorf("failed to write init file: %w", err)
	}
	return nil
}

// path: URL path (e.g. "/write-line")
func registerJsonHandler[ReqT any, RespT any](path string, validate func(*ReqT) error, exec func(*ReqT) (*RespT, error)) {
	http.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {
		if !handleCommom(w, r) {
			return
		}

		slog.Debug(path)
		var req ReqT
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			fmt.Fprintf(w, "invalid JSON: %v", err)
			return
		}

		// Validate request
		err := validate(&req)
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			fmt.Fprintf(w, "invalid request: %v", err)
			return
		}

		resp, err := exec(&req)
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			slog.Error("error during API processing", "error", err)
			return
		}
		respondJson(w, resp)
	})
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

	// Initialize line storage
	storage := newLineStorage()

	// Initialize payload logger
	logger := NewPayloadLogger(logDirAbs)
	defer logger.Close()

	// Initialize serial protocol
	comm, err := initComm(*portName, *baud, storage, logger)
	if err != nil {
		slog.Error("Failed to initialize comm", "port", portName, "baud", baud, "error", err)
		return
	}
	defer comm.Close()

	// Handle init file - always check and prepare init file regardless of noinit flag
	_, err = fetchInitLines(initFileAbs)
	if err != nil {
		slog.Error("Init file error", "error", err)
		return
	}

	// Register RPC endpoints
	validateWriteLine := func(req *writeLineRequest) error {
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
	execWriteLine := func(req *writeLineRequest) (*writeLineResponse, error) {
		comm.writeLine(req.Line)

		resp := writeLineResponse{
			Now: formatSpoolerTime(time.Now()),
		}
		return &resp, nil
	}
	registerJsonHandler("/write-line", validateWriteLine, execWriteLine)

	validateQueryLines := func(req *queryLinesRequest) error {
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
	execQueryLines := func(req *queryLinesRequest) (*queryLinesResponse, error) {
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
		lines := storage.Query(opts)

		totalCount := len(lines)
		const maxLines = 1000 // Limit response to 1000 lines
		if len(lines) > maxLines {
			lines = lines[:maxLines]
		}

		// Convert to response format
		resp := queryLinesResponse{
			Count: totalCount,
			Lines: make([]lineInfo, len(lines)),
			Now:   formatSpoolerTime(time.Now()),
		}
		for i, l := range lines {
			resp.Lines[i] = lineInfo{
				LineNum: l.num,
				Dir:     l.dir,
				Content: l.content,
				Time:    formatSpoolerTime(l.time),
			}
		}
		return &resp, nil
	}
	registerJsonHandler("/query-lines", validateQueryLines, execQueryLines)

	validateClearQueue := func(req *clearQueueRequest) error {
		return nil
	}
	execClearQueue := func(req *clearQueueRequest) (*clearQueueResponse, error) {
		comm.drainWriteQueue()
		return &clearQueueResponse{}, nil
	}
	registerJsonHandler("/clear-queue", validateClearQueue, execClearQueue)

	validateGetStatus := func(req *getStatusRequest) error {
		return nil
	}
	execGetStatus := func(req *getStatusRequest) (*getStatusResponse, error) {
		resp := getStatusResponse{
			Busy: comm.writeQueueLength() > 0,
		}
		return &resp, nil
	}
	registerJsonHandler("/status", validateGetStatus, execGetStatus)

	validateSetInit := func(req *setInitRequest) error {
		for _, line := range req.Lines {
			if strings.Contains(line, "\n") {
				return errors.New("lines: must not contain newline")
			}
		}
		return nil
	}
	execSetInit := func(req *setInitRequest) (*setInitResponse, error) {
		if err := writeInitLines(initFileAbs, req.Lines); err != nil {
			return nil, fmt.Errorf("failed to write init file: %w", err)
		}
		slog.Info("Init lines updated")
		return &setInitResponse{}, nil
	}
	registerJsonHandler("/set-init", validateSetInit, execSetInit)

	validateGetInit := func(req *getInitRequest) error {
		return nil
	}
	execGetInit := func(req *getInitRequest) (*getInitResponse, error) {
		lines, err := fetchInitLines(initFileAbs)
		if err != nil {
			return nil, fmt.Errorf("failed to read init file: %w", err)
		}

		return &getInitResponse{Lines: lines}, nil
	}
	registerJsonHandler("/get-init", validateGetInit, execGetInit)

	slog.Info("HTTP server started", "port", *addr)
	if err := http.ListenAndServe(*addr, nil); err != nil {
		slog.Error("HTTP server error", "error", err)
	}
}
