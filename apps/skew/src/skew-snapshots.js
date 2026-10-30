const HOUR = 3600;

export const SNAPSHOT_RESOLUTIONS = [
  { value: "daily", label: "Daily · 3 days hourly", count: 72, step: HOUR },
  { value: "weekly", label: "Weekly · 14 days daily", count: 14, step: 24 * HOUR },
  { value: "monthly", label: "Monthly · 12 weeks weekly", count: 12, step: 7 * 24 * HOUR },
];

// Fill internal maturity gaps using the same timestamp's observed neighbours.
// Interpolate in actual expiry time, independently of the chart's equal spacing.
// These chart estimates never enter hourly history, IV inputs or percentiles.
export function interpolateSkewMaturities(points, expiries) {
  const filled = [...points];
  let left = null;
  for (let right = 0; right < points.length; right++) {
    if (!points[right]) continue;
    if (left != null && right > left + 1) {
      for (let index = left + 1; index < right; index++) {
        const weight = (expiries[index] - expiries[left]) / (expiries[right] - expiries[left]);
        filled[index] = {
          expiry: expiries[index],
          ts: points[left].ts,
          skew: points[left].skew * (1 - weight) + points[right].skew * weight,
          interpolated: true,
          leftExpiry: expiries[left],
          rightExpiry: expiries[right],
        };
      }
    }
    left = right;
  }
  return filled;
}

// Keep partial snapshots on their exact schedule; interpolate maturity gaps
// within each curve, never borrow another timestamp or extrapolate its ends.
export function buildSkewSnapshots(history, expiries, asOf, resolution = "daily") {
  const spec = SNAPSHOT_RESOLUTIONS.find(item => item.value === resolution);
  if (!spec) throw new Error(`Unknown snapshot resolution: ${resolution}`);
  if (!Number.isFinite(asOf)) return [];
  const latestClose = Math.floor(asOf / HOUR) * HOUR;
  const scheduled = new Map(Array.from({ length: spec.count }, (_, ageIndex) => {
    const ts = latestClose - ageIndex * spec.step;
    return [ts, { ts, ageIndex, byExpiry: new Map() }];
  }));
  const listed = new Set(expiries);
  for (const point of history) {
    const snapshot = scheduled.get(point.ts);
    if (snapshot && listed.has(point.expiry) && Number.isFinite(point.skew))
      snapshot.byExpiry.set(point.expiry, point);
  }
  return [...scheduled.values()].reverse().flatMap(({ ts, ageIndex, byExpiry }) => {
    const points = expiries.map(expiry => byExpiry.get(expiry) ?? null);
    return points.some(Boolean)
      ? [{ ts, ageIndex, points: interpolateSkewMaturities(points, expiries) }]
      : [];
  });
}
