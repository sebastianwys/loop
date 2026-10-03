import type { Growth, Metro, PanelMarks, Period, YearKey, YearValues } from "../types";

export type ScaleKind = "sequential" | "diverging";
// rate2 is a rate its publisher sets in hundredths, the fed funds target at
// 4.25 or a mortgage rate at 6.95, which one decimal would print as a rate
// nobody published
export type ValueFormat = "pct" | "usd" | "usd_k" | "ratio" | "rate" | "rate2" | "points" | "int" | "index" | "days" | "minutes" | "per_1000";
export type Group = "House prices" | "Housing market" | "Rents and affordability" | "People and migration" | "Supply" | "Forecasts";
export type Source = "fhfa" | "census" | "bls" | "zillow" | "fred" | "acs" | "pep" | "bps" | "irs" | "realtor" | "bea" | "hud" | "forecast";

export const PERIODS: Period[] = ["2014", "2019", "2024", "latest"];
export const GROUPS: Group[] = ["House prices", "Housing market", "Rents and affordability", "People and migration", "Supply", "Forecasts"];

export const SOURCE_LABEL: Record<Source, string> = {
  fhfa: "FHFA",
  census: "Census ACS",
  bls: "BLS LAUS",
  zillow: "Zillow",
  fred: "FRED",
  acs: "Census ACS",
  pep: "Census population estimates",
  bps: "Census building permits",
  irs: "IRS SOI migration",
  realtor: "Realtor.com",
  bea: "BEA",
  hud: "HUD",
  forecast: "Loop model",
};

// a metric definition. periods lists the panels it can be read at; an empty
// list means a change figure with no period, which disables the period control
export interface MetricDef {
  id: string;
  label: string;
  format: ValueFormat;
  kind: ScaleKind;
  group: Group;
  source: Source;
  periods: Period[];
  valueAt: (metro: Metro, period: Period | null) => number | null;
  // the field whose _date companion dates a derived value at latest
  dateId?: string;
}

// a definition resolved at one period. the map, legend and ranking read this
export interface Metric {
  id: string;
  def: MetricDef;
  period: Period | null;
  label: string;
  format: ValueFormat;
  kind: ScaleKind;
  group: Group;
  source: Source;
  accessor: (metro: Metro) => number | null;
  dateOf: (metro: Metro) => string | null;
}

type Field = keyof YearValues;

const YEARS: Period[] = ["2014", "2019", "2024"];
const ALL: Period[] = ["2014", "2019", "2024", "latest"];
const RECENT: Period[] = ["2019", "2024", "latest"];

// a value is usable only if it is a finite number
export function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function yearValue(metro: Metro, year: YearKey, field: Field): number | null {
  return num(metro?.years?.[year]?.[field]);
}

// one field read from a year panel or from latest. never throws on a bare object
export function fieldAt(metro: Metro, period: Period | null, field: Field): number | null {
  if (!period) return null;
  const panel = period === "latest" ? metro?.latest : metro?.years?.[period];
  return num((panel as unknown as Record<string, unknown> | undefined)?.[field]);
}

// the date a value carries: the year itself, or the source's date for latest
export function dateAt(metro: Metro, period: Period | null, field: string): string | null {
  if (!period) return null;
  if (period !== "latest") return period;
  const date = (metro?.latest as unknown as Record<string, unknown> | undefined)?.[`${field}_date`];
  return typeof date === "string" ? date : null;
}

// the same for a definition, which may date itself by another field
export function defDate(def: MetricDef, metro: Metro, period: Period | null): string | null {
  return dateAt(metro, period, def.dateId ?? def.id);
}

function field(id: Field, label: string, format: ValueFormat, kind: ScaleKind, group: Group, source: Source, periods: Period[]): MetricDef {
  return { id, label, format, kind, group, source, periods, valueAt: (m, p) => fieldAt(m, p, id) };
}

function change(id: keyof Growth, label: string, group: Group, source: Source): MetricDef {
  return { id, label, format: "pct", kind: "diverging", group, source, periods: [], valueAt: (m) => num(m?.growth?.[id]) };
}

// null in, null out. a zero denominator is treated as missing, not infinity
function divide(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator <= 0) return null;
  return numerator / denominator;
}

// the zillow series a division takes whole from its parent metro
const ZILLOW_OWN = new Set<string>(["zhvi", "zori"]);

// a division with no rows of its own for a metric takes the parent metro's and
// lists the metric in parent_metrics. the number is real, it just belongs to a
// bigger place, so it is shown with its provenance and kept out of rankings
export function isInherited(metro: Metro, metric: Metric | MetricDef): boolean {
  // a resolved Metric's id carries its period, permits_units_latest, so the
  // field key comes off the definition. dateId names the field a derived
  // metric is built from
  const def = "def" in metric ? metric.def : metric;
  const key = def.dateId ?? def.id;
  // zillow publishes metros only, so a division's zhvi and zori are the parent
  // metro's. that is marked by zillow_scope rather than by parent_metrics
  if (metro?.zillow_scope === "parent metro" && ZILLOW_OWN.has(key)) return true;
  return metro?.parent_metrics?.includes(key) ?? false;
}

// a ratio may only combine fields that describe the same geography. a division
// that inherits one side from its parent metro and keeps its own other side
// has no rate to report, so the caller returns null
function sameGeography(metro: Metro, fields: Field[]): boolean {
  const inherited = metro?.parent_metrics ?? [];
  const from = fields.map((f) => inherited.includes(f));
  return from.every((v) => v === from[0]);
}

// the decade rates the build withholds when a metro's county lines moved too
// far between the two acs vintages, with the vintage field each one divides
const FOOTPRINT_RATES: Record<string, { field: Field; from: YearKey; to: YearKey }> = {
  income_14_24: { field: "income", from: "2014", to: "2024" },
  home_value_14_24: { field: "home_value", from: "2014", to: "2024" },
  pop_14_24: { field: "pop", from: "2014", to: "2024" },
};

// why a blank is withheld: the county lines moved between the two vintages of
// a decade rate, or a year's permits and people were counted over different
// counties
export type Withheld = "footprint" | "permits";

// the metrics a blank can be withheld from rather than never measured
export function canBeWithheld(metric: Metric | MetricDef): boolean {
  const def = "def" in metric ? metric.def : metric;
  return def.id in FOOTPRINT_RATES || def.id === "permits_per_1000";
}

const isShare = (value: unknown): boolean => typeof value === "number" && Number.isFinite(value) && value >= 0;

// a withheld number and a number nobody measured are different claims, and a
// blank cell cannot tell them apart, so every surface that shows a blank asks
// this first. it is withheld only when the build had both sides to divide and
// refused to: a rate with a vintage missing was never there to withhold
export function withheldWhy(metro: Metro, metric: Metric | MetricDef, period: Period | null = null): Withheld | null {
  const def = "def" in metric ? metric.def : metric;
  const at = "def" in metric ? metric.period : period;
  const rate = FOOTPRINT_RATES[def.id];
  if (rate) {
    if (num(metro?.growth?.[def.id as keyof Growth]) !== null) return null;
    const moved = metro?.footprint_unweighed === true || isShare(metro?.footprint_refused);
    const both = yearValue(metro, rate.from, rate.field) !== null && yearValue(metro, rate.to, rate.field) !== null;
    return moved && both ? "footprint" : null;
  }
  if (def.id === "permits_per_1000" && at) {
    const both = fieldAt(metro, at, "permits_units") !== null && fieldAt(metro, at, "pop_estimate") !== null;
    return permitsMarked(metro, at) && both ? "permits" : null;
  }
  return null;
}

// a panel whose permits and people were counted over different counties, by
// a measured share or by a move nobody could weigh
function permitsMarked(metro: Metro, period: Period | null): boolean {
  if (!period) return false;
  const panel = (period === "latest" ? metro?.latest : metro?.years?.[period]) as PanelMarks | undefined;
  return num(panel?.permits_footprint) !== null || panel?.permits_unweighed === true;
}

// the word a withheld blank wears in a tooltip, a table cell or a key
export const WITHHELD = "withheld";

// what happened, for a sentence that already says withheld
export function withheldBecause(why: Withheld): string {
  return why === "footprint"
    ? "the county lines moved between the two vintages"
    : "the permits and the people were counted over different counties";
}

// the reason, for a title or a sentence
export function withheldReason(why: Withheld): string {
  return `withheld because ${withheldBecause(why)}`;
}

// the same in a few words, for a tooltip or a key
export function withheldShort(why: Withheld): string {
  return why === "footprint" ? "county lines moved" : "counted over different counties";
}

export const DEFS: MetricDef[] = [
  // house prices
  change("hpi_19_24", "HPI growth, 2019 to 2024", "House prices", "fhfa"),
  change("hpi_14_19", "HPI growth, 2014 to 2019", "House prices", "fhfa"),
  field("hpi", "House price index", "index", "sequential", "House prices", "fhfa", ALL),
  { id: "ptir", label: "Price to income ratio", format: "ratio", kind: "sequential", group: "House prices", source: "census", periods: YEARS,
    valueAt: (m, p) => (p && p !== "latest" ? num(m?.ptir?.[p]) : null) },
  field("home_value", "Median home value", "usd", "sequential", "House prices", "census", YEARS),
  change("home_value_14_24", "Median home value growth, 2014 to 2024", "House prices", "census"),
  field("zhvi", "Zillow home value index", "usd", "sequential", "House prices", "zillow", ALL),
  field("median_listing_price", "Median listing price", "usd", "sequential", "House prices", "realtor", RECENT),
  field("zhvf_forecast", "Zillow 12 month value forecast", "rate", "diverging", "House prices", "zillow", ["latest"]),
  // housing market
  field("active_listings", "Active listings", "int", "sequential", "Housing market", "realtor", RECENT),
  field("inventory", "For sale inventory", "int", "sequential", "Housing market", "zillow", RECENT),
  field("days_on_market", "Median days on market", "days", "sequential", "Housing market", "realtor", RECENT),
  field("days_to_pending", "Mean days to pending", "days", "sequential", "Housing market", "zillow", RECENT),
  field("price_reduced_share", "Listings with a price reduction", "pct", "sequential", "Housing market", "realtor", RECENT),
  field("price_cut_share", "Listings with a price cut", "pct", "sequential", "Housing market", "zillow", RECENT),
  // rents and affordability
  field("zori", "Zillow rent index", "usd", "sequential", "Rents and affordability", "zillow", ALL),
  field("gross_rent", "Median gross rent", "usd", "sequential", "Rents and affordability", "acs", YEARS),
  field("rent_burden", "Renters paying 30% or more of income", "pct", "sequential", "Rents and affordability", "acs", YEARS),
  { id: "rent_to_income", label: "Annual rent to household income", format: "pct", kind: "sequential", group: "Rents and affordability", source: "acs", periods: YEARS, dateId: "gross_rent",
    valueAt: (m, p) => { const rent = fieldAt(m, p, "gross_rent"); return divide(rent === null ? null : rent * 12, fieldAt(m, p, "income")); } },
  field("fmr_2br", "Fair market rent, two bedroom", "usd", "sequential", "Rents and affordability", "hud", ALL),
  field("income", "Median household income", "usd", "sequential", "Rents and affordability", "census", YEARS),
  change("income_14_24", "Median income growth, 2014 to 2024", "Rents and affordability", "census"),
  field("median_family_income", "Median family income", "usd", "sequential", "Rents and affordability", "hud", ALL),
  field("bea_income_per_capita", "Per capita personal income", "usd", "sequential", "Rents and affordability", "bea", ALL),
  field("bea_personal_income", "Total personal income", "usd_k", "sequential", "Rents and affordability", "bea", ALL),
  field("bea_population", "Population (BEA)", "int", "sequential", "People and migration", "bea", ALL),
  // people and migration
  field("pop", "Population, ACS", "int", "sequential", "People and migration", "census", YEARS),
  field("pop_estimate", "Population estimate", "int", "sequential", "People and migration", "pep", ALL),
  change("pop_14_24", "Population growth, 2014 to 2024", "People and migration", "census"),
  field("natural_change", "Natural change, births less deaths", "int", "diverging", "People and migration", "pep", ALL),
  field("domestic_migration", "Net domestic migration", "int", "diverging", "People and migration", "pep", ALL),
  field("domestic_migration_rate", "Net domestic migration per 1,000", "per_1000", "diverging", "People and migration", "pep", ALL),
  field("net_migration", "Net migration, all sources", "int", "diverging", "People and migration", "pep", ALL),
  field("irs_net_returns", "IRS net migration, tax returns", "int", "diverging", "People and migration", "irs", ALL),
  field("irs_net_exemptions", "IRS net migration, people", "int", "diverging", "People and migration", "irs", ALL),
  field("irs_inflow_returns", "IRS inflow, tax returns", "int", "sequential", "People and migration", "irs", ALL),
  field("irs_outflow_returns", "IRS outflow, tax returns", "int", "sequential", "People and migration", "irs", ALL),
  field("unemp", "Unemployment rate", "rate", "sequential", "People and migration", "bls", ALL),
  field("labor_force_rate", "Labor force participation", "pct", "sequential", "People and migration", "acs", YEARS),
  field("poverty_rate", "Poverty rate", "pct", "sequential", "People and migration", "acs", YEARS),
  field("commute_minutes", "Mean commute", "minutes", "sequential", "People and migration", "acs", YEARS),
  field("age", "Median age", "index", "sequential", "People and migration", "census", YEARS),
  field("degree_share", "Bachelors or masters, adults 25+", "pct", "sequential", "People and migration", "census", YEARS),
  field("own_rate", "Homeownership rate", "pct", "sequential", "People and migration", "census", YEARS),
  // supply
  field("permits_units", "Housing units permitted", "int", "sequential", "Supply", "bps", ALL),
  // a panel whose permits and people were counted over different counties
  // carries permits_footprint, or permits_unweighed when nobody could weigh
  // the difference, and the rate is withheld there rather than divided
  // across two places
  { id: "permits_per_1000", label: "Units permitted per 1,000 residents", format: "per_1000", kind: "sequential", group: "Supply", source: "bps", periods: ALL, dateId: "permits_units",
    valueAt: (m, p) => { if (!sameGeography(m, ["permits_units", "pop_estimate"]) || permitsMarked(m, p)) return null; const units = fieldAt(m, p, "permits_units"); return divide(units === null ? null : units * 1000, fieldAt(m, p, "pop_estimate")); } },
  field("permits_single_family", "Single family units permitted", "int", "sequential", "Supply", "bps", ALL),
  field("permits_multifamily", "Units in 5+ unit buildings permitted", "int", "sequential", "Supply", "bps", ALL),
  field("vacancy_rate", "Vacant housing units", "pct", "sequential", "Supply", "acs", YEARS),
  // forecasts. the export writes percent at the origin quarter, so these
  // read as rates like the zillow forecast, signed either way
  field("hpi_forecast_4q", "Expected HPI growth, next 4 quarters", "rate", "diverging", "Forecasts", "forecast", ["latest"]),
  field("hpi_forecast_8q", "Expected HPI growth, next 8 quarters", "rate", "diverging", "Forecasts", "forecast", ["latest"]),
  // what the fhfa index did up to the origin. the export works these out and
  // the build files them under the model's folder, but nothing in them is the
  // model's, so they are credited to the index they are read off
  field("hpi_trend_5y", "HPI growth, 5 year annualized", "rate", "diverging", "Forecasts", "fhfa", ["latest"]),
  field("hpi_yoy_latest", "HPI growth, last 4 quarters", "rate", "diverging", "Forecasts", "fhfa", ["latest"]),
  // realized growth minus expected growth is a gap between two rates, so it
  // is in percentage points, the way the accuracy page prints the same field
  field("hpi_surprise_4q", "Surprise, actual minus expected, last 4 quarters", "points", "diverging", "Forecasts", "forecast", ["latest"]),
  // fhfa publishes a standard error beside the expanded index. a thin market
  // has fewer repeat sales, so its index is a looser measurement, and a wide
  // error here is a reason to read the forecast above it loosely. fhfa sets it
  // in hundredths, and one decimal printed the tightest metros as one number
  // and denver as zero
  field("hpi_index_error", "Index standard error", "rate2", "sequential", "Forecasts", "fhfa", ["latest"]),
];

export function defaultPeriod(def: MetricDef): Period | null {
  return def.periods.length ? def.periods[def.periods.length - 1] : null;
}

// the label carries the period so a ranking or legend reads on its own
export function resolveMetric(def: MetricDef, period: Period | null): Metric {
  const p = def.periods.length ? (period && def.periods.includes(period) ? period : defaultPeriod(def)) : null;
  const suffix = p ? `, ${p}` : "";
  return {
    id: p ? `${def.id}_${p}` : def.id,
    def,
    period: p,
    label: def.label + suffix,
    format: def.format,
    kind: def.kind,
    group: def.group,
    source: def.source,
    accessor: (m) => def.valueAt(m, p),
    dateOf: (m) => defDate(def, m, p),
  };
}

// every definition at its default period
export const METRICS: Metric[] = DEFS.map((d) => resolveMetric(d, defaultPeriod(d)));

const LEGACY = /^(.*)_(2014|2019|2024|latest)$/;

// a definition by id, also accepting the resolved form like income_2024
export function defById(id: string): { def: MetricDef; period: Period | null } | null {
  const exact = DEFS.find((d) => d.id === id);
  if (exact) return { def: exact, period: defaultPeriod(exact) };
  const m = LEGACY.exec(id);
  if (m) {
    const def = DEFS.find((d) => d.id === m[1]);
    if (def) return { def, period: m[2] as Period };
  }
  return null;
}

// unknown ids fall back to the first metric so the map always has something to draw
export function metricById(id: string): Metric {
  const hit = defById(id);
  return hit ? resolveMetric(hit.def, hit.period) : METRICS[0];
}

export function labelFor(id: string): string {
  return defById(id)?.def.label ?? id;
}

// definitions with at least one value somewhere, so a source that has not
// been collected yet stays out of the menu. before data loads, everything shows
export function visibleDefs(metros: Metro[]): MetricDef[] {
  if (metros.length === 0) return DEFS;
  return DEFS.filter((def) => {
    const periods: (Period | null)[] = def.periods.length ? def.periods : [null];
    return periods.some((p) => metros.some((m) => def.valueAt(m, p) !== null));
  });
}

// the declared periods that actually carry a value for this data
export function availablePeriods(def: MetricDef, metros: Metro[]): Period[] {
  if (metros.length === 0) return def.periods;
  return def.periods.filter((p) => metros.some((m) => def.valueAt(m, p) !== null));
}

// keep the period when it is available, otherwise the closest one by position,
// preferring the later of two equally close
export function nearestPeriod(wanted: Period | null, available: Period[]): Period | null {
  if (available.length === 0) return null;
  if (wanted && available.includes(wanted)) return wanted;
  const target = wanted ? PERIODS.indexOf(wanted) : PERIODS.length;
  let best = available[0];
  let bestDistance = Infinity;
  for (const p of available) {
    const distance = Math.abs(PERIODS.indexOf(p) - target);
    if (distance < bestDistance || (distance === bestDistance && PERIODS.indexOf(p) > PERIODS.indexOf(best))) {
      best = p;
      bestDistance = distance;
    }
  }
  return best;
}

// "Source: Realtor.com, latest 2026-08". the latest date is the newest any
// metro carries, the year periods name themselves
// hud publishes fair market rents and income limits by fiscal year, so a bare
// year from it is not a calendar year. the rule lives here because both the
// legend caption below and the timeline's date labels have to say the same
// thing about the same number
const FISCAL: Source[] = ["hud"];

export function yearLabel(year: string | number, source?: Source): string {
  return source !== undefined && FISCAL.includes(source) ? `FY ${year}` : String(year);
}


export function metricCaption(metric: Metric, metros: Metro[]): string {
  const source = `Source: ${SOURCE_LABEL[metric.source]}`;
  if (!metric.period) return source;
  if (metric.period !== "latest") return `${source}, ${yearLabel(metric.period, metric.source)}`;
  let newest: string | null = null;
  for (const m of metros) {
    const d = metric.dateOf(m);
    if (d && (!newest || d > newest)) newest = d;
  }
  if (!newest) return `${source}, latest`;
  // a bare year is labelled the way its publisher counts years, so the legend
  // and the detail panel do not call one value two different things
  const when = /^\d{4}$/.test(newest) ? yearLabel(newest, metric.source) : newest;
  return `${source}, latest ${when}`;
}

// what the colour on the map means, in two or three sentences, for the
// sidebar's question mark. it replaces a bare source line and the timeline's
// note about vintage changes, both of which said a fraction of this
export function metricExplainer(metric: Metric): string {
  const source = SOURCE_LABEL[metric.def.source];
  const spanned = metric.def.periods.length === 0;
  // a year off an annual history borrows the level's definition and carries
  // growth into that year. timeline.ts owns the type and imports this module,
  // so the year is read off the metric rather than through isYearMetric
  if (typeof (metric as Metric & { year?: unknown }).year === "number") {
    return `Each metro is colored by its ${metric.label}, the change in its index into the year the timeline is set to. The index comes from ${source}, unadjusted, and a metro with no index that year is drawn hollow.`;
  }
  const what = spanned
    ? `Each metro is colored by its ${metric.def.label}, a change measured between the two shaded vintage years rather than a reading at one date.`
    : `Each metro is colored by its ${metric.def.label} at the period the timeline is set to.`;
  return `${what} The numbers come from ${source}, unadjusted, and a metro with no reading is drawn hollow.${withheldSentence(metric)}`;
}

// a withheld blank is a claim of its own, so the help says what it is and how
// it is drawn, apart from a metro nobody measured
function withheldSentence(metric: Metric): string {
  if (!canBeWithheld(metric)) return "";
  const why = metric.def.id === "permits_per_1000"
    ? "A year whose permits and people were counted over different counties"
    : "A metro whose county lines moved by more than two percent of its people between the two vintages";
  return ` ${why} is withheld instead, drawn hollow with a solid outline and keyed withheld.`;
}
