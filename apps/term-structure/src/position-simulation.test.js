import test from "node:test";
import assert from "node:assert/strict";
import { simulatePosition } from "./simulation/position-simulation.js";
import { buildForwardCurve } from "./simulation/forward-curve.js";
import { calcOptionPrice, calcGreeks } from "../../../lib/thalex.js";
import { builderExpiry, builderInstruments, defaultShortStraddle, resolvePosition, entryValuations } from "./simulation/position-selection.js";

const DAY = 86400;
const near = (a, b, epsilon = 1e-6) => assert.ok(Math.abs(a - b) < epsilon, `${a} != ${b}`);
const config = (overrides = {}) => ({
  asset: "BTC", spot: 100000, horizon: 7 * DAY, step: 300,
  rvMultiplier: 1, drift: 0, threshold: 0.05, tolerance: 0.15,
  period: 1800, timing: "timer", hedgeBps: 1, optionBps: 1, seed: 42,
  nodes: [{ seconds: DAY, iv: 0.7 }, { seconds: 7 * DAY, iv: 0.6 }, { seconds: 30 * DAY, iv: 0.55 }],
  legs: [
    { optionType: "call", strike: 100000, maturity: 7 * DAY, signedQty: -1 },
    { optionType: "call", strike: 100000, maturity: 30 * DAY, signedQty: 1 },
  ],
  ...overrides,
});

test("a call calendar marks each expiry independently and reconciles its hedge and cash ledger", () => {
  const input = config();
  const run = simulatePosition(input);
  const curves = input.legs.map(leg => buildForwardCurve(input.nodes, leg.maturity));
  const entry = input.legs.reduce((sum, leg, i) => sum + leg.signedQty *
    calcOptionPrice(input.spot, leg.strike, leg.maturity, curves[i].entryIv, leg.optionType), 0);
  let cash = 0, position = 0;
  const trades = [...run.trades];
  for (const row of run.rows) {
    const value = input.legs.reduce((sum, leg, i) => sum + leg.signedQty *
      calcOptionPrice(row.spot, leg.strike, leg.maturity - row.elapsed,
        curves[i].remainingIv(row.elapsed), leg.optionType), 0);
    while (trades.length && trades[0].elapsed <= row.elapsed) {
      const trade = trades.shift();
      cash -= trade.amount * trade.spot;
      position += trade.amount;
    }
    near(row.optionPnl, value - entry);
    near(row.hedgePnl, cash + position * row.spot);
    near(row.pnl, value - entry + cash + position * row.spot - row.fees);
    near(Object.values(row.buckets).reduce((sum, value) => sum + value, 0), row.pnl);
    if (row.elapsed < input.horizon) {
      const delta = input.legs.reduce((sum, leg, i) => sum + leg.signedQty *
        calcGreeks(row.spot, leg.strike, leg.maturity - row.elapsed,
          curves[i].remainingIv(row.elapsed), leg.optionType).delta, 0);
      near(row.optionDelta, delta);
    }
  }
  near(run.end.optionFees, (2 * input.spot + run.end.spot) * input.optionBps / 10000);
  assert.equal(run.end.elapsed, 7 * DAY);
  assert.equal(run.end.position, 0);
  assert.equal(run.end.netDelta, 0);
  assert.equal(run.end.gamma, 0);
  assert.equal(run.end.vega, 0);
  assert.equal(run.trades.at(-1).reason, "exit");
  assert.ok(run.legs[1].exitIv > 0);
  near(run.legs[1].exitIv, curves[1].remainingIv(input.horizon));
});

test("single options, unequal quantities and a four-leg position hedge aggregate delta", () => {
  const legs = [
    { optionType: "put", strike: 95000, maturity: 7 * DAY, signedQty: 2 },
    { optionType: "call", strike: 105000, maturity: 7 * DAY, signedQty: -3 },
    { optionType: "put", strike: 90000, maturity: 30 * DAY, signedQty: -1 },
    { optionType: "call", strike: 110000, maturity: 30 * DAY, signedQty: 1 },
  ];
  for (const count of [1, 2, 4]) {
    const run = simulatePosition(config({ legs: legs.slice(0, count) }));
    const expected = legs.slice(0, count).reduce((sum, leg) => sum + leg.signedQty *
      calcGreeks(run.config.spot, leg.strike, leg.maturity,
        buildForwardCurve(run.config.nodes, leg.maturity).entryIv, leg.optionType).delta, 0);
    near(run.rows[0].optionDelta, expected);
    near(run.rows[0].position, -expected);
    near(run.rows[0].netDelta, 0);
    near(run.rows[0].optionFees, legs.slice(0, count).reduce((sum, leg) => sum + Math.abs(leg.signedQty), 0) * run.config.spot / 10000);
  }
});

test("zero net premium is valid and vertical spreads value each strike independently", () => {
  const base = { optionType: "call", strike: 100000, maturity: 7 * DAY };
  const flat = simulatePosition(config({ legs: [{ ...base, signedQty: 1 }, { ...base, signedQty: -1 }] }));
  assert.equal(flat.entryValue, 0);
  assert.ok(flat.premium > 0);
  for (const row of flat.rows) {
    near(row.optionPnl, 0);
    near(row.hedgePnl, 0);
    near(row.pnl, -row.fees);
  }
  const vertical = simulatePosition(config({ legs: [
    { ...base, signedQty: 1 }, { ...base, strike: 110000, signedQty: -1 },
  ] }));
  assert.ok(vertical.entryValue > 0 && vertical.entryValue < 10000);
  const intrinsic = Math.max(0, vertical.end.spot - 100000) - Math.max(0, vertical.end.spot - 110000);
  near(vertical.end.optionPnl, intrinsic - vertical.entryValue);
});

test("invalid legs, uncovered expiries and holding past the last expiry fail explicitly", () => {
  for (const overrides of [
    { legs: [] }, { legs: Array(5).fill(config().legs[0]) },
    { legs: [{ ...config().legs[0], signedQty: 0 }] },
    { legs: [{ ...config().legs[0], optionType: "future" }] },
    { legs: [{ ...config().legs[0], maturity: 31 * DAY }] },
    { horizon: 31 * DAY },
  ]) assert.throws(() => simulatePosition(config(overrides)));
});

test("last-expiry runs settle each leg on its exact expiry and hedge only live options", () => {
  const input = config({
    horizon: 30 * DAY,
    legs: [
      { optionType: "call", strike: 95000, maturity: 7 * DAY + 123, signedQty: -1 },
      { optionType: "put", strike: 102000, maturity: 13 * DAY + 17, signedQty: -0.5 },
      { optionType: "call", strike: 100000, maturity: 30 * DAY, signedQty: 1 },
    ],
  });
  const run = simulatePosition(input);
  const curves = input.legs.map(leg => buildForwardCurve(input.nodes, leg.maturity));
  assert.deepEqual(run.settlements.map(item => item.elapsed), input.legs.map(leg => leg.maturity));
  assert.equal(run.end.elapsed, input.horizon);
  const settlements = new Map(run.settlements.map(item => [item.legIndex, item]));
  const firstExit = simulatePosition({ ...input, horizon: input.legs[0].maturity });
  const prefix = run.rows.filter(row => row.elapsed <= firstExit.end.elapsed);
  assert.deepEqual(prefix.map(row => row.spot), firstExit.rows.map(row => row.spot));
  assert.equal(firstExit.settlements.length, 1);
  let cash = 0, position = 0;
  const trades = [...run.trades];
  for (const row of run.rows) {
    let settled = 0, liveValue = 0, delta = 0;
    input.legs.forEach((leg, i) => {
      if (row.elapsed >= leg.maturity) {
        const settlement = settlements.get(i);
        const intrinsic = leg.optionType === "call"
          ? Math.max(0, settlement.spot - leg.strike)
          : Math.max(0, leg.strike - settlement.spot);
        near(settlement.amount, leg.signedQty * intrinsic);
        settled += leg.signedQty * intrinsic;
      } else {
        const remaining = leg.maturity - row.elapsed;
        const iv = curves[i].remainingIv(row.elapsed);
        liveValue += leg.signedQty * calcOptionPrice(row.spot, leg.strike, remaining, iv, leg.optionType);
        delta += leg.signedQty * calcGreeks(row.spot, leg.strike, remaining, iv, leg.optionType).delta;
      }
    });
    while (trades.length && trades[0].elapsed <= row.elapsed) {
      const trade = trades.shift();
      cash -= trade.amount * trade.spot;
      position += trade.amount;
    }
    near(row.settledValue, settled);
    near(row.optionValue, settled + liveValue);
    near(row.optionPnl, settled + liveValue - run.entryValue);
    near(row.optionDelta, delta);
    near(row.hedgePnl, cash + position * row.spot);
    near(row.pnl, settled + liveValue - run.entryValue + cash + position * row.spot - row.fees);
    near(Object.values(row.buckets).reduce((sum, value) => sum + value, 0), row.pnl);
  }
  const entryFees = input.legs.reduce((sum, leg) => sum + Math.abs(leg.signedQty), 0) * input.spot / 10000;
  assert.ok(run.rows.every(row => row.optionFees === entryFees), "cash settlements incur no option closing fees");
  assert.equal(run.end.netDelta, 0);
  assert.equal(run.end.position, 0);
  assert.equal(run.end.gamma, 0);
  assert.equal(run.end.vega, 0);
  assert.ok(run.trades.some(trade => trade.elapsed > input.legs[0].maturity && trade.reason !== "exit"));
});

test("an out-of-the-money settlement remains zero even if spot later crosses the strike", () => {
  const run = simulatePosition(config({
    horizon: 30 * DAY, rvMultiplier: 0, drift: 2,
    legs: [
      { optionType: "call", strike: 110000, maturity: 7 * DAY, signedQty: -1 },
      { optionType: "call", strike: 100000, maturity: 30 * DAY, signedQty: 1 },
    ],
  }));
  near(run.settlements[0].amount, 0);
  assert.ok(run.end.spot > 110000);
  const farIntrinsic = Math.max(0, run.end.spot - 100000);
  near(run.end.optionPnl, farIntrinsic - run.entryValue);
  assert.equal(run.settlements.length, 2);
});

test("builder selections resolve strictly to listed instruments and keep model entry marks consistent", () => {
  const asOf = Date.UTC(2026, 10, 3, 8) / 1000;
  const chain = [7, 30].flatMap(days => [95000, 100000].flatMap(strike =>
    ["C", "P"].map(side => ({ name: `BTC-${days}-${strike}-${side}`, side, strike, expiry: asOf + days * DAY }))));
  const defaults = defaultShortStraddle(chain, config().nodes, 99000, asOf);
  assert.equal(defaults.length, 2);
  assert.ok(defaults.every(leg => leg.side === "sell" && leg.qty === 1 && leg.strike === 100000));
  assert.equal(defaults[0].expiry, builderExpiry(asOf + 30 * DAY));
  const selected = resolvePosition(defaults, chain, asOf);
  assert.ok(selected.every(leg => leg.maturity === 30 * DAY && leg.signedQty === -1));
  const instruments = builderInstruments(chain, "BTC");
  assert.equal(instruments[0].underlying, "BTCUSD");
  assert.equal(instruments[0].option_type, "call");
  const values = entryValuations(selected, config().nodes, 99000);
  for (const leg of selected) {
    near(values[leg.id].mark, calcOptionPrice(99000, leg.strike, leg.maturity, 0.55, leg.optionType));
    near(values[leg.id].greeks.delta, calcGreeks(99000, leg.strike, leg.maturity, 0.55, leg.optionType).delta);
    near(values[leg.id].greeks.vega, calcGreeks(99000, leg.strike, leg.maturity, 0.55, leg.optionType).vega / 100);
  }
  assert.throws(() => resolvePosition([{ ...defaults[0], strike: 99000 }], chain, asOf), /currently listed/);
  assert.throws(() => resolvePosition([], chain, asOf), /Add an option leg/);
});

test("trade windows preserve the full path and open a fresh option and hedge ledger at the selected entry", () => {
  const input = config({ horizon: 30 * DAY, step: 1800 });
  const full = simulatePosition(input);
  const run = simulatePosition({ ...input, tradeWindow: [2 * DAY + 1, 9 * DAY + 1] });
  assert.deepEqual(run.pathRows, full.pathRows);
  assert.deepEqual(run.tradeWindow, [2 * DAY + 1800, 9 * DAY]);
  const entry = run.rows[0];
  const expectedValue = input.legs.reduce((sum, leg) => sum + leg.signedQty * calcOptionPrice(
    entry.spot, leg.strike, leg.maturity - entry.elapsed,
    buildForwardCurve(input.nodes, leg.maturity).remainingIv(entry.elapsed), leg.optionType), 0);
  near(run.entryValue, expectedValue);
  near(entry.optionPnl, 0);
  near(entry.hedgePnl, 0);
  near(entry.pnl, -entry.fees);
  near(entry.optionFees, 2 * entry.spot * input.optionBps / 10000);
  assert.equal(run.trades[0].reason, "entry");
  assert.equal(run.trades[0].elapsed, entry.elapsed);
  assert.equal(run.trades.at(-1).reason, "exit");
  assert.equal(run.trades.at(-1).elapsed, 9 * DAY);
  assert.deepEqual(run.settlements.map(row => row.elapsed), [7 * DAY]);
  near(run.end.optionFees, (2 * entry.spot + run.end.spot) * input.optionBps / 10000);
  let cash = 0, position = 0;
  const trades = [...run.trades];
  for (const row of run.rows) {
    while (trades.length && trades[0].elapsed <= row.elapsed) {
      const trade = trades.shift();
      cash -= trade.amount * trade.spot;
      position += trade.amount;
    }
    near(row.hedgePnl, cash + position * row.spot);
    near(row.pnl, row.optionValue - expectedValue + cash + position * row.spot - row.fees);
    near(Object.values(row.buckets).reduce((a, b) => a + b, 0), row.pnl);
  }
  assert.equal(run.end.position, 0);
  assert.deepEqual(simulatePosition({ ...input, tradeWindow: null }).rows, full.rows, "reset restores the original account");
});

test("window replay preserves stochastic paths and rejects empty windows or entry after a leg expires", () => {
  for (const dynamics of ["stochastic", "jumps"]) {
    const input = config({ marketModel: { shape: "forward", dynamics, rvMultiplier: 1,
      manual: { jumpIntensity: 5, jumpVol: .05 } } });
    const full = simulatePosition(input);
    const run = simulatePosition({ ...input, tradeWindow: [DAY, 3 * DAY] });
    assert.deepEqual(run.pathRows, full.pathRows);
  }
  for (const tradeWindow of [[0, 1], [40 * DAY, 41 * DAY], [NaN, DAY], [0], [7 * DAY, 8 * DAY]])
    assert.throws(() => simulatePosition(config({ horizon: 30 * DAY, tradeWindow })), /entry|observations/);
});

test("the 90-day holding horizon retains one-minute observations through expiry", () => {
  const input = config({
    horizon: 90 * DAY, step: 60, rvMultiplier: 0, hedgeEnabled: false, optionBps: 0,
    nodes: [{ seconds: 90 * DAY, iv: .6 }],
    legs: [{ optionType: "call", strike: 100000, maturity: 90 * DAY, signedQty: -1 }],
  });
  const run = simulatePosition(input);
  assert.equal(run.pathRows.length, 90 * 24 * 60 + 1);
  assert.equal(run.rows.length, run.pathRows.length);
  assert.equal(run.end.elapsed, 90 * DAY);
  assert.ok(Number.isFinite(run.end.pnl));
  assert.ok(run.pathRows.slice(1).every((row, i) => row.elapsed - run.pathRows[i].elapsed === 60));
  assert.throws(() => simulatePosition({ ...input, step: 59 }), /129,600 steps/);
});
