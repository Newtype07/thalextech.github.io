import test from "node:test";
import assert from "node:assert/strict";
import { coneWindow, CONE_TENORS, constantTenorIv, impliedConeHistory, realizedConeHistory, buildVolatilityCone } from "./volatility-cone.js";
import { hourlyVariance } from "./realized-volatility.js";
import { buildHistoricalSeries } from "./volatility.js";
import { loadVolatilityConeData } from "./volatility-cone-data.js";

const DAY = 86400, HOUR = 3600;
const ts = Date.UTC(2026, 10, 8) / 1000;
const bar = t => ({ ts: t, open: 100, high: 102, low: 98, close: 101 });
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} ≈ ${expected}`);

test("cone lookbacks use calendar months, hourly below 180 days and daily otherwise", () => {
  const end = Date.UTC(2026, 2, 31, 17) / 1000;
  const month = coneWindow(end, "1m");
  assert.equal(month.from, Date.UTC(2026, 1, 28, 17) / 1000);
  assert.equal(month.to, Date.UTC(2026, 2, 31, 17) / 1000);
  assert.equal(month.timestamps.length, 31 * 24);
  assert.equal(month.timestamps[0], month.from + HOUR);
  assert.equal(coneWindow(Date.UTC(2024, 2, 31) / 1000, "1m").from, Date.UTC(2024, 1, 29) / 1000);
  assert.deepEqual(["1m", "3m", "6m", "1y"].map(v => coneWindow(ts, v).timestamps.length), [31 * 24, 92 * 24, 184, 365]);
  assert.equal(coneWindow(ts + 2 * HOUR + 50, "3m").to, ts + 2 * HOUR);
  assert.equal(coneWindow(ts + 2 * HOUR, "6m").to, ts);
  assert.deepEqual(coneWindow(null).timestamps, []);
  assert.throws(() => coneWindow(ts, "bad"), /Unknown cone lookback/);
});

test("constant-tenor IV interpolates total variance, preserves exact maturities and flags ATM fallbacks", () => {
  const curve = [{ expiry: ts + 10 * DAY, iv: 0.2 }, { expiry: ts + 30 * DAY, iv: 0.4, clamped: true }];
  const [exact, mid] = constantTenorIv(curve, ts, [10, 20]);
  close(exact.iv, 0.2);
  close(mid.iv, Math.sqrt((0.2 ** 2 * 10 / 2 + 0.4 ** 2 * 30 / 2) / 20));
  assert.equal(mid.weight, 0.5);
  assert.equal(mid.clamped, true);
  assert.equal(mid.nearExpiry, curve[0].expiry);
});

test("unbracketed horizons and negative forward variance stay unavailable", () => {
  const curve = [{ expiry: ts + 10 * DAY, iv: 1 }, { expiry: ts + 30 * DAY, iv: 0.1 }];
  const result = constantTenorIv(curve, ts, [1, 20, 60]);
  assert.deepEqual(result.map(p => p.iv), [null, null, null]);
  assert.equal(result[1].reason, "negative-forward-variance");
  assert.equal(constantTenorIv([], ts)[0].reason, "unbracketed-maturity");
});

test("historical IV includes contracts now expired and never pairs different timestamps", () => {
  const old = ts - 100 * DAY;
  const quotes = [10, 30].flatMap(days => ["C", "P"].map(side => ({ ts: old, expiry: old + days * DAY, strike: 100, spot: 100, iv: 0.5, side })));
  const slices = buildHistoricalSeries({ history: quotes, expiries: [...new Set(quotes.map(q => q.expiry))], limit: Infinity });
  const [point] = impliedConeHistory(slices, [20]);
  close(point.iv, 0.5);
  assert.ok(point.farExpiry < ts, "expired today, valid at its historical timestamp");
  const split = impliedConeHistory([{ ...slices[0] }, { ...slices[1], ts: old + HOUR }], [20]);
  assert.ok(split.every(p => p.iv === null));
});

test("rolling RV matches an independent OHLC calculation and excludes future/incomplete bars", () => {
  const bars = Array.from({ length: 72 }, (_, i) => ({ ...bar(ts - (72 - i) * HOUR), high: 102 + i / 10 }));
  const polluted = [...bars, { ...bar(ts), high: 10000 }];
  const [point] = realizedConeHistory(polluted, [ts], [2]);
  const mean = bars.slice(-48).reduce((sum, b) => sum + hourlyVariance(b), 0) / 48;
  close(point.iv, Math.sqrt(mean * 24 * 365.25));
  assert.equal(point.coverage, 1);
  assert.equal(point.hours, 48);
});

test("RV retains its exact window across gaps and honors 99% coverage without zero filling", () => {
  const full = Array.from({ length: 240 }, (_, i) => bar(ts - (240 - i) * HOUR));
  const [complete] = realizedConeHistory(full, [ts], [10]);
  const [twoMissing] = realizedConeHistory(full.slice(2), [ts], [10]);
  close(twoMissing.iv, complete.iv);
  assert.equal(twoMissing.ts, ts);
  assert.equal(twoMissing.count, 238);
  assert.equal(realizedConeHistory(full.slice(3), [ts], [10])[0].iv, null);
  assert.equal(realizedConeHistory(full.slice(0, -1), [ts], [10])[0].iv, null, "samples after the source cutoff stay missing even at 99% coverage");
  assert.equal(realizedConeHistory(full.slice(1), [ts], [1])[0].coverage, 1, "gaps outside the window are irrelevant");
  assert.throws(() => realizedConeHistory([...full, full[0]], [ts], [10]), /Duplicate/);
});

test("zero realized volatility is valid; warmup belongs before the cone lookback", () => {
  const bars = Array.from({ length: 24 * 400 }, (_, i) => ({ ts: ts - (24 * 400 - i) * HOUR, open: 100, high: 100, low: 100, close: 100 }));
  const times = coneWindow(ts, "1m").timestamps;
  const rv = realizedConeHistory(bars, times, [365]);
  assert.equal(rv.length, times.length);
  assert.ok(rv.every(p => p.iv === 0 && p.coverage === 1));
});

test("cone statistics filter each lookback, keep independent IV/RV counts and do not treat current quotes as history", () => {
  const row = (days, iv) => ({ tenorDays: 30, ts: ts - days * DAY, iv });
  const data = { implied: [row(0, 0.2), row(1, 0.4), row(2, null), row(100, 9), row(-1, 8)],
    realized: [row(0, 0), row(1, 0.6)], latestRealized: [{ ...row(0, 0.3), coverage: 1 }] };
  const current = [{ expiry: ts + 30 * DAY, iv: 0.2 }];
  const original = JSON.stringify(data);
  const cone = buildVolatilityCone({ data, current, asOf: ts, lookback: "1m" });
  const p = cone.points.find(p => p.tenorDays === 30);
  assert.equal(p.implied.count, 2);
  assert.equal(p.implied.expectedCount, 31 * 24);
  close(p.implied.median, 0.3);
  close(p.implied.p05, 0.21);
  close(p.implied.p95, 0.39);
  assert.equal(p.realized.min, 0);
  assert.equal(p.impliedRank, 25, "ties receive half weight");
  assert.equal(p.realizedRank, 50);
  assert.equal(cone.currentCurve[0].tenorDays, 30);
  assert.equal(cone.points[0].implied.min, null);
  assert.equal(JSON.stringify(data), original);
  assert.equal(buildVolatilityCone({ data, asOf: ts - DAY }).points.find(p => p.tenorDays === 30).currentRealized, null);
  assert.equal(buildVolatilityCone({ data, asOf: ts, lookback: "1y" }).points.find(p => p.tenorDays === 30).implied.count, 3);
});

function artifact(asset = "BTC") {
  return { schema: "thalex-volatility-cone", version: 1, asset, source: "backtest/source-data/thalex",
    sourceThrough: { index: ts, marks: ts }, tenors: CONE_TENORS,
    sampling: { shortSeconds: HOUR, longSeconds: DAY, longFromDays: 180, dailyUtcHour: 0, timestampBasis: "bar-close" },
    methodology: { iv: "atm-spot-close-total-variance", rv: "garman-klass-hourly", daysPerYear: 365.25, minHourlyCoverage: 0.99 },
    implied: [{ ts, tenorDays: 30, iv: 0.5 }], realized: [], latestRealized: [] };
}

test("short lookbacks include intraday samples while long lookbacks select only exact midnight closes", () => {
  const data = { implied: [
    { ts, tenorDays: 7, iv: 0.2 },
    { ts: ts + HOUR, tenorDays: 7, iv: 0.4 },
    { ts: ts + 2 * HOUR, tenorDays: 7, iv: 0.8 },
  ] };
  const options = { data, asOf: ts + HOUR + 100 };
  const short = buildVolatilityCone({ ...options, lookback: "3m" }).points.find(p => p.tenorDays === 7);
  const long = buildVolatilityCone({ ...options, lookback: "6m" }).points.find(p => p.tenorDays === 7);
  assert.equal(short.implied.count, 2);
  close(short.implied.median, 0.3);
  assert.equal(short.implied.to, ts + HOUR);
  assert.equal(long.implied.count, 1);
  assert.equal(long.implied.max, 0.2);
});
const manifest = asset => ({ schema: "thalex-term-history", version: 1, asset, cone: "cone-abc.json" });

test("loader reads only the selected asset's immutable cone artifact and forwards cancellation", async () => {
  const calls = [], controller = new AbortController();
  const fetchImpl = async (url, options) => {
    calls.push([url, options]);
    return { ok: true, json: async () => url.endsWith("manifest.json") ? manifest("ETH") : artifact("ETH") };
  };
  const data = await loadVolatilityConeData("ETH", { signal: controller.signal, fetchImpl });
  assert.equal(data.asset, "ETH");
  assert.deepEqual(calls.map(([url]) => url), ["/history-cache/eth/manifest.json", "/history-cache/eth/cone-abc.json"]);
  assert.ok(calls.every(([, opts]) => opts.signal === controller.signal));
  assert.equal(calls[0][1].cache, "no-cache");
});

test("loader rejects wrong assets, stale formats, duplicate observations and invalid RV coverage", async () => {
  for (const change of [d => { d.asset = "ETH"; }, d => { d.version = 99; },
    d => { d.implied.push(d.implied[0]); }, d => { d.implied[0].iv = NaN; },
    d => { d.latestRealized.push({ ts, tenorDays: 1, hours: 24, count: 20, coverage: 20 / 24, iv: 0.3 }); }]) {
    const data = artifact(); change(data);
    await assert.rejects(loadVolatilityConeData("BTC", { fetchImpl: async url => ({ ok: true, json: async () => url.endsWith("manifest.json") ? manifest("BTC") : data }) }), /cone/i);
  }
  await assert.rejects(loadVolatilityConeData("BTC", { fetchImpl: async () => ({ ok: false, status: 404 }) }), /build:data/);
  await assert.rejects(loadVolatilityConeData("BTC", { fetchImpl: async () => ({ ok: true, headers: new Headers({ "content-type": "text/html" }) }) }), /HTML/);
  await assert.rejects(loadVolatilityConeData("SOL"), /Unsupported cone asset/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(loadVolatilityConeData("BTC", { signal: controller.signal,
    fetchImpl: async () => ({ ok: true, json: async () => manifest("BTC") }) }), { name: "AbortError" });
});
