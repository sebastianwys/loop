# one chart style for every figure in results/figures, so the walkthrough
# reads as one system. light surface, thin marks, recessive grid, a fixed
# categorical order, one blue ramp for magnitude and blue against red for sign

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt
import numpy as np
from matplotlib.colors import LinearSegmentedColormap
from matplotlib.font_manager import FontProperties
from matplotlib.ticker import FuncFormatter

from loop.spec import FIGURES_DIR

SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"]
SEQUENTIAL = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"]
DIVERGING = ["#184f95", "#3987e5", "#9ec5f4", "#f0efec", "#f3a6a5", "#e34948", "#a32626"]
SURFACE = "#fcfcfb"
INK = "#0b0b0b"
INK2 = "#52514e"
MUTED = "#898781"
GRID = "#e1e0d9"
AXIS = "#c3c2b7"
BAND = "#cde2fb"

# the model page shows its seven figures about 680 px wide, so they use these
PAGE_WIDTH = 7.2
PAGE_SMALL = 9


# small is the smallest text size, and every other size steps up from it
def style(small=8):
    plt.rcParams.update({
        "figure.facecolor": SURFACE,
        "axes.facecolor": SURFACE,
        "savefig.facecolor": SURFACE,
        "axes.edgecolor": AXIS,
        "axes.linewidth": 0.8,
        "axes.spines.top": False,
        "axes.spines.right": False,
        "axes.grid": True,
        "axes.grid.axis": "y",
        "grid.color": GRID,
        "grid.linewidth": 0.6,
        "xtick.color": MUTED,
        "ytick.color": MUTED,
        "xtick.labelsize": small,
        "ytick.labelsize": small,
        "text.color": INK,
        "axes.labelcolor": INK2,
        "axes.labelsize": small + 1,
        "axes.titlesize": small + 3,
        "axes.titleweight": "normal",
        "axes.titlelocation": "left",
        "font.size": small + 1,
        "lines.linewidth": 1.6,
        "legend.frameon": False,
        "legend.fontsize": small,
        "savefig.dpi": 160,
        "axes.prop_cycle": plt.cycler(color=SERIES),
    })


# given room in inches, the subtitle wraps and the panels start that far under it
def figure(title, subtitle=None, size=(9, 5), rows=1, cols=1, small=8, room=None, **kwargs):
    style(small)
    fig, axes = plt.subplots(rows, cols, figsize=size, **kwargs)
    # the subtitle sits a fixed distance under the title in inches, so short
    # figures do not push the two lines into each other
    top = 0.995
    fig.suptitle(title, x=0.01, y=top, ha="left", va="top", fontsize=small + 4, color=INK)
    if subtitle:
        if room is not None:
            subtitle = wrap(fig, subtitle, small + 1)
        drop = 0.28 * (small + 4) / 12
        fig.text(0.01, top - drop / fig.get_figheight(), subtitle, ha="left", va="top", fontsize=small + 1, color=INK2)
    if room is not None:
        fig.subplots_adjust(top=1 - (header_depth(fig) + room) / fig.get_figheight())
    return fig, axes


# words onto lines no wider than the figure, measured as drawn
def wrap(fig, text, size):
    renderer = fig.canvas.get_renderer()
    font = FontProperties(size=size)
    limit = 0.97 * fig.bbox.width
    out = []
    for paragraph in text.split("\n"):
        lines = [""]
        for word in paragraph.split():
            trial = f"{lines[-1]} {word}".strip()
            if lines[-1] and renderer.get_text_width_height_descent(trial, font, ismath=False)[0] > limit:
                lines.append(word)
            else:
                lines[-1] = trial
        out += lines
    return "\n".join(out)


# inches from the top of the figure to the bottom of its subtitle
def header_depth(fig):
    renderer = fig.canvas.get_renderer()
    lowest = min(text.get_window_extent(renderer).y0 for text in fig.texts)
    return (fig.bbox.height - lowest) / fig.dpi


def save(fig, name):
    FIGURES_DIR.mkdir(parents=True, exist_ok=True)
    path = FIGURES_DIR / f"{name}.png"
    fig.savefig(path, bbox_inches="tight", pad_inches=0.3)
    plt.close(fig)
    return path


# a label at the right end of a line, in ink, next to a mark of the series color
def label_end(ax, x, y, text, color):
    ax.plot([x], [y], marker="o", markersize=4, color=color, zorder=5)
    ax.annotate(text, (x, y), xytext=(5, 0), textcoords="offset points", va="center", fontsize=8, color=INK2)


# values pushed at least gap apart, each crowded run centered where it began
def spread(values, gap):
    values = np.asarray(values, dtype=float)
    order = np.argsort(values, kind="stable")
    runs = []
    for value in values[order]:
        runs.append([value, [value]])
        while len(runs) > 1 and runs[-2][0] + gap * len(runs[-2][1]) > runs[-1][0]:
            members = runs[-2][1] + runs[-1][1]
            runs[-2:] = [[np.mean(members) - gap * (len(members) - 1) / 2, members]]
    placed = np.concatenate([start + gap * np.arange(len(members)) for start, members in runs])
    out = np.empty_like(placed)
    out[order] = placed
    return out


# line end names in ink, pushed apart, each with a leader in its line's color
def label_ends(ax, ends, size, dx=16, lead=1.7):
    points = ax.figure.dpi / 72
    ys = ax.transData.transform([(x, y) for x, y, _, _ in ends])[:, 1]
    placed = spread(ys, lead * size * points)
    for (x, y, text, color), at, y0 in zip(ends, placed, ys):
        ax.annotate(text, (x, y), xytext=(dx, (at - y0) / points), textcoords="offset points",
                    va="center", fontsize=size, color=INK2, annotation_clip=False,
                    arrowprops=dict(arrowstyle="-", color=color, linewidth=1.0, shrinkA=1, shrinkB=4))


def pct_axis(ax, axis="y", decimals=0):
    fmt = FuncFormatter(lambda v, _: f"{v:.{decimals}f}%")
    (ax.yaxis if axis == "y" else ax.xaxis).set_major_formatter(fmt)


def sequential_cmap():
    return LinearSegmentedColormap.from_list("loop_sequential", SEQUENTIAL)


def diverging_cmap():
    return LinearSegmentedColormap.from_list("loop_diverging", DIVERGING)
