import { useMemo, useState } from "react";
import { visibleDefs } from "../lib/metrics";
import { buildSources, safeUrl, shortHash, stamp, type SourceRow } from "../lib/sources";
import type { ViewProps } from "../lib/views";
import "../styles/sources.css";

const count = (n: number) => n.toLocaleString("en-US");

const day = (iso: string | null) => (iso === null ? "" : stamp(iso).slice(0, 10));

// a small count opening a sentence reads as a word, not as a digit
const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const opener = (n: number) => {
  const word = n >= 0 && n < WORDS.length ? WORDS[n] : count(n);
  return word.charAt(0).toUpperCase() + word.slice(1);
};

// the manifest url, as a link when it is an http address and as plain text
// when it is not. a parameter that reads like a credential never gets here
function Address({ url }: { url: string }) {
  const safe = safeUrl(url);
  return (
    <>
      {safe.href === null
        ? <code className="url">{safe.text}</code>
        : <a className="url" href={safe.href} target="_blank" rel="noreferrer">{safe.text}</a>}
      {safe.stripped.length > 0 && (
        <span className="stripped">{safe.stripped.join(" and ")} removed before this was shown</span>
      )}
    </>
  );
}

// the checksum cell. sixteen sha256 values is a wall of hex, so each is cut to
// twelve characters with the whole of it a button or a toggle away
function Checksum({ row, full, onCopy }: { row: SourceRow; full: boolean; onCopy: (row: SourceRow) => void }) {
  const { filename, sha256 } = row.entry;
  return (
    <>
      <code className="file">{filename}</code>
      <span className="sha">
        <code>{full ? sha256 : shortHash(sha256)}</code>
        <button type="button" className="copy" aria-label={`copy the sha256 of ${row.entry.source}/${filename}`} onClick={() => onCopy(row)}>
          copy
        </button>
      </span>
    </>
  );
}

// where every number on this site comes from: the publisher, the address it
// was fetched from, the vintage, the moment it was fetched, how many rows
// arrived, and the sha256 of the file the number was read out of
export function SourcesPage({ data, go }: ViewProps) {
  const [full, setFull] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);

  const report = useMemo(() => buildSources(data), [data]);
  const forecasts = useMemo(() => visibleDefs(data.metros).filter((d) => d.source === "forecast"), [data.metros]);
  const vintages = Object.entries(data.sources ?? {});
  const modelVintage = data.sources?.forecast ?? null;
  const blank = report.rows.filter((r) => r.metrics.length === 0).length;
  // a source id can have more than one folder behind it, so the page names
  // which rather than leaving a reader to spot the repeat
  const shared = useMemo(() => {
    const seen = new Map<string, number>();
    for (const row of report.rows) if (row.source) seen.set(row.source, (seen.get(row.source) ?? 0) + 1);
    return [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id);
  }, [report.rows]);

  // a browser that refuses the clipboard still has to leave the value
  // reachable, so a refusal opens the full checksums to select by hand
  const refuse = () => { setFull(true); setCopied(null); setDenied(true); };

  const copy = (row: SourceRow) => {
    const clip = typeof navigator === "undefined" ? null : navigator.clipboard;
    if (!clip || typeof clip.writeText !== "function") return refuse();
    clip.writeText(row.entry.sha256).then(
      () => { setCopied(row.entry.source); setDenied(false); },
      refuse,
    );
  };

  const status = denied ? "this browser did not allow a copy, so the full checksums are shown to select"
    : copied === null ? "" : `the ${copied} checksum is on the clipboard`;

  return (
    <main className="sources-page">
      <div className="sources-inner">
        <div className="sources-head">
          <h2>Where every number comes from</h2>
          <p className="sources-note">
            Nothing on this site is typed in by hand. Every source was fetched once, written to a named file
            and hashed, and the pipeline records what it got rather than what it asked for. The table below is
            that record: the publisher, the address, the vintage, the moment of the download, the rows that
            arrived and the sha256 of the file each number was read out of.
          </p>
        </div>

        {report.rows.length === 0 ? (
          <>
            <p className="sources-empty">
              This build of metros.json carries no provenance block, which is what a build made before the block
              was added looks like, and what the bundled sample data is. The vintages it does carry are below,
              but there is no checksum to show and this page will not invent one.
            </p>
            {vintages.length > 0 && (
              <div className="sources-scroll">
                <table className="feeds-table">
                  <caption className="sr">the source vintages this build carries</caption>
                  <thead>
                    <tr>
                      <th scope="col">source</th>
                      <th scope="col">vintage</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vintages.map(([name, version]) => (
                      <tr key={name}>
                        <th scope="row"><code>{name}</code></th>
                        <td>{version ?? "not loaded"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : (
          <>
            <ul className="sources-stats">
              <li><b>{report.rows.length}</b> sources</li>
              <li><b>{count(report.files)}</b> files</li>
              <li><b>{count(report.rowCount)}</b> rows</li>
              <li>fetched <b>{day(report.oldest)}</b> to <b>{day(report.newest)}</b></li>
              <li>built <b>{stamp(data.generated_at)}</b></li>
            </ul>

            <div className="sources-controls">
              <button type="button" className="linkish" aria-pressed={full} onClick={() => setFull((f) => !f)}>
                {full ? "shorten the checksums" : "show the full checksums"}
              </button>
              <p className="sources-status" role="status">{status}</p>
            </div>

            <div className="sources-scroll">
              <table className="sources-table">
                <caption className="sr">
                  every raw download in this build, with its publisher, address, vintage, size and sha256
                </caption>
                <thead>
                  <tr>
                    <th scope="col">source</th>
                    <th scope="col">address</th>
                    <th scope="col">vintage</th>
                    <th scope="col">downloaded</th>
                    <th scope="col" className="v">files</th>
                    <th scope="col" className="v">rows</th>
                    <th scope="col">file and sha256</th>
                  </tr>
                </thead>
                <tbody>
                  {report.rows.map((row) => (
                    <tr key={row.entry.source}>
                      <th scope="row">
                        <code>{row.entry.source}</code>
                        <span className="who">{row.entry.provider}</span>
                      </th>
                      <td><Address url={row.entry.url} /></td>
                      <td>{row.entry.version}</td>
                      <td className="when">{stamp(row.entry.downloaded_at)}</td>
                      <td className="v">{count(row.entry.files)}</td>
                      <td className="v">{count(row.entry.row_count)}</td>
                      <td className="hash"><Checksum row={row} full={full} onCopy={copy} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="sources-foot">
              The file count and the row count cover the whole folder. The sha256 belongs to the one file named
              beside it, which is the file the metrics in the next table were read out of.
            </p>

            <div className="sources-head">
              <h3>What each source builds</h3>
              <p className="sources-note">
                The folder names above are the pipeline's, not the site's, and they do not all line up.
                {shared.length > 0 ? ` More than one folder feeds ${shared.join(" and ")} here.` : ""}
                {blank > 0 ? ` ${blank === 1 ? "One folder builds" : `${opener(blank)} folders build`} no metric at all: they are what the map is drawn on and what the header reports, so they are named rather than left blank.` : ""}
              </p>
            </div>

            <div className="sources-scroll">
              <table className="feeds-table">
                <caption className="sr">the metrics this site builds out of each source</caption>
                <thead>
                  <tr>
                    <th scope="col">source</th>
                    <th scope="col">on this site</th>
                    <th scope="col">what it builds</th>
                  </tr>
                </thead>
                <tbody>
                  {report.rows.map((row) => (
                    <tr key={row.entry.source}>
                      <th scope="row"><code>{row.entry.source}</code></th>
                      <td>{row.label ?? "no metric"}</td>
                      <td>
                        {row.metrics.length > 0 ? (
                          <ul className="metric-list">
                            {row.metrics.map((def) => <li key={def.id}>{def.label}</li>)}
                          </ul>
                        ) : (
                          <span className="role">{row.role ?? "nothing on this site reads it"}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {forecasts.length > 0 && (
          <div className="sources-model">
            <h3>The forecast is computed here, not downloaded</h3>
            <p>
              {opener(forecasts.length)} of the metrics on this site are written by the forecasting model in
              the repository's ml directory rather than fetched from a publisher. It is the one row above with
              no address to follow, because nothing was downloaded for it: the address column names the code
              that wrote the file instead of a publisher's url.
            </p>
            <ul className="metric-list">
              {forecasts.map((def) => <li key={def.id}>{def.label}</li>)}
            </ul>
            <p>
              It is checkable the same way as the rest. The model is fit on the sources this build records,
              and its export writes a manifest of its own at ml/results/forecast/download_manifest.json in the
              same shape as the download manifests this page is built from, so the hash in the table above is
              the hash of the file the site reads. That manifest carries one thing the table has no column
              for: the checksums of the three artifacts the export was computed from.
              {modelVintage ? ` This build reads the ${modelVintage} export.` : ""}
            </p>
            {report.rows.length > 0 && (
              <p>
                One number in that file is not the model's. The index standard error is FHFA's own, published
                beside the expanded index, and it rides in the model's export only because nothing else
                carries it. It is listed under fhfa above, where it came from.
              </p>
            )}
            <p>
              <button type="button" className="linkish" onClick={() => go({ view: "model" })}>
                How the model is built and judged
              </button>
            </p>
          </div>
        )}

        <p className="sources-foot">
          Every file named above is in the repository beside the download manifest this page is built from,
          under data/raw in the folder the source column names, and under ml/results for the one the model
          computed. Running a sha256 over that file returns the value in the last column, which is what makes
          the rest of this site checkable rather than trustable.
        </p>
      </div>
    </main>
  );
}
