import { calcGreeks, calcOptionPrice } from "../../../../lib/thalex.js";
import { buildForwardCurve, YEAR } from "./forward-curve.js";
import { hedgeDecision } from "./delta-hedge.js";

export const ATTRIBUTION = [
  {
    key: "theta",
    label: "Time decay",
    note: "Exact time revaluation at the previous spot and IV.",
  },
  {
    key: "roll",
    label: "Term-structure roll",
    note: "Exact revaluation of the change in remaining forward variance.",
  },
  {
    key: "delta",
    label: "Option delta",
    note: "Previous option delta × change in spot.",
  },
  {
    key: "gamma",
    label: "Option gamma",
    note: "½ × previous gamma × squared spot move.",
  },
  {
    key: "residual",
    label: "Higher-order / cross effects",
    note: "Remaining option revaluation, including Greek approximation error.",
  },
  {
    key: "hedge",
    label: "Hedge trading P&L",
    note: "Linear hedge held over each price move, before costs.",
  },
  {
    key: "costs",
    label: "Execution costs",
    note: "Option entry/exit and every hedge fill, including entry and final unwind.",
  },
];

function normals(seed) {
  let state = seed >>> 0;
  const uniform = () => {
    state += 0x6d2b79f5;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () =>
    Math.sqrt(-2 * Math.log(Math.max(uniform(), 1e-15))) *
    Math.cos(2 * Math.PI * uniform());
}

function optionRisk(spot, leg, remaining, iv) {
  if (remaining <= 0 || iv === 0) {
    const callDelta = spot > leg.strike ? 1 : spot < leg.strike ? 0 : 0.5;
    return {
      delta: leg.optionType === "put" ? callDelta - 1 : callDelta,
      gamma: 0, vega: 0,
    };
  }
  return calcGreeks(spot, leg.strike, remaining, iv, leg.optionType);
}

function validate(config) {
  const positive = [
    "spot",
    "horizon",
    "step",
    "period",
  ];
  const nonnegative = [
    "rvMultiplier",
    "threshold",
    "tolerance",
    "hedgeBps",
    "optionBps",
  ];
  if (
    positive.some((key) => !Number.isFinite(config[key]) || config[key] <= 0) ||
    nonnegative.some(
      (key) => !Number.isFinite(config[key]) || config[key] < 0,
    ) ||
    !Number.isFinite(config.drift) ||
    !Number.isInteger(config.seed) ||
    config.seed < 0 ||
    config.seed > 4294967295 ||
    !["timer", "scheduled"].includes(config.timing)
  ) {
    throw new Error(
      "Check the simulation settings: prices, size and times must be positive; costs, RV and bands cannot be negative.",
    );
  }
  if (!Array.isArray(config.legs) || !config.legs.length || config.legs.length > 4)
    throw new Error("Choose between one and four option legs.");
  for (const leg of config.legs) {
    if (![leg.strike, leg.maturity, leg.signedQty].every(Number.isFinite) ||
        leg.strike <= 0 || leg.maturity <= 0 || leg.signedQty === 0 ||
        !["call", "put"].includes(leg.optionType))
      throw new Error("Every leg needs a positive strike, maturity and nonzero quantity.");
  }
  if (config.horizon > Math.max(...config.legs.map(leg => leg.maturity)) + 1e-6)
    throw new Error("Holding period cannot exceed the last option expiry.");
  if (config.tolerance > 0 && config.tolerance < config.threshold)
    throw new Error(
      "Tolerance must be at least the threshold, or zero to disable it.",
    );
  if (config.step > config.period)
    throw new Error("Simulation step must be no longer than the hedge period.");
  if (
    config.timing === "scheduled" &&
    Math.abs(
      config.period / config.step - Math.round(config.period / config.step),
    ) > 1e-8
  ) {
    throw new Error(
      "For scheduled checks, choose a period that is a multiple of the simulation step.",
    );
  }
}

/** One spot path, an option position and its net-delta hedge. No fetches or UI state. */
export function simulatePosition(config) {
  validate(config);
  const curve = buildForwardCurve(config.nodes, config.horizon);
  const legs = config.legs.map(leg => {
    const legCurve = buildForwardCurve(config.nodes, leg.maturity);
    return {
      ...leg,
      curve: legCurve,
      entryIv: legCurve.entryIv,
      exitIv: legCurve.remainingIv(config.horizon),
      entryPrice: calcOptionPrice(config.spot, leg.strike, leg.maturity, legCurve.entryIv, leg.optionType),
    };
  });
  const hedgePolicy = {
    threshold: config.threshold,
    tolerance: config.tolerance,
    period: config.period,
    timing: config.timing,
  };
  // The path clock never depends on hedging settings: same seed, same moves.
  // Include variance boundaries and the exact exit, even for partial steps.
  const times = new Set([0, config.horizon]);
  const estimated = config.horizon / config.step;
  if (estimated > 120000)
    throw new Error(
      "This run exceeds 120,000 steps. Choose a shorter holding period.",
    );
  for (let t = config.step; t < config.horizon; t += config.step) times.add(t);
  for (const interval of curve.intervals)
    if (interval.end < config.horizon) times.add(interval.end);
  for (const leg of legs)
    if (leg.maturity < config.horizon) times.add(leg.maturity);
  const clock = [...times].sort((a, b) => a - b);
  const normal = normals(config.seed);
  const entryValue = legs.reduce((sum, leg) => sum + leg.signedQty * leg.entryPrice, 0);
  // Gross premium stays meaningful for zero-cost spreads and offsetting legs.
  const premium = legs.reduce((sum, leg) => sum + Math.abs(leg.signedQty) * leg.entryPrice, 0);
  if (!(premium > 1e-8))
    throw new Error("Opening option value is too small. Choose strikes closer to spot or longer maturities.");
  const grossQuantity = legs.reduce((sum, leg) => sum + Math.abs(leg.signedQty), 0);
  const buckets = Object.fromEntries(ATTRIBUTION.map((item) => [item.key, 0]));
  const settlements = [],
    settledValues = legs.map(() => null),
    trades = [],
    rows = [];
  // Settled cash stays fixed; only live legs continue to revalue with spot.
  const optionValueAt = (price, elapsed, vols) => legs.reduce((sum, leg, i) =>
    sum + (settledValues[i] ?? leg.signedQty * calcOptionPrice(
      price, leg.strike, Math.max(0, leg.maturity - elapsed), vols[i], leg.optionType,
    )), 0);
  let spot = config.spot,
    position = 0,
    cash = 0,
    optionFees = (grossQuantity * spot * config.optionBps) / 10000;
  let fees = optionFees;
  let hedgePnl = 0,
    breachSince = null,
    previous,
    previousIvs,
    sampledVariance = 0;
  const execute = (elapsed, target, reason, netDeltaBefore) => {
    const amount = target - position;
    if (Math.abs(amount) < 1e-12) return;
    const cost = (Math.abs(amount) * spot * config.hedgeBps) / 10000;
    cash -= amount * spot;
    position = target;
    fees += cost;
    trades.push({
      elapsed,
      spot,
      amount,
      position,
      reason,
      cost,
      netDeltaBefore,
      netDeltaAfter: 0,
    });
  };
  for (const elapsed of clock) {
    const exit = elapsed === config.horizon;
    // Every leg rolls its own remaining variance from the same calendar-time curve.
    const ivs = legs.map(leg => leg.curve.remainingIv(elapsed));
    const iv = ivs[0];
    const forwardVol = (
      curve.intervals.find((interval) => elapsed < interval.end) ||
      curve.intervals.at(-1)
    ).iv;
    if (previous) {
      const dt = elapsed - previous.elapsed;
      const variance = Math.max(
        0,
        curve.varianceAt(elapsed) - curve.varianceAt(previous.elapsed),
      );
      const pathVariance = variance * config.rvMultiplier ** 2;
      const logReturn =
        (config.drift * dt) / YEAR -
        0.5 * pathVariance +
        Math.sqrt(pathVariance) * normal();
      spot *= Math.exp(logReturn);
      if (!Number.isFinite(spot) || spot <= 0)
        throw new Error(
          "Path overflow. Reduce the drift or volatility settings.",
        );
      sampledVariance += logReturn ** 2;
      hedgePnl += position * (spot - previous.spot);
      const timeValue = optionValueAt(previous.spot, elapsed, previousIvs);
      const rollValue = optionValueAt(previous.spot, elapsed, ivs);
      const endValue = optionValueAt(spot, elapsed, ivs);
      const direction = previous.optionDelta * (spot - previous.spot);
      const gamma = 0.5 * previous.gamma * (spot - previous.spot) ** 2;
      buckets.theta += timeValue - previous.optionValue;
      buckets.roll += rollValue - timeValue;
      buckets.delta += direction;
      buckets.gamma += gamma;
      buckets.residual += endValue - rollValue - direction - gamma;
    }
    legs.forEach((leg, i) => {
      if (settledValues[i] !== null || elapsed < leg.maturity) return;
      const amount = leg.signedQty * calcOptionPrice(spot, leg.strike, 0, 0, leg.optionType);
      settledValues[i] = amount;
      settlements.push({
        legIndex: i,
        instrumentName: leg.instrumentName,
        elapsed,
        spot,
        amount,
      });
    });
    const greeks = legs.reduce((total, leg, i) => {
      if (settledValues[i] !== null) return total;
      const risk = optionRisk(spot, leg, Math.max(0, leg.maturity - elapsed), ivs[i]);
      for (const key of ["delta", "gamma", "vega"]) total[key] += leg.signedQty * risk[key];
      return total;
    }, { delta: 0, gamma: 0, vega: 0 });
    const optionDelta = greeks.delta;
    const netDeltaBefore = optionDelta + position;
    let trigger = null;
    if (!previous) {
      trigger = "entry";
      execute(elapsed, -optionDelta, trigger, netDeltaBefore);
    } else if (exit) {
      trigger = "exit";
      execute(elapsed, 0, trigger, netDeltaBefore);
      // Expiring legs cash-settle; later-dated legs close at model marks.
      const closingQuantity = legs.reduce((sum, leg) =>
        sum + (leg.maturity - elapsed > 1e-6 ? Math.abs(leg.signedQty) : 0), 0);
      const closeFee = (closingQuantity * spot * config.optionBps) / 10000;
      optionFees += closeFee;
      fees += closeFee;
    } else {
      const decision = hedgeDecision(
        { elapsed, netDelta: netDeltaBefore, breachSince },
        hedgePolicy,
      );
      breachSince = decision.breachSince;
      trigger = decision.reason;
      if (trigger) execute(elapsed, -optionDelta, trigger, netDeltaBefore);
    }
    const optionValue = optionValueAt(spot, elapsed, ivs);
    const optionPnl = optionValue - entryValue;
    buckets.hedge = hedgePnl;
    buckets.costs = -fees;
    const pnl = optionPnl + hedgePnl - fees;
    const reconciled = Object.values(buckets).reduce((a, b) => a + b, 0);
    if (
      ![pnl, optionValue, optionDelta, reconciled].every(Number.isFinite) ||
      Math.abs(pnl - reconciled) > Math.max(1e-6, Math.abs(pnl) * 1e-9)
    ) {
      throw new Error("Simulation accounting failed to reconcile.");
    }
    const row = {
      elapsed,
      spot,
      iv,
      forwardVol,
      rvVol: forwardVol * config.rvMultiplier,
      optionDelta: exit ? 0 : optionDelta,
      gamma: exit ? 0 : greeks.gamma,
      vega: exit ? 0 : greeks.vega,
      optionValue,
      settledValue: settledValues.reduce((sum, value) => sum + (value ?? 0), 0),
      optionPnl,
      hedgePnl,
      fees,
      optionFees,
      hedgeFees: fees - optionFees,
      pnl,
      position,
      cash,
      netDeltaBefore,
      netDelta: exit ? 0 : optionDelta + position,
      trigger,
      returnOnPremium: pnl / premium,
      buckets: { ...buckets },
    };
    rows.push(row);
    previous = row;
    previousIvs = ivs;
  }
  return {
    config: structuredClone(config),
    rows,
    trades,
    settlements,
    curve: { intervals: curve.intervals, entryIv: curve.entryIv },
    premium,
    entryValue,
    legs: legs.map(({ curve, ...leg }) => leg),
    end: rows.at(-1),
    targetRv:
      Math.sqrt((curve.varianceAt(config.horizon) * YEAR) / config.horizon) *
      config.rvMultiplier,
    sampledRv: Math.sqrt((sampledVariance * YEAR) / config.horizon),
    maxDrawdown: rows.reduce(
      (state, row) => ({
        peak: Math.max(state.peak, row.pnl),
        drawdown: Math.max(
          state.drawdown,
          Math.max(state.peak, row.pnl) - row.pnl,
        ),
      }),
      { peak: 0, drawdown: 0 },
    ).drawdown,
  };
}
