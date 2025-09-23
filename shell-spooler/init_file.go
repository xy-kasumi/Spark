// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later
package main

import (
	"fmt"
	"log/slog"
	"os"
	"strings"
)

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