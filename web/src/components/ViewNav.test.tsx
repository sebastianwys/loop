import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ViewTab } from "../lib/views";
import { ViewNav } from "./ViewNav";

// no dom in this suite, so the markup is read as a string. the registry
// itself is not imported here: it pulls in the map, and with it leaflet

const tabs: ViewTab[] = [
  { id: "map", label: "Map", title: "every metro on one map" },
  { id: "compare", label: "Compare", title: "two to four metros side by side" },
];

const nav = (current: ViewTab["id"], views = tabs) =>
  renderToStaticMarkup(
    <ViewNav views={views} current={current} href={(id) => `?view=${id}`} onChange={() => {}} />,
  );

describe("the view switch", () => {
  it("is a real link per view, so a middle click opens one in a tab", () => {
    const markup = nav("map");
    expect(markup).toContain('href="?view=map"');
    expect(markup).toContain('href="?view=compare"');
    expect(markup).toContain('aria-label="views"');
  });

  it("marks the view being read, and only that one", () => {
    expect(nav("compare").split('aria-current="page"')).toHaveLength(2);
    expect(nav("compare")).toContain('aria-current="page">Compare');
  });

  it("draws nothing at all while there is only one view to be in", () => {
    expect(nav("map", tabs.slice(0, 1))).toBe("");
  });
});
