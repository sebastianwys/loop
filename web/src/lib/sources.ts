import type { MapData, Provenance } from "../types";
import { SOURCE_LABEL, visibleDefs, type MetricDef, type Source } from "./metrics";

// the provenance rows are named after raw data folders, which are not the
// site's source ids. every folder but these three is named after the id it
// feeds, or after no id at all
const ALIAS: Record<string, Source> = { zillow_extras: "zillow" };

// the four fields the extras csv carries. zillow is the one source id that two
// folders feed, so its metrics are split by field rather than by id: a metric
// belongs to the file its number was read out of
const EXTRA_METRICS = ["inventory", "days_to_pending", "price_cut_share", "zhvf_forecast"];

// what a folder does when no metric on this site is built from it. an empty
// metric list with nothing beside it reads like a download nobody uses
const ROLE: Record<string, string> = {
  boundaries: "the metro outlines the map draws in shapes mode",
  gazetteer: "the centroid each metro's dot is placed at",
  fred: "the 30 year mortgage rate in the header, a national figure rather than a metro metric",
  national: "the national indicators in the header strip, a second pull from the same publisher",
};

// a query parameter whose name reads like a credential. no manifest in this
// build carries one, and this is what keeps a later one off the page
const SECRET = /key|token|secret|password|auth|userid|user_id|credential|registration/i;

export interface SourceRow {
  // the manifest row, verbatim, because the point of the page is the download
  entry: Provenance;
  source: Source | null;
  label: string | null;
  metrics: MetricDef[];
  // set only when the folder builds no metric
  role: string | null;
}

export interface SourceReport {
  rows: SourceRow[];
  files: number;
  rowCount: number;
  oldest: string | null;
  newest: string | null;
  // source ids that carry metrics but no folder in data/raw. the model's
  // export is computed rather than downloaded, so it lands here
  unsourced: Source[];
}

function isSource(id: string): id is Source {
  return Object.prototype.hasOwnProperty.call(SOURCE_LABEL, id);
}

export function sourceOf(folder: string): Source | null {
  const id = ALIAS[folder] ?? folder;
  return isSource(id) ? id : null;
}

export function metricsOf(folder: string, defs: MetricDef[]): MetricDef[] {
  const source = sourceOf(folder);
  if (source === null) return [];
  const mine = defs.filter((def) => def.source === source);
  if (folder === "zillow_extras") return mine.filter((def) => EXTRA_METRICS.includes(def.id));
  if (folder === "zillow") return mine.filter((def) => !EXTRA_METRICS.includes(def.id));
  return mine;
}

// the whole page in one object. an older build with no provenance block comes
// back with no rows rather than with a claim it cannot support
export function buildSources(data: MapData | null | undefined): SourceReport {
  const entries: Provenance[] = Array.isArray(data?.provenance) ? data!.provenance : [];
  const defs = visibleDefs(data?.metros ?? []);
  const rows: SourceRow[] = [...entries]
    .sort((a, b) => a.source.localeCompare(b.source))
    .map((entry) => {
      const source = sourceOf(entry.source);
      const metrics = metricsOf(entry.source, defs);
      return {
        entry,
        source,
        label: source === null ? null : SOURCE_LABEL[source],
        metrics,
        role: metrics.length === 0 ? ROLE[entry.source] ?? null : null,
      };
    });

  let files = 0;
  let rowCount = 0;
  let oldest: string | null = null;
  let newest: string | null = null;
  for (const { entry } of rows) {
    files += Number.isFinite(entry.files) ? entry.files : 0;
    rowCount += Number.isFinite(entry.row_count) ? entry.row_count : 0;
    const at = entry.downloaded_at;
    if (typeof at === "string" && at.length > 0) {
      if (oldest === null || at < oldest) oldest = at;
      if (newest === null || at > newest) newest = at;
    }
  }

  const covered = new Set(rows.map((r) => r.source));
  const unsourced = [...new Set(defs.map((d) => d.source))].filter((s) => !covered.has(s)).sort();

  return { rows, files, rowCount, oldest, newest, unsourced };
}

export interface SafeUrl {
  // null when the value is not an http url, so a manifest cannot put a
  // javascript: href on the page
  href: string | null;
  text: string;
  stripped: string[];
}

// the url a manifest recorded, made safe to render. the string is left byte
// for byte unless a parameter has to come out, so a link a reader checks is
// the one the pipeline asked for
export function safeUrl(raw: string): SafeUrl {
  const value = typeof raw === "string" ? raw.trim() : "";
  const q = value.indexOf("?");
  const stripped: string[] = [];
  let text = value;
  if (q >= 0) {
    const kept: string[] = [];
    for (const part of value.slice(q + 1).split("&")) {
      if (SECRET.test(part.split("=")[0])) stripped.push(part.split("=")[0]);
      else kept.push(part);
    }
    if (stripped.length > 0) text = kept.length > 0 ? `${value.slice(0, q)}?${kept.join("&")}` : value.slice(0, q);
  }
  return { href: /^https?:\/\//i.test(text) ? text : null, text, stripped };
}

// "2026-09-15T19:04:53Z" as "2026-09-15 19:04 UTC". the manifest records utc,
// so it is shown as utc rather than moved to wherever the reader is sitting
export function stamp(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(typeof iso === "string" ? iso : "");
  return m ? `${m[1]} ${m[2]} UTC` : (iso ?? "");
}

// a sha256 is 64 characters and there are sixteen of them on this page
export function shortHash(sha: string, keep = 12): string {
  const value = typeof sha === "string" ? sha : "";
  return value.length > keep ? `${value.slice(0, keep)}...` : value;
}
