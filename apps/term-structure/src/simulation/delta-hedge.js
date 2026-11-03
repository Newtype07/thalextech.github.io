// Pure hedge decision. The ledger owns positions, fills and costs.
export function hedgeDecision(
  { elapsed, netDelta, breachSince },
  { threshold, tolerance, period, timing },
) {
  const outside = Math.abs(netDelta) > threshold + 1e-12;
  const since = outside ? (breachSince ?? elapsed) : null;
  if (tolerance > 0 && Math.abs(netDelta) > tolerance + 1e-12)
    return { reason: "tolerance", breachSince: null };
  const ready =
    timing === "scheduled"
      ? elapsed > 0 &&
        Math.abs(elapsed / period - Math.round(elapsed / period)) < 1e-8
      : outside && elapsed - since >= period - 1e-8;
  return outside && ready
    ? {
        reason: timing === "scheduled" ? "scheduled" : "timer",
        breachSince: null,
      }
    : { reason: null, breachSince: since };
}
