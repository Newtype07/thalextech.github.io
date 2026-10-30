import test from "node:test";
import assert from "node:assert/strict";
import { buildSkewSnapshots, interpolateSkewMaturities, SNAPSHOT_RESOLUTIONS } from "./skew-snapshots.js";

const HOUR = 3600, end = 500000 * HOUR;
const expiries = [end + 86400, end + 864000, end + 2592000];
const point = (ts, expiry, skew = -0.04) => ({ ts, expiry, skew });

for (const { value, count, step } of SNAPSHOT_RESOLUTIONS) {
  test(`${value} selects ${count} simultaneous curves exactly ${step / HOUR} hours apart`, () => {
    const history = Array.from({ length: 2000 }, (_, hour) =>
      expiries.map(expiry => point(end - hour * HOUR, expiry)),
    ).flat();
    const result = buildSkewSnapshots(history, expiries, end + 1200, value);
    assert.equal(result.length, count);
    assert.equal(result.at(-1).ts, end);
    assert.equal(result[0].ts, end - (count - 1) * step);
    result.forEach((snapshot, index) => {
      assert.equal(snapshot.ageIndex, count - index - 1);
      if (index) assert.equal(snapshot.ts - result[index - 1].ts, step);
      assert.deepEqual(snapshot.points.map(p => p.expiry), expiries);
      assert.ok(snapshot.points.every(p => p.ts === snapshot.ts));
    });
  });
}

test("partial snapshots are retained without borrowing or rescheduling timestamps", () => {
  const history = [
    point(end, expiries[0]), point(end, expiries[2]),
    point(end - 24 * HOUR, expiries[1]),
    point(end - HOUR, expiries[1]), // Not a weekly target.
    point(end - 900, expiries[1]), point(end + HOUR, expiries[1]),
    point(end, end + 999999), point(end, expiries[1], NaN),
  ];
  const result = buildSkewSnapshots(history, expiries, end, "weekly");
  assert.equal(result.length, 2);
  assert.deepEqual(result.at(-1).points.map(p => p?.expiry ?? null), expiries);
  assert.equal(result.at(-1).points[1].interpolated, true);
  assert.equal(result[0].points[0], null);
  assert.equal(result[0].points[2], null);
  assert.equal(result[0].points[1].interpolated, undefined);
  assert.deepEqual(buildSkewSnapshots(history, expiries, end + 14 * 24 * HOUR, "weekly"), []);
});

test("uneven expiry coverage retains all scheduled curves rather than filtering to complete ones", () => {
  const history = Array.from({ length: 72 }, (_, hour) => expiries.flatMap((expiry, index) => {
    // The middle expiry has all 72 hours, but the front and back have fewer.
    if ((index === 0 && hour > 10) || (index === 2 && hour % 2)) return [];
    return [point(end - hour * HOUR, expiry)];
  })).flat();
  const result = buildSkewSnapshots(history, expiries, end);
  assert.equal(result.length, 72);
  assert.deepEqual(result.map(s => s.ageIndex), Array.from({ length: 72 }, (_, index) => 71 - index));
  assert.ok(result.every(s => s.points.length === expiries.length && s.points.filter(Boolean).every(p => p.ts === s.ts)));
  assert.ok(result.some(s => s.points[0] === null), "front-end gaps remain unavailable rather than extrapolated");
  assert.deepEqual(buildSkewSnapshots(history, [], end), []);
});

test("negative, zero and positive skew survive selection without mutating source data", () => {
  const history = Object.freeze(expiries.map((expiry, i) => Object.freeze(point(end, expiry, (i - 1) * 0.04))));
  const [snapshot] = buildSkewSnapshots(history, expiries, end);
  assert.deepEqual(snapshot.points.map(p => p.skew), [-0.04, 0, 0.04]);
  assert.equal(snapshot.points[0], history[0]);
  assert.equal(snapshot.ageIndex, 0);
  assert.deepEqual(buildSkewSnapshots(history, expiries, null), []);
  assert.deepEqual(buildSkewSnapshots(history, expiries, undefined), []);
  assert.throws(() => buildSkewSnapshots(history, expiries, end, "invalid"), /Unknown snapshot resolution/);
});


test("maturity interpolation uses actual expiry time and preserves observed values and provenance", () => {
  const maturities = [end + HOUR, end + 2 * HOUR, end + 5 * HOUR, end + 11 * HOUR];
  const first = Object.freeze(point(end, maturities[0], -0.02));
  const last = Object.freeze(point(end, maturities[3], 0.08));
  const raw = Object.freeze([first, null, null, last]);
  const filled = interpolateSkewMaturities(raw, maturities);
  assert.equal(filled[0], first);
  assert.equal(filled[3], last);
  assert.ok(Math.abs(filled[1].skew - (-0.01)) < 1e-12);
  assert.ok(Math.abs(filled[2].skew - 0.02) < 1e-12);
  for (const p of filled.slice(1, 3)) {
    assert.equal(p.interpolated, true);
    assert.equal(p.ts, end);
    assert.equal(p.leftExpiry, first.expiry);
    assert.equal(p.rightExpiry, last.expiry);
    assert.equal(p.callIv, undefined, "chart-only estimates do not invent wing IVs");
  }
  assert.deepEqual(raw, [first, null, null, last]);
});

test("interpolation never extrapolates, fills empty snapshots, or borrows another timestamp", () => {
  const history = [point(end, expiries[1], 0), point(end - HOUR, expiries[0]), point(end - HOUR, expiries[2])];
  const result = buildSkewSnapshots(history, expiries, end);
  assert.deepEqual(result.at(-1).points.map(p => p?.skew ?? null), [null, 0, null]);
  assert.equal(result[0].points[1].interpolated, true);
  assert.equal(result[0].points[1].ts, end - HOUR);
  assert.deepEqual(interpolateSkewMaturities([null, null, null], expiries), [null, null, null]);
});
