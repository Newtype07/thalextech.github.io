import test from "node:test";
import assert from "node:assert/strict";
import { median } from "d3";
import { positionEnsemble } from "./simulation/position-ensemble.js";
import { simulatePosition } from "./simulation/position-simulation.js";

const config = (overrides = {}) => ({
  asset: "BTC", spot: 100000, horizon: 3600 + 17, step: 60,
  rvMultiplier: 1, drift: 0.1, threshold: 0.05, tolerance: 0.15,
  period: 1800, timing: "timer", hedgeBps: 1, optionBps: 1, seed: 4294967295,
  nodes: [{ seconds: 86400, iv: 0.6 }, { seconds: 7 * 86400, iv: 0.55 }],
  legs: [
    { optionType: "call", strike: 100000, maturity: 86400, signedQty: -1 },
    { optionType: "put", strike: 100000, maturity: 86400, signedQty: -1 },
  ],
  ...overrides,
});

function collect(input) {
  const batch = positionEnsemble(input);
  const progress = [];
  let next = batch.next();
  while (!next.done) {
    progress.push(next.value.completed);
    next = batch.next();
  }
  return { result: next.value, progress };
}

test("100 independent paths retain net accounting, exact exit and pointwise medians", () => {
  const input = config();
  const original = structuredClone(input);
  const { result, progress } = collect(input);
  assert.deepEqual(input, original);
  assert.deepEqual(progress, Array.from({ length: 100 }, (_, i) => i + 1));
  assert.equal(result.paths.length, 100);
  assert.equal(new Set(result.paths.map(path => path.seed)).size, 100);
  assert.ok(new Set(result.paths.map(path => path.pnl.at(-1))).size > 90);
  assert.equal(result.elapsed[0], 0);
  assert.equal(result.elapsed.at(-1), input.horizon);
  for (const path of result.paths) {
    const independent = simulatePosition({ ...input, seed: path.seed });
    assert.deepEqual(path.pnl, independent.rows.map(row => row.optionPnl + row.hedgePnl - row.fees));
    assert.ok(path.pnl[0] < 0, "entry option and hedge costs are included");
  }
  for (let i = 0; i < result.elapsed.length; i++) {
    assert.equal(result.median[i], median(result.paths.map(path => path.pnl[i])));
  }
  assert.deepEqual(collect(input).result, result, "a batch seed reproduces every path");
  assert.notDeepEqual(collect({ ...input, seed: 42 }).result.paths, result.paths);
});

test("long batches bound chart samples while preserving entry, exit and exact sampled P&Ls", () => {
  const input = config({ horizon: 86400, step: 60 });
  const { result } = collect(input);
  assert.equal(result.elapsed.length, 1200);
  assert.equal(new Set(result.elapsed).size, result.elapsed.length);
  assert.equal(result.elapsed[0], 0);
  assert.equal(result.elapsed.at(-1), input.horizon);
  const independent = simulatePosition(input);
  const ledger = new Map(independent.rows.map(row => [row.elapsed, row.pnl]));
  assert.deepEqual(result.paths[0].pnl, result.elapsed.map(time => ledger.get(time)));
});

test("batches preserve simulation validation and deterministic zero-volatility outcomes", () => {
  for (const seed of [-1, NaN, 1.5, 4294967296])
    assert.throws(() => collect(config({ seed })), /Check the simulation settings/);
  assert.throws(() => collect(config({ tolerance: 0.01 })), /Tolerance/);
  const { result } = collect(config({ rvMultiplier: 0, drift: 0 }));
  assert.ok(result.paths.every(path => path.pnl.every((pnl, i) => pnl === result.median[i])));
});
