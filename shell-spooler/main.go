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

var (
	coreLogMu sync.Mutex
	coreLog   strings.Builder
)

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
			fmt.Printf("Read %d bytes\n", n)
			if n > 0 {
				coreLogMu.Lock()
				coreLog.Write(buf[:n])
				coreLogMu.Unlock()
			}
			if err != nil {
				log.Printf("serial read error: %v", err)
				time.Sleep(time.Second)
			}
		}
	}()

	// HTTP handler to write data
	http.HandleFunc("/status", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		w.WriteHeader(http.StatusOK)
		fmt.Fprintln(w, `{"status": "ok"}`)
	})
	http.HandleFunc("/write", func(w http.ResponseWriter, r *http.Request) {
		// allow CORS for browser-based dashboard
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
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
		w.WriteHeader(http.StatusOK)
		fmt.Fprintln(w, "ok")
	})

	http.HandleFunc("/get-core-log", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		coreLogMu.Lock()
		output := coreLog.String()
		coreLogMu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"output": output})
	})

	log.Printf("listening on %s, writing to %s at %d", *addr, *portName, *baud)
	if err := http.ListenAndServe(*addr, nil); err != nil {
		log.Fatalf("HTTP server error: %v", err)
	}
}
