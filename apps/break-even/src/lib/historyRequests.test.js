import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryRequester } from './historyRequests.js';

function fixture(options = {}) {
  let time = 0;
  const request = createHistoryRequester({ ...options, now: () => time, sleep: async (ms) => { time += ms; } });
  return { request, now: () => time, advance: (ms) => { time += ms; } };
}

test('retries beyond the former limit and retains the chunk result', async () => {
  const { request } = fixture();
  let attempts = 0;
  const rows = [{ ts: 123 }];
  assert.equal(await request(async () => {
    if (++attempts <= 8) throw Object.assign(new Error('limited'), { status: 429 });
    return rows;
  }), rows);
  assert.equal(attempts, 9);
});

test('honors server cooldown and spaces queued requests after recovery', async () => {
  const { request, now } = fixture();
  const starts = [];
  let attempts = 0;
  await Promise.all([
    request(async () => {
      starts.push(now());
      if (++attempts === 1) throw Object.assign(new Error('limited'), { status: 429, retryAfterMs: 90000 });
    }),
    request(async () => starts.push(now())),
    request(async () => starts.push(now())),
  ]);
  assert.deepEqual(starts, [0, 90000, 90100, 90200]);
});

test('permanent errors reject instead of becoming empty histories', async () => {
  const { request } = fixture();
  await assert.rejects(request(async () => { throw Object.assign(new Error('bad request'), { status: 400 }); }), /bad request/);
  assert.equal(await request(async () => 'next'), 'next');
});

test('cancellation stops network-error retries and lets the next load proceed', async () => {
  const { request } = fixture();
  let canceled = false;
  let attempts = 0;
  await assert.rejects(request(async () => {
    attempts++;
    canceled = true;
    throw new TypeError('network');
  }, { isCanceled: () => canceled }), /canceled/);
  assert.equal(attempts, 1);
  assert.equal(await request(async () => 'new load'), 'new load');
});


test('allows 100 initial requests, then stays sequential at 10 requests per second', async () => {
  const { request, now } = fixture();
  const starts = [];
  let active = 0;
  let maxActive = 0;
  await Promise.all(Array.from({ length: 103 }, () => request(async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    starts.push(now());
    await Promise.resolve();
    active--;
  })));
  assert.deepEqual(starts, [...Array(100).fill(0), 100, 200, 300]);
  assert.equal(maxActive, 1);
});


test('network latency counts toward pacing without allowing catch-up bursts', async () => {
  const { request, now, advance } = fixture({ burstLimit: 0 });
  const starts = [];
  for (const latency of [40, 150, 10, 0]) {
    await request(async () => {
      starts.push(now());
      advance(latency);
    });
  }
  assert.deepEqual(starts, [0, 100, 250, 350]);
});

test('cached chunks bypass pacing, expire, and never cache failures', async () => {
  const { request, now, advance } = fixture({ burstLimit: 0, cacheTtlMs: 5000 });
  let calls = 0;
  const fetcher = async () => { calls++; return [{ ts: 1 }]; };
  const options = { cacheKey: 'mark:BTC:1h:0:360' };
  const rows = await request(fetcher, options);
  assert.equal(await request(fetcher, options), rows);
  assert.equal(now(), 0);
  assert.equal(calls, 1);
  advance(5000);
  await request(fetcher, options);
  assert.equal(calls, 2);
  await assert.rejects(request(async () => { throw new Error('invalid'); }, { cacheKey: 'failed' }));
  assert.equal(await request(async () => 'recovered', { cacheKey: 'failed' }), 'recovered');
});

test('queued identical chunks reuse the first successful response', async () => {
  const { request } = fixture();
  let calls = 0;
  const fetcher = async () => ++calls;
  assert.deepEqual(await Promise.all([
    request(fetcher, { cacheKey: 'same' }),
    request(fetcher, { cacheKey: 'same' }),
  ]), [1, 1]);
});
