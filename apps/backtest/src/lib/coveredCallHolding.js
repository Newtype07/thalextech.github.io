// Allocate a single buy-and-hold position across reporting cycles. Calls keep
// their own entry/exit dates; holding windows also include the uncovered gaps.
export const assignCoveredCallHolding = (plans, indexRows, start, end) => {
  if (!plans.length) return plans;
  const rows = indexRows.filter(row => row.ts >= start.getTime() / 1000
    && row.ts <= end.getTime() / 1000 && Number.isFinite(row.indexPrice))
    .sort((a, b) => a.ts - b.ts);
  if (!rows.length) return plans;
  const initial = rows[0];
  const prices = new Map(rows.map(row => [row.ts, row.indexPrice]));
  return plans.map((plan, index) => {
    const holdingStartTs = index ? plans[index - 1].exitTs : initial.ts;
    const holdingEndTs = index === plans.length - 1 ? rows.at(-1).ts : plan.exitTs;
    return {
      ...plan,
      underlyingQuantity: 1,
      holdingStartTs,
      holdingEndTs,
      holdingStartPrice: prices.get(holdingStartTs),
      holdingEndPrice: prices.get(holdingEndTs),
      initialInvestmentUsd: initial.indexPrice,
      investmentUsd: initial.indexPrice,
      underlyingFirstEntry: index === 0,
    };
  });
};

export const extendCoveredCallDetail = (activeRows, plan, indexRows) => {
  if (!activeRows.length || !Number.isFinite(plan.holdingStartTs)) return activeRows;
  const activeByTs = new Map(activeRows.map(row => [row.ts, row]));
  const first = activeRows[0];
  const last = activeRows.at(-1);
  const beforePnl = plan.entryIndexPrice - plan.holdingStartPrice;
  return indexRows.filter(row => row.ts >= plan.holdingStartTs && row.ts <= plan.holdingEndTs)
    .sort((a, b) => a.ts - b.ts)
    .map(({ ts, indexPrice }) => {
      const active = activeByTs.get(ts);
      const before = ts < plan.entryTs;
      const base = active || (before ? first : last);
      const optionPnlUsd = before ? 0 : base.optionPnlUsd;
      const hedgePnlUsd = indexPrice - plan.holdingStartPrice;
      const additionalDelta = before ? hedgePnlUsd : active ? beforePnl
        : beforePnl + indexPrice - last.indexPrice;
      return {
        ...base, ts, dateTime: new Date(ts * 1000), indexPrice,
        optionPnlUsd, hedgePnlUsd,
        totalPnlUsd: optionPnlUsd + hedgePnlUsd,
        cumulativeNetDeltaMtmUsd: (before ? 0 : base.cumulativeNetDeltaMtmUsd) + additionalDelta,
        hedgeQuantity: 1,
        hedgeTrade: plan.underlyingFirstEntry && ts === plan.holdingStartTs
          ? { side: 'buy', quantity: 1, price: indexPrice } : null,
        ...(active ? {} : { legMarks: [], combinedMark: Number.NaN }),
      };
    });
};
