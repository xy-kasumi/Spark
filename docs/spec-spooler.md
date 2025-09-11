# Spooler Spec

Spooler is line-based I/O buffer between UIs (e.g. shell-dashboard) and the core.

Spooler doesn't know about core protocols or G-code. It just assumes it's line-based bi-directional stream.
Implementation of UIs can be stateless by relying on query capability of the spooler.

Spooler also serves as reliable comm log for debug purpose.

## Core concepts
* direction: dataflow direction. Either `up` or `down`. `up` means towards the user (core -> spooler -> UI). `down` means away from the user. (UI -> spooler -> core).
  * This removes confusion of "RX" vs "TX"
* line number: Stats from 1 and incremented. Both `up` and `down` lines belong to same line number space. Line number is reset to 1 iff spooler is restarted.
* init lines: lines that are sent (same as /write-line) to the core, when spooler is started.
  * Can be suppressed by a command line argument.

## HTTP API

### POST /write-line

Write a line to the serial device.

**Request Type**

```typescript
{
  line: string  // Line content (no newlines allowed)
}
```

**Response Type**

```typescript
{
  line_num: number  // Assigned line number
  time: string      // Local timestamp "YYYY-MM-DD HH:MM:SS.mmm", just after line is sent to the device.
}
```

**Examples**

Request:
```json
{
  "line": "G1 X10 Y20"
}
```

Response:
```json
{
  "line_num": 123,
  "time": "2025-07-27 15:04:05.000"
}
```

### POST /query-lines

Query logged lines.

**Request Type**

```typescript
{
  from_line?: number  // Start line (inclusive, 1-based)
  to_line?: number    // End line (exclusive, 1-based)
  tail?: number       // Get last N lines
  filter_dir?: "up" | "down", // Direction filter (any if omitted)
  filter_regex?: string     // Regex filter (RE2 syntax)
}
```

The query semantics: apply "filter" to each line within "scan range" and return order-preserved results.

Scan Range

* If none is specified, the query scans all lines.
* If `from` and/or `to` is specified, the query scans the range. Cannot specify `tail` in this mode.
  * missing `from`: from the beginning
  * missing `to`: to the end
* If `tail` is specified, the query scans last N lines. Cannot specify `from` nor `to` in this mode.

Filter

* Multiple filters are combined as AND
* omitted fields means matches any
* `filter_regex`: follows [RE2 syntax](https://github.com/google/re2/wiki/Syntax)


**Response Type**

```typescript
{
  count: number       // Total matching lines
  lines: Array<{
    line_num: number  // Line number
    dir: "up" | "down"  // Direction
    content: string   // Line content
    time: string      // Local timestamp "YYYY-MM-DD HH:MM:SS.mmm"
  }>
  now: string         // Current spooler time
}
```

Returns matches lines. Count contains exact count, but lines is truncated by first 1000 matching lines.


**Examples**

Request:
```json
{
  "tail": 50
}
```

Response:
```json
{
  "count": 2,
  "lines": [
    {
      "line_num": 122,
      "dir": "down",
      "content": "G1 X10 Y20",
      "time": "2025-07-27 15:04:04.500"
    },
    {
      "line_num": 123,
      "dir": "up",
      "content": ">ack",
      "time": "2025-07-27 15:04:04.600"
    }
  ],
  "now": "2025-07-27 15:04:05.000"
}
```

Request with filter:
```json
{
  "tail": 100,
  "filter_dir": "up",
  "filter_regex": "^>"
}
```

Response
```json
{
  "count": 1,
  "lines": [
    {
      "line_num": 123,
      "dir": "up",
      "content": ">ack",
      "time": "2025-07-27 15:04:04.600"
    }
  ],
  "now": "2025-07-27 15:04:05.000"
}
```

### POST /set-init

Set content of init lines. The content will be persisted as a file across spooler reboot.

**Request Type**

```typescript
{
  lines: Array<string>
}
```

**Response Type**

```typescript
{}
```

**Examples**

Request:
```json
{
  "content": ["set cs.g.pos.x 1", "set cs.g.pos.x 2"]
}
```

### POST /get-init

Get current init lines. Empty if not configured or not found.

**Request Type**

```typescript
{}
```

**Response Type**

```typescript
{
  lines: Array<string>
}
```

**Examples**

Request:
```json
{
  "content": ["set cs.g.pos.x 1", "set cs.g.pos.x 2"]
}
```
