#!/usr/bin/env python3
"""Plot probe hit positions from a JSONL file produced by test_probe.py."""

import argparse
import json
import math
import os

import matplotlib.pyplot as plt
from scipy import stats


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("path")
    ap.add_argument("--out", default=None, help="output PNG path (default: <input>.png)")
    args = ap.parse_args()

    ixs, hits = [], []
    with open(args.path) as fp:
        for line in fp:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            ixs.append(rec["ix"])
            hits.append(rec["hit"])

    n = len(hits)
    fit = stats.linregress(ixs, hits)
    b, a = fit.slope, fit.intercept
    se = fit.stderr
    df = n - 2
    t_crit = stats.t.ppf(0.975, df)
    p_two = fit.pvalue

    fitted = [a + b * x for x in ixs]
    resid = [h - f for h, f in zip(hits, fitted)]
    rmin, rmax = min(resid), max(resid)
    resid_std = (sum(r * r for r in resid) / df) ** 0.5

    print(f"n={n}")
    print(f"slope = {b*1000:.4f} um/probe   (95% CI: [{(b-t_crit*se)*1000:.4f}, {(b+t_crit*se)*1000:.4f}])")
    print(f"intercept = {a:.6f}   p(two-sided)={p_two:.3g}   R^2={fit.rvalue**2:.3f}")
    print(f"residual std = {resid_std*1000:.3f} um   range=[{rmin*1000:.2f}, {rmax*1000:.2f}] um")

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(11, 4.5))

    ax1.plot(ixs, hits, marker="o", linestyle="-", markersize=4, label="hit")
    fit_label = f"fit: {b*1000:.3f} µm/probe (95% CI ±{t_crit*se*1000:.3f})"
    ax1.plot(ixs, fitted, color="C1", linestyle="--", linewidth=1.5, label=fit_label)
    ax1.set_xlabel("probe index")
    ax1.set_ylabel("hit position [mm]")
    ax1.set_title(f"{os.path.basename(args.path)}")
    ax1.legend(loc="best", fontsize=8)
    ax1.grid(True, alpha=0.3)

    resid_um = [r * 1000 for r in resid]
    bin_w_um = 5.0
    lo = math.floor(min(resid_um) / bin_w_um) * bin_w_um
    hi = math.ceil(max(resid_um) / bin_w_um) * bin_w_um
    n_bins = max(1, round((hi - lo) / bin_w_um))
    edges = [lo + i * bin_w_um for i in range(n_bins + 1)]
    ax2.hist(resid_um, bins=edges, edgecolor="black")
    ax2.axvline(0, color="C1", linestyle="--", linewidth=1)
    ax2.set_xlabel("residual from linear fit [µm]")
    ax2.set_ylabel("count")
    ax2.set_title(f"residuals (bin=5µm, σ={resid_std*1000:.2f}µm)")
    ax2.grid(True, alpha=0.3)

    fig.tight_layout()
    out = args.out or os.path.splitext(args.path)[0] + ".png"
    fig.savefig(out, dpi=120)
    print(f"saved {out}")


if __name__ == "__main__":
    main()
