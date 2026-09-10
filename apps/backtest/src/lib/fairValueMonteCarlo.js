import { blackScholesPrice } from "./optionPricing.js";
import { blackScholesDelta, normalizeVol } from "./optionRisk.js";
import { mean } from "./statistics.js";
import { calibrateBatesModel } from "../../../../lib/batesCalibration.js";
import {
  buildIntraWeekSimulationTimes,
  buildQuadraticVariationBudget,
  generateBatesPath,
  simulateBatesRealizedVol,
} from "../../../../lib/batesSimulation.js";

const SECONDS_PER_YEAR = 365 * 86_400;
const EPSILON = 1e-12;
export const HEDGE_MODES = ["unhedged", "dynamic"];
export const ANNUAL_DRIFT_VARIANTS = [-1, 0, 1];

const quantile = (values, probability) => {
  if (!values.length) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const weight = position - lower;
  return sorted[lower] + (sorted[lower + 1] - sorted[lower] || 0) * weight;
};

const populationStdDev = (values) => {
  if (!values.length) return Number.NaN;
  const average = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
};

const IV_REGIMES = [
  { label: "Low IV", rangeLabel: "z < −1", accepts: (zScore) => zScore < -1 },
  { label: "Medium IV", rangeLabel: "−1 ≤ z < +1", accepts: (zScore) => zScore >= -1 && zScore < 1 },
  { label: "High IV", rangeLabel: "z ≥ +1", accepts: (zScore) => zScore >= 1 },
];

const PRICE_MOVE_COHORT_LABELS = [
  "Lowest BTC moves",
  "Middle BTC moves",
  "Highest BTC moves",
];

const formatSignedPercent = (value) => {
  const rounded = Math.abs(value) < 0.0005 ? 0 : value;
  const sign = rounded < 0 ? "−" : rounded > 0 ? "+" : "";
  return `${sign}${Math.abs(rounded * 100).toFixed(1)}%`;
};

const buildPriceMoveGroups = (cycles) => {
  const ordered = [...cycles].sort(
    (first, second) =>
      (first.exitSpot / first.entrySpot) - (second.exitSpot / second.entrySpot),
  );
  const baseSize = Math.floor(ordered.length / PRICE_MOVE_COHORT_LABELS.length);
  const remainder = ordered.length % PRICE_MOVE_COHORT_LABELS.length;
  let start = 0;
  return PRICE_MOVE_COHORT_LABELS.map((label, index) => {
    const size = baseSize + (index < remainder ? 1 : 0);
    const cohortCycles = ordered.slice(start, start + size);
    start += size;
    const moves = cohortCycles.map((cycle) => cycle.exitSpot / cycle.entrySpot - 1);
    return {
      label,
      rangeLabel: moves.length
        ? `${formatSignedPercent(moves[0])} to ${formatSignedPercent(moves.at(-1))}`
        : "no observed weeks",
      cycles: cohortCycles,
    };
  });
};

export const createSeededRandom = (seed = 1) => {
  let state = Number(seed) >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
};

const createNormalRandom = (uniform) => {
  let spare = null;
  return () => {
    if (spare != null) {
      const value = spare;
      spare = null;
      return value;
    }
    const radius = Math.sqrt(-2 * Math.log(Math.max(EPSILON, uniform())));
    const angle = 2 * Math.PI * uniform();
    spare = radius * Math.sin(angle);
    return radius * Math.cos(angle);
  };
};

// Keep the volatility choice isolated so a surface-based model can replace it later.
export const resolveCycleEntryVol = (cycle) => {
  const legs = (cycle?.legs || []).filter((leg) =>
    Number.isFinite(Number(leg.entryImpliedVol)),
  );
  if (!legs.length) return Number.NaN;
  const closestDistance = Math.min(...legs.map((leg) =>
    Math.abs(Number(leg.strike) - Number(cycle.entryIndexPrice)),
  ));
  const atmLegs = legs.filter((leg) =>
    Math.abs(Number(leg.strike) - Number(cycle.entryIndexPrice)) === closestDistance,
  );
  return mean(atmLegs.map((leg) => normalizeVol(Number(leg.entryImpliedVol))));
};

const modelLeg = (leg, spot, ts, sigma) => {
  if (ts >= leg.expirationTs) {
    return leg.optionType === "C"
      ? Math.max(spot - leg.strike, 0)
      : Math.max(leg.strike - spot, 0);
  }
  return blackScholesPrice(leg, spot, ts, sigma);
};

const modelLegDelta = (leg, spot, ts, sigma) => {
  if (ts >= leg.expirationTs) return 0;
  return blackScholesDelta({
    spot,
    strike: leg.strike,
    yearsToExpiry: Math.max(0, (leg.expirationTs - ts) / SECONDS_PER_YEAR),
    impliedVol: sigma,
    optionType: leg.optionType,
  });
};

export const buildFairValueCycleState = (cycle) => {
  const entryTs = new Date(cycle.entryTime).getTime() / 1000;
  const exitTs = new Date(cycle.exitTime).getTime() / 1000;
  const entrySpot = Number(cycle.entryIndexPrice);
  const exitSpot = Number(cycle.exitIndexPrice);
  const sigma = resolveCycleEntryVol(cycle);
  if (![entryTs, exitTs, entrySpot, exitSpot, sigma].every(Number.isFinite)
    || entrySpot <= 0 || exitSpot <= 0 || exitTs <= entryTs) {
    throw new Error(`Cycle ${cycle.cycle ?? "?"} has an invalid simulation price state`);
  }
  const legs = (cycle.legs || []).map((leg) => ({
    optionType: leg.optionType,
    strike: Number(leg.strike),
    expirationTs: Number(leg.expirationTs),
    quantity: Number(leg.quantity),
    entryDelta: Number(leg.entryDelta),
  }));
  if (!legs.length || legs.some((leg) =>
    ![leg.strike, leg.expirationTs, leg.quantity].every(Number.isFinite),
  )) {
    throw new Error(`Cycle ${cycle.cycle ?? "?"} has invalid option legs`);
  }

  const fairEntryOptionValue = legs.reduce((total, leg) =>
    total + leg.quantity * modelLeg(leg, entrySpot, entryTs, sigma),
  0);
  const observedEntryCashflow = Number(cycle.entryOptionCashflowUsd);
  const entryCashflow = Number.isFinite(observedEntryCashflow)
    ? observedEntryCashflow
    : -fairEntryOptionValue;
  const entryPortfolioDelta = legs.reduce((total, leg) => {
    const delta = Number.isFinite(leg.entryDelta)
      ? leg.entryDelta
      : blackScholesDelta({
          spot: entrySpot,
          strike: leg.strike,
          yearsToExpiry: (leg.expirationTs - entryTs) / SECONDS_PER_YEAR,
          impliedVol: sigma,
          optionType: leg.optionType,
        });
    return total + leg.quantity * delta;
  }, 0);

  const actualDynamicPnl = Number(cycle.cyclePnlUsd) || 0;
  const actualUnhedgedPnl = Number.isFinite(Number(cycle.shortOptionPnlUsd))
    ? Number(cycle.shortOptionPnlUsd)
    : actualDynamicPnl - (Number(cycle.hedgePnlUsd) || 0);
  const state = {
    cycle: Number(cycle.cycle),
    entryTs,
    exitTs,
    entrySpot,
    exitSpot,
    sigma,
    legs,
    entryCashflow,
    fairEntryCashflow: -fairEntryOptionValue,
    premiumBasisUsd: Math.max(EPSILON, Math.abs(entryCashflow)),
    notionalBasisUsd: Math.max(
      EPSILON,
      Number(cycle.investmentUsd) || Number(cycle.notionalUsd) || 100_000,
    ),
    underlyingQuantity: Number(cycle.underlyingQuantity) || 0,
    hedgeEnabled: cycle.hedgeEnabled !== false,
    hedgeIntervalHours: Math.max(1, Number(cycle.hedgeIntervalHours) || 24),
    hedgeDeltaTolerance: Math.max(0, Number(cycle.hedgeDeltaTolerance) || 0),
    hedgeCostBps: Math.max(0, Number(cycle.hedgeCostBps) || 0),
    entryPortfolioDelta,
    actualPnlByMode: {
      unhedged: cycle.underlyingQuantity > 0 ? actualDynamicPnl : actualUnhedgedPnl,
      dynamic: actualDynamicPnl,
    },
  };
  state.simulationTimes = buildSimulationTimes(state);
  return state;
};

const optionPnlAt = (cycle, spot, ts) => cycle.entryCashflow
  + cycle.legs.reduce((total, leg) =>
    total + leg.quantity * modelLeg(leg, spot, ts, cycle.sigma), 0);

const portfolioDeltaAt = (cycle, spot, ts) => cycle.legs.reduce((total, leg) =>
  total + leg.quantity * modelLegDelta(leg, spot, ts, cycle.sigma), 0);

const buildSimulationTimes = (cycle) => {
  const holdingSeconds = cycle.exitTs - cycle.entryTs;
  const intervalSeconds = cycle.hedgeIntervalHours * 3_600;
  const times = new Set([holdingSeconds]);
  for (let elapsed = intervalSeconds; elapsed < holdingSeconds; elapsed += intervalSeconds) {
    times.add(elapsed);
  }
  return [...times].sort((a, b) => a - b);
};

export const generateGbmPath = ({
  cycle,
  normalRandom,
  annualDrift = 0,
}) => {
  const times = cycle.simulationTimes || buildSimulationTimes(cycle);
  let previousElapsedSeconds = 0;
  let logSpot = Math.log(cycle.entrySpot);
  return times.map((elapsedSeconds) => {
    const dtYears = (elapsedSeconds - previousElapsedSeconds) / SECONDS_PER_YEAR;
    logSpot += (annualDrift - 0.5 * cycle.sigma ** 2) * dtYears
      + cycle.sigma * Math.sqrt(dtYears) * normalRandom();
    previousElapsedSeconds = elapsedSeconds;
    return {
      ts: cycle.entryTs + elapsedSeconds,
      elapsedSeconds,
      spot: Math.exp(logSpot),
    };
  });
};

const dynamicHedgePnl = ({ cycle, path }) => {
  const intervalSeconds = cycle.hedgeIntervalHours * 3_600;
  let hedgeQuantity = -cycle.entryPortfolioDelta;
  let previousSpot = cycle.entrySpot;
  let hedgePnl = 0;
  let costs = Math.abs(hedgeQuantity) * cycle.entrySpot * cycle.hedgeCostBps / 10_000;
  for (const point of path) {
    hedgePnl += hedgeQuantity * (point.spot - previousSpot);
    previousSpot = point.spot;
    const isExit = Math.abs(point.ts - cycle.exitTs) < 1e-7;
    const isScheduled = !isExit
      && Math.abs(point.elapsedSeconds / intervalSeconds - Math.round(point.elapsedSeconds / intervalSeconds)) < 1e-7;
    if (!isExit && !isScheduled) continue;
    const targetQuantity = isExit ? 0 : -portfolioDeltaAt(cycle, point.spot, point.ts);
    const tradeQuantity = targetQuantity - hedgeQuantity;
    if (!isExit && Math.abs(tradeQuantity) < cycle.hedgeDeltaTolerance) continue;
    costs += Math.abs(tradeQuantity) * point.spot * cycle.hedgeCostBps / 10_000;
    hedgeQuantity = targetQuantity;
  }
  return hedgePnl - costs;
};

export const simulateWeeklyCycleModes = (
  cycle,
  normalRandom,
  annualDrift = 0,
  batesContext = null,
) => {
  const path = batesContext
    ? generateBatesPath({
        cycle,
        calibration: batesContext.calibration,
        normalRandom,
        uniformRandom: batesContext.uniformRandom,
        annualDrift,
        budget: batesContext.budget,
      })
    : generateGbmPath({ cycle, normalRandom, annualDrift });
  const terminalSpot = path.at(-1).spot;
  const unhedged = optionPnlAt(cycle, terminalSpot, cycle.exitTs)
    + (cycle.underlyingQuantity || 0) * (terminalSpot - cycle.entrySpot);
  return {
    unhedged,
    dynamic: unhedged + dynamicHedgePnl({ cycle, path }),
  };
};

const buildRealizedVolSensitivity = ({
  cycles,
  calibration,
  seed,
  drawsPerCycle = 24,
}) => {
  const uniformRandom = createSeededRandom((Number(seed) + 0x51ed270b) >>> 0);
  const normalRandom = createNormalRandom(uniformRandom);
  const drawsForEachCycle = Math.max(
    drawsPerCycle,
    Math.ceil(240 / Math.max(1, cycles.length)),
  );
  return calibration.sensitivity.map((sensitivity) => {
    const variant = {
      ...calibration,
      threshold: sensitivity.threshold,
      jumps: sensitivity._model.jumps,
      variance: sensitivity._model.variance,
      diagnostics: {
        ...calibration.diagnostics,
        varianceSeries: sensitivity._model.varianceSeries,
      },
    };
    const budgets = cycles.map((cycle) =>
      buildQuadraticVariationBudget({ cycle, calibration: variant }));
    const relativeRealizedVols = [];
    const weekly = cycles.map((cycle, cycleIndex) => {
      const realizedVols = [];
      for (let draw = 0; draw < drawsForEachCycle; draw += 1) {
        const realizedVol = simulateBatesRealizedVol({
          cycle,
          calibration: variant,
          normalRandom,
          uniformRandom,
          budget: budgets[cycleIndex],
        });
        realizedVols.push(realizedVol);
        relativeRealizedVols.push(realizedVol / Math.max(EPSILON, cycle.sigma));
      }
      const budget = budgets[cycleIndex];
      return {
        cycle: cycle.cycle,
        entryTs: cycle.entryTs,
        regime: budget.regime,
        samples: realizedVols.length,
        p10Vol: quantile(realizedVols, 0.1),
        medianVol: quantile(realizedVols, 0.5),
        p90Vol: quantile(realizedVols, 0.9),
        expectedVol: Math.sqrt(budget.targetQv / Math.max(EPSILON, budget.years)),
        diffusiveForecastVol: Math.sqrt(
          budget.expectedDiffusiveQv / Math.max(EPSILON, budget.years),
        ),
        jumpForecastVol: Math.sqrt(
          budget.expectedJumpQv / Math.max(EPSILON, budget.years),
        ),
      };
    });
    const averageAnnualizedVariance = (selector) => mean(budgets.map((budget) =>
      selector(budget) / Math.max(EPSILON, budget.years)));
    return {
      threshold: sensitivity.threshold,
      samples: relativeRealizedVols.length,
      p10Ratio: quantile(relativeRealizedVols, 0.1),
      medianRatio: quantile(relativeRealizedVols, 0.5),
      p90Ratio: quantile(relativeRealizedVols, 0.9),
      totalForecastVol: Math.sqrt(averageAnnualizedVariance((budget) => budget.targetQv)),
      diffusiveForecastVol: Math.sqrt(
        averageAnnualizedVariance((budget) => budget.expectedDiffusiveQv),
      ),
      jumpForecastVol: Math.sqrt(
        averageAnnualizedVariance((budget) => budget.expectedJumpQv),
      ),
      weekly,
    };
  });
};


const summarizeDistribution = (values, actualPnl) => {
  const count = values.length;
  const belowOrEqual = values.filter((value) => value <= actualPnl).length;
  const atOrAboveActual = values.filter((value) => value >= actualPnl).length;
  return {
    actualPnl,
    mean: mean(values),
    standardDeviation: populationStdDev(values),
    median: quantile(values, 0.5),
    p01: quantile(values, 0.01),
    p05: quantile(values, 0.05),
    p95: quantile(values, 0.95),
    p99: quantile(values, 0.99),
    actualPercentile: count ? 100 * belowOrEqual / count : Number.NaN,
    scenariosAtOrAboveActual: atOrAboveActual,
    probabilityAtOrAboveActual: count
      ? (atOrAboveActual + 1) / (count + 1)
      : Number.NaN,
    probabilityExceedsActual: count
      ? values.filter((value) => value > actualPnl).length / count
      : Number.NaN,
  };
};

export const summarizeBayesianEdge = ({
  cycles,
  hedgeMode,
  seed = 1,
  draws = 5_000,
}) => {
  const observations = cycles.map((cycle) =>
    cycle.actualPnlByMode[hedgeMode] / Math.max(EPSILON, cycle.notionalBasisUsd));
  if (!observations.length) {
    return {
      draws: 0,
      probabilityEdgePositive: Number.NaN,
      observedMean: Number.NaN,
      posteriorMedian: Number.NaN,
      p05: Number.NaN,
      p95: Number.NaN,
    };
  }
  const uniformRandom = createSeededRandom(seed);
  const posteriorMeans = Array.from({ length: draws }, () => {
    let weightedTotal = 0;
    let totalWeight = 0;
    observations.forEach((observation) => {
      const weight = -Math.log(Math.max(EPSILON, uniformRandom()));
      weightedTotal += weight * observation;
      totalWeight += weight;
    });
    return weightedTotal / totalWeight;
  });
  return {
    draws,
    probabilityEdgePositive: posteriorMeans.filter((value) => value > 0).length / draws,
    observedMean: mean(observations),
    posteriorMedian: quantile(posteriorMeans, 0.5),
    p05: quantile(posteriorMeans, 0.05),
    p95: quantile(posteriorMeans, 0.95),
  };
};

const summarizeGroups = (
  groups,
  samples,
  hedgeMode,
  bayesianGroups = [],
) => groups.map((group, index) => {
  const actualPnl = group.cycles.reduce(
    (sum, cycle) => sum + cycle.actualPnlByMode[hedgeMode],
    0,
  );
  const premiumBasisUsd = Math.max(EPSILON, group.cycles.reduce(
    (sum, cycle) => sum + cycle.premiumBasisUsd,
    0,
  ));
  const notionalBasisUsd = Math.max(EPSILON, group.cycles.reduce(
    (sum, cycle) => sum + cycle.notionalBasisUsd,
    0,
  ));
  const terminalReturnOnPremium = samples[index].map((value) => value / premiumBasisUsd);
  const terminalReturnOnNotional = samples[index].map((value) => value / notionalBasisUsd);
  return {
    index,
    label: group.label,
    rangeLabel: group.rangeLabel,
    startDate: group.cycles.length ? new Date(group.cycles[0].entryTs * 1000) : null,
    endDate: group.cycles.length ? new Date(group.cycles.at(-1).exitTs * 1000) : null,
    weekCount: group.cycles.length,
    meanEntryIv: group.cycles.length ? mean(group.cycles.map((cycle) => cycle.sigma)) : Number.NaN,
    premiumBasisUsd,
    notionalBasisUsd,
    terminalPnl: [...samples[index]],
    terminalReturnOnPremium,
    terminalReturnOnNotional,
    summary: summarizeDistribution(samples[index], actualPnl),
    returnSummary: summarizeDistribution(
      terminalReturnOnPremium,
      actualPnl / premiumBasisUsd,
    ),
    notionalReturnSummary: summarizeDistribution(
      terminalReturnOnNotional,
      actualPnl / notionalBasisUsd,
    ),
    bayesianEdge: bayesianGroups[index] || null,
  };
});

const summarizeHitRateGroups = (groups, cycles, weeklySamples, hedgeMode) => {
  const cycleIndex = new Map(cycles.map((cycle, index) => [cycle, index]));
  const simulationCount = weeklySamples[0]?.length || 0;
  return groups.map((group, index) => {
    const indexes = group.cycles.map((cycle) => cycleIndex.get(cycle));
    const hitCounts = Array.from({ length: simulationCount }, (_, simulationIndex) =>
      indexes.filter((cycleIndexValue) => weeklySamples[cycleIndexValue][simulationIndex] > 0).length);
    const hitRates = hitCounts.map((hits) => hits / Math.max(1, group.cycles.length));
    const actualHits = group.cycles.filter((cycle) => cycle.actualPnlByMode[hedgeMode] > 0).length;
    const actualHitRate = group.cycles.length ? actualHits / group.cycles.length : Number.NaN;
    const distribution = summarizeDistribution(hitRates, actualHitRate);
    const scenariosAtOrAboveActual = hitCounts.filter((hits) => hits >= actualHits).length;
    return {
      index,
      label: group.label,
      rangeLabel: group.rangeLabel,
      startDate: group.cycles.length ? new Date(group.cycles[0].entryTs * 1000) : null,
      endDate: group.cycles.length ? new Date(group.cycles.at(-1).exitTs * 1000) : null,
      weekCount: group.cycles.length,
      meanEntryIv: group.cycles.length ? mean(group.cycles.map((cycle) => cycle.sigma)) : Number.NaN,
      hitCounts,
      hitRates,
      summary: {
        ...distribution,
        actualHits,
        actualHitRate,
        expectedHitRate: distribution.mean,
        scenariosAtOrAboveActual,
        probabilityAtOrAboveActual: simulationCount
          ? scenariosAtOrAboveActual / simulationCount
          : Number.NaN,
      },
    };
  });
};

// Retained as part of the simulation result contract even though the UI now
// uses the cumulative hit-rate view instead of the weekly percentile strip.
const summarizeWeeklyNullRanks = (cycles, samples, hedgeMode) => cycles.map((cycle, index) => {
  const values = samples[index];
  const actualPnl = cycle.actualPnlByMode[hedgeMode];
  const lessThanActual = values.filter((value) => value < actualPnl).length;
  const equalToActual = values.filter((value) => value === actualPnl).length;
  return {
    cycle: cycle.cycle,
    entryDate: new Date(cycle.entryTs * 1000),
    exitDate: new Date(cycle.exitTs * 1000),
    actualPnl,
    actualReturn: cycle.exitSpot / cycle.entrySpot - 1,
    percentile: values.length
      ? 100 * (lessThanActual + 0.5 * equalToActual) / values.length
      : Number.NaN,
    simulations: values.length,
  };
});

const summarizeMode = ({
  hedgeMode,
  samples,
  requestedSimulations,
  cycles,
  timeGroups,
  ivGroups,
  priceMoveGroups,
  ivMean,
  ivStandardDeviation,
  bayesianEdge,
}) => {
  const terminalPnl = samples.terminalPnl;
  const actualTerminalPnl = timeGroups.flatMap((group) => group.cycles)
    .reduce((sum, cycle) => sum + cycle.actualPnlByMode[hedgeMode], 0);
  const combinedGroups = [{ label: "Combined", cycles }];
  const combined = summarizeGroups(
    combinedGroups,
    [terminalPnl],
    hedgeMode,
    [bayesianEdge.combined],
  )[0];
  const timeCohorts = summarizeGroups(
    timeGroups,
    samples.time,
    hedgeMode,
    bayesianEdge.time,
  );
  const ivRegimes = summarizeGroups(
    ivGroups,
    samples.iv,
    hedgeMode,
    bayesianEdge.iv,
  );
  const priceMoveCohorts = summarizeGroups(
    priceMoveGroups,
    samples.priceMove,
    hedgeMode,
    bayesianEdge.priceMove,
  );
  const combinedHitRate = summarizeHitRateGroups(
    combinedGroups,
    cycles,
    samples.weekly,
    hedgeMode,
  )[0];
  const timeHitRates = summarizeHitRateGroups(timeGroups, cycles, samples.weekly, hedgeMode);
  const ivHitRates = summarizeHitRateGroups(ivGroups, cycles, samples.weekly, hedgeMode);
  const priceMoveHitRates = summarizeHitRateGroups(
    priceMoveGroups,
    cycles,
    samples.weekly,
    hedgeMode,
  );
  return {
    hedgeMode,
    modelLabel: hedgeMode === "dynamic"
      ? "Dynamic hedge under conditional GBM"
      : "Unhedged option PnL under conditional GBM",
    simulations: terminalPnl.length,
    requestedSimulations,
    terminalPnl: [...terminalPnl],
    summary: {
      actualTerminalPnl,
      simulatedMedian: quantile(terminalPnl, 0.5),
      p05: quantile(terminalPnl, 0.05),
      p95: quantile(terminalPnl, 0.95),
      ...summarizeDistribution(terminalPnl, actualTerminalPnl),
    },
    cohorts: timeCohorts,
    combined,
    combinedHitRate,
    bayesianEdge: bayesianEdge.combined,
    weeklyNullRanks: summarizeWeeklyNullRanks(cycles, samples.weekly, hedgeMode),
    weeklyOutcomes: cycles.map((cycle) => ({
      cycle: cycle.cycle,
      entryDate: new Date(cycle.entryTs * 1000),
      entryIv: cycle.sigma,
      ivZScore: ivStandardDeviation > EPSILON
        ? (cycle.sigma - ivMean) / ivStandardDeviation
        : 0,
      priceMove: cycle.exitSpot / cycle.entrySpot - 1,
      pnlUsd: cycle.actualPnlByMode[hedgeMode],
      returnOnNotional: cycle.actualPnlByMode[hedgeMode] / cycle.notionalBasisUsd,
    })),
    views: {
      time: timeCohorts,
      iv: ivRegimes,
      priceMove: priceMoveCohorts,
    },
    hitRateViews: {
      time: timeHitRates,
      iv: ivHitRates,
      priceMove: priceMoveHitRates,
    },
  };
};

const summarize = ({
  modeSamples,
  defaultHedgeMode,
  requestedSimulations,
  cycles,
  timeGroups,
  ivGroups,
  priceMoveGroups,
  ivMean,
  ivStandardDeviation,
  path,
  returnNull,
  hedgeModes,
  bayesianByMode,
  calibration,
  varianceBudgets,
  realizedVolSensitivity,
}) => {
  const modes = Object.fromEntries(hedgeModes.map((hedgeMode) => [
    hedgeMode,
    summarizeMode({
      hedgeMode,
      samples: modeSamples[hedgeMode],
      requestedSimulations,
      cycles,
      timeGroups,
      ivGroups,
      priceMoveGroups,
      ivMean,
      ivStandardDeviation,
      bayesianEdge: bayesianByMode[hedgeMode],
    }),
  ]));
  return {
    ...modes[defaultHedgeMode],
    defaultHedgeMode,
    modes,
    ivZScore: {
      mean: ivMean,
      standardDeviation: ivStandardDeviation,
    },
    path,
    returnNull,
    calibration,
    varianceBudgets,
    realizedVolSensitivity,
  };
};

export const runFairValueMonteCarlo = async ({
  cycles = [],
  historyRows = [],
  jumpThreshold = 4,
  simulations = 1_000,
  seed = Date.now(),
  onProgress,
}) => {
  const states = cycles
    .filter((cycle) => cycle.closed !== false)
    .map(buildFairValueCycleState);
  const count = Math.max(1, Math.round(Number(simulations) || 1_000));
  if (!states.length) throw new Error("No completed cycles are available for simulation");

  const uniformRandom = createSeededRandom(seed);
  const normalRandom = createNormalRandom(uniformRandom);
  const calibratedModel = historyRows.length
    ? calibrateBatesModel({ rows: historyRows, jumpThreshold })
    : null;
  const realizedVolSensitivity = calibratedModel
    ? buildRealizedVolSensitivity({
        cycles: states,
        calibration: calibratedModel,
        seed,
      })
    : [];
  const calibration = calibratedModel
    ? {
        ...calibratedModel,
        sensitivity: calibratedModel.sensitivity.map(({ _model, ...row }) => row),
      }
    : null;
  const varianceBudgets = calibration
    ? states.map((cycle) => ({
        cycle: cycle.cycle,
        entryTs: cycle.entryTs,
        entryIv: cycle.sigma,
        ...buildQuadraticVariationBudget({ cycle, calibration }),
      }))
    : [];
  const varianceBudgetByCycle = new Map(varianceBudgets.map((budget) => [
    budget.cycle,
    budget,
  ]));
  // Follow the strategy run settings: only simulate the hedge mode used in the backtest.
  const defaultHedgeMode = states.some((cycle) => cycle.hedgeEnabled) ? "dynamic" : "unhedged";
  const hedgeModes = [defaultHedgeMode];
  const returnNull = calibration
    ? {
        type: "calibrated-bates-drift-mixture",
        conditionalCycles: states.length,
        volatility: "Heston variance dynamics scaled to each cycle's entry ATM IV budget",
        pathGrid: "hourly path with the configured hedge schedule",
        realizedVariance: "expected diffusion plus jump QV equals entry ATM IV squared times T",
        annualDriftVariants: [...ANNUAL_DRIFT_VARIANTS],
        entryCashflow: "observed strategy premium",
        driftScenarioCounts: Object.fromEntries(ANNUAL_DRIFT_VARIANTS.map((drift, variantIndex) => [
          `${drift}`,
          Math.max(0, Math.floor((count - 1 - variantIndex) / ANNUAL_DRIFT_VARIANTS.length) + 1),
        ])),
        allocation: "round-robin equal thirds",
        zeroDriftIsPrimaryNull: true,
        pnlCenteredToFairValue: false,
      }
    : {
        type: "conditional-gbm-drift-mixture",
        conditionalCycles: states.length,
        volatility: "each cycle's entry IV",
        pathGrid: "scheduled hedge times and exit",
        realizedVariance: "unconstrained finite-sample GBM realization",
        annualDriftVariants: [...ANNUAL_DRIFT_VARIANTS],
        entryCashflow: "observed strategy premium",
        driftScenarioCounts: Object.fromEntries(ANNUAL_DRIFT_VARIANTS.map((drift, variantIndex) => [
          `${drift}`,
          Math.max(0, Math.floor((count - 1 - variantIndex) / ANNUAL_DRIFT_VARIANTS.length) + 1),
        ])),
        allocation: "round-robin equal thirds",
        zeroDriftIsPrimaryNull: true,
        pnlCenteredToFairValue: false,
      };
  const cohortCount = Math.min(3, states.length);
  const baseCohortSize = Math.floor(states.length / cohortCount);
  const remainder = states.length % cohortCount;
  const timeGroups = [];
  let cohortStart = 0;
  for (let index = 0; index < cohortCount; index += 1) {
    const size = baseCohortSize + (index < remainder ? 1 : 0);
    timeGroups.push({
      label: `Cohort ${index + 1}`,
      cycles: states.slice(cohortStart, cohortStart + size),
    });
    cohortStart += size;
  }
  const ivMean = mean(states.map((cycle) => cycle.sigma));
  const ivStandardDeviation = populationStdDev(states.map((cycle) => cycle.sigma));
  const zScoreFor = (cycle) => ivStandardDeviation > EPSILON
    ? (cycle.sigma - ivMean) / ivStandardDeviation
    : 0;
  const ivGroups = IV_REGIMES.map((regime) => ({
    label: regime.label,
    rangeLabel: regime.rangeLabel,
    cycles: states.filter((cycle) => regime.accepts(zScoreFor(cycle))),
  }));
  const priceMoveGroups = buildPriceMoveGroups(states);
  const timeGroupByCycle = new Map();
  timeGroups.forEach((group, groupIndex) => {
    group.cycles.forEach((cycle) => timeGroupByCycle.set(cycle, groupIndex));
  });
  const ivGroupByCycle = new Map();
  ivGroups.forEach((group, groupIndex) => {
    group.cycles.forEach((cycle) => ivGroupByCycle.set(cycle, groupIndex));
  });
  const priceMoveGroupByCycle = new Map();
  priceMoveGroups.forEach((group, groupIndex) => {
    group.cycles.forEach((cycle) => priceMoveGroupByCycle.set(cycle, groupIndex));
  });
  const modeSamples = Object.fromEntries(hedgeModes.map((hedgeMode) => [hedgeMode, {
    terminalPnl: [],
    weekly: states.map(() => []),
    time: timeGroups.map(() => []),
    iv: ivGroups.map(() => []),
    priceMove: priceMoveGroups.map(() => []),
  }]));
  const bayesianByMode = Object.fromEntries(hedgeModes.map((hedgeMode, modeIndex) => {
    const baseSeed = (Number(seed) + 0x9e3779b9 + modeIndex * 10_000) >>> 0;
    const summarizeGroupsForBayes = (groups, offset) => groups.map((group, groupIndex) =>
      summarizeBayesianEdge({
        cycles: group.cycles,
        hedgeMode,
        seed: (baseSeed + offset + groupIndex) >>> 0,
      }));
    return [hedgeMode, {
      combined: summarizeBayesianEdge({ cycles: states, hedgeMode, seed: baseSeed }),
      time: summarizeGroupsForBayes(timeGroups, 1_000),
      iv: summarizeGroupsForBayes(ivGroups, 2_000),
      priceMove: summarizeGroupsForBayes(priceMoveGroups, 3_000),
    }];
  }));
  const path = {
    maxPathPoints: Math.max(...states.map((cycle) => calibration
      ? buildIntraWeekSimulationTimes(cycle).length
      : cycle.simulationTimes.length)),
    usesScheduledHedgeTimes: true,
    pathSource: calibration
      ? "hourly Bates paths with calibrated stochastic variance and regime jump intensity"
      : "conditional GBM with cycle entry IV",
    costsConfigured: states.some((cycle) => cycle.hedgeCostBps > 0),
    toleranceConfigured: states.some((cycle) => cycle.hedgeDeltaTolerance > 0),
  };
  const updateStride = Math.max(1, Math.floor(count / 20));

  for (let simulation = 0; simulation < count; simulation += 1) {
    const annualDrift = ANNUAL_DRIFT_VARIANTS[simulation % ANNUAL_DRIFT_VARIANTS.length];
    const terminalPnl = Object.fromEntries(hedgeModes.map((mode) => [mode, 0]));
    const timePnl = Object.fromEntries(hedgeModes.map((mode) => [mode, timeGroups.map(() => 0)]));
    const ivPnl = Object.fromEntries(hedgeModes.map((mode) => [mode, ivGroups.map(() => 0)]));
    const priceMovePnl = Object.fromEntries(
      hedgeModes.map((mode) => [mode, priceMoveGroups.map(() => 0)]),
    );
    for (const [cycleIndex, cycle] of states.entries()) {
      const outcomes = simulateWeeklyCycleModes(
        cycle,
        normalRandom,
        annualDrift,
        calibration
          ? {
              calibration,
              uniformRandom,
              budget: varianceBudgetByCycle.get(cycle.cycle),
            }
          : null,
      );
      for (const hedgeMode of hedgeModes) {
        terminalPnl[hedgeMode] += outcomes[hedgeMode];
        modeSamples[hedgeMode].weekly[cycleIndex].push(outcomes[hedgeMode]);
        timePnl[hedgeMode][timeGroupByCycle.get(cycle)] += outcomes[hedgeMode];
        ivPnl[hedgeMode][ivGroupByCycle.get(cycle)] += outcomes[hedgeMode];
        priceMovePnl[hedgeMode][priceMoveGroupByCycle.get(cycle)] += outcomes[hedgeMode];
      }
    }
    for (const hedgeMode of hedgeModes) {
      modeSamples[hedgeMode].terminalPnl.push(terminalPnl[hedgeMode]);
      timePnl[hedgeMode].forEach((pnl, index) => modeSamples[hedgeMode].time[index].push(pnl));
      ivPnl[hedgeMode].forEach((pnl, index) => modeSamples[hedgeMode].iv[index].push(pnl));
      priceMovePnl[hedgeMode].forEach(
        (pnl, index) => modeSamples[hedgeMode].priceMove[index].push(pnl),
      );
    }
    const completed = simulation + 1;
    if (completed % updateStride === 0 || completed === count) {
      onProgress?.({
        completed,
        total: count,
        result: summarize({
          modeSamples,
          defaultHedgeMode,
          requestedSimulations: count,
          cycles: states,
          timeGroups,
          ivGroups,
          priceMoveGroups,
          ivMean,
          ivStandardDeviation,
          path,
          returnNull,
          hedgeModes,
          bayesianByMode,
          calibration,
          varianceBudgets,
          realizedVolSensitivity,
        }),
      });
      // Pace batches by one frame so the evolving distribution is visible and
      // controls remain responsive; the calculation itself is already sub-frame.
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
  }

  return summarize({
    modeSamples,
    defaultHedgeMode,
    requestedSimulations: count,
    cycles: states,
    timeGroups,
    ivGroups,
    priceMoveGroups,
    ivMean,
    ivStandardDeviation,
    path,
    returnNull,
    hedgeModes,
    bayesianByMode,
    calibration,
    varianceBudgets,
    realizedVolSensitivity,
  });
};
