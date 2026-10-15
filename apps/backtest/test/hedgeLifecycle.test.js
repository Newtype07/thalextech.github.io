import test from "node:test";
import assert from "node:assert/strict";
import { createHedgeReplay, toleranceTriggers } from "../src/lib/hedgeLifecycle.js";

const plan = {
  entryTs: 0, exitTs: 7_200,
  entryTime: new Date(0), exitTime: new Date(7_200_000),
  optionQuantityBtc: 1, underlyingQuantity: 0,
};
const config = { hedgeEnabled: true, hedgeMode: "tolerance", hedgeDeltaTolerance: 0.05, hedgeIntervalHours: 24 };
const bar = (ts, open = 100, low = 99, high = 101) => ({ ts, indexPrice: open, low, high });
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

test("linear trigger prices include the existing hedge and signed portfolio gamma", () => {
  const args = { open: 100, delta: 0.12, quantity: -0.1, tolerance: 0.05, high: 110, low: 90 };
  const positive = toleranceTriggers({ ...args, gamma: 0.01 });
  near(positive[0].price, 93);
  near(positive[1].targetQuantity, -0.15);
  near(positive[1].price, 103);
  const negative = toleranceTriggers({ ...args, gamma: -0.01 });
  near(negative[0].price, 107);
  near(negative[1].price, 97);
});

for (const gamma of [0.01, -0.01]) {
  test(`a high breach with gamma ${gamma} executes at the threshold, not the high or next open`, () => {
    const replay = createHedgeReplay({ plan, config, intrabarPath: "high_first" });
    const opening = replay(bar(0, 100, 99, 110), { delta: 0, gamma });
    assert.equal(opening.hedgeTrades.length, 1);
    const trade = opening.hedgeTrades[0];
    near(trade.price, 105);
    near(trade.quantity, 0.05);
    assert.equal(trade.side, gamma > 0 ? "sell" : "buy");
    assert.equal(trade.intrabar, true);
    near(opening.hedgePnlUsd, 0); // Current bar has not accrued into an opening mark.
    const next = replay(bar(3_600, 102, 102, 102), { delta: gamma * 2, gamma });
    near(next.hedgePnlUsd, gamma > 0 ? 0.15 : -0.15);
    const exit = replay(bar(7_200, 104), {});
    near(exit.hedgePnlUsd, gamma > 0 ? 0.05 : -0.05);
    near(exit.hedgeQuantity, 0);
    assert.equal(exit.hedgeTrades[0].reason, "exit");
  });
}

test("a low-only touch executes exactly at its boundary even if the next open is unchanged", () => {
  const replay = createHedgeReplay({ plan, config, intrabarPath: "high_first" });
  const opening = replay(bar(0, 100, 95, 101), { delta: 0, gamma: 0.01 });
  near(opening.hedgeTrades[0].price, 95);
  assert.equal(opening.hedgeTrades[0].side, "buy");
  const next = replay(bar(3_600, 100, 100, 100), { delta: 0, gamma: 0.01 });
  near(next.hedgePnlUsd, 0.25);
});

test("nearest trigger fills first and the opposite limit is recalculated for either gamma sign", () => {
  for (const gamma of [0.01, -0.01]) {
    const replay = createHedgeReplay({ plan, config });
    replay(bar(0), { delta: 0, gamma: 0 });
    // At the next open the existing hedge is zero, but option delta is 0.02.
    // For positive gamma the first limit is 103 (distance 3 vs 7).
    // For negative gamma the first limit is 97 (distance 3 vs 7).
    const row = replay(bar(3_600, 100, 90, 110), { delta: 0.02, gamma });
    assert.equal(row.ambiguousHedgeBar, true);
    assert.equal(row.hedgeTrades.length, 2);
    near(row.hedgeTrades[0].price, gamma > 0 ? 103 : 97);
    near(row.hedgeTrades[1].price, gamma > 0 ? 98 : 102);
    assert.equal(row.hedgeTrades[0].side, "sell");
    assert.equal(row.hedgeTrades[1].side, "buy");
    near(row.hedgeTrades[0].netDeltaAfter, 0);
    near(row.hedgeTrades[1].netDeltaAfter, 0);
    const exit = replay(bar(7_200, 108), {});
    const expected = row.hedgeTrades.reduce((sum, trade) => sum
      + (trade.side === "buy" ? 1 : -1) * trade.quantity * (108 - trade.price), 0);
    near(exit.hedgePnlUsd, expected);
  }
});

test("equal-distance triggers choose the lower price and opening trades count toward the cap", () => {
  const replay = createHedgeReplay({ plan, config });
  const entry = replay(bar(0, 100, 90, 110), { delta: 0.02, gamma: 0.01 });
  assert.equal(entry.hedgeTrades.length, 2);
  assert.equal(entry.hedgeTrades[0].reason, "entry");
  near(entry.hedgeTrades[1].price, 95);
  const next = replay(bar(3_600, 100, 90, 110), { delta: -0.03, gamma: 0.01 });
  assert.ok(next.hedgeTrades.length <= 2);
});

test("the second trade uses the recalculated limit, not the original opposite limit", () => {
  const replay = createHedgeReplay({ plan, config });
  replay(bar(0), { delta: 0, gamma: 0 });
  const row = replay(bar(3_600, 100, 90, 110), { delta: 0.02, gamma: 0.01 });
  near(row.hedgeTrades[0].price, 103);
  near(row.hedgeTrades[1].price, 98); // Original lower limit was 93.
  near(row.hedgeTrades[1].quantity, 0.05);
});

test("entry neutralizes opening delta and a breached gap hedges at the observed opening price", () => {
  const replay = createHedgeReplay({ plan, config, intrabarPath: "high_first" });
  const entry = replay(bar(0), { delta: 0.02, gamma: 0.001 });
  near(entry.hedgeQuantity, -0.02);
  assert.equal(entry.hedgeTrade.reason, "entry");
  const gap = replay(bar(3_600, 120, 120, 120), { delta: 0.12, gamma: 0.001 });
  near(gap.hedgeTrade.price, 120);
  near(gap.hedgeTrade.quantity, 0.1);
  near(gap.hedgePnlUsd, -0.4);
});

test("tolerance scales with position size while trigger prices stay the same", () => {
  const results = [1, 10].map(size => {
    const replay = createHedgeReplay({ plan: { ...plan, optionQuantityBtc: size }, config, intrabarPath: "high_first" });
    const opening = replay(bar(0, 100, 99, 110), { delta: 0.02 * size, gamma: 0.01 * size });
    const exit = replay(bar(7_200, 102), {});
    return { opening, exit };
  });
  near(results[0].opening.hedgeTrades[1].price, results[1].opening.hedgeTrades[1].price);
  near(results[1].exit.hedgePnlUsd, results[0].exit.hedgePnlUsd * 10);
});

test("inside tolerance, zero gamma, and missing risk do not invent intrabar fills", () => {
  for (const gamma of [0, 0.001, Number.NaN]) {
    const replay = createHedgeReplay({ plan, config, intrabarPath: "high_first" });
    const row = replay(bar(0), { delta: 0, gamma });
    assert.equal(row.hedgeTrades.length, 0);
  }
  const replay = createHedgeReplay({ plan, config, intrabarPath: "high_first" });
  const missing = replay(bar(0, 100, 90, 110), {});
  assert.equal(missing.missingHedgeRisk, true);
  assert.equal(missing.hedgeTrades.length, 0);
});

test("missing ranges and gaps are visible and exit never uses the following hour's extremes", () => {
  const replay = createHedgeReplay({ plan, config, intrabarPath: "high_first" });
  const entry = replay({ ts: 0, indexPrice: 100 }, { delta: 0.02, gamma: 0.01 });
  assert.equal(entry.missingHedgeRange, true);
  const exit = replay(bar(7_200, 100, 1, 200), {});
  assert.equal(exit.dataGap, true);
  assert.equal(exit.ambiguousHedgeBar, false);
  assert.equal(exit.hedgeTrades.length, 1);
  assert.equal(exit.hedgeTrades[0].intrabar, false);
});

test("time mode keeps its schedule and disabled hedging never trades", () => {
  const replay = createHedgeReplay({ plan, config: { ...config, hedgeMode: "time", hedgeIntervalHours: 2 } });
  near(replay(bar(0), { delta: 0.2 }).hedgeQuantity, -0.2);
  const middle = replay(bar(3_600, 105), { delta: 0.8 });
  near(middle.hedgeQuantity, -0.2);
  assert.equal(middle.hedgeTrades.length, 0);
  near(replay(bar(7_200, 110), {}).hedgePnlUsd, -2);
  const disabled = createHedgeReplay({ plan, config: { ...config, hedgeEnabled: false } });
  assert.equal(disabled(bar(0, 100, 1, 200), { delta: 1, gamma: 1 }).hedgeTrades.length, 0);
});
