#!/usr/bin/env python3
"""
Test homing repeatability by probing
"""

import argparse
import datetime
import json
import sys
import time
import urllib.error
import urllib.request


def rpc(endpoint: str, path: str, body: dict) -> dict:
    req = urllib.request.Request(
        f"http://{endpoint}{path}",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.load(r)


def write_line(endpoint: str, line: str, high_prio: bool = False) -> None:
    resp = rpc(endpoint, "/write-line", {"line": line, "high_prio": high_prio})
    if not resp.get("ok"):
        raise RuntimeError(f"write-line rejected: {line!r} (device dead?)")


def get_ps(endpoint: str, tag: str, count: int = 1) -> list[dict]:
    resp = rpc(endpoint, "/get-ps", {"tag": tag, "count": count})
    return resp.get("pstates", [])


def get_status(endpoint: str) -> dict:
    return rpc(endpoint, "/status", {})


def cancel(endpoint: str) -> None:
    rpc(endpoint, "/cancel", {})


def wait_idle(endpoint: str) -> None:
    while True:
        st = get_status(endpoint)
        if not st.get("device_alive"):
            raise RuntimeError("device died while waiting for idle")
        if not st.get("busy"):
            return
        time.sleep(0.5)


def get_pos(endpoint: str) -> dict:
    write_line(endpoint, "?pos", high_prio=True)
    t_req = time.time()
    deadline = t_req + 5.0
    while time.time() < deadline:
        for ps in get_ps(endpoint, "pos", count=5):
            if ps["time"] >= t_req:
                return ps["kv"]
        time.sleep(0.1)
    raise RuntimeError("timed out waiting for fresh ?pos p-state")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--src", type=float, required=True)
    ap.add_argument("--dst", type=float, required=True)
    ap.add_argument("--count", type=int, default=10)
    ap.add_argument("--spooler", default="localhost:9000")
    args = ap.parse_args()

    # Y-axis (side movement): probe direction
    # Z-axis: retraction

    try:
        st = get_status(args.spooler)
    except (urllib.error.URLError, ConnectionError) as e:
        sys.exit(f"cannot reach spooler at {args.spooler}: {e}")
    if not st.get("device_alive"):
        sys.exit(f"spooler at {args.spooler} reports device_alive=false; aborting")

    ts = datetime.datetime.now().strftime("%Y-%m-%d_%H%M")
    fname = f"probe_{ts}_homing.jsonl"
    print(f"writing to {fname}", flush=True)

    base_z = 35
    retract_z = 50 # Z+ means away from work

    ix = 0
    try:
        with open(fname, "a", buffering=1) as fp:
            while ix < args.count:
                st = get_status(args.spooler)
                if not st.get("device_alive"):
                    sys.exit("device died; aborting")

                print("%d/%d: homing Y" % (ix + 1, args.count))
                write_line(args.spooler, "G53") # machine coords
                write_line(args.spooler, f"G28 Y")
                wait_idle(args.spooler)
                
                print("%d/%d: transitioning (->probe)" % (ix + 1, args.count))
                write_line(args.spooler, "G55") # work coords
                write_line(args.spooler, f"G0 Y{args.src} Z{retract_z}")
                write_line(args.spooler, f"G0 Z{base_z}")
                wait_idle(args.spooler)

                print("%d/%d: probe" % (ix + 1, args.count))
                write_line(args.spooler, f"G38.3 Y{args.dst}")
                wait_idle(args.spooler)
                hit = float(get_pos(args.spooler)["w.y"])
                print("%d/%d: hit at %.3f" % (ix + 1, args.count, hit))

                print("%d/%d: transitioning (->idle)" % (ix + 1, args.count))
                write_line(args.spooler, f"G0 Y{args.src}")
                write_line(args.spooler, f"G0 Z{retract_z}")
                wait_idle(args.spooler)

                rec = {"ix": ix, "hit": hit}
                fp.write(json.dumps(rec) + "\n")
                print(rec, flush=True)
                ix += 1
    except KeyboardInterrupt:
        print("\nCtrl-C: canceling…", flush=True)
        try:
            cancel(args.spooler)
        except Exception as e:
            print(f"cancel failed: {e}", file=sys.stderr)
        sys.exit(130)


if __name__ == "__main__":
    main()
