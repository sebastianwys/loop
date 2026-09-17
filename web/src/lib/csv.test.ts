import { describe, expect, it } from "vitest";
import {
  RANKING_HEADER, browserHost, csvFilename, downloadCsv, escapeField, rankingCsv, slug, toCsv,
  type DownloadHost, type DownloadLink,
} from "./csv";
import { SAMPLE } from "./data";
import { metricById } from "./metrics";
import type { Ranked } from "./rank";

describe("escapeField", () => {
  it("leaves a plain value alone", () => {
    expect(escapeField("Abilene")).toBe("Abilene");
    expect(escapeField(1160)).toBe("1160");
  });

  it("quotes a value containing a comma", () => {
    expect(escapeField("Abilene, TX")).toBe('"Abilene, TX"');
  });

  it("quotes a value containing a double quote and doubles the quote", () => {
    expect(escapeField('the "expanded" index')).toBe('"the ""expanded"" index"');
  });

  it("quotes a value containing a newline", () => {
    expect(escapeField("two\nlines")).toBe('"two\nlines"');
    expect(escapeField("two\r\nlines")).toBe('"two\r\nlines"');
  });

  it("writes a null value as an empty field rather than the word null", () => {
    expect(escapeField(null)).toBe("");
    expect(escapeField(undefined)).toBe("");
  });

  it("writes a value that is not a finite number as an empty field", () => {
    expect(escapeField(Number.NaN)).toBe("");
    expect(escapeField(Number.POSITIVE_INFINITY)).toBe("");
  });

  it("keeps a negative number and a zero, which are values rather than gaps", () => {
    expect(escapeField(-3.4)).toBe("-3.4");
    expect(escapeField(0)).toBe("0");
  });
});

describe("toCsv", () => {
  it("writes the header first and ends every line with a carriage return and a newline", () => {
    const text = toCsv(["a", "b"], [[1, 2], [3, 4]]);
    expect(text).toBe("a,b\r\n1,2\r\n3,4\r\n");
  });

  it("keeps a quoted field with a newline in it on one logical row", () => {
    const text = toCsv(["note"], [["two\nlines"]]);
    expect(text).toBe('note\r\n"two\nlines"\r\n');
    // the only record separator is the crlf, so the embedded lf is not one
    expect(text.split("\r\n").filter(Boolean)).toHaveLength(2);
  });

  it("writes a header alone when there are no rows", () => {
    expect(toCsv(["a"], [])).toBe("a\r\n");
  });
});

describe("rankingCsv", () => {
  const metric = metricById("hpi_19_24");
  const ranked: Ranked[] = [
    { metro: SAMPLE.metros[1], value: 0.4321 },
    { metro: SAMPLE.metros[0], value: -0.05 },
  ];

  it("names its columns and one row per metro in the order the ranking is in", () => {
    const lines = rankingCsv(ranked, metric).trim().split("\r\n");
    expect(lines[0]).toBe(RANKING_HEADER.join(","));
    expect(lines).toHaveLength(3);
    expect(lines[1].startsWith("1,19100,")).toBe(true);
    expect(lines[2].startsWith("2,10180,")).toBe(true);
  });

  it("quotes the metro name, which carries a comma for every metro in the build", () => {
    const text = rankingCsv(ranked, metric);
    expect(text).toContain('"Dallas-Fort Worth-Arlington, TX"');
    expect(text).toContain('"Abilene, TX"');
  });

  it("carries the raw value and the string the site displays, so a rounded number is checkable", () => {
    const row = rankingCsv(ranked, metric).trim().split("\r\n")[1];
    expect(row).toContain("0.4321");
    expect(row.endsWith("+43.2%")).toBe(true);
  });

  it("quotes the metric label, which carries a comma of its own", () => {
    expect(rankingCsv(ranked, metric)).toContain('"HPI growth, 2019 to 2024"');
  });

  it("leaves the period empty for a change metric that has none", () => {
    const row = rankingCsv(ranked, metric).trim().split("\r\n")[1];
    expect(row).toContain('"HPI growth, 2019 to 2024",,');
  });

  // the animated timeline hands the ranking a metric that borrows the index's
  // definition and carries year over year growth. reading def.label there put
  // percent changes under the heading "House price index"
  it("names the metric as it was resolved, not as its definition reads", () => {
    const index = metricById("hpi_latest");
    const animated = { ...index, label: "House price index growth, 2020 to 2021", period: null };
    const text = rankingCsv([{ metro: SAMPLE.metros[0], value: 0.07 }], animated);
    expect(text).toContain('"House price index growth, 2020 to 2021"');
    expect(text).not.toContain("House price index,");
    expect(animated.def.label).toBe("House price index");
  });

  it("writes the period a metric was read at", () => {
    const text = rankingCsv([{ metro: SAMPLE.metros[0], value: 200 }], metricById("hpi_2019"));
    expect(text.trim().split("\r\n")[1]).toContain(",2019,200,");
  });

  it("is a header alone when nothing has a value", () => {
    expect(rankingCsv([], metric)).toBe(`${RANKING_HEADER.join(",")}\r\n`);
  });
});

describe("csvFilename", () => {
  it("names the file after the metric and the period", () => {
    expect(csvFilename("House price index", "latest")).toBe("loop-house-price-index-latest.csv");
    expect(csvFilename("Median home value", "2024")).toBe("loop-median-home-value-2024.csv");
  });

  it("drops the period for a metric that has none", () => {
    expect(csvFilename("HPI growth, 2019 to 2024", null)).toBe("loop-hpi-growth-2019-to-2024.csv");
  });

  it("falls back to a usable name when the label slugs down to nothing", () => {
    expect(csvFilename("...", null)).toBe("loop-ranking.csv");
    expect(csvFilename("", "2014")).toBe("loop-ranking-2014.csv");
  });

  it("slugs a label with punctuation, capitals and runs of spaces", () => {
    expect(slug("  Renters paying 30% or more of income  ")).toBe("renters-paying-30-or-more-of-income");
  });
});

describe("downloadCsv", () => {
  function fake() {
    const calls: string[] = [];
    const link: DownloadLink = { href: "", download: "", click: () => calls.push("click") };
    const deferred: (() => void)[] = [];
    const host: DownloadHost = {
      createObjectURL: () => { calls.push("create"); return "blob:loop/1"; },
      revokeObjectURL: (url) => calls.push(`revoke ${url}`),
      createLink: () => link,
      defer: (fn) => { deferred.push(fn); },
    };
    return { calls, link, host, run: () => deferred.forEach((fn) => fn()) };
  }

  it("clicks a link carrying the object url and the file name", () => {
    const { link, host } = fake();
    downloadCsv("a,b\r\n", "loop-thing.csv", host);
    expect(link.href).toBe("blob:loop/1");
    expect(link.download).toBe("loop-thing.csv");
  });

  it("revokes the object url it made, but only after the click", () => {
    const { calls, host, run } = fake();
    downloadCsv("a,b\r\n", "loop-thing.csv", host);
    expect(calls).toEqual(["create", "click"]);
    run();
    expect(calls).toEqual(["create", "click", "revoke blob:loop/1"]);
  });
});

describe("browserHost", () => {
  // the suite runs in node, which is the case this guard exists for
  it("is null when there is no document to hang a link on", () => {
    expect(browserHost()).toBeNull();
  });
});
