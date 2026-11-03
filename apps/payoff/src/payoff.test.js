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
