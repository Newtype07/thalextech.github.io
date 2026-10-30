import test from "node:test";
import assert from "node:assert/strict";
import { skewCurvePaths } from "./components/skew-curve.js";

const point = (expiry, skew, interpolated = false) => ({ expiry, skew, interpolated });
const x = expiry => expiry * 100;
const y = skew => skew * 100;

test("observed sections stay solid, while both intervals touching an estimate are dashed", () => {
  const points = Object.freeze([
    Object.freeze(point(0, -0.03)), Object.freeze(point(1, -0.04)),
    Object.freeze(point(2, -0.02, true)), Object.freeze(point(3, 0)), Object.freeze(point(4, 0.05)),
  ]);
  const paths = skewCurvePaths(points, x, y);
  assert.equal(paths.observed, "M0,-3L100,-4M300,0L400,5");
  assert.equal(paths.interpolated, "M100,-4L200,-2L300,0");
  assert.equal(points[2].interpolated, true);
});

test("multiple adjacent estimates form one dashed bridge; unbracketed ends remain empty", () => {
  const paths = skewCurvePaths([null, point(1, -0.03), point(2, -0.02, true), point(3, -0.01, true), point(4, 0), null], x, y);
  assert.equal(paths.interpolated, "M100,-3L200,-2L300,-1L400,0");
  assert.equal(paths.observed, "M97,-3h6M397,0h6");
  assert.ok(!paths.interpolated.includes("500,"));
});

test("a lone observation stays visible, empty curves have no path, and missing points are not silently bridged", () => {
  assert.deepEqual(skewCurvePaths([null, point(2, 0), null], x, y), { observed: "M197,0h6", interpolated: null });
  assert.deepEqual(skewCurvePaths([], x, y), { observed: null, interpolated: null });
  assert.deepEqual(skewCurvePaths([null, undefined], x, y), { observed: null, interpolated: null });
  assert.deepEqual(skewCurvePaths([point(0, -0.03), null, point(2, -0.05)], x, y), { observed: "M-3,-3h6M197,-5h6", interpolated: null });
});
