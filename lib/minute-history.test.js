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

const tick = () => new Promise(resolve => setImmediate(resolve));

test("concurrent pages share a loader-wide budget and in-flight requests", async () => {
  const requests = [];
  let active = 0, peak = 0;
  const load = createMinuteHistoryLoader(query => new Promise(resolve => {
    active++;
    peak = Math.max(peak, active);
    requests.push({ query, finish: () => {
      active--;
      resolve(Array.from({ length: 2 }, (_, i) => ({ ts: query.from + i * 60 })));
    } });
  }), { pageSize: 2, concurrency: 3 });
  const query = { index_name: "BTCUSD", from: 60, to: 660 };
  const first = load(query);
  const duplicate = load(query);
  const other = load({ ...query, index_name: "ETHUSD", to: 60 });
  await tick();
  assert.equal(requests.length, 3, "three pages start without waiting for earlier pages");
  requests[2].finish();
  await tick();
  assert.equal(requests.length, 4, "a completed page immediately frees a slot");
  let finished = new Set([requests[2]]);
  while (finished.size < 7) {
    for (const request of [...requests].reverse()) if (!finished.has(request)) {
      finished.add(request);
      request.finish();
    }
    await tick();
  }
  const [rows, duplicatedRows] = await Promise.all([first, duplicate, other]);
  assert.equal(peak, 3, "overlapping loads cannot multiply the request budget");
  assert.equal(requests.length, 7, "duplicates reuse all six BTC pages");
  assert.deepEqual(rows.map(row => row.ts), Array.from({ length: 11 }, (_, i) => (i + 1) * 60));
  assert.deepEqual(duplicatedRows, rows);
  assert.deepEqual(await load(query), rows);
  assert.equal(requests.length, 7, "completed pages remain cached");
});

test("failed in-flight pages can be retried, including synchronous provider failures", async () => {
  let calls = 0;
  const load = createMinuteHistoryLoader(() => {
    if (++calls === 1) throw new Error("offline");
    return [{ ts: 0 }];
  }, { concurrency: 3 });
  const query = { from: 0, to: 0 };
  const results = await Promise.allSettled([load(query), load(query)]);
  assert.ok(results.every(result => result.status === "rejected" && result.reason.message === "offline"));
  assert.equal(calls, 1);
  assert.deepEqual(await load(query), [{ ts: 0 }]);
  assert.equal(calls, 2);
});

test("obsolete parallel loads finish their active batch without paging the remaining window", async () => {
  let current = true;
  const requests = [];
  const load = createMinuteHistoryLoader(query => new Promise(resolve => {
    requests.push(() => resolve([{ ts: query.from }]));
  }), { pageSize: 2, concurrency: 3 });
  const result = load({ from: 0, to: 1200 }, () => current);
  await tick();
  assert.equal(requests.length, 3);
  current = false;
  requests.forEach(finish => finish());
  assert.deepEqual(await result, []);
  assert.equal(requests.length, 3);
});
