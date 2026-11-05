import test from "node:test";
import assert from "node:assert/strict";
import { applyDeltaHedge, comboHedgeObservations, summarizeComboHedge } from "./delta-hedging.js";
import { replayDeltaHedge } from "../../../lib/delta-hedging/index.js";
const rows = [100, 80, 110].map((price, i) => ({ ts: i * 60, index_price_open: 1,
  index_price_close: price, combined_delta: [.5, .2, .6][i], mark_price_close: [10, 5, 12][i], PL: i === 0 ? 0 : 2 }));
test("historical close delta fills at the close and agrees with the common engine", () => {
  const policy = { threshold: .05, tolerance: .15, hedgeBps: 1.5, exit: "hold" };
  const result = applyDeltaHedge(rows, policy, 60);
  const common = replayDeltaHedge(comboHedgeObservations(rows, 60), policy, { observationSeconds: 60 });
  assert.equal(result[0].hedge_fill.price, 100);
  assert.equal(result[0].hedge_fill.time, 60);
  assert.deepEqual(result.map(row => ({ amount: Number(row.hedge_fill.amount.toFixed(12)),
    price: row.hedge_fill.price, time: row.hedge_fill.time })), [
    { amount: -.5, price: 100, time: 60 },
    { amount: .3, price: 80, time: 120 },
    { amount: -.4, price: 110, time: 180 },
  ], "trade markers can distinguish buys and sells using actual closing fills");
  assert.equal(result.at(-1).hedge_cumulative_PL, common.rows.at(-1).netPnl);
  for (const row of result) assert.ok(Math.abs(row.hedge_realized_cumulative + row.hedge_unrealized - row.hedge_cumulative_PL) < 1e-8);
  assert.equal(rows[0].PL, 0);
});
test("missing portfolio delta stays missing and cannot open a fabricated zero-delta hedge", () => {
  const result = applyDeltaHedge([{ ...rows[0], combined_delta: null }, rows[1]], {}, 60);
  assert.equal(result[0].hedge_fill, null);
  assert.equal(result[0].hedge_quality.missingRisk, true);
});

test("brushing into a V starts a fresh hedge ledger at entry and exits inside the selected window", () => {
  const history = [100, 80, 90, 110, 120].map((price, i) => ({ ts: i * 60,
    index_price_close: price, combined_delta: [.8, .2, .3, .5, .7][i],
    mark_price_close: [10, 5, 7, 12, 15][i], PL: 10, delta_PL: 8 }));
  const policy = { threshold: .05, tolerance: .15, hedgeBps: 1, exit: "unwind" };
  const result = applyDeltaHedge(history, policy, 60, [60, 180]);
  const selected = result.slice(1, 4);
  assert.equal(result[0].hedge_fill, undefined, "pre-entry history cannot trade");
  assert.equal(result[4].hedge_fill, undefined, "post-exit history cannot trade");
  assert.equal(selected[0].hedge_fill.reason, "entry");
  assert.equal(selected[0].hedge_fill.time, 120, "entry executes on the selected minute's close");
  assert.equal(selected[0].hedge_fill.price, 80);
  assert.equal(selected[0].hedge_fill.amount, -.2, "neutralizes from zero, not the preceding hedge");
  assert.equal(selected[0].hedge_cumulative_PL, -.0016, "only the new entry fee is charged");
  assert.equal(selected[0].PL, selected[0].hedge_PL, "no pre-entry option interval is carried in");
  assert.equal(selected[0].delta_PL, 0);
  assert.equal(selected.at(-1).hedge_fill.reason, "exit");
  assert.equal(selected.at(-1).hedge_fill.time, 240);
  assert.equal(selected.at(-1).hedge_ratio, 0);
  const fresh = applyDeltaHedge(history.slice(1, 4), policy, 60);
  assert.deepEqual(selected, fresh, "the selected trade is exactly an independent replay");
  assert.equal(history[1].PL, 10, "source history remains reusable when entry changes");
  const moved = applyDeltaHedge(history, policy, 60, [120, 240]);
  assert.equal(moved[1].hedge_fill, undefined);
  assert.equal(moved[2].hedge_fill.reason, "entry");
  assert.equal(moved[2].hedge_fill.amount, -.3);
});

test("threshold timing starts afresh at trade entry", () => {
  const history = [0, 60, 120, 180, 240, 300].map((ts, i) => ({ ts,
    index_price_close: 100, combined_delta: [.1, .2, .3, .5, .5, .5][i], mark_price_close: 10, PL: 0 }));
  const result = applyDeltaHedge(history, { threshold: .1, tolerance: 0, period: 120, exit: "hold" }, 60, [120, 300]);
  assert.deepEqual(result.flatMap(row => row.hedge_fill ? [[row.ts, row.hedge_fill.reason]] : []),
    [[120, "entry"], [300, "timer"]]);
});

test("trade summary separates hedge trading P&L, modeled execution costs and option P&L", () => {
  const hedged = applyDeltaHedge(rows, { threshold: .05, tolerance: .15, hedgeBps: 1.5, exit: "hold" }, 60);
  const summary = summarizeComboHedge(hedged);
  assert.equal(summary.optionPnl, 2);
  assert.equal(summary.grossHedgePnl, 4);
  assert.ok(Math.abs(summary.executionCosts - .0177) < 1e-10);
  assert.ok(Math.abs(summary.hedgePnl - (4 - .0177)) < 1e-10);
  assert.equal(summary.totalPnl, summary.optionPnl + summary.hedgePnl);
  assert.deepEqual(summary.triggers, { period: 0, tolerance: 2, entry: 1, exit: 0, other: 0 });
  assert.equal(summary.fills, 3);
});

test("period and tolerance counts exclude entry and unwind, and follow the selected trade", () => {
  const history = [100, 90, 80, 110, 105].map((price, i) => ({ ts: i * 60,
    index_price_close: price, combined_delta: [.5, .6, .6, .9, .9][i],
    mark_price_close: [10, 9, 8, 12, 11][i], PL: 0 }));
  const policy = { threshold: .05, tolerance: .2, period: 60, hedgeBps: 1, exit: "unwind" };
  const all = summarizeComboHedge(applyDeltaHedge(history, policy, 60));
  assert.deepEqual(all.triggers, { period: 1, tolerance: 1, entry: 1, exit: 1, other: 0 });
  assert.equal(all.fills, 4);
  const selected = summarizeComboHedge(applyDeltaHedge(history, policy, 60, [60, 180]).slice(1, 4));
  assert.deepEqual(selected.triggers, { period: 0, tolerance: 0, entry: 1, exit: 1, other: 0 });
  assert.equal(selected.optionPnl, 3);
  assert.equal(selected.fills, 2);
});

test("summary does not invent P&L when entry or terminal marks are missing", () => {
  assert.equal(summarizeComboHedge([]), null);
  const summary = summarizeComboHedge([{ mark_price_close: 10 }, { mark_price_close: null, hedge_cumulative_PL: null }]);
  assert.equal(summary.optionPnl, null);
  assert.equal(summary.hedgePnl, null);
  assert.equal(summary.totalPnl, null);
  assert.equal(summary.executionCosts, null);
  assert.equal(summary.fills, 0);
});
