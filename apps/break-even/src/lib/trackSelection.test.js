import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTrackProbabilityHistory, nearestTrack } from './trackSelection.js';

const day = 86400;
const start = 1700000000;
const date = offset => new Date((start + offset) * 1000);

test('probability history uses each observed IV and same-time index, omitting missing IV and projections', () => {
  const track = { optionType: 'call', strike: 100, referenceIv: 0.9, points: [
    { date: date(0), iv: 0.2 }, { date: date(day), iv: 0.8 },
    { date: date(2 * day), iv: null }, { date: date(3 * day), iv: 0.9 },
  ] };
  const index = [0, day, 2 * day].map(offset => ({ date: date(offset), value: 100 }));
  const rows = buildTrackProbabilityHistory(track, index, start + 365.25 * day);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].indexPrice, 100);
  assert.ok(rows[0].probability > rows[1].probability, 'historical IV changes must affect probability');
  const puts = buildTrackProbabilityHistory({ ...track, optionType: 'put' }, index, start + 365.25 * day);
  rows.forEach((row, i) => assert.ok(Math.abs(row.probability + puts[i].probability - 1) < 1e-12));
  assert.deepEqual(buildTrackProbabilityHistory(null, index, start + day), []);
});

test('same-time history follows the historical index instead of current spot', () => {
  const track = { optionType: 'call', strike: 100, points: [
    { date: date(0), iv: 0.5 }, { date: date(day), iv: 0.5 },
  ] };
  const rows = buildTrackProbabilityHistory(track, [
    { date: date(0), value: 80 }, { date: date(day), value: 120 },
  ], start + 30 * day);
  assert.ok(rows[0].probability < 0.1);
  assert.ok(rows[1].probability > 0.8);
});

test('hit testing selects the closest line segment within the hover radius', () => {
  const tracks = [
    { id: 'a', points: [[0, 20], [100, 20]] },
    { id: 'b', points: [[0, 28], [100, 28]] },
  ];
  assert.equal(nearestTrack(tracks, 50, 22, 10), 'a');
  assert.equal(nearestTrack(tracks, 50, 27, 10), 'b');
  assert.equal(nearestTrack(tracks, 50, 40, 10), null);
  assert.equal(nearestTrack(tracks, 105, 20, 10), 'a');
  assert.equal(nearestTrack(tracks, 111, 20, 10), null);
  assert.equal(nearestTrack([{ id: 'slope', points: [[0, 0], [100, 100]] }], 50, 60, 8), 'slope');
  assert.equal(nearestTrack([], 50, 50), null);
});

test('maturity changes match the same strike and option type without picking a substitute', async () => {
  const { findSameStrikeInstrument } = await import('./trackSelection.js');
  const selected = { strike: 90000, option_type_normalized: 'call' };
  const put = { instrument_name: 'new-put', strike: 90000, option_type_normalized: 'put' };
  const otherStrike = { instrument_name: 'other-call', strike: 95000, option_type_normalized: 'call' };
  const call = { instrument_name: 'new-call', strike: 90000, option_type_normalized: 'call' };
  assert.equal(findSameStrikeInstrument(selected, [put, otherStrike, call]), call);
  assert.equal(findSameStrikeInstrument(selected, [put, otherStrike]), null);
  assert.equal(findSameStrikeInstrument(null, [call]), null);
});
