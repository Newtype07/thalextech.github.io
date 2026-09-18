import test from 'node:test';
import assert from 'node:assert/strict';
import { calcOptionPrice, calcGreeks, computeGreeksPnlSeries } from '../../../lib/thalex.js';
import { calculateEndStateAttribution, calculatePathwiseAttribution, calculateAttribution } from '../src/lib/attribution.js';

const contract = { strike: 78000, optionType: 'call' };
const instrument = { strike_price: 78000, option_type: 'call', expiration_timestamp: 4000000 };
const entry = { spot: 78000, iv: 0.6, tteSeconds: 2500000 };
const marked = (state, spec = contract) => ({ ...state, mark: calcOptionPrice(state.spot, spec.strike, state.tteSeconds, state.iv, spec.optionType) });
const close = (actual, expected, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
const attribute = (state, spec = contract) => calculateEndStateAttribution(marked(entry, spec), marked(state, spec), spec);

for (const optionType of ['call', 'put']) {
  test(`${optionType}: flat state`, () => {
    for (const value of Object.values(attribute(entry, { ...contract, optionType }))) close(value, 0);
  });
  for (const [field, value, bucket] of [['spot', 82000, 'spot'], ['iv', 0.8, 'volatility'], ['tteSeconds', 2000000, 'time']]) {
    test(`${optionType}: pure ${field} change`, () => {
      const result = attribute({ ...entry, [field]: value }, { ...contract, optionType });
      close(result[bucket], result.total);
      for (const key of ['spot', 'volatility', 'time', 'residual'].filter(k => k !== bucket)) close(result[key], 0);
    });
  }
}

test('mixed change reconciles with actual marks including non-model effects', () => {
  const current = marked({ spot: 81000, iv: 0.7, tteSeconds: 2000000 });
  current.mark += 123;
  const result = calculateEndStateAttribution(marked(entry), current, contract);
  close(result.spot + result.volatility + result.time + result.residual, result.total);
  close(result.residual, 123);
});

const point = (state, ts) => ({
  date: new Date(ts * 1000), ts,
  index_price_close: state.spot, iv_close: state.iv,
  tte_seconds: state.tteSeconds, mark_price_close: marked(state).mark,
});

test('round trip is independent of intermediate observations and selected entry rebases', () => {
  const points = [point(entry, 1), point({ ...entry, spot: 75000 }, 2), point(entry, 3)];
  const result = calculateAttribution(points, instrument, 'end_state');
  close(result.spot.at(-1).value, 0);
  const direct = calculateAttribution([points[0], points[2]], instrument, 'end_state');
  for (const key of Object.keys(result)) close(result[key].at(-1).value, direct[key].at(-1).value);
  const rebased = calculateAttribution(points.slice(1), instrument, 'end_state');
  close(rebased.total[0].value, 0);
  assert.ok(rebased.spot.at(-1).value > 0);
});

test('Shapley averages all six orders, including interactions', () => {
  const current = { spot: 81000, iv: 0.8, tteSeconds: 1500000 };
  const expected = { spot: 0, volatility: 0, time: 0 };
  const names = { spot: 'spot', iv: 'volatility', tteSeconds: 'time' };
  for (const order of [['spot','iv','tteSeconds'], ['spot','tteSeconds','iv'], ['iv','spot','tteSeconds'], ['iv','tteSeconds','spot'], ['tteSeconds','spot','iv'], ['tteSeconds','iv','spot']]) {
    const state = { ...entry };
    for (const field of order) {
      const before = marked(state).mark;
      state[field] = current[field];
      expected[names[field]] += (marked(state).mark - before) / 6;
    }
  }
  const result = attribute(current);
  for (const key of Object.keys(expected)) close(result[key], expected[key]);
});

test('expiration and zero volatility have finite intrinsic values; missing IV remains unavailable', () => {
  for (const state of [{ ...entry, tteSeconds: 0 }, { ...entry, iv: 0 }]) {
    const result = attribute(state);
    assert.ok(Object.values(result).every(Number.isFinite));
    close(result.spot + result.volatility + result.time + result.residual, result.total);
  }
  const result = calculateEndStateAttribution(marked(entry), { ...marked(entry), iv: null }, contract);
  assert.ok(Number.isNaN(result.volatility));
  close(result.total, 0);
});

test('legacy pathwise accumulation skips first interval and retains its fallbacks', () => {
  const points = [
    { date: new Date(0), PL: 999, delta_PL: 999 },
    { date: new Date(1), PL: 20, delta_PL: 10, gamma_theta_PL: 4, vega_PL: 3, residual_PL: 2 },
    { date: new Date(2), PL: null, delta_PL: 2, gamma_theta_PL: null, vega_PL: 1, residual_PL: -1 },
  ];
  const result = calculatePathwiseAttribution(points);
  for (const [key, expected] of Object.entries({ total: [0, 20, 22], delta: [0, 10, 12], gammaTheta: [0, 4, 4], vega: [0, 3, 4], residual: [0, 2, 1] })) {
    assert.deepEqual(result[key].map(p => p.value), expected);
  }
});

test('mode switching preserves inputs, pathwise Greeks, and Total on continuous marks', () => {
  const spots = [78000, 75000, 78000];
  const index = spots.map((spot, n) => ({ ts: 1000 + n * 1000, index_price_open: spots[Math.max(0, n - 1)], index_price_close: spot }));
  const marks = spots.map((spot, n) => ({ ts: index[n].ts, iv_open: 0.6, iv_close: 0.6,
    mark_price_open: marked({ ...entry, spot: spots[Math.max(0, n - 1)] }).mark,
    mark_price_close: marked({ ...entry, spot }).mark,
  }));
  const points = computeGreeksPnlSeries({ mark: marks, index, instrument });
  const snapshot = structuredClone(points);
  const before = calculateAttribution(points, instrument, 'pathwise');
  const endpoint = calculateAttribution(points, instrument, 'end_state');
  const after = calculateAttribution(points, instrument, 'pathwise');
  assert.deepEqual(before, after);
  assert.deepEqual(points, snapshot);
  assert.deepEqual(before.total, endpoint.total);
  assert.ok(Math.abs(before.delta.at(-1).value) > 1);
  close(endpoint.spot.at(-1).value, 0);
  for (let n = 0; n < points.length; n++) {
    close(points[n].delta_PL, calcGreeks(index[n].index_price_open, 78000, instrument.expiration_timestamp - index[n].ts, 0.6).delta * (index[n].index_price_close - index[n].index_price_open));
  }
});

test('gapped candle marks retain legacy Total while endpoint Total uses actual mark difference', () => {
  const points = [point(entry, 1), { ...point({ ...entry, spot: 81000 }, 2), PL: 50, delta_PL: 40 }];
  const legacy = calculateAttribution(points, instrument, 'pathwise');
  const endpoint = calculateAttribution(points, instrument, 'end_state');
  close(legacy.total.at(-1).value, 50);
  close(endpoint.total.at(-1).value, points[1].mark_price_close - points[0].mark_price_close);
  assert.notEqual(legacy.total.at(-1).value, endpoint.total.at(-1).value);
});
