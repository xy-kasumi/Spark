// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later
package main

import (
	"bufio"
	"bytes"
	"log/slog"
	"time"
	"unicode"

	"go.bug.st/serial"
)

type transport struct {
	port    serial.Port
	handler CommHandler
	writeCh chan string
}

func initTransport(serialPort string, baud int, handler CommHandler) (*transport, error) {
	mode := &serial.Mode{BaudRate: baud}
	port, err := serial.Open(serialPort, mode)
	if err != nil {
		return nil, err
	}
	slog.Info("Opened serial port", "port", serialPort, "baud", baud)

	tran := &transport{
		port:    port,
		handler: handler,
		writeCh: make(chan string),
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

		tran.handler.PayloadRecv(payload)
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

		tran.handler.PayloadSent(line)
		slog.Debug("Sent", "line", line)
	}
}

func (tran *transport) Close() {
	tran.port.Close()
}
