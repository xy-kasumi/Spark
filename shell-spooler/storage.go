// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later
package main

import (
	"regexp"
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
	mu    sync.RWMutex
	lines []line
}

// Create new lineStorage instance
func newLineStorage() *lineStorage {
	return &lineStorage{
		lines: make([]line, 0),
	}
}


// Add a line to storage
func (ls *lineStorage) addLine(lineNum int, dir string, content string) time.Time {
	ls.mu.Lock()
	defer ls.mu.Unlock()

	now := time.Now()
	l := line{
		num:     lineNum,
		dir:     dir,
		content: content,
		time:    now,
	}
	ls.lines = append(ls.lines, l)

	return now
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

