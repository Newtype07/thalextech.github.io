import { calcOptionPrice, normalCdf } from "../../../lib/thalex.js";

const YEAR = 365.25 * 86400;
const ZERO = 1e-7;
const intrinsic = (price, leg) => leg.optionType === "put"
  ? Math.max(leg.strike - price, 0)
  : Math.max(price - leg.strike, 0);

export function payoffAtPrice(legs, price, horizonTs, referenceForward) {
  return legs.reduce((total, leg) => {
    const remaining = Math.max(0, leg.expirationTs - horizonTs);
    // Hold relative forwards and each leg's IV constant for calendar scenarios.
    const forward = price * leg.forward / referenceForward;
    const value = remaining === 0 || leg.iv === 0
      ? intrinsic(forward, leg)
      : forward === 0 ? (leg.optionType === "put" ? leg.strike : 0)
        : calcOptionPrice(forward, leg.strike, remaining, leg.iv, leg.optionType);
    return total + leg.signedQty * (value - leg.premium);
  }, 0);
}

function bisect(fn, left, right) {
  let leftValue = fn(left);
  for (let i = 0; i < 80; i++) {
    const mid = (left + right) / 2;
    const value = fn(mid);
    if (Math.abs(value) < ZERO) return mid;
    if (Math.sign(value) === Math.sign(leftValue)) {
      left = mid;
      leftValue = value;
    } else right = mid;
  }
  return (left + right) / 2;
}

function zeroCrossings(prices, fn, linear) {
  const points = [], ranges = [];
  const add = (price) => {
    if (!points.some((p) => Math.abs(price - p) < 1e-5)) points.push(price);
  };
  for (let i = 0; i < prices.length - 1; i++) {
    const left = prices[i], right = prices[i + 1];
    const a = fn(left), b = fn(right);
    if ((linear && Math.abs(a) < ZERO && Math.abs(b) < ZERO) ||
        (a === 0 && b === 0 && fn((left + right) / 2) === 0)) {
      const previous = ranges.at(-1);
      if (previous?.to === left) previous.to = right;
      else ranges.push({ from: left, to: right });
    } else {
      if (Math.abs(a) < ZERO) add(left);
      if (Math.abs(b) < ZERO) add(right);
      if (a * b < 0) add(linear ? left - a * (right - left) / (b - a) : bisect(fn, left, right));
    }
  }
  return { points: points.filter((p) => !ranges.some((r) => p >= r.from && p <= r.to)), ranges };
}

function winProbability(valueAt, breakEvens, forward, deviation) {
  if (deviation === 0) return valueAt(forward) > ZERO ? 1 : 0;
  const cdf = (price) => price <= 0 ? 0 : price === Infinity ? 1
    : normalCdf((Math.log(price / forward) + deviation ** 2 / 2) / deviation);
  const boundaries = [...new Set([
    0, ...breakEvens.points,
    ...breakEvens.ranges.flatMap(({ from, to }) => [from, to]), Infinity,
  ])].sort((a, b) => a - b);
  let probability = 0;
  for (let i = 1; i < boundaries.length; i++) {
    const left = boundaries[i - 1], right = boundaries[i];
    const midpoint = right === Infinity ? left + Math.max(left, forward) : left + (right - left) / 2;
    if (valueAt(midpoint) > ZERO) probability += cdf(right) - cdf(left);
  }
  return Math.max(0, Math.min(1, probability));
}

export function buildPayoff(legs, nowTs = Date.now() / 1000, { probabilityIv = null } = {}) {
  if (!legs.length) return null;
  for (const leg of legs) {
    if (![leg.strike, leg.signedQty, leg.expirationTs, leg.premium, leg.forward].every(Number.isFinite) ||
        leg.strike <= 0 || leg.premium < 0 || leg.forward <= 0 || leg.expirationTs <= nowTs ||
        !["call", "put"].includes(leg.optionType)) {
      throw new Error("Select unexpired option legs with current marks and forwards.");
    }
  }
  const horizonTs = Math.min(...legs.map((leg) => leg.expirationTs));
  const first = legs.find((leg) => leg.expirationTs === horizonTs);
  const forward = first.forward;
  const mixedMaturities = legs.some((leg) => leg.expirationTs !== horizonTs);
  if (mixedMaturities && legs.some((leg) => leg.expirationTs > horizonTs && (!Number.isFinite(leg.iv) || leg.iv < 0))) {
    throw new Error("Current IV is required for later-maturity legs.");
  }
  // A maturity has one reference forward, even if its tickers were marked at different instants.
  const forwards = new Map();
  for (const leg of legs) if (!forwards.has(leg.expirationTs)) forwards.set(leg.expirationTs, leg.forward);
  const normalized = legs.map((leg) => ({ ...leg, forward: forwards.get(leg.expirationTs) }));
  const valueAt = (price) => payoffAtPrice(normalized, price, horizonTs, forward);
  const strikes = [...new Set(legs.map((leg) => leg.strike))].sort((a, b) => a - b);
  const vol = Math.max(0.1, ...legs.map((leg) => leg.iv ?? 0.4));
  const halfWidth = Math.max(forward * 0.15, forward * 3 * vol * Math.sqrt((horizonTs - nowTs) / YEAR));
  let minPrice = Math.max(0, Math.min(forward - halfWidth, strikes[0] * 0.9));
  let maxPrice = Math.max(forward + halfWidth, strikes.at(-1) * 1.1);
  let breakEvens;
  if (!mixedMaturities) {
    // Intrinsic payoffs are exactly linear between strikes. Solve the tails too,
    // so break-evens cannot disappear just because they are outside the initial viewport.
    const last = strikes.at(-1);
    const slope = legs.filter((leg) => leg.optionType === "call").reduce((sum, leg) => sum + leg.signedQty, 0);
    const tailRoot = Math.abs(slope) > 1e-12 ? last - valueAt(last) / slope : last;
    const upper = Math.max(maxPrice, tailRoot + forward * 0.1, last + forward);
    breakEvens = zeroCrossings([0, ...strikes, upper], valueAt, true);
    for (const range of breakEvens.ranges) if (range.to === upper) range.to = Infinity;
    if (breakEvens.points.length) {
      minPrice = Math.max(0, Math.min(minPrice, breakEvens.points[0] - forward * 0.05));
      maxPrice = Math.max(maxPrice, breakEvens.points.at(-1) + forward * 0.05);
    }
  } else {
    const scan = Array.from({ length: 4097 }, (_, i) => minPrice + (maxPrice - minPrice) * i / 4096);
    breakEvens = zeroCrossings([...new Set([...scan, ...strikes])].sort((a, b) => a - b), valueAt, false);
  }
  let probabilityOfProfit = null;
  if (Number.isFinite(probabilityIv) && probabilityIv >= 0) {
    const deviation = probabilityIv * Math.sqrt((horizonTs - nowTs) / YEAR);
    let probabilityBreakEvens = breakEvens;
    if (mixedMaturities && deviation > 0) {
      // Scan the distribution independently of the visible chart. Nine standard
      // deviations leave negligible tail mass; strikes preserve narrow features.
      const scan = Array.from({ length: 2049 }, (_, i) =>
        forward * Math.exp(deviation * (-9 + 18 * i / 2048) - deviation ** 2 / 2));
      probabilityBreakEvens = zeroCrossings([...new Set([
        0, ...scan, ...strikes, ...breakEvens.points,
        ...breakEvens.ranges.flatMap(({ from, to }) => [from, to]).filter(Number.isFinite),
      ])].sort((a, b) => a - b), valueAt, false);
    }
    probabilityOfProfit = winProbability(valueAt, probabilityBreakEvens, forward, deviation);
  }
  const prices = [...new Set([
    ...Array.from({ length: 401 }, (_, i) => minPrice + (maxPrice - minPrice) * i / 400),
    ...strikes, ...breakEvens.points, forward,
  ])].filter((p) => p >= minPrice && p <= maxPrice).sort((a, b) => a - b);
  const points = prices.map((price) => ({ price, pnl: valueAt(price) }));
  // Keep every time slice on the expiry curve's price grid and entry-cost basis.
  // Missing IV must not remove an otherwise valid intrinsic expiry payoff.
  const hasValuationVol = normalized.every(leg => Number.isFinite(leg.iv) && leg.iv >= 0);
  const decayCurves = hasValuationVol ? [0, 0.25, 0.5, 0.75].map(elapsedFraction => {
    const timestamp = nowTs + (horizonTs - nowTs) * elapsedFraction;
    return {
      elapsedFraction, timestamp,
      label: elapsedFraction === 0 ? "Now" : `${elapsedFraction * 100}% elapsed`,
      points: prices.map(price => ({ price, pnl: payoffAtPrice(normalized, price, timestamp, forward) })),
    };
  }) : [];
  // Same-expiry payoffs are linear between strikes and beyond the last strike.
  // Extrema therefore occur at zero/strikes unless the call tail is unbounded.
  const bounds = mixedMaturities ? points.map(point => point.pnl) : [0, ...strikes].map(valueAt);
  const tailSlope = normalized.filter(leg => leg.optionType === "call").reduce((sum, leg) => sum + leg.signedQty, 0);
  const maxLoss = !mixedMaturities && tailSlope < -1e-12 ? Infinity : Math.max(0, -Math.min(...bounds));
  const maxReturn = !mixedMaturities && tailSlope > 1e-12 ? Infinity : Math.max(0, Math.max(...bounds));
  return {
    forward, horizonTs, mixedMaturities, breakEvens, probabilityOfProfit,
    maxLoss, maxReturn,
    decayCurves,
    decayUnavailableReason: hasValuationVol ? "" : "Time curves require a current IV for every leg.",
    netPremium: legs.reduce((sum, leg) => sum + leg.signedQty * leg.premium, 0),
    points,
  };
}
