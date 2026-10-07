import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchIndexHistoryInChunks } from './indexHistory.js';
import { fetchIndexHistory } from '../../../../lib/thalex.js';

const interval = 3600;
const rows = Array.from({ length: 10000 }, (_, index) => ({
  ts: index * interval,
  index_price_close: 80000 + index,
}));
const params = {
  index_name: 'BTCUSD', resolution: '1h',
  from: rows[0].ts, to: rows.at(-1).ts, count: rows.length,
};

test('loads all 10,000 hourly points in bounded requests, ordered oldest first', async () => {
  const requests = [];
  const result = await fetchIndexHistoryInChunks(params, async chunk => {
    requests.push(chunk);
    return rows.filter(row => row.ts >= chunk.from && row.ts <= chunk.to).slice(-chunk.count);
  });
  assert.deepEqual(result, rows);
  assert.equal(requests.length, 7);
  assert.ok(requests.every(chunk => chunk.count <= 1440 && chunk.resolution === '1h'));
  assert.equal(requests.at(-1).count, 1360);
  for (let index = 1; index < requests.length; index++) {
    assert.equal(requests[index].to, result[result.length - index * 1440].ts - 1);
  }
});

test('keeps the default 800-point history to one request', async () => {
  let calls = 0;
  const recent = rows.slice(-800);
  const result = await fetchIndexHistoryInChunks({ ...params, from: recent[0].ts, count: 800 }, async chunk => {
    calls++;
    assert.equal(chunk.count, 800);
    return recent;
  });
  assert.deepEqual(result, recent);
  assert.equal(calls, 1);
});

test('continues after short pages and stops when older data is unavailable', async () => {
  const available = rows.slice(-5);
  let calls = 0;
  const result = await fetchIndexHistoryInChunks(params, async chunk => {
    calls++;
    return available.filter(row => row.ts <= chunk.to).slice(-2);
  });
  assert.deepEqual(result, available);
  assert.equal(calls, 4);
});

test('deduplicates rows and discards timestamps outside the requested range', async () => {
  const result = await fetchIndexHistoryInChunks({ ...params, from: 0, to: interval * 2, count: 3 }, async () => [
    rows[2], rows[1], rows[1], rows[0], { ts: -1 }, { ts: interval * 3 }, { ts: NaN },
  ]);
  assert.deepEqual(result, rows.slice(0, 3));
});

test('propagates failed or canceled pages instead of returning partial history', async () => {
  let calls = 0;
  await assert.rejects(fetchIndexHistoryInChunks(params, async () => {
    if (++calls === 1) return rows.slice(-1440);
    throw new Error('Request canceled');
  }), /Request canceled/);
  assert.equal(calls, 2);
});

test('loads every page through the real history adapter with local caching enabled', async t => {
  const storage = new Map();
  const originalWindow = globalThis.window;
  globalThis.window = {
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key),
    },
  };
  t.after(() => {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    calls++;
    const query = new URL(url).searchParams;
    const page = rows.filter(row => row.ts >= Number(query.get('from')) &&
      row.ts <= Number(query.get('to'))).slice(-Number(query.get('count')));
    return {
      ok: true,
      json: async () => ({ result: { index: page.map(row => [row.ts, 1, 1, 1, row.index_price_close]) } }),
    };
  });
  const result = await fetchIndexHistoryInChunks(params, fetchIndexHistory);
  assert.deepEqual(result.map(row => [row.ts, row.index_price_close]), rows.map(row => [row.ts, row.index_price_close]));
  assert.equal(calls, 7);
  assert.deepEqual(await fetchIndexHistoryInChunks(params, fetchIndexHistory), result);
  assert.equal(calls, 7, 'A repeat load reuses cached pages without truncating the range');
});
