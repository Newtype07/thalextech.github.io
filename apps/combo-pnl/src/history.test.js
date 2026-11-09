import test from "node:test";
import assert from "node:assert/strict";
import { comboHistoryPlan, createComboHistoryLoader } from "./history.js";

const defaults = { historyTo: 1794239940, points: 360, resolution: "15m", intervalSeconds: 900, hedgeEnabled: false };

function provider(calls) {
  return async query => {
    calls.push(query);
    const seconds = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "1d": 86400 }[query.resolution];
    return Array.from({ length: Math.min(query.count, Math.ceil((query.to - query.from) / seconds)) },
      (_, i) => ({ ts: query.from + i * seconds }));
  };
}

test("the default unhedged chart loads native candles instead of a minute replay", async () => {
  const calls = [];
  const load = createComboHistoryLoader(provider(calls));
  const plan = comboHistoryPlan(defaults);
  const rows = await load({ ...plan, index_name: "BTCUSD" });
  assert.equal(plan.resolution, "15m");
  assert.ok(rows.length >= 359 && rows.length <= 360);
  assert.ok(calls.length <= 2, "the old minute path needed six or seven pages per stream");
  assert.ok(calls.every(query => query.resolution === "15m"));
  assert.equal(calls.reduce((sum, query) => sum + (query.to - query.from) / 900, 0), rows.length,
    "no bars before the requested window are downloaded");
  assert.deepEqual(await load({ ...plan, index_name: "BTCUSD" }), rows);
  assert.ok(calls.length <= 2, "rebuilding a position reuses cached history");
});

test("hedging loads a separate minute history whose window does not change with chart resolution", async () => {
  const calls = [];
  const load = createComboHistoryLoader(provider(calls));
  const coarse = comboHistoryPlan(defaults);
  await load({ ...coarse, instrument_name: "BTC-call" });
  const minute = comboHistoryPlan({ ...defaults, hedgeEnabled: true });
  const rows = await load({ ...minute, instrument_name: "BTC-call" });
  assert.equal(rows.length, 5386);
  assert.ok(rows.every((row, i) => i === 0 || row.ts - rows[i - 1].ts === 60));
  for (const intervalSeconds of [60, 300, 900, 3600, 86400]) {
    assert.deepEqual(comboHistoryPlan({ ...defaults, resolution: "unused", intervalSeconds, hedgeEnabled: true }), minute);
  }
  const before = calls.length;
  assert.deepEqual(await load({ ...minute, instrument_name: "BTC-call" }), rows);
  assert.equal(calls.length, before);
});

test("long unhedged windows page all native candles and keep instrument caches separate", async () => {
  const calls = [];
  const load = createComboHistoryLoader(provider(calls));
  const plan = comboHistoryPlan({ ...defaults, points: 10000 });
  const first = await load({ ...plan, instrument_name: "BTC-call" });
  const second = await load({ ...plan, instrument_name: "BTC-put" });
  assert.deepEqual(second, first);
  assert.ok(first.length >= 9999 && first.length <= 10000);
  assert.ok(calls.every(query => query.count === 1000 && query.resolution === "15m"));
  assert.ok(calls.some(query => query.instrument_name === "BTC-call"));
  assert.ok(calls.some(query => query.instrument_name === "BTC-put"));
});
