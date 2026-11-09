// A loader owns its bounded page cache. History providers stay outside the
// hedge engine; gaps remain gaps rather than being filled with coarse bars.
export function createMinuteHistoryLoader(fetchRows, { pageSize = 1000, ttl = 300000, maxPages = 256, concurrency = 1 } = {}) {
  const pages = new Map();
  const pending = new Map();
  const limit = Math.max(1, Math.floor(concurrency));
  let active = 0;
  const waiting = [];
  function getPage(parameters) {
    const key = JSON.stringify(parameters);
    const cached = pages.get(key);
    if (cached && Date.now() - cached.savedAt < ttl) return Promise.resolve(cached);
    if (pending.has(key)) return pending.get(key);
    const request = (async () => {
      // The budget belongs to the loader, including overlapping load calls.
      if (active >= limit) await new Promise(resolve => waiting.push(resolve));
      else active++;
      try {
        const page = { rows: await Promise.resolve().then(() => fetchRows(parameters)), savedAt: Date.now() };
        if (!Array.isArray(page.rows)) throw new Error("One-minute history is unavailable.");
        pages.set(key, page);
        if (pages.size > maxPages) pages.delete(pages.keys().next().value);
        return page;
      } finally {
        pending.delete(key);
        if (waiting.length) waiting.shift()();
        else active--;
      }
    })();
    pending.set(key, request);
    return request;
  }
  return async function load(query, isCurrent = () => true) {
    const first = Math.ceil(query.from / 60) * 60;
    const last = Math.floor(query.to / 60) * 60;
    const result = new Map();
    const span = pageSize * 60;
    let next = Math.floor(first / span) * span;
    let failed = false;
    async function worker() {
      while (next <= last && isCurrent() && !failed) {
        const start = next;
        next += span;
        // Thalex's `to` is exclusive. Adjacent pages meet at exactly the same
        // boundary so the last minute of each page is not accidentally omitted.
        const parameters = { ...query, resolution: "1m", from: start, to: Math.min(start + span, last + 60), count: pageSize };
        let page;
        try { page = await getPage(parameters); }
        catch (error) { failed = true; throw error; }
        if (!isCurrent()) return;
        for (const row of page.rows) {
          if (Number.isFinite(row?.ts) && row.ts >= first && row.ts <= last) result.set(row.ts, row);
        }
      }
    }
    await Promise.all(Array.from({ length: limit }, worker));
    if (!isCurrent()) return [];
    return [...result.values()].sort((a, b) => a.ts - b.ts);
  };
}
