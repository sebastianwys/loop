// the figures the model page shows, with the size each png really is so the
// column does not jump as they arrive, and alt text that says what the figure
// shows rather than that it is a chart.
//
// scripts/model-assets.mjs copies exactly these out of ml/results/figures at
// build time, and its test fails if the two lists drift apart. the other six
// figures the ml folder renders describe the panel or repeat a chart that is
// already here, so they are not worth the megabytes.
export type FigureId =
  | "coverage" | "design" | "training" | "comparison" | "calibration" | "fans" | "distribution";

export interface ModelFigure {
  file: string;
  width: number;
  height: number;
  alt: string;
  caption: string;
}

export const FIGURES: Record<FigureId, ModelFigure> = {
  coverage: {
    file: "01_coverage.png",
    width: 1752,
    height: 971,
    alt: "A grid of thirteen source series against the years 1975 to 2026, each cell shaded by the"
      + " share of the 410 metros that have a value. House prices, the mortgage rate and national"
      + " macro are dark from 1990, the expanded index and its error from 1991, unemployment from"
      + " 1990, Zillow home values from 2000, rents from 2015, permits and income from the middle"
      + " 2010s, and listings and inventory only from the end of that decade.",
    caption: "Every covariate starts later than the price it is meant to explain, and the model is"
      + " fitted on the left of this picture.",
  },
  design: {
    file: "05_backtest_design.png",
    width: 1520,
    height: 780,
    alt: "Four rows, one per horizon, with a tick at every forecast origin. Ticks are coloured by"
      + " the block the outcome falls in: train through 2017Q4, calibration through 2021Q4, test"
      + " from 2022Q1. The longer the horizon, the earlier its ticks change colour, and a callout"
      + " marks the origins left out because their outcome would land in the next block.",
    caption: "Read down a column: the longer the horizon, the earlier an origin has to stop being"
      + " something the model is allowed to learn from.",
  },
  training: {
    file: "09_training_curves.png",
    width: 1520,
    height: 794,
    alt: "Two panels of pinball loss against epoch, the window MLP and the sequence GRU, each with"
      + " a fitting curve and a validation curve. The window MLP stops at epoch 2 with validation"
      + " loss already drifting up while the fitting loss keeps falling. The GRU stops at epoch 12"
      + " with validation flat from about epoch 3.",
    caption: "Both networks stop on validation loss. Neither the test block nor the calibration"
      + " block is consulted.",
  },
  comparison: {
    file: "12_model_comparison.png",
    width: 1353,
    height: 936,
    alt: "Seven lines of mean absolute error against horizon, 1 to 8 quarters, every one rising"
      + " with the horizon. No change is worst at about 18 percentage points at 8 quarters,"
      + " momentum and the window MLP next at about 15.5, the metro mean at 11.8, and ridge,"
      + " gradient boosting and the sequence GRU bunched between 10.1 and 10.4.",
    caption: "Error rises with the horizon for every model, and the strongest few converge at the"
      + " long end, where the choice between them stops being obvious.",
  },
  calibration: {
    file: "10_quantile_calibration.png",
    width: 1846,
    height: 1219,
    alt: "Four panels, one per horizon, plotting the share of test outcomes below each predicted"
      + " quantile against the nominal quantile. At one and two quarters the line sits close to the"
      + " diagonal. At eight quarters it bows away from it, and the panel headings report band"
      + " coverage of 0.80, 0.88, 0.87 and 0.66 against a nominal 0.90.",
    caption: "This is the failure the limits below are about. The bands hold at short horizons and"
      + " give way at eight quarters.",
  },
  fans: {
    file: "11_forecast_fans.png",
    width: 2089,
    height: 1120,
    alt: "Eight metros, each showing its house price index since 2015 and the model's median path"
      + " to 2028 inside a shaded 90 percent band. The bands are wide: the Chicago division's eight"
      + " quarter band runs from minus 3.4 percent to plus 40.7 percent around a median of plus"
      + " 15.2, and Austin's runs from minus 13.0 to plus 25.6.",
    caption: "Eight metros at the 2026Q2 origin: the index since 2015, the median path, and the 90"
      + " percent band drawn around it.",
  },
  distribution: {
    file: "13_forecast_distribution.png",
    width: 1377,
    height: 936,
    alt: "A histogram of the median four quarter forecast across 410 metros, running from under 1"
      + " percent to about 10 percent and peaking near 5 percent, with marked lines at the 10th"
      + " percentile of plus 3.1 percent, the median of plus 4.9 and the 90th percentile of plus"
      + " 6.7. No bar sits below zero.",
    caption: "The shipped four quarter forecast across every metro on the map.",
  },
};

export const FIGURE_IDS = Object.keys(FIGURES) as FigureId[];

export const FIGURE_FILES = FIGURE_IDS.map((id) => FIGURES[id].file);

// the path the build copies them to. public/figures is gitignored, so a tree
// that has never been built has captions and no images
export function figureSrc(figure: ModelFigure): string {
  return `/figures/${figure.file}`;
}
