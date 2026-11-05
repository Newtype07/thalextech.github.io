import test from "node:test";
import assert from "node:assert/strict";
import { applyDeltaHedge } from "./delta-hedging.js";
import { chartResolution, tradeChartResolution } from "./chart-resolution.js";
import { snapTradeWindow, tradeWindowRows } from "./trade-window.js";

test("coarsening the chart preserves minute fills, fees and terminal P&L through a V-shaped move", () => {
  const rows = [100, 80, 100, 120, 100].map((price, i) => ({ ts: i * 60,
    date: new Date(i * 60000), index_price_close: price, combined_delta: [.5, .8, .5, .2, .5][i],
    mark_price_close: [10, 5, 10, 15, 10][i], PL: i ? 1 : 0 }));
  const minute = applyDeltaHedge(rows, { threshold: .05, tolerance: .1, period: 1800, hedgeBps: 1, exit: "hold" }, 60);
  const fills = minute.flatMap(row => row.hedge_fill ? [row.hedge_fill] : []);
  assert.equal(fills.length, 5, "the transient V-shaped move produces fills hidden by coarse endpoints");
  for (const seconds of [60, 300, 900, 3600, 86400]) {
    const chart = chartResolution(minute, seconds);
    assert.equal(chart.at(-1).hedge_cumulative_PL, minute.at(-1).hedge_cumulative_PL);
    assert.equal(chart.at(-1).hedge_fees, minute.at(-1).hedge_fees);
    assert.ok(Math.abs(chart.reduce((sum, row) => sum + row.hedge_PL, 0) - minute.at(-1).hedge_cumulative_PL) < 1e-10);
    assert.equal(chart[0].ts, 0);
    assert.equal(chart.at(-1).ts, 240);
    assert.deepEqual(minute.flatMap(row => row.hedge_fill ? [row.hedge_fill] : []), fills);
  }
  assert.equal(chartResolution(minute, 900).length, 2);
});

test("trade boundaries snap to minute observations and survive coarse chart buckets", () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ ts: i * 60, index_price_close: 100 + i,
    mark_price_close: 10 + i, combined_delta: .5, PL: 1 }));
  const range = snapTradeWindow(rows, [241, 839]);
  assert.deepEqual(range, [300, 780]);
  assert.deepEqual(snapTradeWindow(rows, [839, 241]), range);
  assert.equal(snapTradeWindow(rows, null), null);
  const minute = applyDeltaHedge(rows, { exit: "unwind" }, 60, range);
  const trade = tradeWindowRows(minute, range);
  for (const seconds of [60, 300, 900, 3600, 86400]) {
    const chart = tradeChartResolution(minute, seconds, range);
    const displayedTrade = tradeWindowRows(chart, range);
    assert.equal(displayedTrade[0].ts, range[0]);
    assert.equal(displayedTrade.at(-1).ts, range[1]);
    assert.equal(displayedTrade[0].hedge_fill.reason, "entry");
    assert.equal(displayedTrade.at(-1).hedge_fill.reason, "exit");
    assert.equal(displayedTrade.at(-1).hedge_cumulative_PL, trade.at(-1).hedge_cumulative_PL);
    assert.equal(displayedTrade.at(-1).hedge_fees, trade.at(-1).hedge_fees);
    assert.equal(displayedTrade.reduce((sum, row) => sum + row.PL, 0), trade.reduce((sum, row) => sum + row.PL, 0),
      "chart buckets cannot include P&L from before entry or after exit");
  }
});
