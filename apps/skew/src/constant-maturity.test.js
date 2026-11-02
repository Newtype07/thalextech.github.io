import test from "node:test";
import assert from "node:assert/strict";
import { constantMaturityCurve, constantMaturityHistory } from "./constant-maturity.js";
import { rankCurrentSkew } from "./skew.js";

const DAY = 86400, ts = 1_800_000_000;
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} ≠ ${b}`);
const slice = (days, callIv, putIv, at = ts) => ({ expiry: at + days * DAY, ts: at, callIv, putIv, skew: callIv - putIv });

test("constant tenor interpolates each wing's total variance before subtracting IVs", () => {
  const inputs = Object.freeze([Object.freeze(slice(10, 0.4, 0.7)), Object.freeze(slice(50, 0.8, 0.9))]);
  const [p] = constantMaturityCurve(inputs, ts, [30]);
  const call = Math.sqrt((0.4 ** 2 * 10 * 0.5 + 0.8 ** 2 * 50 * 0.5) / 30);
  const put = Math.sqrt((0.7 ** 2 * 10 * 0.5 + 0.9 ** 2 * 50 * 0.5) / 30);
  close(p.callIv, call); close(p.putIv, put); close(p.skew, call - put);
  assert.equal(p.tenorDays, 30); assert.equal(p.ts, ts);
  assert.equal(p.nearExpiry, inputs[0].expiry); assert.equal(p.farExpiry, inputs[1].expiry);
  assert.equal(p.weight, 0.5);
  assert.ok(Math.abs(p.skew - (-0.2)) > 0.01, "raw skew must not be linearly interpolated");
});

test("flat wing IVs, signed skew, and exact maturity nodes are preserved", () => {
  for (const [call, put] of [[0.4, 0.6], [0.6, 0.4], [0.5, 0.5]]) {
    const inputs = [slice(5, call, put), slice(90, call, put)];
    const curve = constantMaturityCurve(inputs, ts, [5, 7, 30, 90]);
    assert.equal(curve.length, 4);
    for (const p of curve) { close(p.callIv, call); close(p.putIv, put); close(p.skew, call - put); }
    assert.equal(curve[0].nearExpiry, curve[0].farExpiry);
  }
});

test("constant tenor rolls relative to each observation, including contracts expired today", () => {
  const expiry1 = ts + 10 * DAY, expiry2 = ts + 50 * DAY;
  const history = [ts, ts + 5 * DAY].flatMap(at => [
    { expiry: expiry1, ts: at, callIv: 0.4, putIv: 0.6 },
    { expiry: expiry2, ts: at, callIv: 0.4, putIv: 0.6 },
  ]);
  const points = constantMaturityHistory(history, [7, 30]);
  assert.deepEqual(points.map(p => p.tenorDays), [30, 7, 30], "7D becomes bracketed as the first expiry rolls closer");
  for (const p of points) close(p.skew, -0.2);
  const later = points.find(p => p.ts === ts + 5 * DAY && p.tenorDays === 30);
  close(later.weight, (30 - 5) / (45 - 5));
});

test("no maturity extrapolation, cross-time pairing, or substitution of invalid wings", () => {
  const inputs = [slice(10, 0.4, 0.5), slice(50, 0.6, 0.7)];
  assert.deepEqual(constantMaturityCurve(inputs, ts, [1, 7, 60, 180]), []);
  assert.deepEqual(constantMaturityCurve(inputs, null), []);
  assert.deepEqual(constantMaturityCurve([inputs[0], { ...inputs[1], putIv: NaN }], ts, [30]), []);
  assert.deepEqual(constantMaturityHistory([inputs[0], { ...inputs[1], ts: ts + DAY }], [30]), []);
});

test("percentiles compare the same constant tenor across rolling listed expiry brackets", () => {
  const history = [
    { tenorDays: 7, skew: -0.1 }, { tenorDays: 7, skew: 0 }, { tenorDays: 7, skew: 0.1 },
    { tenorDays: 30, skew: 0.2 },
  ];
  const [p] = rankCurrentSkew([{ tenorDays: 7, skew: 0 }], history, "tenorDays");
  assert.equal(p.count, 3); assert.equal(p.rank, 50);
});
