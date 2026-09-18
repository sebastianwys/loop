import { formatValue } from "./format";
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

// one line per forecast field the metro carries, labelled like the menu
export function forecastLines(metro: Metro): ForecastLine[] {
  const lines: ForecastLine[] = [];
  for (const id of FORECAST_FIELDS) {
    const text = id === "hpi_forecast_4q" || id === "hpi_forecast_8q" ? bandLine(metro, id) : plainLine(metro, id);
    if (text !== null) lines.push({ id, label: labelFor(id), text });
  }
  return lines;
}

// "Source: Loop model, origin 2026-06". every forecast field carries the
// origin quarter's last month, so the first date found is the one
export function forecastCaption(metro: Metro): string {
  const source = `Source: ${SOURCE_LABEL.forecast}`;
  for (const id of FORECAST_FIELDS) {
    const date = dateAt(metro, "latest", id);
    if (date) return `${source}, origin ${date}`;
  }
  return source;
}
