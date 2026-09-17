# Project Loop: the data report

Sources, schema, quality, cleaning, findings and reproducing steps. The short version is in the [README](../README.md). The forecasting model is in [ml/README.md](../ml/README.md).

Live map: https://loop.macroviz.workers.dev

This started as my IS477 final project at the University of Illinois. The pipeline in the repo root is that project, tagged `final-project`. I worked individually and every commit is mine.

## The Question

Home prices respond to local income, demographics, education and supply. Which of those actually predict appreciation across U.S. metros, and which metros broke away from what their fundamentals suggest?

The pipeline pulls two government datasets, profiles them, cleans them, joins them on CBSA code, and produces five charts and one integrated CSV.

## The Sources

Both are U.S. government works in the public domain (17 USC 105). No PII: everything aggregates to metro level. ACS responses are mandatory under Title 13. The MIT license here covers source code only.

The bot adds more sources, all public domain except Zillow Research and Realtor.com Economic Research, used under their terms with attribution and not redistributed here.

### FHFA House Price Index

Weighted repeat-sales on Fannie, Freddie, FHA and VA mortgage data. About 186,000 rows, 1975 to 2026.

| field | value |
| --- | --- |
| location | `data/raw/fhfa/hpi_master.csv` |
| source | https://www.fhfa.gov/hpi/download/monthly/hpi_master.csv |
| access | direct HTTP, about 16.8 MB |
| manifest | `data/raw/fhfa/download_manifest.json` |
| vintage | pulled 2026-09-14. No vintage parameter exists, see problem 4. |

Filtered to the canonical inter-metro index (MSA, quarterly, traditional, all-transactions), the working slice is 71,072 rows across 410 MSAs.

| column | type | note |
| --- | --- | --- |
| `place_id` | string | CBSA or division code. Joins to Census `geo_code`. |
| `place_name` | string | metro name |
| `hpi_type` | string | filtered to `traditional` |
| `hpi_flavor` | string | filtered to `all-transactions` |
| `level` | string | filtered to `MSA` |
| `frequency` | string | filtered to `quarterly` |
| `yr`, `period` | int | year, quarter 1 to 4 |
| `index_nsa` | float | the measure used |
| `index_sa` | float | 100 percent null at MSA level. Not used. |
| `rstderr`, `note` | | expanded-data series only. Not used. |

### Census ACS 5-Year Estimates

Sixty months of pooled responses per vintage. Three non-overlapping windows, because Census Comparison Profile guidance is built around non-overlapping intervals. Overlapping windows would count the same respondents twice.

| vintage | window | role | rows |
| --- | --- | --- | --- |
| 2014 | 2010 to 2014 | post-recession baseline | 929 |
| 2019 | 2015 to 2019 | pre-COVID peak | 938 |
| 2024 | 2020 to 2024 | post-COVID | 935 |

Endpoint `https://api.census.gov/data/{year}/acs/acs5`, all metropolitan and micropolitan areas, manifest at `data/raw/census/download_manifest.json`.

| original | renamed | description |
| --- | --- | --- |
| `B19013_001E` | `median_income` | median household income, USD |
| `B01003_001E` | `total_pop` | total population |
| `B01002_001E` | `median_age` | median age |
| `B15003_001E` | `adults_25_plus` | population 25 and over, the universe B15003 counts within |
| `B15003_022E` | `bachelors_count` | persons with a bachelor's |
| `B15003_023E` | `masters_count` | persons with a master's |
| `B25003_001E` | `total_occupied_units` | occupied housing units |
| `B25003_002E` | `owner_occupied_units` | owner-occupied units |
| `B25077_001E` | `median_home_value` | median home value, USD |
| (geo) | `cbsa_code` | CBSA code, cast to string for the join |
| derived | `homeownership_rate` | `owner / total` |

## The Schema

```
+-------------------------+         +-------------------------+
|       FHFA HPI          |         |      CENSUS ACS         |
|-------------------------|         |-------------------------|
|  PK   place_id          |         |  PK   cbsa_code         |
|  PK   yr                |         |  PK   year              |
|       index_nsa         |         |       median_income     |
|       + filters         |         |       + 7 more measures |
+-------------------------+         +-------------------------+
            |                                    |
            |  inner join on                     |
            |  (place_id, yr) = (cbsa_code, year)|
            +--------------+---------------------+
                           v
            +-------------------------+
            |    INTEGRATED CSV       |
            |  1,197 rows x 24 cols   |
            |  410 metros             |
            |  2014, 2019, 2024       |
            +-------------------------+
```

`data/integrated/hpi_census_merged.csv`. 410 metros is 373 metropolitan statistical areas plus 37 metropolitan divisions. The theoretical maximum is 1,230 (410 x 3); the 33 missing rows are metros without FHFA data for every vintage year, usually newer MSA designations.

## The Five Problems

Every one of these was a silent failure. None threw an error.

| # | problem | symptom | fix | lesson |
| --- | --- | --- | --- | --- |
| 1 | CBSA code type mismatch | merge returned zero rows | `astype(str)` on the Census side | profile both sides of a join before merging |
| 2 | 2010 ACS endpoint | errors on a variable set that worked from 2015 | dropped 2010, moved to non-overlapping 2014/2019/2024 | pre-2012 ACS variable codes and geographies differ |
| 3 | HPI type/flavor duplication | 3.77 rows per metro across three years, impossible without duplication | dropped `hpi_type` and `hpi_flavor` from the `groupby` keys | check `rows / unique entities` against what you expect |
| 4 | FHFA has no vintage parameter | hash moved with no code change | the archived raw file in git is the vintage | a source you cannot address by vintage must be pinned by commit |
| 5 | the 13 largest metros missing | Chicago, NYC and LA never joined | pull ACS at division level, crosswalk 4 renamed codes | a housing study without Chicago is not a housing study |

Problem 1 is the one I misread longest. I diagnosed it as a data availability problem until profiling both sides showed identical numeric values under different types. One line to fix, a long time to find.

Problem 4 surfaced on 2026-09-14 while proving a clean start-to-finish run. Census reproduced byte for byte because every ACS endpoint carries its vintage in the URL. FHFA did not. `hpi_master.csv` is a live file, and between May and September FHFA added two quarters and two columns, expanded one series from 7,000 rows to 58,220, and revised history. The merged file kept its row count but 1,094 values changed and its SHA-256 moved from `08c906a7` to `c3d1629e`. I adopted the September pull in one dedicated commit, so `git log -- data/raw/fhfa/hpi_master.csv` shows both snapshots.

Problem 5 raised the join from 373 metros to all 410 FHFA codes. Division rows carry `geo_level` of `division` and their parent code in `parent_cbsa`.

The broader lesson: curation work is mostly diagnosing failures that look like something else. Both of the worst bugs here were one-line fixes that took days to find.

## The Cleaning

| # | operation | why |
| --- | --- | --- |
| 1 | lock the FHFA series to MSA, quarterly, traditional, all-transactions | without it, multiple HPI variants per metro-year duplicate Census rows on the merge |
| 2 | collapse quarters to annual means per metro, with a `quarters_available` count | FHFA is quarterly, Census is annual |
| 3 | coerce eight Census variables with `pd.to_numeric(errors="coerce")` | the API returns strings, and suppression is the sentinel `-666666666`, not null |
| 4 | cast Census `cbsa_code` to string | matches FHFA's format, see problem 1 |
| 5 | derive `homeownership_rate` | a rate compares across metro sizes, counts do not |

Post-coerce null rate is below 1 percent per variable. The merge is an inner join with an empty-merge guard that raises `RuntimeError` on zero rows, which catches CBSA boundary changes before they write an empty CSV.

## The Findings

A regime shift between the 2019 and 2024 vintages.

The top-15 inverted. The 2019 list was led by the Bay Area and Puget Sound: San Francisco-San Mateo-Redwood City at 441.8, San Jose at 418.5, Seattle-Bellevue-Kent at 378.9, Oakland-Fremont-Berkeley at 370.9, then Midland TX at 368.9. The 2024 list is led by the Miami-Miami Beach-Kendall division at 629.0, then Bozeman MT at 610.2, St. Petersburg-Clearwater-Largo at 598.4, Charleston SC at 581.9 and Naples FL at 571.2. Bozeman is the highest ranked whole metro. Salt Lake City, Boise and Portland OR are all outside the top 15, at ranks 32, 27 and 57 of 410. Missoula joined Bozeman, so Montana holds two of the top 15. Mountain towns and Sun Belt coastal markets replaced the Bay Area story, which is the visible signature of remote-work migration.

Seven of the 2024 top 15 are metropolitan divisions, so the list changed shape as well as order when the 37 divisions joined in commit c3af214. Bozeman was already eighth in 2019, so it climbed rather than appeared.

Population did not decouple from price. On the 392 metros carrying all three vintages the correlation with HPI runs 0.28, 0.32, 0.28. It rose and came back. A Fisher z test on the 2019 to 2024 leg gives z = 0.64, p = 0.53, so the move is not distinguishable from sampling noise. Earlier drafts of this report claimed a drop from 0.40 to 0.23 and read a decoupling story into it. Neither endpoint reproduces on the committed data and there is no trend to read.

The correlation matrix at the 2024 vintage, Pearson r over all 410 metros and divisions, pairwise complete:

| pair | r | reading |
| --- | --- | --- |
| median income vs HPI | 0.50 | strongest non-trivial predictor |
| median home value vs HPI | 0.67 | expected, HPI measures value appreciation |
| income vs median home value | 0.82 | wealthy metros have expensive housing |
| homeownership rate vs HPI | -0.10 | weak negative, and it is composition: the 37 divisions average 0.644 ownership at HPI 415, the 373 plain MSAs 0.673 at HPI 342 |
| median age vs homeownership | 0.63 | life-cycle effect, does not reach HPI |

Most of these cells moved when the 37 metropolitan divisions joined the panel in commit c3af214 and the metro count went from 373 to 410. Income vs HPI moved twice: the FHFA 2026-Q3 re-pull in commit 2f9d03c shifted it on the unchanged 373 metros, then the division merge moved it again. Divisions are kept because FHFA publishes the 13 largest metros only as divisions and their parent MSAs are absent from the file, so nothing is double counted. Excluding them would drop New York, Los Angeles, Chicago, Dallas and Atlanta, which is the worst possible exclusion for a correlation against population. Values published before those commits were computed on the smaller population and are not comparable. Recompute rather than citing an older draft.

The income-vs-HPI scatter shows the affordability story: a cluster at HPI 545 to 610 sitting at 80k to 95k median income. Those are Bozeman, Charleston, Naples and Bend, where prices outran local income between 2019 and 2024.

Five charts in `results/visualizations/`: HPI distribution, income vs HPI, homeownership vs HPI, the top-15 bar chart, and the correlation heatmap.

## The Reproducing Steps

```bash
cd loop
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
export CENSUS_API_KEY=your_key_here
```

Get a key at https://api.census.gov/data/key_signup.html and click the activation link. Without one the API returns an HTML page with a 200 status, which `download_census.py` detects.

Three ways to run, same outputs:

| option | command | note |
| --- | --- | --- |
| Snakemake | `snakemake --cores 1` | recommended. Three rules, re-runs only what changed. |
| wrapper | `python run_all.py` | same three scripts, no dependency tracking |
| manual | `python scripts/download_fhfa.py`, then `download_census.py`, then `eda_integrate.py` | |

ACS end years are pinned in `data/raw/census/vintages.json`. `--refresh-vintages` re-resolves the newest vintage and moves the window forward deliberately.

| output | contents |
| --- | --- |
| `data/raw/fhfa/` | HPI master, expanded metro file, manifest |
| `data/raw/census/` | 3 ACS vintages, combined CSV, manifest |
| `data/integrated/` | `hpi_census_merged.csv` |
| `results/visualizations/` | 5 PNGs |

Every manifest records filename, source, SHA-256, size, row count, vintage and an ISO 8601 UTC timestamp. A re-download with a different hash is the trigger to re-run downstream.

Verifying integrity: Census files will match, because each vintage endpoint is fixed. FHFA files will not, because `hpi_master.csv` is live. The committed `data/raw/fhfa/` is the snapshot this report describes. To rebuild from it without downloading, run `snakemake --cores 1 --forcerun integrate`.

## The Bot and the Map

`bot/` collects enrichment sources on a monthly GitHub Actions schedule and rebuilds `web/public/data/metros.json`. Each source is one collector in `bot/collectors/` writing `data/raw/<source>/` with a manifest and a `metrics.csv` the map builder finds by convention.

| source | what it adds |
| --- | --- |
| Census Gazetteer | centroids. Division centroids derived from their counties, plus the counties of every CBSA and division from the OMB 2023 delineation, and from the February 2013 and September 2018 delineations the two older ACS vintages were published on, so a decade growth rate can be withheld from a CBSA that was redrawn between them. |
| Zillow | ZHVI, ZORI, inventory, days to pending, price cuts, ZHVF forecast |
| BLS | metro unemployment |
| FRED | 30-year mortgage rate, plus thirteen national indicators for the strip |
| Census ACS | gross rent, rent burden, vacancy, commute, poverty, labor force |
| Census | population estimates with migration, building permits |
| Realtor.com | listing metrics |
| IRS | county-to-county migration |
| BEA, HUD | personal income, fair market rents. Keys required. |

Divisions inherit metro-level sources from their parent and say so. HUD is the exception: it publishes for its own fair market rent areas rather than for CBSAs, so 66 of the 410 study codes have no HUD entity, the 37 divisions among them. Each of those is rebuilt from the counties the delineation gives it, every county carrying the value of the HUD area it sits in, averaged by ACS population when the counties span more than one area, which is why the HUD collector reads `CENSUS_API_KEY` as well as its own token. Without the census key the codes that sit in a single area still resolve and the rest stay missing rather than being averaged blind. New England is keyed town by town, and in Connecticut HUD still names the pre-2022 counties while the delineation names planning regions, so its towns are placed by the census. The Massachusetts municipalities that became cities, Methuen, Watertown, Amesbury, Easthampton and Framingham, carry their pre-incorporation subdivision code at HUD and their reassigned one at the census; the five pairs are crosswalked in the collector. Left unmatched they had no weight, and a row with no weight leaves the numerator and the denominator both, so they did not go missing from the mean, they tilted it: 107,874 people and 4.3 percent of Cambridge-Newton-Framingham, one directional, since Methuen is half of them and sits in the cheaper Lawrence area. Any town that falls outside the crosswalk is named in the manifest rather than dropped in silence. HUD has nothing before fiscal 2017, so 2014 is blank for every metro and the map says so rather than showing an empty panel. Run it with `python -m bot.run_bot`. `CENSUS_API_KEY` and `FRED_API_KEY` are required; `BLS_API_KEY`, `BEA_API_KEY` and `HUD_API_TOKEN` add the rest. A source with no key is skipped.

`web/` is the React and Leaflet map. Settings and deploy steps are in [web/README.md](../web/README.md).

## The Layout

```
loop/
|-- scripts/          acquisition and integration
|-- data/raw/         one folder per source, each with a manifest
|-- data/integrated/  the merged output
|-- results/          5 PNG charts
|-- ml/               the forecasting model, see ml/README.md
|-- bot/              collectors and the map data build
|-- web/              react and leaflet map
|-- tests/            python run_tests.py
|-- docs/REPORT.md    this file
|-- Snakefile         workflow definition
`-- metadata.jsonld   Schema.org Dataset description
```

Raw files keep their source name. Manifests are always `download_manifest.json` in the source folder. Visualizations use snake_case.

## The Lifecycle

The DCC Curation Lifecycle Model, mapped to artifacts.

| phase | here |
| --- | --- |
| conceptualise | the project plan: research questions, dataset selection |
| create or receive | `scripts/download_fhfa.py`, `scripts/download_census.py` |
| appraise and select | filter to MSA, quarterly, traditional, all-transactions |
| ingest | save to `data/raw/` with a SHA-256 manifest |
| preservation action | public domain inputs, MIT license, structured manifests |
| store | `data/raw/` and `data/integrated/` committed to GitHub |
| access, use, reuse | `README.md`, `Snakefile`, `run_all.py`, `metadata.jsonld` |
| transform | `scripts/eda_integrate.py` cleans, joins, derives, visualizes |

## The Future Work

The metropolitan-division crosswalk and the forecasting model are both done. What remains:

- Feature engineering on the integrated set: income-to-price ratio, education share, demographic deltas across vintages.
- Generative scenarios. A small VAE producing synthetic metro-year observations under counterfactual conditions, kept only if it beats conditional sampling.
- FAIR metadata. A DCAT file or a DataCite descriptor for a Zenodo deposit would make the dataset machine-discoverable.

`ml/MILESTONES.md` is the plan.

## The References

Datasets

1. Federal Housing Finance Agency. *House Price Index Master File*. https://www.fhfa.gov/data/hpi/datasets?tab=master-hpi-data. Retrieved September 2026. Public domain.
2. U.S. Census Bureau. *American Community Survey 5-Year Estimates*. Vintages 2010 to 2014, 2015 to 2019, 2020 to 2024. https://www.census.gov/data/developers/data-sets/acs-5year.html. Public domain.

Methodology

3. U.S. Census Bureau. *When to Use 1-year, 3-year, or 5-year Estimates*. https://www.census.gov/programs-surveys/acs/guidance/estimates.html.
4. U.S. Census Bureau. *Comparing ACS Data*. https://www.census.gov/programs-surveys/acs/guidance/comparing-acs-data.html.
5. Office of Management and Budget. (2023). *2023 Standards for Delineating Core Based Statistical Areas (OMB Bulletin 23-01)*. https://www.census.gov/programs-surveys/metro-micro/about/omb-bulletins.html.
6. Federal Housing Finance Agency. *HPI FAQs and Methodology*. https://www.fhfa.gov/data/hpi/hpi-faqs.

Software

7. McKinney, W., and the pandas development team. *pandas* v2.1+. https://pandas.pydata.org/.
8. Harris, C. R., Millman, K. J., van der Walt, S. J., et al. (2020). Array programming with NumPy. *Nature* 585, 357 to 362.
9. Hunter, J. D. (2007). Matplotlib: A 2D graphics environment. *Computing in Science & Engineering* 9(3), 90 to 95.
10. Reitz, K., and contributors. *Requests* v2.31+. https://requests.readthedocs.io/.
11. Waskom, M. L. (2021). seaborn. *Journal of Open Source Software* 6(60), 3021.
12. Python Software Foundation. *Python 3.12 Reference Manual*. https://www.python.org/.

License

Source code MIT (`LICENSE`). Data public domain. The integrated dataset is offered into the public domain.
