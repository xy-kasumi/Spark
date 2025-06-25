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

type getLinesRequest struct {
	LineNumSince int `json:"line_num_since,omitempty"` // Optional: line number to start from (inclusive). If omitted, returns all lines.
	NumLines     int `json:"num_lines,omitempty"`      // Optional: maximum number of lines to return. If omitted, returns up to 1000 lines.
}

type getLinesResponse struct {
	Lines []lineInfo `json:"lines"` // actual lines, ordered by line number (ascending)
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

// Get lines from storage
func (ls *lineStorage) getLines(lineNumSince int, numLines int) []line {
	ls.mu.RLock()
	defer ls.mu.RUnlock()

	if numLines == 0 || numLines > 1000 {
		numLines = 1000
	}

	result := make([]line, 0, numLines)
	for _, l := range ls.lines {
		if l.num >= lineNumSince {
			result = append(result, l)
			if len(result) >= numLines {
				break
			}
		}
	}

	return result
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
		lineNum, timestamp := storage.addLine("up", req.Line)

		resp := writeLineResponse{
			LineNum: lineNum,
			Time:    timestamp.Local().Format("2006-01-02 15:04:05.000"),
		}
		respondJson(w, &resp)
	})

	// HTTP handler to get lines
	http.HandleFunc("/get-lines", func(w http.ResponseWriter, r *http.Request) {
		if !handleCommom(w, r) {
			return
		}

		slog.Debug("/get-lines")
		var req getLinesRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			fmt.Fprintf(w, "invalid JSON: %v", err)
			return
		}

		// Default to line 1 if not specified
		if req.LineNumSince == 0 {
			req.LineNumSince = 1
		}

		// Get lines from storage
		lines := storage.getLines(req.LineNumSince, req.NumLines)

		// Convert to response format
		resp := getLinesResponse{
			Lines: make([]lineInfo, len(lines)),
		}
		for i, l := range lines {
			resp.Lines[i] = lineInfo{
				LineNum: l.num,
				Dir:     l.dir,
				Content: l.content,
				Time:    l.time.Local().Format("2006-01-02 15:04:05.000"),
			}
		}

		respondJson(w, &resp)
	})

	slog.Info("HTTP server started listening", "port", *addr)
	if err := http.ListenAndServe(*addr, nil); err != nil {
		slog.Error("HTTP server error", "error", err)
	}
}
