import assert from "node:assert/strict";
import test from "node:test";
import { inferOptionStop, hitsOptionStop } from "../src/lib/optionStopComparison.ts";

test("inferred stops spend the premium budget for either exposure direction", () => {
  for (const delta of [0.5, -0.5]) {
    const stop = inferOptionStop(100, delta, 5)!;
    assert.equal(stop.leverage, 10);
    assert.equal(delta * (stop.stopPrice - 100), -5);
    assert.equal(hitsOptionStop(100, stop), false);
    assert.equal(hitsOptionStop(stop.stopPrice, stop), true);
    assert.equal(hitsOptionStop(delta > 0 ? 80 : 120, stop), true);
  }
});

test("no inferred stop for credit, neutral, or unreachable downside exposure", () => {
  assert.equal(inferOptionStop(100, 0.5, -5), null);
  assert.equal(inferOptionStop(100, 0, 5), null);
  assert.equal(inferOptionStop(100, 0.01, 5), null);
});
