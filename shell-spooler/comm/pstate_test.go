// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later
package comm

import (
	"testing"
)

func assertExistsAndEqual[T comparable](t *testing.T, val T, ok bool, expected T, key string) {
	if !ok {
		t.Errorf("Expected key(%s) not found", key)
		return
	}
	if val != expected {
		t.Errorf("For key(%s), expected %v, got %v", key, expected, val)
	}
}

func TestTokenize(t *testing.T) {
	toks, err := tokenize(`test < ab:cd >`)
	if err != nil {
		t.Errorf("%v", err)
		return
	}
	expected := []token{
		{typ: tokOther, val: "test"},
		{typ: tokBegin},
		{typ: tokOther, val: "ab"},
		{typ: tokSep},
		{typ: tokOther, val: "cd"},
		{typ: tokEnd},
	}
	if len(toks) != len(expected) {
		t.Errorf("Expected %d tokens, got %d (%v)", len(expected), len(toks), toks)
		return
	}
	for i := range toks {
		if toks[i] != expected[i] {
			t.Errorf("At token %d, expected %+v, got %+v", i, expected[i], toks[i])
		}
	}
}

func TestTokenizeComplexString(t *testing.T) {
	toks, err := tokenize(`test a.b.c:" 1\"2\\3" x:y`)
	if err != nil {
		t.Errorf("%v", err)
		return
	}
	expected := []token{
		{typ: tokOther, val: "test"},
		{typ: tokOther, val: "a.b.c"},
		{typ: tokSep},
		{typ: tokStr, val: ` 1"2\3`},
		{typ: tokOther, val: "x"},
		{typ: tokSep},
		{typ: tokOther, val: "y"},
	}
	if len(toks) != len(expected) {
		t.Errorf("Expected %d tokens, got %d (%v)", len(expected), len(toks), toks)
		return
	}
	for i := range toks {
		if toks[i] != expected[i] {
			t.Errorf("At token %d, expected %+v, got %+v", i, expected[i], toks[i])
		}
	}
}

func TestParseEmpty(t *testing.T) {
	parser := NewPStateParser()
	ps, _ := parser.Update(`test < >`)
	if ps == nil {
		t.Errorf("Expected non-nil p-state, got nil")
		return
	}
	if ps.Tag != "test" {
		t.Errorf("Expected tag 'test', got %q", ps.Tag)
	}
}

func TestParseSingle(t *testing.T) {
	parser := NewPStateParser()
	ps, err := parser.Update(`test < num1:1 num2:2.3 hex:0x1234abcd bool:true str:"hello \"world\"\\!" >`)
	if err != nil {
		t.Errorf("%v", err)
		return
	}
	if ps == nil {
		t.Errorf("Expected non-nil p-state, got nil")
		return
	}
	if ps.Tag != "test" {
		t.Errorf("Expected tag 'test', got %q", ps.Tag)
	}

	// Values that exists.
	num1Val, num1Ok := ps.GetFloat("num1")
	assertExistsAndEqual(t, num1Val, num1Ok, float32(1.0), "num1")

	num2Val, num2Ok := ps.GetFloat("num2")
	assertExistsAndEqual(t, num2Val, num2Ok, float32(2.3), "num2")

	hexVal, hexOk := ps.GetUInt("hex")
	assertExistsAndEqual(t, hexVal, hexOk, uint32(0x1234abcd), "hex")

	boolVal, boolOk := ps.GetBool("bool")
	assertExistsAndEqual(t, boolVal, boolOk, true, "bool")

	strVal, strOk := ps.GetString("str")
	assertExistsAndEqual(t, strVal, strOk, `hello "world"\!`, "str")

	// Value that does not exist.
	_, ok := ps.GetFloat("nonexist")
	if ok {
		t.Errorf("GetFloat falsely returned non-existent value")
	}
	_, ok = ps.GetUInt("nonexist")
	if ok {
		t.Errorf("GetUInt falsely returned non-existent value")
	}
	_, ok = ps.GetBool("nonexist")
	if ok {
		t.Errorf("GetBool falsely returned non-existent value")
	}
	_, ok = ps.GetString("nonexist")
	if ok {
		t.Errorf("GetString falsely returned non-existent value")
	}

	// Assert that no automatic type casting.
	_, ok = ps.GetFloat("hex")
	if ok {
		t.Errorf("GetFloat wrongly returned casted uint32 value")
	}
	_, ok = ps.GetUInt("num1")
	if ok {
		t.Errorf("GetUInt wrongly returned casted float32 value")
	}
	_, ok = ps.GetString("bool")
	if ok {
		t.Errorf("GetString wrongly returned casted bool value")
	}
}
