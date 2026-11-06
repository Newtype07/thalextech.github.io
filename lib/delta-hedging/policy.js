export const DEFAULT_HEDGE_POLICY = Object.freeze({
  enabled: true,
  threshold: 0.05,
  tolerance: 0.25,
  period: 24 * 60 * 60,
  timing: "timer",
  hedgeBps: 1,
  entry: "neutralize",
  exit: "unwind",
});

export function normalizeHedgePolicy(input = {}) {
  const policy = { ...DEFAULT_HEDGE_POLICY, ...input };
  for (const key of ["threshold", "tolerance", "period", "hedgeBps"]) {
    if (!Number.isFinite(policy[key]) || policy[key] < 0)
      throw new Error(`${key === "hedgeBps" ? "Hedge cost" : key[0].toUpperCase() + key.slice(1)} must be a nonnegative number.`);
  }
  if (policy.tolerance > 0 && policy.tolerance < policy.threshold)
    throw new Error("Tolerance must be at least the threshold, or zero to disable it.");
  if (!["timer", "scheduled"].includes(policy.timing))
    throw new Error("Choose sustained breach or scheduled hedge timing.");
  if (policy.timing === "scheduled" && policy.period === 0)
    throw new Error("Scheduled checks need a positive period.");
  if (!["neutralize", "policy"].includes(policy.entry) || !["unwind", "hold"].includes(policy.exit))
    throw new Error("Choose a valid hedge entry and exit policy.");
  return policy;
}

// All times are seconds relative to the run's anchor, all deltas underlying units.
export function hedgeDecision({ elapsed, netDelta, breachSince, previousElapsed }, policy) {
  if (!Number.isFinite(netDelta) || !Number.isFinite(elapsed))
    return { reason: null, breachSince: null };
  const outside = Math.abs(netDelta) > policy.threshold + 1e-12;
  const since = outside ? (breachSince ?? elapsed) : null;
  if (policy.tolerance > 0 && Math.abs(netDelta) > policy.tolerance + 1e-12)
    return { reason: "tolerance", breachSince: null };
  const scheduled = elapsed > 0 && (Number.isFinite(previousElapsed)
    ? Math.floor((elapsed + 1e-8) / policy.period) > Math.floor((previousElapsed + 1e-8) / policy.period)
    : Math.abs(elapsed / policy.period - Math.round(elapsed / policy.period)) < 1e-8);
  const ready = policy.timing === "scheduled" ? scheduled : outside && elapsed - since >= policy.period - 1e-8;
  return outside && ready
    ? { reason: policy.timing === "scheduled" ? "scheduled" : "timer", breachSince: null }
    : { reason: null, breachSince: since };
}
