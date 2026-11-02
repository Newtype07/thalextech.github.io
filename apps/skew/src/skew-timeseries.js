const HOUR = 3600;
export const HISTORY_VIEWS = [
  { value: "1y", label: "1 year", months: 12, step: 24 * HOUR, sampling: "Daily closes" },
  { value: "6m", label: "6 months", months: 6, step: 24 * HOUR, sampling: "Daily closes" },
  { value: "3m", label: "3 months", months: 3, step: 6 * HOUR, sampling: "6-hourly closes" },
  { value: "1m", label: "1 month", months: 1, step: 2 * HOUR, sampling: "2-hourly closes" },
  { value: "1w", label: "1 week", days: 7, step: HOUR, sampling: "Hourly closes" },
];

export function historyWindow(view, asOf) {
  const spec = HISTORY_VIEWS.find(item => item.value === view);
  if (!spec) throw new Error(`Unknown history view: ${view}`);
  if (!Number.isFinite(asOf)) return { ...spec, timestamps: [], from: null, to: null };
  const to = Math.floor(asOf / spec.step) * spec.step;
  const date = new Date(to * 1000), day = date.getUTCDate();
  if (spec.months) {
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() - spec.months);
    const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(day, lastDay));
  } else date.setUTCDate(day - spec.days);
  const from = date.getTime() / 1000;
  const timestamps = Array.from({ length: Math.round((to - from) / spec.step) + 1 }, (_, i) => from + i * spec.step);
  return { ...spec, timestamps, from, to };
}

export function mergeSkewHistory(prepared, additions) {
  const points = new Map(prepared.map(p => [`${p.ts}:${p.tenorDays}`, p]));
  for (const p of additions) points.set(`${p.ts}:${p.tenorDays}`, p);
  return [...points.values()].sort((a, b) => a.ts - b.ts || a.tenorDays - b.tenorDays);
}

// Project fixed-tenor observations onto a common UTC schedule, one series per
// tenor. Preserve real missing closes explicitly; never borrow a nearby hour.
export function buildSkewTimeSeries({ history, current = [], tenors, asOf, view = "3m" }) {
  const window = historyWindow(view, asOf);
  if (!window.timestamps.length) return { timestamps: [], series: [], from: null, to: null };
  const timestamps = [...window.timestamps], latestClose = window.to;
  const scheduled = new Set(timestamps), selected = new Set(tenors);
  const byTenor = new Map(tenors.map(tenor => [tenor, new Map()]));
  for (const point of history)
    if (selected.has(point.tenorDays) && scheduled.has(point.ts) && Number.isFinite(point.skew))
      byTenor.get(point.tenorDays).set(point.ts, point);
  const live = new Map(current.filter(p => selected.has(p.tenorDays) && Number.isFinite(p.skew)).map(p => [p.tenorDays, p]));
  const appendLive = live.size > 0 && asOf > latestClose;
  if (appendLive) timestamps.push(asOf);
  const series = tenors.map(tenorDays => {
    const points = timestamps.map(ts => byTenor.get(tenorDays).get(ts) ?? null);
    if (live.has(tenorDays)) points[points.length - 1] = { ...live.get(tenorDays), ts: asOf, live: true };
    return { tenorDays, points };
  });
  return { timestamps, series, from: timestamps[0], to: timestamps.at(-1) };
}
