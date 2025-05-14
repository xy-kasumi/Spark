// SPDX-License-Identifier: AGPL-3.0-or-later
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"sync/atomic"
	"time"
)

// writeRequest defines the expected JSON payload
type writeRequest struct {
	Data string `json:"data"`
}

type machineStatus struct {
	XPos float64
	YPos float64
	ZPos float64
}

type statusResponse struct {
	Status    string  `json:"status"`
	CoreState string  `json:"core_state"`
	XPos      float64 `json:"x_pos"`
	YPos      float64 `json:"y_pos"`
	ZPos      float64 `json:"z_pos"`
}

// Data that arrived within certain time gap.
type logEntry struct {
	up   bool // up: client->host, down: host->client
	data string
	time time.Time
}

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
	builder.WriteString(time.Local().Format("2006-01-02 15:04:05.000"))
	if up {
		builder.WriteString(">")
	} else {
		builder.WriteString("<")
	}
	builder.WriteString(data)
	return builder.String()
}

func main() {
	portName := flag.String("port", "COM3", "Serial port name")
	baud := flag.Int("baud", 115200, "Serial port baud rate")
	addr := flag.String("addr", ":9000", "HTTP listen address")
	verbose := flag.Bool("verbose", false, "Verbose logging")
	flag.Parse()

	if verbose != nil && *verbose {
		slog.SetLogLoggerLevel(slog.LevelDebug)
	}

	// log
	logCh := make(chan logEntry)
	var logPtr atomic.Pointer[[]logEntry]
	go func() {
		var buf []logEntry
		for {
			log := <-logCh
			buf = append(buf, log)

			logForRead := slices.Clone(buf)
			logPtr.Store(&logForRead)
		}
	}()

	machine := initGrblhal(*portName, *baud, logCh)
	if machine == nil {
		return
	}
	defer machine.Close()

	// HTTP handler to write data
	http.HandleFunc("/status", func(w http.ResponseWriter, r *http.Request) {
		slog.Debug("/status")
		if !handleCommom(w, r) {
			return
		}

		resultCh := machine.enqueue("?")
		<-resultCh

		mStat := machine.getStatus()

		statusResponse := statusResponse{Status: "ok", CoreState: "idle"}
		statusResponse.XPos = mStat.XPos
		statusResponse.YPos = mStat.YPos
		statusResponse.ZPos = mStat.ZPos

		w.WriteHeader(http.StatusOK)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(&statusResponse)
	})

	// TODO: This should become a G-code
	// Spooler can have printer profile file.
	http.HandleFunc("/home", func(w http.ResponseWriter, r *http.Request) {
		slog.Debug("/home")
		if !handleCommom(w, r) {
			return
		}
		var req writeRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			fmt.Fprintf(w, "invalid JSON: %v", err)
			return
		}

		resultCh := machine.enqueueSeq([]string{
			"$5=7",
			"$14=7",
			"$X",
		})
		<-resultCh

		w.WriteHeader(http.StatusOK)
		fmt.Fprintln(w, "doing")
	})

	http.HandleFunc("/write", func(w http.ResponseWriter, r *http.Request) {
		slog.Debug("/write")
		if !handleCommom(w, r) {
			return
		}
		var req writeRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			fmt.Fprintf(w, "invalid JSON: %v", err)
			return
		}

		// TODO: multi-command handling
		var cmds []string
		lines := strings.Split(req.Data, "\n")
		for _, line := range lines {
			line = strings.TrimSpace(line)
			if line != "" {
				cmds = append(cmds, line)
			}
		}
		machine.enqueueSeq(cmds)

		w.WriteHeader(http.StatusOK)
		fmt.Fprintln(w, "ok")
	})

	http.HandleFunc("/get-core-log", func(w http.ResponseWriter, r *http.Request) {
		slog.Debug("/get-core-log")
		if !handleCommom(w, r) {
			return
		}
		builder := strings.Builder{}
		logs := logPtr.Load()
		for _, log := range *logs {
			builder.WriteString(packLog(log.up, log.data, log.time))
			builder.WriteString("\n")
		}
		output := builder.String()

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"output": output})
	})

	slog.Info("HTTP server started listening", "port", *addr)
	if err := http.ListenAndServe(*addr, nil); err != nil {
		slog.Error("HTTP server error", "error", err)
	}
}
