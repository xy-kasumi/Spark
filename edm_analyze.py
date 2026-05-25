#!/usr/bin/env python3
"""Visualize edm_tune.py JSONL trial logs.

4x4 pair plot of completed trials:
  - diagonal:        1D marginal (eff_duty vs each param)
  - lower triangle:  2D scatter of each param pair, colored by eff_duty
Per-param η² (fraction of Var(eff_duty) explained by quantile-binning that
one param) is printed as a rough importance score. Catches unimodal/peaked
shapes that a rank correlation would miss; still 1D, so interactions
between params are invisible.

Usage:
    edm_analyze.py [edm_tune.jsonl] [--cycles M..N]
"""

import argparse
import json
import sys

import matplotlib.pyplot as plt
import numpy as np


PARAM_LOG = {
    "adv_thresh":       False,
    "retr_thresh":      False,
    "adv_speed":        True,
    "retr_speed_ratio": True,
}
PARAMS = list(PARAM_LOG)


def load(path: str) -> list[dict]:
    with open(path) as f:
        return [json.loads(line) for line in f if line.strip()]


def eta_squared(x: np.ndarray, y: np.ndarray, n_bins: int = 5) -> float:
    """Fraction of Var(y) explained by quantile-binning x into n_bins."""
    ss_total = float(((y - y.mean()) ** 2).sum())
    if ss_total == 0:
        return 0.0
    edges = np.quantile(x, np.linspace(0, 1, n_bins + 1))
    bin_idx = np.clip(np.digitize(x, edges[1:-1]), 0, n_bins - 1)
    ss_between = 0.0
    for b in range(n_bins):
        mask = bin_idx == b
        if mask.any():
            ss_between += mask.sum() * (y[mask].mean() - y.mean()) ** 2
    return float(ss_between / ss_total)


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

    print("\nη²(param, eff_duty)  [fraction of Var(eff_duty) explained, 1D]:")
    for p, r in sorted(((p, eta_squared(P[p], y)) for p in PARAMS),
                       key=lambda kv: -kv[1]):
        print(f"  {p:18s} {r:.3f}")

    plt.show()


if __name__ == "__main__":
    main()
