# run every collector, keep going past failures, then rebuild the map data.
# from the repo root:  python -m bot.run_bot

import importlib
import pkgutil
import sys

from bot import build_map_data
from bot import collectors as collectors_pkg


# every module in bot/collectors with a collect() runs. gazetteer goes first
# because bls and the build key on its centroids, the rest alphabetically
def discover():
    names = sorted(module.name for module in pkgutil.iter_modules(collectors_pkg.__path__))
    ordered = ["gazetteer"] + [name for name in names if name != "gazetteer"]
    found, broken = [], []
    for name in ordered:
        # a module that will not import is one failed collector, not a reason
        # to lose the whole run before the first one has been given a turn
        try:
            module = importlib.import_module(f"bot.collectors.{name}")
        except Exception as e:
            print(f"[{name}] FAILED to import {type(e).__name__}: {e}")
            broken.append(name)
            continue
        if callable(getattr(module, "collect", None)):
            found.append((name, module.collect))
    return found, broken


def main():
    collectors, failures = discover()
    for name, collect in collectors:
        try:
            collect()
        except Exception as e:
            print(f"[{name}] FAILED {type(e).__name__}: {e}")
            failures.append(name)

    build_map_data.build()

    if failures:
        print(f"collectors failed: {failures}")
        sys.exit(1)
    print("bot run complete")


if __name__ == "__main__":
    main()
