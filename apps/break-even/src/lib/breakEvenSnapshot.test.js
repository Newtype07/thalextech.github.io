import test from 'node:test';
import assert from 'node:assert/strict';
import { calcConditionalWinningPrice, calcOptionNd2 } from './breakEvenSnapshot.js';

const year = 365.25 * 86400;

// Independently integrate the terminal distribution in standard-normal space.
// No CDF or conditional-moment formula from the implementation is used here.
function integrateInTheMoneyPrices({ optionType, spot, strike, iv, tauSeconds }) {
  const variance = iv * iv * tauSeconds / year;
  const sd = Math.sqrt(variance);
  const threshold = (Math.log(strike / spot) + variance / 2) / sd;
  const from = optionType === 'put' ? -10 : threshold;
  const to = optionType === 'put' ? threshold : 10;
  const steps = 12000;
  const dz = (to - from) / steps;
  let probability = 0;
  let moment = 0;
  for (let i = 0; i <= steps; i++) {
    const z = from + i * dz;
    const weight = i === 0 || i === steps ? 1 : i % 2 ? 4 : 2;
    const density = Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI);
    probability += weight * density;
    moment += weight * density * spot * Math.exp(-variance / 2 + sd * z);
  }
  return { probability: probability * dz / 3, mean: moment / probability };
}

test('conditional in-the-money prices match numerical integration beyond strike', () => {
  for (const optionType of ['call', 'put']) {
    const params = { optionType, spot: 100, strike: optionType === 'call' ? 110 : 90,
      iv: 0.6, tauSeconds: 30 * 86400 };
    const expected = integrateInTheMoneyPrices(params);
    const actual = calcConditionalWinningPrice(params);
    assert.ok(Math.abs(actual - expected.mean) < 0.00002);
    const probability = calcOptionNd2(params);
    assert.ok(Math.abs(probability - expected.probability) < 0.0000001);
    assert.ok(optionType === 'call' ? actual > params.strike : actual < params.strike);
  }
});

test('conditional means and complementary probabilities recover the unconditional spot mean', () => {
  const params = { spot: 100, strike: 110, iv: 0.8, tauSeconds: 90 * 86400 };
  const probability = calcOptionNd2({ ...params, optionType: 'call' });
  const upperMean = calcConditionalWinningPrice({ ...params, optionType: 'call' });
  const lowerMean = calcConditionalWinningPrice({ ...params, optionType: 'put' });
  assert.ok(Math.abs(probability * upperMean + (1 - probability) * lowerMean - params.spot) < 1e-10);
});

test('rare call and put wins retain a finite conditional price on the winning side', () => {
  for (const optionType of ['call', 'put']) {
    const params = { optionType, spot: 100, strike: optionType === 'call' ? 140 : 60,
      iv: 0.5, tauSeconds: 86400 };
    const probability = calcOptionNd2(params);
    assert.ok(probability > 0 && probability < 1e-20);
    const mean = calcConditionalWinningPrice(params);
    assert.ok(Number.isFinite(mean) && mean > 0);
    assert.ok(optionType === 'call' ? mean > params.strike : mean < params.strike);
  }
});

test('expiry and unavailable inputs do not fabricate an average winning price', () => {
  const params = { optionType: 'call', spot: 100, strike: 90, iv: 0.6, tauSeconds: 0 };
  assert.equal(calcConditionalWinningPrice(params), 100);
  assert.equal(calcConditionalWinningPrice({ ...params, strike: 110 }), null);
  assert.equal(calcConditionalWinningPrice({ ...params, strike: 100 }), null);
  assert.equal(calcConditionalWinningPrice({ ...params, optionType: 'put', strike: 110 }), 100);
  assert.equal(calcConditionalWinningPrice({ ...params, optionType: 'put' }), null);
  for (const invalid of [{ spot: 0 }, { strike: 0 }, { iv: null }, { iv: 0 }, { tauSeconds: null }]) {
    assert.equal(calcConditionalWinningPrice({ ...params, ...invalid }), null);
  }
});
