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
  time: {type: float64}
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
  "now": 1735689600.123
}
```

### POST /get-ps

Get latest p-states of specified tag.

**Request Schema**
```yaml
properties:
  tag: {type: string}
optionalProperties:
  count: {type: int}
```

* `tag`: P-state tag (e.g. "queue", "stat", "init")
* `count`: Max number of p-states to return (must be > 0). 1 if omitted.

**Response Schema**
```yaml
properties:
  pstates:
    elements:
      properties:
        time: {type: number}
        kv: {values: {}}
```

* `pstates`: in latest-first order.
* `time`: timestamp of the p-state reception
* `kv`: flattened representation of p-state (i.e. key can contain ".")

**Example**
Request
```json
{
  "tag": "pos",
  "count": 2
}
```

Response
```json
{
  "pstates": [
    {
      "time": 1735689600,
      "kv": {
        "m.x": 1
      }
    },
    {
      "time": 1735689500,
      "kv": {
        "m.x": 2
      }
    }
  ]
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
  time: {type: float64}
  busy: {type: bool}
  num_pending_commands: {type: int}
optionalProperties:
  running_job: {type: string}
```

* `time`: spooler timestamp of this status
* `busy`: some commands are pending to execute (or being executed). Signals do not count as busy.
* `num_pending_commands`: number of commands (either directly or via job)
  * includes commands in core queue
* `running_job`: job_id if a job is running

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

### POST /cancel

Cancel everything through the stack, including:
* currently running command in core
* command queue in core
* command queue in spooler
* waiting / running job in spooler

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
properties:
  jobs:
    elements:
      properties:
        job_id: {type: string}
        status:
          enum: [WAITING, RUNNING, COMPLETED, CANCELED]
        time_added: {type: float64}
      optionalProperties:
        time_started: {type: float64}
        time_ended: {type: float64}
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
  start: {type: float64}
  end: {type: float64}
  step: {type: float64}
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
/query-ts will never re-sample the data.

When step is smaller than sampling rate of original data, response will contain lots of nulls inbetween.

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
  "start": 1735689600,
  "end": 1735690600,
  "step": 10,
  "query": ["pos.x", "edm.open"]
}
```

Response
```json
{
  "times": [
    1735689600,
    1735689610,
    ...
    1735690600
  ],
  "values": {
    "pos.sys": ["machine", "machine", "work", ...],
    "edm.open": [0.1, 0.2, ...]
  }
}
```

### Appendix: Timestamps
All timestamps use Unix time in seconds.
They should have at least millisecond precision.

Note that leap seconds might end up elongating "1 second" for a day (smearing),
or time can reverse for that duration.

Implementation should not crash when encountering such timestamps,
but OK to lose data for that period.
