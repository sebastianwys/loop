// device probe. loads the map at a table of real viewport sizes and reports
// what the layout does there: overflow, panels another layer punches through,
// tap targets too small to hit, and inputs small enough that ios zooms the
// page on focus. writes a json report and a screenshot per profile.
//
// playwright is not a dependency of this package, since installing it pulls
// several hundred MB of browsers that nobody cloning the map needs. point
// PLAYWRIGHT_PATH at an existing install, or run it where playwright resolves.
//
//   npm run probe
//   PROBE_URL=https://loop.macroviz.workers.dev/ npm run probe
//   PROBE_ENGINE=webkit npm run probe        safari's engine, catches ios only bugs
//   PROBE_SCHEME=dark npm run probe
//   PROBE_ONLY=iphone-15-pro,win-1080-150 npm run probe

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const URL_ = process.env.PROBE_URL || "http://localhost:4173/";
const ENGINE = process.env.PROBE_ENGINE || "chromium";
const SCHEME = process.env.PROBE_SCHEME || "light";
const ONLY = (process.env.PROBE_ONLY || "").split(",").map((s) => s.trim()).filter(Boolean);
const OUT = process.env.PROBE_OUT || resolve(HERE, "..", ".probe");

// windows reports css pixels after display scaling, so a 1920x1080 panel at
// 150% is a 1280 viewport. those are the sizes that actually break, not the
// panel's pixel count. chrome heights subtract the browser's own chrome.
const PROFILES = [
  { id: "mac-16", name: "MacBook Pro 16in", w: 1728, h: 1117, dpr: 2, chrome: 88 },
  { id: "mac-14", name: "MacBook Pro 14in", w: 1512, h: 982, dpr: 2, chrome: 88 },
  { id: "mac-air-13", name: "MacBook Air 13in", w: 1470, h: 956, dpr: 2, chrome: 88 },
  { id: "mac-studio", name: "Studio Display 27in", w: 2560, h: 1440, dpr: 2, chrome: 88 },
  { id: "win-1080-100", name: "Win 1920x1080 at 100%", w: 1920, h: 1080, dpr: 1, chrome: 75 },
  { id: "win-1080-125", name: "Win 1920x1080 at 125%", w: 1536, h: 864, dpr: 1.25, chrome: 87 },
  { id: "win-1080-150", name: "Win 1920x1080 at 150%", w: 1280, h: 720, dpr: 1.5, chrome: 87 },
  { id: "win-1366", name: "Win 1366x768 at 100%", w: 1366, h: 768, dpr: 1, chrome: 75 },
  { id: "win-surface", name: "Surface 2256x1504 at 200%", w: 1128, h: 752, dpr: 2, chrome: 87 },
  { id: "win-4k-150", name: "Win 3840x2160 at 150%", w: 2560, h: 1440, dpr: 1.5, chrome: 87 },
  { id: "ipad-land", name: "iPad Air landscape", w: 1180, h: 820, dpr: 2, chrome: 0, touch: true },
  { id: "ipad-port", name: "iPad Air portrait", w: 820, h: 1180, dpr: 2, chrome: 0, touch: true },
  { id: "ipad-mini", name: "iPad mini portrait", w: 744, h: 1133, dpr: 2, chrome: 0, touch: true },
  { id: "iphone-15-pro", name: "iPhone 15 Pro", w: 393, h: 852, dpr: 3, chrome: 0, touch: true },
  { id: "iphone-se", name: "iPhone SE", w: 375, h: 667, dpr: 2, chrome: 0, touch: true },
  { id: "pixel-8", name: "Pixel 8", w: 412, h: 915, dpr: 2.625, chrome: 0, touch: true },
  { id: "galaxy-s-land", name: "Galaxy S landscape", w: 915, h: 412, dpr: 2.625, chrome: 0, touch: true },
];

// runs in the page
function measure() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const de = document.documentElement;

  const box = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none") return { hidden: true };
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };

  // a tile inside a sideways scroller is meant to sit past the edge, so only
  // elements with no scrolling ancestor count as a real bleed
  const inScroller = (el) => {
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
      const ov = getComputedStyle(n).overflowX;
      if (ov === "auto" || ov === "scroll" || ov === "hidden") return true;
    }
    return false;
  };
  const bleed = [];
  for (const el of document.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (r.right <= vw + 1.5 && r.left >= -1.5) continue;
    const ov = getComputedStyle(el).overflowX;
    if (ov === "auto" || ov === "scroll" || ov === "hidden" || inScroller(el)) continue;
    bleed.push(`${el.tagName}.${(el.className?.baseVal ?? el.className ?? "").toString().slice(0, 24)}`);
  }

  const coarse = window.matchMedia("(pointer: coarse)").matches;
  const small = [];
  const zoomy = [];
  if (coarse) {
    for (const el of document.querySelectorAll("button, select, input, summary")) {
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      // leaflet's attribution links are tiny by design and must stay legible,
      // not tappable. forcing them to 44px breaks the bar
      if (el.closest(".leaflet-control-attribution")) continue;
      if (r.height < 30) small.push(`${(el.className || el.tagName).toString().slice(0, 22)}:${Math.round(r.height)}`);
    }
    for (const el of document.querySelectorAll("input, select, textarea")) {
      const fs = parseFloat(getComputedStyle(el).fontSize);
      if (fs < 16) zoomy.push(`${el.id || el.tagName}:${fs}`);
    }
  }

  // a panel another layer draws over is not really on top. sample inside it
  // and ask the browser what is actually there
  const covered = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return null;
    const hits = [];
    for (const [fx, fy] of [[0.3, 0.06], [0.7, 0.06], [0.2, 0.5], [0.8, 0.5], [0.5, 0.94]]) {
      const x = r.left + r.width * fx;
      const y = r.top + r.height * fy;
      if (x < 0 || y < 0 || x > vw || y > vh) continue;
      const top = document.elementFromPoint(x, y);
      if (top && !top.closest(sel)) {
        hits.push(`${top.tagName}.${(top.className?.baseVal ?? top.className ?? "").toString().slice(0, 22)}`);
      }
    }
    return [...new Set(hits)];
  };

  const map = box(".map");
  return {
    vw, vh, dpr: window.devicePixelRatio,
    rootFont: getComputedStyle(de).fontSize,
    hScroll: de.scrollWidth > vw + 1,
    mapPctOfVh: map && !map.hidden ? Number((map.h / vh * 100).toFixed(1)) : null,
    stripScrollLeft: document.querySelector(".strip-row")?.scrollLeft ?? null,
    shell: document.querySelector(".app")?.className ?? "",
    header: box(".header"), sidebar: box(".sidebar"), map, legend: box(".legend"), detail: box(".detail"),
    bleed: bleed.slice(0, 6),
    smallTargets: small.slice(0, 6),
    iosZoomInputs: zoomy,
    coveredDetail: covered(".detail"),
    coveredSidebar: covered(".sidebar"),
  };
}

async function loadEngine() {
  const from = process.env.PLAYWRIGHT_PATH || "playwright";
  try {
    return await import(from);
  } catch (err) {
    console.error(
      `could not load playwright from "${from}".\n` +
      "it is not a dependency of this package on purpose. install it somewhere\n" +
      "and set PLAYWRIGHT_PATH to that module, for example:\n" +
      "  PLAYWRIGHT_PATH=/path/to/node_modules/playwright/index.mjs npm run probe\n" +
      `original error: ${err.message}`,
    );
    process.exit(2);
  }
}

const playwright = await loadEngine();
const launcher = playwright[ENGINE];
if (!launcher) {
  console.error(`unknown engine "${ENGINE}". use chromium, webkit or firefox`);
  process.exit(2);
}

const profiles = ONLY.length ? PROFILES.filter((p) => ONLY.includes(p.id)) : PROFILES;
if (profiles.length === 0) {
  console.error(`no profile matched PROBE_ONLY="${process.env.PROBE_ONLY}"`);
  process.exit(2);
}

mkdirSync(OUT, { recursive: true });
const browser = await launcher.launch();
const report = [];
let failures = 0;

console.log(`${ENGINE} ${browser.version()}, ${SCHEME}, ${URL_}`);

for (const p of profiles) {
  const context = await browser.newContext({
    viewport: { width: p.w, height: Math.max(220, p.h - (p.chrome || 0)) },
    deviceScaleFactor: p.dpr,
    hasTouch: !!p.touch,
    // isMobile is chromium only, so touch is what carries the coarse pointer
    ...(ENGINE === "chromium" && p.touch ? { isMobile: true } : {}),
    colorScheme: SCHEME,
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 160)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 160)); });

  await page.goto(URL_, { waitUntil: "networkidle", timeout: 90000 });
  await page.waitForSelector(".leaflet-container", { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1400);

  const initial = await page.evaluate(measure);
  await page.screenshot({ path: `${OUT}/${p.id}-1-initial.png` });
  const steps = {};

  const tile = page.locator(".ind-tile").first();
  if (await tile.count()) {
    await tile.click({ timeout: 6000 }).catch((e) => errors.push(`tile: ${e.message.slice(0, 70)}`));
    await page.waitForTimeout(700);
    steps.indicatorOpened = (await page.locator(".ind-detail").count()) > 0;
    await page.screenshot({ path: `${OUT}/${p.id}-2-indicator.png` });
    await tile.click({ timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(300);
  }

  // below 900 the controls live behind the toggle
  const drawer = initial.shell.includes("layout-drawer");
  if (drawer) {
    await page.locator(".panel-toggle").click({ timeout: 6000 }).catch((e) => errors.push(`toggle: ${e.message.slice(0, 70)}`));
    await page.waitForTimeout(500);
    steps.drawerOpened = await page.locator(".sidebar").evaluate((el) => getComputedStyle(el).visibility === "visible").catch(() => false);
    steps.drawer = await page.evaluate(measure);
    await page.screenshot({ path: `${OUT}/${p.id}-3-drawer.png` });
  }

  const rank = page.locator(".rank li button").first();
  if (await rank.count()) {
    await rank.click({ timeout: 6000 }).catch((e) => errors.push(`rank: ${e.message.slice(0, 70)}`));
    await page.waitForTimeout(900);
    steps.detailOpened = (await page.locator(".detail").count()) > 0;
    steps.detail = await page.evaluate(measure);
    await page.screenshot({ path: `${OUT}/${p.id}-4-detail.png` });
  }

  const states = [initial, steps.drawer, steps.detail].filter(Boolean);
  const covered = states.flatMap((s) => [...(s.coveredDetail ?? []), ...(s.coveredSidebar ?? [])]);
  const bad =
    initial.hScroll ||
    initial.bleed.length > 0 ||
    initial.smallTargets.length > 0 ||
    initial.iosZoomInputs.length > 0 ||
    covered.length > 0 ||
    errors.length > 0 ||
    steps.indicatorOpened === false ||
    steps.detailOpened === false ||
    (drawer && steps.drawerOpened === false);
  if (bad) failures += 1;

  report.push({ id: p.id, name: p.name, engine: ENGINE, scheme: SCHEME, profile: p, initial, steps, errors: [...new Set(errors)].slice(0, 4), ok: !bad });

  console.log(
    `${bad ? "FAIL" : "ok  "} ${p.id.padEnd(14)} ${String(initial.vw).padStart(4)}x${String(initial.vh).padEnd(4)}` +
    ` font=${initial.rootFont.padEnd(9)} map=${initial.mapPctOfVh}%vh` +
    ` hScroll=${initial.hScroll} strip@${initial.stripScrollLeft}` +
    ` ind=${steps.indicatorOpened ?? "-"} drw=${steps.drawerOpened ?? "-"} det=${steps.detailOpened ?? "-"}` +
    ` bleed=${initial.bleed.length} tap=${initial.smallTargets.length} zoom=${initial.iosZoomInputs.length} cov=${covered.length} err=${errors.length}`,
  );
  if (errors.length) console.log(`     err: ${errors[0]}`);
  if (initial.bleed.length) console.log(`     bleed: ${initial.bleed.join(" ")}`);
  if (initial.smallTargets.length) console.log(`     tap: ${initial.smallTargets.join(" ")}`);
  if (initial.iosZoomInputs.length) console.log(`     ios zoom on focus: ${initial.iosZoomInputs.join(" ")}`);
  if (covered.length) console.log(`     covered: ${[...new Set(covered)].join(" ")}`);

  await context.close();
}

await browser.close();
writeFileSync(`${OUT}/report-${ENGINE}-${SCHEME}.json`, JSON.stringify(report, null, 2));
console.log(`\n${profiles.length - failures}/${profiles.length} clean. report and screenshots in ${OUT}`);
process.exit(failures === 0 ? 0 : 1);
