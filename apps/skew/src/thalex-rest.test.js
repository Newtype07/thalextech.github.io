import test from "node:test";
import assert from "node:assert/strict";
import { createThalexClient, retryAfterMs } from "./thalex-rest.js";
import { ThalexTokenBucket } from "./thalex-rate-limit.js";
const ok = (value) => ({ ok: true, json: async () => ({ result: value }) });
test("Retry-After accepts seconds and HTTP dates", () => {
  assert.equal(retryAfterMs("2"), 2000);
  assert.equal(
    retryAfterMs(
      "Wed, 21 Oct 2015 07:28:00 GMT",
      Date.UTC(2015, 9, 21, 7, 27, 50),
    ),
    10000,
  );
  assert.equal(retryAfterMs(""), 0);
  assert.equal(retryAfterMs("invalid"), 0);
});
test("429 honors Retry-After and re-enters the shared bucket without a retry burst", async () => {
  let time = 100000,
    calls = 0;
  const starts = [];
  const bucket = new ThalexTokenBucket({
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
  });
  const client = createThalexClient({
    bucket,
    random: () => 0,
    fetchImpl: async () => {
      starts.push(time);
      return ++calls === 1
        ? {
            ok: false,
            status: 429,
            headers: new Headers({ "Retry-After": "20" }),
          }
        : ok([1]);
    },
  });
  assert.deepEqual(await client("instruments"), [1]);
  assert.deepEqual(starts, [100000, 120250]);
});

test("a 429 pauses other queued requests too, and they resume one token at a time", async () => {
  let time = 100000;
  const starts = [];
  const bucket = new ThalexTokenBucket({
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
  });
  const client = createThalexClient({
    bucket,
    maxConcurrent: 1,
    random: () => 0,
    fetchImpl: async (url) => {
      starts.push({ url, time });
      return starts.length === 1
        ? {
            ok: false,
            status: 429,
            headers: new Headers({ "Retry-After": "3" }),
          }
        : ok(1);
    },
  });
  await Promise.all([client("one"), client("two"), client("three")]);
  assert.equal(starts.length, 4);
  assert.equal(starts[0].time, 100000);
  assert.deepEqual(
    starts.slice(1).map((s) => s.time),
    [110250, 110500, 110750],
  );
});
test("opaque CORS/network errors also trigger shared cooldown and have only one retry", async () => {
  let time = 0,
    calls = 0;
  const bucket = new ThalexTokenBucket({
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
  });
  const client = createThalexClient({
    bucket,
    random: () => 0,
    fetchImpl: async () => {
      calls++;
      throw new TypeError("Failed to fetch");
    },
  });
  await assert.rejects(client("instruments"), TypeError);
  assert.equal(calls, 2);
  assert.ok(time >= 10250);
});

test("refresh adapts to a tighter upstream budget instead of repeating 429s at the same rate", async () => {
  let time = 0,
    previous = -Infinity,
    rejected = 0;
  const bucket = new ThalexTokenBucket({
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
  });
  const starts = [];
  const client = createThalexClient({
    bucket,
    random: () => 0,
    fetchImpl: async () => {
      starts.push(time);
      // Another client on the IP has left us only five requests/second.
      if (time - previous < 200) {
        rejected++;
        return { ok: false, status: 429, headers: new Headers() };
      }
      previous = time;
      return ok(1);
    },
  });
  for (let i = 0; i < 30; i++) assert.equal(await client(`quote-${i}`), 1);
  assert.equal(rejected, 1);
  assert.equal(starts[2] - starts[1], 10250);
  assert.ok(starts.slice(3).every((ts, i) => ts - starts[i + 2] >= 250));
});

test("concurrent refresh queues pace every REST start, including on first load", async () => {
  let time = 0,
    finished = false;
  const timers = [],
    starts = [];
  const bucket = new ThalexTokenBucket({
    now: () => time,
    sleep: (ms) =>
      new Promise((resolve) => timers.push({ at: time + ms, resolve })),
  });
  const options = {
    bucket,
    fetchImpl: async () => {
      starts.push(time);
      return ok(1);
    },
  };
  const clients = [createThalexClient(options), createThalexClient(options)];
  const pending = Promise.all(
    Array.from({ length: 140 }, (_, i) => clients[i % 2](`quote-${i}`)),
  ).then(() => {
    finished = true;
  });
  while (!finished) {
    await new Promise((resolve) => setImmediate(resolve));
    if (finished) break;
    assert.ok(timers.length, "pending requests must be waiting on pacing");
    time = Math.min(...timers.map((timer) => timer.at));
    for (let i = timers.length - 1; i >= 0; i--)
      if (timers[i].at <= time) timers.splice(i, 1)[0].resolve();
  }
  await pending;
  assert.equal(starts.length, 140);
  assert.equal(starts[0], 0);
  assert.ok(starts.slice(1).every((ts, i) => ts - starts[i] >= 125));
});
test("identical in-flight requests share one call, with cancellation scoped to their signal", async () => {
  let complete,
    calls = 0;
  const client = createThalexClient({
    fetchImpl: () => {
      calls++;
      return new Promise((resolve) => {
        complete = resolve;
      });
    },
  });
  const controller = new AbortController();
  const first = client("ticker", { b: 2, a: 1 }, controller.signal),
    second = client("ticker", { a: 1, b: 2 }, controller.signal);
  assert.equal(first, second);
  await new Promise((resolve) => setImmediate(resolve));
  complete(ok(42));
  assert.deepEqual(await Promise.all([first, second]), [42, 42]);
  assert.equal(calls, 1);
});
test("concurrency is bounded and a cancelled queued job never fetches or consumes budget", async () => {
  let started = 0,
    tokens = 0;
  const responses = [];
  const client = createThalexClient({
    maxConcurrent: 2,
    bucket: {
      take: async () => {
        tokens++;
      },
    },
    fetchImpl: () => {
      started++;
      return new Promise((resolve) => responses.push(resolve));
    },
  });
  const first = client("one"),
    second = client("two");
  const controller = new AbortController(),
    queued = client("three", {}, controller.signal);
  controller.abort();
  await assert.rejects(queued, { name: "AbortError" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started, 2);
  assert.equal(tokens, 2);
  responses.forEach((resolve) => resolve(ok(1)));
  await Promise.all([first, second]);
});
test("non-retryable HTTP errors do not loop", async () => {
  let calls = 0;
  const client = createThalexClient({
    fetchImpl: async () => {
      calls++;
      return { ok: false, status: 400 };
    },
  });
  await assert.rejects(client("bad"), /HTTP 400/);
  assert.equal(calls, 1);
});

test("a successful HTML fallback is identified as a missing proxy, not parsed or retried", async () => {
  let calls = 0,
    parsed = false;
  const client = createThalexClient({
    baseUrl: "/thalex-api",
    fetchImpl: async () => {
      calls++;
      return {
        ok: true,
        headers: new Headers({ "Content-Type": "text/html" }),
        json: async () => {
          parsed = true;
          throw new SyntaxError("Unexpected token <");
        },
      };
    },
  });
  await assert.rejects(
    client("instruments"),
    /Expected JSON from \/thalex-api\/instruments.*local API proxy is not active/,
  );
  assert.equal(parsed, false);
  assert.equal(calls, 1);
});

test("invalid JSON without a useful content-type still reports the failing endpoint", async () => {
  const client = createThalexClient({
    fetchImpl: async () => ({
      ok: true,
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    }),
  });
  await assert.rejects(
    client("instruments"),
    /Expected JSON from .*instruments/,
  );
});
