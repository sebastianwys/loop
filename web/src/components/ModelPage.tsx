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
  separatedSentence, settingsPhrase, shiftQuarter, spanPaired, spanRows, spanStart, spansIn, spreadOf, tiedWith, widthAgainst,
  winsAt,
} from "../lib/model";
import {
  ADMISSION, BACKTEST, CALIBRATION_N, INPUTS, PAIRED, PANEL, PANEL_COVERAGE, WALKFORWARD, WALKFORWARD_BANDS, WALKFORWARD_LATEST,
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

// "cuts the no-change error 45 percent at four quarters and 44 percent at
// eight", or says it adds to it where the model is the worse of the two
function cutPhrase(near: number | null, far: number | null): string {
  if (near === null || far === null) return "has no scored comparison with no change at four and eight quarters";
  if (near >= 0 && far >= 0) return `cuts the no-change error ${asPercent(near)} percent at four quarters and ${asPercent(far)} percent at eight`;
  if (near < 0 && far < 0) return `adds ${asPercent(-near)} percent to the no-change error at four quarters and ${asPercent(-far)} percent at eight`;
  const one = (cut: number, where: string) =>
    cut >= 0 ? `cuts the no-change error ${asPercent(cut)} percent at ${where}` : `adds ${asPercent(-cut)} percent to it at ${where}`;
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
// design, the models, the results, the walk-forward record, the shipped
// forecast, the limits.
//
// every number here is read rather than written down. the leaderboard and the
// panel's facts come from ml/results through scripts/model-assets.mjs, and the
// shipped forecast is measured off the same json the map draws, so a retrain
// or a fresh export moves this page with it instead of leaving it lying. a
// sentence that says who wins, which side is larger or whether a band holds
// is chosen by the numbers it reads, not written for the ones it had once
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
  const expandedFrom = firstYear("expanded hpi");
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

  const meanReading = againstMean.length > 0 && beatsMean.length === againstMean.length
    ? "it beats the metro's own long run average at every horizon, which is the rule that matters: a long mean is a good guess at a trend and a bad one across a boom"
    : beatsMean.length > 0
      ? `it beats the metro's own long run average at ${horizonPhrase(beatsMean)} and not at ${horizonPhrase(againstMean.filter((h) => !beatsMean.includes(h)))}`
      : "it does not beat the metro's own long run average at any horizon";

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

  // the walk-forward record, which the page leads with: every model refitted
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
  const settings = settingsPhrase(WALKFORWARD_BANDS);
  const stepping = WALKFORWARD_BANDS.some((band) => band.model === SHIPPED && scored(band.gamma) && band.gamma > 0);
  const missRate = 1 - NOMINAL_COVERAGE;

  // the headline, the way ml/README.md opens: the record, then 2022 onward
  // against the fixed split, then where the gru stands among the models the
  // record cannot tell apart
  const recordTest = recordEvery
    ? `, and a paired test puts the gap beyond chance at every horizon${recordBound ? ` (p below ${recordBound})` : ""}`
    : recordApart.length > 0
      ? `, and a paired test puts the gap beyond chance at ${horizonPhrase(recordApart)}`
      : recordTested.length > 0 ? ", though a paired test puts every one of those gaps down to chance" : "";
  const recentCuts = recentCut4 !== null && recentCut8 !== null && recentCut4 >= 0 && recentCut8 >= 0
    ? asPercent(recentCut4) === asPercent(recentCut8)
      ? `the cut is ${asPercent(recentCut4)} percent at both`
      : `the cut is ${asPercent(recentCut4)} percent at four quarters and ${asPercent(recentCut8)} at eight`
    : `the GRU ${cutPhrase(recentCut4, recentCut8)}`;
  const lowestOnRecord = walkWins.length === 0
    ? "The GRU does not have the lowest error at any horizon of that record"
    : walkWins.length === walkHorizons.length
      ? "The GRU has the lowest error at every horizon of that record"
      : `The GRU has the lowest error at ${horizonPhrase(walkWins)} of that record`;
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
        `Refitted once a year from ${REFIT_FROM} and fed FHFA's index as each release first printed it, the sequence GRU `
          + `${cutPhrase(recordCut4, recordCut8)}`
          + `${recordOrigins !== null && recordStart ? `, across the ${recordOrigins} quarterly origins whose outcomes land from ${recordStart} on` : ""}`
          + `${recordTest}.`,
        recent.length > 0 && recentStart
          ? `On ${recentStart} onward alone${sameOutcomes ? ", the years the fixed split below scores" : ""}, ${recentCuts}`
            + `${recentVsSplit && cut4 !== null && cut8 !== null ? `, ${recentVsSplit} that split's ${asPercent(cut4)} and ${asPercent(cut8)}` : ""}`
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
    ? ` The record's ${recordOrigins} origins, through a boom and a correction, give the test something to work with that the `
      + `fixed split's ${origins} from one cycle did not.`
    : "";
  const recentPass = recentTested.length === 0
    ? ""
    : `, and ${passWords(recentApart, recentTested.map((row) => row.horizon))}`
      + `${recentApart.length > 0 && recentApart.length < recentTested.length ? ` (${pList(recentP)})` : ""}`;
  const againstFixed = recentVsSplit && recent4 && recent8 && shipped4 && shipped8 && cut4 !== null && cut8 !== null
    ? ` At four and eight quarters that ${recentVsSplit === "set against" ? "compares with" : `is ${recentVsSplit}`} the fixed `
      + `split's ${asPercent(cut4)} and ${asPercent(cut8)}${sameOutcomes ? " on the same outcomes" : ""}: the GRU refitted every `
      + `year misses by ${points(recent4.maePct)} and ${points(recent8.maePct)} points there, where the one fitted once, on nothing `
      + `realized after ${trainYear}, missed by ${points(shipped4.maePct)} and ${points(shipped8.maePct)}.`
      + `${recent4.maePct > shipped4.maePct && recent8.maePct > shipped8.maePct ? " More recent data did not buy a better forecast of the correction." : ""}`
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
      : `${revision.share < 0.05 ? "Revisions barely matter." : "Revisions matter here."} Read on today's index instead, the GRU's error `
        + `moves by ${points(revision.error)} points or less at every horizon`
        + `${revision.cut !== null ? ` and its cut against no change by ${revision.cut <= 1 ? "a point or less" : `up to ${points(revision.cut, 1)} points`}` : ""}.`
        + `${revision.share < 0.05 ? " The honest reading costs almost nothing, which is itself worth knowing." : ""}`,
  ].filter((reading) => reading.length > 0);

  // the band replay's verdict, and the line the limits carry about it
  const bandVerdict = bandPairsRecent.length === 0
    ? ""
    : [
        `The online band ${bandWords(bandRule)}.`,
        longPair && longWidth
          ? `At ${horizonPhrase([longPair.horizon])} it is ${longWidth}${longGain !== null ? ` for ${longGain > 0 ? `${inWords(longGain)} more points of coverage` : "no more coverage"}` : ""}.`
          : "",
        stepping
          ? `Each step moves the aimed miss rate by gamma times the gap between the nominal ${Math.round(missRate * 100)} percent and the share `
            + `that missed, so a quarter in which every band missed moves it ${inWords(Math.round((1 - missRate) / missRate))} times further `
            + `than a quarter in which none did, and misses across ${PANEL.metros} metros arrive together: the band widens fast in a turn `
            + "and narrows slowly after it."
          : "",
        `The static band keeps its small look-ahead in this comparison, which leans the comparison its way`
          + `${bandRule.higher.length > 0 && bandRule.higher.length === bandRule.horizons.length ? ", and it still wins at every horizon" : ""}.`,
        bandRule.replaces
          ? "By the rule written first, the online band replaces the static one."
          : "So the static band stays, and the under-coverage stays in the limits below.",
      ].filter((sentence) => sentence.length > 0).join(" ");
  const shiftTried = bandPairsRecent.length > 0
    ? ` A conformal method built for distribution shift, one that reads only outcomes realized by each origin, is tried in the walk-forward `
      + `record above: it ${bandWords(bandRule)}${longPair && longWidth ? `, with ${longWidth} at ${horizonPhrase([longPair.horizon])}` : ""}.`
    : " A wider held out period, or a conformal method built for distribution shift, is the real answer.";
  // the pipeline picks the gru between the two networks, and the record is
  // where ridge and the average were weighed against it
  const weighed = calls.length === 0
    ? ""
    : ` The walk-forward record above does weigh ${joinList(calls.map((call) => proseName(call.against)))} against it, by a rule written `
      + `before the run, and ${promoted.length > 0
        ? `the rule says ${joinList(promoted.map(proseName))} should replace it`
        : `the rule keeps the GRU${tied.length > 0 ? `, one of ${inWords(tied.length + 1)} tied models` : ""}`}.`;

  return (
    <main className="model-page">
      <div className="model-inner">
        <header className="model-head">
          <h2>How the forecast is built and judged</h2>
          <p className="model-lead">
            The expected growth lines on the map come from a model fitted in this repository. It reads a
            metro's quarterly history and answers one question: given what is known at this quarter,
            how much does the house price index move over the next one, two, four and eight quarters,
            and how sure can it be. This page is the case for believing those numbers, including the
            places where the model loses.
          </p>
          {headline && <p className="model-lead">{headline}</p>}
          <ul className="model-stats">
            <li>
              <span className="value">{recordCut4 !== null ? `${asPercent(Math.abs(recordCut4))}%` : "-"}</span>
              <span className="label">{recordCut4 !== null && recordCut4 < 0 ? "more" : "less"} error at four quarters</span>
              <span className="note">
                refitted every year
                {recordOrigins !== null && recordStart ? `, over the ${recordOrigins} origins from ${recordStart} on` : ""}, against
                the rule that says nothing changes
              </span>
            </li>
            <li>
              <span className="value">{band4 !== null ? `${asPercent(Math.abs(band4))}%` : "-"}</span>
              <span className="label">{band4 !== null && band4 < 0 ? "wider" : "narrower"} band at four quarters</span>
              <span className="note">in the fixed split, against the metro's own long run average</span>
            </li>
            <li>
              <span className="value">{points(cover8)}</span>
              <span className="label">band coverage at eight quarters</span>
              <span className="note">
                in the fixed split, against a nominal {points(NOMINAL_COVERAGE)}
                {cover8 === null ? "" : misses8 ? ", and that is a miss" : ", and that holds"}
              </span>
            </li>
          </ul>
        </header>

        <section className="model-section">
          <h3>The panel</h3>
          <p>
            One row per metro per quarter: {PANEL.metros} metros, {PANEL.first} to {PANEL.last},{" "}
            {PANEL.rows.toLocaleString("en-US")} rows. The FHFA all-transactions index is the thing being
            forecast. {sentenceCase(inWords(features))} features feed the models and{" "}
            {inWords(INPUTS.context)} more columns ride along for the figures without reaching one.
          </p>
          <p>
            A value enters the panel when it was published. A monthly value is known in the month it
            covers. An annual value enters when its source publishes it: population and migration from
            the first quarter of the next year, permits from the second, income from the fourth, and a
            release that came out late from the quarter it landed in. Population growth across the 2019
            to 2020 change of census base and county lines is left out rather than read as a year of
            growth. A metropolitan division inherits what it lacks from its parent metro. The build
            writes a manifest with row counts, the non-null share of every column and the hash of the
            panel it produced.
          </p>
          <p>
            Three things the panel cannot undo. FHFA revises past quarters as later sales come in, so
            every origin reads the vintage of the index that runs through {PANEL.last}, not the one
            published at the time. Population and income are later vintages too: the population
            estimates come from Census releases made after the years they cover, and income is BEA's
            current revision. And the expanded-data index reaches back for all {PANEL.metros} metros,
            though FHFA published it for {EXPANDED_BEFORE} before its {EXPANDED_FOR_ALL_FROM} report,
            which the section on the models deals with.
          </p>
          <ModelFigure id="coverage" />
          <p>
            How late a series starts matters more than it looks. A feature can only be learned where
            the model is fitted, and that is not the whole train block: its last three years are held
            out for validation, so a model fits on outcomes through {fitEnd}. The rule down the middle
            of the figure above is that date.
            {unseen.length > 0
              ? ` ${sentenceCase(unseenNames)} ${unseen.length === 1 ? "has" : "have"} nothing left of it, so the two networks in the backtest below read ${inWords(seen)} of the ${inWords(features)} features, while the forecast the map draws, refitted through ${PANEL.last}, reads all ${inWords(features)}.`
              : PANEL_COVERAGE
                ? ` Every feature has something left of it, so the backtest below and the forecast the map draws read the same ${inWords(features)}.`
                : ""}
          </p>
          <p>
            Two sources that started late could be pulled back further and were
            {firstYear("unemp") !== null && firstYear("mortgage") !== null
              ? `: unemployment now starts in ${firstYear("unemp")} and the mortgage rate in ${firstYear("mortgage")}`
              : ", unemployment and the mortgage rate"}
            .{unseen.length > 0 ? ` ${sentenceCase(unseenNames)} ${unseen.length === 1 ? "has" : "have"} not been.` : ""}
          </p>
        </section>

        <section className="model-section">
          <h3>The evaluation design</h3>
          <p>
            This is the part that makes the numbers mean anything. The target is log growth of the
            index over h quarters. A sample is one metro, one origin quarter, one horizon, and it
            lands in a block by where its outcome falls, never by where it starts.
          </p>
          <div className="model-scroll">
            <table className="model-table blocks">
              <caption>The three blocks, and what each one is allowed to touch.</caption>
              <thead>
                <tr>
                  <th scope="col">block</th>
                  <th scope="col">outcome realized</th>
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
            Because the outcome quarter decides the block, one origin sits in different blocks at
            different horizons. No outcome realized after 2021 reaches a model judged on 2022 onward,
            though every block reads the later vintages described under the panel.
          </p>
          <ModelFigure id="design" />
          <p>
            An earlier version of this rule read the block off the origin instead. That cut the
            calibration samples at eight quarters in half and put every one of them in the 2020 to 2021
            boom, so every published band width came off two years of the least representative data in
            the panel. The blocks are horizon independent now
            {CALIBRATION_N !== null && scoredN !== null
              ? `: ${CALIBRATION_N.toLocaleString("en-US")} calibration samples and ${scoredN.toLocaleString("en-US")} test samples at every horizon`
              : ""}
            .
          </p>
          <p>
            The bands are conformalized quantile regression. The model predicts the 10th, 50th and
            90th percentiles, and the calibration block sets the smallest widening of that band that
            covers at least {Math.round(NOMINAL_COVERAGE * 100)} percent of held-out outcomes, with the
            finite sample correction of Romano, Patterson and Candes (2019). That guarantee assumes
            exchangeable samples, and quarters are not exchangeable. So the coverage measured on the test
            block is the honest number, and it is printed beside every model below.
          </p>
        </section>

        <section className="model-section">
          <h3>The models</h3>
          <p>
            Five classical rules set the bar: no change, momentum, the metro's own average growth,
            ridge on price lags and covariates, and gradient boosting with quantile losses. Two
            networks share one input: 24 quarters of {inWords(INPUTS.sequence)} series each with a
            presence mask, {inWords(INPUTS.annual)} annual features at the origin, and a learned embedding per metro. The window MLP flattens
            that into a three layer perceptron. The sequence GRU reads it as a sequence and
            concatenates the final state with the annual features and the embedding. Both emit three
            monotone quantiles per horizon and train on pinball loss with Adam, weight decay and
            early stopping.
          </p>
          <p>
            Learning rate, weight decay and the input set are chosen on validation loss, never on
            test. The validation set is the tail of the train block, outcomes realized {heldBack},
            and what is left of that block is what the model fits on. Permits and income, which the
            fitting part never sees, were admitted by a second run, described below, that fits into
            the calibration block and scores the rest of it.
          </p>
          <ModelFigure id="training" />
          <p>
            Two of the {inWords(INPUTS.sequence)} series come from a file FHFA publishes beside the
            index that this project had downloaded and never read: the expanded-data index, a second
            estimate of the same metro quarter built from more records, and the relative standard error
            FHFA reports for it, a percent of the index. That error is the only published measure of how
            thin a metro's repeat-sale record is
            {error
              ? `, and it is the difference between ${error.lowest.name} measured to within ${points(error.lowest.value)} percent and ${error.highest.name} measured to within ${points(error.highest.value)} percent`
              : ""}
            . The model has no other way to know that.
          </p>
          <p>
            That file is also where the input rules changed. FHFA published the expanded-data index for{" "}
            {EXPANDED_BEFORE} metros until its {EXPANDED_FOR_ALL_FROM} report, and for all {PANEL.metros}{" "}
            since{expandedFrom !== null ? `, with its history back to ${expandedFrom}` : ""}. So the backtest
            below reads the index and its error only for those {EXPANDED_BEFORE}: for the other{" "}
            {newlyExpanded} both are masked at every quarter before {EXPANDED_FOR_ALL_FROM}, because no model
            could have read them then. The forecast the map draws reads them for all {PANEL.metros}, because
            FHFA publishes them now. Its band margin comes from a band model that, like the backtest, reads
            them only where they were published, so that band is conservative for the metros that gained
            them. What the index really adds for those metros is measured as outcomes land, not assumed here.
          </p>
          <p>
            Input sets were compared on validation loss and nothing else, and ml/README.md carries the
            tables. One run of a set moves with its seed, so a margin between two sets that is smaller
            than the spread across seeds of one set is not read as a result either way. The expanded
            index and its error stay in on other grounds: a forecast made now reads both for every
            metro, and what they add in real time is measured as outcomes land. The national series,
            CPI, the ten year, the term spread and national unemployment, stay out: one number shared by
            every metro tells a window which era it sits in and nothing about the place. The rejected
            columns stay in the panel, out of reach of every model, because a negative result that is
            one command from being re-run is worth more than one written down.
          </p>
          <p>
            That comparison has a blind spot. A feature the fitting part of the train block never sees
            is blanked in validation as well, in both sets, so permits and income, and rents and listing
            prices, were never measured there at all. A second run moves the boundary instead: it fits
            into the calibration block, scores the rest of it, never reads the test block, and compares
            sets seed for seed.{admitted ? ` ${admitted}` : ""} Inventory starts too late to be measured
            without spending the block that would score it. The years the run scores are the boom, the
            only window left between the old fitting block and the test block.
          </p>
        </section>

        <section className="model-section">
          <h3>The results, 2022Q1 onward</h3>
          <p>
            One split: every model fitted once, with nothing realized after {trainYear} in its fit, and scored once
            on the test block. Here the GRU {cutPhrase(cut4, cut8)}{fixedP}, and {bandPhrase(band4, band8)}.
            {record.length > 0 ? " The walk-forward record below replays the same models refitted every year." : ""}
          </p>
          <div className="model-scroll">
            <table className="model-table board">
              <caption>
                The test block, scored once.
                {scoredN !== null ? ` Every model sees the same ${scoredN.toLocaleString("en-US")} samples at each horizon.` : ""}
                {" "}The first number is the mean absolute error of the median forecast, in percentage
                points of growth, so lower is better. Under it: the share of outcomes that fell inside
                the 90 percent band, and that band's mean width in log growth units.
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
            No change, momentum and the metro mean read no inputs at all, so a new feature cannot move
            them: they are the fixed bar. Ridge and gradient boosting read the {inWords(features)} features
            at the origin, plus lags of the metro's quarterly price growth, its running mean and a
            national growth mean, and fit on the whole train block, through {TRAIN_END}. The two networks
            read a 24 quarter window and fit through {fitEnd}, holding {heldBack} back to choose their
            epochs.
            {moreFit
              ? ` So the classical rules learn from ${moreFit} than the networks${unseenInTrain ? `, ${unseenNames} among them` : ""}, and neither side fits on an outcome past ${trainYear}.`
              : ""}
          </p>
          {pairedFound && (
            <p>
              A lower mean error can be luck, so the GRU is also tested against
              {tested.length === pairedRivals.length ? " every other model on the table" : ` ${joinList(tested.map(proseName))}`}, a
              horizon at a time, on the samples both scored. Metros at one origin share its shocks, so they
              are not independent draws: the gap between two errors is averaged across metros at each origin
              first, and the test, Diebold and Mariano's with the small sample correction of Harvey, Leybourne
              and Newbold, asks whether its mean over {origins !== null ? `the ${origins} origins` : "the origins"} is far
              enough from zero, allowing for the quarters that overlapping outcomes share. {pairedFound}
            </p>
          )}
          <h4>Three honest readings</h4>
          <ul className="model-readings">
            <li>
              {wins.length > 0
                ? `The sequence GRU has the lowest error at ${horizonPhrase(wins)}.`
                : "The sequence GRU has the lowest error at no horizon in this build."}
              {" "}It {cutPhrase(cut4, cut8)}, and {meanReading}. That
              average goes from {points(longRun4?.maePct)} to {points(longRun8?.maePct)} points as the horizon
              doubles while the GRU goes {points(shipped4?.maePct)} to {points(shipped8?.maePct)}.
              {meanTest ? ` ${meanTest}` : ""}
            </li>
            <li>
              {lossText
                ? `It loses at ${horizonPhrase(lossHorizons)}, where ${lossText}.`
                : "In this build it is ahead at every horizon, which is not the usual result and is worth re-reading rather than celebrating."}
              {ridgeSentence ? ` ${ridgeSentence}` : ""}
              {ridgeAll
                ? ` ${ridgeVerdict(PAIRED, horizons)}`
                : ridgeFirst ? " A penalised linear model is hard to beat one quarter out, and that is worth saying out loud." : ""}
            </li>
            <li>
              {closest8
                ? `At eight quarters the nearest rival is ${modelLabel(closest8.model)}, ${points(closest8.gap)} points away, which is ${asPercent(gapShare8) ?? "-"} percent of the error it sits inside.${won8 && band8 !== null && band8 > 0 ? ` The GRU's case at that horizon rests as much on its band being ${asPercent(band8)} percent narrower than the long run average's as on those points.` : ""}`
                : "At eight quarters the field is too thin in this build to name a rival."}
            </li>
          </ul>
          <ModelFigure id="calibration" />
        </section>

        {record.length > 0 && recordFrom && (
          <section className="model-section">
            <h3>The walk-forward record, {recordFrom} onward</h3>
            <p>
              The split above is not how a forecaster lives. Its models never learn from anything realized after{" "}
              {trainYear}, its paired test has {origins !== null ? `${origins} origins` : "the origins"} from one cycle,
              and it reads FHFA's index as FHFA prints it today, when every release revises past quarters. The
              walk-forward record replays the forecasts instead. Every model is refitted once a year from {REFIT_FROM}:
              the model for a year fits on outcomes realized by the end of the year before and forecasts every origin
              in its year, so each forecast is out of sample for the model that made it. Every forecast and every refit
              reads FHFA's index as the release of its day printed it, out of ALFRED's archive of those releases, and
              scoring keeps today's index as the truth.
              {joined.includes(AVERAGE)
                ? ` One model joins the ${inWords(modelsIn(rows).length)} above: the GRU and ridge averaged quantile by quantile, called the average below.`
                : ""}
            </p>
            <div className="model-scroll">
              <table className="model-table board">
                <caption>
                  Mean absolute error of the median forecast
                  {recordOrigins !== null ? ` over the ${recordOrigins} origins` : ""} whose outcomes land from {recordFrom} on
                  {recordN !== null ? `, ${recordN.toLocaleString("en-US")} samples at each horizon` : ""}, read from the
                  vintages, in percentage points of growth, so lower is better. Under it: the p value of the paired test of
                  that model against the sequence GRU.
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
                  The band gets the same replay. The fixed calibration window
                  {misses8 ? " under-covers at eight quarters, and it also" : ""} looks ahead a little: its 2020 and 2021
                  outcomes calibrate test forecasts made at 2020 and 2021 origins. The online band is the one a
                  forecaster living through the record could have run. At each origin its margin is the conformal
                  quantile of every score realized by then, over a trailing window or all of them, and the miss rate it
                  aims for moves with the misses as they land, adaptive conformal inference after Gibbs and Candes
                  (2021). An optional per-metro scale, the metro's trailing volatility of quarterly growth, widens a
                  volatile metro's band against a quiet one's. The settings are chosen by mean interval score on outcomes
                  from {BAND_TUNE[0]} to {BAND_TUNE[1]} and nothing later{settings ? `, and for the GRU they are ${settings}` : ""}.
                  The rule, again written first: the online band replaces the static one only if its interval score is
                  lower at {inWords(RULE_HORIZONS)} of the {inWords(bandPairsRecent.length)} horizons on {recentStart} onward.
                </p>
                <div className="model-scroll">
                  <table className="model-table">
                    <caption>
                      The sequence GRU's two bands
                      {recentOrigins !== null ? ` over the ${recentOrigins} origins` : ""} whose outcomes land from {recentFrom} on,
                      read from the vintages. The first number is the band's mean interval score: its width plus{" "}
                      {Math.round(2 / missRate)} times the distance by which an outcome lands outside it, so lower is
                      better. Under it: the share of outcomes inside the {Math.round(NOMINAL_COVERAGE * 100)} percent
                      band, and its mean width. The score and the width are in log growth units.
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
            What the map draws is not the model the table above scored. It is the GRU refitted on every
            outcome realized by {origin ?? "the last quarter of the panel"}, at the epoch count found on
            validation, and it reads all {inWords(features)} features, the expanded index for every metro
            among them{unseen.length > 0 ? `, where the backtested GRU read ${inWords(seen)} and that index for ${EXPANDED_BEFORE} metros` : ""}.
            Its band margin is out of sample: a second GRU fitted through 2021 and calibrated on 2022 onward,
            whose margin is applied to the refit's quantiles.
          </p>
          <p>
            The GRU ships because {WHY_SHIPPED}. Of the window MLP and the GRU, the one with the lower error
            on the calibration block at four quarters goes on the map, and ridge and the other classical rules
            are never in that choice.
            {ridgeAll
              ? " So the map carries a model that ridge matches or beats at every horizon on the fixed split's table, on error and on band width."
              : ""}
            {weighed}
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
            Only the expected growth lines in the map's Forecasts group are forecasts. The growth over the
            last four quarters and the five year annualized trend are what the FHFA index did up to the
            origin, worked out in the model's export and credited to FHFA rather than to the model, and the
            surprise scores the backtest's call from four quarters before the origin against what then
            happened. The index standard error is FHFA's own
            measurement, a percent of the index, credited to FHFA, and it rides in the model's export because
            nothing else on the map carries it. It belongs beside a forecast, and each metro's detail panel
            puts it there, because it says how firmly the thing being forecast is even measured
            {error
              ? `: ${points(error.lowest.value)} percent in ${error.lowest.name} against ${points(error.highest.value)} percent in ${error.highest.name}`
              : ""}
            . A wide error there is a reason to read the forecast above it loosely.
          </p>
        </section>

        <section className="model-section model-limits">
          <h3>The limits</h3>
          <p>
            This is not the footnote. It is the part a reader deciding whether to trust the map should
            read first.
          </p>
          <ul>
            <li>
              <strong>
                {misses8
                  ? "The bands fail at eight quarters."
                  : cover8 !== null ? "The bands hold at eight quarters in this build." : "The bands at eight quarters are not scored in this build."}
              </strong>{" "}
              The sequence GRU's backtest band covers {points(cover8)} of outcomes there against a nominal{" "}
              {points(NOMINAL_COVERAGE)}
              {eighth
                ? allUnderCover(rows, 8)
                  ? `, and no model on the table escapes it: the field runs ${points(eighth.low.coverage)} for ${modelLabel(eighth.low.model)} to ${points(eighth.high.coverage)} for ${modelLabel(eighth.high.model)}`
                  : `, and the field runs ${points(eighth.low.coverage)} for ${modelLabel(eighth.low.model)} to ${points(eighth.high.coverage)} for ${modelLabel(eighth.high.model)}`
                : ""}
              . The calibration block is fixed at 2018 to 2021 by choice. Conformal coverage is guaranteed
              only for exchangeable samples: calibration outcomes land in the run up and the boom, test
              outcomes land in the correction, and no margin fitted on the first is promised to cover the
              second.
              {/* a repair is only worth ruling out while there is a miss to repair */}
              {misses8
                ? ` Rolling the calibration window forward would fix the number by calibrating on the period being scored, which is leakage, so it is reported rather than repaired.${shiftTried}`
                : " Rolling the calibration window forward would calibrate on the period being scored, which is leakage, so the window stays where it is."}
            </li>
            <li>
              {lossText ? (
                <>
                  <strong>
                    {lostAll ? "It loses every horizon." : lossesShort ? "It loses the short horizons." : `It loses at ${horizonPhrase(lossHorizons)}.`}
                  </strong>{" "}
                  {`${sentenceCase(lossText)}.`}
                  {ridgeAll
                    ? ` ${ridgeSentence} ${ridgeVerdict(PAIRED, horizons)}${pairedWith(PAIRED, "ridge").length > 0 && separatedAt(PAIRED, "ridge").length === 0 ? "" : ` The GRU is on the map only because ${WHY_SHIPPED}.`}`
                    : ridgeFirst && lossHorizons.includes(shortest)
                      ? ` If the question is one quarter out, the penalised linear model is the better answer${winsLong ? ", and the network earns its place only as the horizon lengthens" : ""}.`
                      : ""}
                </>
              ) : (
                <>
                  <strong>It loses no horizon.</strong> Not in this build, which is worth checking rather than celebrating.
                </>
              )}
            </li>
            {closest8 && winner8 && (won8 || lost8) && (
              <li>
                {won8 ? (
                  <>
                    <strong>{gapShare8 !== null && gapShare8 < 0.05 ? "The long horizon win is thin." : "The long horizon win."}</strong>{" "}
                    {`The nearest rival, ${modelLabel(closest8.model)}, is ${points(closest8.gap)} points behind at eight quarters, ${points(rowAt(rows, closest8.model, 8)?.maePct)} against ${points(shipped8?.maePct)}, ${asPercent(gapShare8) ?? "-"} percent of the error. It separates two runs and not two ideas, and this table ranks runs.`}
                  </>
                ) : (
                  <>
                    <strong>It does not win the long horizon.</strong>{" "}
                    {`${sentenceCase(modelLabel(winner8.model))} is ahead at eight quarters, ${points(winner8.maePct)} against ${points(shipped8?.maePct)}.`}
                  </>
                )}
              </li>
            )}
            <li>
              <strong>Some series are thin exactly where the model is taught.</strong>
              {zhviFrom !== null ? ` Zillow values start in ${zhviFrom}, late in the fitting block.` : ""}
              {emptyContext.length > 0
                ? ` ${sentenceCase(joinList(emptyContext))} have nothing left of the rule, and ride in the panel and on the map out of reach of every model.`
                : " Rents, listing prices and inventory ride in the panel and on the map out of reach of every model."}
              {" "}Keeping their monthly history would not change that: the fix is a later fitting era, not a
              better collector, and a later fitting era buys fewer years to learn from.
            </li>
            <li>
              <strong>The expanded index is new for most metros.</strong> The forecast reads FHFA's
              expanded-data index for all {PANEL.metros} metros, but for the {newlyExpanded} FHFA added in its{" "}
              {EXPANDED_FOR_ALL_FROM} report nothing could have read it before then, so the backtest does not, and
              there is no held-out score for what it adds there. Their band is set by a band model that did not
              read it, which is the conservative side, and what the index is worth for them is measured as
              outcomes land.
            </li>
          </ul>
        </section>

        <p className="model-foot">
          The leaderboard, the walk-forward record, the panel's facts and every number the figures'
          descriptions give are generated from ml/results at build time, and the forecast prose is measured off
          the same data file the map draws, so a retrain or a fresh export moves this page with it. The full walkthrough, with the
          input hashes and the commands that reproduce every figure, is ml/README.md in the repository.
        </p>
      </div>
    </main>
  );
}
