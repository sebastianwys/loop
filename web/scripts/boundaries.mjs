// downloads the census cartographic boundary shapefiles for core based
// statistical areas and metropolitan divisions, simplifies them with mapshaper
// and writes one topojson the map fetches the first time shapes are asked for.
// from web/:  npm install --no-save mapshaper@0.7 && npm run boundaries
// mapshaper runs only here and pulls a 150 mb dependency tree, so it is not a
// dependency of the app and is loaded only when this script runs
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const YEAR = 2024;
// 35% keeps the coastlines readable at street level and lands under 1 mb
const SIMPLIFY = "35%";
const BASE = `https://www2.census.gov/geo/tiger/GENZ${YEAR}/shp`;
const USER_AGENT = "loop-bot/0.1 (+https://github.com/sebwys/loop)";

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RAW = path.resolve(WEB, "..", "data", "raw", "boundaries");
const OUT = path.join(WEB, "public", "data", "boundaries.json");

const FILES = {
  cbsa: { file: `cb_${YEAR}_us_cbsa_500k.zip`, dataset: "core based statistical areas, cartographic boundaries, 1:500,000" },
  metdiv: { file: `cb_${YEAR}_us_metdiv_500k.zip`, dataset: "metropolitan divisions, cartographic boundaries, 1:500,000" },
};

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
const kb = (bytes) => Math.round((bytes / 1024) * 10) / 10;

async function download(name) {
  const url = `${BASE}/${name}`;
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(path.join(RAW, name), buffer);
  console.log(`[boundaries] ${name}: ${kb(buffer.length)} KB`);
  return buffer;
}

async function loadMapshaper() {
  try {
    return (await import("mapshaper")).default;
  } catch {
    throw new Error("mapshaper is not installed. run: npm install --no-save mapshaper@0.7");
  }
}

async function main() {
  const mapshaper = await loadMapshaper();
  await mkdir(RAW, { recursive: true });
  await mkdir(path.dirname(OUT), { recursive: true });

  const zips = {};
  for (const [key, { file }] of Object.entries(FILES)) {
    zips[key] = await download(file);
  }

  // micropolitan areas (LSAD M2) are never in the study, so only M1 is kept.
  // a division's GEOID is the parent cbsa code followed by the division code.
  // the last five digits are what the study keys on
  const commands = [
    `-i ${path.join(RAW, FILES.cbsa.file)} ${path.join(RAW, FILES.metdiv.file)} combine-files`,
    "-rename-layers cbsa,metdiv",
    `-filter 'LSAD=="M1"' target=cbsa`,
    "-each 'GEOID=GEOID.slice(-5)' target=metdiv",
    "-filter-fields GEOID,NAME target=*",
    "-each 'NAME=NAME.normalize(\"NFD\").replace(/[\\u0300-\\u036f]/g, \"\")' target=*",
    `-simplify ${SIMPLIFY} keep-shapes target=*`,
    `-o ${OUT} format=topojson target=*`,
  ].join(" ");
  await mapshaper.runCommands(commands);

  const topojson = await readFile(OUT);
  const topology = JSON.parse(topojson.toString("utf8"));
  const counts = {
    cbsa: topology.objects.cbsa.geometries.length,
    metdiv: topology.objects.metdiv.geometries.length,
  };
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const version = `${YEAR} cartographic boundary files, 1:500,000`;

  const entry = (filename, buffer, source, rowCount, notes) => ({
    filename,
    file_format: path.extname(filename).slice(1).toUpperCase(),
    source,
    integrity: { sha256: sha256(buffer), size_kb: kb(buffer.length), row_count: rowCount },
    version,
    downloaded_at: now,
    notes,
  });
  const census = (dataset, file) => ({
    endpoint: `${BASE}/${file}`,
    provider: "U.S. Census Bureau",
    access_method: "Direct HTTP download",
    dataset,
  });

  const manifest = [
    entry(FILES.cbsa.file, zips.cbsa, census(FILES.cbsa.dataset, FILES.cbsa.file), counts.cbsa,
      `${counts.cbsa} metropolitan areas kept, micropolitan areas dropped. the zip is not committed`),
    entry(FILES.metdiv.file, zips.metdiv, census(FILES.metdiv.dataset, FILES.metdiv.file), counts.metdiv,
      "GEOID reduced to the five digit division code. the zip is not committed"),
    entry("boundaries.json", topojson, {
      endpoint: "derived from the two files above by web/scripts/boundaries.mjs",
      provider: "this repository",
      access_method: "npm run boundaries",
      dataset: `topojson with objects cbsa and metdiv, GEOID and NAME only, ${SIMPLIFY} simplification with keep-shapes`,
    }, counts.cbsa + counts.metdiv, "lives at web/public/data/boundaries.json and is committed"),
  ];
  await writeFile(path.join(RAW, "download_manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  console.log(`[boundaries] ${counts.cbsa} metros and ${counts.metdiv} divisions at ${SIMPLIFY} -> boundaries.json (${kb(topojson.length)} KB)`);
}

main().catch((error) => {
  console.error(`[boundaries] FAILED ${error.message}`);
  process.exit(1);
});
