export type PathModelParams = {
  kind: "gbm" | "bates";
  volOfVol: number;
  correlation: number;
  jumpsEnabled: boolean;
  jumpIntensity: number;
  maxJumpVarianceShare: number;
  jumpMean: number;
  jumpVol: number;
};

export const DEFAULT_PATH_MODEL: PathModelParams = {
  kind: "bates",
  volOfVol: 5 / (50 * Math.sqrt(14 / 365.25)),
  correlation: 0.25,
  jumpsEnabled: false,
  jumpIntensity: 220.6,
  maxJumpVarianceShare: 0.35,
  jumpMean: -0.00163,
  jumpVol: 0.01878,
};

export const horizonVolMovePointsFromVolOfVol = (
  volOfVol: number,
  horizonYears: number,
): number => {
  if (
    !Number.isFinite(volOfVol) ||
    !Number.isFinite(horizonYears) ||
    horizonYears <= 0
  ) {
    return 0;
  }
  return 50 * Math.max(0, volOfVol) * Math.sqrt(horizonYears);
};

export const volOfVolFromHorizonMovePoints = (
  movePoints: number,
  horizonYears: number,
): number => {
  if (
    !Number.isFinite(movePoints) ||
    !Number.isFinite(horizonYears) ||
    horizonYears <= 0
  ) {
    return 0;
  }
  return Math.max(0, movePoints) / (50 * Math.sqrt(horizonYears));
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export const defaultPathModelForUnderlying = (
  underlying: "BTCUSD" | "ETHUSD",
  horizonYears: number,
): PathModelParams => ({
  ...DEFAULT_PATH_MODEL,
  volOfVol: volOfVolFromHorizonMovePoints(underlying === "ETHUSD" ? 10 : 5, horizonYears),
});

const finiteOr = (value: number, fallback: number): number =>
  Number.isFinite(Number(value)) ? Number(value) : fallback;

export const sanitizePathModel = (
  value: PathModelParams,
): PathModelParams => ({
  kind: value?.kind === "gbm" ? "gbm" : "bates",
  volOfVol: clamp(
    finiteOr(value?.volOfVol, DEFAULT_PATH_MODEL.volOfVol),
    0,
    3,
  ),
  correlation: clamp(
    finiteOr(value?.correlation, DEFAULT_PATH_MODEL.correlation),
    -0.99,
    0.99,
  ),
  jumpsEnabled:
    typeof value?.jumpsEnabled === "boolean"
      ? value.jumpsEnabled
      : DEFAULT_PATH_MODEL.jumpsEnabled,
  jumpIntensity: clamp(
    finiteOr(value?.jumpIntensity, DEFAULT_PATH_MODEL.jumpIntensity),
    0,
    500,
  ),
  maxJumpVarianceShare: clamp(
    finiteOr(
      value?.maxJumpVarianceShare,
      DEFAULT_PATH_MODEL.maxJumpVarianceShare,
    ),
    0,
    0.9,
  ),
  jumpMean: clamp(
    finiteOr(value?.jumpMean, DEFAULT_PATH_MODEL.jumpMean),
    -0.2,
    0.2,
  ),
  jumpVol: clamp(
    finiteOr(value?.jumpVol, DEFAULT_PATH_MODEL.jumpVol),
    0,
    0.2,
  ),
});

export const stochasticVarianceParameters = (
  realizedVol: number,
  model: PathModelParams,
): {
  kappa: 0;
  theta: number;
  sigma: number;
  rho: number;
  initialVariance: number;
} => {
  const sanitized = sanitizePathModel(model);
  const safeVol = clamp(finiteOr(realizedVol, 0.4), 0.01, 3);
  const initialVariance = safeVol ** 2;
  return {
    kappa: 0,
    // theta is immaterial when kappa is zero. Keeping it at the entered RV
    // level makes the calibration self-describing without adding a second
    // volatility target.
    theta: initialVariance,
    sigma: sanitized.volOfVol,
    rho: sanitized.correlation,
    initialVariance,
  };
};
