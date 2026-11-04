export type OptionGreeks = {
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  price: number;
};

export const computeOptionOmega = (
  delta: number,
  spot: number,
  optionPrice: number,
): number | null => {
  if (
    !Number.isFinite(delta) ||
    !Number.isFinite(spot) ||
    spot <= 0 ||
    !Number.isFinite(optionPrice) ||
    optionPrice <= 0
  ) {
    return null;
  }
  const omega = Math.abs((delta * spot) / optionPrice);
  return Number.isFinite(omega) ? omega : null;
};

const normalCDF = (x: number): number => {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  // The coefficients approximate erf(x). The normal CDF is
  // 0.5 * (1 + erf(x / sqrt(2))), so the approximation must receive
  // the scaled input throughout, including in t.
  x = Math.abs(x) / Math.sqrt(2);

  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 -
    ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) *
      t *
      Math.exp(-x * x);

  return 0.5 * (1.0 + sign * y);
};

const normalPDF = (x: number): number => {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
};

export const blackScholesGreeks = (
  spot: number,
  strike: number,
  T: number,
  vol: number,
  r: number,
  optionType: "call" | "put",
): OptionGreeks => {
  if (T <= 0 || vol <= 0 || spot <= 0 || strike <= 0) {
    const intrinsic =
      optionType === "call"
        ? Math.max(0, spot - strike)
        : Math.max(0, strike - spot);
    return {
      delta: optionType === "call" ? (spot > strike ? 1 : 0) : (spot < strike ? -1 : 0),
      gamma: 0,
      theta: 0,
      vega: 0,
      price: intrinsic,
    };
  }

  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(spot / strike) + (r + 0.5 * vol * vol) * T) / (vol * sqrtT);
  const d2 = d1 - vol * sqrtT;

  const Nd1 = normalCDF(d1);
  const Nd2 = normalCDF(d2);
  const Nnd1 = normalCDF(-d1);
  const Nnd2 = normalCDF(-d2);
  const nd1 = normalPDF(d1);

  let price: number;
  let delta: number;

  if (optionType === "call") {
    price = spot * Nd1 - strike * Math.exp(-r * T) * Nd2;
    delta = Nd1;
  } else {
    price = strike * Math.exp(-r * T) * Nnd2 - spot * Nnd1;
    delta = -Nnd1;
  }

  const gamma = nd1 / (spot * vol * sqrtT);
  const vega = spot * nd1 * sqrtT / 100;
  const theta =
    optionType === "call"
      ? (-(spot * nd1 * vol) / (2 * sqrtT) -
          r * strike * Math.exp(-r * T) * Nd2) / 365
      : (-(spot * nd1 * vol) / (2 * sqrtT) +
          r * strike * Math.exp(-r * T) * Nnd2) / 365;

  return { delta, gamma, theta, vega, price };
};

export const computeBreakeven = (
  legs: Array<{
    side: "buy" | "sell";
    qty: number;
    optionType: "call" | "put";
    strike: number;
    premium: number;
  }>,
): number | null => {
  if (legs.length === 0) return null;

  const totalPremium = legs.reduce((sum, leg) => {
    const sign = leg.side === "buy" ? -1 : 1;
    return sum + sign * leg.qty * leg.premium;
  }, 0);

  const strikes = [...new Set(legs.map((l) => l.strike))].sort((a, b) => a - b);
  if (strikes.length === 0) return null;

  const minStrike = strikes[0];
  const maxStrike = strikes[strikes.length - 1];
  const range = maxStrike - minStrike || maxStrike * 0.5;

  const testPoints: number[] = [];
  for (let i = 0; i <= 200; i++) {
    testPoints.push(minStrike - range + (i / 200) * (range * 3));
  }

  let prevPayoff: number | null = null;
  for (const price of testPoints) {
    let payoff = totalPremium;
    for (const leg of legs) {
      const sign = leg.side === "buy" ? 1 : -1;
      const intrinsic =
        leg.optionType === "call"
          ? Math.max(0, price - leg.strike)
          : Math.max(0, leg.strike - price);
      payoff += sign * leg.qty * intrinsic;
    }

    if (prevPayoff !== null && prevPayoff * payoff < 0) {
      return price;
    }
    prevPayoff = payoff;
  }

  return null;
};
