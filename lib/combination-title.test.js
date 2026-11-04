import test from "node:test";
import assert from "node:assert/strict";
import { formatCombinationTitle } from "./combination-title.js";

const november = Date.UTC(2026, 10, 27, 8) / 1000;
const december = Date.UTC(2026, 11, 25, 8) / 1000;
const leg = (overrides = {}) => ({
  expirationTs: november, strike: 78000, optionType: "call", signedQty: 1, ...overrides,
});

test("a shared maturity appears once, with explicit legs instead of a strategy name", () => {
  assert.equal(formatCombinationTitle([leg({ optionType: "put" }), leg()], "Bitcoin"),
    "Bitcoin · 27 Nov 2026 · 1 × 78K Call\u20021 × 78K Put");
});

test("mixed maturities annotate each leg and preserve signed quantities", () => {
  assert.equal(formatCombinationTitle([
    leg({ expirationTs: december, strike: 80500, signedQty: 2 }),
    leg({ signedQty: -1 }),
  ], "Bitcoin"), "Bitcoin · −1 × 27 Nov 2026 78K Call\u20022 × 25 Dec 2026 80.5K Call");
});

test("matching contracts net together; empty combinations retain the asset name", () => {
  assert.equal(formatCombinationTitle([leg({ signedQty: 3 }), leg({ signedQty: -1 })], "Bitcoin"),
    "Bitcoin · 27 Nov 2026 · 2 × 78K Call");
  assert.equal(formatCombinationTitle([leg(), leg({ signedQty: -1 })], "Bitcoin"), "Bitcoin");
  assert.equal(formatCombinationTitle([], "Ethereum"), "Ethereum");
});
