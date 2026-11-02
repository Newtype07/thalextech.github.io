import test from "node:test";
import assert from "node:assert/strict";
import { planSkewHistory } from "./skew-history-plan.js";
import { emptyArchive } from "./history-cache.js";
import { buildHistoricalSkew } from "./skew.js";
import { constantMaturityHistory } from "./constant-maturity.js";
const HOUR = 3600, DAY = 86400, close = 1_800_000_000, ts = close - HOUR;
const strikes = [60, 70, 80, 90, 95, 100, 105, 110, 120, 130, 150];
const chain = [5, 10, 50].flatMap(days => strikes.flatMap(strike => ["C", "P"].map(side => ({
  name: `${days}-${strike}-${side}`, expiry: close + days * DAY, strike, side,
}))));
const iv = i => i.side === "C" ? 0.5 : 0.6;
const seedIvs = new Map(chain.map(i => [i.name, iv(i)]));
const options = cache => ({ chain, cache, spots: new Map([[ts, 100]]), hours: [ts], delta: .25, tenors: [30], seedIvs });
const fill = (cache, requests, empty = new Set()) => {
  for (const { instrument, hours } of requests) {
    if (!cache.marks.has(instrument.name)) cache.marks.set(instrument.name, { ...instrument, rows: new Map() });
    for (const hour of hours) {
      if (empty.has(instrument.name)) cache.checked.set(instrument.name, [{ from: hour, to: hour + HOUR - 1, expires: Date.now() + 60000 }]);
      else cache.marks.get(instrument.name).rows.set(hour, iv(instrument));
    }
  }
};

test("delta planning selects only the two tenor brackets and adjacent real wing inputs", () => {
  const cache = emptyArchive(), first = planSkewHistory(options(cache));
  assert.equal(first.requests.length, 8, "two strikes per side, two maturity inputs, instead of the full chain");
  assert.ok(first.requests.every(p => p.instrument.expiry !== close + 5 * DAY));
  assert.equal(first.readyHours.size, 0);
  fill(cache, first.requests);
  const complete = planSkewHistory(options(cache));
  assert.equal(complete.requests.length, 0); assert.ok(complete.readyHours.has(ts));
  const quotes = [...cache.marks.values()].map(i => ({ ...i, ts: close, iv: i.rows.get(ts), spot: 100 }));
  const sparse = constantMaturityHistory(buildHistoricalSkew({ quotes, delta: .25 }), [30]);
  const full = constantMaturityHistory(buildHistoricalSkew({ quotes: chain.map(i => ({ ...i, ts: close, iv: iv(i), spot: 100 })), delta: .25 }), [30]);
  assert.equal(sparse.length, 1); assert.ok(Math.abs(sparse[0].skew - full[0].skew) < 1e-12);
});

test("confirmed empty inputs expand the strike search; failures and expired checks remain unresolved", () => {
  const cache = emptyArchive(), first = planSkewHistory(options(cache));
  const missing = first.requests[0].instrument.name;
  fill(cache, first.requests, new Set([missing]));
  const wider = planSkewHistory(options(cache));
  assert.ok(wider.requests.length > 0);
  assert.ok(wider.requests.every(p => p.instrument.name !== missing));
  assert.equal(wider.readyHours.size, 0);
  for (let round = 0; round < 10; round++) {
    const next = planSkewHistory(options(cache)); if (!next.requests.length) break; fill(cache, next.requests);
  }
  assert.ok(planSkewHistory(options(cache)).readyHours.has(ts));
  const failed = emptyArchive(); fill(failed, first.requests.slice(1));
  assert.ok(planSkewHistory(options(failed)).requests.some(p => p.instrument.name === missing));
});

test("selection uses each hour's spot, combines envelopes by name, and never pulls a future listing", () => {
  const cache = emptyArchive();
  const pastHours = [ts - 2 * HOUR, ts - HOUR, ts];
  const plan = planSkewHistory({ ...options(cache), spots: new Map([[ts - 2 * HOUR, 85], [ts - HOUR, 115], [ts, 85]]), hours: pastHours });
  assert.ok(plan.requests.some(p => p.hours.size === 2));
  assert.ok(plan.requests.every(p => [...p.hours].every(h => pastHours.includes(h))));
  const future = chain.map(i => i.expiry === close + 50 * DAY ? { ...i, listedAt: ts + 1 } : i);
  const noFuture = planSkewHistory({ ...options(cache), chain: future });
  assert.ok(noFuture.requests.every(p => p.instrument.expiry !== close + 50 * DAY));
});

test("seed IVs never become observations and non-fetchable cached strikes do not fan out", () => {
  const cache = emptyArchive();
  const plan = planSkewHistory({ ...options(cache), chain: chain.map(i => ({ ...i, fetchable: false })) });
  assert.equal(plan.requests.length, 0);
  assert.equal(cache.marks.size, 0);
});
