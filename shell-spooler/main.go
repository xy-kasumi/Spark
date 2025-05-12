// SPDX-License-Identifier: AGPL-3.0-or-later
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"go.bug.st/serial.v1"
)

// writeRequest defines the expected JSON payload
type writeRequest struct {
	Data string `json:"data"`
}

type statusResponse struct {
	Status        string  `json:"status"`
	CoreStatusRaw string  `json:"core_status_raw"`
	CoreState     string  `json:"core_state"`
	XPos          float64 `json:"x_pos"`
	YPos          float64 `json:"y_pos"`
	ZPos          float64 `json:"z_pos"`
}

// Data that arrived within certain time gap.
type logEntry struct {
	up   bool // up: client->host, down: host->client
	data string
	time time.Time
}

var (
	coreLogMu sync.Mutex

	recvTime   time.Time
	recvBuffer strings.Builder
	logs       []logEntry
	//coreLog   strings.Builder
)

// handleCommon returns true if caller should continue RPC processing.
func handleCommom(w http.ResponseWriter, r *http.Request) bool {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return false
	}
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return false
	}
	return true
}

func packLog(up bool, data string, time time.Time) string {
	var builder strings.Builder
	builder.WriteString(fmt.Sprintf("%s", time.Local().Format("2006-01-02 15:04:05.000")))
	if up {
		builder.WriteString(">")
	} else {
		builder.WriteString("<")
	}
	builder.WriteString(data)
	return builder.String()
}

func parseGrblStatus(line string, status *statusResponse) bool {
	line = strings.TrimSpace(line)
	log.Printf("parseGrbl: %s\n", line)
	if !strings.HasPrefix(line, "<") || !strings.HasSuffix(line, ">") {
		return false
	}
	log.Printf("parseGrblHas<>\n")

	line = strings.Trim(line, "<>")
	parts := strings.Split(line, "|")
	if len(parts) < 2 {
		return false
	}
	log.Printf("parseGrblHasParts\n")

	status.CoreState = parts[0]

	for _, part := range parts[1:] {
		if strings.HasPrefix(part, "MPos:") {
			log.Printf("parseGrblHasMPos\n")
			// e.g. part=="MPos:0.000,0.000,0.000"
			coords := strings.Split(strings.TrimPrefix(part, "MPos:"), ",")
			if len(coords) >= 3 {
				v, err := strconv.ParseFloat(strings.TrimSpace(coords[0]), 64)
				if err != nil {
					return false
				}
				status.XPos = v

				v, err = strconv.ParseFloat(strings.TrimSpace(coords[1]), 64)
				if err != nil {
					return false
				}
				status.YPos = v

				v, err = strconv.ParseFloat(strings.TrimSpace(coords[2]), 64)
				if err != nil {
					return false
				}
				status.ZPos = v
			}
		}
	}

	return true
}

func main() {
	portName := flag.String("port", "COM3", "Serial port name")
	baud := flag.Int("baud", 115200, "Serial port baud rate")
	addr := flag.String("addr", ":9000", "HTTP listen address")
	flag.Parse()

	mode := &serial.Mode{BaudRate: *baud}
	ser, err := serial.Open(*portName, mode)
	if err != nil {
		log.Fatalf("failed to open serial port (%v, baud=%v): %v", *portName, *baud, err)
	}
	defer ser.Close()

	// start serial read goroutine
	go func() {
		buf := make([]byte, 1024)
		for {
			n, err := ser.Read(buf)
			if n > 0 {
				// Add new log
				coreLogMu.Lock()
				recvBuffer.Write(buf[:n])
				recvTime = time.Now()

				coreLogMu.Unlock()
			}
			if err != nil {
				log.Printf("serial read error: %v", err)
				time.Sleep(time.Second)
			}
		}
	}()

	go func() {
		for {
			coreLogMu.Lock()
			if time.Now().Sub(recvTime).Seconds() > 0.1 && recvBuffer.Len() > 0 {
				logs = append(logs, logEntry{up: true, data: recvBuffer.String(), time: recvTime})
				recvBuffer.Reset()
			}
			coreLogMu.Unlock()
			time.Sleep(time.Millisecond * 100)
		}
	}()

	writeSerial := func(data string) bool {
		if _, err := ser.Write([]byte(data)); err != nil {
			log.Printf("failed to write to serial: %v", err)
			return false
		}
		coreLogMu.Lock()
		logs = append(logs, logEntry{up: false, data: data, time: time.Now()})
		coreLogMu.Unlock()
		return true
	}

	// HTTP handler to write data
	http.HandleFunc("/status", func(w http.ResponseWriter, r *http.Request) {
		if !handleCommom(w, r) {
			return
		}

		// TODO: This can conflict with other ongoing commands. Spooler needs to order them.
		writeSerial("?\n")
		time.Sleep(150 * time.Millisecond)
		coreResponse := ""
		coreLogMu.Lock()
		if len(logs) > 0 {
			coreResponse = logs[len(logs)-1].data
		}
		coreLogMu.Unlock()

		log.Printf("status: %q", coreResponse)

		statusResponse := statusResponse{Status: "ok", CoreStatusRaw: coreResponse}

		coreResponse = strings.ReplaceAll(coreResponse, "\r\n", "\n")
		lines := strings.Split(coreResponse, "\n")
		log.Printf("status lines: %v", len(lines))
		if len(lines) >= 1 {
			log.Printf("status line[0]: %q", lines[0])
			parseGrblStatus(lines[0], &statusResponse)
		}

		w.WriteHeader(http.StatusOK)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(&statusResponse)
	})

	http.HandleFunc("/home", func(w http.ResponseWriter, r *http.Request) {
		if !handleCommom(w, r) {
			return
		}
		var req writeRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			fmt.Fprintf(w, "invalid JSON: %v", err)
			return
		}

		writeSerial("$5=7\n$14=7\n$X\n")

		w.WriteHeader(http.StatusOK)
		fmt.Fprintln(w, "doing")
	})

	http.HandleFunc("/write", func(w http.ResponseWriter, r *http.Request) {
		if !handleCommom(w, r) {
			return
		}
		var req writeRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			fmt.Fprintf(w, "invalid JSON: %v", err)
			return
		}

		writeSerial(req.Data)

		w.WriteHeader(http.StatusOK)
		fmt.Fprintln(w, "ok")
	})

	http.HandleFunc("/get-core-log", func(w http.ResponseWriter, r *http.Request) {
		if !handleCommom(w, r) {
			return
		}
		builder := strings.Builder{}
		coreLogMu.Lock()
		for _, log := range logs {
			builder.WriteString(packLog(log.up, log.data, log.time))
			builder.WriteString("\n")
		}
		output := builder.String()
		coreLogMu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"output": output})
	})

	log.Printf("listening on %s, writing to %s at %d", *addr, *portName, *baud)
	if err := http.ListenAndServe(*addr, nil); err != nil {
		log.Fatalf("HTTP server error: %v", err)
	}
}
