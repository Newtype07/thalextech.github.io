const DAY = 86400;
export const TENORS = [7, 14, 30, 60, 90, 180];
export const tenorLabel = days => `${days}D`;

// Inputs are same-delta call/put IVs by listed expiry. Interpolate each wing's
// total variance in time, then recover IV before taking call minus put.
export function constantMaturityCurve(slices, ts, tenors = TENORS) {
  if (!Number.isFinite(ts)) return [];
  const clean = slices.filter(p => p.expiry > ts &&
    [p.expiry, p.callIv, p.putIv].every(Number.isFinite) && p.callIv > 0 && p.putIv > 0)
    .sort((a, b) => a.expiry - b.expiry);
  return tenors.flatMap(tenorDays => {
    if (!(tenorDays > 0)) return [];
    const duration = tenorDays * DAY, target = ts + duration;
    const near = clean.findLast(p => p.expiry <= target);
    const far = clean.find(p => p.expiry >= target);
    if (!near || !far) return []; // No wing or maturity extrapolation.
    const weight = far.expiry === near.expiry ? 0 : (target - near.expiry) / (far.expiry - near.expiry);
    const iv = field => Math.sqrt(((1 - weight) * near[field] ** 2 * (near.expiry - ts) +
      weight * far[field] ** 2 * (far.expiry - ts)) / duration);
    const callIv = iv("callIv"), putIv = iv("putIv");
    return [{ tenorDays, ts, callIv, putIv, skew: callIv - putIv,
      nearExpiry: near.expiry, farExpiry: far.expiry, weight }];
  });
}

export function constantMaturityHistory(slices, tenors = TENORS) {
  const groups = new Map();
  for (const point of slices) {
    if (!groups.has(point.ts)) groups.set(point.ts, []);
    groups.get(point.ts).push(point);
  }
  return [...groups].sort((a, b) => a[0] - b[0])
    .flatMap(([ts, points]) => constantMaturityCurve(points, ts, tenors));
}

