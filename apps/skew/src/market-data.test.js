import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchHistoricalQuotes,
  fetchLiveQuotes,
  fetchOptionChain,
  HISTORY_LIMIT,
  HOUR,
} from "./market-data.js";
import { emptyArchive } from "./history-cache.js";
const chain = [
  {
    name: "BTC-TEST-C",
    expiry: Date.now() / 1000 + 86400,
    strike: 100,
    side: "C",
  },
];
const bar = (ts, iv) => [ts, 1, 1, 1, 1, iv, iv, iv, iv];
test("exclusive API boundaries include the latest complete hour in both index and IV backfill", async t => {
  const end = Math.floor(Date.now() / 1000 / HOUR) * HOUR;
  const latest = end - HOUR;
  const archive = emptyArchive();
  archive.sourceThrough = { index: latest, marks: latest };
  archive.index.set(latest - HOUR, [latest - HOUR, 100, 100, 100, 100]);
  archive.marks.set(chain[0].name, { ...chain[0], rows: new Map([[latest - HOUR, 0.4]]) });
  const calls = [];
  t.mock.method(globalThis, "fetch", async input => {
    const url = new URL(input);
    calls.push(url);
    const from = Number(url.searchParams.get("from"));
    const exclusiveEnd = Math.floor(Number(url.searchParams.get("to")) / HOUR) * HOUR;
    const isIndex = url.pathname.endsWith("index_price_historical_data");
    const rows = [];
    for (let ts = from; ts + HOUR <= exclusiveEnd; ts += HOUR)
      rows.push(isIndex ? [ts, 100, 100, 100, 100] : bar(ts, 0.5));
    return { ok: true, json: async () => ({ result: { [isIndex ? "index" : "mark"]: rows } }) };
  });
  const result = await fetchHistoricalQuotes(chain, "BTC", { archive, asOf: end + 1200 });
  assert.equal(result.indexBars.at(-1).ts + HOUR, end, "index reaches the last complete close");
  assert.equal(Math.max(...result.quotes.map(point => point.ts)), end, "IV reaches the same close");
  assert.deepEqual(result.failures, []);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(url => Number(url.searchParams.get("to")) === end));
  assert.ok(result.quotes.every(point => point.ts <= end), "the current incomplete hour stays excluded");
});

test("history pages backwards, joins exact index timestamps and labels completed bar closes", async (t) => {
  const to = Math.floor(Date.now() / 1000 / HOUR) * HOUR - 1;
  const from = to + 1 - HISTORY_LIMIT * HOUR;
  const calls = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input),
      end = Number(url.searchParams.get("to"));
    calls.push(url);
    let result;
    if (url.pathname.endsWith("index_price_historical_data"))
      result =
        end === to + 1
          ? { index: [[from + HOUR, 100, 100, 100, 101]] }
          : { index: [[from, 100, 100, 100, 100]] };
    else
      result = {
        mark: [
          bar(from, 0.4),
          bar(from + HOUR, 0.5),
          bar(from + 2 * HOUR, 0.7),
        ],
      };
    return { ok: true, json: async () => ({ result }) };
  });
  const { quotes, failures } = await fetchHistoricalQuotes(chain, "BTC", {
    archive: emptyArchive(),
  });
  assert.equal(failures.length, 0);
  assert.equal(quotes.length, 2);
  assert.deepEqual(
    quotes.map((q) => q.ts),
    [from + HOUR, from + 2 * HOUR],
  );
  assert.deepEqual(
    quotes.map((q) => q.spot),
    [100, 101],
  );
  assert.ok(
    calls.every((url) => {
      const hours = Math.ceil(
        (Number(url.searchParams.get("to")) -
          Number(url.searchParams.get("from"))) /
          HOUR,
      );
      return (
        Number(url.searchParams.get("count")) === Math.min(HISTORY_LIMIT, hours)
      );
    }),
  );
});
test("explicit no_data is accepted; malformed history is reported as a partial failure", async (t) => {
  const ts = Math.floor(Date.now() / 1000 / HOUR) * HOUR - HOUR;
  let payload = { no_data: true };
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input);
    const result = url.pathname.endsWith("index_price_historical_data")
      ? Number(url.searchParams.get("to")) <= ts
        ? { no_data: true }
        : { index: [[ts, 100, 100, 100, 100]] }
      : payload;
    return { ok: true, json: async () => ({ result }) };
  });
  assert.deepEqual(
    (await fetchHistoricalQuotes(chain, "BTC", { archive: emptyArchive() }))
      .quotes,
    [],
  );
  for (const missing of [{}, { instrument_type: "option" }]) {
    payload = missing;
    const result = await fetchHistoricalQuotes(chain, "BTC", {
      archive: emptyArchive(),
    });
    assert.equal(result.failures.length, 0);
    assert.deepEqual(result.quotes, []);
  }
  payload = { mark: {} };
  assert.equal(
    (await fetchHistoricalQuotes(chain, "BTC", { archive: emptyArchive() }))
      .failures.length,
    1,
  );
});
test("chain filters assets/expired contracts; snapshots bypass cache and reject stale marks", async (t) => {
  const now = Date.now() / 1000;
  let ticker = false;
  t.mock.method(globalThis, "fetch", async (input, options) => {
    assert.equal(options.cache, "no-store");
    const result = ticker
      ? { iv: 0.4, index: 100, mark_timestamp: now - 180 }
      : [
          {
            type: "option",
            underlying: "BTCUSD",
            expiration_timestamp: now + 1000,
            instrument_name: "test",
            option_type: "call",
            strike_price: 100,
          },
          {
            type: "option",
            underlying: "ETHUSD",
            expiration_timestamp: now + 1000,
          },
          {
            type: "option",
            underlying: "BTCUSD",
            expiration_timestamp: now - 1,
          },
        ];
    return { ok: true, json: async () => ({ result }) };
  });
  assert.equal((await fetchOptionChain("BTC")).length, 1);
  ticker = true;
  const live = await fetchLiveQuotes(chain);
  assert.equal(live.quotes.length, 0);
  assert.equal(live.failures.length, 1);
});
test("cancellation stops fetching", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fetchOptionChain("BTC", controller.signal), {
    name: "AbortError",
  });
});

test("cached history plus API tail merges once, retains cached strikes and is reused on refresh", async (t) => {
  const end = Math.floor(Date.now() / 1000 / HOUR) * HOUR,
    from = end - HISTORY_LIMIT * HOUR;
  const archive = emptyArchive();
  archive.sourceThrough = { index: end - HOUR, marks: end - HOUR };
  for (let ts = from; ts < end - HOUR; ts += HOUR)
    archive.index.set(ts, [ts, 100, 102, 98, 101]);
  archive.marks.set(chain[0].name, {
    ...chain[0],
    rows: new Map([[end - 2 * HOUR, 0.4]]),
  });
  archive.marks.set("delisted-strike", {
    ...chain[0],
    name: "delisted-strike",
    strike: 110,
    rows: new Map([[end - 2 * HOUR, 0.6]]),
  });
  const active = [{ ...chain[0], listedAt: end - 2 * HOUR }];
  const calls = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input);
    calls.push(url);
    assert.equal(Number(url.searchParams.get("from")), end - HOUR);
    const result = url.pathname.endsWith("index_price_historical_data")
      ? { index: [[end - HOUR, 101, 103, 99, 102]] }
      : { mark: [bar(end - HOUR, 0.5)] };
    return { ok: true, json: async () => ({ result }) };
  });
  const result = await fetchHistoricalQuotes(active, "BTC", {
    archive,
    asOf: end,
  });
  assert.equal(calls.length, 3);
  assert.equal(result.quotes.length, 4);
  assert.equal(result.quotes.find((q) => q.ts === end).spot, 102);
  assert.deepEqual(result.coverage, {
    cachedIndexRows: 1999,
    cachedMarkRows: 2,
    apiIndexRows: 1,
    apiMarkRows: 2,
  });
  await fetchHistoricalQuotes(active, "BTC", { archive, asOf: end });
  assert.equal(calls.length, 3);
});

test("long expiries do not extend the index lookback beyond the skew window", async (t) => {
  const end = Math.floor(Date.now() / 1000 / HOUR) * HOUR;
  const requiredHours = 2100;
  const active = [
    { ...chain[0], expiry: end + requiredHours * HOUR, listedAt: end },
  ];
  const archive = emptyArchive();
  for (let ts = end - requiredHours * HOUR; ts < end - HOUR; ts += HOUR)
    archive.index.set(ts, [ts, 100, 101, 99, 100]);
  archive.sourceThrough = { index: end - HOUR, marks: end - HOUR };
  // An older Parquet gap is left untouched; the gap after Parquet still updates.
  archive.index.delete(end - 100 * HOUR);
  const calls = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input);
    calls.push(url);
    assert.equal(Number(url.searchParams.get("from")), end - HOUR);
    return {
      ok: true,
      json: async () => ({
        result: { index: [[end - HOUR, 100, 101, 99, 100]] },
      }),
    };
  });
  const result = await fetchHistoricalQuotes(active, "BTC", {
    archive,
    asOf: end,
  });
  assert.equal(calls.length, 1);
  assert.equal(result.indexBars.length, HISTORY_LIMIT - 1);
  assert.equal(result.indexBars[0].ts, end - HISTORY_LIMIT * HOUR);
  assert.equal(result.warning, "");
});

test("cached history publishes before network requests, then updates after each expiry completes", async (t) => {
  const end = Math.floor(Date.now() / 1000 / HOUR) * HOUR,
    from = end - HISTORY_LIMIT * HOUR;
  const active = [
    { ...chain[0], listedAt: end - 2 * HOUR },
    {
      ...chain[0],
      name: "BTC-NEXT-C",
      expiry: chain[0].expiry + 86400,
      listedAt: end - 2 * HOUR,
    },
  ];
  const archive = emptyArchive();
  for (let ts = from; ts < end; ts += HOUR)
    archive.index.set(ts, [ts, 100, 102, 98, 101]);
  for (const instrument of active)
    archive.marks.set(instrument.name, {
      ...instrument,
      rows: new Map([[end - 2 * HOUR, 0.4]]),
    });
  const updates = [];
  const activities = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    assert.ok(
      updates.length > 0,
      "cached data must be published before any API request",
    );
    assert.equal(new URL(input).searchParams.get("from"), String(end - HOUR));
    return {
      ok: true,
      json: async () => ({ result: { mark: [bar(end - HOUR, 0.5)] } }),
    };
  });
  await fetchHistoricalQuotes(active, "BTC", {
    archive,
    asOf: end,
    onUpdate: (data) => updates.push(data.quotes),
    onActivity: (data) => activities.push(data),
  });
  assert.equal(updates[0].length, 2);
  assert.ok(
    updates.length >= 4,
    "initial snapshot, each completed expiry and final snapshot publish",
  );
  assert.equal(updates.at(-1).length, 4);
  const checking = activities.find(data => data.active.length);
  assert.ok(checking, "history activity is visible before an expiry finishes");
  assert.equal(checking.active[0].from, end - HOUR);
  assert.equal(checking.active[0].to, end - 1);
  assert.ok(active.some(instrument => instrument.name === checking.active[0].name));
  const complete = activities.at(-1);
  assert.equal(complete.stage, "complete");
  assert.equal(complete.completedChecks, 2);
  assert.equal(complete.completedExpiries, 2);
  assert.deepEqual(complete.active, []);
  assert.equal(complete.coverage.apiMarkRows, 2);
  assert.equal(complete.coverage.cachedMarkRows, 2);
});

test("missing index hours do not trigger unusable per-option history requests", async (t) => {
  const end = Math.floor(Date.now() / 1000 / HOUR) * HOUR,
    from = end - HISTORY_LIMIT * HOUR;
  const archive = emptyArchive(),
    rows = new Map(),
    missing = end - 3 * HOUR;
  for (let ts = from; ts < end; ts += HOUR) {
    if (ts === missing) continue;
    archive.index.set(ts, [ts, 100, 102, 98, 101]);
    rows.set(ts, 0.4);
  }
  archive.marks.set(chain[0].name, { ...chain[0], rows });
  const calls = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input);
    calls.push(url);
    assert.ok(url.pathname.endsWith("index_price_historical_data"));
    return { ok: true, json: async () => ({ result: {} }) };
  });
  const result = await fetchHistoricalQuotes(chain, "BTC", {
    archive,
    asOf: end,
  });
  assert.equal(calls.length, 1);
  assert.equal(result.quotes.length, 1999);
  await fetchHistoricalQuotes(chain, "BTC", { archive, asOf: end });
  assert.equal(calls.length, 1);
});

test("without Parquet coverage, backfill is bounded by the requested lookback", async (t) => {
  const end = Math.floor(Date.now() / 1000 / HOUR) * HOUR;
  const first = end - HISTORY_LIMIT * HOUR;
  const calls = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input);
    calls.push(url);
    const from = Number(url.searchParams.get("from"));
    assert.ok(from >= first);
    assert.ok(Number(url.searchParams.get("count")) <= HISTORY_LIMIT);
    const result = url.pathname.endsWith("index_price_historical_data")
      ? { index: [[first, 100, 100, 100, 100]] }
      : { mark: [bar(first, 0.4)] };
    return { ok: true, json: async () => ({ result }) };
  });
  const result = await fetchHistoricalQuotes(chain, "BTC", {
    archive: emptyArchive(),
    asOf: end,
  });
  assert.equal(result.quotes.length, 1);
  assert.equal(result.warning, "");
});

test("gaps inside Parquet history remain untouched when the subsequent tail is cached", async (t) => {
  const end = Math.floor(Date.now() / 1000 / HOUR) * HOUR;
  const from = end - HISTORY_LIMIT * HOUR,
    gap = end - 100 * HOUR;
  const archive = emptyArchive(),
    rows = new Map();
  for (let ts = from; ts < end; ts += HOUR) {
    archive.index.set(ts, [ts, 100, 100, 100, 100]);
    if (ts !== gap) rows.set(ts, 0.4);
  }
  archive.marks.set(chain[0].name, { ...chain[0], rows });
  archive.sourceThrough = { index: end, marks: end - HOUR };
  t.mock.method(globalThis, "fetch", async () => {
    assert.fail("gaps inside Parquet history must not trigger API requests");
  });
  const result = await fetchHistoricalQuotes(chain, "BTC", {
    archive,
    asOf: end,
  });
  assert.equal(result.quotes.length, HISTORY_LIMIT - 1);
  assert.equal(result.failures.length, 0);
  assert.equal(result.coverage.apiMarkRows, 0);
});

test("backfill spans the entire Parquet-to-present gap with separate index/IV boundaries and newly listed expiries", async (t) => {
  const end = Math.floor(Date.now() / 1000 / HOUR) * HOUR;
  const from = end - HISTORY_LIMIT * HOUR;
  const indexThrough = end - 7 * 24 * HOUR,
    marksThrough = end - 8 * 24 * HOUR;
  const active = [
    { name: "existing", expiry: end + 86400, strike: 100, side: "C" },
    {
      name: "new-expiry",
      expiry: end + 2 * 86400,
      strike: 100,
      side: "C",
      listedAt: end - 6 * 24 * HOUR,
    },
  ];
  const archive = emptyArchive();
  archive.sourceThrough = { index: indexThrough, marks: marksThrough };
  const rows = new Map();
  for (let ts = from; ts < indexThrough; ts += HOUR)
    archive.index.set(ts, [ts, 100, 100, 100, 100]);
  for (let ts = from; ts < marksThrough; ts += HOUR) rows.set(ts, 0.4);
  archive.marks.set("existing", { ...active[0], rows });
  const calls = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input);
    calls.push(url);
    const from = Number(url.searchParams.get("from")),
      to = Number(url.searchParams.get("to"));
    const isIndex = url.pathname.endsWith("index_price_historical_data");
    const first = isIndex
      ? indexThrough
      : url.searchParams.get("instrument_name") === "new-expiry"
        ? active[1].listedAt
        : marksThrough;
    assert.equal(
      from,
      first,
      "backfill starts immediately after the actual Parquet coverage, or at listing",
    );
    assert.equal(to, end);
    const rows = [];
    for (let ts = from; ts < to; ts += HOUR)
      rows.push(isIndex ? [ts, 100, 100, 100, 100] : bar(ts, 0.4));
    return {
      ok: true,
      json: async () => ({ result: { [isIndex ? "index" : "mark"]: rows } }),
    };
  });
  const result = await fetchHistoricalQuotes(active, "BTC", {
    archive,
    asOf: end,
  });
  assert.equal(calls.length, 3);
  assert.equal(result.indexBars.length, HISTORY_LIMIT);
  assert.equal(
    result.quotes.filter((q) => q.expiry === active[0].expiry).length,
    HISTORY_LIMIT,
  );
  assert.equal(
    result.quotes.filter((q) => q.expiry === active[1].expiry).length,
    6 * 24,
  );
  assert.deepEqual(
    archive.sourceThrough,
    { index: indexThrough, marks: marksThrough },
    "API additions do not move source boundaries",
  );
  await fetchHistoricalQuotes(active, "BTC", { archive, asOf: end });
  assert.equal(calls.length, 3, "completed tail is reused in memory");
});

test("skew backfill requests both wings once and reuses their full ladders across delta changes", async t => {
  const end = Math.floor(Date.now() / 1000 / HOUR) * HOUR;
  const ts = end - HOUR;
  const active = [80, 90, 110, 120].flatMap(strike => ["C", "P"].map(side => ({
    name: `${strike}-${side}`, expiry: end + 30 * 86400, strike, side, listedAt: ts,
  })));
  const archive = emptyArchive();
  archive.sourceThrough = { index: end, marks: ts };
  archive.index.set(ts, [ts, 100, 100, 100, 100]);
  const calls = [];
  t.mock.method(globalThis, "fetch", async input => {
    const url = new URL(input);
    calls.push(url.searchParams.get("instrument_name"));
    assert.equal(Number(url.searchParams.get("from")), ts);
    assert.equal(Number(url.searchParams.get("to")), end);
    return { ok: true, json: async () => ({ result: { mark: [bar(ts, 0.5)] } }) };
  });
  const result = await fetchHistoricalQuotes(active, "BTC", { archive, asOf: end });
  assert.deepEqual(new Set(calls), new Set(active.map(i => i.name)));
  assert.equal(result.quotes.length, 8);
  assert.deepEqual(result.failures, []);
  await fetchHistoricalQuotes(active, "BTC", { archive, asOf: end });
  assert.equal(calls.length, 8);
});

test("historical universe discovery paginates in three-day intervals and backfills expired contracts only before expiry", async t => {
  const end = Math.floor(Date.now() / 1000 / HOUR) * HOUR;
  const from = end - 7 * 24 * HOUR, expiry = end - 24 * HOUR;
  const archive = emptyArchive();
  archive.sourceThrough = { index: end, marks: from };
  for (let ts = from; ts < end; ts += HOUR) archive.index.set(ts, [ts, 100, 100, 100, 100]);
  const discovery = [], markCalls = [];
  t.mock.method(globalThis, "fetch", async input => {
    const url = new URL(input);
    if (url.pathname.endsWith("all_instruments")) {
      discovery.push(url);
      assert.ok(Number(url.searchParams.get("time_high")) - Number(url.searchParams.get("time_low")) <= 3 * 86400);
      assert.equal(url.searchParams.get("underlying"), "BTCUSD");
      assert.equal(url.searchParams.get("instrument_type"), "options");
      return { ok: true, json: async () => ({ result: [{ type: "option", underlying: "BTCUSD", instrument_name: "expired-c",
        strike_price: 100, option_type: "call", expiration_timestamp: expiry, create_time: from }] }) };
    }
    assert.ok(url.pathname.endsWith("mark_price_historical_data"));
    markCalls.push(url);
    assert.equal(url.searchParams.get("instrument_name"), "expired-c");
    const first = Number(url.searchParams.get("from")), last = Number(url.searchParams.get("to"));
    assert.equal(first, from); assert.equal(last, expiry - HOUR, "settlement close and later hours are excluded");
    const mark = [];
    for (let ts = first; ts < last; ts += HOUR) mark.push(bar(ts, 0.5));
    return { ok: true, json: async () => ({ result: { mark } }) };
  });
  const result = await fetchHistoricalQuotes([], "BTC", { archive, asOf: end, discoverInstruments: true });
  assert.equal(discovery.length, 3); assert.equal(markCalls.length, 1);
  assert.equal(Number(discovery[0].searchParams.get("time_low")), from);
  assert.equal(Number(discovery.at(-1).searchParams.get("time_high")), end);
  assert.ok(result.quotes.length > 0);
  assert.ok(result.quotes.every(q => q.ts < expiry && q.expiry === expiry));
  assert.deepEqual(result.failures, []);
  await fetchHistoricalQuotes([], "BTC", { archive, asOf: end, discoverInstruments: true });
  assert.equal(discovery.length, 3, "discovered intervals are reused for the browser session");
  assert.equal(markCalls.length, 1, "expired contract additions are reused");
});

test("daily backfill uses native daily candles, joins exact closes, and does not mark intervening hourly closes as checked", async t => {
  const DAY = 86400, end = Math.floor(Date.now() / 1000 / DAY) * DAY;
  const archive = emptyArchive();
  archive.sourceThrough = { index: end - 2 * DAY, marks: end - 2 * DAY };
  const active = [{ ...chain[0], listedAt: end - 2 * DAY }];
  const calls = [];
  t.mock.method(globalThis, "fetch", async input => {
    const url = new URL(input); calls.push(url);
    assert.equal(url.searchParams.get("resolution"), "1d");
    assert.equal(Number(url.searchParams.get("count")), 2);
    const isIndex = url.pathname.endsWith("index_price_historical_data");
    const rows = [end - 2 * DAY, end - DAY].map(ts => isIndex ? [ts, 100, 102, 98, 101] : bar(ts, 0.5));
    return { ok: true, json: async () => ({ result: { [isIndex ? "index" : "mark"]: rows } }) };
  });
  const window = { from: end - 10 * DAY, step: DAY, timestamps: [end - DAY, end] };
  const result = await fetchHistoricalQuotes(active, "BTC", { archive, asOf: end + 100, window });
  assert.equal(calls.length, 2);
  assert.deepEqual(result.quotes.map(q => q.ts), [end - DAY, end]);
  assert.ok(result.quotes.every(q => q.spot === 101));
  const { planHistoryRequests } = await import("./market-data.js");
  const intervening = end - 12 * HOUR;
  assert.equal(planHistoryRequests([intervening], archive.index, archive.checkedIndex).length, 1);
  await fetchHistoricalQuotes(active, "BTC", { archive, asOf: end + 100, window });
  assert.equal(calls.length, 2, "a revisit reuses completed daily additions");
});

test("fully prepared historical windows make no history API requests when the Parquet boundary covers all target closes", async t => {
  const end = Math.floor(Date.now() / 1000 / HOUR) * HOUR;
  const archive = emptyArchive(); archive.sourceThrough = { index: end, marks: end };
  archive.preparedHistory = { "25": [{ ts: end - 86400, tenorDays: 30, callIv: 0.5, putIv: 0.6, skew: -0.1 }] };
  archive.index.set(end - HOUR, [end - HOUR, 100, 100, 100, 100]);
  t.mock.method(globalThis, "fetch", () => assert.fail("Parquet coverage must prevent historical requests"));
  const result = await fetchHistoricalQuotes(chain, "BTC", { archive, asOf: end, discoverInstruments: true,
    window: { from: end - 365 * 86400, step: 86400, timestamps: [end - 86400, end] } });
  assert.equal(result.preparedHistory, archive.preparedHistory, "final completion must retain the prepared year, not erase it after progressive updates");
});

test("empty daily checks never suppress an hourly retry of the same close", async () => {
  const { planHistoryRequests } = await import("./market-data.js");
  const ts = 500000 * HOUR;
  const checked = [{ from: ts, to: ts + HOUR - 1, period: 86400, expires: Date.now() + 60000 }];
  assert.equal(planHistoryRequests([ts], new Map(), checked, 86400).length, 0);
  assert.equal(planHistoryRequests([ts], new Map(), checked, HOUR).length, 1);
  assert.equal(planHistoryRequests([ts], new Map([[ts, 0.5]]), checked, HOUR).length, 0, "successful closes are shared across resolutions");
});

test("adaptive skew backfill publishes only completed hours, uses a small strike subset, and reuses it on revisit", async t => {
  const { fetchSkewHistory } = await import("./market-data.js");
  const { buildHistoricalSkew } = await import("./skew.js");
  const { constantMaturityHistory } = await import("./constant-maturity.js");
  const end = Math.floor(Date.now() / 1000 / HOUR) * HOUR;
  const hours = [end - 3 * HOUR, end - 2 * HOUR, end - HOUR];
  const active = [10, 50].flatMap(days => [60, 70, 80, 90, 95, 100, 105, 110, 120, 130, 150].flatMap(strike => ["C", "P"].map(side => ({
    name: `${days}-${strike}-${side}`, expiry: end + days * 86400, strike, side,
  }))));
  const archive = emptyArchive(); archive.sourceThrough = { index: end, marks: hours[0] };
  archive.preparedHistory = { "25": [{ ts: hours[0], tenorDays: 30, skew: -.1 }] };
  for (const hour of hours) archive.index.set(hour, [hour, 100, 100, 100, 100]);
  const calls = [], updates = [];
  t.mock.method(globalThis, "fetch", async input => {
    assert.ok(updates.length, "cached Parquet data must publish before REST work");
    const url = new URL(input); calls.push(url);
    const instrument = active.find(i => i.name === url.searchParams.get("instrument_name"));
    assert.ok(instrument);
    const mark = [];
    for (let ts = Number(url.searchParams.get("from")); ts < Number(url.searchParams.get("to")); ts += HOUR)
      mark.push(bar(ts, instrument.side === "C" ? .5 : .6));
    return { ok: true, json: async () => ({ result: { mark } }) };
  });
  const settings = { archive, asOf: end, delta: .25, tenors: [30],
    liveIvs: () => new Map(active.map(i => [i.name, i.side === "C" ? .5 : .6])),
    window: { from: end - 7 * 86400, step: HOUR, timestamps: hours.map(h => h + HOUR) },
    onUpdate: data => updates.push(data),
  };
  const result = await fetchSkewHistory(active, "BTC", settings);
  assert.equal(calls.length, 8, "only four input strikes per expiry, not all 44 contracts");
  assert.ok(updates[0].preparedHistory["25"].length);
  assert.ok(updates.some(data => data.quotes.length > 0));
  for (const data of updates) {
    const points = constantMaturityHistory(buildHistoricalSkew({ quotes: data.quotes, delta: .25 }), [30]);
    const publishedHours = new Set(data.quotes.map(q => q.ts));
    assert.equal(points.length, publishedHours.size, "no partial strike ladder is advertised as a completed hour");
    assert.ok(points.every(p => Math.abs(p.skew + .1) < 1e-12));
  }
  assert.deepEqual(result.failures, []);
  assert.equal(new Set(result.quotes.map(q => q.ts)).size, 3);
  await fetchSkewHistory(active, "BTC", settings);
  assert.equal(calls.length, 8);
});
