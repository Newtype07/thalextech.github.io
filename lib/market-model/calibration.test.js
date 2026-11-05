import test from "node:test";
import assert from "node:assert/strict";
import { buildCalibrationProfile } from "./calibration.js";
import { validateCalibrationProfile } from "./profiles.js";
const rows = Array.from({ length: 120 * 24 }, (_, i) => ({ ts: (i + 1) * 3600, close: 100 * Math.exp(.03 * Math.sin(i * .47) + .02 * Math.sin(i * .07)) }));
test("profiles use only available history and retain fitted realized correlation", () => {
  const asOf = 90 * 86400;
  const options = { asset: "ETH", lookbackDays: 90, asOf, sourceHash: "test" };
  const profile = buildCalibrationProfile(rows, options);
  assert.equal(profile.status, "ready");
  assert.ok(Math.abs(profile.variance.rho) <= .99);
  assert.ok(profile.training.end <= asOf);
  assert.deepEqual(profile, buildCalibrationProfile(rows.filter(row => row.ts <= asOf), options));
  assert.equal(validateCalibrationProfile(profile, options), profile);
  assert.throws(() => validateCalibrationProfile(profile, { ...options, asOf: asOf - 1 }), /as-of/);
  assert.throws(() => validateCalibrationProfile(profile, { ...options, asset: "BTC" }), /asset/);
});
test("insufficient history is disclosed instead of becoming a calibrated zero", () => {
  const profile = buildCalibrationProfile(rows.slice(0, 100), { asset: "BTC", lookbackDays: 90, asOf: 90 * 86400 });
  assert.equal(profile.status, "unavailable"); assert.equal(profile.variance, null);
});
