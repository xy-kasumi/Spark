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
		slog.Error("failed to create log directory", "dir", logDir, "error", err)
		return ls
	}

	// Scan for existing session files to determine next session number
	sessNum := ls.findNextSessionNumber(logDir)

	// Create log file
	now := time.Now()
	filename := fmt.Sprintf("%s-sess%d-serial.txt", now.Format("2006-01-02"), sessNum)
	logPath := filepath.Join(logDir, filename)

	file, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		slog.Error("failed to create log file", "path", logPath, "error", err)
		return ls
	}

	ls.logFile = file
	slog.Info("created log file", "path", logPath, "session", sessNum)

	return ls
}

// findNextSessionNumber scans the log directory for existing session files
// and returns the next available session number
func (ls *lineStorage) findNextSessionNumber(logDir string) int {
	entries, err := os.ReadDir(logDir)
	if err != nil {
		slog.Debug("could not read log directory", "dir", logDir, "error", err)
		return 0
	}

	// Pattern to match: YYYY-MM-DD-sessN-serial.txt
	pattern := regexp.MustCompile(`^\d{4}-\d{2}-\d{2}-sess(\d+)-serial\.txt$`)
	maxSession := -1

	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}

		matches := pattern.FindStringSubmatch(entry.Name())
		if len(matches) == 2 {
			sessionNum, err := strconv.Atoi(matches[1])
			if err == nil && sessionNum > maxSession {
				maxSession = sessionNum
			}
		}
	}

	return maxSession + 1
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
			slog.Error("failed to write to log file", "error", err)
		} else {
			// Flush to ensure immediate write
			ls.logFile.Sync()
		}
	}

	return l.num, now
}

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