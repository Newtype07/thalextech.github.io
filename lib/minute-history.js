// A loader owns its bounded page cache. History providers stay outside the
// hedge engine; gaps remain gaps rather than being filled with coarse bars.
export function createMinuteHistoryLoader(fetchRows, { pageSize = 1000, ttl = 300000, maxPages = 256 } = {}) {
  const pages = new Map();
  return async function load(query, isCurrent = () => true) {
    const first = Math.ceil(query.from / 60) * 60;
    const last = Math.floor(query.to / 60) * 60;
    const result = new Map();
    const span = pageSize * 60;
    for (let start = Math.floor(first / span) * span; start <= last; start += span) {
      if (!isCurrent()) return [];
      // Thalex's `to` is exclusive. Adjacent pages meet at exactly the same
      // boundary so the last minute of each page is not accidentally omitted.
      const parameters = { ...query, resolution: "1m", from: start, to: Math.min(start + span, last + 60), count: pageSize };
      const key = JSON.stringify(parameters);
      let page = pages.get(key);
      if (!page || Date.now() - page.savedAt >= ttl) {
        page = { rows: await fetchRows(parameters), savedAt: Date.now() };
        if (!Array.isArray(page.rows)) throw new Error("One-minute history is unavailable.");
        pages.set(key, page);
        if (pages.size > maxPages) pages.delete(pages.keys().next().value);
      }
      if (!isCurrent()) return [];
      for (const row of page.rows) {
        if (Number.isFinite(row?.ts) && row.ts >= first && row.ts <= last) result.set(row.ts, row);
      }
    }
    return [...result.values()].sort((a, b) => a.ts - b.ts);
  };
}
