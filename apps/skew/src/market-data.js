// Thalex's external contracts end here. Chart/domain code only sees normalized quotes.
import { fetchStreamSnapshot, normalizeTicker } from "./live-quotes.js";
import {
  loadHistoryCache,
  missingHourRanges,
  historySnapshot,
} from "./history-cache.js";
import { requestThalex as request, THALEX_WS_URL } from "./thalex-rest.js";
import { planSkewHistory } from "./skew-history-plan.js";
import { TENORS } from "./constant-maturity.js";
export const HISTORY_LIMIT = 2000;
export const HOUR = 3600;

// Domain-specific entry point: the REST/cache adapter owns I/O, while the pure
// planner selects the actual delta and maturity inputs required by the chart.
export function fetchSkewHistory(chain, asset, { delta = 0.25, tenors = TENORS, liveIvs = () => new Map(), ...options } = {}) {
  return fetchHistoricalQuotes(chain, asset, { ...options,
    selectionKey: `${delta}:${tenors.join(",")}`,
    planInputs: context => planSkewHistory({ ...context, delta, tenors, seedIvs: liveIvs() }),
  });
}

// Internal slots identify the last hourly bar before each requested close.
// Daily API candles are mapped back to those same close slots on ingestion.
export function planHistoryRequests(hours, known, checked, period = HOUR) {
  const missing = [...hours].filter(ts => !known.has(ts) && !checked.some(r =>
    (r.period ?? HOUR) === period && ts >= r.from && ts <= r.to && (r.expires == null || r.expires > Date.now())));
  if (!missing.length) return [];
  return [{ from: Math.min(...missing) - (period - HOUR), to: Math.max(...missing) + HOUR - 1, hours: missing }];
}

function rememberChecked(checked, range, period = HOUR) {
  const expires = Date.now() + 60000;
  if (range.hours) for (const ts of range.hours) checked.push({ from: ts, to: ts + HOUR - 1, expires, period });
  else checked.push({ from: range.from, to: range.to, expires, period });
}

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
  return normalizeInstruments(rows, asset, Date.now() / 1000);
}

function normalizeInstruments(rows, asset, after) {
  if (!Array.isArray(rows)) throw new Error("Invalid instruments response");
  return rows
    .filter(
      (i) =>
        i.type === "option" &&
        i.underlying === `${asset}USD` &&
        i.expiration_timestamp > after,
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
  } catch (error) {
    signal?.throwIfAborted();
    if (error.isRateLimit) rateLimitWarning = error.message;
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
  const period = params.resolution === "1d" ? 86400 : HOUR;
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
          Math.ceil((to - params.from + 1) / period),
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
    discoverInstruments = archive == null,
    window: samplingWindow,
    planInputs,
    selectionKey,
  } = {},
) {
  const end = Math.floor(asOf / HOUR) * HOUR;
  const to = end - 1,
    from = samplingWindow ? samplingWindow.from - HOUR : end - HISTORY_LIMIT * HOUR;
  const period = samplingWindow?.step >= 86400 ? 86400 : HOUR;
  const targetHours = samplingWindow?.timestamps.map(ts => ts - HOUR);
  // Index closes are delta inputs; skew needs no longer RV window.
  const indexFrom = from;
  const ready = cache => {
    cache.readyHours ||= new Map();
    if (!cache.readyHours.has(selectionKey)) cache.readyHours.set(selectionKey, new Set());
    return cache.readyHours.get(selectionKey);
  };
  const snapshot = (cache) => {
    const data = historySnapshot(cache, { from, end, indexFrom });
    if (planInputs) data.quotes = data.quotes.filter(q =>
      q.ts - HOUR < (cache.sourceThrough.marks ?? from) || ready(cache).has(q.ts - HOUR));
    return data;
  };
  const publish = (cache) => {
    signal?.throwIfAborted();
    if (onUpdate) onUpdate(snapshot(cache));
  };
  const cache =
    archive || (await loadHistoryCache(asset, signal, publish));
  publish(cache);
  // The immutable Parquet boundaries survive session additions. A failed request
  // must not move the boundary forward and hide a hole on the next refresh.
  const fallbackFrom = samplingWindow ? Math.max(from, end - 7 * 86400) : from;
  const updateFrom = Math.max(from, cache.sourceThrough?.marks ?? fallbackFrom);
  let discoveryWarning = samplingWindow && cache.sourceThrough?.marks == null
    ? "Parquet history unavailable; API fallback is limited to the latest week to bound requests." : "";
  if (discoverInstruments && (!targetHours || targetHours.some(ts => ts >= updateFrom))) {
    // all_instruments supports historical intervals of at most three days.
    // Discover the Parquet-to-present tail, including contracts expired today.
    let cursor = Math.max(updateFrom, cache.universeThrough ?? updateFrom);
    try {
      while (cursor < end) {
        const next = Math.min(end, cursor + 3 * 86400);
        onActivity({ stage: "instruments", active: [{ name: `${asset} option universe`, from: cursor, to: next }],
          completedExpiries: 0, totalExpiries: 0, completedChecks: 0 });
        const rows = await request("all_instruments", {
          underlying: `${asset}USD`, instrument_type: "options", time_low: cursor, time_high: next,
        }, signal);
        for (const instrument of normalizeInstruments(rows, asset, from)) {
          const stored = cache.marks.get(instrument.name);
          cache.marks.set(instrument.name, { ...stored, ...instrument, fetchable: true, rows: stored?.rows || new Map() });
        }
        cache.universeThrough = next;
        cursor = next;
      }
    } catch (error) {
      signal?.throwIfAborted();
      discoveryWarning = `Historical instrument discovery incomplete: ${error.message}. Available contracts are still used.`;
    }
  }
  // Cached expiries may be expired now but were live at a historical close.
  chain = [...new Map([
    ...[...cache.marks.values()].filter(i => i.expiry > from).map(({ rows, ...instrument }) =>
      [instrument.name, { ...instrument, fetchable: instrument.fetchable ?? false }]),
    ...chain.map(i => [i.name, { ...i, fetchable: true }]),
  ]).values()];
  const expiries = [...new Set(chain.map(i => i.expiry))];
  const indexUpdateFrom = Math.max(
    indexFrom,
    cache.sourceThrough?.index ?? fallbackFrom,
  );
  const params = { resolution: period === 86400 ? "1d" : "1h" };
  let apiIndexRows = 0,
    apiMarkRows = 0,
    completedChecks = 0,
    completedExpiries = 0;
  let totalExpiries = expiries.length;
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
    totalExpiries,
    coverage: { cachedIndexRows, cachedMarkRows, apiIndexRows, apiMarkRows },
  });
  reportActivity("index");
  const indexRanges = targetHours
    ? planHistoryRequests(targetHours.filter(ts => ts >= indexUpdateFrom), cache.index, cache.checkedIndex, period)
    : missingHourRanges(indexUpdateFrom, to, cache.index, cache.checkedIndex);
  for (const range of indexRanges) {
    activeChecks.set("index", { name: `${asset}USD index`, ...range });
    reportActivity("index");
    const rows = await historyRows(
      "index_price_historical_data",
      "index",
      { ...params, from: range.from, to: range.to, index_name: `${asset}USD` },
      signal,
    );
    for (const row of rows) {
      if (
        row.length >= 5 &&
        row.slice(0, 5).every(Number.isFinite) &&
        row.slice(1, 5).every((v) => v > 0)
      ) {
        const ts = row[0] + period - HOUR;
        cache.index.set(ts, [ts, ...row.slice(1, 5)]);
        apiIndexRows++;
      }
    }
    rememberChecked(cache.checkedIndex, range, period);
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
  const failedNames = new Set();
  const loadMarkRange = async range => {
    const { instrument, from, to } = range;
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
          stored.rows.set(row[0] + period - HOUR, row[8]);
          apiMarkRows++;
        }
      }
      if (!cache.checked.has(instrument.name))
        cache.checked.set(instrument.name, []);
      rememberChecked(cache.checked.get(instrument.name), range, period);
    } catch (error) {
      signal?.throwIfAborted();
      // Failed ranges remain retryable on refresh.
      if (error.isRateLimit) rateLimitWarning = error.message;
      failures.push(`${instrument.name}: ${error.message}`);
      failedNames.add(instrument.name);
    } finally {
      activeChecks.delete(instrument.name);
      completedChecks++;
      if (!signal?.aborted) reportActivity("marks");
    }
  };
  const byExpiry = new Map(
    expiries.map((expiry) => [
      expiry,
      chain.filter((i) => i.expiry === expiry),
    ]),
  );
  if (planInputs) {
    const hours = (targetHours || [...spots.keys()]).filter(ts => ts >= updateFrom && ts <= to && spots.has(ts));
    const refreshSelection = () => {
      const selection = planInputs({ chain, cache, spots, hours, period });
      for (const ts of selection.readyHours) ready(cache).add(ts);
      totalExpiries = selection.needed.size;
      completedExpiries = totalExpiries - new Set(selection.requests.map(p => p.instrument.expiry)).size;
      publish(cache);
      return selection;
    };
    while (true) {
      signal?.throwIfAborted();
      const selection = refreshSelection();
      const requests = selection.requests.filter(p => !failedNames.has(p.instrument.name)).flatMap(({ instrument, hours }) =>
        planHistoryRequests(hours, cache.marks.get(instrument.name)?.rows || new Map(), cache.checked.get(instrument.name) || [], period)
          .map(range => ({ instrument, ...range })));
      if (!requests.length) break;
      let completed = 0;
      // Keep the same shared pacer as Term Structure. Narrowing input selection,
      // not increasing concurrency, makes the backfill faster.
      await pool(requests, 2, async range => {
        await loadMarkRange(range);
        if (++completed % 4 === 0) refreshSelection();
        onProgress(completedChecks, completedChecks + requests.length - completed);
      }, signal);
    }
    refreshSelection();
  } else {
    await pool(
      [...byExpiry.values()],
      2,
      async (instruments) => {
        // Both wings are required at every delta. Fetch the same full ladder once,
        // then reuse it when switching between 15, 25 and 35 delta.
        const checkedAt = Date.now();
        const plan = instruments.map((instrument) => ({
          instrument,
          hours: new Set([...(targetHours || spots.keys())].filter((ts) => spots.has(ts) &&
            ts >= Math.max(updateFrom, instrument.listedAt ?? updateFrom) && ts <= to && ts + HOUR < instrument.expiry)),
        }));
        const requests = plan.flatMap(({ instrument, hours }) => {
          const stored = cache.marks.get(instrument.name);
          const checked = cache.checked.get(instrument.name) || [];
          if (targetHours) return planHistoryRequests(hours, stored?.rows || new Map(), checked, period)
            .map(range => ({ instrument, ...range }));
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
          loadMarkRange,
          signal,
        );
        onProgress((done += instruments.length), chain.length);
        publish(cache);
        completedExpiries++;
        reportActivity("marks");
      },
      signal,
    );
  }
  const { quotes, preparedHistory } = snapshot(cache);
  publish(cache);
  reportActivity("complete");
  return {
    quotes,
    preparedHistory,
    indexBars,
    failures,
    warning: [cache.warning, discoveryWarning].filter(Boolean).join(" "),
    rateLimitWarning,
    coverage: { cachedIndexRows, cachedMarkRows, apiIndexRows, apiMarkRows },
  };
}
