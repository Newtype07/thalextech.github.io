// Domain curve: seconds from entry, decimal IV, 365.25-day pricing year.
// Linear interpolation of total variance gives piecewise-constant forward variance.
export const YEAR = 365.25 * 86400;

export function buildForwardCurve(nodes, maturity) {
  if (!Number.isFinite(maturity) || maturity <= 0)
    throw new Error("Choose a positive option maturity.");
  const ordered = nodes
    .map((node) => ({ ...node }))
    .sort((a, b) => a.seconds - b.seconds);
  if (
    !ordered.length ||
    ordered.some(
      (p) =>
        !Number.isFinite(p.seconds) ||
        p.seconds <= 0 ||
        !Number.isFinite(p.iv) ||
        p.iv <= 0,
    )
  ) {
    throw new Error("Every curve point needs positive days and IV.");
  }
  if (ordered.some((p, i) => i && p.seconds === ordered[i - 1].seconds))
    throw new Error("Curve maturities must be distinct.");
  if (maturity > ordered.at(-1).seconds + 1e-6)
    throw new Error(
      "Option maturity exceeds the curve. Add a longer-dated IV point.",
    );
  const intervals = [];
  let start = 0,
    total = 0;
  for (const point of ordered) {
    const nextTotal = (point.iv ** 2 * point.seconds) / YEAR;
    const variance = ((nextTotal - total) * YEAR) / (point.seconds - start);
    if (variance < -1e-12) {
      throw new Error(
        `Negative forward variance between ${(start / 86400).toFixed(2)} and ${(point.seconds / 86400).toFixed(2)} days. Adjust those IVs; a falling IV curve is valid only while total variance rises.`,
      );
    }
    const end = Math.min(point.seconds, maturity);
    intervals.push({
      start,
      end,
      variance: Math.max(0, variance),
      iv: Math.sqrt(Math.max(0, variance)),
      total,
    });
    total = nextTotal;
    start = point.seconds;
    if (end === maturity) break;
  }
  const varianceAt = (seconds) => {
    const t = Math.max(0, Math.min(maturity, seconds));
    const interval = intervals.find((p) => t <= p.end) || intervals.at(-1);
    return interval.total + (interval.variance * (t - interval.start)) / YEAR;
  };
  const totalVariance = varianceAt(maturity);
  if (!(totalVariance > 0))
    throw new Error("The selected maturity needs positive total variance.");
  return {
    intervals,
    maturity,
    totalVariance,
    varianceAt,
    entryIv: Math.sqrt((totalVariance * YEAR) / maturity),
    remainingIv(seconds) {
      if (seconds >= maturity) return intervals.at(-1).iv;
      return Math.sqrt(
        (Math.max(0, totalVariance - varianceAt(seconds)) * YEAR) /
          (maturity - seconds),
      );
    },
  };
}
