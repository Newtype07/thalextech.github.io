import test from "node:test";
import assert from "node:assert/strict";
import { buildSkewTimeSeries, HISTORY_VIEWS, historyWindow, mergeSkewHistory } from "./skew-timeseries.js";
const HOUR = 3600, end = Date.UTC(2026, 9, 30, 19, 23) / 1000, tenors = [7, 30, 90, 180];
const point = (ts, tenorDays, skew = -0.04) => ({ ts, tenorDays, skew });
for (const { value, step } of HISTORY_VIEWS) {
  test(`${value} uses a bounded UTC schedule and one chronological line per tenor`, () => {
    const window = historyWindow(value, end);
    assert.ok(window.timestamps.length <= 373 && window.timestamps.length >= 160);
    assert.equal(window.to % step, 0);
    const history = window.timestamps.flatMap(ts => tenors.map(t => point(ts, t)));
    const result = buildSkewTimeSeries({ history, tenors, asOf: end, view: value });
    assert.equal(result.timestamps.length, window.timestamps.length);
    assert.equal(result.series.length, tenors.length);
    assert.equal(result.from, window.from); assert.equal(result.to, window.to);
    for (const series of result.series) {
      assert.ok(series.points.every(p => p.tenorDays === series.tenorDays));
      assert.deepEqual(series.points.map(p => p.ts), window.timestamps);
    }
  });
}
test("month/year windows use calendar boundaries, including end-of-month and leap years", () => {
  const march = Date.UTC(2026, 2, 31, 19) / 1000;
  assert.equal(historyWindow("1m", march).from, Date.UTC(2026, 1, 28, 18) / 1000);
  const leap = Date.UTC(2024, 1, 29, 12) / 1000;
  assert.equal(historyWindow("1y", leap).from, Date.UTC(2023, 1, 28) / 1000);
  assert.equal(historyWindow("1y", end).from, Date.UTC(2025, 9, 30) / 1000);
});
test("missing closes stay explicit and sampling never borrows a neighbouring hour", () => {
  const close = historyWindow("6m", end).to;
  const history = [point(close, 7, 0), point(close - HOUR, 30), point(close - 24 * HOUR, 30), point(close, 90, NaN)];
  const result = buildSkewTimeSeries({ history, tenors, asOf: end, view: "6m" });
  assert.equal(result.series[0].points.at(-1).skew, 0);
  assert.equal(result.series[1].points.at(-1), null);
  assert.equal(result.series[1].points.at(-2).ts, close - 24 * HOUR);
  assert.ok(result.series[2].points.every(p => p === null));
});
test("live marks append without changing cached history or duplicating an exact-close endpoint", () => {
  const close = historyWindow("1w", end).to;
  const historical = Object.freeze(point(close, 7, -0.04));
  const live = Object.freeze(point(end, 7, -0.03));
  const result = buildSkewTimeSeries({ history: [historical], current: [live], tenors, asOf: end, view: "1w" });
  assert.equal(result.series[0].points.at(-2), historical);
  assert.deepEqual(result.series[0].points.at(-1), { ...live, live: true });
  assert.equal(result.series[1].points.at(-1), null); assert.equal(live.live, undefined);
  const exact = buildSkewTimeSeries({ history: [historical], current: [point(close, 7, 0)], tenors, asOf: close, view: "1w" });
  assert.equal(exact.timestamps.length, 169); assert.equal(exact.series[0].points.at(-1).live, true);
});
test("merging prepared Parquet observations with API additions replaces matching keys without losing older history", () => {
  const old = Object.freeze(point(end - 365 * 86400, 30));
  const recent = point(end, 7, -0.03), corrected = point(end, 7, -0.04);
  const merged = mergeSkewHistory([recent, old], [corrected, point(end, 30)]);
  assert.equal(merged.length, 3); assert.equal(merged[0], old); assert.equal(merged[1], corrected);
  assert.equal(recent.skew, -0.03);
});
test("invalid views and empty reference times are handled explicitly", () => {
  assert.deepEqual(buildSkewTimeSeries({ history: [], tenors, asOf: null }), { timestamps: [], series: [], from: null, to: null });
  assert.throws(() => historyWindow("invalid", end), /Unknown history view/);
});
