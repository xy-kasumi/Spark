// SPDX-License-Identifier: AGPL-3.0-or-later
package main

import (
	"bufio"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"time"

	"go.bug.st/serial"
)

type atomicCommand struct {
	commands []string
	resCh    chan string // empty string means "ok". Otherwise error message.
}

type commandContext struct {
	sent  time.Time
	resCh chan string // empty string means "ok". Otherwise error message.
}

// Singleton corresponding to single physical machine & port.
type coreBoard struct {
	ser    serial.Port
	commCh chan atomicCommand
	status *machineStatus // pointer to make atomic
}

func parseCoreStatus(line string) (machineStatus, bool) {
	line = strings.TrimSpace(line)
	if !strings.HasPrefix(line, "I ready ") {
		return machineStatus{}, false
	}

	// Remove "I ready " prefix, leaving "X0.000 Y0.000 Z0.000"
	coordString := strings.TrimPrefix(line, "I ready ")
	parts := strings.Fields(coordString)

	mstat := machineStatus{State: MACHINE_OK}

	// Parse each coordinate part (e.g. "X0.000", "Y0.000", "Z0.000")
	for _, part := range parts {
		if len(part) < 2 {
			continue
		}

		axis := part[0]
		valueStr := part[1:]
		value, err := strconv.ParseFloat(valueStr, 64)
		if err != nil {
			continue // Skip invalid coordinates
		}

		switch axis {
		case 'X':
			mstat.XPos = value
		case 'Y':
			mstat.YPos = value
		case 'Z':
			mstat.ZPos = value
		}
	}

	return mstat, true
}

func initProtocol(portName string, baud int, logCh chan logEntry) *coreBoard {
	m := &coreBoard{
		commCh: make(chan atomicCommand, 10),
	}

	mode := &serial.Mode{BaudRate: baud}
	ser, err := serial.Open(portName, mode)
	if err != nil {
		slog.Error("failed to open serial port", "port", portName, "baud", baud, "error", err)
		return nil
	}
	slog.Info("opened serial port", "port", portName, "baud", baud)
	m.ser = ser

	cmdExecOkCh := make(chan int, 1)

	var cmdCtxMtx sync.Mutex
	cmdCtxMap := make(map[int]commandContext)

	// start serial read goroutine
	go func() {
		cmdIx := 1
		cmdExecOkCh <- cmdIx

		stateExec := false
		currCommandErrOut := "" // only capture first one. "" means success

		r := bufio.NewReader(ser)
		slog.Info("Starting serial read goroutine")
		for {
			var raw string
			// Don't give up until success. Reduce log spam by exponential backoff.
			waitTime := time.Millisecond * 500
			for {
				raw, err = r.ReadString('\n')
				if err == nil {
					break
				}
				slog.Error("serial port read error; retrying", "error", err)
				time.Sleep(waitTime)
				waitTime *= 2
			}
			raw = strings.TrimSpace(raw)

			slog.Info("received", "raw", raw, "length", len(raw), "commandIx", cmdIx)
			logCh <- logEntry{
				up:   true,
				data: raw,
				time: time.Now(),
			}

			if strings.HasPrefix(raw, "I") {
				if stateExec {
					// Previous command finished, allow next command execution.
					cmdCtxMtx.Lock()
					ctx, ok := cmdCtxMap[cmdIx]
					if !ok {
						slog.Error("response to unknown command", "commandIx", cmdIx)
						panic("assertion failed")
					}
					ctx.resCh <- currCommandErrOut
					delete(cmdCtxMap, cmdIx)
					cmdCtxMtx.Unlock()

					cmdIx++
					cmdExecOkCh <- cmdIx
				}
				stateExec = false

				// status & command finish
				mStat, ok := parseCoreStatus(raw)
				if ok {
					m.status = &mStat
				} else {
					slog.Warn("missing impl: ignored unparsable core status", "core", raw)
				}
			} else if strings.HasPrefix(raw, ">") {
				stateExec = true
				if strings.HasPrefix(raw, ">err ") {
					currCommandErrOut = strings.TrimPrefix(raw, ">err ")
				}
			} else {
				// others (unexpected)
				slog.Error("unknown message", "raw", raw)
			}
		}
	}()

	// start serial write goroutine
	go func() {
		for {
			cmd := <-m.commCh

			for _, cmdString := range cmd.commands {
				if strings.Contains(cmdString, "\n") {
					slog.Error("command contains \\n", "cmd", cmdString)
					panic("assertion failed")
				}

				commandIx := <-cmdExecOkCh
				cmdCtxMtx.Lock()
				cmdCtxMap[commandIx] = commandContext{
					sent:  time.Now(),
					resCh: cmd.resCh,
				}
				cmdCtxMtx.Unlock()

				// Don't give up until success. Reduce log spam by exponential backoff.
				waitTime := time.Millisecond * 500
				for {
					_, err := ser.Write([]byte(cmdString + "\n"))
					if err == nil {
						break
					}
					slog.Error("serial port write error; retrying", "error", err)
					time.Sleep(waitTime)
					waitTime *= 2
				}

				slog.Debug("sent", "raw", cmdString, "commandIx", commandIx)
				logCh <- logEntry{
					up:   false,
					data: cmdString,
					time: time.Now(),
				}
			}
		}
	}()

	return m
}

func (m *coreBoard) Close() {
	m.ser.Close()
}

// goroutine-safe
// command must not contain \n
// result chan: returns single value upon command reception (not execution completion).
// empty string means "ok". Otherwise error message.
func (m *coreBoard) enqueue(command string) chan string {
	resultChan := make(chan string, 1)
	m.commCh <- atomicCommand{
		commands: []string{command},
		resCh:    resultChan,
	}
	return resultChan
}

// goroutine-safe
// guaranteed that commands are executed back-to-back, in-order, uninterrupted by other enqueue() or enqueueSeq() calls.
// commands must not contain \n
// result chan: returns same number of strings as commands, when all commands are accepted.
// empty value means command was successful. Otherwise error.
func (m *coreBoard) enqueueSeq(commands []string) chan []string {
	tempChan := make(chan string)
	m.commCh <- atomicCommand{
		commands: commands,
		resCh:    tempChan,
	}

	resultChan := make(chan []string, 1)
	go func() {
		var combinedResult []string
		for i := 0; i < len(commands); i++ {
			result := <-tempChan
			combinedResult = append(combinedResult, result)
		}
		resultChan <- combinedResult
	}()
	return resultChan
}

func (m *coreBoard) getStatus() machineStatus {
	if m.status == nil {
		return machineStatus{
			State: MACHINE_OFFLINE,
		}
	}
	return *m.status
}
