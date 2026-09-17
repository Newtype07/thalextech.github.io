import assert from "node:assert/strict";
import test from "node:test";
import type { AtmOptionExpiryQuote } from "../src/lib/atmOptionChain.ts";
import {
  closestExpirationTs,
  horizonOptionsForQuotes,
  maturityOptionsForQuotes,
  resolveHorizonSeconds,
  selectableExpiryQuotes,
} from "../src/lib/stopLossMaturity.ts";

const DAY = 24 * 60 * 60;
const valuationTs = 1_700_000_000;

const quote = (
  days: number,
  putInstrumentName: string | null = `BTC-${days}D-P`,
): AtmOptionExpiryQuote => ({
  expirationTs: valuationTs + days * DAY,
  strike: 60_000,
  callInstrumentName: `BTC-${days}D-C`,
  putInstrumentName,
  callIv: 0.5,
  putIv: 0.5,
  callMark: 1_000,
  putMark: 1_000,
  fetchedAt: valuationTs * 1_000,
});

test("maturity options represent distinct eligible listed expiries", () => {
  const quotes = [quote(7), quote(14), quote(21), quote(42)];
  const selectable = selectableExpiryQuotes(quotes, valuationTs, 14, "up");

  assert.deepEqual(maturityOptionsForQuotes(selectable, valuationTs), [
    { label: "14d [28 Nov 2023]", value: valuationTs + 14 * DAY },
    { label: "21d [05 Dec 2023]", value: valuationTs + 21 * DAY },
    { label: "42d [26 Dec 2023]", value: valuationTs + 42 * DAY },
  ]);
});

test("short maturity options exclude expiries without a matching put", () => {
  const quotes = [quote(21, null), quote(42)];

  assert.deepEqual(
    selectableExpiryQuotes(quotes, valuationTs, 14, "down").map(
      ({ expirationTs }) => expirationTs,
    ),
    [valuationTs + 42 * DAY],
  );
});

test("the initial selection keeps the listed expiry nearest the target", () => {
  const quotes = [quote(21), quote(42), quote(133)];

  assert.equal(
    closestExpirationTs(quotes, valuationTs + 60 * DAY),
    valuationTs + 42 * DAY,
  );
});

test("horizon options include listed maturity day counts", () => {
  const options = horizonOptionsForQuotes(
    [quote(21), quote(42)],
    valuationTs,
    [7, 14, 30],
  );

  assert.deepEqual(options.map(({ value }) => value), [7, 14, 21, 30, 42]);
});

test("a rounded maturity match caps the horizon at the exact expiry", () => {
  const expirationTs = valuationTs + 13.25 * DAY;
  const nearFourteenDayQuote = {
    ...quote(14),
    expirationTs,
  };

  assert.deepEqual(
    selectableExpiryQuotes(
      [nearFourteenDayQuote],
      valuationTs,
      14,
      "up",
    ),
    [nearFourteenDayQuote],
  );
  assert.equal(
    resolveHorizonSeconds(14, expirationTs, valuationTs),
    13.25 * DAY,
  );
});

test("the horizon never extends beyond a selected expiry", () => {
  assert.equal(
    resolveHorizonSeconds(30, valuationTs + 21 * DAY, valuationTs),
    21 * DAY,
  );
  assert.equal(
    resolveHorizonSeconds(14, valuationTs + 21 * DAY, valuationTs),
    14 * DAY,
  );
});
