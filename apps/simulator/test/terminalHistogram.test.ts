import assert from "node:assert/strict";
import test from "node:test";
import { buildTerminalPriceBins, findPriceBinIndex } from "../src/lib/terminalHistogram.ts";
import { DEFAULT_PATH_MODEL } from "../src/lib/pathModel.ts";
import { simulate } from "../src/workers/sim.worker.ts";

const close = (actual: number, expected: number): void => {
  assert.ok(Math.abs(actual - expected) <= 1e-10 * Math.max(1, Math.abs(expected)),
    `${actual} differs from ${expected}`);
};

for (const scale of ["log", "linear"] as const) {
  test(`${scale} bins cover terminal extrema and have equal width on their axis`, () => {
    const prices = Float64Array.from({ length: 1000 }, (_, i) => 9000 * Math.exp(i / 200));
    const bins = buildTerminalPriceBins(prices, scale, 100, 1);
    assert.equal(bins[0].x0, prices[0]);
    assert.equal(bins.at(-1)!.x1, prices.at(-1));
    assert.ok(bins.length >= 10 && bins.length <= 100);
    const coordinate = scale === "log" ? Math.log : (price: number) => price;
    const width = coordinate(bins[0].x1) - coordinate(bins[0].x0);
    bins.forEach((bin, index) => {
      close(coordinate(bin.x1) - coordinate(bin.x0), width);
      assert.equal(findPriceBinIndex(bins, bin.x0), index);
      assert.equal(findPriceBinIndex(bins, bin.x1), Math.min(index + 1, bins.length - 1));
      if (index) assert.equal(bin.x0, bins[index - 1].x1);
    });
    assert.equal(findPriceBinIndex(bins, prices.at(-1)!), bins.length - 1);
  });

  test(`${scale} bins handle identical terminal prices`, () => {
    const bins = buildTerminalPriceBins(new Float64Array(100).fill(95000), scale, 100, 1);
    assert.ok(bins.every((bin) => Number.isFinite(bin.x0) && bin.x0 > 0 && bin.x1 > bin.x0));
    const bin = bins[findPriceBinIndex(bins, 95000)];
    assert.ok(bin.x0 <= 95000 && bin.x1 >= 95000);
  });
}

for (const [mu, vol] of [[5, 0.1], [-5, 0.1], [0.1, 1.2]]) {
  test(`rebinning preserves outcomes and EV at drift ${mu}, vol ${vol}`, () => {
    const T = 193 / 365.25;
    const request = {
      id: 1, seed: 42,
      params: { s0: 79000, mu, vol, T, dt: T / 64, rows: 5000 },
      pathModel: { ...DEFAULT_PATH_MODEL, kind: "bates" as const },
      legs: [], optionPricingByLegId: {}, valuationTs: 1700000000,
      horizonSeconds: T * 365.25 * 86400,
      histBins: 100, histBinsMultiplier: 1, samplePathLimit: 100,
    };
    const linear = simulate({ ...request, histogramScale: "linear" });
    const log = simulate({ ...request, histogramScale: "log" });
    assert.deepEqual(log.terminalPricesBuffer, linear.terminalPricesBuffer);
    assert.deepEqual(log.terminalPayoffsBuffer, linear.terminalPayoffsBuffer);
    assert.deepEqual(log.sampledPathsBuffer, linear.sampledPathsBuffer);
    assert.equal(log.meanPayoff, linear.meanPayoff);
    assert.equal(log.medianPayoff, linear.medianPayoff);
    assert.equal(log.winRate, linear.winRate);
    assert.notDeepEqual(log.bins, linear.bins);
    for (const result of [linear, log]) {
      assert.equal(result.bins[0].x0, result.finalPriceMin);
      assert.equal(result.bins.at(-1)!.x1, result.finalPriceMax);
      assert.equal(result.bins.reduce((sum, bin) => sum + bin.count, 0), request.params.rows);
      close(result.bins.reduce((sum, bin) => sum + bin.sumPayoff, 0) / request.params.rows, result.meanPayoff);
      const prices = new Float64Array(result.terminalPricesBuffer);
      const payoffs = new Float64Array(result.terminalPayoffsBuffer);
      const expectedCounts = result.bins.map(() => 0);
      const expectedSums = result.bins.map(() => 0);
      prices.forEach((price, row) => {
        // Independent reference using the documented dollar boundaries.
        const index = result.bins.findIndex((bin, i) => price >= bin.x0
          && (price < bin.x1 || i === result.bins.length - 1));
        assert.equal(findPriceBinIndex(result.bins, price), index);
        expectedCounts[index]++;
        expectedSums[index] += payoffs[row];
      });
      assert.deepEqual(result.bins.map((bin) => bin.count), expectedCounts);
      assert.deepEqual(result.bins.map((bin) => bin.sumPayoff), expectedSums);
    }
  });
}
