package main

import (
	"slices"
	"sync"
	"time"
)

type TSDB struct {
	mu   sync.RWMutex
	data map[string][]entry // entries are sorted by t (increasing order)
}

type TSValue interface{}

type entry struct {
	t int64 // unix time in nanosec
	v TSValue
}

func NewTSDB() *TSDB {
	return &TSDB{
		mu:   sync.RWMutex{},
		data: make(map[string][]entry),
	}
}

// Insert data point. If (key, time) exactly matches existing data, overwrite it.
// O(log N) (amortized) if time is newer than previous Insert() for the same key. Not O(1) because of ocassional re-allocation & copy.
// O(N) (where N is number of data points for the key) otherwise.
func (db *TSDB) Insert(key string, time time.Time, value TSValue) {
	db.mu.Lock()
	defer db.mu.Unlock()

	newE := entry{
		t: time.UnixNano(),
		v: value,
	}
	entries, ok := db.data[key]
	// Handle empty case
	if !ok {
		db.data[key] = []entry{newE}
		return
	}

	// Handle append case (most typical)
	if newE.t > entries[len(entries)-1].t {
		db.data[key] = append(entries, newE)
		return
	}

	// Need to find insertion point
	i, found := slices.BinarySearchFunc(entries, newE.t, func(e entry, t int64) int {
		if e.t < t {
			return -1
		} else if e.t > t {
			return 1
		} else {
			return 0
		}
	})

	if found {
		// overwrite
		entries[i] = newE
	} else {
		// insert
		db.data[key] = slices.Insert(entries, i, newE)
	}
}

func sampleTimes(start int64, end int64, step int64) []int64 {
	res := []int64{}
	curr := start
	for curr <= end {
		res = append(res, curr)
		curr += step
	}
	return res
}

// Find latest entry in [start, end]. Return nil if not found.
// O(log N) (where N=len(sortedData))
func findLatestInWindow(start int64, end int64, sortedData []entry) *entry {
	i, _ := slices.BinarySearchFunc(sortedData, end, func(e entry, t int64) int {
		if e.t < t {
			return -1
		} else if e.t > t {
			return 1
		} else {
			return 0
		}
	})
	i = min(i, len(sortedData)-1) // binary search can return len(sortedData)
	for i >= 0 {
		t := sortedData[i].t
		if start <= t && t <= end {
			return &sortedData[i]
		}
		if t < start {
			return nil
		}
		i--
	}
	return nil
}

// Query time series of specified keys with periodic sampling.
//
// `start`, `end`, `step` determines query timestamps like
// * start + step * 0, start + step * 1, ...
// * last timestamp <= end
//
// For each timestamp T, latest original data point in window [T-step, T] is returned.
// If no data is found, nil is returned.
// QueryRanges never mix (interpolate) between samples.
//
// O(log N * K * S) (where N is number of data points per key, K=len(keys), S=number of sample timestamps)
func (db *TSDB) QueryRanges(keys []string, start time.Time, end time.Time, step time.Duration) ([]time.Time, map[string][]TSValue) {
	sampleTs := sampleTimes(start.UnixNano(), end.UnixNano(), step.Nanoseconds())

	db.mu.RLock()
	defer db.mu.RUnlock()

	tms := make([]time.Time, len(sampleTs))
	valsMap := make(map[string][]TSValue)
	for i, t := range sampleTs {
		tms[i] = time.Unix(0, t)
	}
	for _, key := range keys {
		valsMap[key] = make([]TSValue, len(sampleTs))
		entries, ok := db.data[key]
		if !ok {
			continue // all values are nil
		}
		for i, t := range sampleTs {
			e := findLatestInWindow(t-step.Nanoseconds(), t, entries)
			if e != nil {
				valsMap[key][i] = e.v
			}
		}
	}
	return tms, valsMap
}
