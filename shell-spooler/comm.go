// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later
package main

import (
	"errors"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"time"
)

type CommHandler interface {
	// Called when payload is definitely sent (ack-ed) to the core.
	PayloadSent(payload string)
	// Called when payload is definitely received (ack-ed) from the core.
	PayloadRecv(payload string)
	// Called when a p-state is definitely received (ack-ed and parsed ok) from the core.
	PStateRecv(tag string, ps PState)
}

type PState struct {
}

type comm struct {
	tran      *transport
	psp       *pstateParser
	signalCh  chan string
	commandCh chan string
}

type pstateParser struct {
	partial map[string]map[string]string

	muComplete sync.Mutex
	complete   map[string]map[string]string
}

func newPstateParser() *pstateParser {
	return &pstateParser{
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

func (ps *pstateParser) update(line string) {
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

func (ps *pstateParser) getQueue() (psQueue, bool) {
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

func initComm(serialPort string, baud int, storage *LineDB, logger *PayloadLogger) (*comm, error) {
	ps := newPstateParser()
	tran, err := initTransport(serialPort, baud, storage, logger, func(payload string) {
		ps.update(payload)
	})
	if err != nil {
		return nil, err
	}
	cm := &comm{
		tran:      tran,
		psp:       ps,
		signalCh:  make(chan string, 10),
		commandCh: make(chan string, 10_000_000),
	}

	go cm.feedSignal()
	go cm.feedCommand()

	return cm, nil
}

func (cm *comm) feedSignal() {
	for {
		line := <-cm.signalCh
		cm.tran.sendPayload(line)
	}
}

func (cm *comm) queryQueueBlocking() psQueue {
	const queueSignalTimeout = 1 * time.Second
	for {
		cm.signalCh <- "?queue"
		sent := time.Now()
		for {
			qs, ok := cm.psp.getQueue()
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

func (cm *comm) feedCommand() {
	const maxFillRate = 0.75
	okToSend := 0

	for {
		for {
			if okToSend > 0 {
				break
			}
			time.Sleep(100 * time.Millisecond)
			qs := cm.queryQueueBlocking()
			okToSend = int(float64(qs.Cap)*maxFillRate) - qs.Num
		}

		select {
		case line := <-cm.commandCh:
			cm.tran.sendPayload(line)
			okToSend--
		default:
		}
	}
}

func (cm *comm) pollQueueStatus() {
	for {
		if len(cm.commandCh) > 0 {
			cm.signalCh <- "?queue"
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func (cm *comm) writeLine(line string) {
	if line[0] == '!' || line[0] == '?' {
		cm.signalCh <- line
	} else {
		cm.commandCh <- line
	}
}

func (cm *comm) writeQueueLength() int {
	return len(cm.commandCh)
}

func (cm *comm) drainWriteQueue() {
	for {
		select {
		case <-cm.commandCh:
		default:
			return // nothing in writeCh now
		}
	}
}

func (cm *comm) Close() {
	cm.tran.Close()
}
