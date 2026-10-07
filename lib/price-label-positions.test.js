import test from 'node:test';
import assert from 'node:assert/strict';
import { priceLabelPositions } from './price-label-positions.js';

test('leaves well-separated labels on their intended baselines', () => {
  assert.deepEqual(priceLabelPositions([108, 60, 84], 14, 700), [108, 60, 84]);
});

test('balances the screenshot cluster instead of pushing BE and AWP down', () => {
  // Center Current, BE and AWP text on their lines at 90, 102 and 118.
  const targets = [90, 102, 118];
  const positions = priceLabelPositions(targets, 14, 700);
  assert.ok(positions[0] < targets[0]);
  assert.ok(positions.every((y, index) => Math.abs(y - targets[index]) < 3));
  assert.ok(Math.abs(positions.reduce((a, b) => a + b) - 310) < 1e-9);
  assert.equal(positions[1] - positions[0], 16);
  assert.equal(positions[2] - positions[1], 16);
});

test('centers equal-price labels while preserving input order', () => {
  assert.deepEqual(priceLabelPositions([100, 100, 100], 14, 700), [84, 100, 116]);
});

test('keeps labels within plot bounds with room between each', () => {
  for (const targets of [[1, 2, 3], [699, 700, 701], [700, 2, 1]]) {
    const positions = priceLabelPositions(targets, 14, 700);
    assert.ok(positions.every(y => y >= 14 && y <= 700));
    const sorted = [...positions].sort((a, b) => a - b);
    assert.ok(sorted[1] - sorted[0] >= 16 && sorted[2] - sorted[1] >= 16);
  }
  assert.deepEqual(priceLabelPositions([], 14, 700), []);
});
