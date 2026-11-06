import test from "node:test";
import assert from "node:assert/strict";
import { createMarketProcess } from "./path.js";
import { YEAR } from "./forward-curve.js";
import { atmCurveFromQuotes, fetchForwardSnapshot } from "./live-curve.js";

function randoms(seed) {
  let x = seed >>> 0;
  const uniform = () => { x = (Math.imul(1664525, x) + 1013904223) >>> 0; return (x + .5) / 4294967296; };
  const normal = () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
  return { uniform, normal };
}
const DAY = 86400;
const regressionProfile = {
  status: "ready",
  variance: { kappa: 2000, theta: .2, initialVariance: .3, sigma: .4, rho: -.4 },
  jumps: { intensity: 10000, logMean: -.01, logStdDev: .02, logSecondMoment: .0005,
    compensatorMean: Math.exp(-.01 + .5 * .02 ** 2) - 1 },
};

test("seeded paths preserve pre-optimization results across curve boundaries and subdivided steps", () => {
  // Captured from the original engine. The next draw also detects changes to RNG consumption.
  const fixtures = [
    ["flat", "constant", 100.02164990093891, null, 0, 0, .6439828417496756],
    ["flat", "stochastic", 100.36975106838928, .19520898136388484, .20000050028349536, 0, .20223198004532605],
    ["flat", "jumps", 96.32486897588157, .20183242972429896, .20000050028349536, 58, .2565493598813191],
    ["forward", "constant", 100.34545728532498, null, 0, 0, .6439828417496756],
    ["forward", "stochastic", 100.36462255078042, .19331791982654256, .2000005003270947, 0, .1456752159865573],
    ["forward", "jumps", 96.32225505064869, .2022793933764592, .2000005003270947, 59, .6081761833047494],
  ];
  for (const [shape, dynamics, spot, variance, expectedVariance, capped, nextUniform] of fixtures) {
    const process = createMarketProcess({ horizon: 2 * DAY, shape, dynamics, rv: .4, rvMultiplier: .9,
      nodes: [{ seconds: DAY, iv: .5 }, { seconds: 2 * DAY, iv: .45 }], profile: regressionProfile });
    const state = process.createState(100), random = randoms(73);
    let time = 0;
    for (const seconds of [60, 3600, DAY - 3660 + 30, DAY - 30]) {
      process.advance(state, time, seconds, random.normal, random.uniform, .1);
      time += seconds;
    }
    assert.ok(Math.abs(state.spot - spot) < 1e-10, `${shape}/${dynamics} spot`);
    if (variance !== null) assert.ok(Math.abs(state.bates.variance - variance) < 1e-12);
    assert.ok(Math.abs(state.expectedVariance - expectedVariance) < 1e-12);
    assert.equal(state.cappedJumpSteps, capped);
    assert.equal(random.uniform(), nextUniform);
  }
});

test("interleaved paths keep their own execution parameters and leave calibration unchanged", () => {
  const profile = structuredClone(regressionProfile);
  const config = { horizon: 2 * DAY, shape: "forward", dynamics: "jumps", rvMultiplier: 1,
    nodes: [{ seconds: DAY, iv: .5 }, { seconds: 2 * DAY, iv: .45 }], profile };
  const process = createMarketProcess(config);
  const isolated = createMarketProcess(config);
  const a = process.createState(100), b = process.createState(150), expected = isolated.createState(100);
  const ra = randoms(7), rb = randoms(9), re = randoms(7);
  for (let time = 0; time < 2 * DAY; time += 3600) {
    process.advance(a, time, 3600, ra.normal, ra.uniform, .1);
    process.advance(b, time, 3600, rb.normal, rb.uniform, -.2);
    isolated.advance(expected, time, 3600, re.normal, re.uniform, .1);
    assert.equal(a.spot, expected.spot);
    assert.equal(a.bates.variance, expected.bates.variance);
  }
  assert.deepEqual(profile, regressionProfile);
});

test("flat and a flat forward curve produce identical paths and integrated variance", () => {
  const config = { horizon: 2 * DAY, rv: .5, dynamics: "constant" };
  const flat = createMarketProcess(config), forward = createMarketProcess({ ...config, shape: "forward", nodes: [{ seconds: 2 * DAY, iv: .5 }] });
  const a = flat.createState(100), b = forward.createState(100), ra = randoms(3), rb = randoms(3);
  for (let time = 0; time < 2 * DAY; time += 3600) {
    flat.advance(a, time, 3600, ra.normal, ra.uniform);
    forward.advance(b, time, 3600, rb.normal, rb.uniform);
    assert.ok(Math.abs(a.spot - b.spot) < 1e-10);
  }
  assert.ok(Math.abs(flat.totalVariance - .25 * 2 * DAY / YEAR) < 1e-12);
});

test("stochastic variance and jumps retain the forward variance allocation in each interval", () => {
  const nodes = [{ seconds: DAY, iv: .8 }, { seconds: 2 * DAY, iv: Math.sqrt(.34) }]; // second day variance .04
  const profile = { status: "ready", variance: { kappa: 8, theta: .25, initialVariance: .25, sigma: .3, rho: -.4 },
    jumps: { intensity: 20, logMean: -.01, logStdDev: .02, logSecondMoment: .0005,
      compensatorMean: Math.exp(-.01 + .5 * .02 ** 2) - 1 } };
  for (const dynamics of ["stochastic", "jumps"]) {
    const process = createMarketProcess({ horizon: 2 * DAY, shape: "forward", nodes, dynamics, profile });
    const random = randoms(73), sums = [0, 0];
    const count = 4000;
    for (let i = 0; i < count; i++) {
      const state = process.createState(100);
      for (let hour = 0; hour < 48; hour++) {
        const previous = state.spot;
        process.advance(state, hour * 3600, 3600, random.normal, random.uniform);
        sums[hour < 24 ? 0 : 1] += Math.log(state.spot / previous) ** 2;
      }
    }
    for (let bucket = 0; bucket < 2; bucket++) {
      const expected = process.varianceAt((bucket + 1) * DAY) - process.varianceAt(bucket * DAY);
      assert.ok(Math.abs(sums[bucket] / count / expected - 1) < .08, `${dynamics} bucket ${bucket}: ${sums[bucket] / count / expected}`);
    }
  }
});

test("live ATM snapshot interpolates variance, rejects stale quotes and discloses gaps", async () => {
  const expiry = 100000;
  const quotes = [{ expiry, strike: 90, iv: .4, ts: 0 }, { expiry, strike: 110, iv: .6, ts: 0 }];
  assert.ok(Math.abs(atmCurveFromQuotes(quotes, 100, 0)[0].iv ** 2 - .26) < 1e-12);
  assert.deepEqual(atmCurveFromQuotes(quotes, 100, 121), []);
  assert.deepEqual(atmCurveFromQuotes(quotes, 120, 0), []);
  const snapshot = await fetchForwardSnapshot({ asset: "BTC", spot: 100, now: () => 0,
    instruments: [90, 110].map(strike => ({ instrument_name: `BTC-X-${strike}-C`, expiration_timestamp: expiry, strike_price: strike })),
    request: async (_, args) => ({ iv: args.instrument_name.includes("-90-") ? .4 : .6, mark_timestamp: 0 }) });
  assert.equal(snapshot.nodes.length, 1);
  assert.ok(Math.abs(snapshot.nodes[0].iv ** 2 - .26) < 1e-12);
});
