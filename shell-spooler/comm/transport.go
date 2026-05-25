// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later
package comm

import (
	"bufio"
	"bytes"
	"log/slog"
	"sync"
	"time"
	"unicode"

	"go.bug.st/serial"
)

type Transport struct {
	port    serial.Port
	writeCh chan string

	mu      sync.RWMutex
	handler CommHandler
}

func OpenTransport(serialPort string, baud int) (*Transport, error) {
	mode := &serial.Mode{BaudRate: baud}
	port, err := serial.Open(serialPort, mode)
	if err != nil {
		return nil, err
	}
	slog.Info("Opened serial port", "port", serialPort, "baud", baud)

	tran := &Transport{
		port:    port,
		writeCh: make(chan string),
	}

	go tran.readLoop()
	go tran.writeLoop()

	return tran, nil
}

func (tran *Transport) SetHandler(h CommHandler) {
	tran.mu.Lock()
	defer tran.mu.Unlock()
	tran.handler = h
}

func (tran *Transport) snapshotHandler() CommHandler {
	tran.mu.RLock()
	defer tran.mu.RUnlock()
	return tran.handler
}

func (tran *Transport) sendPayload(payload string) {
	tran.writeCh <- payload
}

func (tran *Transport) readLoop() {
	r := bufio.NewReader(tran.port)
	slog.Debug("Starting serial read goroutine")

	for {
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

		if h := tran.snapshotHandler(); h != nil {
			h.PayloadRecv(payload, time.Now())
		}
		slog.Debug("Received", "line", payload)
	}
}

func (tran *Transport) writeLoop() {
	for {
		line := <-tran.writeCh

		_, err := tran.port.Write([]byte(line + "\n"))
		if err != nil {
			slog.Error("Serial port write error", "error", err)
			time.Sleep(500 * time.Millisecond)
			continue
		}

		if h := tran.snapshotHandler(); h != nil {
			h.PayloadSent(line, time.Now())
		}
		slog.Debug("Sent", "line", line)
	}
}

func (tran *Transport) Close() {
	tran.port.Close()
}
