import test from "node:test";
import assert from "node:assert/strict";
import { spotDelta, selectLiveQuotes } from "./volatility.js";
import { interpolateSkew, buildCurrentSkew, buildHistoricalSkew, rankCurrentSkew, DELTAS } from "./skew.js";

const ts = 1_790_000_000, expiry = ts + 90 * 86400;
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);

// Construct a ladder whose delta brackets and variances have known weights.
function quote(side, delta, iv, overrides = {}) {
  const q = { side, iv, spot: 100, ts, expiry, ...overrides };
  let low = 0.01, high = 10000;
  for (let i = 0; i < 100; i++) {
    const strike = (low + high) / 2;
    if (spotDelta({ ...q, strike }) > delta) low = strike;
    else high = strike;
  }
  return { ...q, strike: (low + high) / 2 };
}
const ladder = () => [quote("C", 0.1, 0.4), quote("C", 0.4, 0.7), quote("P", -0.4, 0.8), quote("P", -0.1, 0.5)];

test("15/25/35 delta interpolate each wing's variance before call-minus-put subtraction", () => {
  for (const { delta } of DELTAS) {
    const point = interpolateSkew(ladder(), delta);
    const weight = (delta - 0.1) / 0.3;
    const call = Math.sqrt(0.4 ** 2 * (1 - weight) + 0.7 ** 2 * weight);
    const put = Math.sqrt(0.5 ** 2 * (1 - weight) + 0.8 ** 2 * weight);
    close(point.callIv, call);
    close(point.putIv, put);
    close(point.skew, call - put);
    assert.ok(point.skew < 0, "puts richer means negative skew");
  }
});

test("flat zero, positive, and negative skew are valid observations", () => {
  for (const [call, put] of [[0.5, 0.5], [0.6, 0.4], [0.4, 0.6]]) {
    const rows = [quote("C", 0.1, call), quote("C", 0.4, call), quote("P", -0.4, put), quote("P", -0.1, put)];
    close(interpolateSkew(rows).skew, call - put);
    assert.equal(buildCurrentSkew(rows, 0.25).length, 1);
  }
});

test("missing, invalid, expired, or unbracketed wings do not extrapolate", () => {
  const rows = ladder();
  assert.equal(interpolateSkew(rows.filter(q => q.side === "C")), null);
  assert.equal(interpolateSkew(rows.slice(1)), null);
  assert.equal(interpolateSkew(rows.map(q => ({ ...q, iv: NaN }))), null);
  assert.equal(interpolateSkew(rows.map(q => ({ ...q, ts: expiry }))), null);
  assert.throws(() => interpolateSkew(rows, 0.5));
});

test("historical pairing never combines wings across timestamps or expiries", () => {
  const rows = ladder();
  const shifted = rows.map(q => q.side === "P" ? { ...q, ts: ts + 3600 } : q);
  const splitExpiry = rows.map(q => q.side === "P" ? { ...q, expiry: expiry + 86400 } : q);
  const build = quotes => buildHistoricalSkew({ quotes, expiries: [expiry, expiry + 86400], delta: 0.25 });
  assert.deepEqual(build(shifted), []);
  assert.deepEqual(build(splitExpiry), []);
  assert.equal(build(rows).length, 1);
  assert.deepEqual(buildHistoricalSkew({ quotes: rows, expiries: [], delta: 0.25 }), []);
});

test("history retains the latest observations per maturity; ranking includes zero and half-weight ties", () => {
  const quotes = [0, 1, 2].flatMap(i => ladder().map(q => ({ ...q, ts: ts + i * 3600 })));
  const history = buildHistoricalSkew({ quotes, expiries: [expiry], delta: 0.25, limit: 2 });
  assert.deepEqual(history.map(p => p.ts), [ts + 3600, ts + 7200]);
  const [ranked] = rankCurrentSkew([{ expiry, skew: 0 }], [-0.1, 0, 0.1].map(skew => ({ expiry, skew })));
  assert.equal(ranked.rank, 50);
  assert.equal(ranked.count, 3);
  assert.equal(rankCurrentSkew([{ expiry, skew: 0 }], [])[0].rank, null);
});

test("book-mid selection retains marks for missing books and recomputes both wings", () => {
  const rows = ladder().map(q => ({ ...q, bookIv: q.side === "C" ? q.iv + 0.1 : null }));
  const book = selectLiveQuotes(rows, "book");
  assert.equal(book[2].iv, rows[2].iv);
  assert.equal(book[0].iv, rows[0].iv + 0.1);
  assert.notEqual(interpolateSkew(book).skew, interpolateSkew(rows).skew);
});
