// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later
package comm

import (
	"errors"
	"fmt"
	"strings"
)

type PState struct {
	Tag string
	m   map[string]interface{}
}

func NewPState(tag string) PState {
	return PState{
		Tag: tag,
		m:   make(map[string]interface{}),
	}
}

func (ps PState) GetString(key string) (string, bool) {
	v, ok := ps.m[key]
	if !ok {
		return "", false
	}
	s, ok := v.(string)
	return s, ok
}

func (ps PState) GetUInt(key string) (uint32, bool) {
	v, ok := ps.m[key]
	if !ok {
		return 0, false
	}
	i, ok := v.(uint32)
	return i, ok
}

func (ps PState) GetFloat(key string) (float32, bool) {
	v, ok := ps.m[key]
	if !ok {
		return 0.0, false
	}
	f, ok := v.(float32)
	return f, ok
}

func (ps PState) GetBool(key string) (bool, bool) {
	v, ok := ps.m[key]
	if !ok {
		return false, false
	}
	b, ok := v.(bool)
	return b, ok
}

type PStateParser map[string]*PState

func NewPStateParser() PStateParser {
	return make(map[string]*PState)
}

type tokenType string

const (
	tokBegin tokenType = "<"
	tokEnd   tokenType = ">"
	tokSep   tokenType = ":"
	tokStr   tokenType = "str"   // string literal
	tokOther tokenType = "other" // keys, tags, numbers, bools
)

type token struct {
	typ tokenType
	val string // for tokStr: unescaped value, for tokOther: raw value string, for tokBegin/tokEnd/tokSep: empty
}

// e.g. `pos < sys:"a \"b" a.b:2 >“ -> [Other "pos", Begin, Other "sys", Sep, Str `a "b`, Other "a.b", Sep, Other "2", End]
func tokenize(payload string) ([]token, error) {
	type stateType int
	const (
		normal stateType = iota
		inQuote
		inQuoteEscape
	)

	var toks []token
	var buf []rune
	state := normal
	for _, ch := range payload {
		switch state {
		case inQuoteEscape:
			switch ch {
			case '\\':
				buf = append(buf, '\\')
			case '"':
				buf = append(buf, '"')
			default:
				return nil, errors.New("invalid escape sequence" + string(ch))
			}
			state = inQuote
		case inQuote:
			switch ch {
			case '\\':
				state = inQuoteEscape
			case '"':
				toks = append(toks, token{typ: tokStr, val: string(buf)})
				buf = nil
				state = normal
			default:
				buf = append(buf, ch)
			}
		case normal:
			switch ch {
			case '"':
				state = inQuote
			case '<':
				if len(buf) > 0 {
					return nil, errors.New("unexpected '<'")
				}
				toks = append(toks, token{typ: tokBegin})
			case '>':
				if len(buf) > 0 {
					return nil, errors.New("unexpected '>'")
				}
				toks = append(toks, token{typ: tokEnd})
			case ':':
				if len(buf) == 0 {
					return nil, errors.New("unexpected ':'")
				}
				toks = append(toks, token{typ: tokOther, val: string(buf)})
				buf = nil
				toks = append(toks, token{typ: tokSep})
			case ' ':
				if len(buf) > 0 {
					toks = append(toks, token{typ: tokOther, val: string(buf)})
					buf = nil
				}
			default:
				buf = append(buf, ch)
			}
		}
	}
	if state != normal {
		return nil, errors.New("unclosed string")
	}
	if len(buf) > 0 {
		toks = append(toks, token{typ: tokOther, val: string(buf)})
	}
	return toks, nil
}

// Feed new payload and return completed pstate if any.
// Note that (nil, nil) can be returned if payload has no error but didn't complete any p-state.
func (parser PStateParser) Update(payload string) (*PState, error) {
	toks, err := tokenize(payload)
	if err != nil {
		return nil, err
	}
	if len(toks) < 1 || toks[0].typ != tokOther {
		return nil, errors.New("missing p-state tag")
	}
	type stateType int
	const (
		normal stateType = iota
		expSep
		expVal
	)

	tag := toks[0].val
	ps := parser[tag]

	state := normal
	var key string
	for _, tok := range toks[1:] {
		switch state {
		case normal:
			switch tok.typ {
			case tokBegin:
				psInst := NewPState(tag)
				ps = &psInst
				parser[tag] = ps
			case tokEnd:
				if ps == nil {
					return nil, errors.New("unexpected '>' without matching '<'")
				}
				delete(parser, tag)
				return ps, nil
			case tokOther:
				key = tok.val
				state = expSep
			default:
				return nil, fmt.Errorf("unexpected token(typ=%s,val=%s)", tok.typ, tok.val)
			}
		case expSep:
			switch tok.typ {
			case tokSep:
				state = expVal
			default:
				return nil, fmt.Errorf("expected ':', got (typ=%s,val=%s)", tok.typ, tok.val)
			}
		case expVal:
			if ps == nil {
				return nil, errors.New("unexpected value without matching '<'")
			}
			switch tok.typ {
			case tokStr:
				ps.m[key] = tok.val
			case tokOther:
				if tok.val == "true" {
					ps.m[key] = true
				} else if tok.val == "false" {
					ps.m[key] = false
				} else if strings.HasPrefix(tok.val, "0x") {
					var u uint32
					_, err := fmt.Sscanf(tok.val, "0x%x", &u)
					if err != nil {
						return nil, errors.New("invalid hex: " + tok.val)
					}
					ps.m[key] = u
				} else {
					var f float32
					n, err := fmt.Sscanf(tok.val, "%f", &f)
					if err != nil || n != 1 {
						return nil, errors.New("invalid float: " + tok.val)
					}
					ps.m[key] = f
				}
			default:
				return nil, errors.New("expected value, got " + tok.val)
			}
			state = normal
		}
	}
	return nil, nil
}
