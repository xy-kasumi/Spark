#!/usr/bin/env python3
"""Plot 2-end probe center & width from a JSONL file produced by test_probe.py."""

import argparse
import json
import os

import matplotlib.pyplot as plt
from scipy import stats


def fit_and_plot(ax, ixs, ys, ylabel):
    n = len(ys)
    fit = stats.linregress(ixs, ys)
    b, a = fit.slope, fit.intercept
    se = fit.stderr
    t_crit = stats.t.ppf(0.975, n - 2)

    fitted = [a + b * x for x in ixs]
    fit_label = f"fit: {b*1000:.3f} µm/probe (95% CI ±{t_crit*se*1000:.3f})"

    ax.plot(ixs, ys, marker="o", linestyle="-", markersize=4, label=ylabel)
    ax.plot(ixs, fitted, color="C1", linestyle="--", linewidth=1.5, label=fit_label)
    ax.set_ylabel(f"{ylabel} [mm]")
    ax.legend(loc="best", fontsize=8)
    ax.grid(True, alpha=0.3)

    print(f"{ylabel}: slope = {b*1000:.4f} um/probe   "
          f"(95% CI: [{(b-t_crit*se)*1000:.4f}, {(b+t_crit*se)*1000:.4f}])   "
          f"intercept = {a:.6f}   R^2={fit.rvalue**2:.3f}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("path")
    ap.add_argument("--out", default=None, help="output PNG path (default: <input>.png)")
    args = ap.parse_args()

    ixs, centers, widths = [], [], []
    with open(args.path) as fp:
        for line in fp:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            hit1, hit2 = rec["hit1"], rec["hit2"]
            ixs.append(rec["ix"])
            centers.append((hit1 + hit2) / 2)
            widths.append(abs(hit2 - hit1))

    print(f"n={len(ixs)}")

    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(8, 7), sharex=True)
    fit_and_plot(ax1, ixs, centers, "center")
    fit_and_plot(ax2, ixs, widths, "width")
    ax1.set_title(f"{os.path.basename(args.path)}")
    ax2.set_xlabel("probe index")

    fig.tight_layout()
    out = args.out or os.path.splitext(args.path)[0] + ".png"
    fig.savefig(out, dpi=120)
    print(f"saved {out}")


if __name__ == "__main__":
    main()
