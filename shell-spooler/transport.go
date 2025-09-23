// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later
package main

import (
	"bufio"
	"bytes"
	"log/slog"
	"sync"
	"time"
	"unicode"

	"go.bug.st/serial"
)

type transport struct {
	port    serial.Port
	storage *LineDB
	logger  *PayloadLogger
	writeCh chan string
	onRecv  func(string)

	// lineNum assignment
	lineNumMu  sync.Mutex
	nextLineNum int
}

func initTransport(serialPort string, baud int, storage *LineDB, logger *PayloadLogger, onRecv func(string)) (*transport, error) {
	mode := &serial.Mode{BaudRate: baud}
	port, err := serial.Open(serialPort, mode)
	if err != nil {
		return nil, err
	}
	slog.Info("Opened serial port", "port", serialPort, "baud", baud)

	tran := &transport{
		port:        port,
		storage:     storage,
		logger:      logger,
		writeCh:     make(chan string),
		onRecv:      onRecv,
		nextLineNum: 1,
	}

	go tran.readLoop()
	go tran.writeLoop()

	return tran, nil
}

func (tran *transport) sendPayload(payload string) {
	tran.writeCh <- payload
}

func (tran *transport) readLoop() {
	r := bufio.NewReader(tran.port)
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
		payload := string(bytes.Map(func(r rune) rune {
			switch r {
			case '\r':
				return -1
			}
			if unicode.IsPrint(r) {
				return r
			}
			return -1
		}, lineBytes))

		if payload == "" {
			continue
		}

		tran.addLineAtomic("up", payload)
		tran.onRecv(payload)
		slog.Debug("Received", "line", payload)
	}
}

func (tran *transport) writeLoop() {
	for {
		line := <-tran.writeCh

		// Write to serial port
		_, err := tran.port.Write([]byte(line + "\n"))
		if err != nil {
			slog.Error("Serial port write error", "error", err)
			// Keep trying
			time.Sleep(500 * time.Millisecond)
			continue
		}

		tran.addLineAtomic("down", line)
		slog.Debug("Sent", "line", line)
	}
}

func (tran *transport) addLineAtomic(dir string, payload string) {
	tran.lineNumMu.Lock()
	defer tran.lineNumMu.Unlock()

	lineNum := tran.nextLineNum
	tran.nextLineNum++

	tran.storage.addLine(lineNum, dir, payload)
	tran.logger.AddLine(lineNum, dir, payload)
}

func (tran *transport) Close() {
	tran.port.Close()
	tran.logger.Close()
}
