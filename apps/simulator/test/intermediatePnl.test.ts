import assert from "node:assert/strict";
import test from "node:test";
import { simulate } from "../src/workers/sim.worker.ts";
import { DEFAULT_PATH_MODEL } from "../src/lib/pathModel.ts";
import { blackScholesGreeks } from "../src/lib/blackScholes.ts";

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
  let hadInterimPeak = false;
  for (let row = 0; row < finals.length; row += 1) {
    let peak = 0;
    for (let step = 0; step < result.steps; step += 1) {
      const spot = paths[row * result.steps + step];
      const pnl = blackScholesGreeks(spot, 100,
        Math.max(0, T - (step + 1) * dt), 0.8, 0, "call").price - premium;
      peak = Math.max(peak, pnl);
    }
    const terminalPnl = Math.max(0, finals[row] - 100) - premium;
    if (peak > Math.max(0, terminalPnl) + 1e-6) hadInterimPeak = true;
    const index = result.bins.findIndex((bin, i) => finals[row] >= bin.x0
      && (finals[row] < bin.x1 || i === result.bins.length - 1));
    expected[index] = Math.max(expected[index], peak);
  }
  assert.ok(hadInterimPeak);
  result.bins.forEach((bin, index) => {
    if (bin.count === 0) assert.equal(bin.maxIntermediatePnl, null);
    else assert.ok(Math.abs(bin.maxIntermediatePnl! - expected[index]) < 1e-8);
  });
});
