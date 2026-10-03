# is477-sp26 workflow
# does the same as run_all.py but tracks file deps so it only reruns what changed

import json
import sys
from pathlib import Path

# python that started snakemake. same one runs each rule
PYTHON = sys.executable

# acs end years come from the pinned vintages file so the dag matches what the
# downloader writes. the fallback only applies before the first pin exists
VINTAGES_FILE = Path("data/raw/census/vintages.json")
if VINTAGES_FILE.exists():
    CENSUS_YEARS = json.loads(VINTAGES_FILE.read_text())["years"]
else:
    CENSUS_YEARS = [2014, 2019, 2024]

# what each collector writes, the archive the report lists with the outputs
FHFA_ARCHIVE = [
    "data/raw/fhfa/hpi_master.csv",
    "data/raw/fhfa/hpi_exp_metro.txt",
    "data/raw/fhfa/download_manifest.json",
]
CENSUS_ARCHIVE = expand("data/raw/census/acs_5yr_{year}.csv", year=CENSUS_YEARS) + [
    "data/raw/census/acs_5yr_combined.csv",
    "data/raw/census/download_manifest.json",
]


# rule all = the final outputs we want. the archive is one of them, so a
# missing file is fetched again even when the merged csv is still current
rule all:
    input:
        FHFA_ARCHIVE,
        CENSUS_ARCHIVE,
        "data/integrated/hpi_census_merged.csv",
        "results/visualizations/hpi_distribution.png",
        "results/visualizations/income_vs_hpi.png",
        "results/visualizations/homeownership_vs_hpi.png",
        "results/visualizations/top15_metros_hpi.png",
        "results/visualizations/correlation_matrix.png"


# pull fhfa files and write manifest. hpi_master.csv has no vintage parameter,
# so the archived copy is the only copy of that vintage. snakemake deletes a
# job's outputs before it runs and again when it fails, which would undo the
# collector's refusal to overwrite. update() stops both: the archive stays put
# while the rule runs, and a failed run copies it back from a backup snakemake
# took first. the bytes come back unchanged but the mtime is new, so the next
# plain run reruns integrate over the same inputs. the files are still the
# outputs, so a missing one schedules the download and a whole archive does not
rule download_fhfa:
    output:
        update(FHFA_ARCHIVE)
    shell:
        f"{PYTHON} scripts/download_fhfa.py"


# pull the pinned acs vintages, build combined csv, write manifest. flagged the
# same way, a retired end year cannot be fetched again either
rule download_census:
    output:
        update(CENSUS_ARCHIVE)
    shell:
        f"{PYTHON} scripts/download_census.py"


# load both, clean, merge on cbsa+year, write csv and 5 charts
rule integrate:
    input:
        "data/raw/fhfa/hpi_master.csv",
        "data/raw/census/acs_5yr_combined.csv"
    output:
        "data/integrated/hpi_census_merged.csv",
        "results/visualizations/hpi_distribution.png",
        "results/visualizations/income_vs_hpi.png",
        "results/visualizations/homeownership_vs_hpi.png",
        "results/visualizations/top15_metros_hpi.png",
        "results/visualizations/correlation_matrix.png"
    shell:
        f"{PYTHON} scripts/eda_integrate.py"
