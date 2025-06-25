// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later
package main

import (
	"bufio"
	"log/slog"
	"strings"
	"time"

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
		slog.Error("failed to open serial port", "port", portName, "baud", baud, "error", err)
		return nil
	}
	slog.Info("opened serial port", "port", portName, "baud", baud)

	sh := &serialHandler{
		port:    port,
		storage: storage,
		writeCh: make(chan string, 100),
	}

	go sh.readLoop()
	go sh.writeLoop()

	return sh
}

func (sh *serialHandler) readLoop() {
	r := bufio.NewReader(sh.port)
	slog.Info("Starting serial read goroutine")

	for {
		// Read line from serial
		line, err := r.ReadString('\n')
		if err != nil {
			slog.Error("serial port read error", "error", err)
			time.Sleep(500 * time.Millisecond)
			continue
		}

		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}

		slog.Debug("received", "line", line)

		// Add to storage
		sh.storage.addLine("down", line)
	}
}

func (sh *serialHandler) writeLoop() {
	for {
		line := <-sh.writeCh

		// Write to serial port
		_, err := sh.port.Write([]byte(line + "\n"))
		if err != nil {
			slog.Error("serial port write error", "error", err)
			// Keep trying
			time.Sleep(500 * time.Millisecond)
			continue
		}

		slog.Debug("sent", "line", line)
	}
}

func (sh *serialHandler) writeLine(line string) {
	sh.writeCh <- line
}

func (sh *serialHandler) Close() {
	sh.port.Close()
}
