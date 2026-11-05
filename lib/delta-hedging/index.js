import { hedgeDecision, normalizeHedgePolicy } from "./policy.js";
import { createHedgeLedger, executeHedge, markHedge } from "./ledger.js";
export { DEFAULT_HEDGE_POLICY, normalizeHedgePolicy, hedgeDecision } from "./policy.js";
export { createHedgeLedger, executeHedge, markHedge } from "./ledger.js";

/** A run-local streaming engine; the same transition drives workers and replay. */
export function createDeltaHedge(input = {}, { observationSeconds = 0 } = {}) {
  const policy = normalizeHedgePolicy(input);
  const ledger = createHedgeLedger();
  let anchor = null, previousTime = null, breachSince = null, entryPending = false;
  function observe({ time, price, delta, hedgeUnitDelta = 1, phase = "observe" }) {
    if (!Number.isFinite(time) || (previousTime !== null && time < previousTime))
      throw new Error("Hedge observations must have increasing finite timestamps.");
    if (anchor === null) anchor = time;
    if (phase === "entry") entryPending = true;
    const gap = previousTime !== null && observationSeconds > 0 && time - previousTime > observationSeconds + 1e-6;
    const missingPrice = !Number.isFinite(price) || price <= 0;
    const missingRisk = !Number.isFinite(delta) || !Number.isFinite(hedgeUnitDelta) || Math.abs(hedgeUnitDelta) < 1e-12;
    if (gap || missingPrice || missingRisk) breachSince = null;
    const before = missingRisk ? null : delta + ledger.position * hedgeUnitDelta;
    let reason = null, fill = null;
    if (policy.enabled && !missingPrice) {
      if (phase === "exit" && policy.exit === "unwind") reason = "exit";
      else if (!missingRisk && (phase !== "exit" || policy.exit === "hold")) {
        if (entryPending && policy.entry === "neutralize") reason = "entry";
        else {
          const decision = hedgeDecision({ elapsed: time - anchor, netDelta: before, breachSince,
            previousElapsed: previousTime === null ? 0 : previousTime - anchor }, policy);
          reason = decision.reason;
          breachSince = decision.breachSince;
        }
        entryPending = false;
      }
      if (reason) {
        fill = executeHedge(ledger, { time, price, target: reason === "exit" ? 0 : -delta / hedgeUnitDelta,
          reason, netDeltaBefore: before, hedgeUnitDelta }, policy.hedgeBps);
        breachSince = null;
      }
    }
    previousTime = time;
    return { ...markHedge(ledger, missingPrice ? null : price), fill, reason,
      netDeltaBefore: before, netDelta: missingRisk ? null : delta + ledger.position * hedgeUnitDelta,
      position: ledger.position, cash: ledger.cash, fees: ledger.fees, turnover: ledger.turnover,
      tradeCount: ledger.tradeCount, gap, missingPrice, missingRisk };
  }
  return { policy, ledger, observe };
}

export function replayDeltaHedge(observations, policy, options) {
  const engine = createDeltaHedge(policy, options);
  const trades = [];
  const rows = observations.map((sample, i) => {
    const row = engine.observe({ ...sample, phase: sample.phase ?? (i === 0 ? "entry" : i === observations.length - 1 ? "exit" : "observe") });
    if (row.fill) trades.push(row.fill);
    return { ...sample, ...row };
  });
  return { rows, trades, policy: engine.policy };
}

