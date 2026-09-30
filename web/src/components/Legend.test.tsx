import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { metricById, type Withheld } from "../lib/metrics";
import { buildScale } from "../lib/scale";
import { Legend } from "./Legend";

// no dom in this suite, so the markup is read as a string
const metric = metricById("income_14_24");
const scale = buildScale([-5, 0, 5, 10, 15, 20], metric.kind);
const key = (withheld: Withheld | null) =>
  renderToStaticMarkup(<Legend scale={scale} metric={metric} caption="Source: ACS" withheld={withheld} />);

// a blank the build withheld is a different claim from no data, so whenever
// the map shows one the key gives it a row of its own, with why
describe("the map legend", () => {
  it("keys a withheld blank apart from no data, with the reason", () => {
    const markup = key("footprint");
    expect(markup).toContain("no data");
    expect(markup).toContain('class="sw withheld"');
    expect(markup).toContain("withheld, county lines moved");
    expect(key("permits")).toContain("withheld, counted over different counties");
  });

  it("has no withheld row when nothing on the map is withheld", () => {
    expect(key(null)).not.toContain("withheld");
    expect(key(null)).toContain("no data");
  });
});
