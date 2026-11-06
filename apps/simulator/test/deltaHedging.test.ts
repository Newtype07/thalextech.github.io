import test from "node:test";
import assert from "node:assert/strict";
import { simulate } from "../src/workers/sim.worker.ts";
import { DEFAULT_PATH_MODEL } from "../src/lib/pathModel.ts";
import { blackScholesGreeks } from "../src/lib/blackScholes.ts";
import { replayDeltaHedge } from "../../../lib/delta-hedging/index.js";
import { STRATEGY_OBSERVATION_SECONDS } from "../src/lib/simulation.ts";
const YEAR = 365.25 * 86400;
test("Simulator's hourly clock matches hourly replay and is independent of drawing resolution and hedge activation", () => {
  const input = request();
  const hedgePolicy = { enabled: true, threshold: .03, tolerance: .1, period: 1800, hedgeBps: 2 };
  const base = { ...input, hedgePolicy, hedgeObservationSeconds: STRATEGY_OBSERVATION_SECONDS };
  const hourly = simulate(base);
  const coarse = simulate({ ...base, params: { ...base.params, dt: base.params.T / 12 } });
  const dense = simulate({ ...base, params: { ...base.params, dt: base.params.T / 96 } });
  const unhedged = simulate({ ...base, hedgePolicy: { enabled: false } });
  for (const result of [coarse, dense]) {
    assert.deepEqual(new Float64Array(result.terminalPricesBuffer), new Float64Array(hourly.terminalPricesBuffer));
    assert.deepEqual(new Float64Array(result.terminalPayoffsBuffer), new Float64Array(hourly.terminalPayoffsBuffer));
    assert.equal(result.meanHedgeTrades, hourly.meanHedgeTrades);
    assert.equal(result.meanHedgeFees, hourly.meanHedgeFees);
  }
  assert.deepEqual(new Float64Array(unhedged.sampledPathsBuffer), new Float64Array(hourly.sampledPathsBuffer));
  assert.equal(unhedged.meanHedgeTrades, 0);
  const spots = new Float64Array(hourly.sampledPathsBuffer).subarray(0, hourly.steps);
  const samples = [{ time: 0, price: 100, delta: -blackScholesGreeks(100, 100, input.params.T, .5, 0, "call").delta },
    ...Array.from(spots, (price, i) => ({ time: (i + 1) * 3600, price,
      delta: i + 1 === hourly.steps ? 0 : -blackScholesGreeks(price, 100, input.params.T - (i + 1) * 3600 / YEAR, .5, 0, "call").delta }))];
  const replay = replayDeltaHedge(samples, hedgePolicy, { observationSeconds: 3600 });
  const pnl = input.legs[0].premium - Math.max(0, spots.at(-1)! - 100) + replay.rows.at(-1)!.netPnl!;
  assert.ok(Math.abs(new Float64Array(hourly.terminalPayoffsBuffer)[0] - pnl) < 1e-8,
    "hourly hedge fills and costs reconcile to an independent replay");
});
test("one-minute hedge evaluation is independent of graph density and agrees with a minute replay", () => {
  const base = { ...request(), hedgeObservationSeconds: 60, hedgePolicy: { enabled: true, threshold: .03, tolerance: .1, period: 1800, hedgeBps: 2 } };
  const coarse = simulate(base);
  const dense = simulate({ ...base, params: { ...base.params, dt: base.params.T / 96 } });
  const minute = simulate({ ...base, params: { ...base.params, dt: 60 / YEAR } });
  assert.deepEqual(new Float64Array(coarse.terminalPricesBuffer), new Float64Array(dense.terminalPricesBuffer));
  assert.deepEqual(new Float64Array(coarse.terminalPayoffsBuffer), new Float64Array(dense.terminalPayoffsBuffer));
  assert.equal(coarse.meanHedgeTrades, dense.meanHedgeTrades);
  assert.equal(coarse.meanHedgeFees, dense.meanHedgeFees);
  assert.equal(new Float64Array(coarse.sampledPathsBuffer).length, base.params.rows * coarse.steps,
    "the worker keeps only display samples, avoiding a full minute-path matrix");
  const spots = new Float64Array(minute.sampledPathsBuffer).subarray(0, minute.steps);
  const samples = [{ time: 0, price: 100, delta: -blackScholesGreeks(100, 100, base.params.T, .5, 0, "call").delta },
    ...Array.from(spots, (price, i) => ({ time: (i + 1) * 60, price,
      delta: i + 1 === minute.steps ? 0 : -blackScholesGreeks(price, 100, base.params.T - (i + 1) * 60 / YEAR, .5, 0, "call").delta }))];
  const replay = replayDeltaHedge(samples, base.hedgePolicy, { observationSeconds: 60 });
  const pnl = base.legs[0].premium - Math.max(0, spots.at(-1)! - 100) + replay.rows.at(-1)!.netPnl!;
  assert.ok(Math.abs(new Float64Array(coarse.terminalPayoffsBuffer)[0] - pnl) < 1e-8);
  const unhedged = simulate({ ...base, hedgePolicy: { enabled: false } });
  assert.deepEqual(new Float64Array(unhedged.sampledPathsBuffer), new Float64Array(coarse.sampledPathsBuffer));
});
function request() {
  const T = 2 / 365.25;
  return { id: 1, seed: 42, params: { s0: 100, mu: 0, vol: .5, T, dt: T / 48, rows: 40 },
    pathModel: { ...DEFAULT_PATH_MODEL, kind: "gbm" as const },
    legs: [{ id: "call", kind: "option" as const, side: "sell" as const, qty: 1, strike: 100, optionType: "call" as const,
      premium: blackScholesGreeks(100, 100, T, .5, 0, "call").price }],
    optionPricingByLegId: {}, valuationTs: 0, horizonSeconds: T * YEAR,
    histBins: 20, histBinsMultiplier: 1, samplePathLimit: 40, returnSamplePaths: true };
}
test("worker hedges every path using the common ledger without changing price paths", () => {
  const input = request();
  const plain = simulate(input);
  const hedgePolicy = { enabled: true, threshold: .03, tolerance: .1, period: 1800, hedgeBps: 2 };
  const hedged = simulate({ ...input, hedgePolicy });
  assert.deepEqual(new Float64Array(plain.terminalPricesBuffer), new Float64Array(hedged.terminalPricesBuffer));
  assert.deepEqual(new Float64Array(plain.sampledPathsBuffer), new Float64Array(hedged.sampledPathsBuffer));
  const spots = new Float64Array(hedged.sampledPathsBuffer).subarray(0, hedged.steps);
  const samples = [{ time: 0, price: 100, delta: -blackScholesGreeks(100, 100, input.params.T, .5, 0, "call").delta },
    ...Array.from(spots, (price, i) => ({ time: (i + 1) * input.params.dt * YEAR, price,
      delta: i + 1 === hedged.steps ? 0 : -blackScholesGreeks(price, 100, input.params.T - (i + 1) * input.params.dt, .5, 0, "call").delta }))];
  const replay = replayDeltaHedge(samples, hedgePolicy);
  const optionPnl = input.legs[0].premium - Math.max(0, spots.at(-1)! - 100);
  const workerPnl = new Float64Array(hedged.terminalPayoffsBuffer)[0];
  assert.ok(Math.abs(workerPnl - optionPnl - replay.rows.at(-1)!.netPnl!) < 1e-8);
  assert.ok(hedged.meanHedgeFees > 0); assert.ok(hedged.meanHedgeTrades > 1);
});

test("the shared calibrated path process also replays identically with hedging on or off", () => {
  const input = { ...request(), hedgeObservationSeconds: 60, marketModel: { shape: "forward" as const, dynamics: "stochastic" as const,
    rv: .5, rvMultiplier: 1, profile: null, manual: { volOfVol: .3, correlation: -.5 } },
    forwardNodes: [{ seconds: 86400, iv: .7 }, { seconds: 2 * 86400, iv: .55 }] };
  const plain = simulate(input), hedged = simulate({ ...input, hedgePolicy: { enabled: true } });
  assert.deepEqual(new Float64Array(plain.terminalPricesBuffer), new Float64Array(hedged.terminalPricesBuffer));
  assert.deepEqual(new Float64Array(plain.sampledPathsBuffer), new Float64Array(hedged.sampledPathsBuffer));
  const sampled = new Float64Array(plain.sampledPathsBuffer);
  const terminal = new Float64Array(plain.terminalPricesBuffer);
  for (let i = 0; i < input.params.rows; i++) assert.equal(sampled[(i + 1) * plain.steps - 1], terminal[i]);
});

test("an earlier option expiry freezes its settlement and removes its delta", () => {
  const base = request();
  const expiry = 86400;
  const premium = blackScholesGreeks(100, 100, 1 / 365.25, .5, 0, "call").price;
  const input = { ...base, legs: [{ ...base.legs[0], premium }], optionPricingByLegId: {
    call: { iv: .5, mark: premium, expirationTs: expiry },
  } };
  const plain = simulate(input), hedged = simulate({ ...input, hedgePolicy: { enabled: true, threshold: 0, tolerance: 0, period: 0, hedgeBps: 0 } });
  const paths = new Float64Array(plain.sampledPathsBuffer), payoffs = new Float64Array(plain.terminalPayoffsBuffer);
  for (let i = 0; i < input.params.rows; i++) {
    const priceAtExpiry = paths[i * plain.steps + 23];
    assert.ok(Math.abs(payoffs[i] - (premium - Math.max(0, priceAtExpiry - 100))) < 1e-10);
  }
  assert.deepEqual(new Float64Array(plain.terminalPricesBuffer), new Float64Array(hedged.terminalPricesBuffer));
  assert.ok(hedged.meanHedgeTrades <= 25, "settled options cannot keep rehedging after expiry");
});
