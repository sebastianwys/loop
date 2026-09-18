# is477-sp26 workflow
# does the same as run_all.py but tracks file deps so it only re-runs what changed

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


# rule all = the final outputs we want
rule all:
    input:
        "data/integrated/hpi_census_merged.csv",
        "results/visualizations/hpi_distribution.png",
        "results/visualizations/income_vs_hpi.png",
        "results/visualizations/homeownership_vs_hpi.png",
        "results/visualizations/top15_metros_hpi.png",
        "results/visualizations/correlation_matrix.png"


# pull fhfa files and write manifest. a failed job deletes every output it
# finds, and hpi_master.csv has no vintage parameter, so the archived copy is
# the only copy of that vintage. the rule owns a marker and the collector writes
# the archive beside it, which leaves the refusal to overwrite where it belongs
rule download_fhfa:
    output:
        touch("data/raw/fhfa/.download_complete")
    shell:
        f"{PYTHON} scripts/download_fhfa.py"


# pull the pinned acs vintages, build combined csv, write manifest. the archive
# is a side effect here too, a retired end year cannot be fetched again either
rule download_census:
    output:
        touch("data/raw/census/.download_complete")
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
