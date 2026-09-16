import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CHART_W, DETAIL_ID, SPARK_H, SPARK_W, changeChip, chartTitle, groupIndicators, indicatorSpark, indicatorValue,
  monthLabel, sourceLine, tileId, tileReadout,
} from "../lib/indicators";
import { scrollEdges, type ScrollEdges } from "../lib/layout";
import type { Indicator } from "../types";
import { IndicatorChart } from "./IndicatorChart";

interface TileProps {
  indicator: Indicator;
  expanded: boolean;
  onToggle: () => void;
}

// one national figure: the label, the value, how far it moved over a year
// and the shape of the history. the chip names the direction in a word, so
// its color only repeats what the text already says
function Tile({ indicator, expanded, onToggle }: TileProps) {
  const chip = changeChip(indicator.change_12m);
  const spark = indicatorSpark(indicator.history);
  const newest = spark?.points[spark.points.length - 1];
  const title = chartTitle(indicator);
  return (
    <button
      type="button"
      className={`ind-tile${expanded ? " open" : ""}`}
      id={tileId(indicator.id)}
      data-ind={indicator.id}
      aria-expanded={expanded}
      aria-controls={DETAIL_ID}
      aria-label={tileReadout(indicator)}
      title={indicator.note}
      onClick={onToggle}
    >
      <span className="name">{indicator.label}</span>
      <span className="read">
        <span className="value">{indicatorValue(indicator)}</span>
        {spark && newest && (
          <svg
            className="ind-spark"
            width={SPARK_W}
            height={SPARK_H}
            viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
            role="img"
            aria-label={title}
          >
            <title>{title}</title>
            <path className="line" d={spark.d} />
            <circle className="dot" cx={newest.x} cy={newest.y} r={2} />
          </svg>
        )}
      </span>
      <span className="foot">
        <span className={`chip ${chip.direction}`}>
          {chip.text}
          {chip.word && <span className="word">{chip.word}</span>}
        </span>
        <span className="when">{monthLabel(indicator.date)}</span>
      </span>
    </button>
  );
}

interface DetailProps {
  indicator: Indicator;
  width: number;
  onClose: () => void;
}

// the one expanded row: the full history as a chart, what the series is,
// who publishes it and the months shown
export function IndicatorDetail({ indicator, width, onClose }: DetailProps) {
  const when = monthLabel(indicator.date);
  return (
    <div className="ind-detail" role="region" aria-label={`${indicator.label}, the full history`}>
      <div className="ind-detail-head">
        <span className="name">{indicator.label}</span>
        <span className="read">
          {indicatorValue(indicator)}
          {when && <span className="when"> in {when}</span>}
        </span>
        <button type="button" className="close" aria-label="close the indicator detail" onClick={onClose}>
          x
        </button>
      </div>
      <IndicatorChart indicator={indicator} width={width} />
      {indicator.note && <p className="ind-note">{indicator.note}</p>}
      <p className="ind-source">{sourceLine(indicator)}</p>
    </div>
  );
}

interface Props {
  indicators: Indicator[];
}

// the national figures under the title line: one scrolling row of tiles in
// three groups, and one detail row that any tile opens. with no indicators
// in the build it renders nothing and the header keeps its old shape
export function NationalStrip({ indicators }: Props) {
  const blocks = useMemo(() => groupIndicators(indicators), [indicators]);
  const [open, setOpen] = useState<string | null>(null);
  const [width, setWidth] = useState(CHART_W);
  const [edges, setEdges] = useState<ScrollEdges>({ left: false, right: false });
  const row = useRef<HTMLDivElement>(null);
  const detail = useRef<HTMLDivElement>(null);

  // a narrow window hides most of the row, so the fades and the two step
  // buttons say which way it still runs
  const readEdges = useCallback(() => {
    const el = row.current;
    if (el) setEdges(scrollEdges(el.scrollLeft, el.scrollWidth, el.clientWidth));
  }, []);

  useEffect(() => {
    const el = row.current;
    if (!el) return;
    readEdges();
    el.addEventListener("scroll", readEdges, { passive: true });
    const watch = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(readEdges);
    watch?.observe(el);
    return () => {
      el.removeEventListener("scroll", readEdges);
      watch?.disconnect();
    };
  }, [readEdges, blocks.length]);

  const step = (direction: 1 | -1) => {
    const el = row.current;
    el?.scrollBy({ left: direction * Math.max(180, el.clientWidth * 0.8), behavior: "smooth" });
  };

  // the expanded chart runs the width of the strip, so it is measured
  // rather than fixed, and follows the window
  useEffect(() => {
    const el = detail.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => setWidth(Math.max(240, Math.round(el.clientWidth)));
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, [blocks.length]);

  if (blocks.length === 0) return null;

  const current = indicators.find((i) => i.id === open) ?? null;

  const close = () => {
    setOpen(null);
    if (open) row.current?.querySelector<HTMLButtonElement>(`[data-ind="${open}"]`)?.focus();
  };

  // escape closes the detail row and stops there, so the map keeps its
  // selection
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Escape" || !current) return;
    e.stopPropagation();
    close();
  };

  // left and right walk the row, across the group breaks
  const onRowKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const tiles = Array.from(row.current?.querySelectorAll<HTMLButtonElement>("button.ind-tile") ?? []);
    const at = tiles.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    e.preventDefault();
    tiles[at + (e.key === "ArrowRight" ? 1 : -1)]?.focus();
  };

  return (
    <div className="strip" onKeyDown={onKeyDown}>
      <div className="strip-scroll">
        <span className={`strip-fade left${edges.left ? " on" : ""}`} aria-hidden="true" />
        <span className={`strip-fade right${edges.right ? " on" : ""}`} aria-hidden="true" />
        <button
          type="button"
          className={`strip-nav prev${edges.left ? " shown" : ""}`}
          aria-label="scroll the national figures left"
          tabIndex={-1}
          onClick={() => step(-1)}
        >
          <svg width="8" height="10" viewBox="0 0 8 10" aria-hidden="true"><polygon points="6.5,0.5 6.5,9.5 1,5" /></svg>
        </button>
        <button
          type="button"
          className={`strip-nav next${edges.right ? " shown" : ""}`}
          aria-label="scroll the national figures right"
          tabIndex={-1}
          onClick={() => step(1)}
        >
          <svg width="8" height="10" viewBox="0 0 8 10" aria-hidden="true"><polygon points="1.5,0.5 1.5,9.5 7,5" /></svg>
        </button>
        <div className="strip-row" ref={row} onKeyDown={onRowKeyDown}>
          {blocks.map((block) => (
            <div className="ind-group" key={block.group}>
              <span className="group-label" id={block.id}>{block.group}</span>
              <div className="tiles" role="group" aria-labelledby={block.id}>
                {block.indicators.map((indicator) => (
                  <Tile
                    key={indicator.id}
                    indicator={indicator}
                    expanded={indicator.id === open}
                    onToggle={() => setOpen(indicator.id === open ? null : indicator.id)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="strip-detail" id={DETAIL_ID} ref={detail}>
        {current && <IndicatorDetail key={current.id} indicator={current} width={width} onClose={close} />}
      </div>
    </div>
  );
}
