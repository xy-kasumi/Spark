// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later
package main

import (
	"bufio"
	"bytes"
	"log/slog"
	"strings"
	"time"
	"unicode"

	"go.bug.st/serial"
)

type serialHandler struct {
	port    serial.Port
	storage *lineStorage
	writeCh chan string
}

func initSerial(portName string, baud int, storage *lineStorage) *serialHandler {
	mode := &serial.Mode{BaudRate: baud}
	port, err := serial.Open(portName, mode)
	if err != nil {
		slog.Error("Failed to open serial port", "port", portName, "baud", baud, "error", err)
		return nil
	}
	slog.Info("Opened serial port", "port", portName, "baud", baud)

	sh := &serialHandler{
		port:    port,
		storage: storage,
		writeCh: make(chan string, 10_000_000),
	}

	go sh.readLoop()
	go sh.writeLoop()

	return sh
}

func (sh *serialHandler) readLoop() {
	r := bufio.NewReader(sh.port)
	slog.Debug("Starting serial read goroutine")

	for {
		// Read line from serial
		lineBytes, err := r.ReadBytes('\n')
		if err != nil {
			slog.Error("Serial port read error", "error", err)
			time.Sleep(500 * time.Millisecond)
			continue
		}

		// Discard CRs & non-printables.
		line := string(bytes.Map(func(r rune) rune {
			switch r {
			case '\r':
				return -1
			}
			if unicode.IsPrint(r) {
				return r
			}
			return -1
		}, lineBytes))

		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}

		slog.Debug("Received", "line", line)

		// Add to storage
		sh.storage.addLine("up", line)
	}
}

func (sh *serialHandler) writeLoop() {
	for {
		line := <-sh.writeCh

		// Write to serial port
		_, err := sh.port.Write([]byte(line + "\n"))
		if err != nil {
			slog.Error("Serial port write error", "error", err)
			// Keep trying
			time.Sleep(500 * time.Millisecond)
			continue
		}

		slog.Debug("Sent", "line", line)
	}
}

func (sh *serialHandler) writeLine(line string) {
	sh.writeCh <- line
}

func (sh *serialHandler) writeQueueLength() int {
	return len(sh.writeCh)
}

func (sh *serialHandler) drainWriteQueue() {
	for {
		select {
		case <-sh.writeCh:
		default:
			return // nothing in writeCh now
		}
	}
}

func (sh *serialHandler) Close() {
	sh.port.Close()
}
