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

const straddlePrice = (spot, strike, remaining, iv) =>
  calcOptionPrice(spot, strike, remaining, iv, "call") +
  calcOptionPrice(spot, strike, remaining, iv, "put");

function risk(spot, strike, remaining, iv) {
  if (remaining <= 0 || iv === 0)
    return { delta: Math.sign(spot - strike), gamma: 0, vega: 0 };
  const call = calcGreeks(spot, strike, remaining, iv, "call");
  return {
    delta: 2 * call.delta - 1,
    gamma: 2 * call.gamma,
    vega: 2 * call.vega,
  };
}

function validate(config) {
  const positive = [
    "spot",
    "strike",
    "quantity",
    "maturity",
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
    !["buy", "sell"].includes(config.side) ||
    !["timer", "scheduled"].includes(config.timing)
  ) {
    throw new Error(
      "Check the simulation settings: prices, size and times must be positive; costs, RV and bands cannot be negative; seed must be a 32-bit unsigned integer.",
    );
  }
  if (config.horizon > config.maturity + 1e-6)
    throw new Error("Holding period cannot exceed option maturity.");
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

/** One seeded path and one fixed-strike straddle. No fetches or UI state. */
export function simulateStraddle(config) {
  validate(config);
  const curve = buildForwardCurve(config.nodes, config.maturity);
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
      "This run exceeds 120,000 steps. Increase the simulation step or shorten the holding period.",
    );
  for (let t = config.step; t < config.horizon; t += config.step) times.add(t);
  for (const interval of curve.intervals)
    if (interval.end < config.horizon) times.add(interval.end);
  const clock = [...times].sort((a, b) => a - b);
  const quantity = config.quantity * (config.side === "sell" ? -1 : 1);
  const normal = normals(config.seed);
  const entryPrice = straddlePrice(
    config.spot,
    config.strike,
    config.maturity,
    curve.entryIv,
  );
  const premium = entryPrice * config.quantity;
  if (!(premium > 1e-8))
    throw new Error(
      "Opening premium is too small. Choose a strike closer to spot or a longer maturity.",
    );
  const buckets = Object.fromEntries(ATTRIBUTION.map((item) => [item.key, 0]));
  const trades = [],
    rows = [];
  let spot = config.spot,
    position = 0,
    cash = 0,
    optionFees = (2 * config.quantity * spot * config.optionBps) / 10000;
  let fees = optionFees;
  let hedgePnl = 0,
    breachSince = null,
    previous,
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
    const remaining = Math.max(0, config.maturity - elapsed);
    // Marks use only the variance left in the captured calendar-time curve.
    const iv = curve.remainingIv(elapsed);
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
      const priceAt = (s, vol) =>
        quantity * straddlePrice(s, config.strike, remaining, vol);
      const timeValue = priceAt(previous.spot, previous.iv);
      const rollValue = priceAt(previous.spot, iv);
      const endValue = priceAt(spot, iv);
      const direction = previous.optionDelta * (spot - previous.spot);
      const gamma = 0.5 * previous.gamma * (spot - previous.spot) ** 2;
      buckets.theta += timeValue - previous.optionValue;
      buckets.roll += rollValue - timeValue;
      buckets.delta += direction;
      buckets.gamma += gamma;
      buckets.residual += endValue - rollValue - direction - gamma;
    }
    const greeks = risk(spot, config.strike, remaining, iv);
    const optionDelta = quantity * greeks.delta;
    const netDeltaBefore = optionDelta + position;
    let trigger = null;
    if (!previous) {
      trigger = "entry";
      execute(elapsed, -optionDelta, trigger, netDeltaBefore);
    } else if (exit) {
      trigger = "exit";
      execute(elapsed, 0, trigger, netDeltaBefore);
      // Options settle at maturity; otherwise close both legs at model marks.
      if (remaining > 1e-6) {
        const closeFee =
          (2 * config.quantity * spot * config.optionBps) / 10000;
        optionFees += closeFee;
        fees += closeFee;
      }
    } else {
      const decision = hedgeDecision(
        { elapsed, netDelta: netDeltaBefore, breachSince },
        hedgePolicy,
      );
      breachSince = decision.breachSince;
      trigger = decision.reason;
      if (trigger) execute(elapsed, -optionDelta, trigger, netDeltaBefore);
    }
    const optionValue =
      quantity * straddlePrice(spot, config.strike, remaining, iv);
    const optionPnl = optionValue - quantity * entryPrice;
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
      gamma: quantity * greeks.gamma,
      vega: quantity * greeks.vega,
      optionValue,
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
  }
  return {
    config: structuredClone(config),
    rows,
    trades,
    curve: { intervals: curve.intervals, entryIv: curve.entryIv },
    premium,
    entryPrice,
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
