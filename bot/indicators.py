# the national indicators the dashboard strip shows. one source of truth for
# the collector that downloads them and the build that shapes them for the map
#
# transform says how a tile's number is made from the raw series:
#   level    the observation as published, already a rate or an index
#   yoy      percent change over twelve months, for a price index
#   spread   this series minus the one named in against
#
# every series is public and keyless except through fred, which the bot
# already has a key for. the conference board consumer confidence index is a
# paid product and is not here; michigan sentiment is the free survey

# how many months of each tile's own history the build writes into the map. the
# chart offers five, ten and twenty five year ranges and a max, so the whole
# collected history has to reach it: cpi and unemployment start in 1954, 872
# months. the cap stays a guard at a century of months, so a series with a
# deeper start than those cannot grow the payload on its own
HISTORY_MONTHS = 1200

INDICATORS = [
    {
        "id": "cpi",
        "series": "CPIAUCSL",
        "label": "CPI, all items",
        "group": "Prices",
        "transform": "yoy",
        "format": "pct",
        "provider": "BLS via FRED",
        "note": "consumer price index for all urban consumers, change over twelve months",
    },
    {
        "id": "core_cpi",
        "series": "CPILFESL",
        "label": "Core CPI",
        "group": "Prices",
        "transform": "yoy",
        "format": "pct",
        "provider": "BLS via FRED",
        "note": "consumer prices less food and energy, change over twelve months",
    },
    {
        "id": "core_pce",
        "series": "PCEPILFE",
        "label": "Core PCE",
        "group": "Prices",
        "transform": "yoy",
        "format": "pct",
        "provider": "BEA via FRED",
        "note": "the price measure the federal reserve targets at two percent, less food and energy",
    },
    {
        "id": "ppi",
        "series": "PPIFIS",
        "label": "PPI, final demand",
        "group": "Prices",
        "transform": "yoy",
        "format": "pct",
        "provider": "BLS via FRED",
        "note": "producer prices for final demand, change over twelve months",
    },
    {
        "id": "core_ppi",
        "series": "PPIFES",
        "label": "Core PPI",
        "group": "Prices",
        "transform": "yoy",
        "format": "pct",
        "provider": "BLS via FRED",
        "note": "producer prices for final demand less foods and energy, change over twelve months",
    },
    {
        "id": "fed_funds",
        "series": "DFEDTARU",
        "label": "Fed funds target",
        "group": "Rates",
        "transform": "level",
        "format": "rate",
        "provider": "Federal Reserve via FRED",
        "note": "upper limit of the federal funds target range",
    },
    {
        "id": "rate_path",
        "series": "DGS1",
        "against": "EFFR",
        "label": "Priced rate change, 1 year",
        "group": "Rates",
        "transform": "spread",
        "format": "rate",
        "provider": "Treasury and Federal Reserve via FRED",
        "note": "one year treasury yield less the effective fed funds rate, the average policy change the market prices over the next year. it carries a term premium, so it is a proxy and not a probability",
    },
    {
        "id": "mortgage",
        "series": "MORTGAGE30US",
        "label": "30 year mortgage",
        "group": "Rates",
        "transform": "level",
        "format": "rate",
        "provider": "Freddie Mac via FRED",
        "note": "average rate on a 30 year fixed mortgage",
    },
    {
        "id": "treasury_10y",
        "series": "DGS10",
        "label": "10 year Treasury",
        "group": "Rates",
        "transform": "level",
        "format": "rate",
        "provider": "Treasury via FRED",
        "note": "market yield on the ten year treasury note",
    },
    {
        "id": "sentiment",
        "series": "UMCSENT",
        "label": "Consumer sentiment",
        "group": "Consumers",
        "transform": "level",
        "format": "index",
        "provider": "University of Michigan via FRED",
        "note": "university of michigan survey of consumers, 1966 first quarter equals 100",
    },
    {
        "id": "inflation_expected",
        "series": "MICH",
        "label": "Inflation expected, 1 year",
        "group": "Consumers",
        "transform": "level",
        "format": "pct",
        "provider": "University of Michigan via FRED",
        "note": "what households in the michigan survey expect prices to do over the next year",
    },
    {
        "id": "unemployment",
        "series": "UNRATE",
        "label": "Unemployment",
        "group": "Consumers",
        "transform": "level",
        "format": "pct",
        "provider": "BLS via FRED",
        "note": "national unemployment rate, seasonally adjusted",
    },
    {
        "id": "retail_sales",
        "series": "RRSFS",
        "label": "Real retail sales",
        "group": "Consumers",
        "transform": "yoy",
        "format": "pct",
        "provider": "Census via FRED",
        "note": "retail and food services sales adjusted for prices, change over twelve months",
    },
]

GROUPS = ["Prices", "Rates", "Consumers"]

# every fred series the collector downloads, including the ones that only
# appear as the right hand side of a spread
def series_ids():
    ids = []
    for spec in INDICATORS:
        for key in ("series", "against"):
            name = spec.get(key)
            if name and name not in ids:
                ids.append(name)
    return ids


def by_id(indicator_id):
    for spec in INDICATORS:
        if spec["id"] == indicator_id:
            return spec
    raise KeyError(indicator_id)
