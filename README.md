# Project Loop: Consumer & Macro Conditions Data Platform

Economic conditions across 410 U.S. metros on one live map. I join FHFA, Census, BLS, FRED, Zillow and IRS data into one panel, forecast house price growth with a PyTorch GRU, and publish both.

Live map: https://loop.macroviz.workers.dev

The map colors every metro by any of 55 metrics for 2014, 2019, 2024 or the latest reading. Each metro has a detail panel with its history and forecast, and a strip of 13 national indicators along the top updates from FRED every weekday after the market close.

## How I built it

| step | what I did |
| --- | --- |
| pipeline | Built the FHFA and Census join for my IS477 final project at Illinois, with Snakemake and a SHA-256 manifest for every download |
| collectors | Wrote 13 collectors that run on GitHub Actions, the national series every weekday and the rest monthly |
| model | Trained a GRU to forecast 1 to 8 quarters ahead and tested it the way it would have been used: refitted every year, on FHFA prices as they were first published |
| map | Built the map in React and Leaflet and deploy it to Cloudflare |

## What it found

- Mountain towns and coastal Sun Belt markets replaced the Bay Area at the top of the price index between 2019 and 2024. Bozeman MT is the highest whole metro at 610, behind only the Miami division at 629.
- Population barely predicts price, and that held steady: a correlation of 0.27 in 2014, 0.31 in 2019 and 0.27 in 2024.
- Median income is the strongest real predictor of the price index, at 0.50.
- Scored on the 34 quarters from 2018 on, the forecast cut the error of a no change forecast by 43 percent at one year, and by 36 percent on 2022 onward alone. Ridge regression and gradient boosting did about as well. The details are in [ml/README.md](ml/README.md).

## The layout

| folder | what it holds |
| --- | --- |
| root | the FHFA and Census pipeline, tagged `final-project` |
| `bot/` | the collectors and the map data build |
| `ml/` | the forecasting model and its tests |
| `web/` | the map |
| `docs/` | the data report |

## Setup

```
python3.12 -m venv .venv
pip install -r requirements.txt
export CENSUS_API_KEY=your_key_here
snakemake --cores 1
```

The bot also needs `FRED_API_KEY`. `BLS_API_KEY`, `BEA_API_KEY` and `HUD_API_TOKEN` add the rest, and a source without a key is skipped. Rebuild the map data with `python -m bot.run_bot` and run the tests with `python run_tests.py`.

## More

- [The data report](docs/REPORT.md): sources, schema, the five problems I hit, cleaning and findings.
- [The forecasting model](ml/README.md): how it was tested, results, and limits.
- [The map](web/README.md): settings and deployment.

## License

MIT for the code. The data is public domain U.S. government work, except Zillow Research and Realtor.com Economic Research, which are used under their terms with attribution. Their downloaded files are not committed. The repo keeps metro figures built from them (yearly averages, the latest month, and Zillow's one year forecast), and the site shows values derived from their data.
