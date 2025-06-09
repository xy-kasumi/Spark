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

type writeRequest struct {
	Commands []string `json:"commands"` // list of commands. cannot contain newline
}

type writeResponse struct {
	Error          *string   `json:"error"`           // error of request processing itself. null means no error (commands are executed).
	CommandSuccess bool      `json:"command_success"` // true if all commands succesfully executed.
	CommandErrors  []*string `json:"command_errors"`  // errors for each command. null if success.
}

type statusResponse struct {
	Status string  `json:"status"`
	XPos   float64 `json:"x_pos"`
	YPos   float64 `json:"y_pos"`
	ZPos   float64 `json:"z_pos"`
}

type machineState int

const (
	MACHINE_OFFLINE machineState = iota
	MACHINE_OK
	MACHINE_CRIT
)

type machineStatus struct {
	XPos    float64
	YPos    float64
	ZPos    float64
	State   machineState
	CritMsg string
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

func respondJson(w http.ResponseWriter, resp any) {
	w.WriteHeader(http.StatusOK)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
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

	machine := initProtocol(*portName, *baud, logCh)
	if machine == nil {
		return
	}
	defer machine.Close()

	// HTTP handler to write data
	http.HandleFunc("/status", func(w http.ResponseWriter, r *http.Request) {
		if !handleCommom(w, r) {
			return
		}

		slog.Debug("/status")
		resultCh := machine.enqueue("help")
		select {
		case <-time.After(500 * time.Millisecond):
			slog.Debug("timeout waiting for help response in /status")
		case <-resultCh:
		}

		mStat := machine.getStatus()

		resp := statusResponse{Status: "OK"}
		resp.XPos = mStat.XPos
		resp.YPos = mStat.YPos
		resp.ZPos = mStat.ZPos
		if mStat.State == MACHINE_CRIT {
			resp.Status = "critical: " + mStat.CritMsg
		}

		respondJson(w, &resp)
	})

	// TODO: This should become a G-code or macro-ish thing in /write, maybe.
	http.HandleFunc("/init", func(w http.ResponseWriter, r *http.Request) {
		if !handleCommom(w, r) {
			return
		}

		slog.Debug("/init")
		var req writeRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			fmt.Fprintf(w, "invalid JSON: %v", err)
			return
		}

		resultCh := machine.enqueueSeq(homeCommandSeq)
		<-resultCh

		w.WriteHeader(http.StatusOK)
		fmt.Fprintln(w, "doing")
	})

	http.HandleFunc("/write", func(w http.ResponseWriter, r *http.Request) {
		if !handleCommom(w, r) {
			return
		}

		slog.Debug("/write")
		var req writeRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			fmt.Fprintf(w, "invalid JSON: %v", err)
			return
		}

		// Validate request content
		if len(req.Commands) == 0 {
			errMsg := `1 or more "commands" required`
			resp := writeResponse{Error: &errMsg}
			respondJson(w, &resp)
			return
		}
		for _, cmd := range req.Commands {
			if strings.Contains(cmd, "\n") {
				errMsg := fmt.Sprintf(`command cannot contain newline: %q`, cmd)
				resp := writeResponse{Error: &errMsg}
				respondJson(w, &resp)
				return
			}
		}

		// Execute
		resultCh := machine.enqueueSeq(req.Commands)
		errors := <-resultCh

		resp := writeResponse{CommandSuccess: true}
		for _, err := range errors {
			if err != "" {
				resp.CommandSuccess = false
				resp.CommandErrors = append(resp.CommandErrors, &err)
			} else {
				resp.CommandErrors = append(resp.CommandErrors, nil)
			}
		}
		respondJson(w, &resp)
	})

	http.HandleFunc("/get-core-log", func(w http.ResponseWriter, r *http.Request) {
		if !handleCommom(w, r) {
			return
		}

		slog.Debug("/get-core-log")
		builder := strings.Builder{}
		logs := logPtr.Load()
		for _, log := range *logs {
			builder.WriteString(packLog(log.up, log.data, log.time))
			builder.WriteString("\n")
		}
		output := builder.String()

		resp := map[string]string{"output": output}
		respondJson(w, resp)
	})

	slog.Info("HTTP server started listening", "port", *addr)
	if err := http.ListenAndServe(*addr, nil); err != nil {
		slog.Error("HTTP server error", "error", err)
	}
}
