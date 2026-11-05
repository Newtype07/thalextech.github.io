import test from "node:test";
import assert from "node:assert/strict";
import { createMinuteHistoryLoader } from "./minute-history.js";

test("minute history pages the whole window, caches pages and keeps gaps", async () => {
  const calls = [];
  const load = createMinuteHistoryLoader(async query => {
    calls.push(query);
    const rows = [];
    for (let ts = query.from; ts < query.to; ts += 60) if (ts !== 120) rows.push({ ts });
    return rows.reverse();
  }, { pageSize: 2 });
  const query = { index_name: "BTCUSD", from: 0, to: 300 };
  const rows = await load(query);
  assert.deepEqual(rows.map(row => row.ts), [0, 60, 180, 240, 300]);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(query => [query.from, query.to]), [[0, 120], [120, 240], [240, 360]], "exclusive page ends leave no artificial gaps");
  assert.ok(calls.every(query => query.resolution === "1m" && query.count === 2));
  assert.deepEqual(await load(query), rows);
  assert.equal(calls.length, 3, "replaying a policy reuses the same observations");
});

test("minute history stops an obsolete request without a coarse fallback", async () => {
  let calls = 0, current = true;
  const load = createMinuteHistoryLoader(async () => { calls++; current = false; return [{ ts: 0 }]; }, { pageSize: 2 });
  assert.deepEqual(await load({ from: 0, to: 600 }, () => current), []);
  assert.equal(calls, 1);
  await assert.rejects(createMinuteHistoryLoader(async () => null)({ from: 0, to: 60 }), /unavailable/);
});
