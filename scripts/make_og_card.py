# the link preview card, 1200x630, built from the map's own data so the image a
# social crawler shows is the product rather than a logo. linkedin lists og:image
# among the four tags it requires and wants at least 1200x627 at about 1.91:1
#
#   python scripts/make_og_card.py
#
# writes web/public/og.png, which the vite build copies into dist
import json
import math
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.patches import Rectangle

BASE_DIR = Path(__file__).resolve().parent.parent
DATA = BASE_DIR / "web" / "public" / "data" / "metros.json"
OUT = BASE_DIR / "web" / "public" / "og.png"

# web/src/lib/palette.ts, the chart tokens the map itself draws with
SURFACE = "#fcfcfb"
INK = "#0b0b0b"
INK_2 = "#52514e"
MUTED = "#898781"
SEQUENTIAL = ["#86b6ef", "#5598e7", "#2a78d6", "#1c5cab", "#0d366b"]

WIDTH, HEIGHT, DPI = 1200, 630, 200
YEAR = "2024"

# the frame is the contiguous states. the four metros outside it are counted in
# the caption rather than stretching the map to reach them
LON = (-125.0, -66.5)
LAT = (24.0, 49.5)
# longitude degrees are shorter than latitude degrees away from the equator, so
# the aspect is corrected at the middle of the frame rather than left square
MID_LAT = math.radians(sum(LAT) / 2)


def oklab_lightness(hex_color):
    r, g, b = (int(hex_color[i:i + 2], 16) / 255 for i in (1, 3, 5))
    linear = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in (r, g, b)]
    r, g, b = linear
    l = np.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
    m = np.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
    s = np.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
    return 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s


# a sequential ramp has one job: darker means more. the categorical checks do
# not apply, so this is the one that does
def check_monotonic(ramp):
    steps = [oklab_lightness(c) for c in ramp]
    falling = all(a > b for a, b in zip(steps, steps[1:]))
    print("ramp lightness " + ", ".join(f"{s:.3f}" for s in steps)
          + (" -> monotonic" if falling else " -> NOT monotonic"))
    return falling


def load_metros():
    payload = json.loads(DATA.read_text())
    rows = []
    for metro in payload["metros"]:
        year = metro["years"].get(YEAR, {})
        income, pop = year.get("income"), year.get("pop")
        if income and pop and metro.get("lat") and metro.get("lon"):
            rows.append((metro["lon"], metro["lat"], float(income), float(pop)))
    return payload, rows


def draw(payload, rows):
    if not check_monotonic(SEQUENTIAL):
        raise SystemExit("the ramp is not ordered light to dark, fix the palette first")

    lon, lat, income, pop = (np.array(col, dtype=float) for col in zip(*rows))
    inside = (lon > LON[0]) & (lon < LON[1]) & (lat > LAT[0]) & (lat < LAT[1])

    # five bins on the five step ramp, cut at the quintiles of the year's incomes
    edges = np.percentile(income, [20, 40, 60, 80])
    bins = np.digitize(income, edges)
    colors = np.array(SEQUENTIAL)[bins]
    # area carries population, so the big metros read as big. the root keeps
    # new york from swallowing the frame
    sizes = 1.5 + 34 * np.sqrt(pop / pop.max())

    fig = plt.figure(figsize=(WIDTH / DPI, HEIGHT / DPI), dpi=DPI, facecolor=SURFACE)
    ax = fig.add_axes([0.375, 0.105, 0.605, 0.82])
    ax.set_facecolor(SURFACE)
    # a thin surface ring keeps overlapping metros legible on the coasts
    ax.scatter(lon[inside], lat[inside], s=sizes[inside], c=colors[inside],
               linewidths=0.35, edgecolors=SURFACE, zorder=3)
    ax.set_xlim(*LON)
    ax.set_ylim(*LAT)
    ax.set_aspect(1 / math.cos(MID_LAT))
    ax.axis("off")

    # the text column stops short of the pacific coast dots, which sit a little
    # inside the map axes, so nothing overlaps the west
    fig.text(0.045, 0.85, "Loop", color=INK, fontsize=34, fontweight="bold", va="top")
    fig.text(0.045, 0.685, "Housing, income, jobs\nand migration across\n410 U.S. metros",
             color=INK_2, fontsize=10, va="top", linespacing=1.5)
    fig.text(0.045, 0.40, "loop.macroviz.workers.dev", color=INK, fontsize=8.5, va="top")
    fig.text(0.045, 0.325, "FHFA, Census, BLS, BEA, HUD, IRS, Zillow",
             color=MUTED, fontsize=7, va="top")

    # the legend names what the color means, so identity is never color alone
    fig.text(0.045, 0.235, f"Median household income, {YEAR}", color=INK_2, fontsize=7, va="top")
    x, width = 0.045, 0.036
    for index, step in enumerate(SEQUENTIAL):
        fig.patches.append(Rectangle((x + index * (width + 0.004), 0.145), width, 0.035,
                                     facecolor=step, edgecolor=SURFACE, linewidth=0.6,
                                     transform=fig.transFigure, figure=fig))
    fig.text(0.045, 0.125, f"${income.min() / 1000:.0f}k", color=MUTED, fontsize=6, va="top")
    fig.text(0.243, 0.125, f"${income.max() / 1000:.0f}k", color=MUTED, fontsize=6,
             va="top", ha="right")

    outside = int((~inside).sum())
    fig.text(0.98, 0.055, f"{int(inside.sum())} metros shown, {outside} outside the frame. "
             f"Built {payload['generated_at'][:10]}.", color=MUTED, fontsize=6, ha="right")

    fig.savefig(OUT, dpi=DPI, facecolor=SURFACE)
    plt.close(fig)
    print(f"{OUT.relative_to(BASE_DIR)} {OUT.stat().st_size / 1024:.0f} kb, "
          f"{len(rows)} metros, {outside} outside the frame")


if __name__ == "__main__":
    draw(*load_metros())
