import test from "node:test";
import assert from "node:assert/strict";
import { skewTimeSeriesPath } from "./components/skew-curve.js";
const x = ts => ts * 100, y = skew => skew * 100;
test("display smoothing rounds interior observations, preserves endpoints and leaves source data untouched", () => {
  const points = Object.freeze([Object.freeze({ ts: 0, tenorDays: 30, skew: -0.03 }), Object.freeze({ ts: 1, tenorDays: 30, skew: 0 }), Object.freeze({ ts: 2, tenorDays: 30, skew: 0.05 })]);
  const path = skewTimeSeriesPath(points, x, y);
  assert.ok(path.startsWith("M0,-3"));
  assert.ok(path.includes("C"));
  assert.ok(!path.includes(",100,0C"), "interior corners are rounded rather than interpolated exactly");
  assert.ok(path.endsWith("200,5"));
  assert.deepEqual(points.map(p => p.skew), [-0.03, 0, 0.05]);
});
test("outages are not bridged and isolated observations remain visible", () => {
  assert.equal(skewTimeSeriesPath([{ ts: 0, skew: 0 }, null, { ts: 2, skew: -0.05 }], x, y), "M-3,0h6M197,-5h6");
  assert.equal(skewTimeSeriesPath([], x, y), null);
});
