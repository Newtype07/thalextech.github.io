import assert from "node:assert/strict";
import test from "node:test";
import {
  buildScenarioSpotGrid,
  getScenarioSpotRange,
} from "./scenario-range.js";

const DAY = 24 * 60 * 60;
const YEAR = 365.25 * DAY;

test("centers the range on spot at plus or minus three scaled sigmas", () => {
  const range = getScenarioSpotRange({
    spot: 100_000,
    anchorTs: 1_000,
    expirationTimestamps: [1_000 + YEAR / 4],
  });

  assert.ok(range);
  assert.equal(range.minSpot, 40_000);
  assert.equal(range.maxSpot, 160_000);
});

test("uses the longest selected expiration", () => {
  const shortRange = getScenarioSpotRange({
    spot: 100_000,
    anchorTs: 1_000,
    expirationTimestamps: [1_000 + 7 * DAY],
  });
  const mixedRange = getScenarioSpotRange({
    spot: 100_000,
    anchorTs: 1_000,
    expirationTimestamps: [1_000 + 7 * DAY, 1_000 + 28 * DAY],
  });

  assert.ok(shortRange);
  assert.ok(mixedRange);
  assert.ok(mixedRange.maxSpot - 100_000 > shortRange.maxSpot - 100_000);
  assert.ok(mixedRange.minSpot < shortRange.minSpot);
});

test("shrinks with the remaining time selected by the T control", () => {
  const fullRange = getScenarioSpotRange({
    spot: 100_000,
    anchorTs: 1_000,
    expirationTimestamps: [1_000 + 90 * DAY],
  });
  const quarterTimeRange = getScenarioSpotRange({
    spot: 100_000,
    anchorTs: 1_000,
    expirationTimestamps: [1_000 + 90 * DAY],
    remainingTimeFraction: 0.25,
  });

  assert.ok(fullRange);
  assert.ok(quarterTimeRange);
  assert.equal(
    quarterTimeRange.maxSpot - 100_000,
    (fullRange.maxSpot - 100_000) / 2,
  );
});

test("builds an evenly spaced grid with spot at the center", () => {
  const grid = buildScenarioSpotGrid({
    spot: 100_000,
    anchorTs: 1_000,
    expirationTimestamps: [1_000 + 30 * DAY],
    pointCount: 91,
  });

  assert.equal(grid.length, 91);
  assert.equal(grid[45].scenarioSpot, 100_000);
  assert.ok(grid[0].scenarioSpot < 100_000);
  assert.ok(grid.at(-1).scenarioSpot > 100_000);
});
