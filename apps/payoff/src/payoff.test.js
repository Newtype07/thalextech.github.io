import assert from "node:assert/strict";
import test from "node:test";
import { buildPayoff, payoffAtPrice } from "./payoff.js";
import { normalizePayoffQuote } from "./payoff-market.js";

const NOW = 1_800_000_000, EXPIRY = NOW + 30 * 86400;
const leg = (overrides = {}) => ({
  optionType: "call", strike: 100, signedQty: 1, premium: 10,
  expirationTs: EXPIRY, forward: 102, iv: 0.4, ...overrides,
});
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-5, `${a} != ${b}`);

test("long call subtracts current mark, with an exact break-even", () => {
  const result = buildPayoff([leg()], NOW);
  assert.deepEqual(result.breakEvens.points, [110]);
  assert.equal(result.netPremium, 10);
  close(payoffAtPrice([leg()], 120, EXPIRY, 102), 10);
  assert.ok(result.points.some((p) => p.price === 100 && p.pnl === -10));
});

test("short puts and unequal quantities use signed marks and payouts", () => {
  const result = buildPayoff([leg({ optionType: "put", signedQty: -3, premium: 7 })], NOW);
  assert.deepEqual(result.breakEvens.points, [93]);
  assert.equal(result.netPremium, -21);
  close(payoffAtPrice([leg({ optionType: "put", signedQty: -3, premium: 7 })], 80, EXPIRY, 102), -39);
});

test("straddle has both break-evens and includes a far crossing in the chart", () => {
  const result = buildPayoff([leg({ premium: 80 }), leg({ optionType: "put", premium: 10 })], NOW);
  assert.deepEqual(result.breakEvens.points, [10, 190]);
  assert.ok(result.points[0].price <= 10);
  assert.ok(result.points.at(-1).price >= 190);
});

test("bull call spread nets credit from the short leg", () => {
  const result = buildPayoff([leg(), leg({ strike: 120, signedQty: -1, premium: 3 })], NOW);
  assert.deepEqual(result.breakEvens.points, [107]);
  close(payoffAtPrice([leg(), leg({ strike: 120, signedQty: -1, premium: 3 })], 150, EXPIRY, 102), 13);
});

test("same maturity uses a single forward despite slightly different quote timestamps", () => {
  const result = buildPayoff([leg(), leg({ optionType: "put", forward: 103 })], NOW);
  assert.deepEqual(result.breakEvens.points, [80, 120]);
});

test("no crossings and zero-payoff intervals are distinguished", () => {
  assert.deepEqual(buildPayoff([leg(), leg({ signedQty: -1, premium: 5 })], NOW).breakEvens, { points: [], ranges: [] });
  assert.deepEqual(buildPayoff([leg(), leg({ signedQty: -1 })], NOW).breakEvens,
    { points: [], ranges: [{ from: 0, to: Infinity }] });
  assert.deepEqual(buildPayoff([leg({ premium: 0 })], NOW).breakEvens,
    { points: [], ranges: [{ from: 0, to: 100 }] });
});

test("a butterfly touching zero at its middle strike has one break-even", () => {
  const result = buildPayoff([
    leg({ strike: 90, premium: 20 }),
    leg({ strike: 100, signedQty: -2, premium: 6 }),
    leg({ strike: 110, premium: 2 }),
  ], NOW);
  assert.deepEqual(result.breakEvens.points, [100]);
});

test("first maturity sets the reference regardless of leg order; later legs retain time value", () => {
  const later = leg({ expirationTs: EXPIRY + 30 * 86400, forward: 105, premium: 15 });
  const first = leg({ signedQty: -1, forward: 101 });
  const result = buildPayoff([later, first], NOW);
  assert.equal(result.horizonTs, EXPIRY);
  assert.equal(result.forward, 101);
  assert.equal(result.mixedMaturities, true);
  const pnl = payoffAtPrice([later, first], 101, EXPIRY, 101);
  assert.ok(pnl > -5, "later option must retain more than intrinsic value");
  for (const root of result.breakEvens.points) close(payoffAtPrice([later, first], root, EXPIRY, 101), 0);
});

test("invalid and expired inputs cannot silently produce break-evens", () => {
  assert.equal(buildPayoff([], NOW), null);
  assert.throws(() => buildPayoff([leg({ premium: NaN })], NOW), /current marks/);
  assert.throws(() => buildPayoff([leg({ expirationTs: NOW })], NOW), /unexpired/);
  assert.throws(() => buildPayoff([leg(), leg({ expirationTs: EXPIRY + 86400, iv: null })], NOW), /IV is required/);
});

test("offsetting calendars show a zero-payoff range instead of thousands of roots", () => {
  const later = { expirationTs: EXPIRY + 86400 };
  const result = buildPayoff([
    leg(), leg({ signedQty: -1 }),
    leg(later), leg({ ...later, signedQty: -1 }),
  ], NOW);
  assert.deepEqual(result.breakEvens.points, []);
  assert.equal(result.breakEvens.ranges.length, 1);
});

test("exchange adapter rejects missing forwards and marks, including null fields", () => {
  const ticker = { mark_price: 5, forward: 102, iv: 0.4, index: 100, mark_timestamp: NOW };
  assert.deepEqual(normalizePayoffQuote(ticker, "CALL"), { premium: 5, forward: 102, iv: 0.4, spot: 100, timestamp: NOW });
  for (const field of ["mark_price", "forward", "index", "mark_timestamp"])
    assert.throws(() => normalizePayoffQuote({ ...ticker, [field]: null }, "CALL"), /CALL/);
  assert.equal(normalizePayoffQuote({ ...ticker, mark_price: 0 }, "CALL").premium, 0);
});


test("expiry payoff limits match long/short straddles, bounded puts and spreads", () => {
  const straddle = [leg({ strike: 78000, premium: 3000 }), leg({ optionType: "put", strike: 78000, premium: 2905 })];
  const long = buildPayoff(straddle, NOW);
  assert.equal(long.maxLoss, 5905);
  assert.equal(long.maxReturn, Infinity);
  assert.deepEqual(long.breakEvens.points, [72095, 83905]);
  const short = buildPayoff(straddle.map(item => ({ ...item, signedQty: -1 })), NOW);
  assert.equal(short.maxLoss, Infinity);
  assert.equal(short.maxReturn, 5905);
  const put = buildPayoff([leg({ optionType: "put" })], NOW);
  assert.equal(put.maxLoss, 10);
  assert.equal(put.maxReturn, 90);
  const spread = buildPayoff([leg(), leg({ strike: 120, signedQty: -1, premium: 3 })], NOW);
  assert.equal(spread.maxLoss, 7);
  assert.equal(spread.maxReturn, 13);
});

test("time curves show long-straddle decay on a common price and entry-cost basis", () => {
  const legs = [leg({ forward: 100 }), leg({ optionType: "put", forward: 100 })];
  const result = buildPayoff(legs, NOW);
  assert.deepEqual(result.decayCurves.map(curve => curve.elapsedFraction), [0, 0.25, 0.5, 0.75]);
  const atStrike = curve => curve.points.find(point => point.price === 100).pnl;
  const values = [...result.decayCurves.map(atStrike), atStrike(result)];
  assert.ok(values.every((value, i) => i === 0 || value < values[i - 1]), "time value decreases at a fixed ATM price");
  assert.equal(values.at(-1), -20, "expiry loses the same original premium");
  for (const curve of result.decayCurves) {
    assert.deepEqual(curve.points.map(point => point.price), result.points.map(point => point.price));
    assert.equal(curve.timestamp, NOW + (EXPIRY - NOW) * curve.elapsedFraction);
    assert.ok(curve.points.every(point => Number.isFinite(point.pnl)));
  }
  const short = buildPayoff(legs.map(item => ({ ...item, signedQty: -1 })), NOW);
  result.decayCurves.forEach((curve, i) => curve.points.forEach((point, j) => close(point.pnl, -short.decayCurves[i].points[j].pnl)));
});

test("time curves preserve call-put parity and keep later calendar legs alive", () => {
  const call = buildPayoff([leg()], NOW);
  const put = buildPayoff([leg({ optionType: "put" })], NOW);
  for (let i = 0; i < call.decayCurves.length; i++) {
    const c = call.decayCurves[i].points.find(point => point.price === 102);
    const p = put.decayCurves[i].points.find(point => point.price === 102);
    close(c.pnl - p.pnl, 2);
  }
  const later = leg({ expirationTs: EXPIRY + 30 * 86400, forward: 105, premium: 15 });
  const first = leg({ signedQty: -1, forward: 101 });
  const calendar = buildPayoff([later, first], NOW);
  assert.ok(calendar.decayCurves.every(curve => curve.timestamp < EXPIRY));
  assert.ok(calendar.decayCurves.every(curve => curve.points.every(point => Number.isFinite(point.pnl))));
  assert.ok(calendar.points.find(point => point.price === 101).pnl > -5);
});

test("missing IV omits time curves without fabricating it or blocking an intrinsic payoff", () => {
  const result = buildPayoff([leg({ iv: null })], NOW);
  assert.deepEqual(result.decayCurves, []);
  assert.match(result.decayUnavailableReason, /current IV/);
  assert.deepEqual(result.breakEvens.points, [110]);
  assert.ok(result.points.every(point => Number.isFinite(point.pnl)));
  assert.throws(() => buildPayoff([leg(), leg({ expirationTs: EXPIRY + 86400, iv: -0.1 })], NOW), /IV is required/);
});
