// Trade boundaries use the underlying minute observations, never chart buckets.
export function tradeWindowRows(rows, range) {
  if (!Array.isArray(range)) return rows;
  return rows.filter(row => row.ts >= range[0] && row.ts <= range[1]);
}

export function snapTradeWindow(rows, range) {
  if (!Array.isArray(range)) return null;
  const [from, to] = range.map(Number).sort((a, b) => a - b);
  const selected = tradeWindowRows(rows, [from, to]);
  return selected.length ? [selected[0].ts, selected.at(-1).ts] : null;
}
