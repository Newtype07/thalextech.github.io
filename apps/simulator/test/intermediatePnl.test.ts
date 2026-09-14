import assert from "node:assert/strict";
import test from "node:test";
import { simulate } from "../src/workers/sim.worker.ts";
import { DEFAULT_PATH_MODEL } from "../src/lib/pathModel.ts";
import { blackScholesGreeks } from "../src/lib/blackScholes.ts";

test("straddle stops count either leg once per path even when net delta is near zero", () => {
  const T = 11 / 365.25;
  const result = simulate({
    id: 1, seed: 12345,
    params: { s0: 79000, mu: 0.1, vol: 0.4, T, dt: T / 100, rows: 200 },
    pathModel: { ...DEFAULT_PATH_MODEL, kind: "gbm" },
    legs: (["call", "put"] as const).map((optionType) => ({
      id: optionType, kind: "option" as const, side: "buy" as const, qty: 1,
      strike: 79000, optionType,
      premium: blackScholesGreeks(79000, 79000, T, 0.4, 0, optionType).price,
    })),
    optionPricingByLegId: {}, valuationTs: 0,
    horizonSeconds: T * 365.25 * 24 * 60 * 60,
    histBins: 20, histBinsMultiplier: 1, samplePathLimit: 200, returnSamplePaths: true,
  });
  const paths = new Float64Array(result.sampledPathsBuffer);
  const finals = new Float64Array(result.sampledFinalPricesBuffer);
  const stops = result.bins[0].optionStop!.stops;
  assert.equal(stops.length, 2);
  const counts = result.bins.map(() => 0);
  let bothHits = 0;
  finals.forEach((final, row) => {
    const path = paths.subarray(row * result.steps, (row + 1) * result.steps);
    const hit = stops.map((stop) => path.some((spot) => stop.delta > 0
      ? spot <= stop.stopPrice : spot >= stop.stopPrice));
    if (hit.every(Boolean)) bothHits++;
    if (!hit.some(Boolean)) return;
    const index = result.bins.findIndex((bin, i) => final >= bin.x0
      && (final < bin.x1 || i === result.bins.length - 1));
    counts[index]++;
  });
  assert.ok(bothHits > 0);
  assert.ok(counts.reduce((sum, value) => sum + value, 0) > 0);
  result.bins.forEach((bin, index) => assert.equal(bin.optionStop!.count, counts[index]));
});

test("bin peak P&L includes intermediate option values, not just terminal payoff", () => {
  const T = 10 / 365.25;
  const dt = T / 10;
  const premium = blackScholesGreeks(100, 100, T, 0.8, 0, "call").price;
  const result = simulate({
    id: 1, seed: 12345,
    params: { s0: 100, mu: 0, vol: 0.8, T, dt, rows: 100 },
    pathModel: { ...DEFAULT_PATH_MODEL, kind: "gbm" },
    legs: [{ id: "call", kind: "option", side: "buy", qty: 1,
      strike: 100, optionType: "call", premium }],
    optionPricingByLegId: {}, valuationTs: 0,
    horizonSeconds: T * 365.25 * 24 * 60 * 60,
    histBins: 20, histBinsMultiplier: 1, samplePathLimit: 100,
    returnSamplePaths: true,
  });
  const paths = new Float64Array(result.sampledPathsBuffer);
  const finals = new Float64Array(result.sampledFinalPricesBuffer);
  const expected = result.bins.map(() => -Infinity);
  const stopCounts = result.bins.map(() => 0);
  const savedSums = result.bins.map(() => 0);
  const drawdowns: number[][] = result.bins.map(() => []);
  const realizedVols: number[][] = result.bins.map(() => []);
  let hadInterimPeak = false;
  for (let row = 0; row < finals.length; row += 1) {
    let peak = 0;
    let pricePeak = 100;
    let drawdown = 0;
    let previousSpot = 100;
    let squaredReturns = 0;
    for (let step = 0; step < result.steps; step += 1) {
      const spot = paths[row * result.steps + step];
      pricePeak = Math.max(pricePeak, spot);
      drawdown = Math.max(drawdown, (pricePeak - spot) / pricePeak);
      squaredReturns += Math.log(spot / previousSpot) ** 2;
      previousSpot = spot;
      const pnl = blackScholesGreeks(spot, 100,
        Math.max(0, T - (step + 1) * dt), 0.8, 0, "call").price - premium;
      peak = Math.max(peak, pnl);
    }
    const terminalPnl = Math.max(0, finals[row] - 100) - premium;
    if (peak > Math.max(0, terminalPnl) + 1e-6) hadInterimPeak = true;
    const index = result.bins.findIndex((bin, i) => finals[row] >= bin.x0
      && (finals[row] < bin.x1 || i === result.bins.length - 1));
    expected[index] = Math.max(expected[index], peak);
    drawdowns[index].push(drawdown);
    realizedVols[index].push(Math.sqrt(squaredReturns / (result.steps * dt)));
    const stop = result.bins[index].optionStop!.stops[0];
    const stopped = paths.subarray(row * result.steps, (row + 1) * result.steps)
      .some((spot) => spot <= stop.stopPrice);
    if (stopped) {
      stopCounts[index] += 1;
      savedSums[index] += terminalPnl + premium;
    }
  }
  assert.ok(hadInterimPeak);
  const median = (values: number[]): number => {
    values.sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2);
    return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
  };
  result.bins.forEach((bin, index) => {
    if (bin.count === 0) assert.equal(bin.maxIntermediatePnl, null);
    else assert.ok(Math.abs(bin.maxIntermediatePnl! - expected[index]) < 1e-8);
    assert.equal(bin.optionStop!.count, stopCounts[index]);
    assert.ok(Math.abs(bin.optionStop!.advantageSum - savedSums[index]) < 1e-8);
    if (bin.count > 0) {
      assert.ok(Math.abs(bin.medianMaxDrawdown - median(drawdowns[index])) < 1e-10);
      assert.ok(Math.abs(bin.medianRealizedVol - median(realizedVols[index])) < 1e-10);
    }
  });
  assert.ok(stopCounts.reduce((sum, count) => sum + count, 0) > 0);
});
