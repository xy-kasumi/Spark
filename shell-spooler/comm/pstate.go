// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later
package comm

import (
	"errors"
	"log/slog"
	"strings"
	"sync"
)

type PState map[string]interface{}

func (ps PState) GetString(key string) (string, bool) {
	v, ok := ps[key]
	if !ok {
		return "", false
	}
	s, ok := v.(string)
	return s, ok
}

func (ps PState) GetUInt(key string) (uint32, bool) {
	v, ok := ps[key]
	if !ok {
		return 0, false
	}
	i, ok := v.(uint32)
	return i, ok
}

func (ps PState) GetFloat(key string) (float32, bool) {
	v, ok := ps[key]
	if !ok {
		return 0.0, false
	}
	f, ok := v.(float32)
	return f, ok
}

func (ps PState) GetBool(key string) (bool, bool) {
	v, ok := ps[key]
	if !ok {
		return false, false
	}
	b, ok := v.(bool)
	return b, ok
}

// Token types for parsing pstate data
type Token interface {
	token() // marker method
}

type ID struct{ Value string }
type KV struct {
	Key   string
	Value interface{}
}
type Begin struct{}
type End struct{}

func (ID) token()    {}
func (KV) token()    {}
func (Begin) token() {}
func (End) token()   {}

type pstateParser struct {
	partial map[string]PState

	muComplete sync.Mutex
	complete   map[string]PState
}

func newPstateParser() *pstateParser {
	return &pstateParser{
		partial:  make(map[string]PState),
		complete: make(map[string]PState),
	}
}

// e.g. "pos < sys:"a b" a.b:2 >" -> ["pos", "<", `sys:"a b"`, "a.b:2", ">"]
// won't do much extra validation
func splitPsTokens(payload string) ([]string, error) {
	var toks []string
	var buf []rune
	inQuote := false
	inEscape := false
	for _, ch := range payload {
		if inEscape {
			if ch == '\\' {
				buf = append(buf, '\\')
			} else if ch == '"' {
				buf = append(buf, '"')
			} else {
				return nil, errors.New("invalid escape sequence" + string(ch))
			}
			inEscape = false
		} else if inQuote {
			if ch == '\\' {
				inEscape = true
			} else {
				if ch == '"' {
					inQuote = false
				}
				buf = append(buf, ch)
			}
		} else {
			if ch == ' ' {
				if len(buf) > 0 {
					toks = append(toks, string(buf))
					buf = nil
				}
			} else {
				if ch == '"' {
					inQuote = true
				}
				buf = append(buf, ch)
			}
		}
	}
	if len(buf) > 0 {
		toks = append(toks, string(buf))
	}
	if inQuote || inEscape {
		return nil, errors.New("unclosed quote or escape")
	}
	return toks, nil
}

func (parser *pstateParser) update(line string) {
	tokens, err := splitPsTokens(line)
	if err != nil {
		slog.Warn("Malformed pstate", "error", err)
		return
	}
	if len(tokens) < 1 {
		return
	}
	psType := tokens[0]
	for _, token := range tokens[1:] {
		switch token {
		case "<":
			parser.partial[psType] = nil
		case ">":
			m, ok := parser.partial[psType]
			if !ok {
				slog.Warn("Received '>' without matching '<'", "type", psType)
				continue
			}
			parser.muComplete.Lock()
			parser.complete[psType] = m
			parser.muComplete.Unlock()
		default:
			m, ok := parser.partial[psType]
			if !ok {
				slog.Warn("Received pstate key-value without matching '<'", "type", psType)
				continue
			}
			kv := strings.SplitN(token, ":", 2)
			if len(kv) != 2 {
				slog.Warn("Received malformed pstate", "payload", line)
				continue
			}
			m[kv[0]] = kv[1]
		}
	}
}
