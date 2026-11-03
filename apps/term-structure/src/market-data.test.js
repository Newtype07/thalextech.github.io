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
import { buildTermStructure } from "./volatility.js";
const chain = [
  {
    name: "BTC-TEST-C",
    expiry: Date.now() / 1000 + 86400,
    strike: 100,
    side: "C",
  },
];
const bar = (ts, iv) => [ts, 1, 1, 1, 1, iv, iv, iv, iv];
test("exclusive API boundaries include the latest complete hour in both index and IV backfill", async (t) => {
  const end = Math.floor(Date.now() / 1000 / HOUR) * HOUR;
  const latest = end - HOUR;
  const archive = emptyArchive();
  archive.sourceThrough = { index: latest, marks: latest };
  archive.markSourceThrough.set(chain[0].expiry, latest);
  archive.index.set(latest - HOUR, [latest - HOUR, 100, 100, 100, 100]);
  archive.marks.set(chain[0].name, {
    ...chain[0],
    rows: new Map([[latest - HOUR, 0.4]]),
  });
  const calls = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input);
    calls.push(url);
    const from = Number(url.searchParams.get("from"));
    const exclusiveEnd =
      Math.floor(Number(url.searchParams.get("to")) / HOUR) * HOUR;
    const isIndex = url.pathname.endsWith("index_price_historical_data");
    const rows = [];
    for (let ts = from; ts + HOUR <= exclusiveEnd; ts += HOUR)
      rows.push(isIndex ? [ts, 100, 100, 100, 100] : bar(ts, 0.5));
    return {
      ok: true,
      json: async () => ({ result: { [isIndex ? "index" : "mark"]: rows } }),
    };
  });
  const result = await fetchHistoricalQuotes(chain, "BTC", {
    archive,
    asOf: end + 1200,
  });
  assert.equal(
    result.indexBars.at(-1).ts + HOUR,
    end,
    "index reaches the last complete close",
  );
  assert.equal(
    Math.max(...result.quotes.map((point) => point.ts)),
    end,
    "IV reaches the same close",
  );
  assert.deepEqual(result.failures, []);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((url) => Number(url.searchParams.get("to")) === end));
  assert.ok(
    result.quotes.every((point) => point.ts <= end),
    "the current incomplete hour stays excluded",
  );
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
  assert.equal(calls.length, 2);
  assert.equal(result.quotes.length, 3);
  assert.equal(result.quotes.find((q) => q.ts === end).spot, 102);
  assert.deepEqual(result.coverage, {
    cachedIndexRows: 1999,
    cachedMarkRows: 2,
    apiIndexRows: 1,
    apiMarkRows: 1,
  });
  await fetchHistoricalQuotes(active, "BTC", { archive, asOf: end });
  assert.equal(calls.length, 2);
});

test("long-expiry RV backfills from the Parquet boundary and leaves older source gaps untouched", async (t) => {
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
  assert.equal(result.indexBars.length, requiredHours - 1);
  assert.equal(result.indexBars[0].ts, end - requiredHours * HOUR);
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
  const checking = activities.find((data) => data.active.length);
  assert.ok(checking, "history activity is visible before an expiry finishes");
  assert.equal(checking.active[0].from, end - HOUR);
  assert.equal(checking.active[0].to, end - 1);
  assert.ok(
    active.some((instrument) => instrument.name === checking.active[0].name),
  );
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

test("ATM fetches hourly brackets only, preserves the full cached window and reuses session additions", async (t) => {
  const end = Math.floor(Date.now() / 1000 / HOUR) * HOUR;
  const from = end - 72 * HOUR;
  const active = [80, 90, 100, 110, 120, 130].flatMap((strike) =>
    ["C", "P"].map((side) => ({
      name: `${strike}-${side}`,
      expiry: end + 86400,
      strike,
      side,
    })),
  );
  const archive = emptyArchive(),
    full = [];
  archive.sourceThrough = { index: end, marks: from };
  for (let ts = end - HISTORY_LIMIT * HOUR; ts < end; ts += HOUR) {
    const spot = ts === from + HOUR ? 105 : 95;
    archive.index.set(ts, [ts, spot, spot, spot, spot]);
    for (const instrument of active) {
      const iv = instrument.strike / 250 + (instrument.side === "P" ? 0.02 : 0);
      full.push({ ...instrument, ts: ts + HOUR, iv, spot });
      if (ts >= from) continue;
      if (!archive.marks.has(instrument.name))
        archive.marks.set(instrument.name, { ...instrument, rows: new Map() });
      archive.marks.get(instrument.name).rows.set(ts, iv);
    }
  }
  const calls = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input);
    calls.push(url);
    const instrument = active.find(
      (i) => i.name === url.searchParams.get("instrument_name"),
    );
    assert.ok(instrument, "index is already cached");
    const first = Number(url.searchParams.get("from"));
    const last = Number(url.searchParams.get("to"));
    assert.ok(first >= from && last <= end);
    const mark = [];
    for (let ts = first; ts < last; ts += HOUR)
      mark.push(
        bar(ts, instrument.strike / 250 + (instrument.side === "P" ? 0.02 : 0)),
      );
    return { ok: true, json: async () => ({ result: { mark } }) };
  });
  const result = await fetchHistoricalQuotes(active, "BTC", {
    archive,
    asOf: end,
  });
  assert.equal(
    calls.length,
    6,
    "three required strikes, both sides, one request per instrument",
  );
  assert.deepEqual(
    new Set(calls.map((url) => url.searchParams.get("instrument_name"))),
    new Set(["90-C", "90-P", "100-C", "100-P", "110-C", "110-P"]),
  );
  const expected = buildTermStructure({
    live: [],
    history: full,
    expiries: [active[0].expiry],
  }).history;
  const actual = buildTermStructure({
    live: [],
    history: result.quotes,
    expiries: [active[0].expiry],
  }).history;
  assert.deepEqual(
    actual,
    expected,
    "selected inputs reproduce full-chain ATM, including older cached history",
  );
  assert.equal(actual.length, HISTORY_LIMIT);
  await fetchHistoricalQuotes(active, "BTC", { archive, asOf: end });
  assert.equal(
    calls.length,
    6,
    "same-session refresh makes no repeated history requests",
  );
});

test("empty ATM brackets expand to usable neighbours instead of silently clamping", async (t) => {
  const end = Math.floor(Date.now() / 1000 / HOUR) * HOUR,
    ts = end - HOUR;
  const active = [80, 90, 100, 110].map((strike) => ({
    name: String(strike),
    expiry: end + 86400,
    strike,
    side: "C",
    listedAt: ts,
  }));
  const archive = emptyArchive();
  archive.index.set(ts, [ts, 95, 95, 95, 95]);
  const calls = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input);
    if (url.pathname.endsWith("index_price_historical_data"))
      return { ok: true, json: async () => ({ result: {} }) };
    const name = url.searchParams.get("instrument_name");
    calls.push(name);
    return {
      ok: true,
      json: async () => ({
        result: {
          mark: ["90", "100"].includes(name)
            ? []
            : [bar(ts, name === "80" ? 0.4 : 0.6)],
        },
      }),
    };
  });
  const result = await fetchHistoricalQuotes(active, "BTC", {
    archive,
    asOf: end,
  });
  // Requests within each bracket round may start in either order while they
  // contend for the shared limiter. Expansion must still follow the first pair.
  assert.deepEqual(calls.slice(0, 2).sort(), ["100", "90"]);
  assert.deepEqual(calls.slice(2).sort(), ["110", "80"]);
  const [point] = buildTermStructure({
    live: [],
    history: result.quotes,
    expiries: [active[0].expiry],
  }).history;
  assert.equal(point.clamped, false);
  assert.ok(Math.abs(point.iv - Math.sqrt((0.4 ** 2 + 0.6 ** 2) / 2)) < 1e-12);
});

test("delta selection fetches only its side and reuses cached ATM inputs", async (t) => {
  const end = Math.floor(Date.now() / 1000 / HOUR) * HOUR,
    ts = end - HOUR;
  const active = [80, 90, 100, 110].flatMap((strike) =>
    ["C", "P"].map((side) => ({
      name: `${strike}-${side}`,
      expiry: end + 86400,
      strike,
      side,
      listedAt: ts,
    })),
  );
  const archive = emptyArchive();
  archive.index.set(ts, [ts, 95, 95, 95, 95]);
  // The preceding ATM selection already fetched its two put inputs.
  for (const instrument of active.filter((i) =>
    ["90-P", "100-P"].includes(i.name),
  ))
    archive.marks.set(instrument.name, {
      ...instrument,
      rows: new Map([[ts, 0.4]]),
    });
  const calls = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input);
    if (url.pathname.endsWith("index_price_historical_data"))
      return { ok: true, json: async () => ({ result: {} }) };
    calls.push(url.searchParams.get("instrument_name"));
    return {
      ok: true,
      json: async () => ({ result: { mark: [bar(ts, 0.4)] } }),
    };
  });
  await fetchHistoricalQuotes(active, "BTC", {
    archive,
    asOf: end,
    slice: "25p",
  });
  assert.deepEqual(calls.toSorted(), ["110-P", "80-P"]);
  await fetchHistoricalQuotes(active, "BTC", {
    archive,
    asOf: end,
    slice: "10p",
  });
  assert.equal(
    calls.length,
    2,
    "another put delta reuses the same side's history",
  );
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

test("a failed bracket request does not widen or get remembered as empty", async (t) => {
  const end = Math.floor(Date.now() / 1000 / HOUR) * HOUR,
    ts = end - HOUR;
  const active = [80, 90, 100, 110].map((strike) => ({
    name: String(strike),
    expiry: end + 86400,
    strike,
    side: "C",
    listedAt: ts,
  }));
  const archive = emptyArchive();
  archive.index.set(ts, [ts, 95, 95, 95, 95]);
  const calls = [];
  let fail = true;
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input);
    if (url.pathname.endsWith("index_price_historical_data"))
      return { ok: true, json: async () => ({ result: {} }) };
    const name = url.searchParams.get("instrument_name");
    calls.push(name);
    if (fail && name === "90") return { ok: false, status: 400 };
    return {
      ok: true,
      json: async () => ({ result: { mark: [bar(ts, 0.4)] } }),
    };
  });
  const result = await fetchHistoricalQuotes(active, "BTC", {
    archive,
    asOf: end,
  });
  // Both brackets are requested concurrently; dispatch order is not a contract.
  assert.deepEqual([...calls].sort(), ["100", "90"]);
  assert.equal(result.failures.length, 1);
  assert.equal(archive.checked.has("90"), false);
  fail = false;
  const retry = await fetchHistoricalQuotes(active, "BTC", {
    archive,
    asOf: end,
  });
  assert.deepEqual(calls.slice(2), ["90"]);
  assert.equal(retry.failures.length, 0);
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
  archive.markSourceThrough.set(chain[0].expiry, end - HOUR);
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
  archive.markSourceThrough.set(active[0].expiry, marksThrough);
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

test("expiries absent from Parquet fetch pre-boundary listing history for ATM and delta slices", async (t) => {
  const end = Math.floor(Date.now() / 1000 / HOUR) * HOUR;
  const listedAt = end - 6 * HOUR,
    assetEnd = end - 2 * HOUR;
  const expiry = end + 86400;
  const active = ["C", "P"].map((side) => ({
    name: `unarchived-${side}`,
    expiry,
    strike: 100,
    side,
    listedAt,
  }));
  for (const slice of ["atm", "25p"]) {
    const archive = emptyArchive();
    archive.sourceThrough = { index: end, marks: assetEnd };
    for (let ts = listedAt; ts < end; ts += HOUR)
      archive.index.set(ts, [ts, 100, 100, 100, 100]);
    const calls = [];
    t.mock.method(globalThis, "fetch", async (input) => {
      const url = new URL(input);
      assert.match(url.pathname, /mark_price_historical_data$/);
      assert.equal(
        Number(url.searchParams.get("from")),
        listedAt,
        "a different expiry's newer Parquet end must not truncate this listing",
      );
      assert.equal(Number(url.searchParams.get("to")), end);
      calls.push(url.searchParams.get("instrument_name"));
      return {
        ok: true,
        json: async () => ({
          result: {
            mark: Array.from({ length: 6 }, (_, i) =>
              bar(listedAt + i * HOUR, 0.4),
            ),
          },
        }),
      };
    });
    const result = await fetchHistoricalQuotes(active, "BTC", {
      archive,
      asOf: end,
      slice,
    });
    assert.deepEqual(result.failures, []);
    assert.deepEqual(
      calls.toSorted(),
      slice === "atm" ? ["unarchived-C", "unarchived-P"] : ["unarchived-P"],
    );
    assert.equal(result.quotes.length, slice === "atm" ? 12 : 6);
    assert.equal(
      Math.min(...result.quotes.map((point) => point.ts)),
      listedAt + HOUR,
    );
    assert.equal(
      archive.markSourceThrough.has(expiry),
      false,
      "API rows do not become Parquet provenance",
    );
    const count = calls.length;
    await fetchHistoricalQuotes(active, "BTC", { archive, asOf: end, slice });
    assert.equal(calls.length, count, "session additions are reused");
    t.mock.restoreAll();
  }
});

test("an unarchived expiry without a listing timestamp is bounded by the full lookback", async (t) => {
  const end = Math.floor(Date.now() / 1000 / HOUR) * HOUR,
    from = end - HISTORY_LIMIT * HOUR;
  const archive = emptyArchive();
  archive.sourceThrough = { index: end, marks: end };
  for (let ts = from; ts < end; ts += HOUR)
    archive.index.set(ts, [ts, 100, 100, 100, 100]);
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input);
    assert.equal(Number(url.searchParams.get("from")), from);
    assert.equal(Number(url.searchParams.get("to")), end);
    return {
      ok: true,
      json: async () => ({
        result: {
          mark: Array.from({ length: HISTORY_LIMIT }, (_, i) =>
            bar(from + i * HOUR, 0.4),
          ),
        },
      }),
    };
  });
  const result = await fetchHistoricalQuotes(chain, "BTC", {
    archive,
    asOf: end,
  });
  assert.equal(result.quotes.length, HISTORY_LIMIT);
  assert.equal(result.failures.length, 0);
});

test("covered expiries use their own Parquet end and retain older intentional holes", async (t) => {
  const end = Math.floor(Date.now() / 1000 / HOUR) * HOUR,
    from = end - HISTORY_LIMIT * HOUR;
  const expiryEnd = end - 3 * HOUR,
    gap = end - 100 * HOUR;
  const archive = emptyArchive();
  archive.sourceThrough = { index: end, marks: end };
  archive.markSourceThrough.set(chain[0].expiry, expiryEnd);
  const rows = new Map();
  for (let ts = from; ts < end; ts += HOUR) {
    archive.index.set(ts, [ts, 100, 100, 100, 100]);
    if (ts < expiryEnd && ts !== gap) rows.set(ts, 0.4);
  }
  archive.marks.set(chain[0].name, { ...chain[0], rows });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input);
    assert.equal(Number(url.searchParams.get("from")), expiryEnd);
    calls++;
    return {
      ok: true,
      json: async () => ({
        result: { mark: [0, 1, 2].map((i) => bar(expiryEnd + i * HOUR, 0.5)) },
      }),
    };
  });
  const result = await fetchHistoricalQuotes(chain, "BTC", {
    archive,
    asOf: end,
  });
  assert.equal(calls, 1);
  assert.equal(result.quotes.length, HISTORY_LIMIT - 1);
  assert.equal(archive.marks.get(chain[0].name).rows.has(gap), false);
  assert.equal(archive.markSourceThrough.get(chain[0].expiry), expiryEnd);
});
