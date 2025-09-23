# Spooler Spec

Spooler is  I/O buffer between UIs (e.g. shell-dashboard) and the core.

Spooler communicates with the core via serial port, and provides HTTP API.
UI implementations can be stateless by querying spooler as needed.

Within the [protocol](https://github.com/xy-kasumi/Spark-corefw/blob/main/spec/protocol.md), spooler knows
* Transport layer
* P-states
* Signals (e.g. difference between "!", "?queue")

Spooler does not know
* G-code, Commands (e.g. what "G1" or "set" means)

Spooler also serves as reliable comm log for debug purpose.

## Core concepts
* direction: dataflow direction. Either `up` or `down`. `up` means towards the user (core -> spooler -> UI). `down` means away from the user. (UI -> spooler -> core).
  * This removes confusion of "RX" vs "TX"
* line number: starts from 1 and incremented. Both `up` and `down` lines belong to same line number space. Line number is reset to 1 iff spooler is restarted.
* init file: text file that is persisted across reboot, useful for initializing the core.

## HTTP API

Spooler uses HTTP as RPC.
All API is POST, both request & response are `application/json`.

It sticks to just 3 types of status codes.
* 200 OK: Request is processed succesfully, response is JSON.
* 400 Bad Request: Returned for non-comforming (syntax or semantics) request. Response is human-readable error text.
* 500 Internal Server Error: Request seemed ok, but somehow processing failed. Response is human-readable error text.

### POST /write-line

Enqueue sending of a payload.
It won't be sent if /clear-queue is called after /write-line and before actual sending.
Signals will be immediately sent even if a job is running.
If any job is `WAITING` or `RUNNING`, /write-line of commands will fail.

**Request Schema**

```yaml
properties:
  line: {type: string}
```
* `line`: a valid payload. (between 1~100 bytes, does not contain newline, etc.)

**Response Schema**

```yaml
properties:
  ok: {type: bool}
  time: {type: string}
```
* `ok`: commands was enqueued
* `time`: time of spooler enqueue (timestamp)

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
  "ok": true,
  "now": "2025-07-27 15:04:05.000Z"
}
```

### POST /query-lines

Query raw payloads.

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
    time: string      // Timestamp
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

### POST /status

Get spooler status summary.

**Request Type**

```json
{}
```

**Response Schema**

```yaml
properties:
  busy: {type: bool}
  command_queue:
    properties:
      spooler: {type: int}
      core: {type: int}
      job: {type: int}
```

* `busy`: some commands are pending to execute (or being executed). Signals do not count as busy.
* `command_queue`: current queue size of various place
  * `spooler`: commands by `/write-line` queued in spooler
  * `core`: command queued in core
  * `job`: remaining commands in `WAITING` or `RUNNING`

**Examples**

Request:
```json
{}
```

Response:
```json
{
  "busy": true,
  "command_queue": {
    "spooler": 13,
    "core": 24
  }
}
```

### POST /clear-queue

Clear spooler down queue.

**Request Type**

```typescript
{}
```

**Response Type**

```typescript
{}
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

### POST /add-job

Add a "job", which is a collection of commands and periodic signals.
Add only succeeds if all existing jobs are ended (`CANCELED` or `COMPLETED`).

Job only starts executing when command queue of both spooler and core become is fully empty.
Job completes when all `commands` are sent and core queue become fully empty.

**Request Schema**
```yaml
properties:
  commands:
    elements: {type: string}
  signals:
    values: {type: float32}
```

* `commands`: list of commands to be executed
* `signals`: list of signals to be periodically executed

**Response Schema**
```yaml
properties:
  ok: {type: bool}
optionalProperties:
  job_id: {type: string}
```

* `job_id`: Unique id describing the job in the spooler session. Undef if !ok.

**Examples**
Request
```json
{
  "commands": [
    "set m.x 3",
    "G0 X10 Y10",
    ...
  ],
  "signals": {
    "?pos": 1,
    "?edm": 0.5
  }
}
```

Response
```json
{
  "ok": true,
  "job_id": "A3zF"
}
```

### POST /list-jobs

List all added jobs.

**Request**
```json
{}
```

**Response Schema**
```yaml
elements:
  properties:
    job_id: {type: string}
    status:
      enum: [WAITING, RUNNING, COMPLETED, CANCELED]
    time_added: {type: string}
  optionalProperties:
    time_started: {type: string}
    time_ended: {type: string}
```

* `status`: Current status of the job
  * `WAITING`: added but not started (time_started, time_ended are undef)
  * `RUNNING`: job is currently being executed (time_started exists, time_ended is undef)
  * `COMPLETED`: entirety of job was executed (time_started, time_ended exists)
  * `CANCELED`: job was cancled without becoming completed (time_started, time_ended exists)
* `time_added`, `time_started`, `time_ended`: timestamps


### POST /query-ts

Query time-series data from p-state.

**Request Schema**
```yaml
properties:
  start: {type: string}
  end: {type: string}
  step: {type: float32}
  query:
    elements: {type: string}
```

* `start`, `end`: timestamps to specify time range, inclusive. End >= start.
* `step`: resolution in seconds (> 0)
* `query`: p-state tags and keys to query in `<tag>.<keys>` format

`start`, `end`, `step` determines query timestamps like
* start + step * 0, start + step * 1, ...
  * this continues until end. The last element can be smaller than, or same as end.
  * in valid request, this will always contain at least one element (start)

For each timestamp T, latest original data point in window [T-step, T] is returned.
Query will never re-sample the data.

**Response Schema**
```yaml
properties:
  times:
    elements: {type: float64}
  values:
    values: {}
```

* `times`: sequence of Unix timestamps, as calculated by `start`, `end`, `step`.
* `values`: sequence of data. null if data is missing.

All the arrays (`times`, and each element of `values`) has same length.

**Examples**
Request
```json
{
  "start": "2025-01-01 15:00:00.000Z",
  "end": "2025-01-01 15:10:00.000Z",
  "step": 60,
  "query": ["pos.x", "edm.open"]
}
```

Response
```json
{
  "times": [
    1735711200,
    1735711260,
    ...
    1735711800
  ],
  "values": {
    "pos.sys": ["machine", "machine", "work", ...],
    "edm.open": [0.1, 0.2, ...]
  }
}
```

### Appendix: Timestamps
All timestamps use [RFC3339](https://datatracker.ietf.org/doc/html/rfc3339) timestamp.

For readability and precision, implementations should:
* Use local time offset instead of UTC ("Z")
* Use millisecond precision
* Allow " " for "T" separator

Example: "2025-01-02 23:03:48.123+09:00"
