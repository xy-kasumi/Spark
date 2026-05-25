// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later
package comm

import (
	"log/slog"
	"strings"
	"sync"
	"time"
)

// deadThreshold is the maximum time without a queue p-state before the device is declared dead.
const deadThreshold = 1 * time.Second

type Comm struct {
	tran        *Transport
	parser      PStateParser
	handler     CommHandler
	immediateCh chan string
	commandCh   chan string

	muQueue       *sync.Mutex
	latestQueue   *psQueue
	okToSend      int
	lastQueueTime time.Time

	stop      chan struct{}
	dead      chan struct{}
	closeOnce sync.Once
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

// AttachComm wires a Comm onto an already-open Transport, takes over its handler slot,
// and starts the polling / flow-control / liveness goroutines.
func AttachComm(tran *Transport, handler CommHandler) *Comm {
	cm := &Comm{
		tran:          tran,
		handler:       handler,
		parser:        NewPStateParser(),
		immediateCh:   make(chan string, 10),
		commandCh:     make(chan string, 10_000_000), // must be bigger than any G-code file
		muQueue:       &sync.Mutex{},
		lastQueueTime: time.Now(),
		stop:          make(chan struct{}),
		dead:          make(chan struct{}),
	}
	tran.SetHandler(cm)

	go cm.pollQueue()
	go cm.feedImmediate()
	go cm.feedCommand()
	go cm.watchLiveness()
	return cm
}

func (cm *Comm) pollQueue() {
	for {
		select {
		case <-cm.stop:
			return
		case <-time.After(250 * time.Millisecond):
		}
		select {
		case cm.immediateCh <- "?queue":
		case <-cm.stop:
			return
		}
	}
}

func (cm *Comm) handleQueueStatus(q *psQueue) {
	const maxFillRate = 0.75

	cm.muQueue.Lock()
	defer cm.muQueue.Unlock()

	cm.latestQueue = q
	cm.okToSend = int(float64(q.Cap)*maxFillRate) - q.Num
	cm.lastQueueTime = time.Now()
}

func (cm *Comm) watchLiveness() {
	tick := time.NewTicker(500 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-cm.stop:
			return
		case <-tick.C:
			cm.muQueue.Lock()
			elapsed := time.Since(cm.lastQueueTime)
			cm.muQueue.Unlock()
			if elapsed > deadThreshold {
				close(cm.dead)
				return
			}
		}
	}
}

// WaitDead blocks until the device is declared dead (no queue p-state for deadThreshold).
func (cm *Comm) WaitDead() {
	<-cm.dead
}

func (cm *Comm) feedImmediate() {
	for {
		select {
		case <-cm.stop:
			return
		case line := <-cm.immediateCh:
			cm.tran.sendPayload(line)
		}
	}
}

func (cm *Comm) feedCommand() {
	for {
		// Wait until flow control allows a send, or we are stopped.
		for {
			cm.muQueue.Lock()
			canSend := cm.okToSend > 0
			cm.muQueue.Unlock()
			if canSend {
				break
			}
			select {
			case <-cm.stop:
				return
			case <-time.After(50 * time.Millisecond):
			}
		}

		var line string
		select {
		case <-cm.stop:
			return
		case line = <-cm.commandCh:
		}
		cm.tran.sendPayload(line)
		cm.muQueue.Lock()
		cm.okToSend--
		cm.muQueue.Unlock()
	}
}

// SendImmediate sends payload bypassing the command queue and its flow-control.
// Routing is the caller's responsibility. Silently dropped if the Comm is stopped.
func (cm *Comm) SendImmediate(payload string) {
	select {
	case cm.immediateCh <- payload:
	case <-cm.stop:
	}
}

func (cm *Comm) WriteCommand(payload string) {
	payload = cleanupGCode(payload)
	if payload == "" {
		return
	}
	select {
	case cm.commandCh <- payload:
	case <-cm.stop:
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
			return
		}
	}
}

// Detach this Comm from the underlying transport (transport itself is left open).
func (cm *Comm) Close() {
	cm.closeOnce.Do(func() {
		cm.tran.SetHandler(nil)
		close(cm.stop)
	})
}

func cleanupGCode(payload string) string {
	if idx := strings.Index(payload, ";"); idx != -1 {
		payload = payload[:idx]
	}
	return strings.TrimSpace(payload)
}
