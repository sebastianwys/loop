# Loop map

A static map of 410 metros and metropolitan divisions. Each metro is a dot sized by population or a Census boundary shape, colored by the selected metric. Click one for its detail panel.

Data comes from `public/data/metros.json`, which `bot/build_map_data.py` writes from the pipeline output and the bot's sources. Run the pipeline and the bot before deploying.

```
npm install
npm run dev          local server, falls back to a 3-metro sample if the json is missing
npm run test         vitest, offline
npm run build        typecheck then vite build into dist/
npm run boundaries   rebuild the TopoJSON for the Shapes toggle
```

## The National Strip

Thirteen indicators across the top: consumer prices, core CPI and PCE, producer prices, the fed funds rate and where futures put it a year out, the 30-year mortgage rate, the 10-year Treasury, consumer sentiment, expected inflation, unemployment and retail sales.

Each tile shows the latest value, its twelve month change and a sparkline. Opening one gives the full monthly history and names the provider. The numbers come from the national block of `metros.json`, collected from FRED. Without that block the strip is absent.

## The Metrics

Grouped into House prices, Housing market, Rents and affordability, People and migration, Supply, and Forecasts. The menu lists only metrics the built json actually carries, so a source with no key stays hidden.

The "as of" control is a timeline on a calendar axis from 2014 to the newest date in the data. One tick per period, filled where the metric has values and hollow where it is not published, with the metro count under each. Arrow keys step between filled ticks. Play walks the map start to finish.

Forecasts colors the map by the model's expected HPI growth over the next four and eight quarters, realized growth over the last four quarters and five years annualized, and the surprise, actual minus expected. The detail panel adds the 90 percent band. Numbers come from `ml/results/forecast/metrics.csv`, written by `python -m loop.export`.

A monthly bot run carries the last exported forecast until the model is rerun. So the caption date is the forecast origin, not the run date.

## The Shapes Toggle

Draws each metro as its boundary instead of a dot, from `public/data/boundaries.json`. `npm run boundaries` downloads the Census cartographic boundary files and simplifies them with mapshaper, installed one-off with `npm install --no-save mapshaper@0.7` rather than kept as a dependency. The zips stay in `data/raw/boundaries/` with a manifest. The TopoJSON is committed and fetched only when Shapes is first chosen.

## The Layout

Four bands, set in `src/lib/layout.ts` and matched one for one by the media queries in `src/styles.css`. Windows reports CSS pixels after display scaling, so a 1920x1080 panel at 150% is a 1280 viewport and lands in compact.

| band | width | sidebar | detail panel |
|---|---|---|---|
| phone | under 640 | drawer, starts shut | sheet from the bottom |
| tablet | 640 to 899 | drawer, starts shut | sheet from the bottom |
| compact | 900 to 1399 | docked, collapsible | floating card |
| wide | 1400 and up | docked, collapsible | floating card |

Panel widths and the root font size are `clamp()` values, so nothing is pinned to one screen. The map fits the lower 48 to whatever container it gets and refits on resize until you pan or zoom it yourself.

Also handled: `prefers-color-scheme: dark`, `prefers-reduced-motion`, `prefers-contrast: more`, 44px targets and 16px inputs on touch, safe area insets, and `scrollbar-gutter` so the Windows scrollbar does not shift the column.

## The Device Probe

`npm run probe` loads the map at 17 viewport sizes and fails on anything the layout gets wrong: horizontal overflow, an element past the viewport that is not inside a scroller, a tap target under 30px, an input under 16px (iOS zooms the page on focus otherwise), a panel another layer draws over, or a console error. It writes a report and screenshots to `.probe/`, which is gitignored.

Playwright is deliberately not a dependency here. It pulls several hundred MB of browsers that nobody cloning the map needs, so point `PLAYWRIGHT_PATH` at an existing install.

```
PLAYWRIGHT_PATH=/path/to/node_modules/playwright/index.mjs npm run probe
PROBE_URL=https://loop.macroviz.workers.dev/ npm run probe
PROBE_ENGINE=webkit npm run probe      Safari's engine
PROBE_SCHEME=dark npm run probe
PROBE_ONLY=iphone-15-pro npm run probe
```

Run the WebKit pass before shipping a layout change. Chromium and WebKit disagree on form controls: WebKit clamps `min-height` on a default-appearance `select` to its intrinsic 18px and drops the padding, which left the metric picker a 23px target on iOS while Chromium reported a healthy 44. That is why the select carries an explicit `appearance: none` and its own chevron.

## Deploying

Cloudflare Workers flow: Workers and Pages, Create, import the repository.

| setting | value |
|---|---|
| root directory | `web` |
| build command | `npm ci && npm run build` |
| deploy command | `npx wrangler deploy` |
| environment variables | none |

`wrangler.jsonc` points the Worker at `dist` as static assets. The older Pages flow works too, same root and build command, output directory `dist`.

Run `npx wrangler deploy` from `web`, never from the repo root. A root run publishes the whole repo folder as a new Worker.

By hand, run `npm run deploy` rather than wrangler on its own. It builds, and first runs `scripts/preflight-deploy.mjs`, which refuses to publish a checkout that is behind its upstream. Wrangler publishes the whole of `dist` as one manifest rather than a diff, and its "already uploaded" line means the content was already in the asset store, not that the file is unchanged, so a deploy from a stale tree quietly republishes old data over whatever the scheduled runs have since refreshed. That is how a national strip refresh got rolled back a day on 2026-09-16. Every build input except the gitignored Zillow csvs is tracked, so being level with the remote is the closest cheap test that the inputs are current. `LOOP_DEPLOY_FORCE=1 npm run deploy` publishes anyway. The workflows call wrangler directly from a fresh checkout and never reach the preflight.

Tiles are OpenStreetMap. Attribution is in the map and the footer.
