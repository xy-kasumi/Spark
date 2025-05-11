// SPDX-License-Identifier: AGPL-3.0-or-later
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"

	"go.bug.st/serial.v1"
)

// writeRequest defines the expected JSON payload
type writeRequest struct {
	Data string `json:"data"`
}

func main() {
	// Flags for serial port settings
	portName := flag.String("port", "COM3", "Serial port name")
	baud := flag.Int("baud", 115200, "Serial port baud rate")
	addr := flag.String("addr", ":8080", "HTTP listen address")
	flag.Parse()

	// Open serial port using go.bug.st/serial.v1
	mode := &serial.Mode{BaudRate: *baud}
	ser, err := serial.Open(*portName, mode)
	if err != nil {
		log.Fatalf("failed to open serial port: %v", err)
	}
	defer ser.Close()

	// HTTP handler to write data
	http.HandleFunc("/write", func(w http.ResponseWriter, r *http.Request) {
		// allow CORS for browser-based dashboard
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
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

	log.Printf("listening on %s, writing to %s at %d", *addr, *portName, *baud)
	if err := http.ListenAndServe(*addr, nil); err != nil {
		log.Fatalf("HTTP server error: %v", err)
	}
}
