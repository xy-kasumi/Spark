#!/usr/bin/env python3
"""Analyze past jobs from spooler logs.

Scans shell-spooler/logs/*.txt (excluding archive/) for jobs, where a job
starts at a `down G53` line and ends at the next `up queue ... num:0 >`
that follows actual queue activity. Short jobs (under threshold) are
listed as likely failed/canceled and skipped for graphing.

For each job above the threshold, draws an eff_duty graph (avg/min/max
within 30-second bins) saved as PNG next to this script.

Usage:
    spool_analyze.py [--logs DIR] [--out DIR] [--threshold-min N] [--bin-sec N]
"""

import argparse
import os
import re
import sys
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np


LINE_RE = re.compile(r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+\+\d{2}:\d{2}) (up|down) (.*)$")
QUEUE_NUM_RE = re.compile(r"num:(\d+)")
EFF_DUTY_RE = re.compile(r"eff_duty:([\d.eE+-]+)")


def parse_ts(s: str) -> datetime:
    # Python 3.10 fromisoformat doesn't handle "+09:00" in some forms; normalize.
    # The string is e.g. "2026-05-25 17:04:57.660+09:00".
    return datetime.fromisoformat(s.replace(" ", "T"))


@dataclass
class Event:
    ts: datetime
    kind: str  # "g53", "queue", "edm"
    value: float = 0.0  # queue num or eff_duty


@dataclass
class Job:
    log_file: str
    start: datetime
    end: datetime
    edm: list[tuple[float, float]] = field(default_factory=list)  # (t_minutes, eff_duty)

    @property
    def duration(self) -> timedelta:
        return self.end - self.start


def parse_log(path: Path) -> list[Event]:
    events: list[Event] = []
    with path.open() as f:
        for line in f:
            m = LINE_RE.match(line.rstrip("\n"))
            if not m:
                continue
            ts_s, direction, rest = m.group(1), m.group(2), m.group(3)
            if direction == "down" and rest.startswith("G53"):
                events.append(Event(parse_ts(ts_s), "g53"))
            elif direction == "up" and rest.startswith("queue"):
                qm = QUEUE_NUM_RE.search(rest)
                if qm:
                    events.append(Event(parse_ts(ts_s), "queue", float(qm.group(1))))
            elif direction == "up" and rest.startswith("edm "):
                em = EFF_DUTY_RE.search(rest)
                if em:
                    try:
                        events.append(Event(parse_ts(ts_s), "edm", float(em.group(1))))
                    except ValueError:
                        pass
    return events


def detect_jobs(events: list[Event], log_file: str) -> list[Job]:
    """A job starts at a G53 (when not already in one). It ends at the first
    queue=0 that arrives after we've seen queue>0 during the job. G53s while
    in a job extend the job (no new job started)."""
    jobs: list[Job] = []
    in_job = False
    start_ts: datetime | None = None
    saw_queue_active = False
    edm_buf: list[tuple[datetime, float]] = []

    for ev in events:
        if not in_job:
            if ev.kind == "g53":
                in_job = True
                start_ts = ev.ts
                saw_queue_active = False
                edm_buf = []
            continue
        # in_job
        if ev.kind == "g53":
            pass  # stay in job
        elif ev.kind == "queue":
            if ev.value > 0:
                saw_queue_active = True
            elif saw_queue_active:
                # End job here.
                assert start_ts is not None
                job = Job(log_file=log_file, start=start_ts, end=ev.ts)
                for ts, eff in edm_buf:
                    job.edm.append(((ts - start_ts).total_seconds() / 60.0, eff))
                jobs.append(job)
                in_job = False
                start_ts = None
                edm_buf = []
        elif ev.kind == "edm":
            edm_buf.append((ev.ts, ev.value))

    if in_job and start_ts is not None and edm_buf:
        # Trailing job that never sees queue=0 (e.g., truncated log).
        job = Job(log_file=log_file, start=start_ts, end=edm_buf[-1][0])
        for ts, eff in edm_buf:
            job.edm.append(((ts - start_ts).total_seconds() / 60.0, eff))
        jobs.append(job)
    return jobs


def plot_eff_duty(job: Job, out_path: Path, bin_sec: float) -> None:
    if not job.edm:
        return
    t = np.array([p[0] for p in job.edm])  # minutes
    y = np.array([p[1] for p in job.edm])

    bin_min = bin_sec / 60.0
    total_min = job.duration.total_seconds() / 60.0
    n_bins = max(1, int(np.ceil(total_min / bin_min)))
    edges = np.arange(n_bins + 1) * bin_min
    idx = np.clip(np.digitize(t, edges[1:-1]), 0, n_bins - 1)

    centers, avg, lo, hi = [], [], [], []
    for b in range(n_bins):
        mask = idx == b
        if not mask.any():
            continue
        centers.append((edges[b] + edges[b + 1]) / 2.0)
        vals = y[mask]
        avg.append(vals.mean())
        lo.append(vals.min())
        hi.append(vals.max())
    centers = np.array(centers)
    avg = np.array(avg)
    lo = np.array(lo)
    hi = np.array(hi)

    fig, ax = plt.subplots(figsize=(10, 4))
    ax.fill_between(centers, lo, hi, alpha=0.25, label=f"min..max ({int(bin_sec)}s bins)")
    ax.plot(centers, avg, color="C0", linewidth=1.5, label="avg")
    ax.set_xlabel("time (min)")
    ax.set_ylabel("eff_duty")
    ax.set_xlim(0, total_min)
    ax.set_ylim(bottom=0)
    ax.set_title(
        f"{Path(job.log_file).stem}  start={job.start.strftime('%Y-%m-%d %H:%M:%S')}  "
        f"duration={format_dur(job.duration)}"
    )
    ax.legend(loc="upper right")
    ax.grid(True, alpha=0.3)
    fig.tight_layout()
    fig.savefig(out_path, dpi=120)
    plt.close(fig)


def format_dur(d: timedelta) -> str:
    s = int(d.total_seconds())
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    if h:
        return f"{h}h{m:02d}m{sec:02d}s"
    return f"{m}m{sec:02d}s"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--logs", default="shell-spooler/logs",
                    help="log directory (archive/ subdir is skipped)")
    ap.add_argument("--out", default=".",
                    help="output directory for PNGs")
    ap.add_argument("--threshold-min", type=float, default=5.0,
                    help="jobs shorter than this are listed but not graphed")
    ap.add_argument("--bin-sec", type=float, default=10.0,
                    help="bin width in seconds for eff_duty aggregation")
    args = ap.parse_args()

    logs_dir = Path(args.logs)
    if not logs_dir.is_dir():
        print(f"log dir not found: {logs_dir}", file=sys.stderr)
        return 1
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    log_files = sorted(p for p in logs_dir.iterdir() if p.is_file() and p.suffix == ".txt")

    all_jobs: list[Job] = []
    for path in log_files:
        events = parse_log(path)
        jobs = detect_jobs(events, str(path))
        all_jobs.extend(jobs)

    threshold = timedelta(minutes=args.threshold_min)
    long_jobs = [j for j in all_jobs if j.duration >= threshold]
    short_jobs = [j for j in all_jobs if j.duration < threshold]

    print(f"Found {len(all_jobs)} jobs across {len(log_files)} log files "
          f"({len(long_jobs)} >= {args.threshold_min:g}min, "
          f"{len(short_jobs)} likely failed/canceled)\n")

    print("Long jobs (graphed):")
    for i, j in enumerate(long_jobs, 1):
        print(f"  [{i}] {Path(j.log_file).name}  "
              f"{j.start.strftime('%Y-%m-%d %H:%M:%S')}  "
              f"dur={format_dur(j.duration)}  edm_samples={len(j.edm)}")

    print("\nShort jobs (skipped):")
    for j in short_jobs:
        print(f"  -   {Path(j.log_file).name}  "
              f"{j.start.strftime('%Y-%m-%d %H:%M:%S')}  "
              f"dur={format_dur(j.duration)}")

    print()
    for i, j in enumerate(long_jobs, 1):
        stem = Path(j.log_file).stem
        png = out_dir / f"job_{i:02d}_{stem}_{j.start.strftime('%H%M%S')}.png"
        if not j.edm:
            print(f"job [{i}]: no eff_duty samples (older telemetry format?) - skipping plot")
            continue
        plot_eff_duty(j, png, args.bin_sec)
        print(f"wrote {png}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
