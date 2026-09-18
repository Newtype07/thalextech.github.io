import { calcOptionPrice } from "../../../../lib/thalex.js";

// Existing chart accumulation, preserved independently of endpoint repricing.
export function calculatePathwiseAttribution(pnlWindow) {
  const cumulative = {
    total: 0,
    delta: 0,
    gammaTheta: 0,
    vega: 0,
    residual: 0,
  };
  const seriesByKey = {
    total: [],
    delta: [],
    gammaTheta: [],
    vega: [],
    residual: [],
  };

  pnlWindow.forEach((point, index) => {
    const date = point.date;

    // The first point marks the start of our range (t=0).
    // We set it to zero and skip its P&L values, because point.PL
    // represents the interval *ending* at this timestamp (before our window).
    if (index === 0) {
      seriesByKey.total.push({ date, value: 0 });
      seriesByKey.delta.push({ date, value: 0 });
      seriesByKey.gammaTheta.push({ date, value: 0 });
      seriesByKey.vega.push({ date, value: 0 });
      seriesByKey.residual.push({ date, value: 0 });
      return;
    }

    // Accumulate P&L for all points after the first
    const deltaPL = Number.isFinite(point.delta_PL) ? point.delta_PL : 0;
    const gammaThetaPL = Number.isFinite(point.gamma_theta_PL)
      ? point.gamma_theta_PL
      : 0;
    const vegaPL = Number.isFinite(point.vega_PL) ? point.vega_PL : 0;
    const residualPL = Number.isFinite(point.residual_PL)
      ? point.residual_PL
      : 0;
    const totalPL = Number.isFinite(point.PL)
      ? point.PL
      : deltaPL + gammaThetaPL + vegaPL + residualPL;

    cumulative.delta += deltaPL;
    cumulative.gammaTheta += gammaThetaPL;
    cumulative.vega += vegaPL;
    cumulative.residual += residualPL;
    cumulative.total += totalPL;

    seriesByKey.total.push({ date, value: cumulative.total });
    seriesByKey.delta.push({ date, value: cumulative.delta });
    seriesByKey.gammaTheta.push({ date, value: cumulative.gammaTheta });
    seriesByKey.vega.push({ date, value: cumulative.vega });
    seriesByKey.residual.push({ date, value: cumulative.residual });
  });

  return seriesByKey;
}

const PERMUTATIONS = [
  [0, 1, 2], [0, 2, 1], [1, 0, 2],
  [1, 2, 0], [2, 0, 1], [2, 1, 0],
];

// Only the two endpoints enter this calculation. IV is the option's own marked IV.
export function calculateEndStateAttribution(entry, current, { strike, optionType }) {
  const before = [entry.spot, entry.iv, entry.tteSeconds];
  const after = [current.spot, current.iv, current.tteSeconds];
  const price = ([spot, iv, time]) => calcOptionPrice(spot, strike, time, iv, optionType);
  const total = Number.isFinite(entry.mark) && Number.isFinite(current.mark)
    ? current.mark - entry.mark : NaN;
  // Cache the eight hybrid states shared by all six orders.
  const prices = Array.from({ length: 8 }, (_, mask) =>
    price(before.map((value, factor) => mask & (1 << factor) ? after[factor] : value)),
  );
  if (!prices.every(Number.isFinite)) {
    return { spot: NaN, volatility: NaN, time: NaN, residual: NaN, total };
  }
  const contributions = [0, 0, 0];
  for (const order of PERMUTATIONS) {
    let mask = 0;
    for (const factor of order) {
      const next = mask | (1 << factor);
      contributions[factor] += (prices[next] - prices[mask]) / PERMUTATIONS.length;
      mask = next;
    }
  }
  const [spot, volatility, time] = contributions;
  return { spot, volatility, time, residual: total - (spot + volatility + time), total };
}

const closeState = (point) => ({
  spot: point.index_price_close,
  iv: point.iv_close,
  tteSeconds: point.tte_seconds,
  mark: point.mark_price_close,
});

export function calculateAttribution(points, instrument, method = "pathwise") {
  if (method === "pathwise") return calculatePathwiseAttribution(points);
  const series = { spot: [], volatility: [], time: [], residual: [], total: [] };
  if (!points.length) return series;
  const entry = closeState(points[0]);
  const contract = {
    strike: Number(instrument?.strike_price),
    optionType: instrument?.option_type?.toLowerCase?.() === "put" ? "put" : "call",
  };
  for (const point of points) {
    const attribution = calculateEndStateAttribution(entry, closeState(point), contract);
    for (const key of Object.keys(series)) {
      series[key].push({ date: point.date, value: attribution[key] });
    }
  }
  return series;
}
