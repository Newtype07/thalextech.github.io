import test from "node:test";
import assert from "node:assert/strict";
import { createDeltaHedge, replayDeltaHedge, normalizeHedgePolicy } from "./index.js";
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);

test("the dynamic threshold timer resets inside the band and measures delta from the last hedge", () => {
  const engine = createDeltaHedge({ threshold: .05, tolerance: .15, period: 120 }, { observationSeconds: 60 });
  const rows = [.5, .56, .54, .57, .58, .59, .60, .80].map((delta, i) =>
    engine.observe({ time: i * 60, price: 100, delta, phase: i ? "observe" : "entry" }));
  assert.deepEqual(rows.map(row => row.reason), ["entry", null, null, null, null, "timer", null, "tolerance"]);
  near(rows[5].fill.amount, -.09);
  near(rows[6].netDelta, .01);
  near(rows[7].fill.amount, -.21);
});

test("sustained breach resets on a V-shaped return; tolerance bypasses the timer", () => {
  const engine = createDeltaHedge({ threshold: .05, tolerance: .15, period: 120, entry: "policy" });
  const rows = [[0, 100, .1], [60, 90, .04], [120, 95, .1], [180, 100, .16], [240, 110, -.1]]
    .map(([time, price, delta]) => engine.observe({ time, price, delta }));
  assert.deepEqual(rows.map(row => row.reason), [null, null, null, "tolerance", "tolerance"]);
  near(rows[3].position, -.16); near(rows[4].position, .1);
});

test("fills reconcile cash, realized/unrealized, reversals and fees independently", () => {
  const { rows, trades } = replayDeltaHedge([
    { time: 0, price: 100, delta: .5 }, { time: 60, price: 120, delta: 1 },
    { time: 120, price: 90, delta: -.3 }, { time: 180, price: 110, delta: -.2 },
  ], { threshold: 0, tolerance: 0, period: 0, hedgeBps: 2 });
  let cash = 0, position = 0, fees = 0;
  for (const row of rows) {
    if (row.fill) { cash -= row.fill.amount * row.price; position += row.fill.amount; fees += Math.abs(row.fill.amount * row.price) * .0002; }
    near(row.grossPnl, cash + position * row.price); near(row.fees, fees);
    near(row.netPnl, row.grossPnl - fees); near(row.realized + row.unrealized, row.grossPnl);
  }
  assert.equal(trades.at(-1).reason, "exit"); near(rows.at(-1).position, 0);
  near(trades.at(-1).netDeltaAfter, -.2); // The option has not been closed by the hedge ledger.
});

test("gaps and missing risk restart the breach timer without fabricating fills", () => {
  const engine = createDeltaHedge({ entry: "policy", period: 120, tolerance: 0 }, { observationSeconds: 60 });
  const observe = (time, delta) => engine.observe({ time, price: 100, delta });
  observe(0, .1); assert.equal(observe(180, .1).gap, true);
  assert.equal(observe(240, null).missingRisk, true);
  assert.equal(observe(300, .1).reason, null);
  assert.equal(observe(360, .1).reason, null);
  assert.equal(observe(420, .1).reason, "timer");
});

test("scheduled deadlines survive irregular observations and tolerance does not shift the anchor", () => {
  const engine = createDeltaHedge({ entry: "policy", timing: "scheduled", period: 100, tolerance: .2 });
  const observe = (time, delta) => engine.observe({ time, price: 100, delta });
  observe(1000, .1); assert.equal(observe(1090, .3).reason, "tolerance");
  assert.equal(observe(1110, .1).reason, "scheduled");
  assert.equal(observe(1190, .2).reason, null);
  assert.equal(observe(1210, .2).reason, "scheduled");
});

test("zero tolerance disables overrides; equality holds; invalid settings reject", () => {
  assert.throws(() => normalizeHedgePolicy({ threshold: .2, tolerance: .1 }), /Tolerance/);
  assert.throws(() => normalizeHedgePolicy({ timing: "scheduled", period: 0 }), /positive/);
  const engine = createDeltaHedge({ entry: "policy", threshold: .1, tolerance: 0, period: 60 });
  assert.equal(engine.observe({ time: 0, price: 100, delta: .1 }).reason, null);
  assert.equal(engine.observe({ time: 60, price: 100, delta: .2 }).reason, null);
  assert.equal(engine.observe({ time: 120, price: 100, delta: .2 }).reason, "timer");
});

test("entry neutralization waits for valid risk instead of treating missing delta as zero", () => {
  const engine = createDeltaHedge();
  assert.equal(engine.observe({ time: 0, price: 100, delta: null, phase: "entry" }).fill, null);
  const next = engine.observe({ time: 60, price: 100, delta: .01 });
  assert.equal(next.reason, "entry"); near(next.position, -.01);
});
