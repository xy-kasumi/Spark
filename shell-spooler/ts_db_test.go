package main

import (
	"slices"
	"testing"
	"time"

	"pgregory.net/rapid"
)

func genDate(t *rapid.T, label string) time.Time {
	min := time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC).UnixNano()
	max := time.Date(2100, 1, 1, 0, 0, 0, 0, time.UTC).UnixNano()
	return time.Unix(0, rapid.Int64Range(min, max).Draw(t, label))
}

func TestQueryShapeEmptyDB(t *testing.T) {
	db := NewTSDB()

	rapid.Check(t, func(t *rapid.T) {
		start := genDate(t, "start")
		dur := time.Duration(rapid.Int64Range(0, time.Hour.Nanoseconds()).Draw(t, "dur"))
		keys := rapid.SliceOf(rapid.String()).Draw(t, "keys")
		end := start.Add(dur)
		step := time.Minute

		tms, valsMap := db.QueryRanges(keys, start, end, step)
		// Check timestamps
		if len(tms) == 0 {
			t.Fatalf("at least one timestamp is expected")
		}
		if !slices.IsSortedFunc(tms, func(a, b time.Time) int {
			return a.Compare(b)
		}) {
			t.Fatalf("timestamps are not increasing %v", tms)
		}
		for _, tm := range tms {
			if tm.Before(start) || tm.After(end) {
				t.Fatalf("timestamp %v is out of range [%v, %v]", tm, start, end)
			}
		}
		// Check values
		for _, key := range keys {
			_, ok := valsMap[key]
			if !ok {
				t.Fatalf("key %s not found in values", key)
			}
		}
		for key, vals := range valsMap {
			if !slices.Contains(keys, key) {
				t.Fatalf("unexpected key in values: %s", key)
			}
			if len(vals) != len(tms) {
				t.Fatalf("(key=%s) value array length didn't match: expected =%d, got %d", key, len(tms), len(vals))
			}
			for _, val := range vals {
				if val != nil {
					t.Fatalf("(key=%s) value must be nil, got %v", key, val)
				}
			}
		}
	})
}

func TestQuery(t *testing.T) {
	db := NewTSDB()
	db.Insert("a", time.Date(2000, 1, 1, 0, 0, 1, 0, time.UTC), TSValue(1))   // slightly after 0s
	db.Insert("a", time.Date(2000, 1, 1, 0, 0, 4, 0, time.UTC), TSValue("v")) // slightly before 5s

	// query [0s, 5s], step 1s
	_, valsMap := db.QueryRanges([]string{"a"}, time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC), time.Date(2000, 1, 1, 0, 0, 5, 0, time.UTC), time.Second)
	// 0s=missing-data 1s=data arrived 2s=1s-stale 3s=out-of-window 4s=data-arrived 5s=1s-stale
	expected := []TSValue{nil, TSValue(1), TSValue(1), nil, TSValue("v"), TSValue("v")}
	observed := valsMap["a"]
	if len(observed) != 6 {
		t.Fatalf("value array length didn't match: expected =%d, got %d", len(expected), len(observed))
	}
	for i := range expected {
		if observed[i] != expected[i] {
			t.Errorf("value[%d] didn't match: expected =%v, got %v", i, expected[i], observed[i])
		}
	}
}

func TestQueryOutOfOrderInsert(t *testing.T) {
	db := NewTSDB()
	rapid.Check(t, func(t *rapid.T) {
		data := []int{0, 1, 2, 3, 4, 5}
		ts := rapid.Permutation(data).Draw(t, "ts")
		for _, t := range ts {
			db.Insert("a", time.Unix(int64(t), 0), TSValue(t))
		}
		_, valsMap := db.QueryRanges([]string{"a"}, time.Unix(0, 0), time.Unix(5, 0), time.Second)

		for i, v := range valsMap["a"] {
			if i != v {
				t.Fatalf("value[%d] didn't match: expected =%v, got %v", i, i, v)
			}
		}
	})
}

func TestQueryFinerThanData(t *testing.T) {
	db := NewTSDB()

	rapid.Check(t, func(t *rapid.T) {
		// Data is every 10s (0s, 10s, ..., 1000s)
		key := rapid.StringN(1, 10, 10).Draw(t, "key")
		for i := range 101 {
			db.Insert(key, time.Unix(int64(i)*10, 0), TSValue(i))
		}

		// Query at step=1s
		_, valsMap := db.QueryRanges([]string{key}, time.Unix(0, 0), time.Unix(1000, 0), time.Second)
		vals := valsMap[key]
		if len(vals) != 1001 {
			t.Fatalf("value array length didn't match: expected =%d, got %d", 1001, len(vals))
		}

		for i, v := range vals {
			var expected TSValue
			if i%10 < 2 {
				// mod==0 (exact match), mod==1 (within [t-step, t] window)
				expected = TSValue(i / 10)
			} else {
				// others samples are out of windows
				expected = nil
			}
			if v != expected {
				t.Fatalf("value[%d] didn't match: expected =%v, got %v", i, expected, v)
			}
		}
	})
}

func TestQueryCoarserThanData(t *testing.T) {
	db := NewTSDB()

	rapid.Check(t, func(t *rapid.T) {
		// Data is every 1s (0s, 1s, ..., 1000s)
		key := rapid.StringN(1, 10, 10).Draw(t, "key")
		for i := range 1001 {
			db.Insert(key, time.Unix(int64(i), 0), TSValue(i))
		}

		// Query at step=10s
		_, valsMap := db.QueryRanges([]string{key}, time.Unix(0, 0), time.Unix(1000, 0), time.Second*10)
		vals := valsMap[key]
		if len(vals) != 101 {
			t.Fatalf("value array length didn't match: expected =%d, got %d", 101, len(vals))
		}

		for i, v := range vals {
			expected := TSValue(i * 10)
			if v != expected {
				t.Fatalf("value[%d] didn't match: expected =%v, got %v", i, expected, v)
			}
		}
	})
}
