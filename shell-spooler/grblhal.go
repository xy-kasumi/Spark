// SPDX-License-Identifier: AGPL-3.0-or-later
package main

import (
	"bufio"
	"log"
	"strconv"
	"strings"
	"sync"
	"time"

	"go.bug.st/serial.v1"
)

type atomicCommand struct {
	commands   []string
	resultChan chan string // empty string means "ok". Otherwise error message.
}

// Singleton corresponding to single physical machine & port.
type grblhalMachine struct {
	commCh chan atomicCommand
	status *machineStatus // pointer to make atomic
}

func parseGrblStatus(line string) (machineStatus, bool) {
	line = strings.TrimSpace(line)
	log.Printf("parseGrbl: %s\n", line)
	if !strings.HasPrefix(line, "<") || !strings.HasSuffix(line, ">") {
		return machineStatus{}, false
	}
	log.Printf("parseGrblHas<>\n")

	line = strings.Trim(line, "<>")
	parts := strings.Split(line, "|")
	if len(parts) < 2 {
		return machineStatus{}, false
	}
	log.Printf("parseGrblHasParts\n")

	mstat := machineStatus{}
	for _, part := range parts[1:] {
		if strings.HasPrefix(part, "MPos:") {
			log.Printf("parseGrblHasMPos\n")
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
	log.Printf("Initializing GRBL with port: %s and baud: %d", portName, baud)

	m := &grblhalMachine{
		commCh: make(chan atomicCommand, 10),
	}

	mode := &serial.Mode{BaudRate: baud}
	ser, err := serial.Open(portName, mode)
	if err != nil {
		log.Fatalf("failed to open serial port (%v, baud=%v): %v", portName, baud, err)
	}
	defer ser.Close()

	commandExecAllowedCh := make(chan int)

	var resultMapMtx sync.Mutex
	resultMap := make(map[int]chan string)

	// start serial read goroutine
	go func() {
		commandIx := 1
		commandExecAllowedCh <- commandIx

		r := bufio.NewReader(ser)
		for {
			raw, err := r.ReadString('\n')
			if err != nil {
				log.Printf("serial port read error: %v", err)
				continue
			}

			raw = strings.TrimSpace(raw)

			logCh <- logEntry{
				up:   true,
				data: raw,
				time: time.Now(),
			}

			// TODO: Do some processing
			if strings.HasPrefix(raw, "<") {
				// status
				mStat, ok := parseGrblStatus(raw)
				if ok {
					m.status = &mStat
				} else {
					log.Printf("warning, impl error: ignored unparsable grblHAL status: %q", raw)
				}
			} else if strings.HasPrefix(raw, "ok") || strings.HasPrefix(raw, "error") {
				// command response
				result := ""
				if raw != "ok" {
					result = raw
				}

				resultMapMtx.Lock()
				resultChan, ok := resultMap[commandIx]
				if !ok {
					log.Panicf("response to unknown command %d", commandIx)
				}
				resultChan <- result
				delete(resultMap, commandIx)
				resultMapMtx.Unlock()

				// Allow next command writing by issuing a new commandIx.
				commandIx++
				commandExecAllowedCh <- commandIx
			} else if strings.HasPrefix(raw, "[") {
				// custom text or log
				log.Printf("(unimpl) custom status message: %q", raw)
			} else {
				// others (like boot banner or alarms)
				log.Printf("(unimpl) unknown status message: %q", raw)
			}
		}
	}()

	// start serial write goroutine
	go func() {
		for {
			cmd := <-m.commCh

			for _, cmdString := range cmd.commands {
				if strings.Contains(cmdString, "\n") {
					log.Panicf("command contains \\n: %q", cmdString)
				}

				commandIx := <-commandExecAllowedCh
				resultMapMtx.Lock()
				resultMap[commandIx] = cmd.resultChan
				resultMapMtx.Unlock()

				// Don't give up until success. Reduce log spam by exponential backoff.
				waitTime := time.Millisecond * 500
				for {
					_, err := ser.Write([]byte(cmdString))
					if err == nil {
						break
					}
					log.Printf("serial port write error: %v; retrying", err)
					time.Sleep(waitTime)
					waitTime *= 2
				}

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

// goroutine-safe
// command must not contain \n
// result chan: returns single value upon command reception (not execution completion).
// empty string means "ok". Otherwise error message.
func (m *grblhalMachine) enqueue(command string) chan string {
	resultChan := make(chan string)
	m.commCh <- atomicCommand{
		commands:   []string{command},
		resultChan: resultChan,
	}
	return resultChan
}

// goroutine-safe
// guaranteed that commands are executed back-to-back, in-order, uninterrupted by other enqueue() or enqueueSeq() calls.
// commands must not contain \n
// result chan: returns same number of strings as commands, when all commands are accepted.
// empty value means command was "ok". Otherwise error.
func (m *grblhalMachine) enqueueSeq(commands []string) chan []string {
	tempChan := make(chan string)
	m.commCh <- atomicCommand{
		commands:   commands,
		resultChan: tempChan,
	}

	resultChan := make(chan []string)
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
	return *m.status
}
