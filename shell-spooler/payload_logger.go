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

type PayloadLogger struct {
	mu      sync.Mutex
	logFile *os.File
}

func NewPayloadLogger(logDir string) *PayloadLogger {
	pl := &PayloadLogger{}

	// Create log directory if it doesn't exist
	if err := os.MkdirAll(logDir, 0755); err != nil {
		slog.Error("Failed to create log directory", "dir", logDir, "error", err)
		return pl
	}

	// Create log file
	now := time.Now()

	// Find next available filename for today
	filename := pl.findNextFileName(logDir, now)
	if filename == "" {
		slog.Error("Failed to read log directory, continuing without log file", "dir", logDir)
		return pl
	}

	logPath := filepath.Join(logDir, filename)
	file, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		slog.Error("Failed to create log file", "path", logPath, "error", err)
		return pl
	}

	pl.logFile = file
	slog.Info("Created log file", "path", logPath)

	return pl
}

// findNextFileName scans the log directory for existing session files
// and returns the next available filename for today
func (pl *PayloadLogger) findNextFileName(logDir string, now time.Time) string {
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

func (pl *PayloadLogger) AddLine(lineNum int, dir string, payload string) {
	pl.mu.Lock()
	defer pl.mu.Unlock()

	// Write to log file if available
	if pl.logFile != nil {
		now := time.Now()
		logLine := fmt.Sprintf("%s %d %s %s\n",
			formatSpoolerTime(now), lineNum, dir, payload)

		if _, err := pl.logFile.WriteString(logLine); err != nil {
			slog.Error("Failed to write to log file", "error", err)
		} else {
			// Flush to ensure immediate write
			pl.logFile.Sync()
		}
	}
}

func (pl *PayloadLogger) Close() {
	pl.mu.Lock()
	defer pl.mu.Unlock()

	if pl.logFile != nil {
		pl.logFile.Close()
		pl.logFile = nil
	}
}