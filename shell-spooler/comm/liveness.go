// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later
package comm

import (
	"strings"
	"sync"
	"time"
)

// probeHandler watches inbound payloads for anything starting with "queue" or "sys".
type probeHandler struct {
	once   sync.Once
	signal chan struct{}
}

func newProbeHandler() *probeHandler {
	return &probeHandler{
		signal: make(chan struct{}),
	}
}

func (p *probeHandler) PayloadSent(payload string, tm time.Time) {}

func (p *probeHandler) PayloadRecv(payload string, tm time.Time) {
	if !strings.HasPrefix(payload, "queue") && !strings.HasPrefix(payload, "sys") {
		return
	}
	p.once.Do(func() { close(p.signal) })
}

func (p *probeHandler) PStateRecv(ps PState, tm time.Time) {}

// Blocks until the device become responsive.
func WaitAlive(tran *Transport) {
	probe := newProbeHandler()
	tran.SetHandler(probe)
	defer tran.SetHandler(nil)

	tick := time.NewTicker(1000 * time.Millisecond)
	defer tick.Stop()

	// Send one now to quickly detect already-alive case.
	tran.sendPayload("?queue")
	for {
		select {
		case <-probe.signal:
			return
		case <-tick.C:
			tran.sendPayload("?queue")
		}
	}
}
