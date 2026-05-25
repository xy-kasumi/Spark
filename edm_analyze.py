#!/usr/bin/env python3
"""Visualize edm_tune.py JSONL trial logs.

4x4 pair plot of completed trials:
  - diagonal:        1D marginal (eff_duty vs each param)
  - lower triangle:  2D scatter of each param pair, colored by eff_duty
Spearman ρ(param, eff_duty) is printed to stdout as a rough per-param
importance score (handles monotone non-linearities; misses interactions).

Usage:
    edm_analyze.py [edm_tune.jsonl] [--cycles M..N]
"""

import argparse
import json
import sys

import matplotlib.pyplot as plt
import numpy as np


PARAM_LOG = {
    "adv_thresh":  False,
    "retr_thresh": False,
    "adv_speed":   True,
    "retr_speed":  True,
}
PARAMS = list(PARAM_LOG)


def load(path: str) -> list[dict]:
    with open(path) as f:
        return [json.loads(line) for line in f if line.strip()]


def spearman(x: np.ndarray, y: np.ndarray) -> float:
    xr = np.argsort(np.argsort(x))
    yr = np.argsort(np.argsort(y))
    return float(np.corrcoef(xr, yr)[0, 1])


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("log", nargs="?", default="edm_tune.jsonl")
    ap.add_argument("--cycles", help="filter to cycles M..N (inclusive)")
    args = ap.parse_args()

    rows = load(args.log)
    if args.cycles:
        lo, hi = (int(s) for s in args.cycles.split(".."))
        rows = [r for r in rows if lo <= r["cycle"] <= hi]
    if not rows:
        sys.exit("no rows after filtering")

    cmin = min(r["cycle"] for r in rows)
    cmax = max(r["cycle"] for r in rows)
    print(f"{len(rows)} trials across cycles {cmin}..{cmax}")

    P = {p: np.array([r["params"][p] for r in rows]) for p in PARAMS}
    y = np.array([r["value"] for r in rows])
    vmin, vmax = float(y.min()), float(y.max())

    n = len(PARAMS)
    fig, axes = plt.subplots(n, n, figsize=(11, 11), constrained_layout=True)
    sc = None
    for i, pi in enumerate(PARAMS):
        for j, pj in enumerate(PARAMS):
            ax = axes[i, j]
            if i < j:
                ax.axis("off")
                continue
            if i == j:
                ax.scatter(P[pj], y, c=y, cmap="viridis",
                           vmin=vmin, vmax=vmax, s=12)
                ax.set_ylabel("eff_duty" if j == 0 else f"{pi}\neff_duty")
            else:
                sc = ax.scatter(P[pj], P[pi], c=y, cmap="viridis",
                                vmin=vmin, vmax=vmax, s=12)
                if j == 0:
                    ax.set_ylabel(pi)
                if PARAM_LOG[pi]:
                    ax.set_yscale("log")
            if PARAM_LOG[pj]:
                ax.set_xscale("log")
            if i == n - 1:
                ax.set_xlabel(pj)

    if sc is not None:
        fig.colorbar(sc, ax=axes.ravel().tolist(), shrink=0.6, label="eff_duty")

    print("\nSpearman ρ(param, eff_duty):")
    for p, r in sorted(((p, spearman(P[p], y)) for p in PARAMS),
                       key=lambda kv: -abs(kv[1])):
        print(f"  {p:12s} {r:+.3f}")

    plt.show()


if __name__ == "__main__":
    main()
