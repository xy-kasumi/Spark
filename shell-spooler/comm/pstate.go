// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later
package comm

import (
	"errors"
	"log/slog"
	"strings"
	"sync"
)

type PState struct {
}

type pstateParser struct {
	partial map[string]map[string]string

	muComplete sync.Mutex
	complete   map[string]map[string]string
}

func newPstateParser() *pstateParser {
	return &pstateParser{
		partial:  make(map[string]map[string]string),
		complete: make(map[string]map[string]string),
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

func (ps *pstateParser) update(line string) {
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
			ps.partial[psType] = map[string]string{}
		case ">":
			m, ok := ps.partial[psType]
			if !ok {
				slog.Warn("Received '>' without matching '<'", "type", psType)
				continue
			}
			ps.muComplete.Lock()
			ps.complete[psType] = m
			ps.muComplete.Unlock()
		default:
			// K:V
			m, ok := ps.partial[psType]
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

