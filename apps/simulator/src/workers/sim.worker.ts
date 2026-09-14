import { blackScholesGreeks } from "../lib/blackScholes.ts";
import { adaptiveStopSubsteps } from "../lib/adaptiveStopSampling.ts";
import type { GBMParams } from "../lib/gbm.ts";
import {
  stochasticVarianceParameters,
  type PathModelParams,
} from "../lib/pathModel.ts";
import type { FutureLeg, OptionLeg, PositionLeg } from "../lib/position.ts";
import {
  advanceBatesState,
  buildQuadraticVariationBudget,
  createBatesProcess,
  createBatesState,
  type BatesCalibration,
  type BatesProcess,
} from "../../../../lib/batesSimulation.js";

type OptionPricingInput = {
  iv: number | null;
  mark: number | null;
  expirationTs: number | null;
};

type SimWorkerRequest = {
  id: number;
  seed: number;
  params: GBMParams;
  pathModel: PathModelParams;
  legs: PositionLeg[];
  optionPricingByLegId: Record<string, OptionPricingInput>;
  valuationTs: number;
  horizonSeconds: number;
  histBins: number;
  histBinsMultiplier: number;
  samplePathLimit: number;
  returnSamplePaths?: boolean;
  samplingStopLoss?: {
    side: "buy" | "sell";
    price: number;
  };
};

type SimBin = {
  x0: number;
  x1: number;
  count: number;
  sumPayoff: number;
  medianPayoff: number;
  p10Payoff: number;
  p25Payoff: number;
  p50Payoff: number;
  p75Payoff: number;
  p90Payoff: number;
  winCount: number;
  maxLossCount: number;
  opportunityCostSum: number;
  maxIntermediatePnl: number | null;
};

type SimWorkerSuccess = {
  id: number;
  steps: number;
  rows: number;
  sampleRows: number;
  sampledPathRows: number;
  sampledPathsBuffer: ArrayBuffer;
  sampledFinalPricesBuffer: ArrayBuffer;
  sampledPayoffsBuffer: ArrayBuffer;
  terminalPricesBuffer: ArrayBuffer;
  terminalPayoffsBuffer: ArrayBuffer;
  bins: SimBin[];
  pathMin: number;
  pathMax: number;
  finalPriceMin: number;
  finalPriceMax: number;
  payoffMin: number;
  payoffMax: number;
  meanPayoff: number;
  medianPayoff: number;
  maxPayoff: number;
  maxDrawdown: number;
  winRate: number;
  p05Payoff: number;
  p10Payoff: number;
  p25Payoff: number;
  p50Payoff: number;
  p75Payoff: number;
  p90Payoff: number;
  p95Payoff: number;
  maxLossRate: number;
  opportunityCost: number;
};

type SimWorkerError = {
  id: number;
  error: string;
};

type PreparedOptionLeg = {
  sign: number;
  qty: number;
  strike: number;
  optionType: OptionLeg["optionType"];
  iv: number;
  entryPrice: number;
  entryRemainingYears: number;
};

type PreparedFuturePathLeg = {
  sign: number;
  qty: number;
  entry: number | null;
  stopLoss: number | null;
  isBuy: boolean;
  annualFundingRate: number;
};
type TailCandidate = {
  index: number;
  finalPrice: number;
};

type Rng = () => number;
type Randn = () => number;

const SECONDS_PER_YEAR = 365.25 * 24 * 60 * 60;
const RISK_FREE_RATE = 0.0;
const TAIL_PATH_POOL_SIZE = 20;
const BATES_SECONDS_PER_YEAR = 365 * 24 * 60 * 60;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const mulberry32 = (seed: number): Rng => {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
};

const makeRandn = (rng: Rng): Randn => {
  let spare: number | null = null;
  return () => {
    if (spare !== null) {
      const z = spare;
      spare = null;
      return z;
    }
    let u = 0;
    let v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    const magnitude = Math.sqrt(-2 * Math.log(u));
    const angle = 2 * Math.PI * v;
    spare = magnitude * Math.sin(angle);
    return magnitude * Math.cos(angle);
  };
};

const medianOfTypedArray = (values: Float64Array): number => {
  const n = values.length;
  if (n === 0) return 0;
  const sorted = Array.from(values).sort((a, b) => a - b);
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) * 0.5 : sorted[mid];
};

const quantileSorted = (sorted: Float64Array, p: number): number => {
  const n = sorted.length;
  if (!n) return 0;
  if (n === 1) return sorted[0];
  const clampedP = clamp(p, 0, 1);
  const idx = (n - 1) * clampedP;
  const lo = Math.floor(idx);
  const hi = Math.min(n - 1, lo + 1);
  if (lo === hi) return sorted[lo];
  const t = idx - lo;
  return sorted[lo] * (1 - t) + sorted[hi] * t;
};

const prepareBatesProcess = (
  request: SimWorkerRequest,
): BatesProcess | null => {
  if (request.pathModel.kind !== "bates") return null;
  const model = request.pathModel;
  const jumpIntensity = model.jumpsEnabled ? model.jumpIntensity : 0;
  const jumpVariance = model.jumpVol ** 2;
  const jumpSecondMoment = jumpVariance + model.jumpMean ** 2;
  const regimeJumpParameters = {
    low: { intensity: jumpIntensity },
    medium: { intensity: jumpIntensity },
    high: { intensity: jumpIntensity },
  };
  const calibration: BatesCalibration = {
    variance: stochasticVarianceParameters(request.params.vol, model),
    jumps: {
      logMean: model.jumpMean,
      logStdDev: model.jumpVol,
      logSecondMoment: jumpSecondMoment,
      compensatorMean: Math.exp(model.jumpMean + 0.5 * jumpVariance) - 1,
      byRegime: regimeJumpParameters,
    },
    regimeCutoffs: {
      lowToMedium: Number.NEGATIVE_INFINITY,
      mediumToHigh: Number.POSITIVE_INFINITY,
    },
  };
  const entryTs = request.valuationTs;
  const cycle = {
    entryTs,
    exitTs: entryTs + request.params.T * BATES_SECONDS_PER_YEAR,
    sigma: request.params.vol,
  };
  const budget = buildQuadraticVariationBudget({
    cycle,
    calibration,
    maxJumpVarianceShare: model.maxJumpVarianceShare,
  });
  return createBatesProcess({
    calibration,
    budget,
    annualDrift: request.params.mu,
  });
};

const computeAdaptiveBinCount = (
  values: Float64Array,
  rangeMin: number,
  rangeMax: number,
  maxBins: number,
): number => {
  const n = values.length;
  const range = rangeMax - rangeMin;
  if (n < 2 || !Number.isFinite(range) || range <= 0) {
    return clamp(maxBins, 10, 400);
  }

  const sorted = Float64Array.from(values);
  sorted.sort();
  const q1 = quantileSorted(sorted, 0.25);
  const q3 = quantileSorted(sorted, 0.75);
  const iqr = q3 - q1;

  // Freedman-Diaconis bin width.
  let binWidth = 2 * iqr * Math.pow(n, -1 / 3);
  if (!Number.isFinite(binWidth) || binWidth <= 0) {
    // Fallback when IQR collapses (heavy concentration / ties).
    binWidth = range / Math.max(10, Math.round(Math.sqrt(n)));
  }
  if (!Number.isFinite(binWidth) || binWidth <= 0) {
    return clamp(maxBins, 10, 400);
  }

  const autoBins = Math.ceil(range / binWidth);
  return clamp(autoBins, 10, maxBins);
};

const pickSampleIndices = (rows: number, limit: number, seed: number): number[] => {
  if (rows <= 0) return [];
  if (limit >= rows) return Array.from({ length: rows }, (_, i) => i);

  const rng = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  const selected = Array.from({ length: limit }, (_, i) => i);
  for (let i = limit; i < rows; i += 1) {
    const j = Math.floor(rng() * (i + 1));
    if (j < limit) selected[j] = i;
  }
  selected.sort((a, b) => a - b);
  return selected;
};

const insertLowTailCandidate = (
  pool: TailCandidate[],
  candidate: TailCandidate,
  limit: number,
): void => {
  if (pool.length === 0) {
    pool.push(candidate);
    return;
  }
  if (pool.length < limit) {
    let i = pool.length - 1;
    while (i >= 0 && candidate.finalPrice < pool[i].finalPrice) i -= 1;
    pool.splice(i + 1, 0, candidate);
    return;
  }
  if (candidate.finalPrice >= pool[pool.length - 1].finalPrice) return;
  let i = pool.length - 2;
  while (i >= 0 && candidate.finalPrice < pool[i].finalPrice) i -= 1;
  pool.splice(i + 1, 0, candidate);
  pool.pop();
};

const insertHighTailCandidate = (
  pool: TailCandidate[],
  candidate: TailCandidate,
  limit: number,
): void => {
  if (pool.length === 0) {
    pool.push(candidate);
    return;
  }
  if (pool.length < limit) {
    let i = pool.length - 1;
    while (i >= 0 && candidate.finalPrice > pool[i].finalPrice) i -= 1;
    pool.splice(i + 1, 0, candidate);
    return;
  }
  if (candidate.finalPrice <= pool[pool.length - 1].finalPrice) return;
  let i = pool.length - 2;
  while (i >= 0 && candidate.finalPrice > pool[i].finalPrice) i -= 1;
  pool.splice(i + 1, 0, candidate);
  pool.pop();
};

const prepareLegs = (
  request: SimWorkerRequest,
): {
  hasPositionLegs: boolean;
  optionLegs: PreparedOptionLeg[];
  futureLegs: PreparedFuturePathLeg[];
} => {
  const optionLegs: PreparedOptionLeg[] = [];
  const futureLegs: PreparedFuturePathLeg[] = [];
  const hasPositionLegs = (request.legs?.length ?? 0) > 0;

  for (const leg of request.legs ?? []) {
    if (leg.kind !== "option") {
      const future = leg as FutureLeg;
      const qty =
        Number.isFinite(future.qty) && future.qty > 0 ? future.qty : 0;
      if (qty <= 0) continue;
      const entry = Number.isFinite(future.entry) ? future.entry : null;
      const stopLoss =
        future.stopLoss == null || !Number.isFinite(future.stopLoss)
          ? null
          : future.stopLoss;
      futureLegs.push({
        sign: future.side === "buy" ? 1 : -1,
        qty,
        entry,
        stopLoss,
        isBuy: future.side === "buy",
        annualFundingRate: Number.isFinite(future.annualFundingRate)
          ? Number(future.annualFundingRate)
          : 0,
      });
      continue;
    }

    const option = leg as OptionLeg;
    const qty =
      Number.isFinite(option.qty) && option.qty > 0 ? option.qty : 0;
    const strike = Number(option.strike);
    if (!Number.isFinite(strike) || qty <= 0) continue;
    const sign = option.side === "buy" ? 1 : -1;
    const pricing = request.optionPricingByLegId?.[option.id];
    const iv =
      pricing?.iv != null && Number.isFinite(pricing.iv) && pricing.iv > 0
        ? pricing.iv
        : request.params.vol;
    const entryPrice =
      pricing?.mark != null && Number.isFinite(pricing.mark)
        ? pricing.mark
        : Number.isFinite(option.premium)
          ? option.premium
          : 0;
    const expiryTs =
      pricing?.expirationTs != null && Number.isFinite(pricing.expirationTs)
        ? pricing.expirationTs
        : null;
    const entryRemainingSeconds =
      expiryTs != null
        ? Math.max(0, expiryTs - request.valuationTs)
        : request.horizonSeconds;
    optionLegs.push({
      sign,
      qty,
      strike,
      optionType: option.optionType,
      iv,
      entryPrice,
      entryRemainingYears: entryRemainingSeconds / SECONDS_PER_YEAR,
    });
  }

  return { hasPositionLegs, optionLegs, futureLegs };
};

const updateFutureStops = (
  spot: number,
  stepIndex: number,
  futureLegs: PreparedFuturePathLeg[],
  stopHit: Uint8Array | null,
  stopHitStep: Int32Array | null,
): void => {
  if (!stopHit) return;
  for (let index = 0; index < futureLegs.length; index += 1) {
    if (stopHit[index]) continue;
    const leg = futureLegs[index];
    if (leg.stopLoss == null) continue;
    if (
      (leg.isBuy && Number.isFinite(spot) && spot <= leg.stopLoss) ||
      (!leg.isBuy && Number.isFinite(spot) && spot >= leg.stopLoss)
    ) {
      stopHit[index] = 1;
      if (stopHitStep) stopHitStep[index] = stepIndex;
    }
  }
};

const activeStopPrices = (
  futureLegs: PreparedFuturePathLeg[],
  stopHit: Uint8Array | null,
  samplingStopLoss: SimWorkerRequest["samplingStopLoss"],
  samplingStopHit: boolean,
): number[] => {
  const prices: number[] = [];
  for (let index = 0; index < futureLegs.length; index += 1) {
    const stopPrice = futureLegs[index].stopLoss;
    if (!stopHit?.[index] && stopPrice != null && Number.isFinite(stopPrice)) {
      prices.push(stopPrice);
    }
  }
  if (
    !samplingStopHit &&
    samplingStopLoss != null &&
    Number.isFinite(samplingStopLoss.price)
  ) {
    prices.push(samplingStopLoss.price);
  }
  return prices;
};

const positionPnlAt = ({
  spot,
  elapsedYears,
  elapsedSteps,
  optionLegs,
  futureLegs,
  stopHit,
  stopHitStep,
  dt,
}: {
  spot: number;
  elapsedYears: number;
  elapsedSteps: number;
  optionLegs: PreparedOptionLeg[];
  futureLegs: PreparedFuturePathLeg[];
  stopHit: Uint8Array | null;
  stopHitStep: Int32Array | null;
  dt: number;
}): number => {
  let total = 0;
  for (const leg of optionLegs) {
    const modelPrice = blackScholesGreeks(
      spot,
      leg.strike,
      Math.max(0, leg.entryRemainingYears - elapsedYears),
      leg.iv,
      RISK_FREE_RATE,
      leg.optionType,
    ).price;
    total += leg.sign * leg.qty * (modelPrice - leg.entryPrice);
  }

  for (let index = 0; index < futureLegs.length; index += 1) {
    const leg = futureLegs[index];
    const entryPrice = leg.entry ?? spot;
    const exitPrice =
      leg.stopLoss != null && stopHit?.[index] ? leg.stopLoss : spot;
    total += leg.sign * leg.qty * (exitPrice - entryPrice);
    const fundedSteps =
      stopHitStep?.[index] != null && stopHitStep[index] >= 0
        ? stopHitStep[index] + 1
        : elapsedSteps;
    total -=
      leg.sign *
      leg.qty *
      entryPrice *
      leg.annualFundingRate *
      fundedSteps *
      dt;
  }
  return total;
};

export const simulate = (request: SimWorkerRequest): SimWorkerSuccess => {
  const steps = Math.max(1, Math.floor(request.params.T / request.params.dt));
  const rows = Math.max(1, Math.floor(request.params.rows));
  const baseline = request.params.s0;
  const histBinsCap = clamp(Math.round(request.histBins), 10, 400);
  const histBinsMultiplier = clamp(
    Number(request.histBinsMultiplier ?? 1),
    1,
    2,
  );
  const samplePathLimit = clamp(Math.round(request.samplePathLimit), 1, rows);

  const finalPrices = new Float64Array(rows);
  const payoffs = new Float64Array(rows);
  const pathWin = new Uint8Array(rows);
  const pathMaxLoss = new Uint8Array(rows);
  const pathOpportunityCost = new Float64Array(rows);
  const pathPeakPnl = new Float64Array(rows);

  const rng = mulberry32(request.seed);
  const randn = makeRandn(rng);
  const batesProcess = prepareBatesProcess(request);

  const { hasPositionLegs, optionLegs, futureLegs } = prepareLegs(request);

  const sampledIndices = pickSampleIndices(rows, samplePathLimit, request.seed);
  const lowTailPool: TailCandidate[] = [];
  const highTailPool: TailCandidate[] = [];

  let pathMin = baseline;
  let pathMax = baseline;
  let finalPriceMin = Number.POSITIVE_INFINITY;
  let finalPriceMax = Number.NEGATIVE_INFINITY;
  let payoffMin = Number.POSITIVE_INFINITY;
  let payoffMax = Number.NEGATIVE_INFINITY;
  let payoffSum = 0;
  let wins = 0;
  let maxLossHits = 0;
  let opportunityCostSum = 0;
  let maxDrawdown = 0;
  let highestStoppedFinalPrice = Number.NEGATIVE_INFINITY;
  let highestStoppedFinalIndex: number | null = null;
  const optionPremiumAtRisk = Math.max(
    0,
    optionLegs.reduce(
      (sum, leg) =>
        sum + leg.sign * leg.qty * Math.max(0, leg.entryPrice),
      0,
    ),
  );

  for (let r = 0; r < rows; r += 1) {
    let s = baseline;
    const batesState = batesProcess
      ? createBatesState(baseline, batesProcess)
      : null;
    let peak = baseline;
    let worstDrawdown = 0;
    let samplingStopHit = false;
    const stopHit =
      futureLegs.length > 0 ? new Uint8Array(futureLegs.length) : null;
    const stopHitStep =
      futureLegs.length > 0
        ? new Int32Array(futureLegs.length).fill(-1)
        : null;
    const pnlAtStep = (elapsedSteps: number): number => hasPositionLegs
      ? positionPnlAt({
          spot: s,
          elapsedYears: Math.min(request.params.T, elapsedSteps * request.params.dt),
          elapsedSteps,
          optionLegs,
          futureLegs,
          stopHit,
          stopHitStep,
          dt: request.params.dt,
        })
      : s - baseline;
    let peakPnl = pnlAtStep(0);

    for (let c = 0; c < steps; c += 1) {
      const substeps = adaptiveStopSubsteps(
        s,
        request.params.vol,
        request.params.dt,
        activeStopPrices(
          futureLegs,
          stopHit,
          request.samplingStopLoss,
          samplingStopHit,
        ),
      );
      const substepDt = request.params.dt / substeps;
      const substepDrift =
        (request.params.mu - 0.5 * request.params.vol ** 2) * substepDt;
      const substepVol = request.params.vol * Math.sqrt(substepDt);

      for (let substep = 0; substep < substeps; substep += 1) {
        if (batesProcess && batesState) {
          s = advanceBatesState(
            batesState,
            batesProcess,
            substepDt,
            randn,
            rng,
          ).spot;
        } else {
          s *= Math.exp(substepDrift + substepVol * randn());
        }

        if (s < pathMin) pathMin = s;
        if (s > pathMax) pathMax = s;

        if (s > peak) peak = s;
        if (peak > 0) {
          const drawdown = (peak - s) / peak;
          if (drawdown > worstDrawdown) worstDrawdown = drawdown;
        }

        updateFutureStops(s, c, futureLegs, stopHit, stopHitStep);
        if (!samplingStopHit && request.samplingStopLoss) {
          samplingStopHit =
            request.samplingStopLoss.side === "buy"
              ? s <= request.samplingStopLoss.price
              : s >= request.samplingStopLoss.price;
        }
      }
      if (c + 1 < steps) peakPnl = Math.max(peakPnl, pnlAtStep(c + 1));
    }

    if (worstDrawdown > maxDrawdown) maxDrawdown = worstDrawdown;

    finalPrices[r] = s;
    if (s < finalPriceMin) finalPriceMin = s;
    if (s > finalPriceMax) finalPriceMax = s;

    const total = hasPositionLegs
      ? positionPnlAt({
          spot: s,
          elapsedYears: request.params.T,
          elapsedSteps: steps,
          optionLegs,
          futureLegs,
          stopHit,
          stopHitStep,
          dt: request.params.dt,
        })
      : s - baseline;

    for (let i = 0; i < futureLegs.length; i += 1) {
      const leg = futureLegs[i];
      // Opportunity cost of a bad stop: path hit the stop, then recovered
      // past it by horizon. Price-only (matches stop-path highlight).
      if (leg.stopLoss != null && stopHit?.[i]) {
        const recovered =
          (leg.isBuy && s > leg.stopLoss) ||
          (!leg.isBuy && s < leg.stopLoss);
        if (recovered) {
          const pathOpp = leg.sign * leg.qty * (s - leg.stopLoss);
          pathOpportunityCost[r] += pathOpp;
          opportunityCostSum += pathOpp;
        }
      }
    }

    payoffs[r] = total;
    pathPeakPnl[r] = Math.max(peakPnl, total);
    payoffSum += total;
    if (total > 0) {
      wins += 1;
      pathWin[r] = 1;
    }
    const stopped = stopHit?.some((value) => value === 1) ?? false;
    if (
      (futureLegs.length > 0 && stopped) ||
      (futureLegs.length === 0 &&
        optionPremiumAtRisk > 0 &&
        total <= -0.99 * optionPremiumAtRisk)
    ) {
      maxLossHits += 1;
      pathMaxLoss[r] = 1;
    }
    if ((stopped || samplingStopHit) && s > highestStoppedFinalPrice) {
      highestStoppedFinalPrice = s;
      highestStoppedFinalIndex = r;
    }
    if (total < payoffMin) payoffMin = total;
    if (total > payoffMax) payoffMax = total;

    if (rows > samplePathLimit) {
      const tailCandidate: TailCandidate = {
        index: r,
        finalPrice: s,
      };
      insertLowTailCandidate(lowTailPool, tailCandidate, TAIL_PATH_POOL_SIZE);
      insertHighTailCandidate(highTailPool, tailCandidate, TAIL_PATH_POOL_SIZE);
    }

  }

  if (!Number.isFinite(payoffMin)) payoffMin = 0;
  if (!Number.isFinite(payoffMax)) payoffMax = 0;
  if (!Number.isFinite(finalPriceMin)) finalPriceMin = baseline;
  if (!Number.isFinite(finalPriceMax)) finalPriceMax = baseline;

  const meanPayoff = rows > 0 ? payoffSum / rows : 0;
  const medianPayoff = medianOfTypedArray(payoffs);
  const maxPayoff = payoffMax;
  const winRate = rows > 0 ? wins / rows : 0;
  const maxLossRate = rows > 0 ? maxLossHits / rows : 0;
  // Probability-weight each path equally (1 / N) so this is expected
  // opportunity cost, not a raw Monte Carlo total.
  const opportunityCost = rows > 0 ? opportunityCostSum / rows : 0;
  const sortedPayoffs = Float64Array.from(payoffs);
  sortedPayoffs.sort();
  const p05Payoff = quantileSorted(sortedPayoffs, 0.05);
  const p10Payoff = quantileSorted(sortedPayoffs, 0.1);
  const p25Payoff = quantileSorted(sortedPayoffs, 0.25);
  const p50Payoff = quantileSorted(sortedPayoffs, 0.5);
  const p75Payoff = quantileSorted(sortedPayoffs, 0.75);
  const p90Payoff = quantileSorted(sortedPayoffs, 0.9);
  const p95Payoff = quantileSorted(sortedPayoffs, 0.95);

  const maxDelta = Math.max(
    Math.abs(pathMin - baseline),
    Math.abs(pathMax - baseline),
  );
  const paddedDelta = maxDelta * 1.02;
  const safeDelta =
    Number.isFinite(paddedDelta) && paddedDelta > 0 ? paddedDelta : 1;
  const binMin = baseline - safeDelta;
  const binMax = baseline + safeDelta;
  const baseBins = computeAdaptiveBinCount(
    finalPrices,
    binMin,
    binMax,
    histBinsCap,
  );
  const histBins = clamp(
    Math.round(baseBins * histBinsMultiplier),
    10,
    histBinsCap,
  );
  const binSize = (binMax - binMin) / histBins;
  const invBinSize = binSize > 0 ? 1 / binSize : 0;

  const counts = new Uint32Array(histBins);
  const sums = new Float64Array(histBins);
  const winCounts = new Uint32Array(histBins);
  const maxLossCounts = new Uint32Array(histBins);
  const opportunityCostSums = new Float64Array(histBins);
  const payoffLists: number[][] = Array.from({ length: histBins }, () => []);
  const binPeakPnl = new Float64Array(histBins).fill(Number.NEGATIVE_INFINITY);

  const findBinIndex = (value: number): number => {
    if (!Number.isFinite(value) || value <= binMin) return 0;
    if (value >= binMax) return histBins - 1;
    if (invBinSize <= 0) return 0;
    const idx = Math.floor((value - binMin) * invBinSize);
    if (idx < 0) return 0;
    if (idx >= histBins) return histBins - 1;
    return idx;
  };

  for (let i = 0; i < rows; i += 1) {
    const idx = findBinIndex(finalPrices[i]);
    counts[idx] += 1;
    sums[idx] += payoffs[i];
    winCounts[idx] += pathWin[i];
    maxLossCounts[idx] += pathMaxLoss[i];
    opportunityCostSums[idx] += pathOpportunityCost[i];
    payoffLists[idx].push(payoffs[i]);
    binPeakPnl[idx] = Math.max(binPeakPnl[idx], pathPeakPnl[i]);
  }

  const bins: SimBin[] = new Array(histBins);
  for (let i = 0; i < histBins; i += 1) {
    const x0 = binMin + i * binSize;
    const x1 = i === histBins - 1 ? binMax : x0 + binSize;
    const sortedBinPayoffs = Float64Array.from(payoffLists[i]);
    sortedBinPayoffs.sort();
    const p50BinPayoff = quantileSorted(sortedBinPayoffs, 0.5);
    bins[i] = {
      x0,
      x1,
      count: counts[i],
      sumPayoff: sums[i],
      medianPayoff: p50BinPayoff,
      maxIntermediatePnl: counts[i] > 0 ? binPeakPnl[i] : null,
      p10Payoff: quantileSorted(sortedBinPayoffs, 0.1),
      p25Payoff: quantileSorted(sortedBinPayoffs, 0.25),
      p50Payoff: p50BinPayoff,
      p75Payoff: quantileSorted(sortedBinPayoffs, 0.75),
      p90Payoff: quantileSorted(sortedBinPayoffs, 0.9),
      winCount: winCounts[i],
      maxLossCount: maxLossCounts[i],
      opportunityCostSum: opportunityCostSums[i],
    };
  }

  const sampleIndexSet = new Set<number>(sampledIndices);
  if (rows > samplePathLimit) {
    // Always include explicit min/max terminal-price paths,
    // then add a few percentile representatives from each extreme tail pool.
    const lowExtreme = lowTailPool[0];
    const highExtreme = highTailPool[0];
    if (lowExtreme) sampleIndexSet.add(lowExtreme.index);
    if (highExtreme) sampleIndexSet.add(highExtreme.index);

    const addTailPercentileSamples = (pool: TailCandidate[], picks: number): void => {
      if (!pool.length || picks <= 0) return;
      const picked = new Set<number>();
      for (let i = 1; i <= picks; i += 1) {
        const p = i / (picks + 1); // 0.25, 0.5, 0.75 for 3 picks
        const idx = Math.max(
          0,
          Math.min(pool.length - 1, Math.round(p * (pool.length - 1))),
        );
        picked.add(pool[idx].index);
      }
      for (const index of picked) {
        sampleIndexSet.add(index);
      }
    };

    addTailPercentileSamples(lowTailPool, 3);
    addTailPercentileSamples(highTailPool, 3);
  }
  if (highestStoppedFinalIndex != null) {
    sampleIndexSet.add(highestStoppedFinalIndex);
  }
  const sampleIndices = Array.from(sampleIndexSet).sort((a, b) => a - b);
  const sampleIndexToRow = new Map<number, number>();
  for (let i = 0; i < sampleIndices.length; i += 1) {
    sampleIndexToRow.set(sampleIndices[i], i);
  }

  const sampleRows = sampleIndices.length;
  const returnSamplePaths = request.returnSamplePaths !== false;
  const sampledPathRows = returnSamplePaths ? sampleRows : 0;
  const sampledPaths = new Float64Array(sampledPathRows * steps);
  const sampledFinalPrices = new Float64Array(sampleRows);
  const sampledPayoffs = new Float64Array(sampleRows);

  for (let i = 0; i < sampleRows; i += 1) {
    const pathIndex = sampleIndices[i];
    sampledFinalPrices[i] = finalPrices[pathIndex] ?? baseline;
    sampledPayoffs[i] = payoffs[pathIndex] ?? 0;
  }
  if (returnSamplePaths) {
    // Replay once to materialize only selected paths.
    const replayRng = mulberry32(request.seed);
    const replayRandn = makeRandn(replayRng);
    for (let r = 0; r < rows; r += 1) {
      let s = baseline;
      const batesState = batesProcess
        ? createBatesState(baseline, batesProcess)
        : null;
      const sampleRow = sampleIndexToRow.get(r);
      let samplingStopHit = false;
      const stopHit =
        futureLegs.length > 0 ? new Uint8Array(futureLegs.length) : null;
      const stopHitStep =
        futureLegs.length > 0
          ? new Int32Array(futureLegs.length).fill(-1)
          : null;
      const writeOffset = sampleRow != null ? sampleRow * steps : -1;
      for (let c = 0; c < steps; c += 1) {
        const substeps = adaptiveStopSubsteps(
          s,
          request.params.vol,
          request.params.dt,
          activeStopPrices(
            futureLegs,
            stopHit,
            request.samplingStopLoss,
            samplingStopHit,
          ),
        );
        const substepDt = request.params.dt / substeps;
        const substepDrift =
          (request.params.mu - 0.5 * request.params.vol ** 2) * substepDt;
        const substepVol = request.params.vol * Math.sqrt(substepDt);
        for (let substep = 0; substep < substeps; substep += 1) {
          if (batesProcess && batesState) {
            s = advanceBatesState(
              batesState,
              batesProcess,
              substepDt,
              replayRandn,
              replayRng,
            ).spot;
          } else {
            s *= Math.exp(substepDrift + substepVol * replayRandn());
          }
          updateFutureStops(s, c, futureLegs, stopHit, stopHitStep);
          if (!samplingStopHit && request.samplingStopLoss) {
            samplingStopHit =
              request.samplingStopLoss.side === "buy"
                ? s <= request.samplingStopLoss.price
                : s >= request.samplingStopLoss.price;
          }
        }
        if (writeOffset >= 0) {
          sampledPaths[writeOffset + c] = s;
        }
      }
    }
  }

  return {
    id: request.id,
    steps,
    rows,
    sampleRows,
    sampledPathRows,
    sampledPathsBuffer: sampledPaths.buffer,
    sampledFinalPricesBuffer: sampledFinalPrices.buffer,
    sampledPayoffsBuffer: sampledPayoffs.buffer,
    terminalPricesBuffer: finalPrices.buffer,
    terminalPayoffsBuffer: payoffs.buffer,
    bins,
    pathMin,
    pathMax,
    finalPriceMin,
    finalPriceMax,
    payoffMin,
    payoffMax,
    meanPayoff,
    medianPayoff,
    maxPayoff,
    maxDrawdown,
    winRate,
    p05Payoff,
    p10Payoff,
    p25Payoff,
    p50Payoff,
    p75Payoff,
    p90Payoff,
    p95Payoff,
    maxLossRate,
    opportunityCost,
  };
};

const scope =
  typeof self === "undefined"
    ? null
    : (self as DedicatedWorkerGlobalScope);
let queuedRequest: SimWorkerRequest | null = null;
let processing = false;

const processQueue = (): void => {
  if (processing || scope == null) return;
  processing = true;
  while (queuedRequest != null) {
    const request = queuedRequest;
    queuedRequest = null;
    try {
      const response = simulate(request);
      scope.postMessage(response, [
        response.sampledPathsBuffer,
        response.sampledFinalPricesBuffer,
        response.sampledPayoffsBuffer,
        response.terminalPricesBuffer,
        response.terminalPayoffsBuffer,
      ]);
    } catch (error) {
      const response: SimWorkerError = {
        id: request.id,
        error: error instanceof Error ? error.message : "Unknown worker error",
      };
      scope.postMessage(response);
    }
  }
  processing = false;
};

if (scope != null) {
  scope.onmessage = (event: MessageEvent<SimWorkerRequest>): void => {
    queuedRequest = event.data;
    processQueue();
  };
}
