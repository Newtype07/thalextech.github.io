const PERIOD_PNL_FIELDS = ["PL", "delta_PL", "gamma_theta_PL", "vega_PL", "vanna_PL", "charm_PL", "vomma_PL", "residual_PL", "hedge_PL"];

// Never merge entry/exit observations with history outside the trade.
export function tradeChartResolution(rows, seconds, range) {
  if (!Array.isArray(range)) return chartResolution(rows, seconds);
  return [
    rows.filter(row => row.ts < range[0]),
    rows.filter(row => row.ts >= range[0] && row.ts <= range[1]),
    rows.filter(row => row.ts > range[1]),
  ].flatMap(segment => chartResolution(segment, seconds));
}

// Aggregate only after minute-level accounting. Cumulative values and state
// come from the bucket's final observation; period P&L is summed, never rerun.
export function chartResolution(rows, seconds) {
  if (seconds <= 60 || rows.length < 2) return rows;
  const result = [rows[0]];
  let bucket = null, last = null, sums = {}, valid = {};
  const finish = () => {
    if (!last) return;
    const point = { ...last };
    for (const field of PERIOD_PNL_FIELDS) if (field in point) point[field] = valid[field] && Number.isFinite(sums[field]) ? sums[field] : null;
    result.push(point);
  };
  for (const row of rows.slice(1)) {
    const key = Math.floor(row.ts / seconds);
    if (key !== bucket) { finish(); bucket = key; sums = {}; valid = {}; }
    for (const field of PERIOD_PNL_FIELDS) {
      if (Number.isFinite(row[field])) { sums[field] = (sums[field] ?? 0) + row[field]; valid[field] = true; }
      else if (field in row) { sums[field] = NaN; }
    }
    last = row;
  }
  finish();
  return result;
}
