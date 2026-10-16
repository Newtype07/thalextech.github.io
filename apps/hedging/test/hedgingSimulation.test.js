import test from "node:test";
import assert from "node:assert/strict";
import { buildHedgingSimulation, HEDGE_TRADING_COST_RATE } from "../src/hedgingSimulation.js";

const close = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

function simulate(settings = {}) {
  const prices = [100, 130, 80, 80];
  return buildHedgingSimulation({
    indexRows: prices.map((price, i) => ({ ts: 1000 + i, index_price_open: price, index_price_close: price })),
    targets: [{
      instrument: { type_normalized: "option", option_type_normalized: "call", strike: 100, expiration_ts: 31537000 },
      rows: prices.map((price, i) => ({ ts: 1000 + i, mark_price_close: price / 10, iv_open: 0.6, iv_close: 0.6 })),
    }],
    hedgeRows: prices.map((price, i) => ({ ts: 1000 + i, mark_price_close: price })),
    hedge: { type_normalized: "perpetual" },
    settings: { targetAmount: 1, threshold: 0.001, tolerance: 0.01, period: 0, ...settings },
  });
}

for (const targetAmount of [1, -1, 3]) {
  test(`costs accumulate on actual adjustments for position ${targetAmount}`, () => {
    const gross = simulate({ targetAmount });
    const net = simulate({ targetAmount, tradingCostRate: HEDGE_TRADING_COST_RATE });
    assert.equal(net.trades.length, 3);
    assert.ok(net.trades.some(trade => trade.tradeAmount > 0));
    assert.ok(net.trades.some(trade => trade.tradeAmount < 0));
    let costs = 0;
    for (let i = 0; i < net.rows.length; i++) {
      const row = net.rows[i];
      costs += Math.abs(row.tradeAmount * row.hedgePrice) * 0.00015;
      close(row.cumulativeTradingCosts, costs);
      close(row.pnlAfterCosts, row.cumulativePnl - costs);
      close(row.cumulativePnl, gross.rows[i].cumulativePnl);
      close(row.position, gross.rows[i].position);
    }
    assert.ok(net.rows[0].pnlAfterCosts < 0, "initial hedge incurs costs immediately");
    close(net.rows[3].cumulativeTradingCosts, net.rows[2].cumulativeTradingCosts);
    for (const trade of net.trades) close(trade.tradingCost, Math.abs(trade.tradeAmount * trade.hedgePrice) * 0.00015);
  });
}

test("disabled costs preserve gross P&L", () => {
  for (const row of simulate().rows) {
    assert.equal(row.cumulativeTradingCosts, 0);
    assert.equal(row.pnlAfterCosts, row.cumulativePnl);
  }
});

test("no hedge adjustments incur no costs", () => {
  const result = simulate({ threshold: 2, tolerance: 0, tradingCostRate: HEDGE_TRADING_COST_RATE });
  assert.equal(result.trades.length, 0);
  for (const row of result.rows) {
    assert.equal(row.cumulativeTradingCosts, 0);
    assert.equal(row.pnlAfterCosts, row.cumulativePnl);
  }
});
