import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBinnedCumulativeEV,
  buildPayoffDifferenceSummary,
  buildSharedTerminalCumulativeSeries,
  computePayoffBinValue,
  findPayoffCrossingPrice,
  interpolatePayoffGaps,
  smoothSharedTerminalCumulativeSeries,
} from "../src/lib/payoffComparison.ts";

test("display gap interpolation preserves samples, signs, and empty tails", () => {
  const points = [
    { price: 0, value: null },
    { price: 1, value: -20 },
    { price: 2, value: null },
    { price: 4, value: null },
    { price: 5, value: 20 },
    { price: 6, value: null },
  ];
  assert.deepEqual(interpolatePayoffGaps(points), [null, -20, -10, 10, 20, null]);
  assert.equal(points[2].value, null);
  assert.deepEqual(interpolatePayoffGaps([{ price: 1, value: null }]), [null]);
});

test("average payoff marker follows the nearest payoff crossing, not mean price", () => {
  const bins = [
    { x0: 60, x1: 70, count: 10, medianPayoff: 100 },
    { x0: 70, x1: 80, count: 20, medianPayoff: -100 },
    { x0: 80, x1: 90, count: 10, medianPayoff: 100 },
  ];
  assert.equal(findPayoffCrossingPrice(bins, 50, 78), 82.5);
  assert.equal(findPayoffCrossingPrice(bins, 50, 72), 67.5);
  assert.equal(findPayoffCrossingPrice(bins, -100, 78), 75);
  assert.equal(findPayoffCrossingPrice(bins, 200, 78), null);
  assert.equal(findPayoffCrossingPrice([], 50, 78), null);
  assert.equal(findPayoffCrossingPrice(bins.map((bin) => ({ ...bin, medianPayoff: 50 })), 50, 78), 78);
});

test("binned cumulative EV keeps losses signed, includes empty bins, and ends at total EV", () => {
  const points = buildBinnedCumulativeEV([
    { x0: 10, x1: 20, sumPayoff: -40 },
    { x0: 20, x1: 30, sumPayoff: 0 },
    { x0: 30, x1: 40, sumPayoff: 100 },
    { x0: 40, x1: 50, sumPayoff: -20 },
  ], 10);
  assert.deepEqual(points, [
    { terminalPrice: 10, contribution: 0 },
    { terminalPrice: 20, contribution: -4 },
    { terminalPrice: 30, contribution: -4 },
    { terminalPrice: 40, contribution: 6 },
    { terminalPrice: 50, contribution: 4 },
  ]);
  assert.deepEqual(buildBinnedCumulativeEV([], 10), []);
  assert.deepEqual(buildBinnedCumulativeEV([{ x0: 0, x1: 1, sumPayoff: 0 }], 0), []);
});

test("option-perp distribution keeps outcomes paired by simulation path", () => {
  const summary = buildPayoffDifferenceSummary(
    new Float64Array([10, -5, 0]),
    new Float64Array([4, -10, 2]),
  );

  assert.deepEqual(summary.sortedDifferences, [-2, 5, 6]);
  assert.equal(summary.optionWinRate, 2 / 3);
  assert.equal(summary.medianAdvantage, 5);
});

test("frequency weighted payoff is the bin contribution to total EV", () => {
  assert.equal(computePayoffBinValue(600, 3, 100, "payoff"), 200);
  assert.equal(computePayoffBinValue(600, 3, 100, "frequency"), 6);
});

test("cumulative series shares terminal-price order and ends at each EV", () => {
  const points = buildSharedTerminalCumulativeSeries(
    [70_000, 50_000, 60_000],
    [20, -10, 0],
    [8, -4, 2],
  );

  assert.deepEqual(
    points.map((point) => point.terminalPrice),
    [50_000, 60_000, 70_000],
  );
  assert.equal(points[0].primaryContribution, -10 / 3);
  assert.equal(points[1].primaryContribution, -10 / 3);
  assert.ok(Math.abs(points[2].primaryContribution - 10 / 3) < 1e-12);
  assert.equal(points[0].comparisonContribution, -4 / 3);
  assert.equal(points[2].comparisonContribution, 2);
});

test("cumulative smoothing preserves exact EV endpoints", () => {
  const points = [
    { terminalPrice: 1, primaryContribution: -1, comparisonContribution: -2 },
    { terminalPrice: 2, primaryContribution: 4, comparisonContribution: 3 },
    { terminalPrice: 3, primaryContribution: 0, comparisonContribution: -1 },
    { terminalPrice: 4, primaryContribution: 6, comparisonContribution: 5 },
    { terminalPrice: 5, primaryContribution: 3, comparisonContribution: 2 },
  ];
  const smoothed = smoothSharedTerminalCumulativeSeries(points, 2);

  assert.deepEqual(smoothed[0], points[0]);
  assert.deepEqual(smoothed[smoothed.length - 1], points[points.length - 1]);
  assert.equal(smoothed[2].terminalPrice, points[2].terminalPrice);
  assert.notEqual(smoothed[2].primaryContribution, points[2].primaryContribution);
});
