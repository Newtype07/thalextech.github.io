import test from "node:test";
import assert from "node:assert/strict";
import {
  abortableDelay,
  RateLimitPausedError,
  ThalexTokenBucket,
} from "./thalex-rate-limit.js";
function clock() {
  let time = 100000;
  return {
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
    advance: (ms) => {
      time += ms;
    },
  };
}
function store() {
  let value;
  return {
    load: () => value && structuredClone(value),
    save: (state) => {
      value = structuredClone(state);
    },
    lock: (work) => Promise.resolve().then(work),
  };
}
test("100-request burst is followed by spaced starts, including after idle time", async () => {
  const time = clock(),
    bucket = new ThalexTokenBucket({ ...time, capacity: 100, refillPerSecond: 10 }),
    start = time.now();
  for (let i = 0; i < 100; i++) await bucket.take();
  assert.equal(time.now(), start);
  for (let i = 0; i < 10; i++) await bucket.take();
  assert.equal(time.now(), start + 1000);
  time.advance(60000);
  const before = time.now();
  await bucket.take();
  await bucket.take();
  assert.equal(time.now(), before + 100);
});
test("two clients/reloads pace requests from the first call", async () => {
  const time = clock(),
    shared = store();
  const first = new ThalexTokenBucket({ ...time, store: shared }),
    second = new ThalexTokenBucket({ ...time, store: shared });
  const start = time.now();
  for (let i = 0; i < 10; i++) await (i % 2 ? first : second).take();
  const reloaded = new ThalexTokenBucket({ ...time, store: shared });
  await reloaded.take();
  assert.equal(time.now(), start + 1250);
});
test("429 cooldown drains the bucket and resumes at refill rate, including other clients", async () => {
  const time = clock(),
    shared = store();
  const first = new ThalexTokenBucket({ ...time, store: shared }),
    second = new ThalexTokenBucket({ ...time, store: shared });
  const start = time.now();
  await first.take();
  await first.penalize(5000);
  await second.take();
  assert.equal(time.now(), start + 5125);
  await first.take();
  assert.equal(time.now(), start + 5250);
});
test("repeated shared failures open the circuit rather than sending every queued request", async () => {
  const time = clock(),
    bucket = new ThalexTokenBucket(time);
  for (let i = 0; i < 5; i++) await bucket.penalize(1000);
  await assert.rejects(bucket.take(), RateLimitPausedError);
  const start = time.now();
  time.advance(30000);
  await bucket.take();
  assert.equal(time.now(), start + 30125);
});
test("default pacing has no initial burst and leaves headroom below 10/s", async () => {
  const time = clock(),
    bucket = new ThalexTokenBucket(time),
    starts = [];
  for (let i = 0; i < 200; i++) {
    await bucket.take();
    starts.push(time.now());
  }
  assert.equal(starts.at(-1) - starts[0], 24875);
  assert.ok(starts.slice(1).every((ts, i) => ts - starts[i] >= 125));
  time.advance(60000);
  const idleEnd = time.now();
  await bucket.take();
  await bucket.take();
  assert.equal(time.now(), idleEnd + 125);
});
test("a saved 100-token allowance is clamped on upgrade instead of bursting again", async () => {
  const time = clock(), shared = store();
  const old = new ThalexTokenBucket({ ...time, store: shared, capacity: 100 });
  await old.take();
  const previousStart = time.now();
  const upgraded = new ThalexTokenBucket({ ...time, store: shared });
  const starts = [];
  for (let i = 0; i < 4; i++) {
    await upgraded.take();
    starts.push(time.now());
  }
  assert.equal(starts[0] - previousStart, 125);
  assert.ok(starts.slice(1).every((ts, i) => ts - starts[i] >= 125));
  assert.ok(shared.load().tokens <= 1);
});
test("legacy saved budget migrates without replenishing spent burst credit", async () => {
  const time = clock(),
    shared = store();
  shared.save({
    tokens: 0,
    updatedAt: time.now(),
    blockedUntil: 0,
    circuitUntil: 0,
  });
  const bucket = new ThalexTokenBucket({ ...time, store: shared });
  const start = time.now();
  await bucket.take();
  await bucket.take();
  assert.equal(time.now(), start + 250);
});
test("429 slowdown survives reload and recovers gradually without a burst", async () => {
  const time = clock(),
    shared = store(),
    first = new ThalexTokenBucket({ ...time, store: shared });
  const start = time.now();
  await first.take();
  await first.penalize(10000, { reduceRate: true });
  const reloaded = new ThalexTokenBucket({ ...time, store: shared });
  await reloaded.take();
  assert.equal(time.now(), start + 10250);
  await first.take();
  assert.equal(time.now(), start + 10500);
  await first.penalize(10000, { reduceRate: true });
  await reloaded.take();
  assert.equal(time.now(), start + 21000);
  assert.equal(shared.load().ratePerSecond, 2);
  time.advance(60000);
  await reloaded.take();
  assert.equal(shared.load().ratePerSecond, 3);
  const before = time.now();
  await first.take();
  assert.equal(time.now(), before + 334);
});
test("cancellation during token/cooldown wait is immediate and costs no token", async () => {
  const bucket = new ThalexTokenBucket();
  await bucket.penalize(10000);
  const controller = new AbortController(),
    pending = bucket.take(controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  await assert.rejects(abortableDelay(10000, controller.signal), {
    name: "AbortError",
  });
});
