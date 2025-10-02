package main

import (
	"shell-spooler/comm"
	"slices"
	"sync"
	"time"
)

type PSDB struct {
	mu   sync.RWMutex
	data map[string][]PStateWithTime
}

type PStateWithTime struct {
	PState comm.PState
	Time   time.Time
}

func NewPSDB() *PSDB {
	return &PSDB{
		data: make(map[string][]PStateWithTime),
	}
}

// Add new ps. tm should be monotically increasing. (otherwise add will be slow)
// Duplicate tm is allowed (all data are retained).
func (db *PSDB) AddPS(ps comm.PState, tm time.Time) {
	db.mu.Lock()
	defer db.mu.Unlock()

	entries := db.data[ps.Tag]
	n := len(entries)
	if n == 0 || tm.After(entries[n-1].Time) {
		entries = append(entries, PStateWithTime{PState: ps, Time: tm})
		db.data[ps.Tag] = entries
		return
	}

	// Need to find insertion point.
	i, _ := slices.BinarySearchFunc(entries, tm, func(e PStateWithTime, t time.Time) int {
		if e.Time.Before(t) {
			return -1
		} else if e.Time.After(t) {
			return 1
		} else {
			return 0
		}
	})
	db.data[ps.Tag] = slices.Insert(entries, i, PStateWithTime{PState: ps, Time: tm})
}

// Retrieves at most n latest p-states having given tag, in latest-first order.
func (db *PSDB) GetLatestPS(tag string, n int) []PStateWithTime {
	db.mu.RLock()
	defer db.mu.RUnlock()

	entries, ok := db.data[tag]
	if !ok || len(entries) == 0 {
		return nil
	}

	if n > len(entries) {
		n = len(entries)
	}
	ret := slices.Clone(entries[len(entries)-n:])
	slices.Reverse(ret)
	return ret
}
