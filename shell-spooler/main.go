// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
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
	FromLine int `json:"from_line,omitempty"` // Optional: start from this line number (inclusive), 1-based
	ToLine   int `json:"to_line,omitempty"`   // Optional: up to this line number (exclusive), 1-based
	Tail     int `json:"tail,omitempty"`      // Optional: get last N lines (overrides from/to)
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

// Internal line storage
type line struct {
	num     int
	dir     string // "up" or "down"
	content string
	time    time.Time
}

// formatTimestamp formats a time.Time to the standard string format used by the API
func formatSpoolerTime(t time.Time) string {
	return t.Local().Format("2006-01-02 15:04:05.000")
}

// Global line storage
type lineStorage struct {
	mu      sync.RWMutex
	lines   []line
	nextNum int
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

// Create new lineStorage instance
func newLineStorage() *lineStorage {
	return &lineStorage{
		lines:   make([]line, 0),
		nextNum: 1,
	}
}

// Add a line to storage
func (ls *lineStorage) addLine(dir string, content string) (int, time.Time) {
	ls.mu.Lock()
	defer ls.mu.Unlock()

	now := time.Now()
	l := line{
		num:     ls.nextNum,
		dir:     dir,
		content: content,
		time:    now,
	}
	ls.lines = append(ls.lines, l)
	ls.nextNum++

	return l.num, now
}

// Query lines by range [fromLine, toLine)
// fromLine: inclusive, 1-based line number (0 means from beginning)
// toLine: exclusive, 1-based line number (0 means to end)
func (ls *lineStorage) queryRange(fromLine, toLine int) []line {
	ls.mu.RLock()
	defer ls.mu.RUnlock()

	if len(ls.lines) == 0 {
		return []line{}
	}

	var startIdx, endIdx int

	// Find start index
	if fromLine > 0 {
		startIdx = 0
		for i, l := range ls.lines {
			if l.num >= fromLine {
				startIdx = i
				break
			}
		}
		// If no line found with num >= fromLine, return empty
		if startIdx == 0 && len(ls.lines) > 0 && ls.lines[0].num > fromLine {
			return []line{}
		}
	} else {
		startIdx = 0
	}

	// Find end index
	if toLine > 0 {
		endIdx = len(ls.lines)
		for i, l := range ls.lines {
			if l.num >= toLine {
				endIdx = i
				break
			}
		}
	} else {
		endIdx = len(ls.lines)
	}

	if startIdx >= endIdx {
		return []line{}
	}

	return ls.lines[startIdx:endIdx]
}

// Query last N lines
func (ls *lineStorage) queryTail(n int) []line {
	ls.mu.RLock()
	defer ls.mu.RUnlock()

	if len(ls.lines) == 0 || n <= 0 {
		return []line{}
	}

	startIdx := len(ls.lines) - n
	if startIdx < 0 {
		startIdx = 0
	}

	return ls.lines[startIdx:]
}

func main() {
	portName := flag.String("port", "COM3", "Serial port name")
	baud := flag.Int("baud", 115200, "Serial port baud rate")
	addr := flag.String("addr", ":9000", "HTTP listen address")
	verbose := flag.Bool("verbose", false, "Verbose logging")
	flag.Parse()

	if verbose != nil && *verbose {
		slog.SetLogLoggerLevel(slog.LevelDebug)
	}

	// Initialize line storage
	storage := newLineStorage()

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

		// Validate: tail cannot be used with from_line or to_line
		if req.Tail > 0 && (req.FromLine > 0 || req.ToLine > 0) {
			w.WriteHeader(http.StatusBadRequest)
			fmt.Fprintf(w, "tail cannot be used with from_line or to_line")
			return
		}

		// Validate range parameters
		if req.FromLine < 0 || req.ToLine < 0 || req.Tail < 0 {
			w.WriteHeader(http.StatusBadRequest)
			fmt.Fprintf(w, "line numbers cannot be negative")
			return
		}

		// Get lines from storage using appropriate method
		var lines []line
		if req.Tail > 0 {
			lines = storage.queryTail(req.Tail)
		} else {
			lines = storage.queryRange(req.FromLine, req.ToLine)
		}
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
