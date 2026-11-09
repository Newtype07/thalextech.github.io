import { hourlyVariance, RV_MIN_COVERAGE } from "./realized-volatility.js";

const HOUR = 3600, DAY = 86400;
export const CONE_TENORS = [1, 2, 3, 7, 14, 30, 60, 90, 180, 365];
export const CONE_LOOKBACKS = [
  { value: "1y", label: "1 year", months: 12 },
  { value: "6m", label: "6 months", months: 6 },
  { value: "3m", label: "3 months", months: 3 },
  { value: "1m", label: "1 month", months: 1 },
];

// Calendar-month lookbacks: hourly below 180 days, otherwise 00:00 UTC daily closes. A missing close
// stays missing; neither the schedule nor its end moves to fit the source data.
export function coneWindow(asOf, lookback = "1y") {
  const spec = CONE_LOOKBACKS.find(item => item.value === lookback);
  if (!spec) throw new Error(`Unknown cone lookback: ${lookback}`);
  if (!Number.isFinite(asOf)) return { from: null, to: null, timestamps: [] };
  const stepSeconds = spec.months >= 6 ? DAY : HOUR;
  const to = Math.floor(asOf / stepSeconds) * stepSeconds;
  const date = new Date(to * 1000), day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - spec.months);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  const from = date.getTime() / 1000;
  const timestamps = Array.from({ length: Math.round((to - from) / stepSeconds) }, (_, i) => from + (i + 1) * stepSeconds);
  return { from, to, timestamps, stepSeconds };
}

// Match maturities by interpolating total variance at one observation time.
// Never extrapolate, bridge timestamps, or hide negative forward variance.
export function constantTenorIv(curve, ts, tenors = CONE_TENORS) {
  if (!Number.isFinite(ts)) return [];
  const clean = curve.filter(p => Number.isFinite(p.expiry) && p.expiry > ts && Number.isFinite(p.iv) && p.iv > 0)
    .sort((a, b) => a.expiry - b.expiry);
  return tenors.map(tenorDays => {
    const target = ts + tenorDays * DAY;
    const near = clean.findLast(p => p.expiry <= target);
    const far = clean.find(p => p.expiry >= target);
    if (!near || !far) return { ts, tenorDays, iv: null, reason: "unbracketed-maturity" };
    const nearVariance = near.iv ** 2 * (near.expiry - ts);
    const farVariance = far.iv ** 2 * (far.expiry - ts);
    if (farVariance < nearVariance)
      return { ts, tenorDays, iv: null, reason: "negative-forward-variance" };
    const weight = near.expiry === far.expiry ? 0 : (target - near.expiry) / (far.expiry - near.expiry);
    return { ts, tenorDays, iv: Math.sqrt(((1 - weight) * nearVariance + weight * farVariance) / (tenorDays * DAY)),
      nearExpiry: near.expiry, farExpiry: far.expiry, weight, clamped: Boolean(near.clamped || far.clamped) };
  });
}

export function impliedConeHistory(history, tenors = CONE_TENORS) {
  const groups = new Map();
  for (const point of history) {
    if (!groups.has(point.ts)) groups.set(point.ts, []);
    groups.get(point.ts).push(point);
  }
  return [...groups].sort((a, b) => a[0] - b[0])
    .flatMap(([ts, points]) => constantTenorIv(points, ts, tenors));
}

// Prefix sums keep a year's daily rolling windows cheap. Window ends are exact:
// historical gaps never shift a sample back to a different observation time.
export function realizedConeHistory(bars, timestamps, tenors = CONE_TENORS) {
  if (!timestamps.length) return [];
  const start = Math.min(...timestamps) - Math.max(...tenors) * DAY;
  const end = Math.max(...timestamps);
  const size = Math.round((end - start) / HOUR);
  const values = new Map();
  let sourceThrough = -Infinity;
  for (const bar of bars) {
    if (!Number.isFinite(bar.ts) || bar.ts % HOUR !== 0 || bar.ts < start || bar.ts + HOUR > end) continue;
    if (values.has(bar.ts)) throw new Error(`Duplicate cone index bar: ${bar.ts}`);
    values.set(bar.ts, hourlyVariance(bar));
    sourceThrough = Math.max(sourceThrough, bar.ts + HOUR);
  }
  const variance = new Float64Array(size + 1), counts = new Uint32Array(size + 1);
  for (let i = 0; i < size; i++) {
    const v = values.get(start + i * HOUR);
    variance[i + 1] = variance[i] + (v ?? 0);
    counts[i + 1] = counts[i] + (v != null ? 1 : 0);
  }
  return timestamps.flatMap(ts => tenors.map(tenorDays => {
    const hours = tenorDays * 24, right = (ts - start) / HOUR, left = right - hours;
    const count = counts[right] - counts[left], coverage = count / hours;
    return { ts, tenorDays, hours, count, coverage,
      iv: ts <= sourceThrough && count > 0 && coverage >= RV_MIN_COVERAGE
        ? Math.sqrt(Math.max(0, variance[right] - variance[left]) / count * 24 * 365.25) : null };
  }));
}

function distribution(points, expectedCount) {
  const clean = points.filter(p => Number.isFinite(p.iv) && p.iv >= 0).sort((a, b) => a.iv - b.iv);
  const quantile = p => {
    if (!clean.length) return null;
    const i = (clean.length - 1) * p, low = Math.floor(i), weight = i - low;
    return clean[low].iv * (1 - weight) + clean[Math.ceil(i)].iv * weight;
  };
  return { count: clean.length, expectedCount, coverage: expectedCount ? clean.length / expectedCount : 0,
    from: clean.length ? Math.min(...clean.map(p => p.ts)) : null,
    to: clean.length ? Math.max(...clean.map(p => p.ts)) : null,
    min: quantile(0), p05: quantile(0.05), p25: quantile(0.25), median: quantile(0.5),
    p75: quantile(0.75), p95: quantile(0.95), max: quantile(1),
    clampedCount: clean.filter(p => p.clamped).length };
}

export function buildVolatilityCone({ data, current = [], asOf, lookback = "1y" }) {
  const window = coneWindow(asOf, lookback), schedule = new Set(window.timestamps);
  const currentByTenor = new Map(constantTenorIv(current, asOf).map(p => [p.tenorDays, p]));
  const latestRv = new Map((data?.latestRealized || []).filter(p => p.ts <= asOf).map(p => [p.tenorDays, p]));
  const points = CONE_TENORS.map(tenorDays => {
    const select = rows => (rows || []).filter(p => p.tenorDays === tenorDays && schedule.has(p.ts));
    const rv = select(data?.realized), iv = select(data?.implied);
    const live = currentByTenor.get(tenorDays) ?? null;
    const rank = (rows, value) => {
      const sample = rows.filter(p => Number.isFinite(p.iv) && p.iv >= 0);
      return value != null && sample.length
        ? 100 * sample.reduce((n, p) => n + (p.iv < value ? 1 : p.iv === value ? 0.5 : 0), 0) / sample.length : null;
    };
    const currentRealized = latestRv.get(tenorDays) ?? null;
    return { tenorDays, realized: distribution(rv, schedule.size), implied: distribution(iv, schedule.size),
      currentIv: live, currentRealized, impliedRank: rank(iv, live?.iv), realizedRank: rank(rv, currentRealized?.iv) };
  });
  return { lookback, asOf, window, sourceThrough: data?.sourceThrough ?? null, points,
    currentCurve: current.filter(p => p.expiry > asOf && Number.isFinite(p.iv) && p.iv > 0)
      .map(p => ({ ...p, tenorDays: (p.expiry - asOf) / DAY })) };
}
