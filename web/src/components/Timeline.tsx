import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { MetricDef } from "../lib/metrics";
import {
  buildTimeline, frameIndex, frameName, frameText, nextFrame, nextPeriod, prevPeriod,
  type DeepTimeline, type TimelineTick,
} from "../lib/timeline";
import type { Metro, Period } from "../types";
import "../styles/timeline.css";

interface Props {
  def: MetricDef;
  metros: Metro[];
  period: Period | null;
  available: Period[];
  onPeriodChange: (period: Period) => void;
}

// milliseconds each period stays on the map while playing
export const PLAY_MS = 1200;

// fifty years of frames, so a year cannot hold the screen for a second. about
// four a second, near the rate the map repaints a full set of markers
export const YEAR_MS = 260;

// a reader who asks for less motion gets stepping rather than an animation,
// and never gets it without pressing play
export const YEAR_MS_REDUCED = 900;

const pct = (t: number) => `${(t * 100).toFixed(2)}%`;

function tickTitle(tick: TimelineTick, total: number): string {
  if (!tick.available) return "not published for this period";
  const when = tick.period === "latest" && tick.date ? `latest, ${tick.label}` : tick.label;
  return total > 0 ? `${when}: ${tick.count} of ${total} metros have a value` : when;
}

export interface YearScrub {
  // the run behind the metric on screen, null when it has none
  deep: DeepTimeline | null;
  year: number | null;
  onYearChange: (year: number) => void;
  reducedMotion: boolean;
}

// the animated year belongs to whatever colours the map, since the colours
// are what has to change with it. the sidebar in between knows nothing about
// a year, so it travels by context rather than through props it would have
// to carry and forward
export const YearScrubContext = createContext<YearScrub | null>(null);

interface YearsProps {
  deep: DeepTimeline;
  year: number | null;
  onYearChange: (year: number) => void;
  reducedMotion: boolean;
}

// the year control for a metric with an annual history behind it: a native
// range so the arrows, home, end and a touch drag all work without being
// reimplemented, with the year and its coverage read out above it
function Years({ deep, year, onYearChange, reducedMotion }: YearsProps) {
  const frames = deep.frames;
  const total = deep.total;
  const index = frameIndex(deep, year);
  const frame = frames[index];
  const [playing, setPlaying] = useState(false);
  // what a run ended on. the scrubber announces itself while it has focus, so
  // the only change nobody hears is the one a run makes with the focus on the
  // play button, and announcing all fifty of those would be useless
  const [ended, setEnded] = useState<string | null>(null);
  const canPlay = frames.length > 1;
  const stepMs = reducedMotion ? YEAR_MS_REDUCED : YEAR_MS;

  // the run reads these when it fires rather than closing over them, so a
  // frame does not restart the clock and the scrubber can move under it. it is
  // written after the commit, which is the only state the run can act on
  const live = useRef({ index, frames, onYearChange });
  useEffect(() => {
    live.current = { index, frames, onYearChange };
  });

  // another metric ends the run
  useEffect(() => {
    setPlaying(false);
    setEnded(null);
  }, [deep]);

  // one frame is asked for per animation frame and taken only once the step
  // has elapsed, so a slow repaint drops a frame instead of queueing one and
  // the run can never get ahead of the map
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = 0;
    const step = (now: number) => {
      if (last === 0) last = now;
      if (now - last >= stepMs) {
        last = now;
        const run = live.current;
        const next = nextFrame(run.index, run.frames.length);
        if (next < 0) {
          setPlaying(false);
          setEnded(frameText(run.frames[run.index], total));
          return;
        }
        run.onYearChange(run.frames[next].year);
      }
      raf = window.requestAnimationFrame(step);
    };
    raf = window.requestAnimationFrame(step);
    return () => window.cancelAnimationFrame(raf);
  }, [playing, stepMs, total]);

  const first = frames[0];
  const last = frames[frames.length - 1];

  const togglePlay = () => {
    setEnded(null);
    if (playing) {
      setPlaying(false);
      return;
    }
    if (!canPlay) return;
    // a run that reached the end starts again from the first year
    if (index >= frames.length - 1) onYearChange(first.year);
    setPlaying(true);
  };

  const onScrub = (e: React.ChangeEvent<HTMLInputElement>) => {
    setPlaying(false);
    setEnded(null);
    const to = Math.min(frames.length - 1, Math.max(0, Math.round(Number(e.target.value))));
    onYearChange(frames[to].year);
  };

  const playLabel = playing ? "stop playing the years" : `play the years, ${first.year} to ${frameName(last)}`;

  return (
    <div className="timeline-block years">
      <div className="timeline-head">
        <span className="label" id="period-label">year</span>
        <button
          type="button"
          className="play"
          aria-pressed={playing}
          aria-label={playLabel}
          title={reducedMotion ? "steps a year at a time, slowly, because your system asks for less motion" : playLabel}
          disabled={!canPlay}
          onClick={togglePlay}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            {playing ? <rect x="1.5" y="1.5" width="7" height="7" rx="1" /> : <polygon points="2,1 9,5 2,9" />}
          </svg>
          {playing ? "stop" : "play"}
        </button>
      </div>
      {/* the scrubber's own value carries this text, so reading it twice is
          the thing to avoid here rather than reading it at all */}
      <p className="year-read" aria-hidden="true">
        <span className="y">{frameName(frame)}</span>
        <span className="n">{frame.count} of {total} metros</span>
      </p>
      <span className="sr" role="status">{ended ?? ""}</span>
      <div className="coverage" aria-hidden="true">
        {frames.map((f, i) => (
          <span
            key={f.year}
            className={`bar${i === index ? " at" : ""}`}
            style={{ height: pct(total > 0 ? Math.max(0.06, f.count / total) : 0) }}
          />
        ))}
      </div>
      <input
        type="range"
        className="scrub"
        min={0}
        max={frames.length - 1}
        step={1}
        value={index}
        aria-labelledby="period-label"
        aria-valuetext={frameText(frame, total)}
        onChange={onScrub}
      />
      <div className="ends" aria-hidden="true">
        <span>{first.year}</span>
        <span>{last.year}</span>
      </div>
      <p className="mode-note">
        year over year change, since the index is rebased per metro. a metro with no index that year is
        drawn as no data, not as zero. one colour scale for every year, clipped at plus or minus {deep.cap} percent.
      </p>
    </div>
  );
}

// the as of control: a calendar axis with one tick per period, filled where
// the metric has values. the current tick is the one tab stop; arrows move
// between the available ones and play steps through them once
function Panels({ def, metros, period, available, onPeriodChange }: Props) {
  const model = useMemo(() => buildTimeline(def, metros), [def, metros]);
  const [playing, setPlaying] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const canPlay = available.length > 1;

  // a new metric ends the run
  useEffect(() => {
    setPlaying(false);
  }, [def.id]);

  // each step schedules the one after it; the run ends past the last period
  useEffect(() => {
    if (!playing) return;
    const id = window.setTimeout(() => {
      const next = nextPeriod(period, available);
      if (next) onPeriodChange(next);
      else setPlaying(false);
    }, PLAY_MS);
    return () => window.clearTimeout(id);
  }, [playing, period, available, onPeriodChange]);

  const togglePlay = () => {
    if (playing) {
      setPlaying(false);
      return;
    }
    if (!canPlay) return;
    onPeriodChange(available[0]);
    setPlaying(true);
  };

  const move = (target: Period | null) => {
    if (!target) return;
    setPlaying(false);
    onPeriodChange(target);
    root.current?.querySelector<HTMLButtonElement>(`[data-period="${target}"]`)?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const keys: Record<string, () => Period | null> = {
      ArrowRight: () => nextPeriod(period, available),
      ArrowLeft: () => prevPeriod(period, available),
      Home: () => available[0] ?? null,
      End: () => available[available.length - 1] ?? null,
    };
    const pick = keys[e.key];
    if (!pick) return;
    e.preventDefault();
    move(pick());
  };

  return (
    <div className="timeline-block">
      <div className="timeline-head">
        <span className="label" id="period-label">as of</span>
        <button
          type="button"
          className="play"
          aria-pressed={playing}
          aria-label={playing ? "stop stepping through the periods" : "play through the periods"}
          title={canPlay ? "steps from the first period to the last, about a second each" : "needs two or more periods"}
          disabled={!canPlay}
          onClick={togglePlay}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            {playing ? <rect x="1.5" y="1.5" width="7" height="7" rx="1" /> : <polygon points="2,1 9,5 2,9" />}
          </svg>
          {playing ? "stop" : "play"}
        </button>
      </div>
      <div ref={root} className="timeline" role="group" aria-labelledby="period-label" onKeyDown={onKeyDown}>
        <div className="axis" aria-hidden="true">
          {model.marks.map((m) => (
            <span key={m.year} className="mark" style={{ left: pct(m.t) }} />
          ))}
        </div>
        {model.span && (
          <>
            <div
              className="span"
              style={{ left: pct(model.span.t0), width: pct(model.span.t1 - model.span.t0) }}
              title={`${def.label}: the change over these years`}
            />
            <span className="span-year" style={{ left: pct(model.span.t0) }}>{model.span.from}</span>
            <span className="span-year" style={{ left: pct(model.span.t1) }}>{model.span.to}</span>
          </>
        )}
        {model.ticks.map((tick) => {
          const current = tick.period === period;
          const count = tick.available ? `${tick.count} metros` : "not published";
          const isLatest = tick.period === "latest";
          const name = isLatest && tick.date ? `latest, ${tick.label}` : tick.label;
          return (
            <button
              type="button"
              key={tick.period}
              className={`tick ${tick.available ? "filled" : "hollow"}${current ? " current" : ""}`}
              data-period={tick.period}
              style={{ left: pct(tick.t) }}
              aria-pressed={current}
              aria-disabled={!tick.available}
              aria-label={`${name}, ${count}`}
              tabIndex={current ? 0 : -1}
              title={tickTitle(tick, metros.length)}
              onClick={() => tick.available && move(tick.period)}
            >
              <span className="dot" aria-hidden="true" />
              <span className="lbl" style={{ marginTop: tick.row ? 28 : 3 }}>
                <span className="when">{isLatest ? "latest" : tick.label}</span>
                {isLatest && tick.date && <span className="date">{tick.label}</span>}
                <span className="n">{count}</span>
              </span>
            </button>
          );
        })}
      </div>
      {def.periods.length > 0 && available.length === 0 && <p className="mode-note">no period carries a value in this data</p>}
    </div>
  );
}

// an annual history replaces the four vintage panels, because it says the
// same thing at fifty times the resolution. every other metric, and this one
// wherever no history was provided, keeps the panels unchanged
export function Timeline(props: Props) {
  const scrub = useContext(YearScrubContext);
  if (scrub && scrub.deep) {
    return (
      <Years
        deep={scrub.deep}
        year={scrub.year}
        onYearChange={scrub.onYearChange}
        reducedMotion={scrub.reducedMotion}
      />
    );
  }
  return <Panels {...props} />;
}
