// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later
package main

import (
	"bufio"
	"bytes"
	"errors"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

	"go.bug.st/serial"
)

type serialHandler struct {
	port      serial.Port
	storage   *lineStorage
	writeCh   chan string
	ps        *pstate
	signalCh  chan string
	commandCh chan string
}

type pstate struct {
	partial map[string]map[string]string

	muComplete sync.Mutex
	complete   map[string]map[string]string
}

func newPstate() *pstate {
	return &pstate{
		partial:  make(map[string]map[string]string),
		complete: make(map[string]map[string]string),
	}
}

// e.g. "pos < sys:"a b" a.b:2 >" -> ["pos", "<", `sys:"a b"`, "a.b:2", ">"]
// won't do much extra validation
func splitPsTokens(payload string) ([]string, error) {
	var toks []string
	var buf []rune
	inQuote := false
	inEscape := false
	for _, ch := range payload {
		if inEscape {
			if ch == '\\' {
				buf = append(buf, '\\')
			} else if ch == '"' {
				buf = append(buf, '"')
			} else {
				return nil, errors.New("invalid escape sequence" + string(ch))
			}
			inEscape = false
		} else if inQuote {
			if ch == '\\' {
				inEscape = true
			} else {
				if ch == '"' {
					inQuote = false
				}
				buf = append(buf, ch)
			}
		} else {
			if ch == ' ' {
				if len(buf) > 0 {
					toks = append(toks, string(buf))
					buf = nil
				}
			} else {
				if ch == '"' {
					inQuote = true
				}
				buf = append(buf, ch)
			}
		}
	}
	if len(buf) > 0 {
		toks = append(toks, string(buf))
	}
	if inQuote || inEscape {
		return nil, errors.New("unclosed quote or escape")
	}
	return toks, nil
}

func (ps *pstate) update(line string) {
	tokens, err := splitPsTokens(line)
	if err != nil {
		slog.Warn("Malformed pstate", "error", err)
		return
	}
	if len(tokens) < 1 {
		return
	}
	psType := tokens[0]
	for _, token := range tokens[1:] {
		switch token {
		case "<":
			ps.partial[psType] = map[string]string{}
		case ">":
			m, ok := ps.partial[psType]
			if !ok {
				slog.Warn("Received '>' without matching '<'", "type", psType)
				continue
			}
			ps.muComplete.Lock()
			ps.complete[psType] = m
			ps.muComplete.Unlock()
		default:
			// K:V
			m, ok := ps.partial[psType]
			if !ok {
				slog.Warn("Received pstate key-value without matching '<'", "type", psType)
				continue
			}
			kv := strings.SplitN(token, ":", 2)
			if len(kv) != 2 {
				slog.Warn("Received malformed pstate", "payload", line)
				continue
			}
			m[kv[0]] = kv[1]
		}
	}
}

type psQueue struct {
	Cap int
	Num int
}

func (ps *pstate) getQueue() (psQueue, bool) {
	ps.muComplete.Lock()
	defer ps.muComplete.Unlock()

	m, ok := ps.complete["queue"]
	if !ok {
		return psQueue{}, false
	}
	capStr, ok1 := m["cap"]
	numStr, ok2 := m["num"]
	if !ok1 || !ok2 {
		return psQueue{}, false
	}
	cap, err1 := strconv.Atoi(capStr)
	num, err2 := strconv.Atoi(numStr)
	if err1 != nil || err2 != nil {
		return psQueue{}, false
	}
	delete(ps.complete, "queue")
	return psQueue{Cap: cap, Num: num}, true
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
		port:      port,
		storage:   storage,
		writeCh:   make(chan string),
		ps:        newPstate(),
		signalCh:  make(chan string, 10),
		commandCh: make(chan string, 10_000_000),
	}

	// transport layer
	go sh.readLoop()
	go sh.writeLoop()

	// application layer
	go sh.feedSignal()
	go sh.feedCommand()

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

		if line == "" {
			continue
		}

		sh.storage.addLine("up", line)
		sh.ps.update(line)
		slog.Debug("Received", "line", line)
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

		sh.storage.addLine("down", line)
		slog.Debug("Sent", "line", line)
	}
}

func (sh *serialHandler) feedSignal() {
	for {
		line := <-sh.signalCh
		sh.writeCh <- line
	}
}

func (sh *serialHandler) queryQueueBlocking() psQueue {
	const queueSignalTimeout = 1 * time.Second
	for {
		sh.signalCh <- "?queue"
		sent := time.Now()
		for {
			qs, ok := sh.ps.getQueue()
			if ok {
				return qs
			}
			if time.Now().After(sent.Add(queueSignalTimeout)) {
				// queue signal timeout can happen in core reboot)
				break
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
}

func (sh *serialHandler) feedCommand() {
	const maxFillRate = 0.75
	okToSend := 0

	for {
		for {
			if okToSend > 0 {
				break
			}
			time.Sleep(100 * time.Millisecond)
			qs := sh.queryQueueBlocking()
			okToSend = int(float64(qs.Cap)*maxFillRate) - qs.Num
		}

		select {
		case line := <-sh.commandCh:
			sh.writeCh <- line
			okToSend--
		default:
		}
	}
}

func (sh *serialHandler) pollQueueStatus() {
	for {
		if len(sh.commandCh) > 0 {
			sh.signalCh <- "?queue"
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func (sh *serialHandler) writeLine(line string) {
	if line[0] == '!' || line[0] == '?' {
		sh.signalCh <- line
	} else {
		sh.commandCh <- line
	}
}

func (sh *serialHandler) writeQueueLength() int {
	return len(sh.commandCh)
}

func (sh *serialHandler) drainWriteQueue() {
	for {
		select {
		case <-sh.commandCh:
		default:
			return // nothing in writeCh now
		}
	}
}

func (sh *serialHandler) Close() {
	sh.port.Close()
}
