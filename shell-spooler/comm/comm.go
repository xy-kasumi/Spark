// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later
package comm

import (
	"log/slog"
	"strings"
	"sync"
	"time"
)

type Comm struct {
	tran      *transport
	parser    PStateParser
	handler   CommHandler
	signalCh  chan string
	commandCh chan string

	muQueue     *sync.Mutex
	latestQueue *psQueue
	okToSend    int
}

// Called after payload or p-state sent or received (ack-ed).
// Timestamp is also the time of ack.
type CommHandler interface {
	// Payload was sent to the core.
	PayloadSent(payload string, tm time.Time)
	// Payload was received from the core.
	PayloadRecv(payload string, tm time.Time)
	// P-state was received from the core.
	PStateRecv(ps PState, tm time.Time)
}

type psQueue struct {
	Cap int
	Num int
}

func parseQueuePS(ps PState) *psQueue {
	cap, ok1 := ps.GetFloat("cap")
	num, ok2 := ps.GetFloat("num")
	if !ok1 || !ok2 {
		return nil
	}
	return &psQueue{Cap: int(cap), Num: int(num)}
}

func (cm *Comm) PayloadSent(payload string, tm time.Time) {
	cm.handler.PayloadSent(payload, tm)
}

func (cm *Comm) PayloadRecv(payload string, tm time.Time) {
	cm.handler.PayloadRecv(payload, tm)
	ps, err := cm.parser.Update(payload)
	if err != nil {
		slog.Warn("Failed to parse p-state", "payload", payload, "error", err)
		return
	}
	if ps == nil {
		return
	}
	if ps.Tag == "queue" {
		q := parseQueuePS(*ps)
		if q != nil {
			cm.handleQueueStatus(q)
		}
	}
	cm.handler.PStateRecv(*ps, tm)
}

func (cm *Comm) PStateRecv(ps PState, tm time.Time) {
	panic("unreachable")
}

func InitComm(serialPort string, baud int, handler CommHandler) (*Comm, error) {
	cm := &Comm{
		handler:   handler,
		parser:    NewPStateParser(),
		signalCh:  make(chan string, 10),
		commandCh: make(chan string, 10_000_000), // must be bigger than any G-code file
		muQueue:   &sync.Mutex{},
	}
	tran, err := initTransport(serialPort, baud, cm)
	if err != nil {
		return nil, err
	}
	cm.tran = tran

	go cm.pollQueue()
	go cm.feedSignal()
	go cm.feedCommand()
	return cm, nil
}

func (cm *Comm) pollQueue() {
	for {
		time.Sleep(250 * time.Millisecond)
		cm.signalCh <- "?queue"
	}
}

func (cm *Comm) handleQueueStatus(q *psQueue) {
	const maxFillRate = 0.75

	cm.muQueue.Lock()
	defer cm.muQueue.Unlock()

	cm.latestQueue = q
	cm.okToSend = int(float64(q.Cap)*maxFillRate) - q.Num
}

func (cm *Comm) feedSignal() {
	for {
		line := <-cm.signalCh
		cm.tran.sendPayload(line)
	}
}

func (cm *Comm) feedCommand() {
	for {
		for {
			cm.muQueue.Lock()
			canSend := cm.okToSend > 0
			cm.muQueue.Unlock()
			if canSend {
				break
			}
			time.Sleep(50 * time.Millisecond)
		}

		// NOTE: without a new command sent to the core, okToSend will only increase or stay the same.
		// Thus, same to assume that here okToSend is still > 0, because feedCommand() is only place that can send command.
		cm.tran.sendPayload(<-cm.commandCh)
		cm.muQueue.Lock()
		cm.okToSend--
		cm.muQueue.Unlock()
	}
}

func (cm *Comm) SendSignal(payload string) {
	if !IsSignal(payload) {
		panic("not a signal: " + payload)
	}
	cm.signalCh <- payload
}

func (cm *Comm) WriteCommand(payload string) {
	if IsSignal(payload) {
		panic("not a command: " + payload)
	}
	payload = cleanupGCode(payload)
	if payload != "" {
		cm.commandCh <- payload
	}
}

func (cm *Comm) CommandQueueLength() int {
	cm.muQueue.Lock()
	defer cm.muQueue.Unlock()

	var numInCore int
	if cm.latestQueue != nil {
		numInCore = cm.latestQueue.Num
	}
	return len(cm.commandCh) + numInCore
}

func (cm *Comm) DrainCommandQueue() {
	for {
		select {
		case <-cm.commandCh:
		default:
			return // nothing in writeCh now
		}
	}
}

func (cm *Comm) Close() {
	cm.tran.Close()
}

func IsSignal(payload string) bool {
	return strings.HasPrefix(payload, "!") || strings.HasPrefix(payload, "?")
}

func cleanupGCode(payload string) string {
	if idx := strings.Index(payload, ";"); idx != -1 {
		payload = payload[:idx]
	}
	return strings.TrimSpace(payload)
}
