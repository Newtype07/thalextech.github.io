import test from "node:test";
import assert from "node:assert/strict";
import {
  buildFairValueCycleState,
  generateGbmPath,
  runFairValueMonteCarlo,
  simulateWeeklyCycleModes,
  summarizeBayesianEdge,
} from "../src/lib/fairValueMonteCarlo.js";

const entryTs = Date.UTC(2025, 0, 3, 8) / 1000;
const exitTs = entryTs + 7 * 86_400;

const buildCycle = ({
  quantitySign = -1,
  hedgeEnabled = true,
  entryIv = 0.55,
  exitIndexPrice = 101_000,
} = {}) => ({
  cycle: 1,
  entryTime: new Date(entryTs * 1000),
  exitTime: new Date(exitTs * 1000),
  entryIndexPrice: 100_000,
  exitIndexPrice,
  hedgeEnabled,
  closed: true,
  cyclePnlUsd: 125,
  legs: [
    {
      optionType: "C",
      strike: 100_000,
      expirationTs: exitTs,
      quantity: quantitySign * 0.5,
      entryDelta: 0.52,
      entryImpliedVol: entryIv,
    },
    {
      optionType: "P",
      strike: 100_000,
      expirationTs: exitTs,
      quantity: quantitySign * 0.5,
      entryDelta: -0.48,
      entryImpliedVol: entryIv,
    },
  ],
});

const EMPIRICAL_LOG_RETURNS = [-0.08, -0.025, 0.015, 0.12];
const buildSimulationCycles = ({ quantitySign = -1, hedgeEnabled = true } = {}) =>
  EMPIRICAL_LOG_RETURNS.map((logReturn, index) => {
    const cycle = buildCycle({
      quantitySign,
      hedgeEnabled,
      exitIndexPrice: 100_000 * Math.exp(logReturn),
    });
    const offset = index * 7 * 86_400;
    cycle.cycle = index + 1;
    cycle.entryTime = new Date((entryTs + offset) * 1000);
    cycle.exitTime = new Date((exitTs + offset) * 1000);
    cycle.legs = cycle.legs.map((leg) => ({
      ...leg,
      expirationTs: leg.expirationTs + offset,
    }));
    return cycle;
  });

test("conditional GBM uses the hedge grid without pinning realized variance", () => {
  const cycle = buildFairValueCycleState(buildCycle({ entryIv: 0.62 }));
  const normals = [0.4, -1.2, 0.8, 0.1, -0.3, 1.7, -0.5];
  let normalIndex = 0;
  const path = generateGbmPath({
    cycle,
    normalRandom: () => normals[normalIndex++],
    annualDrift: 0,
  });
  assert.deepEqual(path.map((point) => point.elapsedSeconds),
    Array.from({ length: 7 }, (_, index) => (index + 1) * 86_400));
  const logReturns = path.map((point, index) => Math.log(
    point.spot / (index ? path[index - 1].spot : cycle.entrySpot),
  ));
  const holdingYears = (cycle.exitTs - cycle.entryTs) / (365 * 86_400);
  const sampledRv = Math.sqrt(
    logReturns.reduce((total, value) => total + value ** 2, 0) / holdingYears,
  );
  assert.ok(Math.abs(sampledRv - cycle.sigma) > 0.01);
});

test("null paths preserve the strategy's observed entry premium", () => {
  const observedPremium = 1_234.56;
  const rawCycle = {
    ...buildCycle({ hedgeEnabled: false, entryIv: 0.55 }),
    entryOptionCashflowUsd: observedPremium,
    shortOptionPnlUsd: observedPremium,
    legs: [{
      optionType: "C",
      strike: 150_000,
      expirationTs: exitTs,
      quantity: -1,
      entryDelta: 0.05,
      entryImpliedVol: 0.55,
    }],
  };
  const cycle = buildFairValueCycleState(rawCycle);
  assert.equal(cycle.entryCashflow, observedPremium);
  assert.equal(cycle.premiumBasisUsd, observedPremium);
  assert.notEqual(cycle.entryCashflow, cycle.fairEntryCashflow);

  const outcome = simulateWeeklyCycleModes(cycle, () => -3, 0);
  assert.equal(outcome.unhedged, observedPremium);
});

test("same internal seed reproduces weekly scenarios without mutating historical cycles", async () => {
  const cycles = buildSimulationCycles();
  const before = structuredClone(cycles);
  const first = await runFairValueMonteCarlo({ cycles, simulations: 20, seed: 42 });
  const second = await runFairValueMonteCarlo({ cycles, simulations: 20, seed: 42 });
  assert.deepEqual(first.terminalPnl, second.terminalPnl);
  assert.deepEqual(first.weeklyNullRanks, second.weeklyNullRanks);
  assert.equal(first.weeklyNullRanks.length, cycles.length);
  assert.ok(first.weeklyNullRanks.every((week) =>
    week.simulations === 20 && week.percentile >= 0 && week.percentile <= 100,
  ));
  assert.deepEqual(first.hitRateViews, second.hitRateViews);
  assert.equal(first.returnNull.type, "conditional-gbm-drift-mixture");
  assert.equal(first.returnNull.volatility, "each cycle's entry IV");
  assert.equal(first.returnNull.realizedVariance, "unconstrained finite-sample GBM realization");
  assert.deepEqual(first.returnNull.annualDriftVariants, [-1, 0, 1]);
  assert.deepEqual(first.returnNull.driftScenarioCounts, { "-1": 7, "0": 7, "1": 6 });
  assert.equal(first.returnNull.pnlCenteredToFairValue, false);
  assert.equal(first.combined.terminalReturnOnPremium.length, 20);
  assert.deepEqual(first.views.priceMove.map((group) => group.label), [
    "Lowest BTC moves", "Middle BTC moves", "Highest BTC moves",
  ]);
  assert.deepEqual(first.views.priceMove.map((group) => group.weekCount), [2, 1, 1]);
  assert.ok(first.views.priceMove.every((group) => group.terminalPnl.length === 20));
  assert.ok(first.views.priceMove.every((group) =>
    Number.isFinite(group.notionalReturnSummary.mean)));
  assert.equal(first.weeklyOutcomes.length, EMPIRICAL_LOG_RETURNS.length);
  assert.ok(first.weeklyOutcomes.every((week) =>
    Number.isFinite(week.priceMove)
      && Number.isFinite(week.entryIv)
      && Number.isFinite(week.ivZScore)
      && Number.isFinite(week.returnOnNotional)));
  assert.equal(first.bayesianEdge.draws, 5_000);
  assert.ok(first.bayesianEdge.probabilityEdgePositive >= 0);
  assert.ok(first.bayesianEdge.probabilityEdgePositive <= 1);
  assert.equal(first.hitRateViews.time.length, 3);
  assert.ok(first.hitRateViews.time.every((cohort) =>
    cohort.hitRates.length === 20
      && cohort.hitRates.every((rate) => rate >= 0 && rate <= 1)
      && cohort.hitCounts.length === 20
      && cohort.hitCounts.every((hits) => Number.isInteger(hits) && hits >= 0 && hits <= cohort.weekCount)
      && cohort.summary.actualHits >= 0
      && cohort.summary.actualHits <= cohort.weekCount
      && cohort.summary.expectedHitRate >= 0
      && cohort.summary.expectedHitRate <= 1
      && cohort.summary.scenariosAtOrAboveActual >= 0
      && cohort.summary.scenariosAtOrAboveActual <= 20
      && cohort.summary.probabilityAtOrAboveActual
        === cohort.summary.scenariosAtOrAboveActual / 20,
  ));
  assert.deepEqual(cycles, before);
});

test("long and short weekly outcomes are opposites before costs", async () => {
  const short = await runFairValueMonteCarlo({
    cycles: buildSimulationCycles(), simulations: 40, seed: 7,
  });
  const long = await runFairValueMonteCarlo({
    cycles: buildSimulationCycles({ quantitySign: 1 }), simulations: 40, seed: 7,
  });
  short.terminalPnl.forEach((value, index) => {
    assert.ok(Math.abs(value + long.terminalPnl[index]) < 1e-7);
  });
});

test("an unhedged strategy only simulates and exposes the unhedged null", async () => {
  const result = await runFairValueMonteCarlo({
    cycles: buildSimulationCycles({ hedgeEnabled: false }), simulations: 20, seed: 17,
  });
  assert.equal(result.defaultHedgeMode, "unhedged");
  assert.equal(result.hedgeMode, "unhedged");
  assert.deepEqual(Object.keys(result.modes), ["unhedged"]);
  assert.equal(result.terminalPnl.length, 20);
  assert.equal(result.weeklyNullRanks.length, EMPIRICAL_LOG_RETURNS.length);
});

test("a hedged strategy only simulates the dynamic hedge null from run settings", async () => {
  const result = await runFairValueMonteCarlo({
    cycles: buildSimulationCycles({ hedgeEnabled: true }), simulations: 20, seed: 17,
  });
  assert.equal(result.defaultHedgeMode, "dynamic");
  assert.equal(result.hedgeMode, "dynamic");
  assert.deepEqual(Object.keys(result.modes), ["dynamic"]);
  assert.equal(result.terminalPnl.length, 20);
});

test("dynamic hedge is path-dependent while unhedged PnL depends only on the endpoint", () => {
  const cycle = buildFairValueCycleState(buildCycle());
  const sequence = (values) => {
    let index = 0;
    return () => values[index++ % values.length];
  };
  const normals = [1.4, -1.1, 0.9, -0.7, 1.2, -1.3, 0.6];
  const first = simulateWeeklyCycleModes(cycle, sequence(normals), 0);
  const second = simulateWeeklyCycleModes(cycle, sequence([...normals].reverse()), 0);
  assert.equal(first.unhedged, second.unhedged);
  assert.ok(Math.abs(first.dynamic - second.dynamic) > 1e-6);
});

test("Bayesian bootstrap reports the posterior probability of positive observed edge", () => {
  const positive = buildSimulationCycles().map((cycle, index) => ({
    ...buildFairValueCycleState(cycle),
    actualPnlByMode: { unhedged: 100 + index, dynamic: 100 + index },
  }));
  const summary = summarizeBayesianEdge({
    cycles: positive,
    hedgeMode: "dynamic",
    seed: 22,
    draws: 1_000,
  });
  assert.equal(summary.probabilityEdgePositive, 1);
  assert.ok(summary.p05 > 0);
  assert.ok(summary.p95 >= summary.p05);
});

test("simulation streams growing partial distributions", async () => {
  const updates = [];
  const result = await runFairValueMonteCarlo({
    cycles: buildSimulationCycles(),
    simulations: 100,
    seed: 19,
    onProgress: (update) => updates.push(update),
  });
  assert.ok(updates.length > 2);
  assert.equal(updates.at(-1).completed, 100);
  assert.equal(updates.at(-1).result.terminalPnl.length, 100);
  assert.equal(result.terminalPnl.length, 100);
});

test("92 ordered weeks split into three consecutive cohorts", async () => {
  const weeks = Array.from({ length: 92 }, (_, index) => {
    const cycle = buildCycle();
    cycle.cycle = index + 1;
    cycle.entryTime = new Date((entryTs + index * 7 * 86_400) * 1000);
    cycle.exitTime = new Date((exitTs + index * 7 * 86_400) * 1000);
    cycle.exitIndexPrice = 100_000 * Math.exp(((index % 9) - 4) * 0.012);
    cycle.legs = cycle.legs.map((leg) => ({
      ...leg,
      expirationTs: leg.expirationTs + index * 7 * 86_400,
    }));
    return cycle;
  });
  const result = await runFairValueMonteCarlo({ cycles: weeks, simulations: 10, seed: 5 });
  assert.deepEqual(result.cohorts.map((cohort) => cohort.weekCount), [31, 31, 30]);
  assert.equal(result.cohorts[0].startDate.getTime(), weeks[0].entryTime.getTime());
  assert.equal(result.cohorts[2].endDate.getTime(), weeks.at(-1).exitTime.getTime());
  assert.ok(result.cohorts.every((cohort) => cohort.terminalPnl.length === 10));
  assert.ok(result.cohorts.every((cohort) =>
    cohort.terminalReturnOnPremium.length === 10
      && Number.isFinite(cohort.returnSummary.p01)
      && Number.isFinite(cohort.returnSummary.p99),
  ));
  result.cohorts.forEach((cohort) => {
    const atOrAboveActual = cohort.terminalReturnOnPremium.filter(
      (value) => value >= cohort.returnSummary.actualPnl,
    ).length;
    assert.equal(cohort.returnSummary.scenariosAtOrAboveActual, atOrAboveActual);
    assert.equal(
      cohort.returnSummary.probabilityAtOrAboveActual,
      (atOrAboveActual + 1) / (cohort.terminalReturnOnPremium.length + 1),
    );
  });
});

test("entry IV z-score view groups weeks into low, medium, and high regimes", async () => {
  const entryIvs = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 1.2];
  const weeks = entryIvs.map((entryIv, index) => {
    const cycle = buildCycle({ entryIv });
    cycle.cycle = index + 1;
    cycle.entryTime = new Date((entryTs + index * 7 * 86_400) * 1000);
    cycle.exitTime = new Date((exitTs + index * 7 * 86_400) * 1000);
    cycle.exitIndexPrice = 100_000 * Math.exp(((index % 5) - 2) * 0.025);
    cycle.legs = cycle.legs.map((leg) => ({
      ...leg,
      expirationTs: leg.expirationTs + index * 7 * 86_400,
    }));
    return cycle;
  });
  const result = await runFairValueMonteCarlo({ cycles: weeks, simulations: 12, seed: 13 });
  assert.deepEqual(Object.keys(result.modes), ["dynamic"]);
  assert.equal(result.defaultHedgeMode, "dynamic");
  assert.equal(result.hedgeMode, "dynamic");
  assert.deepEqual(result.views.iv.map((group) => group.label), [
    "Low IV", "Medium IV", "High IV",
  ]);
  assert.deepEqual(result.views.iv.map((group) => group.weekCount), [1, 6, 1]);
  result.terminalPnl.forEach((total, simulation) => {
    const groupedTotal = result.views.iv.reduce(
      (sum, group) => sum + group.terminalPnl[simulation],
      0,
    );
    assert.ok(Math.abs(total - groupedTotal) < 1e-8);
  });
});

test("observed BTC price-change view splits ranked weeks into three cohorts", async () => {
  const logReturns = [0.09, -0.03, 0.04, -0.11, 0.01, -0.06, 0.13, -0.01, 0.06];
  const weeks = logReturns.map((logReturn, index) => {
    const cycle = buildCycle({ exitIndexPrice: 100_000 * Math.exp(logReturn) });
    cycle.cycle = index + 1;
    cycle.entryTime = new Date((entryTs + index * 7 * 86_400) * 1000);
    cycle.exitTime = new Date((exitTs + index * 7 * 86_400) * 1000);
    cycle.legs = cycle.legs.map((leg) => ({
      ...leg,
      expirationTs: leg.expirationTs + index * 7 * 86_400,
    }));
    return cycle;
  });
  const result = await runFairValueMonteCarlo({ cycles: weeks, simulations: 12, seed: 27 });
  const cohorts = result.views.priceMove;

  assert.deepEqual(cohorts.map((group) => group.weekCount), [3, 3, 3]);
  assert.deepEqual(cohorts.map((group) => group.label), [
    "Lowest BTC moves", "Middle BTC moves", "Highest BTC moves",
  ]);
  assert.match(cohorts[0].rangeLabel, /^−/);
  assert.match(cohorts[2].rangeLabel, /\+/);
  result.terminalPnl.forEach((total, simulation) => {
    const groupedTotal = cohorts.reduce(
      (sum, group) => sum + group.terminalPnl[simulation],
      0,
    );
    assert.ok(Math.abs(total - groupedTotal) < 1e-8);
  });
  assert.deepEqual(result.hitRateViews.priceMove.map((group) => group.weekCount), [3, 3, 3]);
});

test('covered call simulation includes the underlying and compares full observed PnL', () => {
  const cycle = buildCycle({ hedgeEnabled: false });
  cycle.legs = [cycle.legs[0]];
  cycle.underlyingQuantity = 0.5;
  cycle.shortOptionPnlUsd = -375;
  const covered = buildFairValueCycleState(cycle);
  const naked = buildFairValueCycleState({ ...cycle, underlyingQuantity: 0 });
  assert.equal(covered.actualPnlByMode.unhedged, cycle.cyclePnlUsd);
  const path = generateGbmPath({ cycle: covered, normalRandom: () => 0 });
  const underlyingPnl = 0.5 * (path.at(-1).spot - covered.entrySpot);
  const difference = simulateWeeklyCycleModes(covered, () => 0).unhedged
    - simulateWeeklyCycleModes(naked, () => 0).unhedged;
  assert.ok(Math.abs(difference - underlyingPnl) < 1e-8);
});

test('covered call conditional benchmark excludes uncovered gains from observed comparison', () => {
  const cycle = buildCycle({ hedgeEnabled: false });
  cycle.legs = [cycle.legs[0]];
  cycle.underlyingQuantity = 1;
  cycle.holdingStartTs = entryTs - 86_400;
  cycle.holdingStartPrice = 80_000;
  cycle.shortOptionPnlUsd = -375;
  cycle.cyclePnlUsd = 20_625;
  const state = buildFairValueCycleState(cycle);
  assert.equal(state.actualPnlByMode.unhedged, 625);
});
