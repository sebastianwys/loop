# Project Loop: the data report

This started as my final project for IS477 at the University of Illinois. The pipeline in the repo root is that project, tagged `final-project`. I worked alone. The short version is in the [README](../README.md) and the forecasting model is in [ml/README.md](../ml/README.md).

Live map: https://loop.macroviz.workers.dev

## The question

Home prices respond to local income, demographics, education and supply. Which of those actually predict appreciation across U.S. metros, and which metros broke away from what their fundamentals suggest?

## The sources

Both sources are public domain U.S. government data aggregated to the metro level, so there is no personal information. The MIT license covers the code only.

### FHFA House Price Index

A weighted repeat sales index built from Fannie Mae, Freddie Mac, FHA and VA mortgages, about 186,000 rows from 1975 to 2026.

| field | value |
| --- | --- |
| file | `data/raw/fhfa/hpi_master.csv`, about 16.8 MB |
| source | https://www.fhfa.gov/hpi/download/monthly/hpi_master.csv |
| manifest | `data/raw/fhfa/download_manifest.json` |
| pulled | 2026-09-14. FHFA publishes no vintage parameter, see problem 4 |

I filter to the metro level, quarterly frequency, the traditional all transactions index. That leaves 71,072 rows across 410 metros. The measure is `index_nsa`, keyed by `place_id` (the CBSA or division code) and `yr`.

### Census ACS five year estimates

Each vintage pools 60 months of responses. I use three windows that do not overlap, because overlapping windows count the same respondents twice.

| vintage | window | role | rows |
| --- | --- | --- | --- |
| 2014 | 2010 to 2014 | after the recession | 960 |
| 2019 | 2015 to 2019 | the peak before COVID | 969 |
| 2024 | 2020 to 2024 | after COVID | 972 |

Endpoint `https://api.census.gov/data/{year}/acs/acs5`, manifest at `data/raw/census/download_manifest.json`.

| Census code | renamed | meaning |
| --- | --- | --- |
| `B19013_001E` | `median_income` | median household income, USD |
| `B01003_001E` | `total_pop` | total population |
| `B01002_001E` | `median_age` | median age |
| `B15003_001E` | `adults_25_plus` | population 25 and over |
| `B15003_022E` | `bachelors_count` | people with a bachelor's degree |
| `B15003_023E` | `masters_count` | people with a master's degree |
| `B25003_001E` | `total_occupied_units` | occupied housing units |
| `B25003_002E` | `owner_occupied_units` | owner occupied units |
| `B25077_001E` | `median_home_value` | median home value, USD |
| derived | `homeownership_rate` | owner occupied over total occupied |

## The schema

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
            |  1,204 rows x 24 cols   |
            |  410 metros             |
            |  2014, 2019, 2024       |
            +-------------------------+
```

The output is `data/integrated/hpi_census_merged.csv`. The 410 metros are 373 metropolitan statistical areas plus 37 metropolitan divisions. Three vintages would allow 1,230 rows. The 26 missing rows are metro codes Census had not published yet in 2014 and 2019.

## The five problems

Every one of these failed silently. None of them threw an error.

| # | problem | symptom | fix | lesson |
| --- | --- | --- | --- | --- |
| 1 | CBSA code types did not match | the merge returned zero rows | cast the Census side to string | profile both sides of a join before merging |
| 2 | the 2010 ACS endpoint | errors on a variable set that worked from 2015 | dropped 2010 and moved to 2014, 2019 and 2024 | ACS codes and geographies before 2012 differ |
| 3 | duplicated HPI series | 3.77 rows per metro across three years | dropped `hpi_type` and `hpi_flavor` from the group keys | check rows per entity against what you expect |
| 4 | FHFA has no vintage parameter | the file hash moved with no code change | the raw file committed to git is the vintage | a source you cannot ask for by vintage has to be pinned by commit |
| 5 | the 13 largest metros were missing | Chicago, New York and Los Angeles never joined | pulled ACS at the division level and mapped 4 renamed codes | a housing study without Chicago is not a housing study |

Problem 1 took me the longest. I read it as a data availability problem until profiling both sides showed the same values stored as different types. The fix was one line.

Problem 4 showed up while I proved a clean run from scratch. Census reproduced byte for byte because every ACS endpoint carries its vintage in the URL. FHFA did not. Between May and September FHFA added two quarters and two columns and revised its history, so 1,094 merged values changed. I adopted the September pull in one commit, so `git log -- data/raw/fhfa/hpi_master.csv` shows both snapshots.

Problem 5 raised the join from 373 metros to all 410 FHFA codes. Division rows carry `geo_level` set to `division` and their parent code in `parent_cbsa`.

## The cleaning

| # | step | why |
| --- | --- | --- |
| 1 | lock the FHFA series to metro, quarterly, traditional, all transactions | several index variants per metro and year would duplicate Census rows in the merge |
| 2 | average quarters to a yearly mean per metro, with a count of quarters | FHFA is quarterly and Census is yearly |
| 3 | convert eight Census columns to numbers | the API returns strings and marks suppressed values with `-666666666` |
| 4 | cast the Census `cbsa_code` to string | to match FHFA, see problem 1 |
| 5 | derive `homeownership_rate` | a rate compares across metro sizes and a count does not |

After conversion each column is less than 1 percent null. The merge is an inner join that raises an error when it returns zero rows, which catches a boundary change before it writes an empty file.

## The findings

The top of the market changed between 2019 and 2024. In 2019 the top 15 was led by the Bay Area and Seattle: San Francisco-San Mateo-Redwood City at 441.8, San Jose at 418.5 and Seattle-Bellevue-Kent at 378.9. In 2024 it was led by the Miami-Miami Beach-Kendall division at 629.0, Bozeman MT at 610.2, St. Petersburg-Clearwater-Largo at 598.4, Charleston SC at 581.9 and Naples FL at 571.2. Salt Lake City, Boise and Portland OR are outside the top 15, at ranks 32, 27 and 57 of 410. Mountain towns and coastal Sun Belt markets replaced the Bay Area.

Population did not lose its link to price. On the 396 metros with all three vintages, its correlation with HPI was 0.27, 0.31 and 0.27. A paired test (Steiger, p 0.048) puts the move from 2019 to 2024 at the edge of significance, a wobble of about 0.04 that ended where it started.

Correlations at the 2024 vintage, Pearson r over all 410 metros and divisions:

| pair | r | reading |
| --- | --- | --- |
| median income and HPI | 0.50 | the strongest predictor that is not trivial |
| median home value and HPI | 0.67 | expected, HPI measures value growth |
| income and median home value | 0.82 | wealthy metros have expensive housing |
| homeownership rate and HPI | minus 0.10 | weak, and mostly the divisions, which own less and price higher |
| median age and homeownership | 0.63 | a life cycle effect that does not reach HPI |

The income and HPI scatter shows where prices outran local income: a cluster at HPI 545 to 610 with median income of 80k to 95k, which is Bozeman, Charleston, Naples and Bend.

Five charts are in `results/visualizations/`: the HPI distribution, income against HPI, homeownership against HPI, the top 15 and the correlation heatmap.

## Reproducing it

```bash
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
export CENSUS_API_KEY=your_key_here
snakemake --cores 1
```

Get a key at https://api.census.gov/data/key_signup.html. Without one the API returns an HTML page with a 200 status, which `download_census.py` catches.

| option | command |
| --- | --- |
| Snakemake | `snakemake --cores 1`, which reruns only what changed |
| wrapper | `python run_all.py` |
| by hand | `python scripts/download_fhfa.py`, then `download_census.py`, then `eda_integrate.py` |

Every manifest records the file, source, SHA-256, size, row count, vintage and a UTC timestamp. Census files reproduce exactly. FHFA files do not, because `hpi_master.csv` is live, so the committed copy is the snapshot this report describes. `snakemake --cores 1 --forcerun integrate` rebuilds from it without downloading.

## The bot and the map

`bot/` collects more sources on a GitHub Actions schedule and rebuilds the map data in `web/public/data/metros.json`. Each source is one collector in `bot/collectors/` that writes `data/raw/<source>/` with a manifest.

| source | adds |
| --- | --- |
| Census Gazetteer | metro centroids and the counties in each metro |
| Zillow | home values, rents, inventory, days to pending, price cuts |
| BLS | metro unemployment |
| FRED | the 30 year mortgage rate and 13 national indicators |
| Census ACS | rent, rent burden, vacancy, commute, poverty, labor force |
| Census | population estimates with migration, building permits |
| Realtor.com | listing data |
| IRS | migration between counties |
| BEA, HUD | personal income, fair market rents |

Divisions inherit metro sources from their parent and say so. HUD publishes for its own areas, so divisions are rebuilt from their counties, weighted by population. The map's settings and deploy steps are in [web/README.md](../web/README.md).

## The layout

```
loop/
|-- scripts/          download and integration
|-- data/raw/         one folder per source, each with a manifest
|-- data/integrated/  the merged output
|-- results/          5 charts
|-- ml/               the forecasting model, see ml/README.md
|-- bot/              collectors and the map data build
|-- web/              the React and Leaflet map
|-- tests/            run with python run_tests.py
|-- docs/REPORT.md    this file
|-- Snakefile         the workflow
`-- metadata.jsonld   a Schema.org description of the dataset
```

## The lifecycle

The DCC Curation Lifecycle Model, mapped to this project.

| phase | here |
| --- | --- |
| conceptualise | the project plan, research questions and dataset choice |
| create or receive | `scripts/download_fhfa.py`, `scripts/download_census.py` |
| appraise and select | the filter to metro, quarterly, traditional, all transactions |
| ingest | `data/raw/` with a SHA-256 manifest |
| preservation action | public domain inputs, MIT license, structured manifests |
| store | `data/raw/` and `data/integrated/` committed to GitHub |
| access, use, reuse | `README.md`, `Snakefile`, `run_all.py`, `metadata.jsonld` |
| transform | `scripts/eda_integrate.py` cleans, joins, derives and charts |

## Future work

- More features from the merged set: income to price ratio, education share, change between vintages.
- Synthetic scenarios from a small generative model, kept only if it beats simple conditional sampling.
- A DataCite record for a Zenodo deposit so the dataset can be found and cited.

`ml/MILESTONES.md` is the plan.

## References

Datasets

1. Federal Housing Finance Agency. *House Price Index Master File*. https://www.fhfa.gov/data/hpi/datasets?tab=master-hpi-data. Retrieved September 2026. Public domain.
2. U.S. Census Bureau. *American Community Survey 5-Year Estimates*. Vintages 2010 to 2014, 2015 to 2019, 2020 to 2024. https://www.census.gov/data/developers/data-sets/acs-5year.html. Public domain.

Methodology

3. U.S. Census Bureau. *When to Use 1-year, 3-year, or 5-year Estimates*. https://www.census.gov/programs-surveys/acs/guidance/estimates.html.
4. U.S. Census Bureau. *Comparing ACS Data*. https://www.census.gov/programs-surveys/acs/guidance/comparing-acs-data.html.
5. Office of Management and Budget. (2023). *2023 Standards for Delineating Core Based Statistical Areas (OMB Bulletin 23-01)*. https://www.census.gov/programs-surveys/metro-micro/about/omb-bulletins.html.
6. Federal Housing Finance Agency. *FHFA House Price Index Frequently Asked Questions*. https://www.fhfa.gov/faqs/hpi.
