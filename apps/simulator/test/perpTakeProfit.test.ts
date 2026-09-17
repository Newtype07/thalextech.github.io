import assert from "node:assert/strict";
import test from "node:test";
import { payoffAtPriceForLeg, payoffForPath, type FutureLeg } from "../src/lib/position.ts";
import { simulate } from "../src/workers/sim.worker.ts";
import { DEFAULT_PATH_MODEL } from "../src/lib/pathModel.ts";

const long: FutureLeg = {
  id: "perp", kind: "future", side: "buy", qty: 10, entry: 100,
  stopLoss: 90, takeProfit: 120,
};
test("perp exits at the first barrier and keeps the same risk budget", () => {
  assert.equal(payoffForPath([long], [100, 125, 80]), 200);
  assert.equal(payoffForPath([long], [100, 85, 130]), -100);
  assert.equal(payoffAtPriceForLeg(long, 150), 200);
  assert.equal(payoffForPath([long], [100, 110]), 100);
  const short: FutureLeg = { ...long, side: "sell", stopLoss: 110, takeProfit: 80 };
  assert.equal(payoffForPath([short], [100, 75, 120]), 200);
  assert.equal(payoffForPath([short], [100, 115, 70]), -100);
  assert.equal(payoffAtPriceForLeg(short, 50), 200);
  assert.equal(payoffForPath([{ ...long, takeProfit: null }], [100, 125, 130]), 300);
});
const request = {
  id: 1, seed: 12345,
  params: { s0: 100, mu: 1, vol: 0, T: 1, dt: 0.1, rows: 10 },
  pathModel: { ...DEFAULT_PATH_MODEL, kind: "gbm" as const },
  optionPricingByLegId: {}, valuationTs: 0,
  horizonSeconds: 365.25 * 24 * 60 * 60,
  histBins: 20, histBinsMultiplier: 1, samplePathLimit: 10, returnSamplePaths: true,
};
test("simulation locks take-profit PnL, stops funding, and does not count it as max loss", () => {
  const result = simulate({ ...request, legs: [{ ...long, annualFundingRate: 0.1 }] });
  // The price crosses 120 in the second 0.1-year interval.
  assert.ok(Math.abs(result.meanPayoff - (200 - 10 * 100 * 0.1 * 0.2)) < 1e-8);
  assert.equal(result.maxLossRate, 0);
});
test("take-profit adaptive sampling keeps option and perp paths paired", () => {
  const shared = {
    ...request,
    params: { ...request.params, mu: 0, vol: 0.6, T: 0.01, dt: 0.001, rows: 100 },
    samplePathLimit: 100,
    samplingStopLoss: { side: "buy" as const, price: 90, takeProfit: 102 },
  };
  const primary = simulate({ ...shared, legs: [] });
  const comparison = simulate({ ...shared, legs: [{ ...long, takeProfit: 102 }] });
  assert.deepEqual(new Float64Array(primary.sampledPathsBuffer), new Float64Array(comparison.sampledPathsBuffer));
  assert.deepEqual(new Float64Array(primary.sampledFinalPricesBuffer), new Float64Array(comparison.sampledFinalPricesBuffer));
});
