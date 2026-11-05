import { replayDeltaHedge } from "../../../lib/delta-hedging/index.js";
import { tradeWindowRows } from "./trade-window.js";

// Closing risk becomes available at the end of the bar. Never fill it at the open.
export function comboHedgeObservations(rows, intervalSeconds) {
  const entry = rows[0]?.mark_price_close;
  return rows.map(row => ({ time: row.ts + intervalSeconds,
    price: Number.isFinite(row.index_price_close) ? row.index_price_close : null,
    delta: Number.isFinite(row.combined_delta) ? row.combined_delta : null,
    positionPnl: Number.isFinite(entry) && Number.isFinite(row.mark_price_close) ? row.mark_price_close - entry : NaN,
  }));
}

export function applyDeltaHedge(rows, policy, intervalSeconds, tradeRange = null) {
  const selected = tradeWindowRows(rows, tradeRange);
  const replay = replayDeltaHedge(comboHedgeObservations(selected, intervalSeconds), policy, { observationSeconds: intervalSeconds });
  let previous = 0;
  const hedged = new Map(replay.rows.map((hedge, i) => {
    const original = { ...selected[i] };
    // The first quote is the entry valuation, not an interval held before entry.
    if (i === 0) for (const key of ["PL", "delta_PL", "gamma_theta_PL", "vega_PL", "vanna_PL", "charm_PL", "vomma_PL", "residual_PL"])
      if (key in original) original[key] = 0;
    const periodPnl = hedge.netPnl === null ? null : hedge.netPnl - previous;
    if (hedge.netPnl !== null) previous = hedge.netPnl;
    return [original.ts, { ...original, hedge_PL: periodPnl, hedge_cumulative_PL: hedge.netPnl,
      hedge_gross_cumulative_PL: hedge.grossPnl, hedge_fees: hedge.fees,
      hedge_realized_cumulative: hedge.realized - hedge.fees, hedge_unrealized: hedge.unrealized,
      hedged_mark_price_close: Number.isFinite(original.mark_price_close) && hedge.netPnl !== null
        ? original.mark_price_close + hedge.netPnl : null,
      hedge_ratio: hedge.position, hedge_rehedge: !!hedge.fill,
      hedge_fill: hedge.fill, hedge_quality: { gap: hedge.gap, missingRisk: hedge.missingRisk, missingPrice: hedge.missingPrice },
      PL: Number.isFinite(original.PL) && periodPnl !== null ? original.PL + periodPnl : null,
    }];
  }));
  // Keep the full price history for context; it owns no hedge outside this trade.
  return rows.map(row => hedged.get(row.ts) ?? row);
}

// Summarize the selected minute replay, before any chart resampling. The legacy
// hedge_fees field holds the modeled execution-cost deduction, not actual fees.
export function summarizeComboHedge(rows) {
  if (!rows.length) return null;
  const first = rows[0], last = rows.at(-1);
  const optionPnl = Number.isFinite(first.mark_price_close) && Number.isFinite(last.mark_price_close)
    ? last.mark_price_close - first.mark_price_close : null;
  const hedgePnl = Number.isFinite(last.hedge_cumulative_PL) ? last.hedge_cumulative_PL : null;
  const grossHedgePnl = Number.isFinite(last.hedge_gross_cumulative_PL) ? last.hedge_gross_cumulative_PL : null;
  const executionCosts = Number.isFinite(last.hedge_fees) ? last.hedge_fees : null;
  const triggers = { period: 0, tolerance: 0, entry: 0, exit: 0, other: 0 };
  for (const row of rows) {
    if (!row.hedge_fill) continue;
    const reason = row.hedge_fill.reason;
    const key = reason === "timer" || reason === "scheduled" ? "period" : reason;
    triggers[Object.hasOwn(triggers, key) ? key : "other"]++;
  }
  return { optionPnl, hedgePnl, grossHedgePnl, executionCosts,
    totalPnl: optionPnl !== null && hedgePnl !== null ? optionPnl + hedgePnl : null,
    triggers, fills: Object.values(triggers).reduce((sum, count) => sum + count, 0) };
}
