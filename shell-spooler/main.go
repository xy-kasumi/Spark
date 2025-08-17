// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// Line-based API
type writeLineRequest struct {
	Line string `json:"line"` // single line of command. cannot contain newline.
}

type writeLineResponse struct {
	LineNum int    `json:"line_num"`
	Time    string `json:"time"`
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

func main() {
	portName := flag.String("port", "COM3", "Serial port name")
	baud := flag.Int("baud", 115200, "Serial port baud rate")
	addr := flag.String("addr", ":9000", "HTTP listen address")
	logDir := flag.String("log-dir", "logs", "Directory for log files (relative to current directory)")
	verbose := flag.Bool("verbose", false, "Verbose logging")
	flag.Parse()

	if verbose != nil && *verbose {
		slog.SetLogLoggerLevel(slog.LevelDebug)
	}

	// Initialize line storage
	storage := newLineStorage(*logDir)
	defer storage.Close()

	// Initialize serial protocol
	ser := initSerial(*portName, *baud, storage)
	if ser == nil {
		return
	}
	defer ser.Close()

	// HTTP handler to write a single line
	http.HandleFunc("/write-line", func(w http.ResponseWriter, r *http.Request) {
		if !handleCommom(w, r) {
			return
		}

		slog.Debug("/write-line")
		var req writeLineRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			fmt.Fprintf(w, "invalid JSON: %v", err)
			return
		}

		// Validate request
		if strings.Contains(req.Line, "\n") {
			w.WriteHeader(http.StatusBadRequest)
			fmt.Fprintf(w, "line cannot contain newline")
			return
		}

		// Write to serial
		ser.writeLine(req.Line)

		// Add to storage
		lineNum, timestamp := storage.addLine("down", req.Line)

		resp := writeLineResponse{
			LineNum: lineNum,
			Time:    formatSpoolerTime(timestamp),
		}
		respondJson(w, &resp)
	})

	// HTTP handler to query lines
	http.HandleFunc("/query-lines", func(w http.ResponseWriter, r *http.Request) {
		if !handleCommom(w, r) {
			return
		}

		slog.Debug("/query-lines")
		var req queryLinesRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			fmt.Fprintf(w, "invalid JSON: %v", err)
			return
		}

		tailExists := req.Tail != nil
		rangeExists := req.FromLine != nil || req.ToLine != nil

		// Validate range parameters
		if tailExists && rangeExists {
			w.WriteHeader(http.StatusBadRequest)
			fmt.Fprintf(w, "tail: cannot be used together ranges (from_line, to_line)")
			return
		}
		if rangeExists {
			if req.FromLine != nil && *req.FromLine < 1 {
				w.WriteHeader(http.StatusBadRequest)
				fmt.Fprintf(w, "from_line: must be >= 1")
				return
			}
			if req.ToLine != nil && *req.ToLine < 1 {
				w.WriteHeader(http.StatusBadRequest)
				fmt.Fprintf(w, "to_line: must be >= 1")
				return
			}

			if (req.FromLine != nil && req.ToLine != nil) && *req.ToLine < *req.FromLine {
				w.WriteHeader(http.StatusBadRequest)
				fmt.Fprintf(w, "to_line must be >= from_line")
				return
			}
		}
		if tailExists && *req.Tail < 1 {
			w.WriteHeader(http.StatusBadRequest)
			fmt.Fprintf(w, "tail: must be >= 1")
			return
		}

		// Validate tail value if provided
		if tailExists && *req.Tail <= 0 {
			w.WriteHeader(http.StatusBadRequest)
			fmt.Fprintf(w, "tail: must be positive")
			return
		}

		// Validate filter_dir
		if req.FilterDir != "" && req.FilterDir != "up" && req.FilterDir != "down" {
			w.WriteHeader(http.StatusBadRequest)
			fmt.Fprintf(w, "filter_dir: must be 'up' or 'down'")
			return
		}

		// Compile regex if provided
		var filterRegex *regexp.Regexp
		if req.FilterRegex != "" {
			var err error
			filterRegex, err = regexp.Compile(req.FilterRegex)
			if err != nil {
				w.WriteHeader(http.StatusBadRequest)
				fmt.Fprintf(w, "filter_regex: invalid regex %v", err)
				return
			}
		}

		// Build query options
		opts := QueryOptions{
			FilterDir:   req.FilterDir,
			FilterRegex: filterRegex,
		}

		// Build scan range
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

		respondJson(w, &resp)
	})

	slog.Info("HTTP server started listening", "port", *addr)
	if err := http.ListenAndServe(*addr, nil); err != nil {
		slog.Error("HTTP server error", "error", err)
	}
}
