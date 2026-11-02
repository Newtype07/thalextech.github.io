import { spotDelta } from "./volatility.js";

export const DELTAS = [
  { value: "15", label: "15Δ", delta: 0.15 },
  { value: "25", label: "25Δ", delta: 0.25 },
  { value: "35", label: "35Δ", delta: 0.35 },
];

// Interpolate variance within each wing. Never extrapolate beyond observed deltas.
function wingIv(quotes, side, target) {
  const points = quotes
    .filter(q => q.side === side && [q.iv, q.strike, q.spot, q.expiry, q.ts].every(Number.isFinite)
      && q.iv > 0 && q.strike > 0 && q.spot > 0 && q.expiry > q.ts)
    .map(q => ({ delta: spotDelta(q), variance: q.iv ** 2 }))
    .filter(p => Number.isFinite(p.delta))
    .sort((a, b) => a.delta - b.delta);
  const low = points.findLast(p => p.delta <= target);
  const high = points.find(p => p.delta >= target);
  if (!low || !high) return null;
  const weight = high.delta === low.delta ? 0 : (target - low.delta) / (high.delta - low.delta);
  return Math.sqrt(low.variance * (1 - weight) + high.variance * weight);
}

export function interpolateSkew(quotes, delta = 0.25) {
  if (!(delta > 0 && delta < 0.5)) throw new Error("Skew delta must be between 0 and 0.5");
  const callIv = wingIv(quotes, "C", delta);
  const putIv = wingIv(quotes, "P", -delta);
  if (callIv == null || putIv == null) return null;
  return { skew: callIv - putIv, callIv, putIv };
}

export function buildCurrentSkew(quotes, delta) {
  const groups = new Map();
  for (const quote of quotes) {
    if (!groups.has(quote.expiry)) groups.set(quote.expiry, []);
    groups.get(quote.expiry).push(quote);
  }
  return [...groups].sort((a, b) => a[0] - b[0]).flatMap(([expiry, rows]) => {
    const point = interpolateSkew(rows, delta);
    return point ? [{ expiry, ts: Math.max(...rows.map(q => q.ts)), ...point }] : [];
  });
}

export function buildHistoricalSkew({ quotes, expiries, delta, limit = 2000 }) {
  const listed = expiries == null ? null : new Set(expiries);
  const groups = new Map();
  for (const quote of quotes) {
    if (listed && !listed.has(quote.expiry)) continue;
    const key = `${quote.expiry}:${quote.ts}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(quote);
  }
  const byExpiry = new Map();
  for (const rows of groups.values()) {
    const point = interpolateSkew(rows, delta);
    if (!point) continue;
    const { expiry, ts } = rows[0];
    if (!byExpiry.has(expiry)) byExpiry.set(expiry, []);
    byExpiry.get(expiry).push({ expiry, ts, ...point });
  }
  return [...byExpiry.values()].flatMap(rows => rows.sort((a, b) => a.ts - b.ts).slice(-limit));
}

export function rankCurrentSkew(current, history, key = "expiry") {
  const samples = new Map();
  for (const point of history) {
    if (!samples.has(point[key])) samples.set(point[key], []);
    samples.get(point[key]).push(point.skew);
  }
  return current.map(point => {
    const sample = samples.get(point[key]) || [];
    const rank = sample.length ? 100 * sample.reduce((n, skew) =>
      n + (skew < point.skew ? 1 : skew === point.skew ? 0.5 : 0), 0) / sample.length : null;
    return { ...point, count: sample.length, rank };
  });
}
