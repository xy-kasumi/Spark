// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later
package main

import (
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"sync"
	"time"
)

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
	logFile *os.File
}

// Create new lineStorage instance
func newLineStorage(logDir string) *lineStorage {
	ls := &lineStorage{
		lines:   make([]line, 0),
		nextNum: 1,
	}

	// Create log directory if it doesn't exist
	if err := os.MkdirAll(logDir, 0755); err != nil {
		slog.Error("Failed to create log directory", "dir", logDir, "error", err)
		return ls
	}

	// Create log file
	now := time.Now()

	// Find next available filename for today
	filename := ls.findNextFileName(logDir, now)
	if filename == "" {
		slog.Error("Failed to read log directory, continuing without log file", "dir", logDir)
		return ls
	}

	logPath := filepath.Join(logDir, filename)
	file, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		slog.Error("Failed to create log file", "path", logPath, "error", err)
		return ls
	}

	ls.logFile = file
	slog.Info("Created log file", "path", logPath)

	return ls
}

// findNextFileName scans the log directory for existing session files
// and returns the next available filename for today
func (ls *lineStorage) findNextFileName(logDir string, now time.Time) string {
	today := now.Format("2006-01-02")

	entries, err := os.ReadDir(logDir)
	if err != nil {
		return ""
	}
	// Pattern to match: YYYY-MM-DD-sessN-serial.txt
	pattern := regexp.MustCompile(`^(\d{4}-\d{2}-\d{2})-sess(\d+)-serial\.txt$`)
	maxSession := -1

	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}

		matches := pattern.FindStringSubmatch(entry.Name())
		if len(matches) == 3 {
			fileDate := matches[1]
			// Only consider files from today
			if fileDate == today {
				sessionNum, err := strconv.Atoi(matches[2])
				if err == nil && sessionNum > maxSession {
					maxSession = sessionNum
				}
			}
		}
	}

	nextSession := maxSession + 1
	return fmt.Sprintf("%s-sess%d-serial.txt", today, nextSession)
}

// Add a line to storage and log file
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

	// Write to log file if available
	if ls.logFile != nil {
		logLine := fmt.Sprintf("%s %d %s %s\n",
			formatSpoolerTime(now), l.num, dir, content)

		if _, err := ls.logFile.WriteString(logLine); err != nil {
			slog.Error("Failed to write to log file", "error", err)
		} else {
			// Flush to ensure immediate write
			ls.logFile.Sync()
		}
	}

	return l.num, now
}

// ScanRange represents either a line range or tail mode
type ScanRange interface {
	// Extract returns the lines from the given slice according to the scan range
	Extract(lines []line) []line
}

// RangeScan represents scanning from FromLine to ToLine
// Requirement: ToLine >= FromLine.
type RangeScan struct {
	FromLine *int // Start line (inclusive, 1-based), nil means from beginning
	ToLine   *int // End line (exclusive, 1-based), nil means to end
}

func (r RangeScan) Extract(lines []line) []line {
	start := 0
	if r.FromLine != nil && *r.FromLine > 0 {
		start = *r.FromLine - 1
		if start >= len(lines) {
			return []line{}
		}
	}

	end := len(lines)
	if r.ToLine != nil && *r.ToLine > 0 {
		end = *r.ToLine - 1 // Convert to 0-based
		if end > len(lines) {
			end = len(lines)
		}
	}

	return lines[start:end]
}

// TailScan represents scanning last N lines
type TailScan struct {
	N int // Number of lines from end
}

func (t TailScan) Extract(lines []line) []line {
	if t.N <= 0 {
		return []line{}
	}

	if t.N >= len(lines) {
		return lines
	}

	return lines[len(lines)-t.N:]
}

// QueryOptions specifies parameters for querying lines
type QueryOptions struct {
	// Range specification (optional: all lines if nil)
	Scan ScanRange

	// Filters (all are optional and combined with AND)
	FilterDir   string         // "up" or "down", empty means any
	FilterRegex *regexp.Regexp // Compiled regex, nil means no filter
}

// Query lines with the given options
func (ls *lineStorage) Query(opts QueryOptions) []line {
	ls.mu.RLock()
	defer ls.mu.RUnlock()

	// Apply scan range.
	lines := ls.lines
	if opts.Scan != nil {
		lines = opts.Scan.Extract(ls.lines)
	}

	// Apply filters.
	var result []line
	for _, l := range lines {
		// Direction filter
		if opts.FilterDir != "" && l.dir != opts.FilterDir {
			continue
		}

		// Regex filter
		if opts.FilterRegex != nil && !opts.FilterRegex.MatchString(l.content) {
			continue
		}

		result = append(result, l)
	}
	return result
}

// Deprecated: Use Query() instead
// Query lines by range [fromLine, toLine)
// fromLine: inclusive, 1-based line number (0 means from beginning)
// toLine: exclusive, 1-based line number (0 means to end)
func (ls *lineStorage) queryRange(fromLine, toLine int) []line {
	ls.mu.RLock()
	defer ls.mu.RUnlock()

	numLines := len(ls.lines)
	if numLines == 0 {
		return []line{}
	}

	// Note: line numbers are 1-based, slice indices are 0-based.
	// We assume line numbers in storage are contiguous and start from 1.
	// So, for line number `n`, its index is `n-1`.

	var startIdx int
	if fromLine > 0 {
		startIdx = fromLine - 1
	} else {
		startIdx = 0 // fromLine <= 0 means from the beginning
	}

	if startIdx < 0 {
		startIdx = 0
	}

	if startIdx >= numLines {
		return []line{} // fromLine is after all stored lines
	}

	var endIdx int
	if toLine > 0 {
		// toLine is exclusive, so the index is toLine - 1.
		endIdx = toLine - 1
	} else {
		endIdx = numLines // toLine <= 0 means to the end
	}

	if endIdx > numLines {
		endIdx = numLines
	}

	if startIdx >= endIdx {
		return []line{}
	}

	return ls.lines[startIdx:endIdx]
}

// Deprecated: Use Query() instead
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

// Close the storage and log file
func (ls *lineStorage) Close() {
	ls.mu.Lock()
	defer ls.mu.Unlock()

	if ls.logFile != nil {
		ls.logFile.Close()
		ls.logFile = nil
	}
}
