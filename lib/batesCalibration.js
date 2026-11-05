// Shared Bates calibration used by apps that model stochastic volatility.
const HOURS_PER_YEAR = 365.25 * 24;
const DAYS_PER_YEAR = 365.25;
const HOUR_SECONDS = 3_600;
const EPSILON = 1e-12;

export const DEFAULT_JUMP_THRESHOLD = 4;
export const JUMP_THRESHOLD_SENSITIVITY = [3, 3.5, 4, 4.5, 5];

const mean = (values) => values.length
  ? values.reduce((total, value) => total + value, 0) / values.length
  : Number.NaN;

const variance = (values, average = mean(values)) => values.length
  ? mean(values.map((value) => (value - average) ** 2))
  : Number.NaN;

const quantile = (values, probability) => {
  if (!values.length) return Number.NaN;
  const sorted = [...values].sort((first, second) => first - second);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const weight = position - lower;
  return sorted[lower] + (sorted[lower + 1] - sorted[lower] || 0) * weight;
};

const covariance = (first, second) => {
  if (!first.length || first.length !== second.length) return Number.NaN;
  const firstMean = mean(first);
  const secondMean = mean(second);
  return mean(first.map((value, index) =>
    (value - firstMean) * (second[index] - secondMean)));
};

const correlation = (first, second) => {
  const denominator = Math.sqrt(variance(first) * variance(second));
  return denominator > EPSILON ? covariance(first, second) / denominator : 0;
};

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

const regimeForVol = (annualVol, cutoffs) => {
  if (annualVol < cutoffs.lowToMedium) return "low";
  if (annualVol < cutoffs.mediumToHigh) return "medium";
  return "high";
};

const buildReturnObservations = (rows, localWindowHours) => {
  const sorted = (rows || [])
    .filter((row) => Number.isFinite(Number(row?.ts)) && Number(row?.close) > 0)
    .map((row) => ({ ts: Number(row.ts), close: Number(row.close) }))
    .sort((first, second) => first.ts - second.ts);
  const raw = [];
  for (let index = 1; index < sorted.length; index += 1) {
    const elapsed = sorted[index].ts - sorted[index - 1].ts;
    // A missing hour is not an hourly return; never annualize a two-hour move as one.
    if (elapsed !== HOUR_SECONDS) continue;
    raw.push({
      ts: sorted[index].ts,
      value: Math.log(sorted[index].close / sorted[index - 1].close),
    });
  }
  const minimumWindow = Math.min(48, Math.max(12, Math.floor(localWindowHours / 3)));
  const observations = [];
  for (let index = 0; index < raw.length; index += 1) {
    const history = raw
      .slice(Math.max(0, index - localWindowHours), index)
      .map((row) => row.value);
    if (history.length < minimumWindow) continue;
    const center = quantile(history, 0.5);
    const medianAbsoluteDeviation = quantile(
      history.map((value) => Math.abs(value - center)),
      0.5,
    );
    const fallbackScale = Math.sqrt(variance(history, mean(history)));
    const localScale = Math.max(
      EPSILON,
      medianAbsoluteDeviation > EPSILON
        ? medianAbsoluteDeviation / 0.6744897501960817
        : fallbackScale,
    );
    observations.push({
      ...raw[index],
      center,
      localScale,
      localAnnualVol: localScale * Math.sqrt(HOURS_PER_YEAR),
      zScore: (raw[index].value - center) / localScale,
    });
  }
  return observations;
};

const classifyObservations = (observations, threshold, cutoffs) =>
  observations.map((observation) => ({
    ...observation,
    regime: regimeForVol(observation.localAnnualVol, cutoffs),
    isJump: Math.abs(observation.zScore) >= threshold,
  }));

const summarizeJumps = (observations) => {
  const regimes = ["low", "medium", "high"];
  const byRegime = Object.fromEntries(regimes.map((regime) => {
    const rows = observations.filter((observation) => observation.regime === regime);
    const jumps = rows.filter((observation) => observation.isJump);
    const exposureYears = rows.length / HOURS_PER_YEAR;
    return [regime, {
      regime,
      observations: rows.length,
      jumps: jumps.length,
      exposureYears,
      intensity: exposureYears > 0 ? jumps.length / exposureYears : 0,
    }];
  }));
  const jumpReturns = observations
    .filter((observation) => observation.isJump)
    .map((observation) => observation.value);
  const jumpMean = jumpReturns.length ? mean(jumpReturns) : 0;
  const jumpVariance = jumpReturns.length > 1 ? variance(jumpReturns, jumpMean) : 0;
  const exposureYears = observations.length / HOURS_PER_YEAR;
  return {
    count: jumpReturns.length,
    exposureYears,
    intensity: exposureYears > 0 ? jumpReturns.length / exposureYears : 0,
    logMean: jumpMean,
    logStdDev: Math.sqrt(Math.max(0, jumpVariance)),
    logSecondMoment: jumpVariance + jumpMean ** 2,
    compensatorMean: Math.exp(jumpMean + 0.5 * jumpVariance) - 1,
    byRegime,
  };
};

const buildDailyVarianceSeries = (observations) => {
  const byDay = new Map();
  observations.forEach((observation) => {
    const dayTs = Math.floor(observation.ts / 86_400) * 86_400;
    const bucket = byDay.get(dayTs) || {
      ts: dayTs,
      count: 0,
      diffusiveSquaredReturn: 0,
      diffusiveReturn: 0,
    };
    bucket.count += 1;
    if (!observation.isJump) {
      const centeredReturn = observation.value - observation.center;
      bucket.diffusiveSquaredReturn += centeredReturn ** 2;
      bucket.diffusiveReturn += centeredReturn;
    }
    byDay.set(dayTs, bucket);
  });
  const daily = [...byDay.values()]
    .filter((day) => day.count >= 18)
    .sort((first, second) => first.ts - second.ts)
    .map((day) => ({
      ...day,
      variance: day.diffusiveSquaredReturn * (24 / day.count) * DAYS_PER_YEAR,
    }))
    .filter((day) => Number.isFinite(day.variance) && day.variance > EPSILON);
  const smoothingDays = 7;
  return daily.slice(smoothingDays - 1).map((day, index) => {
    const window = daily.slice(index, index + smoothingDays);
    const smoothedVariance = mean(window.map((row) => row.variance));
    return {
      ...day,
      variance: smoothedVariance,
      realizedVol: Math.sqrt(smoothedVariance),
    };
  });
};

const fitVarianceProcess = (series) => {
  const pairs = [];
  for (let index = 1; index < series.length; index += 1) {
    const dtYears = (series[index].ts - series[index - 1].ts) / (DAYS_PER_YEAR * 86_400);
    if (dtYears <= 0 || dtYears > 2.1 / DAYS_PER_YEAR) continue;
    pairs.push({
      current: series[index - 1],
      next: series[index],
      dtYears,
    });
  }
  if (pairs.length < 20) {
    throw new Error("At least 20 daily realized-variance transitions are required for Bates calibration");
  }
  const currentVariance = pairs.map((pair) => pair.current.variance);
  const nextVariance = pairs.map((pair) => pair.next.variance);
  const xMean = mean(currentVariance);
  const yMean = mean(nextVariance);
  const betaRaw = covariance(currentVariance, nextVariance)
    / Math.max(EPSILON, variance(currentVariance, xMean));
  const beta = clamp(betaRaw, 0.001, 0.999);
  const intercept = yMean - beta * xMean;
  const averageDt = mean(pairs.map((pair) => pair.dtYears));
  const kappa = -Math.log(beta) / averageDt;
  const theta = Math.max(EPSILON, intercept / Math.max(EPSILON, 1 - beta));
  const residuals = pairs.map((pair) => {
    const persistence = Math.exp(-kappa * pair.dtYears);
    const expected = theta + (pair.current.variance - theta) * persistence;
    return pair.next.variance - expected;
  });
  const varianceExposures = pairs.map((pair) =>
    Math.max(EPSILON, pair.current.variance)
      * (1 - Math.exp(-2 * kappa * pair.dtYears))
      / Math.max(EPSILON, 2 * kappa));
  const sigma = Math.sqrt(Math.max(EPSILON, mean(residuals.map((residual, index) =>
    residual ** 2 / varianceExposures[index]))));
  const standardizedReturns = pairs.map((pair) =>
    pair.next.diffusiveReturn
      / Math.sqrt(Math.max(EPSILON, pair.current.variance * pair.dtYears)));
  const standardizedVarianceShocks = residuals.map((residual, index) =>
    residual / Math.max(EPSILON, sigma * Math.sqrt(varianceExposures[index])));
  const rho = clamp(correlation(standardizedReturns, standardizedVarianceShocks), -0.99, 0.99);
  const totalSumSquares = nextVariance.reduce(
    (total, value) => total + (value - yMean) ** 2,
    0,
  );
  const residualSumSquares = residuals.reduce((total, value) => total + value ** 2, 0);
  return {
    kappa,
    theta,
    sigma,
    rho,
    initialVariance: series.at(-1).variance,
    diagnostics: {
      transitions: pairs.length,
      betaRaw,
      betaUsed: beta,
      rSquared: totalSumSquares > EPSILON ? 1 - residualSumSquares / totalSumSquares : 0,
      rmseVariance: Math.sqrt(residualSumSquares / residuals.length),
      fellerRatio: 2 * kappa * theta / Math.max(EPSILON, sigma ** 2),
    },
  };
};

const sampleReturnDiagnostics = (observations, maxPoints = 900) => {
  const stride = Math.max(1, Math.ceil(observations.length / maxPoints));
  return observations.filter((observation, index) =>
    observation.isJump || index % stride === 0).map((observation) => ({
      ts: observation.ts,
      return: observation.value,
      zScore: observation.zScore,
      localAnnualVol: observation.localAnnualVol,
      regime: observation.regime,
      isJump: observation.isJump,
    }));
};

export const calibrateBatesModel = ({
  rows,
  jumpThreshold = DEFAULT_JUMP_THRESHOLD,
  localWindowHours = 168,
  sensitivityThresholds = JUMP_THRESHOLD_SENSITIVITY,
} = {}) => {
  const baseObservations = buildReturnObservations(rows, localWindowHours);
  if (baseObservations.length < 240) {
    throw new Error("At least 10 days of contiguous hourly BTC history are required for Bates calibration");
  }
  const localVols = baseObservations.map((observation) => observation.localAnnualVol);
  const regimeCutoffs = {
    lowToMedium: quantile(localVols, 1 / 3),
    mediumToHigh: quantile(localVols, 2 / 3),
  };
  const observations = classifyObservations(
    baseObservations,
    Number(jumpThreshold),
    regimeCutoffs,
  );
  const jumps = summarizeJumps(observations);
  const varianceSeries = buildDailyVarianceSeries(observations);
  const varianceProcess = fitVarianceProcess(varianceSeries);
  const sensitivity = sensitivityThresholds.map((threshold) => {
    const classified = classifyObservations(baseObservations, threshold, regimeCutoffs);
    const jumpSummary = summarizeJumps(classified);
    const diffusiveSeries = buildDailyVarianceSeries(classified);
    const fittedVariance = fitVarianceProcess(diffusiveSeries);
    return {
      threshold,
      jumps: jumpSummary.count,
      annualIntensity: jumpSummary.intensity,
      lowIntensity: jumpSummary.byRegime.low.intensity,
      mediumIntensity: jumpSummary.byRegime.medium.intensity,
      highIntensity: jumpSummary.byRegime.high.intensity,
      jumpLogMean: jumpSummary.logMean,
      jumpLogStdDev: jumpSummary.logStdDev,
      averageDiffusiveVol: Math.sqrt(mean(diffusiveSeries.map((row) => row.variance))),
      kappa: fittedVariance.kappa,
      longRunVol: Math.sqrt(fittedVariance.theta),
      _model: {
        jumps: jumpSummary,
        variance: fittedVariance,
        varianceSeries: diffusiveSeries.map((row) => ({
          ts: row.ts,
          variance: row.variance,
          realizedVol: row.realizedVol,
        })),
      },
    };
  });
  return {
    model: "Bates",
    threshold: Number(jumpThreshold),
    localWindowHours,
    sample: {
      startTs: observations[0].ts,
      endTs: observations.at(-1).ts,
      hourlyReturns: observations.length,
      dailyVarianceObservations: varianceSeries.length,
    },
    regimeCutoffs,
    jumps,
    variance: varianceProcess,
    sensitivity,
    diagnostics: {
      returnSeries: sampleReturnDiagnostics(observations),
      varianceSeries: varianceSeries.map((row) => ({
        ts: row.ts,
        variance: row.variance,
        realizedVol: row.realizedVol,
      })),
    },
  };
};

export const resolveVarianceAt = (calibration, timestamp) => {
  const series = calibration?.diagnostics?.varianceSeries || [];
  if (!series.length) return calibration?.variance?.initialVariance || EPSILON;
  let low = 0;
  let high = series.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (series[middle].ts <= timestamp) low = middle + 1;
    else high = middle - 1;
  }
  return series[Math.max(0, high)]?.variance
    || calibration?.variance?.initialVariance
    || EPSILON;
};

export const resolveVolatilityRegime = (calibration, annualVol) =>
  regimeForVol(annualVol, calibration.regimeCutoffs);
