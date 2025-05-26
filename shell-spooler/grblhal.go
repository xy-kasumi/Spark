// SPDX-License-Identifier: AGPL-3.0-or-later
package main

import (
	"bufio"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"time"

	"go.bug.st/serial.v1"
)

// When t0 = (),
// Not receiving "ok" or "error" within maxCommandTimeout since t0 means board comm failure.
const maxCommandTimeout = 5 * time.Second

type atomicCommand struct {
	commands []string
	resCh    chan string // empty string means "ok". Otherwise error message.
}

type commandContext struct {
	sent  time.Time
	resCh chan string // empty string means "ok". Otherwise error message.
	long  bool        // true if command is long-running (e.g. homing like "$H" or "$HY")
}

// Singleton corresponding to single physical machine & port.
type grblhalMachine struct {
	ser    serial.Port
	commCh chan atomicCommand
	status *machineStatus // pointer to make atomic
}

func parseGrblStatus(line string) (machineStatus, bool) {
	line = strings.TrimSpace(line)
	if !strings.HasPrefix(line, "<") || !strings.HasSuffix(line, ">") {
		return machineStatus{}, false
	}

	line = strings.Trim(line, "<>")
	parts := strings.Split(line, "|")
	if len(parts) < 2 {
		return machineStatus{}, false
	}

	mstat := machineStatus{}
	for _, part := range parts[1:] {
		if strings.HasPrefix(part, "MPos:") {
			// e.g. part=="MPos:0.000,0.000,0.000"
			coords := strings.Split(strings.TrimPrefix(part, "MPos:"), ",")
			if len(coords) >= 3 {
				v, err := strconv.ParseFloat(strings.TrimSpace(coords[0]), 64)
				if err != nil {
					return machineStatus{}, false
				}
				mstat.XPos = v

				v, err = strconv.ParseFloat(strings.TrimSpace(coords[1]), 64)
				if err != nil {
					return machineStatus{}, false
				}
				mstat.YPos = v

				v, err = strconv.ParseFloat(strings.TrimSpace(coords[2]), 64)
				if err != nil {
					return machineStatus{}, false
				}
				mstat.ZPos = v
			}
		}
	}
	return mstat, true
}

func initGrblhal(portName string, baud int, logCh chan logEntry) *grblhalMachine {
	m := &grblhalMachine{
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

		r := bufio.NewReader(ser)
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

			slog.Debug("received", "grbl", raw, "commandIx", cmdIx)
			logCh <- logEntry{
				up:   true,
				data: raw,
				time: time.Now(),
			}

			// Check any command has expired.
			// TODO: this should be timer-based rather to unstuck client in all cases.
			cmdCtxMtx.Lock()
			for k, ctx := range cmdCtxMap {
				if !ctx.long && time.Since(ctx.sent) > maxCommandTimeout {
					slog.Error("command timeout; probably board or comm failure", "commandIx", k, "time_sent", ctx.sent)
					ctx.resCh <- "error: command timeout"
					delete(cmdCtxMap, k)
				}
			}
			cmdCtxMtx.Unlock()

			if m.status != nil && m.status.State == MACHINE_CRIT {
				slog.Warn("Ignoring received data after entering critical state", "grbl", raw)
				continue
			}

			if strings.HasPrefix(raw, "<") {
				// status
				mStat, ok := parseGrblStatus(raw)
				if ok {
					m.status = &mStat
				} else {
					slog.Warn("missing impl: ignored unparsable grblHAL status", "grbl", raw)
				}
			} else if strings.HasPrefix(raw, "ok") || strings.HasPrefix(raw, "error") {
				// command response
				result := ""
				if raw != "ok" {
					result = raw

					if strings.HasPrefix(raw, "error:") {
						errorNumStr := strings.TrimPrefix(raw, "error:")
						errorCode, err := strconv.Atoi(errorNumStr)
						if err != nil {
							slog.Error("Invalid error message", "grbl", raw)
						} else {
							errorText, ok := grblErrorMessages[errorCode]
							if ok {
								slog.Info("grblHAL error", "code", errorCode, "message", errorText)
							}
						}
					}
				}

				cmdCtxMtx.Lock()
				ctx, ok := cmdCtxMap[cmdIx]
				if !ok {
					slog.Error("response to unknown command", "commandIx", cmdIx)
					panic("assertion failed")
				}
				ctx.resCh <- result
				delete(cmdCtxMap, cmdIx)
				cmdCtxMtx.Unlock()

				// Allow next command writing by issuing a new commandIx.
				cmdIx++
				cmdExecOkCh <- cmdIx
			} else if strings.HasPrefix(raw, "[") {
				// custom text or log
				slog.Info("(unimpl) custom status message", "grbl", raw)
			} else if strings.HasPrefix(raw, "ALARM:") {
				// machine failed critically (will reset automatically)
				critMsg := raw

				numStr := strings.TrimPrefix(raw, "ALARM:")
				num, err := strconv.Atoi(numStr)
				if err != nil {
					slog.Error("Invalid alarm message", "grbl", raw)
				} else {
					errorText, ok := grblAlarmMessages[num]
					if ok {
						critMsg = errorText
					}
				}
				status := machineStatus{
					State:   MACHINE_CRIT,
					CritMsg: critMsg,
				}
				m.status = &status

				slog.Error("Entered critical state after ALARM", "grbl", raw, "message", critMsg)
			} else {
				// others (like boot banner or alarms)
				slog.Info("(unimpl) unknown status message", "grbl", raw)
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

				if m.status != nil && m.status.State == MACHINE_CRIT {
					slog.Error("command not sent; machine in critical state", "cmd", cmdString)
					cmd.resCh <- "error: machine in critical state"
					continue
				}

				//longCommand := strings.HasPrefix(cmdString, "$H") || strings.HasPrefix(cmdString, "G1")
				longCommand := true // anything can be long-command when it's after long command and sync=true

				commandIx := <-cmdExecOkCh
				cmdCtxMtx.Lock()
				cmdCtxMap[commandIx] = commandContext{
					sent:  time.Now(),
					resCh: cmd.resCh,
					long:  longCommand,
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

				slog.Debug("sent", "grbl", cmdString, "commandIx", commandIx)
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

func (m *grblhalMachine) Close() {
	m.ser.Close()
}

// goroutine-safe
// command must not contain \n
// result chan: returns single value upon command reception (not execution completion).
// empty string means "ok". Otherwise error message.
func (m *grblhalMachine) enqueue(command string) chan string {
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
func (m *grblhalMachine) enqueueSeq(commands []string) chan []string {
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

func (m *grblhalMachine) getStatus() machineStatus {
	if m.status == nil {
		return machineStatus{
			State: MACHINE_OFFLINE,
		}
	}
	return *m.status
}
