import { formatValue } from "./format";
import { BACKTEST, PAIRED } from "./modelNumbers";
import {
  NOMINAL_COVERAGE, SHIPPED, WHY_SHIPPED, horizonPhrase, horizonsIn, matchedBy, matchedPhrase, pairedWith, points, rowAt, scored,
  separatedAt, type BacktestRow, type PairedRow,
} from "./model";
import { SOURCE_LABEL, dateAt, defById, fieldAt, labelFor } from "./metrics";
import type { Metro } from "../types";

// the fields the detail panel lists, in reading order. the two expected
// growth lines carry the band from their _lo and _hi companions
export const FORECAST_FIELDS = ["hpi_forecast_4q", "hpi_forecast_8q", "hpi_trend_5y", "hpi_yoy_latest", "hpi_surprise_4q"] as const;

export type ForecastField = (typeof FORECAST_FIELDS)[number];
type Banded = "hpi_forecast_4q" | "hpi_forecast_8q";

export interface ForecastLine {
  id: ForecastField;
  label: string;
  text: string;
  // set when the line is dated apart from the origin the caption names: the
  // surprise scores a call made four quarters before it
  date?: string;
  // set when the number is not the model's. realized growth is read off the
  // fhfa index, so its row names fhfa rather than sitting under the model
  source?: string;
}

// the unit is whatever the metric definition declares, so a field reads the
// same here as it does on the map and on the accuracy page. the surprise is a
// difference of two growth rates and carries points, not percent
function show(id: ForecastField, value: number | null): string {
  return formatValue(value, defById(id)?.def.format ?? "rate", true);
}

// "+3.1% (band -1.2% to +7.0%)". the band is left off when an edge is
// missing, and the line is null when the point itself is
export function bandLine(metro: Metro, field: Banded): string | null {
  const point = fieldAt(metro, "latest", field);
  if (point === null) return null;
  const lo = fieldAt(metro, "latest", `${field}_lo`);
  const hi = fieldAt(metro, "latest", `${field}_hi`);
  return lo === null || hi === null
    ? show(field, point)
    : `${show(field, point)} (band ${show(field, lo)} to ${show(field, hi)})`;
}

function plainLine(metro: Metro, field: ForecastField): string | null {
  const value = fieldAt(metro, "latest", field);
  return value === null ? null : show(field, value);
}

// the origin the caption names: the first date in reading order, which is the
// forecasts' own month. not every line shares it, the surprise is dated at
// the quarter of the call it scores, so a line dated otherwise carries its own
function captionOrigin(metro: Metro): string | null {
  for (const id of FORECAST_FIELDS) {
    const date = dateAt(metro, "latest", id);
    if (date) return date;
  }
  return null;
}

// one line per forecast field the metro carries, labelled like the menu
export function forecastLines(metro: Metro): ForecastLine[] {
  const origin = captionOrigin(metro);
  const lines: ForecastLine[] = [];
  for (const id of FORECAST_FIELDS) {
    const text = id === "hpi_forecast_4q" || id === "hpi_forecast_8q" ? bandLine(metro, id) : plainLine(metro, id);
    if (text === null) continue;
    const line: ForecastLine = { id, label: labelFor(id), text };
    const date = dateAt(metro, "latest", id);
    if (date !== null && date !== origin) line.date = date;
    const source = defById(id)?.def.source;
    if (source && source !== "forecast") line.source = SOURCE_LABEL[source];
    lines.push(line);
  }
  return lines;
}

// "Source: Loop model, origin 2026-06"
export function forecastCaption(metro: Metro): string {
  const source = `Source: ${SOURCE_LABEL.forecast}`;
  const origin = captionOrigin(metro);
  return origin ? `${source}, origin ${origin}` : source;
}

// the index standard error is not a forecast, but it belongs beside one: it
// says how firmly the thing being forecast is measured, and a wide error is a
// reason to read the forecast above it loosely. it is fhfa's number, so it is
// credited to fhfa rather than to the model
export const INDEX_ERROR = "hpi_index_error";

export interface IndexErrorLine {
  label: string;
  text: string;
  source: string;
}

export function indexErrorLine(metro: Metro): IndexErrorLine | null {
  const value = fieldAt(metro, "latest", INDEX_ERROR);
  if (value === null) return null;
  const def = defById(INDEX_ERROR)?.def;
  return { label: labelFor(INDEX_ERROR), text: formatValue(value, def?.format ?? "rate"), source: SOURCE_LABEL[def?.source ?? "fhfa"] };
}

// what the backtest's band held over 2022 onward, and what that says about the
// band drawn beside it. the numbers belong to the backtest, calibrated on 2018
// to 2021, not to the shipped band, whose margin was set on 2022 onward by a
// second model, so the sentence names whose they are. whether they fall short
// is read off them rather than assumed
function backtestCoverage(): string {
  const near = rowAt(BACKTEST, SHIPPED, 4);
  const far = rowAt(BACKTEST, SHIPPED, 8);
  if (!near || !far || !scored(near.coverage) || !scored(far.coverage)) {
    return "The backtest's own coverage, scored on 2022 onward, is reported on the model page.";
  }
  const held = `The backtest's band, calibrated on 2018 to 2021, held ${points(near.coverage)} of outcomes from 2022 on at four quarters and ${points(far.coverage)} at eight`;
  const shortNear = near.coverage < NOMINAL_COVERAGE;
  const shortFar = far.coverage < NOMINAL_COVERAGE;
  if (shortNear && shortFar) {
    const weaker = far.coverage <= near.coverage ? "eight" : "four";
    return `${held}, short of nine in ten at both, so read the ${weaker} quarter band loosely.`;
  }
  if (shortFar) return `${held}, so it reached nine in ten at four quarters and fell short at eight, the band to read loosely.`;
  if (shortNear) return `${held}, so it fell short of nine in ten at four quarters and reached it at eight.`;
  return `${held}, at or above nine in ten at both.`;
}

// how ridge did against the gru in the backtest, whether the paired test
// finds that gap more than chance, and why the gru is on the map either way.
// read off the backtest and the test, so a retrain that changes who leads or
// how firmly changes the sentence
export function againstRidge(backtest: BacktestRow[] = BACKTEST, paired: PairedRow[] = PAIRED): string {
  const at = matchedPhrase(matchedBy(backtest, "ridge", SHIPPED));
  if (!at) return `The GRU ships because ${WHY_SHIPPED}, and the model page scores it against ridge and every other rule.`;
  const tested = pairedWith(paired, "ridge");
  const horizons = horizonsIn(backtest);
  const apart = separatedAt(paired, "ridge");
  const covered = horizons.length > 0 && horizons.every((h) => tested.some((row) => row.horizon === h));
  const test = !covered ? "" : apart.length === 0
    ? ", but a paired test puts every gap between them down to chance, so the two are tied"
    : `, a lead a paired test separates from chance at ${horizonPhrase(apart)}`;
  return `In the backtest ridge regression matches or beats the GRU ${at}${test}, and the GRU ships because ${WHY_SHIPPED}.`;
}

// what the Forecasts table is, in four sentences, for the panel's question
// mark. the coverage numbers and the comparison with ridge are read from the
// shipped backtest rather than written down, so a retrain moves this with the
// rest of the page
export function forecastExplainer(metro: Metro): { sentences: string[]; source: string } {
  return {
    sentences: [
      "A sequence GRU reads 24 quarters of this metro's history and its covariates and forecasts how the FHFA index moves over the next four and eight quarters.",
      "The band drawn here is conformal: the model's range widened by a margin a separate band model set on outcomes from 2022 on, so it is a calibrated range, not a best and worst case.",
      backtestCoverage(),
      againstRidge(),
    ],
    source: forecastCaption(metro),
  };
}
