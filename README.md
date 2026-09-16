# Project Loop: Consumer & Macro Conditions Data Platform

Consumer and macroeconomic conditions across 410 U.S. metros. I join FHFA, Census, BLS, FRED, Zillow and IRS sources into one panel, forecast house price growth with a PyTorch GRU, and publish it to a live map.

## The Map

https://loop.macroviz.workers.dev

It is public. No login, nothing to install.

Dots or Census boundaries, colored by any of 48 metrics, for 2014, 2019, 2024 or the latest reading. A detail panel per metro, a calendar timeline, and thirteen national indicators across the top.

## The Layout

| Folder | What it does |
| --- | --- |
| root | The FHFA and Census ACS pipeline. Snakemake, SHA-256 manifests, tagged `final-project` |
| `bot/` | Thirteen collectors on a monthly GitHub Actions schedule |
| `ml/` | The PyTorch GRU, its baselines and its evaluation |
| `web/` | React and Leaflet map, deploys to Cloudflare |
| `docs/` | The long report |

## The Findings

Metro housing markets shifted between the 2019 and 2024 vintages.

- Mountain towns and Sun Belt coastal markets displaced the Bay Area at the top. Bozeman MT is the highest whole metro at HPI 610, second overall behind the Miami-Miami Beach-Kendall division at 629. Salt Lake City, Boise and Portland OR all fell out of the top 15.
- Population correlation with HPI is flat: 0.28 in 2014, 0.32 in 2019, 0.28 in 2024 on the 392 metros carrying all three vintages. Metro size is a weak predictor and has stayed one.
- Median income against HPI is 0.50, the strongest non-trivial predictor. Homeownership rate against HPI is -0.10, weak enough to be indistinguishable from zero.

Correlations are Pearson r on levels over all 410 metros and divisions at the 2024 vintage, pairwise complete. Row counts differ by vintage, 392 in 2014 and 395 in 2019, so any comparison across vintages is measured on the metros carrying both.

## The Setup

```
python3.12 -m venv .venv
pip install -r requirements.txt
export CENSUS_API_KEY=your_key_here
snakemake --cores 1
```

The bot needs `FRED_API_KEY` as well. `BLS_API_KEY`, `BEA_API_KEY` and `HUD_API_TOKEN` add the rest. A source with no key is skipped.

Rebuild the map data with `python -m bot.run_bot`. Run the python suite with `python run_tests.py`.

## The Rest

- [The data report](docs/REPORT.md). Sources, schema, quality, cleaning, reproducing steps.
- [The forecasting walkthrough](ml/README.md). Evaluation design, baselines, results, the shipped forecast.

## The License

MIT for the code. The data is public domain U.S. government work, except Zillow Research and Realtor.com Economic Research, which are used under their terms with attribution and are not redistributed here.
