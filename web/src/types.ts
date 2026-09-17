export type YearKey = "2014" | "2019" | "2024";

// the panels a metric can be read at. latest is the newest period a source
// publishes, which differs by source and is dated per value
export type Period = YearKey | "latest";

// every field the bot's enrichment sources add. each appears as an optional
// number in the year panels and in latest, with a sibling <key>_date in latest
export type EnrichmentKey =
  // census acs extras
  | "gross_rent" | "rent_burden" | "vacancy_rate" | "commute_minutes" | "poverty_rate" | "labor_force_rate"
  // census population estimates
  | "pop_estimate" | "natural_change" | "domestic_migration" | "net_migration" | "domestic_migration_rate"
  // census building permits
  | "permits_units" | "permits_single_family" | "permits_multifamily"
  // irs county migration
  | "irs_net_returns" | "irs_net_exemptions" | "irs_inflow_returns" | "irs_outflow_returns"
  // realtor.com listings
  | "median_listing_price" | "active_listings" | "days_on_market" | "price_reduced_share"
  // zillow extras
  | "inventory" | "days_to_pending" | "price_cut_share" | "zhvf_forecast"
  // bea, once a key is configured
  | "bea_income_per_capita" | "bea_personal_income"
  | "bea_population"
  // hud, once a token is configured
  | "fmr_2br" | "median_family_income"
  // loop model values, written by loop.export, percent at the origin quarter.
  // each expected growth carries its 90 percent band as _lo and _hi
  | "hpi_forecast_4q" | "hpi_forecast_4q_lo" | "hpi_forecast_4q_hi"
  | "hpi_forecast_8q" | "hpi_forecast_8q_lo" | "hpi_forecast_8q_hi"
  | "hpi_yoy_latest" | "hpi_trend_5y" | "hpi_surprise_4q"
  // fhfa's own standard error for the index, as a percent of it. it rides in
  // the model's file because nothing else carries it, but it is fhfa's number
  | "hpi_index_error";

export type EnrichmentValues = { [K in EnrichmentKey]?: number | null };
export type EnrichmentDates = { [K in EnrichmentKey as `${K}_date`]?: string | null };

export interface YearValues extends EnrichmentValues {
  hpi: number | null;
  income: number | null;
  pop: number | null;
  age: number | null;
  degree_share: number | null;
  own_rate: number | null;
  home_value: number | null;
  zhvi: number | null;
  zori: number | null;
  unemp: number | null;
}

export interface Latest extends EnrichmentValues, EnrichmentDates {
  zhvi: number | null;
  zhvi_date: string | null;
  zori: number | null;
  zori_date: string | null;
  unemp: number | null;
  unemp_date: string | null;
}

export interface Growth {
  hpi_14_19: number | null;
  hpi_19_24: number | null;
  income_14_24: number | null;
  pop_14_24: number | null;
  home_value_14_24: number | null;
}

export interface ParentMetro {
  cbsa: string;
  name: string;
}

// an annual history from the bot: one value per calendar year from start,
// the last a partial year through as_of, null where a year is missing.
// anchor is the index level at as_of itself, the base the model's forecast
// percents were measured from. absent from builds older than the field
export interface AnnualSeries {
  start: number;
  values: (number | null)[];
  as_of: string;
  anchor?: number | null;
  // the newest year when it holds fewer than four quarters. its value is the
  // index at as_of, not an annual mean
  partial_year?: number | null;
}

export interface MetroSeries {
  hpi?: AnnualSeries | null;
}

export interface Metro {
  cbsa: string;
  name: string;
  // metropolitan divisions are the pieces fhfa publishes for the largest metros
  level?: "msa" | "division";
  parent?: ParentMetro | null;
  // zillow publishes metros only, so a division carries its parent's values
  zillow_scope?: "metro" | "parent metro" | null;
  // enrichment metrics a division took from its parent metro
  parent_metrics?: string[];
  // set when the decade rates are reported over a footprint that moved, as the
  // share of the metro's people that changed hands between the two vintages
  footprint_moved?: number;
  lat: number;
  lon: number;
  years: Record<YearKey, YearValues>;
  latest: Latest;
  growth: Growth;
  ptir: Record<YearKey, number | null>;
  // annual histories, absent from builds of metros.json older than the field
  series?: MetroSeries | null;
}

export interface MortgageRate {
  "2014": number;
  "2019": number;
  "2024": number;
  latest: number;
  latest_date: string;
}

// one month of a national indicator, dated "YYYY-MM"
export interface IndicatorPoint {
  date: string;
  value: number;
}

export type IndicatorGroup = "Prices" | "Rates" | "Consumers";

// the units a national indicator arrives in. every value is already in
// display units, so 2.9 means 2.9 percent
export type IndicatorFormat = "pct" | "rate" | "index";

// one national figure with its monthly history, for the header strip
export interface Indicator {
  id: string;
  label: string;
  group: IndicatorGroup;
  format: IndicatorFormat;
  provider: string;
  note: string;
  value: number;
  date: string;
  change_12m: number | null;
  history: IndicatorPoint[];
}

// the national block. a build made before the indicators were collected
// carries the mortgage rate alone, so both fields are optional
export interface National {
  mortgage_rate: MortgageRate | null;
  indicators_updated?: string;
  indicators?: Indicator[];
}

// one row per source folder the bot found, built from that folder's download
// manifest. files and row_count cover the whole folder, sha256 belongs to the
// one file filename names
export interface Provenance {
  source: string;
  provider: string;
  url: string;
  version: string;
  downloaded_at: string;
  files: number;
  row_count: number;
  filename: string;
  sha256: string;
}

// one version string per source folder the bot found, keyed by folder name
export interface Sources {
  gazetteer: string;
  zillow: string | null;
  bls: string | null;
  fred: string | null;
  [source: string]: string | null;
}

export interface MapData {
  generated_at: string;
  years: number[];
  sources: Sources;
  // absent from builds made before the block was added
  provenance?: Provenance[];
  national: National;
  metros: Metro[];
}
