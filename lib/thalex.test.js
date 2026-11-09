import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchAllInstruments, fetchIndexHistory, fetchMarkHistory } from './thalex.js';

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
