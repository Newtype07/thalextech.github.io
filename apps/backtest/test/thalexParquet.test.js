import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SHARD_LOAD_CONCURRENCY,
  decodeInstrumentDictionary,
  decodePreparedShard,
  loadThalexHistory,
  THALEX_ARTIFACT_VERSION,
} from "../src/lib/thalexParquet.js";
import { PRECOMPUTED_DELTA_SCALE } from "../src/lib/optionRisk.js";

const manifest = {
  schema: "thalex-option-backtest",
  version: THALEX_ARTIFACT_VERSION,
  pricing: {
    daysPerYear: 365,
    deltaScale: PRECOMPUTED_DELTA_SCALE,
  },
  dteBuckets: [
    { key: "000-010", minExclusive: 0, maxInclusive: 10 },
    { key: "010-028", minExclusive: 10, maxInclusive: 28 },
    { key: "028-plus", minExclusive: 28, maxInclusive: null },
  ],
  instruments: [
    ["BTC-13JUN25-100000-C", 1_749_808_800, 100_000, 1],
    ["BTC-13JUN25-100000-P", 1_749_808_800, 100_000, -1],
  ],
};

test("current schema dictionary decodes numeric metadata once", () => {
  const instruments = decodeInstrumentDictionary(manifest);

  assert.deepEqual(instruments[0], {
    instrumentId: 0,
    name: "BTC-13JUN25-100000-C",
    expirationTs: 1_749_808_800,
    strike: 100_000,
    optionType: "C",
  });
  assert.equal(instruments[1].optionType, "P");
});

test("compact quote snapshots are filtered without per-quote expansion", () => {
  const payload = {
    schema: "thalex-option-backtest",
    version: THALEX_ARTIFACT_VERSION,
    hourlyOffset: 8,
    index: [[100, 99_000, 100_000, 98_000, 99_500], [200, 100_000, 102_000, 99_000, 101_000]],
    quotes: [
      [100, [[0, 4_000, 0.55, 0.51 * PRECOMPUTED_DELTA_SCALE]]],
      [200, [[1, 3_900, 0.56, -0.48 * PRECOMPUTED_DELTA_SCALE]]],
    ],
  };
  const decoded = decodePreparedShard({
    payload,
    startTs: 150,
    endTs: 250,
  });

  assert.deepEqual(decoded.indexRows, [{ ts: 200, indexPrice: 100_000, high: 102_000, low: 99_000, close: 101_000 }]);
  assert.deepEqual(decoded.quoteSnapshots, [payload.quotes[1]]);
});

test("runtime rejects stale artifact versions", () => {
  assert.throws(
    () => decodeInstrumentDictionary({ ...manifest, version: 1 }),
    new RegExp(`rebuild data with schema version ${THALEX_ARTIFACT_VERSION}`),
  );
});

test("history shards load concurrently while preserving hour order", async () => {
  assert.equal(DEFAULT_SHARD_LOAD_CONCURRENCY, 4);
  const originalFetch = globalThis.fetch;
  const requestedHours = [0, 1, 2, 3, 4];
  const progress = [];
  let activeShardLoads = 0;
  let peakShardLoads = 0;

  globalThis.fetch = async (url) => {
    if (url.endsWith("prepared_manifest.json")) {
      return { ok: true, json: async () => manifest };
    }

    const hour = Number(/h(\d{2})utc/.exec(url)?.[1]);
    activeShardLoads += 1;
    peakShardLoads = Math.max(peakShardLoads, activeShardLoads);
    await new Promise((resolve) => setTimeout(resolve, (5 - hour) * 2));
    activeShardLoads -= 1;
    return {
      ok: true,
      json: async () => ({
        schema: "thalex-option-backtest",
        version: THALEX_ARTIFACT_VERSION,
        hourlyOffset: hour,
        index: [[100 + hour, 99_000 + hour]],
        quotes: [[100 + hour, [[0, 4_000, 0.55, 5_100]]]],
      }),
    };
  };

  try {
    const loaded = await loadThalexHistory({
      start: new Date(0),
      end: new Date(1_000_000),
      hourlyOffsets: requestedHours,
      dataRoot: "test/bounded-shards",
      maxConcurrentShardLoads: 2,
      maxDteDays: 10,
      onProgress: (event) => progress.push(event),
    });

    assert.equal(peakShardLoads, 2);
    assert.deepEqual(
      loaded.indexRows.map((row) => row.ts),
      requestedHours.map((hour) => 100 + hour),
    );
    assert.deepEqual(
      loaded.quoteSnapshots.map(([ts]) => ts),
      requestedHours.map((hour) => 100 + hour),
    );
    assert.deepEqual(progress.map(({ current }) => current), [1, 2, 3, 4, 5]);
    assert.ok(progress.every(({ total }) => total === requestedHours.length));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("maturity buckets fetch only the additional DTE band", async () => {
  const originalFetch = globalThis.fetch;
  const requestedFiles = [];
  let manifestFetchOptions;

  globalThis.fetch = async (url, options) => {
    if (url.endsWith("prepared_manifest.json")) {
      manifestFetchOptions = options;
      return { ok: true, json: async () => manifest };
    }
    requestedFiles.push(url.split("/").at(-1));
    const bucketKey = /_dte([^.]+)\.json$/.exec(url)?.[1];
    return {
      ok: true,
      json: async () => ({
        schema: "thalex-option-backtest",
        version: THALEX_ARTIFACT_VERSION,
        hourlyOffset: 8,
        index: bucketKey === "000-010" ? [[100, 99_000]] : [],
        quotes: [[100, [[0, 4_000, 0.55, 5_100]]]],
      }),
    };
  };

  try {
    const args = {
      start: new Date(0),
      end: new Date(1_000_000),
      hourlyOffsets: [8],
      dataRoot: "test/dte-cache",
    };
    await loadThalexHistory({ ...args, maxDteDays: 10 });
    await loadThalexHistory({ ...args, maxDteDays: 28 });

    assert.deepEqual(requestedFiles, [
      "prepared_1h_h08utc_dte000-010.json",
      "prepared_1h_h08utc_dte010-028.json",
    ]);
    assert.deepEqual(manifestFetchOptions, { cache: "no-cache" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
