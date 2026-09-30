// puts the model page's build inputs in place: the figures the ml folder
// renders, and the numbers every sentence about them reads. both live under
// ml/results, which the deployed site cannot reach, so the figures are copied
// into public/ and the numbers are compiled into a tracked module.
//
// the numbers are generated rather than typed in because a retrain rewrites
// those csvs, and a page quoting them by hand would go on publishing the old
// ones with nobody the wiser. the figures are copied rather than committed
// twice because they are 2.1 MB that git already carries once.
//
//   node scripts/model-assets.mjs      runs as prebuild, before tsc and vite
//
// --results, --module and --figures point the three paths somewhere else, so
// a check can read a copy of ml/results and write into scratch
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const WEB = new URL("../", import.meta.url);
const REPO = new URL("../", WEB);
const ML = new URL("../ml/results/", WEB);
const OUT_FIGURES = new URL("public/figures/", WEB);
const OUT_MODULE = new URL("src/lib/modelNumbers.ts", WEB);

// the backtest files that carry a test block. one row per model, horizon and
// block; everything else in ml/results/backtest is margins or epoch history
export const BACKTEST_FILES = ["baselines.csv", "seqgru.csv", "windowmlp.csv"];

// the two networks' epoch histories, which the training figure draws
export const HISTORY_FILES = { windowmlp: "windowmlp_history.csv", seqgru: "seqgru_history.csv" };

// the shipped forecast, which the fans and the distribution figures draw
export const FORECASTS = "forecast/forecasts.csv";

// what the panel builder published about the panel and the model's inputs
export const MANIFEST = "panel_manifest.json";

// the shipped network against every other scored model, a paired test per
// horizon, which says whether a gap on the table is more than luck
export const PAIRED = "backtest/paired.csv";

// the admission run, ml/admit.py's validation loss by arm and seed, which
// decided the inputs the fitting block could not see
export const ADMISSION = ["admission.csv", "admission_pairs.csv"];

// the model the map draws, whose raw band the calibration figure plots
const SHIPPED = "seqgru";

// the metros the fans figure's alt text names, the first two it draws
export const FAN_METROS = ["16984", "12420"];

// the seven figures the page shows. the other six in ml/results/figures are
// panel description or a baseline-only view of a chart that is already here,
// and copying them would ship megabytes nothing on the page asks for
export const FIGURES = [
  "01_coverage.png",
  "05_backtest_design.png",
  "09_training_curves.png",
  "10_quantile_calibration.png",
  "11_forecast_fans.png",
  "12_model_comparison.png",
  "13_forecast_distribution.png",
];

// every file the module is generated from. with ml/results present, a missing
// one fails the build by name: a page generated from part of them publishes a
// smaller leaderboard, or an older forecast, as if it were the whole story
export const REQUIRED = [
  ...BACKTEST_FILES.map((name) => `backtest/${name}`),
  ...Object.values(HISTORY_FILES).map((name) => `backtest/${name}`),
  PAIRED,
  ...ADMISSION,
  FORECASTS,
  MANIFEST,
];

// the columns the page reads. the csvs carry pinball losses and raw coverage
// too, which belong to the ml folder's own write-up rather than to this page
const KEEP = { mae_pct: "maePct", coverage: "coverage", width: "width" };

// these files are written by one pandas to_csv with plain numeric columns, so
// a split on commas is the whole parser. a quoted field would mean the schema
// changed, and that is a build failure worth having
export function parseBacktest(text) {
  const lines = String(text).trim().split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length < 2) return [];
  const head = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    const row = {};
    head.forEach((name, i) => { row[name] = cells[i]; });
    return row;
  });
}

// one published row per model and horizon: the test block, which is scored
// once and is the only block this page quotes
export function testRows(text) {
  const out = [];
  for (const row of parseBacktest(text)) {
    if (row.block !== "test") continue;
    const cell = { model: row.model, horizon: cellNumber(row.horizon), n: cellNumber(row.n) };
    for (const [csv, key] of Object.entries(KEEP)) cell[key] = kept(cellNumber(row[csv]));
    if (!row.model || !Number.isFinite(cell.horizon)) continue;
    out.push(cell);
  }
  return out;
}

// pandas writes a nan as an empty field, and Number("") is 0, so a blank cell
// is a metric the backtest could not score rather than a published zero
function cellNumber(cell) {
  const text = String(cell ?? "").trim();
  return text === "" ? Number.NaN : Number(text);
}

// the csv's own value, so the page rounds it once, at the precision it
// prints. rounded to four places here first, 0.9049878 became 0.905 and then
// printed as 0.91 where the csv says 0.90
function kept(value) {
  return Number.isFinite(value) ? value : null;
}

export function leaderboard(texts) {
  const rows = texts.flatMap(testRows);
  return rows.sort((a, b) => a.model.localeCompare(b.model) || a.horizon - b.horizon);
}

// how many series a model reads, out of the panel manifest the builder wrote.
// the page says this in prose, and prose that is typed goes stale: it claimed
// ten series for two commits after the input set was cut to eleven columns
export function readInputs(text) {
  const manifest = JSON.parse(String(text));
  const seq = manifest?.features?.sequence;
  const annual = manifest?.features?.annual;
  if (!Array.isArray(seq) || !Array.isArray(annual)) return null;
  return { sequence: seq.length, annual: annual.length, context: (manifest.context ?? []).length };
}

// the panel's size and span, which the page used to carry in type
export function readPanel(text) {
  const manifest = JSON.parse(String(text));
  const rows = Number(manifest?.rows);
  const metros = Number(manifest?.metros);
  const first = String(manifest?.first_quarter ?? "");
  const last = String(manifest?.last_quarter ?? "");
  if (!Number.isFinite(rows) || !Number.isFinite(metros) || !/^\d{4}Q[1-4]$/.test(first) || !/^\d{4}Q[1-4]$/.test(last)) return null;
  return { rows, metros, first, last };
}

// the shipped model's raw 10 to 90 band on the test block, before the
// conformal margin. the calibration figure plots the raw quantiles, so this is
// the number that says how far its lines sit off the diagonal
export function rawBand(text, model = SHIPPED) {
  return parseBacktest(text)
    .filter((row) => row.block === "test" && row.model === model)
    .map((row) => ({ horizon: cellNumber(row.horizon), coverage: kept(cellNumber(row.coverage_raw)) }))
    .filter((row) => Number.isFinite(row.horizon))
    .sort((a, b) => a.horizon - b.horizon);
}

// how many calibration samples the shipped model's band was set on, when
// every horizon has the same number, which is what a horizon independent
// block rule gives. null when they differ, so the page does not claim it
export function calibrationSize(text, model = SHIPPED) {
  const sizes = parseBacktest(text)
    .filter((row) => row.block === "cal" && row.model === model)
    .map((row) => cellNumber(row.n));
  return sizes.length > 0 && sizes.every((n) => Number.isFinite(n) && n === sizes[0]) ? sizes[0] : null;
}

// the paired test, one row per rival and horizon, sorted so a rebuild does
// not churn the file. a p value the test could not compute is a blank, and
// stays missing rather than reading as a zero that passes every test
export function pairedRows(text, model = SHIPPED) {
  return parseBacktest(text)
    .filter((row) => row.model === model && row.against)
    .map((row) => ({
      against: row.against,
      horizon: cellNumber(row.horizon),
      origins: cellNumber(row.origins),
      difference: kept(cellNumber(row.difference)),
      pValue: kept(cellNumber(row.p_value)),
    }))
    .filter((row) => Number.isFinite(row.horizon))
    .sort((a, b) => a.against.localeCompare(b.against) || a.horizon - b.horizon);
}

// ml/admit.py names its arms in words with commas in them, so its csvs quote
// that field. a quote opens and closes a field and a doubled one is a quote,
// which is all pandas writes
export function parseQuoted(text) {
  const lines = String(text).trim().split(/\r?\n/).filter((line) => line.length > 0);
  const split = (line) => {
    const cells = [];
    let cell = "";
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const c = line[i];
      if (quoted && c === "\"" && line[i + 1] === "\"") { cell += "\""; i += 1; }
      else if (c === "\"") quoted = !quoted;
      else if (c === "," && !quoted) { cells.push(cell); cell = ""; }
      else cell += c;
    }
    cells.push(cell);
    return cells;
  };
  if (lines.length < 2) return [];
  const head = split(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = split(line);
    const row = {};
    head.forEach((name, i) => { row[name] = cells[i]; });
    return row;
  });
}

// one row per arm and seed: the validation loss that seed reached
export function admissionRows(text) {
  return parseQuoted(text)
    .map((row) => ({ arm: String(row.arm ?? ""), seed: cellNumber(row.seed), loss: kept(cellNumber(row["validation loss"])) }))
    .filter((row) => row.arm.length > 0 && Number.isFinite(row.seed));
}

// what a training history shows: the epoch validation loss was lowest, which
// is where training stopped and what the figure marks, the last epoch run,
// the epoch from which validation stays within one percent of that low for
// good, and whether the fitting loss kept falling after the low
export function trainingFacts(model, text) {
  const rows = parseBacktest(text)
    .map((row) => ({ epoch: cellNumber(row.epoch), train: cellNumber(row.train_loss), val: cellNumber(row.val_loss) }))
    .filter((row) => Number.isFinite(row.epoch) && Number.isFinite(row.train) && Number.isFinite(row.val))
    .sort((a, b) => a.epoch - b.epoch);
  if (rows.length === 0) return null;
  const best = rows.reduce((a, b) => (b.val < a.val ? b : a));
  const last = rows[rows.length - 1];
  let flat = null;
  for (let i = rows.length - 1; i >= 0 && rows[i].val <= best.val * 1.01; i -= 1) flat = rows[i];
  return { model, stop: best.epoch, last: last.epoch, flatFrom: flat ? flat.epoch : null, trainFalls: last.train < best.train };
}

// linear interpolation between the two nearest ranks, the convention numpy's
// percentile and the page's own quantile use
function quantile(sorted, p) {
  if (sorted.length === 0) return Number.NaN;
  const at = (sorted.length - 1) * Math.min(Math.max(p, 0), 1);
  const low = Math.floor(at);
  const high = Math.ceil(at);
  return low === high ? sorted[low] : sorted[low] + (sorted[high] - sorted[low]) * (at - low);
}

// the tallest bar of a thirty bin histogram, binned the way numpy bins it:
// equal widths from the lowest value to the highest, the last bin closed
function tallestBin(sorted, bins = 30) {
  const lo = sorted[0];
  const hi = sorted[sorted.length - 1];
  const width = (hi - lo) / bins;
  if (!(width > 0)) return { from: lo, to: hi, count: sorted.length };
  const counts = new Array(bins).fill(0);
  for (const value of sorted) counts[Math.min(bins - 1, Math.floor((value - lo) / width))] += 1;
  let top = 0;
  for (let i = 1; i < bins; i += 1) if (counts[i] > counts[top]) top = i;
  return { from: lo + top * width, to: lo + (top + 1) * width, count: counts[top] };
}

// "2026Q2" moved on by a count of quarters
function shiftQuarter(quarter, count) {
  const match = /^(\d{4})Q([1-4])$/.exec(quarter);
  if (!match) return null;
  const slot = Number(match[1]) * 4 + Number(match[2]) - 1 + count;
  return `${Math.floor(slot / 4)}Q${(slot % 4) + 1}`;
}

// the shipped forecast as the fans and the distribution figures draw it: the
// median four quarter call across every metro, and the far band of the
// metros the fans alt text names. values stay as the csv wrote them, so a
// sentence rounds them the way anybody checking the csv would
export function forecastFacts(text, fans = FAN_METROS) {
  const rows = parseBacktest(text);
  const horizons = [...new Set(rows.map((row) => cellNumber(row.horizon)).filter(Number.isFinite))].sort((a, b) => a - b);
  const near = rows.filter((row) => cellNumber(row.horizon) === 4).map((row) => cellNumber(row.q50_pct)).filter(Number.isFinite);
  if (near.length === 0 || horizons.length === 0) return null;
  const sorted = [...near].sort((a, b) => a - b);
  const far = horizons[horizons.length - 1];
  const origin = rows.map((row) => String(row.origin ?? "")).filter((q) => /^\d{4}Q[1-4]$/.test(q)).sort().pop() ?? null;
  return {
    origin,
    end: origin ? shiftQuarter(origin, far) : null,
    far,
    count: sorted.length,
    p10: quantile(sorted, 0.1),
    median: quantile(sorted, 0.5),
    p90: quantile(sorted, 0.9),
    lowest: sorted[0],
    highest: sorted[sorted.length - 1],
    falling: sorted.filter((value) => value < 0).length,
    peak: tallestBin(sorted),
    fans: fans.flatMap((cbsa) => {
      const row = rows.find((r) => r.cbsa_code === cbsa && cellNumber(r.horizon) === far);
      if (!row) return [];
      const [median, lo, hi] = [row.q50_pct, row.lo_pct, row.hi_pct].map(cellNumber);
      return [median, lo, hi].every(Number.isFinite) ? [{ cbsa, median, lo, hi }] : [];
    }),
  };
}

// the coverage figure is drawn from ml/data/panel.parquet, which is not
// tracked, so loop.panel writes what the figure shows into panel_manifest.json,
// which is. the page reads it from there, in ci as much as on this machine
export function measureCoverage(results = ML) {
  const path = new URL("panel_manifest.json", results);
  if (!existsSync(path)) return null;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  return manifest?.coverage ? readCoverage(JSON.stringify(manifest.coverage)) : null;
}

// the answer, checked for the shape the page reads
export function readCoverage(text) {
  let value;
  try {
    value = JSON.parse(String(text));
  } catch {
    return null;
  }
  const series = Array.isArray(value?.series) ? value.series : null;
  if (!series || typeof value.fitEnd !== "string" || !Number.isFinite(value.first) || !Number.isFinite(value.last)) return null;
  return {
    fitEnd: value.fitEnd,
    first: value.first,
    last: value.last,
    series: series.map((s) => ({ label: String(s.label), first: Number.isFinite(s.first) ? s.first : null, emptyBeforeFit: s.emptyBeforeFit === true })),
    features: Number.isFinite(value.features) ? value.features : null,
    unseen: Array.isArray(value.unseen) ? value.unseen.map(String) : [],
  };
}

// the coverage line a module already carries, for a build that cannot measure
const COVERAGE_LINE = /^export const PANEL_COVERAGE: PanelCoverage \| null = (.*);$/m;

export function carriedCoverage(moduleText) {
  const match = COVERAGE_LINE.exec(String(moduleText ?? ""));
  return match ? readCoverage(match[1]) : null;
}

// a number in the module: the csv's value, or NaN for a cell the backtest could
// not score. NaN is still a number to the type checker, so a blank cell cannot
// break the build, and every reader leaves a non finite value out
const literal = (value) => (typeof value === "number" && Number.isFinite(value) ? String(value) : "NaN");

export function renderModule(rows, inputs, extras = {}) {
  const body = rows
    .map((r) => `  { model: "${r.model}", horizon: ${literal(r.horizon)}, maePct: ${literal(r.maePct)}, `
      + `coverage: ${literal(r.coverage)}, width: ${literal(r.width)}, n: ${literal(r.n)} },`)
    .join("\n");
  const { raw, training, forecast, panel, coverage, calibration, paired, admission } = extras;
  const types = ["BacktestRow"];
  if (raw) types.push("RawBand");
  if (training) types.push("TrainingFacts");
  if (forecast) types.push("ForecastFacts");
  if (panel) types.push("PanelFacts");
  if (coverage !== undefined) types.push("PanelCoverage");
  if (paired) types.push("PairedRow");
  if (admission) types.push("AdmissionRow");
  return [
    "// generated by scripts/model-assets.mjs from ml/results/backtest. do not",
    "// edit by hand: npm run build rewrites it from the csvs the backtest wrote,",
    "// so a retrain that changes the numbers changes this file in the same commit.",
    `import type { ${types.join(", ")} } from "./model";`,
    "",
    "// the test block only, outcomes realized 2022Q1 or later, scored once",
    "export const BACKTEST: BacktestRow[] = [",
    body,
    "];",
    ...(inputs
      ? [
          "",
          "// what the shipped model reads: a sequence over the window, a value at the",
          "// origin, and the columns the panel carries that no model touches",
          "export const INPUTS = "
            + `{ sequence: ${inputs.sequence}, annual: ${inputs.annual}, context: ${inputs.context} };`,
        ]
      : []),
    ...(raw
      ? [
          "",
          "// the shipped model's raw 10 to 90 band on the test block, before the margin",
          "export const RAW_BAND: RawBand[] = [",
          ...raw.map((r) => `  { horizon: ${literal(r.horizon)}, coverage: ${literal(r.coverage)} },`),
          "];",
        ]
      : []),
    ...(training
      ? [
          "",
          "// the two networks' training histories: where validation loss was lowest",
          "export const TRAINING: TrainingFacts[] = [",
          ...training.map((t) => `  { model: "${t.model}", stop: ${t.stop}, last: ${t.last}, flatFrom: ${t.flatFrom}, trainFalls: ${t.trainFalls} },`),
          "];",
        ]
      : []),
    ...(forecast
      ? [
          "",
          "// the shipped forecast as ml/results/forecast/forecasts.csv has it",
          `export const FORECAST: ForecastFacts = ${JSON.stringify(forecast)};`,
        ]
      : []),
    ...(panel
      ? [
          "",
          "// the panel the model is fitted on, from ml/results/panel_manifest.json",
          `export const PANEL: PanelFacts = ${JSON.stringify(panel)};`,
        ]
      : []),
    ...(calibration !== undefined
      ? [
          "",
          "// the calibration samples the shipped model's band was set on, at every horizon",
          `export const CALIBRATION_N: number | null = ${calibration === null ? "null" : literal(calibration)};`,
        ]
      : []),
    ...(paired
      ? [
          "",
          "// the shipped model against every other scored model, a paired test per",
          "// horizon over the test block's origins. difference is the shipped model's",
          "// mean error less the other's, in points, so a negative one has it closer",
          "export const PAIRED: PairedRow[] = [",
          ...paired.map((r) => `  { against: ${JSON.stringify(r.against)}, horizon: ${literal(r.horizon)}, origins: ${literal(r.origins)}, `
            + `difference: ${literal(r.difference)}, pValue: ${literal(r.pValue)} },`),
          "];",
        ]
      : []),
    ...(admission
      ? [
          "",
          "// the admission run's validation loss by arm and seed, as ml/admit.py wrote it",
          "export const ADMISSION: AdmissionRow[] = [",
          ...admission.map((r) => `  { arm: ${JSON.stringify(r.arm)}, seed: ${literal(r.seed)}, loss: ${literal(r.loss)} },`),
          "];",
        ]
      : []),
    ...(coverage !== undefined
      ? [
          "",
          "// what the coverage figure shows, as loop.panel wrote it into",
          "// ml/results/panel_manifest.json",
          `export const PANEL_COVERAGE: PanelCoverage | null = ${JSON.stringify(coverage)};`,
        ]
      : []),
    "",
  ].join("\n");
}

// width and height out of a png IHDR, so the page can declare the size a
// figure really is instead of a number somebody remembered
export function pngSize(buffer) {
  if (buffer.length < 24 || buffer.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function copyFigures(results, outFigures) {
  mkdirSync(fileURLToPath(outFigures), { recursive: true });
  let copied = 0;
  const missing = [];
  for (const name of FIGURES) {
    const from = new URL(`figures/${name}`, results);
    if (!existsSync(from)) { missing.push(name); continue; }
    copyFileSync(from, new URL(name, outFigures));
    copied += 1;
  }
  return { copied, missing };
}

// the files the module needs that are not there, named from the repo root
export function missingInputs(results) {
  return REQUIRED.filter((name) => !existsSync(new URL(name, results)));
}

export function writeNumbers(results = ML, outModule = OUT_MODULE, repo = REPO) {
  const missing = missingInputs(results);
  if (missing.length > 0) {
    throw new Error(`[model-assets] ml/results is here but ${missing.map((name) => `ml/results/${name}`).join(", ")} `
      + `${missing.length === 1 ? "is" : "are"} not, so modelNumbers.ts would be written without ${missing.length === 1 ? "it" : "them"}. `
      + "run the ml step that writes it, or restore it from git, and build again");
  }
  const read = (name) => readFileSync(new URL(name, results), "utf8");
  const texts = BACKTEST_FILES.map((name) => read(`backtest/${name}`));
  const rows = leaderboard(texts);
  const models = new Set(rows.map((row) => row.model));
  if (!models.has(SHIPPED)) {
    throw new Error(`[model-assets] ml/results/backtest/seqgru.csv has no test rows for ${SHIPPED}, the model the map draws`);
  }
  const manifest = read(MANIFEST);
  const inputs = readInputs(manifest);
  const panel = readPanel(manifest);
  if (!inputs || !panel) throw new Error(`[model-assets] ml/results/${MANIFEST} does not carry the features, rows and quarters the page reads`);
  const forecast = forecastFacts(read(FORECASTS));
  if (!forecast) throw new Error(`[model-assets] ml/results/${FORECASTS} has no four quarter forecasts to describe`);
  const training = Object.entries(HISTORY_FILES).map(([model, name]) => trainingFacts(model, read(`backtest/${name}`)));
  if (training.some((t) => t === null)) throw new Error("[model-assets] a training history under ml/results/backtest has no epochs in it");
  const raw = rawBand(read("backtest/seqgru.csv"));
  const calibration = calibrationSize(read("backtest/seqgru.csv"));
  const paired = pairedRows(read(PAIRED));
  const admission = ADMISSION.flatMap((name) => admissionRows(read(name)));
  const current = existsSync(outModule) ? readFileSync(outModule, "utf8") : "";
  const measured = measureCoverage(results);
  const coverage = measured ?? carriedCoverage(current);
  const next = renderModule(rows, inputs, { raw, training, forecast, panel, coverage, calibration, paired, admission });
  // only touching the file when the numbers moved keeps the dev server from
  // reloading on every build
  if (next !== current) writeFileSync(outModule, next);
  return { rows: rows.length, changed: next !== current, coverage: measured ? "measured" : coverage ? "carried over" : "unknown" };
}

// "--results ../scratch/results" and friends, each a folder or file path
function option(args, name) {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? pathToFileURL(args[at + 1]) : null;
}

function asFolder(url) {
  return url.href.endsWith("/") ? url : new URL(`${url.href}/`);
}

function main(args = process.argv.slice(2)) {
  const results = option(args, "results") ? asFolder(option(args, "results")) : ML;
  const outModule = option(args, "module") ?? OUT_MODULE;
  const outFigures = option(args, "figures") ? asFolder(option(args, "figures")) : OUT_FIGURES;
  if (!existsSync(results)) {
    // the page degrades to captions without figures rather than failing a
    // build on a checkout that has no ml folder
    console.warn("[model-assets] no ml/results here, leaving the page's figures and numbers as they are");
    return;
  }
  const figures = copyFigures(results, outFigures);
  const numbers = writeNumbers(results, outModule);
  console.log(`[model-assets] ${figures.copied} figures copied, `
    + `${numbers.rows} backtest rows ${numbers.changed ? "rewritten" : "unchanged"}, panel coverage ${numbers.coverage}`);
  if (figures.missing.length > 0) {
    console.warn(`[model-assets] not rendered yet, the page will skip them: ${figures.missing.join(", ")}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
