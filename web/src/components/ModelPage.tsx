import { useMemo } from "react";
import { formatValue } from "../lib/format";
import {
  AVERAGE, BAND_TUNE, CHALLENGERS, EXPANDED_BEFORE, EXPANDED_FOR_ALL_FROM, FIT_END, LONG_RUN, NOMINAL_COVERAGE, NO_CHANGE,
  PAIRED_LEVEL, REFIT_FROM, RULE_HORIZONS, SHIPPED, TRAIN_END, WHY_SHIPPED,
  admissionSentences, aheadOf, allUnderCover, asPercent, bandCall, bandCut, bandExtremes, bandPairs, bandWords, beatenEverywhere,
  bestAt, bothScored, closerAt, closestTo, coverageRange, cutWords, edgeSentence, edgeTest, edgesOver, errorCut, errorCuts,
  extraFit, featureName, horizonPhrase, horizonWord, horizonsIn, inWords, joinList, leaderboard, lossSentence, lossesOf, matchedBy,
  matchedEverywhere, matchedPhrase, meanVerdict, modelLabel, modelsIn, pAt, pBound, pList, pText, pairedOrigins, pairedWith,
  points, proseName, revisionOf, ridgeVerdict, rowAt, ruleCall, ruleSentence, scored, sentenceCase, separatedAt,
  separatedSentence, shiftQuarter, spanPaired, spanRows, spanStart, spansIn, spreadOf, tiedWith, widthAgainst,
  winsAt,
} from "../lib/model";
import {
  ADMISSION, BACKTEST, INPUTS, PAIRED, PANEL, PANEL_COVERAGE, WALKFORWARD, WALKFORWARD_LATEST,
  WALKFORWARD_PAIRED,
} from "../lib/modelNumbers";
import type { ViewProps } from "../lib/views";
import { ModelFigure } from "./ModelFigure";
import "../styles/model.css";

const rate = (value: number | null | undefined) =>
  formatValue(typeof value === "number" ? value : null, "rate", true);

// the coverage figure's row each feature is drawn in
const FEATURE_ROW: Record<string, string> = {
  hpi_qoq: "hpi",
  hpi_yoy: "hpi",
  unemp: "unemp",
  mortgage: "mortgage",
  zhvi_yoy: "zhvi",
  hpi_exp_yoy: "expanded hpi",
  hpi_rstderr: "index error",
  permits_per_1000: "permits",
  pop_growth: "population",
  domestic_migration_rate: "population",
  income_growth: "income",
};

// the first year the coverage figure has any value in a row, when it is known
const firstYear = (label: string): number | null =>
  PANEL_COVERAGE?.series.find((s) => s.label === label)?.first ?? null;

// the columns that ride in the panel for the figures and the map, by the
// coverage figure's row and the name the limits give them
const CONTEXT_ROWS: [string, string][] = [["zori", "rents"], ["listings", "listing prices"], ["inventory", "inventory"]];

// "cuts the no change error 45 percent at four quarters and 44 percent at
// eight", or says it adds to it where the model is the worse of the two
function cutPhrase(near: number | null, far: number | null): string {
  if (near === null || far === null) return "has no scored comparison with no change at four and eight quarters";
  if (near >= 0 && far >= 0) return `cuts the no change error ${asPercent(near)} percent at four quarters and ${asPercent(far)} percent at eight`;
  if (near < 0 && far < 0) return `adds ${asPercent(-near)} percent to the no change error at four quarters and ${asPercent(-far)} percent at eight`;
  const one = (cut: number, where: string) =>
    cut >= 0 ? `cuts the no change error ${asPercent(cut)} percent at ${where}` : `adds ${asPercent(-cut)} percent to it at ${where}`;
  return `${one(near, "four quarters")} and ${one(far, "eight")}`;
}

// "runs bands 23 percent narrower at four quarters and 34 at eight than the
// metro's own long run average", or wider where they are
function bandPhrase(near: number | null, far: number | null): string {
  if (near === null || far === null) return "has no band to set against the metro's own long run average at four and eight quarters";
  const word = (cut: number) => (cut >= 0 ? "narrower" : "wider");
  const size = (cut: number) => asPercent(Math.abs(cut));
  return word(near) === word(far)
    ? `runs bands ${size(near)} percent ${word(near)} at four quarters and ${size(far)} at eight than the metro's own long run average`
    : `runs a band ${size(near)} percent ${word(near)} at four quarters and ${size(far)} percent ${word(far)} at eight than the `
      + "metro's own long run average";
}

// the one value every row shares, or null when they differ
function shared(values: number[]): number | null {
  return values.length > 0 && values.every((value) => value === values[0]) ? values[0] : null;
}

// "only the four quarter gap passes the test", read off the horizons the
// paired test put past chance out of the ones it tested
function passWords(apart: number[], tested: number[]): string {
  if (apart.length === 0) return "no gap passes the test";
  if (apart.length === tested.length) return "every gap passes the test";
  return `only the ${joinList(apart.map(horizonWord))} quarter ${apart.length === 1 ? "gap passes" : "gaps pass"} the test`;
}

// the walkthrough in ml/README.md as a page: the panel, the evaluation
// design, the models, the results, the yearly refit record, the shipped
// forecast, the limits.
//
// every number here is read rather than written down. the tables and the
// panel's facts come from ml/results through scripts/model-assets.mjs, and the
// shipped forecast is measured off the same json the map draws, so a retrain
// or a fresh export moves this page with it. a sentence that says who wins,
// which side is larger or whether a band holds is chosen by the numbers it
// reads, not written for the ones it had once
export function ModelPage({ data }: ViewProps) {
  const rows = BACKTEST;
  const horizons = useMemo(() => horizonsIn(rows), [rows]);
  const board = useMemo(() => leaderboard(rows), [rows]);
  const winners = useMemo(
    () => new Map(horizons.map((horizon) => [horizon, bestAt(rows, horizon)?.model ?? null])),
    [rows, horizons],
  );

  const shipped8 = rowAt(rows, SHIPPED, 8);
  const longRun8 = rowAt(rows, LONG_RUN, 8);
  const longRun4 = rowAt(rows, LONG_RUN, 4);
  const shipped4 = rowAt(rows, SHIPPED, 4);
  const losses = useMemo(() => lossesOf(rows, SHIPPED), [rows]);
  const wins = useMemo(() => winsAt(rows, SHIPPED), [rows]);
  const closest8 = closestTo(rows, SHIPPED, 8);
  const eighth = coverageRange(rows, 8);
  const counts = new Set(rows.map((row) => row.n));
  const scoredN = counts.size === 1 ? rows[0].n : null;

  const cut4 = errorCut(rows, SHIPPED, NO_CHANGE, 4);
  const cut8 = errorCut(rows, SHIPPED, NO_CHANGE, 8);
  const band4 = bandCut(rows, SHIPPED, LONG_RUN, 4);
  const band8 = bandCut(rows, SHIPPED, LONG_RUN, 8);
  const cover8 = shipped8 && scored(shipped8.coverage) ? shipped8.coverage : null;
  const misses8 = cover8 !== null && cover8 < NOMINAL_COVERAGE;

  const near = useMemo(() => spreadOf(data.metros, "hpi_forecast_4q"), [data.metros]);
  const far = useMemo(() => spreadOf(data.metros, "hpi_forecast_8q"), [data.metros]);
  const spans = useMemo(() => bandExtremes(data.metros, "hpi_forecast_4q"), [data.metros]);
  const error = useMemo(() => spreadOf(data.metros, "hpi_index_error"), [data.metros]);
  const origin = near?.origin ?? far?.origin ?? null;

  // what the fitting block can see: every feature the manifest lists, less the
  // ones the coverage figure shows nothing for left of the rule
  const features = INPUTS.sequence + INPUTS.annual;
  const fitEnd = PANEL_COVERAGE?.fitEnd ?? FIT_END;
  const unseen = PANEL_COVERAGE?.unseen ?? [];
  const seen = features - unseen.length;
  const unseenNames = joinList(unseen.map(featureName));
  const trainYear = Number(TRAIN_END.slice(0, 4));
  // the tail of the train block the networks hold back to choose their epochs,
  // "2015 to 2017", and how much more of it ridge and gradient boosting fit on
  const heldFrom = shiftQuarter(fitEnd, 1) ?? fitEnd;
  const heldBack = heldFrom.endsWith("Q1") && TRAIN_END.endsWith("Q4") ? `${heldFrom.slice(0, 4)} to ${trainYear}` : `${heldFrom} to ${TRAIN_END}`;
  const moreFit = extraFit(fitEnd);
  // the unseen features have values inside the train block, which is what the
  // two classical models that fit all of it read
  const unseenInTrain = unseen.length > 0 && unseen.every((c) => {
    const first = firstYear(FEATURE_ROW[c] ?? "");
    return first !== null && first <= trainYear;
  });
  const newlyExpanded = PANEL.metros - EXPANDED_BEFORE;
  const zhviFrom = firstYear("zhvi");
  // the context columns the coverage figure shows empty left of the rule
  const emptyContext = CONTEXT_ROWS
    .filter(([row]) => PANEL_COVERAGE?.series.find((s) => s.label === row)?.emptyBeforeFit)
    .map(([, name]) => name);

  const lossText = lossSentence(losses);
  const lossHorizons = losses.map((loss) => loss.horizon);
  const shortest = horizons[0];
  const longest = horizons[horizons.length - 1];
  // ridge beat the gru at the shortest horizon. read off the losses, so a tie
  // there says nothing either way
  const ridgeFirst = losses.some((loss) => loss.horizon === shortest && loss.winner === "ridge");
  const winsLong = longest !== undefined && wins.includes(longest);
  // the losses are the short ones when every one of them comes before every win
  const lossesShort = lossHorizons.length > 0 && wins.length > 0 && Math.max(...lossHorizons) < Math.min(...wins);
  const beatsMean = aheadOf(rows, SHIPPED, LONG_RUN);
  const againstMean = bothScored(rows, SHIPPED, LONG_RUN);
  // how big the nearest rival gap is against the error it sits inside, which is
  // the only scale on which a tenth of a point means anything
  const gapShare8 = closest8 && shipped8 && scored(shipped8.maePct) ? closest8.gap / shipped8.maePct : null;
  const winner8 = bestAt(rows, 8);
  // a tie at eight quarters is neither a win nor a loss, so the long horizon
  // verdict is written only for one or the other
  const won8 = wins.includes(8);
  const lost8 = lossHorizons.includes(8);
  const lostAll = lossHorizons.length > 0 && lossHorizons.length === horizons.length;
  // where ridge is level with or ahead of the gru, on error and on band width.
  // the pipeline never weighs the two, so the page says where ridge stands
  // instead of letting the gru's place on the map read as a win over it
  const ridge = matchedBy(rows, "ridge", SHIPPED);
  const ridgeAll = matchedEverywhere(ridge);
  const ridgeAt = matchedPhrase(ridge);
  const ridgeSentence = ridgeAt ? `Ridge matches or beats the GRU ${ridgeAt}.` : "";
  // every gap between ridge and the gru tested, and none past chance
  const ridgeTied = pairedWith(PAIRED, "ridge").length > 0 && separatedAt(PAIRED, "ridge").length === 0;

  const meanReading = againstMean.length > 0 && beatsMean.length === againstMean.length
    ? "beats the metro's own long run average at every horizon"
    : beatsMean.length > 0
      ? `beats the metro's own long run average at ${horizonPhrase(beatsMean)} and not at ${horizonPhrase(againstMean.filter((h) => !beatsMean.includes(h)))}`
      : "does not beat the metro's own long run average at any horizon";

  // the paired test of the gru against every other model: which gaps on the
  // table it finds more than chance. every sentence about it is chosen by the
  // p values it wrote, so a retrain that moves them moves the words
  const pairedRivals = modelsIn(rows).filter((model) => model !== SHIPPED);
  const tested = pairedRivals.filter((model) => pairedWith(PAIRED, model).length > 0);
  const origins = pairedOrigins(PAIRED);
  const pairedFound = separatedSentence(PAIRED);
  const meanTest = meanVerdict(PAIRED);
  // what the admission run found for the inputs the old gate could not see
  const admitted = admissionSentences(ADMISSION);

  // the yearly refit record, which the page leads with: every model refitted
  // once a year and fed fhfa's index as each release first printed it, scored
  // over the whole record and over 2022 onward apart. the same record read on
  // today's index is only there to say what the revisions were worth
  const walkSpans = spansIn(WALKFORWARD);
  const recordFrom = walkSpans[0] ?? null;
  const recentFrom = walkSpans.length > 1 ? walkSpans[walkSpans.length - 1] : null;
  const record = spanRows(WALKFORWARD, recordFrom);
  const recent = spanRows(WALKFORWARD, recentFrom);
  const recordPaired = spanPaired(WALKFORWARD_PAIRED, recordFrom);
  const recentPaired = spanPaired(WALKFORWARD_PAIRED, recentFrom);
  const walkHorizons = horizonsIn(record);
  const walkBoard = leaderboard(record);
  const walkWinners = new Map(walkHorizons.map((horizon) => [horizon, bestAt(record, horizon)?.model ?? null]));
  const recordOrigins = shared(record.map((row) => row.origins));
  const recentOrigins = shared(recent.map((row) => row.origins));
  const recordN = shared(record.map((row) => row.n));
  const recordStart = recordFrom ? spanStart(recordFrom) : null;
  const recentStart = recentFrom ? spanStart(recentFrom) : null;
  const joined = modelsIn(record).filter((model) => !modelsIn(rows).includes(model));
  // the average is named in full the first time the page meets it
  const introName = (model: string) => (model === AVERAGE ? "an average of the GRU and ridge" : proseName(model));

  // against no change, over the record and over 2022 onward, and where the
  // paired test puts that gap past chance with the gru the closer
  const recordCut4 = errorCut(record, SHIPPED, NO_CHANGE, 4);
  const recordCut8 = errorCut(record, SHIPPED, NO_CHANGE, 8);
  const recentCut4 = errorCut(recent, SHIPPED, NO_CHANGE, 4);
  const recentCut8 = errorCut(recent, SHIPPED, NO_CHANGE, 8);
  const recordTested = pairedWith(recordPaired, NO_CHANGE);
  const recentTested = pairedWith(recentPaired, NO_CHANGE);
  const recordApart = closerAt(recordPaired, NO_CHANGE, "shipped");
  const recentApart = closerAt(recentPaired, NO_CHANGE, "shipped");
  const recordEvery = recordTested.length > 0 && recordApart.length === recordTested.length;
  const recordBound = pBound(recordTested.filter((row) => recordApart.includes(row.horizon)).map((row) => row.pValue));
  const recentP = recentApart.map((horizon) => pAt(recentPaired, NO_CHANGE, horizon)).filter(scored);
  // 2022 onward is the fixed split's own test block when both score the same
  // samples at every horizon
  const sameOutcomes = recent.length > 0 && horizons.every((h) => {
    const mine = rowAt(recent, SHIPPED, h);
    return mine !== null && mine.n === rowAt(rows, SHIPPED, h)?.n;
  });
  const recent4 = rowAt(recent, SHIPPED, 4);
  const recent8 = rowAt(recent, SHIPPED, 8);
  const recentVsSplit = recentCut4 === null || recentCut8 === null || cut4 === null || cut8 === null
    ? null
    : recentCut4 < cut4 && recentCut8 < cut8 ? "below" : recentCut4 > cut4 && recentCut8 > cut8 ? "above" : "set against";

  // who stands where on the record: the rivals lower than the gru somewhere,
  // the ones the record cannot tell from it, what the rule written before the
  // run makes of ridge and the average, and the ones it beats everywhere
  const walkWins = winsAt(record, SHIPPED);
  const edges = edgesOver(record);
  // the ones lower at more horizons first, the order the readings name them in
  const tied = tiedWith(record, recordPaired)
    .sort((a, b) => aheadOf(record, b, SHIPPED).length - aheadOf(record, a, SHIPPED).length);
  const tiedGaps = tied.flatMap((model) => pairedWith(recordPaired, model));
  const tiedApart = tiedGaps.filter((row) => row.pValue < PAIRED_LEVEL).length;
  const calls = CHALLENGERS.filter((model) => pairedWith(recordPaired, model).length > 0).map((model) => ruleCall(recordPaired, model));
  const promoted = calls.filter((call) => call.replaces).map((call) => call.against);
  const beaten = beatenEverywhere(recordPaired, walkHorizons);
  const revision = revisionOf(record, spanRows(WALKFORWARD_LATEST, recordFrom));

  // the gru's two bands on 2022 onward and what the band rule makes of them
  const bandPairsRecent = bandPairs(WALKFORWARD, recentFrom);
  const bandRule = bandCall(bandPairsRecent);
  const longPair = bandPairsRecent.length > 0 ? bandPairsRecent[bandPairsRecent.length - 1] : null;
  const longWidth = longPair ? widthAgainst(longPair.online.width, longPair.static.width) : null;
  const longGain = longPair && scored(longPair.online.coverage) && scored(longPair.static.coverage)
    ? Math.round((longPair.online.coverage - longPair.static.coverage) * 100)
    : null;
  const missRate = 1 - NOMINAL_COVERAGE;

  // the headline, the way ml/README.md opens: the record, then 2022 onward
  // against the fixed split, then where the gru stands among the models the
  // record cannot tell apart
  const recordTest = recordEvery
    ? `, beyond chance at every horizon${recordBound ? ` (p below ${recordBound})` : ""}`
    : recordApart.length > 0
      ? `, beyond chance at ${horizonPhrase(recordApart)}`
      : recordTested.length > 0 ? ", though a paired test puts every one of those gaps down to chance" : "";
  const recentCuts = recentCut4 !== null && recentCut8 !== null && recentCut4 >= 0 && recentCut8 >= 0
    ? asPercent(recentCut4) === asPercent(recentCut8)
      ? `the cut is ${asPercent(recentCut4)} percent at both`
      : `the cut is ${asPercent(recentCut4)} percent at four quarters and ${asPercent(recentCut8)} at eight`
    : `the GRU ${cutPhrase(recentCut4, recentCut8)}`;
  const lowestOnRecord = walkWins.length === 0
    ? "It does not have the lowest error at any horizon"
    : walkWins.length === walkHorizons.length
      ? "It has the lowest error at every horizon"
      : `It has the lowest error at ${horizonPhrase(walkWins)}`;
  const withinChance = tiedApart === 0
    ? "within chance of it"
    : `within chance of it at all but ${inWords(tiedApart)} of ${tied.length === 1 ? "its" : "their"} ${inWords(tiedGaps.length)} gaps`;
  const standing = tied.length === 0
    ? `${lowestOnRecord}.`
    : `${lowestOnRecord}: ${joinList(tied.map(introName))} ${tied.length === 1 ? "is" : "are"} ${withinChance}`
      + `${promoted.length === 0 ? `, so it ships as one of ${inWords(tied.length + 1)} tied models, by a rule written before the run` : ""}.`;
  const overruled = promoted.length > 0
    ? ` A rule written before the run says ${joinList(promoted.map(introName))} should replace it.`
    : "";
  const headline = record.length === 0 || recordCut4 === null
    ? ""
    : [
        `Refit once a year from ${REFIT_FROM} on FHFA prices as each release first printed them, the sequence GRU `
          + `${cutPhrase(recordCut4, recordCut8)}`
          + `${recordOrigins !== null && recordStart ? `, over the ${recordOrigins} quarterly origins from ${recordStart} on` : ""}`
          + `${recordTest}.`,
        recent.length > 0 && recentStart
          ? `On ${recentStart} onward alone ${recentCuts}`
            + `${recentVsSplit && cut4 !== null && cut8 !== null ? `, ${recentVsSplit} the fixed split's ${asPercent(cut4)} and ${asPercent(cut8)}` : ""}`
            + `${recentTested.length > 0 ? `, and ${passWords(recentApart, recentTested.map((row) => row.horizon))}` : ""}.`
          : "",
        `${standing}${overruled}`,
      ].filter((sentence) => sentence.length > 0).join(" ");

  // the fixed split's own numbers, which the headline used to carry
  const fixedP4 = pAt(PAIRED, NO_CHANGE, 4);
  const fixedP8 = pAt(PAIRED, NO_CHANGE, 8);
  const fixedP = fixedP4 === null || fixedP8 === null
    ? ""
    : pText(fixedP4) === pText(fixedP8) ? ` (p ${pText(fixedP4)} at both)` : ` (${pList([fixedP4, fixedP8])})`;

  // the four readings of the record, each chosen by the rows it reads, so a
  // rerun that moves a p value moves the words
  const recordCuts = errorCuts(record, SHIPPED, NO_CHANGE);
  const recentCutsAll = errorCuts(recent, SHIPPED, NO_CHANGE);
  const splitApart = closerAt(PAIRED, NO_CHANGE, "shipped");
  const recordBeyond = recordEvery
    ? ", beyond chance at every horizon"
    : recordApart.length > 0
      ? `, beyond chance at ${horizonPhrase(recordApart)}`
      : recordTested.length > 0 ? ", and the paired test puts every one of those gaps down to chance" : "";
  // more origins are only worth a sentence while they separate more
  const moreOrigins = recordOrigins !== null && origins !== null && recordApart.length > splitApart.length
    ? ` Its ${recordOrigins} origins run through a boom and a correction, against the fixed split's ${origins} from one cycle.`
    : "";
  const recentPass = recentTested.length === 0
    ? ""
    : `, and ${passWords(recentApart, recentTested.map((row) => row.horizon))}`
      + `${recentApart.length > 0 && recentApart.length < recentTested.length ? ` (${pList(recentP)})` : ""}`;
  const againstFixed = recentVsSplit && recent4 && recent8 && shipped4 && shipped8 && cut4 !== null && cut8 !== null
    ? ` At four and eight quarters that ${recentVsSplit === "set against" ? "compares with" : `is ${recentVsSplit}`} the fixed `
      + `split's ${asPercent(cut4)} and ${asPercent(cut8)}${sameOutcomes ? " on the same outcomes" : ""}: refit every year, the GRU `
      + `misses by ${points(recent4.maePct)} and ${points(recent8.maePct)} points, against ${points(shipped4.maePct)} and `
      + `${points(shipped8.maePct)} for the one fit once on nothing after ${trainYear}.`
      + `${recent4.maePct > shipped4.maePct && recent8.maePct > shipped8.maePct ? " Newer data did not buy a better forecast of the correction." : ""}`
    : "";
  const walkReadings = [
    recordCuts.length === 0 ? "" : `Against no change the GRU ${cutWords(recordCuts)}${recordBeyond}.${moreOrigins}`,
    recentCutsAll.length === 0 || !recentStart
      ? ""
      : `On ${recentStart} onward alone it ${cutWords(recentCutsAll)}${recentPass}.${againstFixed}`,
    [
      walkWins.length === 0 ? "The GRU does not have the lowest error at any horizon." : `The GRU has the lowest error at ${horizonPhrase(walkWins)}.`,
      edgeSentence(edges, walkHorizons.length),
      edgeTest(edges, recordPaired),
      ruleSentence(calls, walkHorizons.length, tied.length + 1),
      beaten.length > 0
        ? `${sentenceCase(joinList(beaten.map(proseName)))} ${beaten.length === 1 ? "is the one" : `are the ${inWords(beaten.length)}`} it beats at every horizon.`
        : "",
    ].filter((sentence) => sentence.length > 0).join(" "),
    revision === null
      ? ""
      : `${revision.share < 0.05 ? "Revisions barely matter." : "Revisions matter here."} On today's index instead, the GRU's error `
        + `moves by ${points(revision.error)} points or less at every horizon`
        + `${revision.cut !== null ? ` and its cut against no change by ${revision.cut <= 1 ? "a point or less" : `up to ${points(revision.cut, 1)} points`}` : ""}.`,
  ].filter((reading) => reading.length > 0);

  // the band replay's verdict, and the line the limits carry about it
  const bandVerdict = bandPairsRecent.length === 0
    ? ""
    : [
        `The online band ${bandWords(bandRule)}.`,
        longPair && longWidth
          ? `It is ${longWidth} at ${horizonPhrase([longPair.horizon])}${longGain !== null ? `, for ${longGain > 0 ? `${inWords(longGain)} more points of coverage` : "no more coverage"}` : ""}.`
          : "",
        bandRule.replaces
          ? "By the rule written first, the online band replaces the static one."
          : "So the static band stays, and its shortfall stays in the limits below.",
      ].filter((sentence) => sentence.length > 0).join(" ");
  const shiftTried = bandPairsRecent.length > 0
    ? ` The online band in the yearly refit record ${bandWords(bandRule)}.`
    : " A wider held out period, or a conformal method built for distribution shift, is the real answer.";
  // the pipeline picks the gru between the two networks, and the record is
  // where ridge and the average were weighed against it
  const weighed = calls.length === 0
    ? ""
    : ` The yearly refit record weighs ${joinList(calls.map((call) => proseName(call.against)))} against it, by a rule written `
      + `before the run, and ${promoted.length > 0
        ? `the rule says ${joinList(promoted.map(proseName))} should replace it`
        : `the rule keeps the GRU${tied.length > 0 ? `, one of ${inWords(tied.length + 1)} tied models` : ""}`}.`;

  return (
    <main className="model-page">
      <div className="model-inner">
        <header className="model-head">
          <h2>How the forecast is built and judged</h2>
          <p className="model-lead">
            The expected growth lines on the map come from a model in this repo. It forecasts how far each metro's
            house price index moves over the next one, two, four and eight quarters, with a{" "}
            {Math.round(NOMINAL_COVERAGE * 100)} percent band. This page shows how well that worked, including where
            it loses.
          </p>
          {headline && <p className="model-lead">{headline}</p>}
          <ul className="model-stats">
            <li>
              <span className="value">{recordCut4 !== null ? `${asPercent(Math.abs(recordCut4))}%` : "-"}</span>
              <span className="label">{recordCut4 !== null && recordCut4 < 0 ? "more" : "less"} error at four quarters</span>
              <span className="note">
                refit every year
                {recordOrigins !== null && recordStart ? `, ${recordOrigins} origins from ${recordStart} on` : ""}, against no change
              </span>
            </li>
            <li>
              <span className="value">{band4 !== null ? `${asPercent(Math.abs(band4))}%` : "-"}</span>
              <span className="label">{band4 !== null && band4 < 0 ? "wider" : "narrower"} band at four quarters</span>
              <span className="note">fixed split, against the metro's own long run average</span>
            </li>
            <li>
              <span className="value">{points(cover8)}</span>
              <span className="label">band coverage at eight quarters</span>
              <span className="note">
                fixed split, target {points(NOMINAL_COVERAGE)}
                {cover8 === null ? "" : misses8 ? ", a miss" : ", it holds"}
              </span>
            </li>
          </ul>
        </header>

        <section className="model-section">
          <h3>The panel</h3>
          <p>
            One row per metro per quarter: {PANEL.metros} metros, {PANEL.first} to {PANEL.last},{" "}
            {PANEL.rows.toLocaleString("en-US")} rows. The FHFA all transactions index is the target.{" "}
            {sentenceCase(inWords(features))} features feed the models and {inWords(INPUTS.context)} more columns
            ride along for the figures.
          </p>
          <p>
            A value enters the panel when it was published. An annual value waits for its release: population and migration from the first quarter of the next year,
            permits from the second, income from the fourth. Population growth across the 2019 to 2020 change of
            census base and county lines is left out. A metropolitan division takes what it lacks from its parent
            metro.
          </p>
          <p>
            Three things the panel cannot undo. FHFA revises past quarters as later sales come in, so every
            origin reads the vintage of the index that runs through {PANEL.last}, not the one published at the
            time. Population and income are later vintages too. And the expanded index covered only{" "}
            {EXPANDED_BEFORE} metros before {EXPANDED_FOR_ALL_FROM}.
          </p>
          <ModelFigure id="coverage" />
          <p>
            A feature can only be learned left of the rule, where the networks fit, on outcomes through {fitEnd}.
            {unseen.length > 0
              ? ` ${sentenceCase(unseenNames)} ${unseen.length === 1 ? "has" : "have"} nothing left of it, so the backtested networks read ${inWords(seen)} of the ${inWords(features)} features. The map's forecast, refit through ${PANEL.last}, reads all ${inWords(features)}.`
              : PANEL_COVERAGE
                ? ` Every feature has something left of it, so the backtest and the map's forecast read the same ${inWords(features)}.`
                : ""}
            {firstYear("unemp") !== null && firstYear("mortgage") !== null
              ? ` Unemployment and the mortgage rate were pulled back to ${firstYear("unemp")} and ${firstYear("mortgage")}.`
              : ""}
            {unseen.length > 0 ? ` ${sentenceCase(unseenNames)} ${unseen.length === 1 ? "has" : "have"} not been.` : ""}
          </p>
        </section>

        <section className="model-section">
          <h3>The evaluation design</h3>
          <p>
            The target is log growth of the index over h quarters. A sample is one metro, one origin quarter and
            one horizon, and it goes in a block by the quarter its outcome lands in, never by where it starts.
          </p>
          <div className="model-scroll">
            <table className="model-table blocks">
              <caption>The three blocks and what each one is used for.</caption>
              <thead>
                <tr>
                  <th scope="col">block</th>
                  <th scope="col">outcome lands</th>
                  <th scope="col">used for</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">train</th>
                  <td>by {TRAIN_END}</td>
                  <td>fitting</td>
                </tr>
                <tr>
                  <th scope="row">calibration</th>
                  <td>2018 to 2021</td>
                  <td>band width, which of the two networks ships, and the run that admitted permits and income</td>
                </tr>
                <tr>
                  <th scope="row">test</th>
                  <td>2022Q1 or later</td>
                  <td>scored once</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p>
            No outcome after 2021 reaches a model judged on 2022 onward, though every block reads the later
            vintages described under the panel.
          </p>
          <ModelFigure id="design" />
          <p>
            The band is conformalized quantile regression: the calibration block widens the model's 10th to 90th
            percentile range until it covers {Math.round(NOMINAL_COVERAGE * 100)} percent of outcomes there, with
            the finite sample correction of Romano, Patterson and Candes (2019). That guarantee assumes
            exchangeable samples, and quarters are not, so the test coverage printed beside every model is the
            number to trust.
          </p>
        </section>

        <section className="model-section">
          <h3>The models</h3>
          <p>
            Five simple rules set the bar: no change, momentum, the metro's own long run average, ridge and
            gradient boosting. Two networks share one input: 24 quarters of {inWords(INPUTS.sequence)} series
            with a mask for missing values, {inWords(INPUTS.annual)} annual features at the origin and a learned
            code for each metro. The window MLP flattens it and the sequence GRU reads it in order. Both predict
            three quantiles per horizon on pinball loss. Their settings and the input set are picked on validation
            loss, outcomes from {heldBack}, never on test.
          </p>
          <ModelFigure id="training" />
          <p>
            Two of the {inWords(INPUTS.sequence)} series are FHFA's expanded index, built from more sales, and its
            standard error, the only published measure of how thin a metro's sales record is. FHFA published them
            for {EXPANDED_BEFORE} metros until its {EXPANDED_FOR_ALL_FROM} report and for all {PANEL.metros} since,
            so the backtest masks them for the other {newlyExpanded} before {EXPANDED_FOR_ALL_FROM}. The map's
            forecast reads them for all {PANEL.metros}, while its band model reads them only where they were
            published, so that band is conservative.
          </p>
          <p>
            Input sets were compared on validation loss only, with the tables in ml/README.md, and a gap smaller
            than one set's spread across seeds does not count either way. National series like CPI stay out, since
            one number shared by every metro says which era a window is in, not anything about the place.
          </p>
          <p>
            That misses any feature the fitting years never see, so a second run fits into the calibration block,
            scores the rest of it and compares sets seed for seed.{admitted ? ` ${admitted}` : ""} It scores the
            2020 to 2021 boom, and inventory starts too late to test at all.
          </p>
        </section>

        <section className="model-section">
          <h3>The results, 2022Q1 onward</h3>
          <p>
            The fixed split fits every model once, on nothing realized after {trainYear}, and scores it once on the
            test block. Here the GRU {cutPhrase(cut4, cut8)}{fixedP}, and {bandPhrase(band4, band8)}.
          </p>
          <div className="model-scroll">
            <table className="model-table board">
              <caption>
                The test block{scoredN !== null ? `, ${scoredN.toLocaleString("en-US")} samples per horizon` : ""}.
                The top number is the mean absolute error of the median forecast in percentage points, lower is
                better. Under it, coverage of the {Math.round(NOMINAL_COVERAGE * 100)} percent band and its mean
                width in log growth.
              </caption>
              <thead>
                <tr>
                  <th scope="col">model</th>
                  {horizons.map((horizon) => (
                    <th key={horizon} scope="col" className="v">{horizon} {horizon === 1 ? "quarter" : "quarters"}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {board.map((row) => (
                  <tr key={row.model}>
                    <th scope="row">
                      {row.label}
                      {row.shipped && <span className="tag">on the map</span>}
                    </th>
                    {row.cells.map((cell, i) => (
                      <td key={horizons[i]} className="v">
                        {cell === null ? "-" : (
                          <>
                            <span className={winners.get(horizons[i]) === row.model ? "mae best" : "mae"}>
                              {points(cell.maePct)}
                              {winners.get(horizons[i]) === row.model && <span className="sr"> lowest error at this horizon</span>}
                            </span>
                            <span className="sub">cover {points(cell.coverage)}</span>
                            <span className="sub">width {points(cell.width, 3)}</span>
                          </>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ModelFigure id="comparison" />
          <p>
            No change, momentum and the metro mean read no inputs at all. Ridge and gradient boosting read the{" "}
            {inWords(features)} features at the origin, plus lags of the metro's quarterly price growth, its
            running mean and a national growth mean, and fit the whole train block through {TRAIN_END}.
            {moreFit
              ? ` So the classical rules learn from ${moreFit} than the networks${unseenInTrain ? `, ${unseenNames} among them` : ""}.`
              : ""}
          </p>
          {pairedFound && (
            <p>
              A lower mean error can be luck, so the GRU is tested against
              {tested.length === pairedRivals.length ? " every other model on the table" : ` ${joinList(tested.map(proseName))}`}.
              Metros at one origin share its shocks, so the gap between two errors is averaged across metros at each
              origin first, then a Diebold and Mariano test asks whether its mean over{" "}
              {origins !== null ? `the ${origins} origins` : "the origins"} is far from zero.
              {" "}{pairedFound}
            </p>
          )}
          <h4>Readings</h4>
          <ul className="model-readings">
            <li>
              {wins.length > 0
                ? `The sequence GRU has the lowest error at ${horizonPhrase(wins)}.`
                : "The sequence GRU has the lowest error at no horizon here."}
              {" "}It {meanReading}: the average goes from {points(longRun4?.maePct)} to {points(longRun8?.maePct)} points
              {" "}as the horizon doubles, the GRU from {points(shipped4?.maePct)} to {points(shipped8?.maePct)}.
              {meanTest ? ` ${meanTest}` : ""}
            </li>
            <li>
              {lossText
                ? `It loses at ${horizonPhrase(lossHorizons)}, where ${lossText}.`
                : "In this build it is ahead at every horizon, which is worth checking rather than celebrating."}
              {ridgeSentence ? ` ${ridgeSentence}` : ""}
              {ridgeAll
                ? ` ${ridgeVerdict(PAIRED, horizons)}`
                : ridgeFirst ? " A penalised linear model is hard to beat one quarter out." : ""}
            </li>
            {closest8 && won8 && (
              <li>
                {`At eight quarters the nearest rival is ${modelLabel(closest8.model)}, ${points(closest8.gap)} points away, which is ${asPercent(gapShare8) ?? "-"} percent of the error it sits inside.`}
                {band8 !== null && band8 > 0 ? ` The GRU's case there rests as much on its band being ${asPercent(band8)} percent narrower than the long run average's.` : ""}
              </li>
            )}
          </ul>
          <ModelFigure id="calibration" />
        </section>

        {record.length > 0 && recordFrom && (
          <section className="model-section">
            <h3>The yearly refit record, {recordFrom} onward</h3>
            <p>
              The fixed split never learns from anything after {trainYear}, tests{" "}
              {origins !== null ? `${origins} origins` : "its origins"} from one cycle and reads FHFA's index as
              printed today. The yearly refit record replays the forecasts instead: from {REFIT_FROM} on, each
              year's model fits on outcomes known by the end of the year before, reads FHFA's index as the release
              of its day printed it, from ALFRED's archive, and forecasts every origin in its year. Scoring uses
              today's index.
              {joined.includes(AVERAGE)
                ? " One model joins: the GRU and ridge averaged quantile by quantile, called the average below."
                : ""}
            </p>
            <div className="model-scroll">
              <table className="model-table board">
                <caption>
                  Mean absolute error{recordOrigins !== null ? ` over the ${recordOrigins} origins` : ""} from{" "}
                  {recordFrom} on{recordN !== null ? `, ${recordN.toLocaleString("en-US")} samples per horizon` : ""},
                  in percentage points, lower is better. Under it, the p value against the sequence GRU.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">model</th>
                    {walkHorizons.map((horizon) => (
                      <th key={horizon} scope="col" className="v">{horizon} {horizon === 1 ? "quarter" : "quarters"}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {walkBoard.map((row) => (
                    <tr key={row.model}>
                      <th scope="row">
                        {row.label}
                        {row.shipped && <span className="tag">on the map</span>}
                      </th>
                      {row.cells.map((cell, i) => {
                        const horizon = walkHorizons[i];
                        const lowest = walkWinners.get(horizon) === row.model;
                        const p = pAt(recordPaired, row.model, horizon);
                        return (
                          <td key={horizon} className="v">
                            {cell === null ? "-" : (
                              <>
                                <span className={lowest ? "mae best" : "mae"}>
                                  {points(cell.maePct)}
                                  {lowest && <span className="sr"> lowest error at this horizon</span>}
                                </span>
                                {p !== null && <span className="sub">p {pText(p)}</span>}
                              </>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {walkReadings.length > 0 && (
              <>
                <h4>{sentenceCase(inWords(walkReadings.length))} readings</h4>
                <ul className="model-readings">
                  {walkReadings.map((reading) => <li key={reading}>{reading}</li>)}
                </ul>
              </>
            )}
            {bandPairsRecent.length > 0 && recentFrom && (
              <>
                <p>
                  The band gets the same replay. The static band{misses8 ? " falls short at eight quarters and" : ""}{" "}
                  looks ahead a little, since its 2020 and 2021 outcomes calibrate forecasts made in those years,
                  which leans this comparison its way. The online band could have run live: its margin comes from the misses realized by each origin and adapts
                  as they land (adaptive conformal inference, Gibbs and Candes 2021). Its settings were picked on{" "}
                  {BAND_TUNE[0]} to {BAND_TUNE[1]}. The rule, written first: it replaces the static band only if its
                  interval score is lower at {inWords(RULE_HORIZONS)} of the {inWords(bandPairsRecent.length)} horizons
                  on {recentStart} onward.
                </p>
                <div className="model-scroll">
                  <table className="model-table">
                    <caption>
                      The sequence GRU's two bands{recentOrigins !== null ? ` over the ${recentOrigins} origins` : ""} from{" "}
                      {recentFrom} on. The top number is the mean interval score, the width plus{" "}
                      {Math.round(2 / missRate)} times any miss outside the band, lower is better. Under it, coverage and
                      mean width, in log growth.
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">band</th>
                        {bandPairsRecent.map((pair) => (
                          <th key={pair.horizon} scope="col" className="v">{pair.horizon} {pair.horizon === 1 ? "quarter" : "quarters"}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {(["static", "online"] as const).map((band) => (
                        <tr key={band}>
                          <th scope="row">{band}</th>
                          {bandPairsRecent.map((pair) => {
                            const cell = pair[band];
                            const other = pair[band === "static" ? "online" : "static"];
                            const lower = scored(cell.intervalScore) && scored(other.intervalScore) && cell.intervalScore < other.intervalScore;
                            return (
                              <td key={pair.horizon} className="v">
                                <span className={lower ? "mae best" : "mae"}>
                                  {points(cell.intervalScore, 3)}
                                  {lower && <span className="sr"> lower interval score at this horizon</span>}
                                </span>
                                <span className="sub">cover {points(cell.coverage)}</span>
                                <span className="sub">width {points(cell.width, 3)}</span>
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {bandVerdict && <p>{bandVerdict}</p>}
              </>
            )}
          </section>
        )}

        <section className="model-section">
          <h3>The shipped forecast</h3>
          <p>
            The map does not draw the model the tables scored. It draws the GRU refit on every outcome through{" "}
            {origin ?? "the last quarter of the panel"}, reading all {inWords(features)} features and the expanded
            index for every metro. Its band margin comes from a second GRU fit through 2021 and calibrated on 2022
            onward, so it is out of sample.
          </p>
          <p>
            The GRU ships because {WHY_SHIPPED}: of the window MLP and the GRU, the one with the lower calibration
            error at four quarters goes on the map.{weighed}
          </p>
          {near && (
            <p>
              {`At the ${near.origin ?? "current"} origin the median four quarter forecast across `}
              {`${near.count} metros is ${rate(near.median)}, with the 10th to 90th percentile `}
              {`running ${rate(near.p10)} to ${rate(near.p90)}. `}
              {/* whether anywhere is forecast to fall is a fact about this export, not a slogan */}
              {near.falling === 0
                ? `It is positive everywhere: the weakest metro is ${near.lowest.name} at ${rate(near.lowest.value)}, the strongest ${near.highest.name} at ${rate(near.highest.value)}.`
                : `${near.falling === 1 ? "One of them is" : `${near.falling} of them are`} forecast to fall, the weakest ${near.lowest.name} at ${rate(near.lowest.value)}, against ${near.highest.name} at ${rate(near.highest.value)}.`}
              {far ? ` The eight quarter median is ${rate(far.median)}.` : ""}
            </p>
          )}
          <ModelFigure id="fans" />
          {spans && (
            <p>
              The band is the part to read. The narrowest four quarter band on the map belongs to{" "}
              {spans.narrow.name} and still runs {rate(spans.narrow.lo)} to {rate(spans.narrow.hi)}. The
              widest belongs to {spans.wide.name}, {rate(spans.wide.lo)} to {rate(spans.wide.hi)}. A
              forecast of {rate(spans.wide.point)} inside a band that wide is a direction, not a number to
              plan against.
            </p>
          )}
          <ModelFigure id="distribution" />
          <p>
            Only the expected growth lines in the map's Forecasts group are forecasts. The last four quarters and
            the five year annualized trend are what the FHFA index did up to the origin, and the surprise scores
            the backtest's call from four quarters before. The index standard error is a percent of the index,
            credited to FHFA
            {error
              ? `: ${points(error.lowest.value)} percent in ${error.lowest.name} against ${points(error.highest.value)} percent in ${error.highest.name}`
              : ""}
            . A wide error is a reason to read the forecast loosely.
          </p>
        </section>

        <section className="model-section model-limits">
          <h3>The limits</h3>
          <p>Read these first.</p>
          <ul>
            <li>
              {misses8
                ? "The bands fail at eight quarters."
                : cover8 !== null ? "The bands hold at eight quarters in this build." : "The bands at eight quarters are not scored in this build."}
              {" "}The sequence GRU's backtest band covers {points(cover8)} of outcomes there against a nominal{" "}
              {points(NOMINAL_COVERAGE)}
              {eighth
                ? allUnderCover(rows, 8)
                  ? `, and every model on the table falls short, from ${points(eighth.low.coverage)} for ${modelLabel(eighth.low.model)} to ${points(eighth.high.coverage)} for ${modelLabel(eighth.high.model)}`
                  : `, and the field runs ${points(eighth.low.coverage)} for ${modelLabel(eighth.low.model)} to ${points(eighth.high.coverage)} for ${modelLabel(eighth.high.model)}`
                : ""}
              . Calibration ran on 2018 to 2021 and the test landed in the correction.
              {/* a repair is only worth ruling out while there is a miss to repair */}
              {misses8
                ? ` Calibrating on the years being scored would fix the number, which is leakage, so it is reported rather than repaired.${shiftTried}`
                : " Calibrating on the years being scored would be leakage, so the window stays where it is."}
            </li>
            <li>
              {lossText ? (
                <>
                  {lostAll ? "It loses every horizon." : lossesShort ? "It loses the short horizons." : `It loses at ${horizonPhrase(lossHorizons)}.`}
                  {" "}{`${sentenceCase(lossText)}.`}
                  {ridgeAll
                    ? ridgeTied
                      ? " The paired test puts every gap between ridge and the GRU down to chance."
                      : ` The GRU is on the map only because ${WHY_SHIPPED}.`
                    : ridgeFirst && lossHorizons.includes(shortest)
                      ? ` One quarter out, the penalised linear model is the better answer${winsLong ? ", and the network earns its place only as the horizon lengthens" : ""}.`
                      : ""}
                </>
              ) : (
                <>It loses no horizon. Not in this build, which is worth checking rather than celebrating.</>
              )}
            </li>
            {closest8 && winner8 && (won8 || (lost8 && !lostAll)) && (
              <li>
                {won8
                  ? `${gapShare8 !== null && gapShare8 < 0.05 ? "The long horizon win is thin." : "It wins the long horizon."} `
                    + `The nearest rival, ${modelLabel(closest8.model)}, is ${points(closest8.gap)} points behind at eight quarters, `
                    + `${points(rowAt(rows, closest8.model, 8)?.maePct)} against ${points(shipped8?.maePct)}.`
                  : `It does not win the long horizon. ${sentenceCase(modelLabel(winner8.model))} is ahead at eight quarters, `
                    + `${points(winner8.maePct)} against ${points(shipped8?.maePct)}.`}
              </li>
            )}
            <li>
              Some series start too late.
              {zhviFrom !== null ? ` Zillow values start in ${zhviFrom}, late in the fitting block.` : ""}
              {emptyContext.length > 0
                ? ` ${sentenceCase(joinList(emptyContext))} have nothing left of the rule, so no model reads them.`
                : " Rents, listing prices and inventory ride in the panel and on the map out of reach of every model."}
            </li>
            <li>
              The expanded index is new for {newlyExpanded} of the {PANEL.metros} metros, so there is no held out
              score yet for what it adds there.
            </li>
          </ul>
        </section>

        <p className="model-foot">
          Every number here is generated at build time from ml/results and the map's data. ml/README.md has the
          walkthrough, the input hashes and the commands for every figure.
        </p>
      </div>
    </main>
  );
}
