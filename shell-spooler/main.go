// SPDX-License-Identifier: AGPL-3.0-or-later
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"go.bug.st/serial.v1"
)

// writeRequest defines the expected JSON payload
type writeRequest struct {
	Data string `json:"data"`
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

func main() {
	// Flags for serial port settings
	portName := flag.String("port", "COM3", "Serial port name")
	baud := flag.Int("baud", 115200, "Serial port baud rate")
	addr := flag.String("addr", ":9000", "HTTP listen address")
	flag.Parse()

	// Open serial port using go.bug.st/serial.v1
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
				fmt.Printf("Read %d bytes\n", n)
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

	// HTTP handler to write data
	http.HandleFunc("/status", func(w http.ResponseWriter, r *http.Request) {
		if !handleCommom(w, r) {
			return
		}
		w.WriteHeader(http.StatusOK)
		fmt.Fprintln(w, `{"status": "ok"}`)
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

		// Write to serial
		if _, err := ser.Write([]byte(req.Data)); err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			fmt.Fprintf(w, "failed to write to serial: %v", err)
			return
		}
		coreLogMu.Lock()
		logs = append(logs, logEntry{up: false, data: req.Data, time: time.Now()})
		coreLogMu.Unlock()

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
