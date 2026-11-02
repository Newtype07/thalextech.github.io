import test from "node:test";
import assert from "node:assert/strict";
import { ThalexTokenBucket, sharedBudgetStore } from "./thalex-rate-limit.js";
import { createThalexClient, getThalexQueueStatus } from "./thalex-rest.js";
import { requestThalex as skewRequest } from "../apps/skew/src/thalex-rest.js";
import { requestThalex as termRequest } from "../apps/term-structure/src/thalex-rest.js";

const ok = value => ({ ok: true, json: async () => ({ result: value }) });

test("Skew and Term Structure use the same transport instance", () => {
  assert.equal(skewRequest, termRequest);
});

test("public transport leaves headroom under the separately observed HTTP edge limit", () => {
  assert.equal(getThalexQueueStatus().ratePerSecond, 4);
});

test("exchange budget caps the first rolling second at 100, then dispatches at most 10/s", async () => {
  let now = 0;
  const starts = [];
  const bucket = new ThalexTokenBucket({ now: () => now, sleep: async ms => { now += ms; } });
  for (let i = 0; i < 250; i++) await bucket.take(undefined, () => starts.push(now));
  assert.deepEqual(starts.slice(0, 100), Array(100).fill(0));
  assert.equal(starts[100], 1000, "request 101 waits until the burst leaves the rolling window");
  assert.ok(starts.slice(101).every((ts, i) => ts - starts[i + 100] >= 100));
  for (const end of starts)
    assert.ok(starts.filter(ts => ts > end - 1000 && ts <= end).length <= 100);
  now += 60000;
  await bucket.take(undefined, () => starts.push(now));
  await bucket.take(undefined, () => starts.push(now));
  assert.equal(starts.at(-1) - starts.at(-2), 100, "idle time does not replenish burst permission");
});

test("separate clients and a reload share one budget under concurrent network dispatch", async () => {
  let now = 0, finished = false;
  const timers = [], starts = [];
  const store = sharedBudgetStore(`test-${Math.random()}`);
  const makeBucket = () => new ThalexTokenBucket({ store, now: () => now,
    sleep: ms => new Promise(resolve => timers.push({ at: now + ms, resolve })) });
  const options = () => ({ bucket: makeBucket(), fetchImpl: async () => { starts.push(now); return ok(1); } });
  const clients = [createThalexClient(options()), createThalexClient(options()), createThalexClient(options())];
  const pending = Promise.all(Array.from({ length: 450 }, (_, i) => clients[i % clients.length](`quote-${i}`)))
    .then(() => { finished = true; });
  while (!finished) {
    await new Promise(resolve => setImmediate(resolve));
    if (finished) break;
    assert.ok(timers.length);
    now = Math.min(...timers.map(timer => timer.at));
    for (let i = timers.length - 1; i >= 0; i--)
      if (timers[i].at <= now) timers.splice(i, 1)[0].resolve();
  }
  await pending;
  assert.equal(starts.length, 450);
  assert.equal(starts.filter(ts => ts < 1000).length, 100);
  assert.ok(starts.slice(101).every((ts, i) => ts - starts[i + 100] >= 100));
  assert.equal(now, 35900);
  const reloaded = createThalexClient({ bucket: new ThalexTokenBucket({ store, now: () => now,
    sleep: async ms => { now += ms; } }), fetchImpl: async () => { starts.push(now); return ok(1); } });
  await reloaded("after-reload");
  assert.equal(starts.at(-1) - starts.at(-2), 100);
});

test("HTTP 200 rate-limit errors drain burst credit and pause every queued retry", async () => {
  let now = 100000;
  const starts = [];
  const bucket = new ThalexTokenBucket({ now: () => now, sleep: async ms => { now += ms; } });
  const client = createThalexClient({ bucket, maxConcurrent: 1, random: () => 0,
    fetchImpl: async () => {
      starts.push(now);
      return starts.length === 1 ? { ok: true, headers: new Headers({ "Retry-After": "20" }),
        json: async () => ({ error: { code: 123, message: "Request rate limit exceeded" } }) } : ok(1);
    } });
  assert.deepEqual(await Promise.all([client("one"), client("two"), client("three")]), [1, 1, 1]);
  assert.deepEqual(starts, [100000, 120200, 120400, 120600]);
});

test("ordinary HTTP 200 API errors fail without retries", async () => {
  let calls = 0;
  const client = createThalexClient({ fetchImpl: async () => {
    calls++;
    return { ok: true, json: async () => ({ error: { code: 27, message: "Invalid instrument" } }) };
  } });
  await assert.rejects(client("invalid"), { message: "Invalid instrument", code: 27, isRateLimit: false });
  assert.equal(calls, 1);
});

test("callers cannot configure a larger burst or sustained rate than the exchange allows", () => {
  const bucket = new ThalexTokenBucket({ capacity: 1000, refillPerSecond: 1000 });
  assert.equal(bucket.capacity, 100);
  assert.equal(bucket.refillPerSecond, 10);
});

test("slow budget persistence cannot bunch actual network starts after their permissions", async () => {
  let now = 0, state, saves = 0;
  const starts = [];
  const bucket = new ThalexTokenBucket({ capacity: 1, refillPerSecond: 10,
    now: () => now, sleep: async ms => { now += ms; }, store: {
      load: () => state && structuredClone(state),
      save: value => { state = structuredClone(value); if (++saves === 1) now += 500; },
      lock: async work => work(),
    } });
  await bucket.take(undefined, () => starts.push(now));
  await bucket.take(undefined, () => starts.push(now));
  assert.deepEqual(starts, [0, 500]);
  assert.equal(state.starts.at(-1), starts.at(-1));
});
