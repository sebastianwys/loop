// every view at a desktop and a phone width, against a built site.
// probe-devices.mjs only ever loads "/", so it exercises the map and nothing
// else. this walks the view registry instead and asks the cheap questions a
// unit test cannot: does the page scroll sideways, did an image fail, is a
// placeholder still on screen, did anything throw.
//
//   npm run preview &
//   PLAYWRIGHT_PATH=/path/to/node_modules/playwright/index.mjs npm run probe:views
//
// PROBE_URL points it at a deployed site instead of localhost.

const URL_ = process.env.PROBE_URL || "http://localhost:4173/";
const VIEWS = ["map", "compare", "explore", "accuracy", "model", "sources"];
const SIZES = [{ name: "desktop", width: 1512, height: 894 }, { name: "phone", width: 393, height: 852 }];
// compare draws nothing until it is given metros, so it is handed two
const EXTRA = { compare: "&compare=10180,19100" };

async function loadEngine() {
  const from = process.env.PLAYWRIGHT_PATH || "playwright";
  try {
    const mod = await import(from);
    // a commonjs entry puts every export under default, and PLAYWRIGHT_PATH
    // pointed at a package directory resolves to exactly that
    return mod.chromium ? mod : mod.default;
  } catch (err) {
    console.error(`could not load playwright from "${from}". point it at index.mjs.\n${err.message}`);
    process.exit(2);
  }
}

// what the page looks like from outside: enough text to be a page, no sideways
// scroll, no broken image, no scaffold left behind
function measure() {
  const root = document.documentElement;
  return {
    text: (document.body.innerText || "").replace(/\s+/g, " ").trim().length,
    hScroll: root.scrollWidth > root.clientWidth + 1,
    brokenImages: [...document.images].filter((i) => i.complete && i.naturalWidth === 0).length,
    placeholders: document.querySelectorAll(".view-pending").length,
  };
}

const playwright = await loadEngine();
const browser = await playwright.chromium.launch();
let failed = 0;

for (const size of SIZES) {
  for (const view of VIEWS) {
    const context = await browser.newContext({ viewport: { width: size.width, height: size.height } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e).slice(0, 140)));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 140)); });

    const url = `${URL_}?view=${view}${EXTRA[view] || ""}`;
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: 90000 });
    } catch (err) {
      console.log(`FAIL ${size.name.padEnd(7)} ${view.padEnd(9)} did not load: ${err.message.split("\n")[0]}`);
      failed += 1;
      await context.close();
      continue;
    }

    const m = await page.evaluate(measure);
    const ok = m.text > 200 && !m.hScroll && m.brokenImages === 0 && m.placeholders === 0 && errors.length === 0;
    if (!ok) failed += 1;
    console.log(
      `${ok ? "ok  " : "FAIL"} ${size.name.padEnd(7)} ${view.padEnd(9)} text=${m.text} hScroll=${m.hScroll} ` +
      `brokenImg=${m.brokenImages} placeholder=${m.placeholders} err=${errors.length}` +
      (errors.length ? ` :: ${errors[0]}` : ""),
    );
    await context.close();
  }
}

await browser.close();
console.log(failed === 0 ? `\n${VIEWS.length * SIZES.length}/${VIEWS.length * SIZES.length} clean` : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
