#!/usr/bin/env python3
"""Tune ov.edm.* params against a running EDM job.

Loops `{explore for --explore-sec, exploit at best for --exploit-sec}`. Each
explore phase warm-starts TPE with the previous cycle's best params, so the
device spends most of its time at known-good settings and re-checks
periodically to track drift. On Ctrl-C, applies the last completed cycle's
best params to the device before exiting.

Caller is responsible for starting the EDM job and ensuring it polls `?edm`
so the `edm` p-state is populated.
"""

import argparse
import json
import sys
import time
import urllib.error
import urllib.request

import optuna


PARAM_RANGES = {
    "adv_thresh":       (0.05, 0.95, False),
    "retr_thresh":      (0.05, 0.95, False),
    "adv_speed":        (0.1, 10.0,  True),
    "retr_speed_ratio": (0.3, 3.0,  True),
}


ADV_SPEED_MAX  = 10.0
RETR_SPEED_MAX = 10.0


def to_hw(params: dict) -> dict:
    """Map search-space params to the 4 hardware ov.edm.* values."""
    adv_v  = min(params["adv_speed"], ADV_SPEED_MAX)
    retr_v = min(adv_v * params["retr_speed_ratio"], RETR_SPEED_MAX)
    return {
        "adv_thresh":  params["adv_thresh"],
        "retr_thresh": params["retr_thresh"],
        "adv_speed":   adv_v,
        "retr_speed":  retr_v,
    }


def rpc(endpoint: str, path: str, body: dict) -> dict:
    req = urllib.request.Request(
        f"http://{endpoint}{path}",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.load(r)


def fset(endpoint: str, key: str, value: float | str) -> None:
    """Set or clear an override. Pass "none" to clear, a float to set."""
    payload = value if isinstance(value, str) else f"{value:.6f}"
    resp = rpc(endpoint, "/write-line", {
        "line": f"fset {key} {payload}",
        "high_prio": True,
    })
    if not resp.get("ok"):
        raise RuntimeError(f"fset {key} rejected (device dead?)")


def get_eff_duty(endpoint: str, since: float) -> float | None:
    """Latest fresh eff_duty in the `edm` pstate, or None if none ≥ `since`."""
    resp = rpc(endpoint, "/get-ps", {"tag": "edm", "count": 5})
    for ps in resp.get("pstates", []):  # latest-first per docs/spooler.md:102
        if ps["time"] < since:
            return None
        if "eff_duty" in ps["kv"]:
            return float(ps["kv"]["eff_duty"])
    return None


def precheck(endpoint: str) -> None:
    try:
        st = rpc(endpoint, "/status", {})
    except (urllib.error.URLError, ConnectionError) as e:
        sys.exit(f"cannot reach spooler at {endpoint}: {e}")
    if not st.get("device_alive"):
        sys.exit(f"spooler at {endpoint} reports device_alive=false; aborting")


def _fmt_params(p: dict) -> str:
    return (f"adv={p['adv_thresh']:.2f} retr={p['retr_thresh']:.2f} "
            f"advV={p['adv_speed']:.2f} retrR={p['retr_speed_ratio']:.2f}")


def apply_params(endpoint: str, params: dict) -> float:
    """Push all 4 params via fset. Returns wall-clock time after the last fset."""
    for name, value in params.items():
        fset(endpoint, f"ov.edm.{name}", value)
    return time.time()


def reset_params(endpoint: str) -> float:
    """Clear all 4 ov.edm.* overrides to defaults. Returns post-write timestamp."""
    for name in PARAM_RANGES:
        fset(endpoint, f"ov.edm.{name}", "none")
    return time.time()


def make_objective(endpoint: str, wait_sec: float):
    def objective(trial: optuna.Trial) -> float:
        params = {
            name: trial.suggest_float(name, lo, hi, log=log)
            for name, (lo, hi, log) in PARAM_RANGES.items()
        }
        try:
            reset_params(endpoint)
            time.sleep(wait_sec)
            set_time = apply_params(endpoint, to_hw(params))
        except RuntimeError as e:
            raise optuna.TrialPruned(str(e))
        time.sleep(wait_sec)
        val = get_eff_duty(endpoint, since=set_time)
        if val is None:
            raise optuna.TrialPruned("no fresh eff_duty in pstate")
        return val
    return objective


def run_explore(endpoint, wait_sec, explore_sec, warm_params, cycle, state, log_path):
    """Run TPE for `explore_sec` seconds. Returns {params, value, trial} or None."""
    sampler = optuna.samplers.TPESampler(n_startup_trials=1, multivariate=True)
    study = optuna.create_study(direction="maximize", sampler=sampler)
    if warm_params is not None:
        study.enqueue_trial(warm_params)

    def dump(study_, trial):
        if trial.state == optuna.trial.TrialState.COMPLETE:
            val_str = f"eff_duty={trial.value:.3f}"
            if state["all_best"] is None or trial.value > state["all_best"]["value"]:
                state["all_best"] = {
                    "cycle": cycle, "trial": trial.number,
                    "params": dict(trial.params), "value": trial.value,
                }
            if log_path:
                with open(log_path, "a") as f:
                    f.write(json.dumps({
                        "time": time.time(),
                        "cycle": cycle, "trial": trial.number,
                        "params": dict(trial.params), "value": trial.value,
                    }) + "\n")
        else:
            val_str = "PRUNED        "
        completed = [t for t in study_.trials if t.state == optuna.trial.TrialState.COMPLETE]
        if completed:
            cb = max(completed, key=lambda t: t.value)
            cb_str = f"cycle-best={cb.value:.3f} (trial {cb.number})"
        else:
            cb_str = "cycle-best=  -"
        ab = state["all_best"]
        ab_str = (f"all-best={ab['value']:.3f} (cycle {ab['cycle']} trial {ab['trial']})"
                  if ab else "all-best=  -")
        print(f"[cycle {cycle} trial {trial.number}] {_fmt_params(trial.params)} -> "
              f"{val_str}  {cb_str}  {ab_str}", flush=True)

    objective = make_objective(endpoint, wait_sec)
    study.optimize(objective, timeout=explore_sec, callbacks=[dump])

    completed = [t for t in study.trials if t.state == optuna.trial.TrialState.COMPLETE]
    if not completed:
        return None
    best = max(completed, key=lambda t: t.value)
    return {"params": dict(best.params), "value": best.value, "trial": best.number}


def run_exploit(endpoint, exploit_sec, best_params, cycle):
    """Pin params to `best_params` and sample eff_duty once per second."""
    try:
        set_time = apply_params(endpoint, to_hw(best_params))
    except RuntimeError as e:
        print(f"[cycle {cycle} exploit] aborted: {e}", flush=True)
        return
    end = set_time + exploit_sec
    while time.time() < end:
        time.sleep(1.0)
        val = get_eff_duty(endpoint, since=set_time)
        val_str = f"eff_duty={val:.3f}" if val is not None else "eff_duty=?    "
        elapsed = time.time() - set_time
        print(f"[cycle {cycle} exploit {elapsed:4.1f}/{exploit_sec:.0f}s] {val_str}",
              flush=True)


def print_summary(cycle_bests, all_best, started):
    elapsed = time.time() - started
    print()
    print(f"--- stopped after {len(cycle_bests)} cycle(s) in {elapsed:.0f}s ---")
    if not cycle_bests:
        print("no completed cycles")
        return

    last = cycle_bests[-1]
    print(f"last-cycle best:  cycle {last['cycle']} trial {last['trial']}  "
          f"eff_duty={last['value']:.3f}  {_fmt_params(last['params'])}")
    print("  reproduce:")
    for name, value in to_hw(last["params"]).items():
        print(f"    fset ov.edm.{name} {value:.6f}")
    if all_best:
        print(f"all-time best:    cycle {all_best['cycle']} trial {all_best['trial']}  "
              f"eff_duty={all_best['value']:.3f}  {_fmt_params(all_best['params'])}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--endpoint", default="localhost:9000")
    ap.add_argument("--wait", type=float, default=2.0,
                    help="seconds to wait after reset-to-default, and again "
                         "after setting test params, before reading eff_duty")
    ap.add_argument("--explore-sec", type=float, default=20.0,
                    help="wall-clock budget per explore phase")
    ap.add_argument("--exploit-sec", type=float, default=40.0,
                    help="seconds running at frozen best between explore phases")
    ap.add_argument("--log", default="edm_tune.jsonl",
                    help="append completed trials as JSONL (empty string disables)")
    args = ap.parse_args()

    precheck(args.endpoint)
    optuna.logging.set_verbosity(optuna.logging.WARNING)

    state = {"all_best": None}
    cycle_bests = []
    prev_best_params = None
    started = time.time()
    cycle = 0
    try:
        while True:
            cycle += 1
            phase = run_explore(args.endpoint, args.wait, args.explore_sec,
                                prev_best_params, cycle, state, args.log or None)
            if phase is None:
                print(f"[cycle {cycle}] explore produced no completed trials; "
                      f"skipping exploit", flush=True)
                continue
            phase["cycle"] = cycle
            cycle_bests.append(phase)
            prev_best_params = phase["params"]
            run_exploit(args.endpoint, args.exploit_sec, phase["params"], cycle)
    except KeyboardInterrupt:
        pass
    print_summary(cycle_bests, state["all_best"], started)
    if cycle_bests:
        last = cycle_bests[-1]
        print(f"applying last-cycle best (cycle {last['cycle']}) to device...",
              flush=True)
        try:
            apply_params(args.endpoint, to_hw(last["params"]))
            print("applied.", flush=True)
        except (RuntimeError, urllib.error.URLError, ConnectionError) as e:
            print(f"apply failed: {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
