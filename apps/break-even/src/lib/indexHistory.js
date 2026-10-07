// Thalex returns the most recent rows in a requested window. Page backwards
// using the oldest returned timestamp, keeping each request at the former cap.
const REQUEST_POINT_LIMIT = 1440;

export async function fetchIndexHistoryInChunks(params, fetchChunk) {
  const byTimestamp = new Map();
  let to = params.to;
  while (to >= params.from && byTimestamp.size < params.count) {
    const rows = await fetchChunk({
      ...params,
      to,
      count: Math.min(REQUEST_POINT_LIMIT, params.count - byTimestamp.size),
    });
    const validRows = rows.filter(row => Number.isFinite(row?.ts) &&
      row.ts >= params.from && row.ts <= to);
    if (!validRows.length) break;
    for (const row of validRows) byTimestamp.set(row.ts, row);
    to = Math.min(...validRows.map(row => row.ts)) - 1;
  }
  return [...byTimestamp.values()].sort((a, b) => a.ts - b.ts);
}
