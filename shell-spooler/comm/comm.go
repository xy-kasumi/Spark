// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later
package comm

import (
	"log/slog"
	"strings"
	"time"
)

type Comm struct {
	tran        *transport
	parser      PStateParser
	handler     CommHandler
	signalCh    chan string
	commandCh   chan string
	latestQueue *psQueue
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
			cm.latestQueue = q
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
	}
	tran, err := initTransport(serialPort, baud, cm)
	if err != nil {
		return nil, err
	}
	cm.tran = tran

	go cm.feedSignal()
	go cm.feedCommand()
	return cm, nil
}

func (cm *Comm) feedSignal() {
	for {
		line := <-cm.signalCh
		cm.tran.sendPayload(line)
	}
}

func (cm *Comm) queryQueueBlocking() psQueue {
	const queueSignalTimeout = 1 * time.Second
	for {
		cm.latestQueue = nil
		cm.signalCh <- "?queue"
		sent := time.Now()
		for {
			if cm.latestQueue != nil {
				return *cm.latestQueue
			}
			if time.Now().After(sent.Add(queueSignalTimeout)) {
				// queue signal timeout can happen in core reboot)
				break
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
}

func (cm *Comm) feedCommand() {
	const maxFillRate = 0.75
	okToSend := 0

	for {
		queueQueryInterval := 100 * time.Millisecond
		for {
			if okToSend > 0 {
				break
			}
			time.Sleep(queueQueryInterval)
			qs := cm.queryQueueBlocking()
			okToSend = int(float64(qs.Cap)*maxFillRate) - qs.Num
			// When core queue has many slow commands, no point in querying too often.
			// Gradually reduce query frequency by exponential backoff.
			queueQueryInterval *= 2
		}

		line := <-cm.commandCh
		cm.tran.sendPayload(line)
		okToSend--
	}
}

func (cm *Comm) SendSignal(payload string) {
	if !IsSignal(payload) {
		panic("not a signal: " + payload)
	}
	cm.signalCh <- payload
}

// TODO: move queue out
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
	return len(cm.commandCh)
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
