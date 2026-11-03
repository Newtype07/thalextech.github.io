import test from "node:test";
import assert from "node:assert/strict";
import { missingHourRanges, loadHistoryCache } from "./history-cache.js";
test("missing ranges identify prefix, internal gaps and suffix without refetching cached hours", () => {
  const ranges = missingHourRanges(
    0,
    6 * 3600 - 1,
    new Map([
      [3600, 1],
      [3 * 3600, 1],
      [4 * 3600, 1],
    ]),
  );
  assert.deepEqual(ranges, [
    { from: 0, to: 3599 },
    { from: 7200, to: 10799 },
    { from: 18000, to: 21599 },
  ]);
  assert.deepEqual(
    missingHourRanges(0, 7199, new Map([[0, 1]]), [{ from: 3600, to: 7199 }]),
    [],
  );
});
test("Parquet-derived cache normalizes close-IV shards without any timestamp shift", async (t) => {
  const expiry = 2000000000;
  t.mock.method(globalThis, "fetch", async (url) => ({
    ok: true,
    json: async () =>
      url.endsWith("manifest.json")
        ? {
            schema: "thalex-term-history",
            version: 1,
            asset: "ETH",
            resolution: 3600,
            timestampBasis: "bar-start",
            sourceThrough: { index: 7200, marks: 10800 },
            ivBasis: "close",
            index: "index-abc.json",
            expiries: { [expiry]: "expiry-abc.json" },
          }
        : url.includes("index-")
          ? { rows: [[3600, 100, 102, 98, 101]] }
          : {
              expiry,
              instruments: [
                {
                  name: "ETH-TEST-C",
                  strike: 100,
                  side: "C",
                  rows: [[3600, 0.5]],
                },
              ],
            },
  }));
  const cache = await loadHistoryCache("ETH", [expiry]);
  assert.equal(cache.warning, "");
  assert.deepEqual(cache.sourceThrough, { index: 7200, marks: 10800 });
  assert.equal(cache.index.get(3600)[4], 101);
  assert.equal(cache.marks.get("ETH-TEST-C").rows.get(3600), 0.5);
  assert.equal(cache.markSourceThrough.get(expiry), 7200);
});
test("missing cache is disclosed and leaves an API-fillable archive", async (t) => {
  t.mock.method(globalThis, "fetch", async () => ({ ok: false, status: 404 }));
  const cache = await loadHistoryCache("BTC", []);
  assert.match(
    cache.warning,
    /missing history will be fetched.*requested lookback/,
  );
  assert.equal(cache.index.size, 0);
});

test("an expiry absent from Parquet has no source boundary despite newer asset-wide data", async (t) => {
  const expiry = 2000000000;
  t.mock.method(globalThis, "fetch", async (url) => ({
    ok: true,
    json: async () =>
      url.endsWith("manifest.json")
        ? {
            schema: "thalex-term-history",
            version: 1,
            asset: "NEW",
            resolution: 3600,
            ivBasis: "close",
            timestampBasis: "bar-start",
            sourceThrough: { index: 7200, marks: 10800 },
            index: "index-abc.json",
            expiries: {},
          }
        : { rows: [[3600, 100, 102, 98, 101]] },
  }));
  const cache = await loadHistoryCache("NEW", [expiry]);
  assert.equal(cache.marks.size, 0);
  assert.deepEqual(cache.sourceThrough, { index: 7200, marks: 10800 });
  assert.equal(cache.markSourceThrough.has(expiry), false);
});

test("legacy manifests infer immutable source boundaries from loaded bars", async (t) => {
  const expiry = 2000000000;
  t.mock.method(globalThis, "fetch", async (url) => ({
    ok: true,
    json: async () =>
      url.endsWith("manifest.json")
        ? {
            schema: "thalex-term-history",
            version: 1,
            asset: "LEGACY",
            resolution: 3600,
            ivBasis: "close",
            timestampBasis: "bar-start",
            index: "index-abc.json",
            expiries: { [expiry]: "expiry-abc.json" },
          }
        : url.includes("index-")
          ? { rows: [[3600, 100, 102, 98, 101]] }
          : {
              expiry,
              instruments: [
                {
                  name: "legacy-option",
                  strike: 100,
                  side: "C",
                  rows: [[0, 0.5]],
                },
              ],
            },
  }));
  const cache = await loadHistoryCache("LEGACY", [expiry]);
  assert.deepEqual(cache.sourceThrough, { index: 7200, marks: 3600 });
  cache.index.set(7200, [7200, 100, 102, 98, 101]);
  cache.marks.get("legacy-option").rows.set(3600, 0.6);
  const reused = await loadHistoryCache("LEGACY", [expiry]);
  assert.deepEqual(reused.sourceThrough, { index: 7200, marks: 3600 });
});

test("refresh loads newly requested expiry shards without reloading known shards or losing API additions", async (t) => {
  const first = 2000000000,
    next = first + 86400;
  const reads = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    reads.push(url);
    const payload = url.endsWith("manifest.json")
      ? {
          schema: "thalex-term-history",
          version: 1,
          asset: "LATER",
          resolution: 3600,
          ivBasis: "close",
          timestampBasis: "bar-start",
          sourceThrough: { index: 7200, marks: 10800 },
          index: "index-later.json",
          expiries: { [first]: "first.json", [next]: "next.json" },
        }
      : url.endsWith("index-later.json")
        ? {
            rows: [
              [0, 100, 100, 100, 100],
              [3600, 100, 100, 100, 100],
            ],
          }
        : {
            expiry: url.endsWith("first.json") ? first : next,
            instruments: [
              {
                name: url.endsWith("first.json") ? "first" : "next",
                strike: 100,
                side: "C",
                rows: [[url.endsWith("first.json") ? 0 : 3600, 0.5]],
              },
            ],
          };
    return { ok: true, json: async () => payload };
  });
  const initial = await loadHistoryCache("LATER", [first]);
  initial.marks.get("first").rows.set(3600, 0.6);
  const refreshed = await loadHistoryCache("LATER", [first, next]);
  assert.equal(refreshed, initial);
  assert.equal(refreshed.marks.get("first").rows.get(3600), 0.6);
  assert.equal(refreshed.marks.get("next").expiry, next);
  assert.deepEqual(
    [...refreshed.markSourceThrough],
    [
      [first, 3600],
      [next, 7200],
    ],
  );
  assert.equal(reads.filter((url) => url.endsWith("manifest.json")).length, 1);
  assert.equal(reads.filter((url) => url.endsWith("first.json")).length, 1);
  assert.equal(reads.filter((url) => url.endsWith("next.json")).length, 1);
  await loadHistoryCache("LATER", [first, next]);
  assert.equal(reads.length, 4);
});

test("an unavailable expiry shard retries on refresh and merges without advancing its Parquet end to API data", async (t) => {
  const expiry = 2000000000;
  let missing = true;
  t.mock.method(globalThis, "fetch", async (url) => {
    if (url.endsWith("expiry-retry.json") && missing)
      return { ok: false, status: 404 };
    return {
      ok: true,
      json: async () =>
        url.endsWith("manifest.json")
          ? {
              schema: "thalex-term-history",
              version: 1,
              asset: "RETRY",
              resolution: 3600,
              ivBasis: "close",
              timestampBasis: "bar-start",
              sourceThrough: { index: 7200, marks: 10800 },
              index: "index-retry.json",
              expiries: { [expiry]: "expiry-retry.json" },
            }
          : url.endsWith("index-retry.json")
            ? { rows: [[0, 100, 100, 100, 100]] }
            : {
                expiry,
                instruments: [
                  { name: "retry", strike: 100, side: "C", rows: [[0, 0.5]] },
                ],
              },
    };
  });
  const archive = await loadHistoryCache("RETRY", [expiry]);
  assert.match(archive.warning, /Cache HTTP 404/);
  assert.equal(archive.markSourceThrough.has(expiry), false);
  archive.marks.set("retry", {
    name: "retry",
    expiry,
    strike: 100,
    side: "C",
    rows: new Map([
      [0, 0.9],
      [3600, 0.6],
    ]),
  });
  missing = false;
  const refreshed = await loadHistoryCache("RETRY", [expiry]);
  assert.equal(refreshed.warning, "");
  assert.equal(refreshed.marks.get("retry").rows.get(0), 0.9);
  assert.equal(refreshed.marks.get("retry").rows.get(3600), 0.6);
  assert.equal(refreshed.markSourceThrough.get(expiry), 3600);
});
