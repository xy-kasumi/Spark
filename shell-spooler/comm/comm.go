// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later
package comm

import (
	"strconv"
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

type Comm struct {
	tran      *transport
	psp       *pstateParser
	signalCh  chan string
	commandCh chan string
}

type commHandlerWithParser struct {
	handler CommHandler
	parser  *pstateParser
}

func (h *commHandlerWithParser) PayloadSent(payload string) {
	h.handler.PayloadSent(payload)
}

func (h *commHandlerWithParser) PayloadRecv(payload string) {
	h.handler.PayloadRecv(payload)
	h.parser.update(payload)
}

func (h *commHandlerWithParser) PStateRecv(tag string, ps PState) {
	h.handler.PStateRecv(tag, ps)
}

func InitComm(serialPort string, baud int, handler CommHandler) (*Comm, error) {
	ps := newPstateParser()
	handlerWithParser := &commHandlerWithParser{
		handler: handler,
		parser:  ps,
	}
	tran, err := initTransport(serialPort, baud, handlerWithParser)
	if err != nil {
		return nil, err
	}
	cm := &Comm{
		tran:      tran,
		psp:       ps,
		signalCh:  make(chan string, 10),
		commandCh: make(chan string, 10_000_000),
	}

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

func (cm *Comm) feedCommand() {
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

func (cm *Comm) pollQueueStatus() {
	for {
		if len(cm.commandCh) > 0 {
			cm.signalCh <- "?queue"
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func (cm *Comm) WriteLine(line string) {
	if line[0] == '!' || line[0] == '?' {
		cm.signalCh <- line
	} else {
		cm.commandCh <- line
	}
}

func (cm *Comm) WriteQueueLength() int {
	return len(cm.commandCh)
}

func (cm *Comm) DrainWriteQueue() {
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
