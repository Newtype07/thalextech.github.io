import test from "node:test";
import assert from "node:assert/strict";
import { buildForwardCurve, YEAR } from "./simulation/forward-curve.js";
import { nearestListedStrike } from "./simulation/straddle-selection.js";
import { straddlePayoff } from "./simulation/straddle-payoff.js";
import { hedgeDecision } from "./simulation/delta-hedge.js";
import { simulateStraddle } from "./simulation/straddle-simulation.js";
import { calcOptionPrice } from "../../../lib/thalex.js";

const DAY = 86400;
const near = (actual, expected, tolerance = 1e-7) =>
  assert.ok(
    Math.abs(actual - expected) < tolerance,
    `${actual} != ${expected}`,
  );
const config = (overrides) => ({
  asset: "BTC",
  side: "sell",
  spot: 100000,
  strike: 100000,
  quantity: 1,
  maturity: 7 * DAY,
  horizon: 7 * DAY,
  step: 300,
  rvMultiplier: 0.8,
  drift: 0,
  threshold: 0.05,
  tolerance: 0.15,
  period: 1800,
  timing: "timer",
  hedgeBps: 1,
  optionBps: 1,
  seed: 42,
  nodes: [
    { seconds: DAY, iv: 0.7 },
    { seconds: 7 * DAY, iv: 0.6 },
    { seconds: 30 * DAY, iv: 0.55 },
  ],
  ...overrides,
});

test("forward variance integrates to the market's total variance and remaining IV rolls down", () => {
  const curve = buildForwardCurve(config().nodes, 7 * DAY);
  near(curve.entryIv, 0.6);
  near(curve.totalVariance, (0.6 ** 2 * 7 * DAY) / YEAR);
  near(curve.intervals[0].iv, 0.7);
  const tailIv = Math.sqrt((0.6 ** 2 * 7 - 0.7 ** 2) / 6);
  near(curve.intervals[1].iv, tailIv);
  near(curve.remainingIv(DAY), tailIv);
  near(curve.remainingIv(3 * DAY), tailIv);
  near(
    curve.varianceAt(7 * DAY) - curve.varianceAt(DAY),
    (tailIv ** 2 * 6 * DAY) / YEAR,
  );
});

test("maturity interpolates in total variance; no extrapolation or negative-forward repair", () => {
  const curve = buildForwardCurve(config().nodes, 4 * DAY);
  near(curve.totalVariance, (((0.7 ** 2 + 0.6 ** 2 * 7) / 2) * DAY) / YEAR);
  assert.throws(() => buildForwardCurve(config().nodes, 31 * DAY), /exceeds/);
  assert.throws(
    () =>
      buildForwardCurve(
        [
          { seconds: DAY, iv: 2 },
          { seconds: 7 * DAY, iv: 0.1 },
        ],
        7 * DAY,
      ),
    /Negative forward variance/,
  );
  // A bad long-dated interval must not invalidate a shorter, covered trade.
  assert.doesNotThrow(() =>
    buildForwardCurve(
      [
        { seconds: DAY, iv: 0.7 },
        { seconds: 7 * DAY, iv: 0.01 },
      ],
      DAY,
    ),
  );
});

test("flat IV has zero term-roll attribution; backwards IV produces nonzero roll", () => {
  const flat = simulateStraddle(
    config({ nodes: [{ seconds: 7 * DAY, iv: 0.6 }] }),
  );
  near(flat.end.buckets.roll, 0, 1e-6);
  const shaped = simulateStraddle(config());
  assert.ok(shaped.end.buckets.roll > 0);
});

test("breach timer resets inside threshold and tolerance bypasses the timer", () => {
  const policy = {
    threshold: 0.05,
    tolerance: 0.15,
    period: 300,
    timing: "timer",
  };
  let state = { elapsed: 0, netDelta: 0.1, breachSince: null };
  let decision = hedgeDecision(state, policy);
  assert.equal(decision.reason, null);
  assert.equal(decision.breachSince, 0);
  decision = hedgeDecision(
    { elapsed: 240, netDelta: 0.04, breachSince: 0 },
    policy,
  );
  assert.equal(decision.breachSince, null);
  decision = hedgeDecision(
    { elapsed: 300, netDelta: 0.1, breachSince: decision.breachSince },
    policy,
  );
  assert.equal(decision.reason, null);
  decision = hedgeDecision(
    { elapsed: 600, netDelta: 0.1, breachSince: decision.breachSince },
    policy,
  );
  assert.equal(decision.reason, "timer");
  assert.equal(
    hedgeDecision({ elapsed: 1, netDelta: -0.16, breachSince: null }, policy)
      .reason,
    "tolerance",
  );
  assert.equal(
    hedgeDecision(
      { elapsed: 1, netDelta: -0.16, breachSince: null },
      { ...policy, tolerance: 0 },
    ).reason,
    null,
  );
});

test("scheduled checks ignore the breach duration and act only on their clock", () => {
  const policy = {
    threshold: 0.05,
    tolerance: 0.15,
    period: 1800,
    timing: "scheduled",
  };
  assert.equal(
    hedgeDecision({ elapsed: 1500, netDelta: 0.1, breachSince: 0 }, policy)
      .reason,
    null,
  );
  assert.equal(
    hedgeDecision({ elapsed: 1800, netDelta: 0.1, breachSince: 1790 }, policy)
      .reason,
    "scheduled",
  );
  assert.equal(
    hedgeDecision({ elapsed: 1800, netDelta: 0.04, breachSince: 0 }, policy)
      .reason,
    null,
  );
});

test("same seed preserves the entire price path under different side, size, hedge and cost choices", () => {
  const a = simulateStraddle(config());
  const b = simulateStraddle(
    config({
      side: "buy",
      quantity: 2,
      timing: "scheduled",
      period: 3600,
      threshold: 0.02,
      tolerance: 0.1,
      hedgeBps: 10,
      optionBps: 3,
    }),
  );
  assert.deepEqual(
    a.rows.map((r) => [r.elapsed, r.spot]),
    b.rows.map((r) => [r.elapsed, r.spot]),
  );
  const c = simulateStraddle(config({ seed: 43 }));
  assert.notEqual(a.end.spot, c.end.spot);
  assert.deepEqual(
    a.rows.map((r) => r.spot),
    simulateStraddle(config()).rows.map((r) => r.spot),
  );
});

test("buy and sell P&L and hedges are opposite before costs", () => {
  const short = simulateStraddle(config({ hedgeBps: 0, optionBps: 0 }));
  const long = simulateStraddle(
    config({ side: "buy", hedgeBps: 0, optionBps: 0 }),
  );
  short.rows.forEach((row, i) => {
    near(row.spot, long.rows[i].spot);
    near(row.pnl, -long.rows[i].pnl);
    near(row.position, -long.rows[i].position);
  });
});

test("the cash/fill ledger independently reproduces hedge P&L and every step reconciles", () => {
  const run = simulateStraddle(config({ horizon: 3 * DAY + 123 }));
  let cash = 0,
    position = 0,
    costs =
      (2 * run.config.spot * run.config.quantity * run.config.optionBps) /
      10000;
  const trades = [...run.trades];
  for (const row of run.rows) {
    while (trades.length && trades[0].elapsed <= row.elapsed) {
      const trade = trades.shift();
      cash -= trade.amount * trade.spot;
      position += trade.amount;
      costs += trade.cost;
    }
    near(cash + position * row.spot, row.hedgePnl, 1e-6);
    near(row.pnl, row.optionPnl + row.hedgePnl - row.fees);
    near(row.fees, row.optionFees + row.hedgeFees);
    near(
      row.pnl,
      row.optionPnl - row.optionFees + (row.hedgePnl - row.hedgeFees),
    );
    near(
      Object.values(row.buckets).reduce((a, b) => a + b, 0),
      row.pnl,
      1e-6,
    );
    near(row.returnOnPremium, row.pnl / run.premium);
  }
  costs +=
    (2 * run.end.spot * run.config.quantity * run.config.optionBps) / 10000;
  near(run.end.fees, costs);
  assert.equal(run.end.elapsed, 3 * DAY + 123);
  assert.equal(run.end.position, 0);
  assert.equal(run.end.netDelta, 0);
});

test("expiry pays intrinsic and unwinds hedge without charging an early option close", () => {
  const run = simulateStraddle(config());
  const intrinsic = Math.abs(run.end.spot - run.config.strike);
  near(run.end.optionPnl, run.premium - intrinsic * run.config.quantity);
  const expectedFees =
    (2 * run.config.spot * run.config.quantity * run.config.optionBps) / 10000 +
    run.trades.reduce((total, trade) => total + trade.cost, 0);
  near(run.end.fees, expectedFees);
  assert.equal(run.trades.at(-1).reason, "exit");
  assert.equal(run.end.position, 0);
  const expectedPremium = ["call", "put"].reduce(
    (value, side) =>
      value +
      calcOptionPrice(
        run.config.spot,
        run.config.strike,
        run.config.maturity,
        run.curve.entryIv,
        side,
      ),
    0,
  );
  near(run.premium, expectedPremium);
});

test("zero RV and drift give a constant path; all premium decays for an ATM short at settlement", () => {
  const run = simulateStraddle(
    config({ rvMultiplier: 0, hedgeBps: 0, optionBps: 0 }),
  );
  assert.ok(run.rows.every((row) => row.spot === run.config.spot));
  near(run.end.hedgePnl, 0);
  near(run.end.pnl, run.premium);
  near(run.sampledRv, 0);
});

test("marks follow the remaining curve without an added IV scenario", () => {
  const run = simulateStraddle(config());
  const curve = buildForwardCurve(run.config.nodes, run.config.maturity);
  for (const row of run.rows) near(row.iv, curve.remainingIv(row.elapsed));
});

test("RV scaling obeys the geometric-Brownian log-return relation for identical draws", () => {
  const full = simulateStraddle(config({ rvMultiplier: 1 }));
  const half = simulateStraddle(config({ rvMultiplier: 0.5 }));
  const variance = (0.6 ** 2 * 7 * DAY) / YEAR;
  near(
    Math.log(half.end.spot / half.config.spot),
    0.5 * Math.log(full.end.spot / full.config.spot) + 0.125 * variance,
  );
  near(full.targetRv, 0.6);
  near(half.targetRv, 0.3);
});

test("invalid simulation inputs and excessive work fail explicitly", () => {
  for (const input of [
    { quantity: 0 },
    { spot: NaN },
    { seed: -1 },
    { tolerance: 0.01 },
    { horizon: 8 * DAY },
    { step: 0.01 },
    { timing: "scheduled", period: 0 },
  ]) {
    assert.throws(() => simulateStraddle(config(input)));
  }
});

test("nearest listed straddle requires both legs at the selected expiry, with deterministic ties", () => {
  const instruments = [
    { expiry: 100, strike: 90000, side: "C" },
    { expiry: 100, strike: 90000, side: "P" },
    { expiry: 100, strike: 92000, side: "C" },
    { expiry: 100, strike: 92000, side: "P" },
    { expiry: 100, strike: 91000, side: "C" },
    { expiry: 200, strike: 91000, side: "P" },
  ];
  assert.equal(nearestListedStrike(instruments, 100, 91000), 90000);
  assert.equal(nearestListedStrike(instruments, 100, 91500), 92000);
  assert.equal(nearestListedStrike(instruments, 200, 91000), null);
  assert.equal(nearestListedStrike(instruments, 300, 91000), null);
  assert.equal(nearestListedStrike(instruments, 100, NaN), null);
});

test("annual drift changes expected price growth while preserving the seeded random moves", () => {
  const base = simulateStraddle(config({ drift: 0 }));
  for (const drift of [-0.2, 0.2]) {
    const scenario = simulateStraddle(config({ drift }));
    scenario.rows.forEach((row, i) => {
      near(
        Math.log(row.spot / base.rows[i].spot),
        (drift * row.elapsed) / YEAR,
      );
    });
  }
  const deterministic = simulateStraddle(
    config({ rvMultiplier: 0, drift: 0.2 }),
  );
  near(
    deterministic.end.spot,
    deterministic.config.spot *
      Math.exp((0.2 * deterministic.config.horizon) / YEAR),
    1e-6,
  );
});

test("option-only payoff summary has exact break-evens and correct bounded/unbounded sides", () => {
  const long = straddlePayoff({
    strike: 78000,
    entryPrice: 5905,
    quantity: 1,
    side: "buy",
  });
  assert.deepEqual(long, {
    maxLoss: 5905,
    maxReturn: Infinity,
    breakEvens: [72095, 83905],
  });
  const short = straddlePayoff({
    strike: 78000,
    entryPrice: 5905,
    quantity: 2,
    side: "sell",
  });
  assert.deepEqual(short, {
    maxLoss: Infinity,
    maxReturn: 11810,
    breakEvens: [72095, 83905],
  });
  for (const price of long.breakEvens) near(Math.abs(price - 78000) - 5905, 0);
  // Expiry prices cannot be negative: an expensive straddle may have one root.
  assert.deepEqual(
    straddlePayoff({ strike: 100, entryPrice: 150, quantity: 1, side: "buy" })
      .breakEvens,
    [250],
  );
  assert.throws(() =>
    straddlePayoff({ strike: 100, entryPrice: NaN, quantity: 1, side: "buy" }),
  );
});

 test("irregular scheduled periods and flat RV reuse a policy-independent clock", () => {
  const forward = simulateStraddle(config());
  const flat = simulateStraddle(config({ volatilityShape: "flat", flatRv: forward.targetRv }));
  assert.deepEqual(forward.rows.map(row => row.elapsed), flat.rows.map(row => row.elapsed));
  assert.notDeepEqual(forward.rows.map(row => row.spot), flat.rows.map(row => row.spot));
  near(flat.targetRv, forward.targetRv);
  const irregular = simulateStraddle(config({ timing: "scheduled", period: 301 }));
  assert.ok(irregular.trades.some(trade => trade.reason === "scheduled"));
});
