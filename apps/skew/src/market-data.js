// Thalex's external contracts end here. Chart/domain code only sees normalized quotes.
import { fetchStreamSnapshot, normalizeTicker } from "./live-quotes.js";
import {
  loadHistoryCache,
  missingHourRanges,
  historySnapshot,
} from "./history-cache.js";
import { requestThalex as request, THALEX_WS_URL } from "./thalex-rest.js";
export const HISTORY_LIMIT = 2000;
export const HOUR = 3600;

async function pool(items, concurrency, work, signal) {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (cursor < items.length) {
        signal?.throwIfAborted();
        await work(items[cursor++]);
      }
    }),
  );
}

export async function fetchOptionChain(asset, signal) {
  const rows = await request("instruments", {}, signal);
  if (!Array.isArray(rows)) throw new Error("Invalid instruments response");
  const now = Date.now() / 1000;
  return rows
    .filter(
      (i) =>
        i.type === "option" &&
        i.underlying === `${asset}USD` &&
        i.expiration_timestamp > now,
    )
    .map((i) => ({
      name: i.instrument_name,
      expiry: i.expiration_timestamp,
      strike: i.strike_price,
      side: i.option_type === "call" ? "C" : "P",
      listedAt: Number.isFinite(i.create_time)
        ? Math.floor(i.create_time / HOUR) * HOUR
        : null,
    }));
}

export async function fetchLiveQuotes(
  chain,
  {
    signal,
    onProgress = () => {},
    onQuotes = () => {},
    WebSocketImpl = typeof window !== "undefined" ? globalThis.WebSocket : null,
    streamTimeoutMs = 8000,
  } = {},
) {
  let quotes = [];
  const failures = [];
  const unavailable = new Map();
  let rateLimitWarning = null;
  try {
    quotes = await fetchStreamSnapshot(chain, {
      url: THALEX_WS_URL,
      WebSocketImpl,
      signal,
      timeoutMs: streamTimeoutMs,
      onUnavailable: (name, error) => unavailable.set(name, error.message),
      onQuotes: (rows) => {
        onQuotes(rows);
        onProgress(rows.length, chain.length);
      },
    });
  } catch {
    signal?.throwIfAborted();
  }
  const streamed = new Set(quotes.map((q) => q.name));
  for (const name of streamed) unavailable.delete(name);
  for (const [name, message] of unavailable) failures.push(`${name}: ${message}`);
  let done = quotes.length + unavailable.size;
  onProgress(done, chain.length);
  await pool(
    chain
      .filter((i) => !streamed.has(i.name) && !unavailable.has(i.name))
      .sort((a, b) => a.expiry - b.expiry || a.strike - b.strike),
    8,
    async (instrument) => {
      try {
        const ticker = await request(
          "ticker",
          { instrument_name: instrument.name },
          signal,
        );
        quotes.push(normalizeTicker(instrument, ticker));
        onQuotes([...quotes]);
      } catch (error) {
        signal?.throwIfAborted();
        if (error.isRateLimit) rateLimitWarning = error.message;
        failures.push(`${instrument.name}: ${error.message}`);
      }
      onProgress(++done, chain.length);
    },
    signal,
  );
  return {
    quotes,
    failures,
    rateLimitWarning,
    transport:
      streamed.size + unavailable.size === chain.length
        ? "websocket"
        : streamed.size
          ? "mixed"
          : "rest",
  };
}

// API responses can be shorter than count. Page backwards until the requested window is covered.
async function historyRows(endpoint, field, params, signal) {
  const rows = new Map();
  let to = params.to;
  while (to >= params.from) {
    const result = await request(
      endpoint,
      {
        ...params,
        // Missing-hour ranges are inclusive internally; Thalex's `to` is
        // exclusive. Ending at HH:59:59 drops that entire hourly candle.
        to: to + 1,
        count: Math.min(
          HISTORY_LIMIT,
          Math.ceil((to - params.from + 1) / HOUR),
        ),
      },
      signal,
    );
    if (result.no_data === true && result[field] === undefined) break;
    // The production API also returns an empty result object for a genuine
    // missing hour (confirmed against the 2026-10-21 09:00 UTC index outage).
    if (
      typeof result === "object" &&
      !Array.isArray(result) &&
      Object.keys(result).length === 0
    )
      break;
    // Missing option hours may carry only the instrument metadata.
    if (
      field === "mark" &&
      result.instrument_type === "option" &&
      Object.keys(result).length === 1
    )
      break;
    if (!Array.isArray(result[field]))
      throw new Error(`Invalid ${field} history response`);
    const page = result[field];
    if (!page.length) break;
    let earliest = Infinity;
    for (const row of page) {
      if (!Array.isArray(row) || !Number.isFinite(row[0]))
        throw new Error(`Invalid ${field} history row`);
      earliest = Math.min(earliest, row[0]);
      if (row[0] >= params.from && row[0] <= params.to) rows.set(row[0], row);
    }
    if (earliest <= params.from) break;
    if (earliest > to) throw new Error("History pagination made no progress");
    to = earliest - 1;
  }
  return [...rows.values()].sort((a, b) => a[0] - b[0]);
}

export async function fetchHistoricalQuotes(
  chain,
  asset,
  {
    signal,
    onProgress = () => {},
    onIndex = () => {},
    onUpdate,
    onActivity = () => {},
    asOf = Date.now() / 1000,
    archive,
  } = {},
) {
  const end = Math.floor(asOf / HOUR) * HOUR;
  const to = end - 1,
    from = end - HISTORY_LIMIT * HOUR;
  // Index closes are delta inputs; skew needs no longer RV window.
  const indexFrom = from;
  const expiries = [...new Set(chain.map((i) => i.expiry))];
  const snapshot = (cache) =>
    historySnapshot(cache, { from, end, indexFrom, expiries });
  const publish = (cache) => {
    signal?.throwIfAborted();
    if (onUpdate) onUpdate(snapshot(cache));
  };
  const cache =
    archive || (await loadHistoryCache(asset, expiries, signal, publish));
  publish(cache);
  // The immutable Parquet boundaries survive session additions. A failed request
  // must not move the boundary forward and hide a hole on the next refresh.
  const updateFrom = Math.max(from, cache.sourceThrough?.marks ?? from);
  const indexUpdateFrom = Math.max(
    indexFrom,
    cache.sourceThrough?.index ?? indexFrom,
  );
  const params = { resolution: "1h" };
  let apiIndexRows = 0,
    apiMarkRows = 0,
    completedChecks = 0,
    completedExpiries = 0;
  const cachedIndexRows = cache.index.size;
  const cachedMarkRows = [...cache.marks.values()].reduce(
    (n, i) => n + i.rows.size,
    0,
  );
  const activeChecks = new Map();
  const reportActivity = (stage) => onActivity({
    stage,
    active: [...activeChecks.values()],
    completedChecks,
    completedExpiries,
    totalExpiries: expiries.length,
    coverage: { cachedIndexRows, cachedMarkRows, apiIndexRows, apiMarkRows },
  });
  reportActivity("index");
  for (const range of missingHourRanges(
    indexUpdateFrom,
    to,
    cache.index,
    cache.checkedIndex,
  )) {
    activeChecks.set("index", { name: `${asset}USD index`, ...range });
    reportActivity("index");
    const rows = await historyRows(
      "index_price_historical_data",
      "index",
      { ...params, ...range, index_name: `${asset}USD` },
      signal,
    );
    for (const row of rows) {
      if (
        row.length >= 5 &&
        row.slice(0, 5).every(Number.isFinite) &&
        row.slice(1, 5).every((v) => v > 0)
      ) {
        cache.index.set(row[0], row.slice(0, 5));
        apiIndexRows++;
      }
    }
    cache.checkedIndex.push({ ...range, expires: Date.now() + 60000 });
    activeChecks.delete("index");
    completedChecks++;
    reportActivity("index");
    publish(cache);
  }
  const index = [...cache.index.values()]
    .filter((r) => r[0] >= indexFrom && r[0] < end)
    .sort((a, b) => a[0] - b[0]);
  if (!index.length)
    throw new Error("No matching hourly index history returned");
  const indexBars = index.map(([ts, open, high, low, close]) => ({
    ts,
    open,
    high,
    low,
    close,
  }));
  onIndex(indexBars);
  const spots = new Map(index.map((r) => [r[0], r[4]]));
  const failures = [];
  let rateLimitWarning = null;
  let done = 0;
  reportActivity("marks");
  const byExpiry = new Map(
    expiries.map((expiry) => [
      expiry,
      chain.filter((i) => i.expiry === expiry),
    ]),
  );
  await pool(
    [...byExpiry.values()],
    2,
    async (instruments) => {
      // Both wings are required at every delta. Fetch the same full ladder once,
      // then reuse it when switching between 15, 25 and 35 delta.
      const checkedAt = Date.now();
      const plan = instruments.map((instrument) => ({
        instrument,
        hours: new Set([...spots.keys()].filter((ts) =>
          ts >= Math.max(updateFrom, instrument.listedAt ?? updateFrom) && ts <= to)),
      }));
      const requests = plan.flatMap(({ instrument, hours }) => {
        const stored = cache.marks.get(instrument.name);
        const checked = cache.checked.get(instrument.name) || [];
        const missing = [...hours].filter(
          (ts) =>
            !stored?.rows.has(ts) &&
            !checked.some(
              (r) =>
                ts >= r.from &&
                ts <= r.to &&
                (r.expires == null || r.expires > checkedAt),
            ),
        );
        if (!missing.length) return [];
        // One bounded envelope per instrument avoids a separate request whenever
        // spot crosses back and forth between strikes. Extra returned hours are reusable.
        return [
          {
            instrument,
            from: Math.min(...missing),
            to: Math.max(...missing) + HOUR - 1,
          },
        ];
      });
      await pool(
        requests,
        4,
        async ({ instrument, from, to }) => {
          activeChecks.set(instrument.name, { name: instrument.name, from, to });
          reportActivity("marks");
          try {
            if (!cache.marks.has(instrument.name))
              cache.marks.set(instrument.name, {
                ...instrument,
                rows: new Map(),
              });
            const stored = cache.marks.get(instrument.name);
            const rows = await historyRows(
              "mark_price_historical_data",
              "mark",
              { ...params, from, to, instrument_name: instrument.name },
              signal,
            );
            for (const row of rows) {
              if (Number.isFinite(row[8]) && row[8] > 0) {
                stored.rows.set(row[0], row[8]);
                apiMarkRows++;
              }
            }
            if (!cache.checked.has(instrument.name))
              cache.checked.set(instrument.name, []);
            cache.checked
              .get(instrument.name)
              .push({ from, to, expires: Date.now() + 60000 });
          } catch (error) {
            signal?.throwIfAborted();
            // Failed ranges remain retryable on refresh.
            if (error.isRateLimit) rateLimitWarning = error.message;
            failures.push(`${instrument.name}: ${error.message}`);
          } finally {
            activeChecks.delete(instrument.name);
            completedChecks++;
            if (!signal?.aborted) reportActivity("marks");
          }
        },
        signal,
      );
      onProgress((done += instruments.length), chain.length);
      publish(cache);
      completedExpiries++;
      reportActivity("marks");
    },
    signal,
  );
  const { quotes } = snapshot(cache);
  publish(cache);
  reportActivity("complete");
  return {
    quotes,
    indexBars,
    failures,
    warning: cache.warning,
    rateLimitWarning,
    coverage: { cachedIndexRows, cachedMarkRows, apiIndexRows, apiMarkRows },
  };
}
