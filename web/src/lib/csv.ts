import type { Period } from "../types";
import { formatValue } from "./format";
import type { Metric } from "./metrics";
import type { Ranked } from "./rank";

export type CsvValue = string | number | null | undefined;

// rfc 4180 line endings. excel reads lf, but a windows text editor does not,
// and a csv that opens wrong is a csv nobody trusts
const EOL = "\r\n";

const NEEDS_QUOTES = /[",\r\n]/;

// a field is quoted when it holds a quote, a comma or a line break, and an
// inner quote is doubled. null and undefined write an empty field, so a
// missing value never arrives in a spreadsheet as the word "null"
export function escapeField(value: CsvValue): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "number" ? (Number.isFinite(value) ? String(value) : "") : String(value);
  return NEEDS_QUOTES.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(header: string[], rows: CsvValue[][]): string {
  const line = (cells: CsvValue[]) => cells.map(escapeField).join(",");
  return [line(header), ...rows.map(line)].join(EOL) + EOL;
}

export const RANKING_HEADER = ["rank", "cbsa", "metro", "metric", "period", "value", "display"];

// the ranking as the sidebar has it: the same rows in the same order, the raw
// number for a spreadsheet and the string the site printed beside it, so a
// reader can tell a rounded display from the value behind it
export function rankingCsv(ranked: Ranked[], metric: Metric): string {
  const signed = metric.kind === "diverging";
  const rows = ranked.map((r, i) => [
    i + 1,
    r.metro.cbsa,
    r.metro.name,
    // the resolved label, not the definition's. an animated metric borrows the
    // index's definition while carrying growth, so def.label would head a
    // column of percent changes "House price index"
    metric.label,
    metric.period ?? "",
    r.value,
    formatValue(r.value, metric.format, signed),
  ]);
  return toCsv(RANKING_HEADER, rows);
}

// a metric label down to something a file system is happy with
export function slug(label: string): string {
  return (typeof label === "string" ? label : "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// named after what is in it, so a folder of downloads is not sixteen copies
// of export.csv
export function csvFilename(label: string, period: Period | null): string {
  const base = slug(label) || "ranking";
  return `loop-${base}${period ? `-${period}` : ""}.csv`;
}

export interface DownloadLink {
  href: string;
  download: string;
  click(): void;
}

export interface DownloadHost {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  createLink(): DownloadLink;
  defer(fn: () => void): void;
}

// the browser half, kept beside the text it writes so the component stays a
// button. the host arrives as an argument because the tests have no dom
export function downloadCsv(text: string, filename: string, host: DownloadHost): void {
  const url = host.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const link = host.createLink();
  link.href = url;
  link.download = filename;
  link.click();
  // an object url pins its blob in memory until it is revoked, and safari
  // cancels the download if the url dies in the same tick as the click
  host.defer(() => host.revokeObjectURL(url));
}

// null where the page is being rendered without a browser behind it
export function browserHost(): DownloadHost | null {
  if (typeof document === "undefined" || typeof URL === "undefined") return null;
  if (typeof URL.createObjectURL !== "function") return null;
  return {
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    createLink: () => document.createElement("a"),
    defer: (fn) => { window.setTimeout(fn, 0); },
  };
}
