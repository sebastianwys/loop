# Loop map

A static map of 410 metros and metropolitan divisions. Each metro is a dot sized by population or a Census boundary shape, colored by the metric you pick. Click one for its detail panel.

The data comes from `public/data/metros.json`, which `bot/build_map_data.py` writes from the pipeline and the bot's sources.

```
npm install
npm run dev          local server, falls back to a three metro sample without the json
npm run test         unit tests, offline
npm run build        type check, then build into dist/
npm run boundaries   rebuild the boundary file for the Shapes toggle
```

## What it shows

The strip across the top holds 13 national indicators from FRED: CPI, core CPI and PCE, producer prices, the fed funds rate and where futures put it a year out, the 30 year mortgage rate, the 10 year Treasury, consumer sentiment, expected inflation, unemployment and retail sales. Each tile shows the latest value, its change over twelve months and a sparkline.

Metrics are grouped into house prices, the housing market, rents and affordability, people and migration, supply, and forecasts. The menu lists only metrics the data carries, so a source without a key stays hidden. The timeline runs from 2014 to the newest date and can play from start to finish.

Forecasts color the map by the model's expected growth over the next four and eight quarters, with the 90 percent band in the detail panel. The numbers come from `ml/results/forecast/metrics.csv`.

## Layout

Four width bands, set in `src/lib/layout.ts` and matched by the media queries in `src/styles.css`.

| band | width | sidebar | detail panel |
|---|---|---|---|
| phone | under 640 | drawer, starts closed | sheet from the bottom |
| tablet | 640 to 899 | drawer, starts closed | sheet from the bottom |
| compact | 900 to 1399 | docked | floating card |
| wide | 1400 and up | docked | floating card |

It respects dark mode, reduced motion and high contrast, and uses 44px tap targets and 16px inputs on touch screens.

`npm run probe` loads the map at 17 screen sizes and fails on overflow, small tap targets, covered panels or console errors. It needs an existing Playwright install through `PLAYWRIGHT_PATH`. Run it with `PROBE_ENGINE=webkit` before shipping a layout change, because Safari sizes form controls differently.

## Deploying

The site deploys as a Cloudflare Worker.

| setting | value |
|---|---|
| root directory | `web` |
| build command | `npm ci && npm run build` |
| deploy command | `npx wrangler deploy` |

Run wrangler from `web`, never from the repo root, or it publishes the whole repo. By hand, use `npm run deploy`, which first refuses to publish a checkout that is behind `origin/main`.

Map tiles are from OpenStreetMap, credited in the map and the footer.
