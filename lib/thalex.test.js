import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchAllInstruments, fetchIndexHistory, fetchMarkHistory } from './thalex.js';
import { createMinuteHistoryLoader } from './minute-history.js';

const options = { instrument_name: 'BTC-09OCT26-70000-P', index_name: 'BTCUSD', resolution: '1h', from: 1780000000, to: 1780100000, requestOptions: { maxRetries: 0 } };

for (const [label, fetchHistory, field] of [
  ['mark', fetchMarkHistory, 'mark'],
  ['index', fetchIndexHistory, 'index'],
]) {
  test(`${label} history accepts explicit no_data but rejects missing or malformed rows`, async t => {
    let payload;
    t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => payload }));
    payload = { result: { instrument_type: 'option', no_data: true } };
    assert.deepEqual(await fetchHistory(options), []);
    payload = { result: { [field]: [] } };
    assert.deepEqual(await fetchHistory(options), []);
    // These exact empty envelopes were observed on the live Thalex REST API.
    for (const empty of [{ result: {} }, { result: { instrument_type: 'option' } }]) {
      payload = empty;
      assert.deepEqual(await fetchHistory(options), []);
    }
    for (const invalid of [{}, { result: null }, { result: [] }, { result: { unexpected: true } }, { result: { no_data: false } }, { result: { no_data: true, [field]: {} } }]) {
      payload = invalid;
      await assert.rejects(fetchHistory(options), /Invalid history response/);
    }
    payload = { result: { [field]: [[1790812800, 10, 12, 9, 11]] } };
    const rows = await fetchHistory(options);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].ts, 1790812800);
    assert.equal(rows[0][field === 'mark' ? 'mark_price_close' : 'index_price_close'], 11);
  });
}

test('instrument choices request only options for the selected underlying', async t => {
  let requested;
  t.mock.method(globalThis, 'fetch', async url => {
    requested = new URL(url);
    return { ok: true, json: async () => ({ result: [] }) };
  });
  await fetchAllInstruments({ underlying: 'ETHUSD', instrument_type: 'options' });
  assert.equal(requested.searchParams.get('underlying'), 'ETHUSD');
  assert.equal(requested.searchParams.get('instrument_type'), 'options');
});

test('all six mark-history pages survive a loader reload and expire after five minutes', async t => {
  const previousWindow = globalThis.window;
  const saved = new Map();
  globalThis.window = { localStorage: {
    getItem: key => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, value),
    removeItem: key => saved.delete(key),
  } };
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const requests = [];
  t.mock.method(globalThis, 'fetch', async url => {
    const query = new URL(url).searchParams;
    const from = Number(query.get('from'));
    const to = Number(query.get('to'));
    requests.push([from, to]);
    const mark = [];
    for (let ts = from; ts < to; ts += 60) mark.push([ts, 10, 12, 9, 11, .5, .5, .5, .5]);
    return { ok: true, json: async () => ({ result: { instrument_type: 'option', mark } }) };
  });

  const query = { instrument_name: options.instrument_name, from: 0, to: 660 };
  const freshLoader = () => createMinuteHistoryLoader(fetchMarkHistory, { pageSize: 2, concurrency: 3 });
  const initial = await freshLoader()(query);
  assert.equal(initial.length, 12);
  assert.equal(requests.length, 6);

  // Discard the loader's memory cache, retaining only simulated localStorage.
  assert.deepEqual(await freshLoader()(query), initial);
  assert.equal(requests.length, 6, 'a reload must reuse every fresh saved page');

  now += 5 * 60 * 1000 + 1;
  assert.deepEqual(await freshLoader()(query), initial);
  assert.equal(requests.length, 12, 'expired pages must be fetched again');
});
