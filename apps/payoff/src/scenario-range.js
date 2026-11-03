const SECONDS_PER_YEAR = 365.25 * 24 * 60 * 60;
const MIN_TTE_SECONDS = 60;

export function getScenarioSpotRange({
  spot,
  anchorTs,
  expirationTimestamps,
  annualizedVol = 0.4,
  standardDeviations = 3,
  remainingTimeFraction = 1,
}) {
  const referenceSpot = Number(spot);
  const referenceTs = Number(anchorTs);
  const expirations = (expirationTimestamps || [])
    .map(Number)
    .filter(Number.isFinite);
  const volatility = Number(annualizedVol);
  const sigmaCount = Number(standardDeviations);
  const timeFraction = Number(remainingTimeFraction);

  if (
    !Number.isFinite(referenceSpot) ||
    referenceSpot <= 0 ||
    !Number.isFinite(referenceTs) ||
    !expirations.length ||
    !Number.isFinite(volatility) ||
    volatility <= 0 ||
    !Number.isFinite(sigmaCount) ||
    sigmaCount <= 0 ||
    !Number.isFinite(timeFraction) ||
    timeFraction < 0
  ) {
    return null;
  }

  const longestExpirationTs = Math.max(...expirations);
  const tteSeconds = Math.max(
    MIN_TTE_SECONDS,
    (longestExpirationTs - referenceTs) * timeFraction,
  );
  const timeToExpiryYears = tteSeconds / SECONDS_PER_YEAR;
  const requestedHalfWidth =
    referenceSpot * sigmaCount * volatility * Math.sqrt(timeToExpiryYears);
  const halfWidth = Math.min(
    requestedHalfWidth,
    referenceSpot * (1 - Number.EPSILON),
  );

  return {
    minSpot: referenceSpot - halfWidth,
    maxSpot: referenceSpot + halfWidth,
    timeToExpiryYears,
  };
}

export function buildScenarioSpotGrid({
  spot,
  anchorTs,
  expirationTimestamps,
  pointCount,
  annualizedVol = 0.4,
  standardDeviations = 3,
  remainingTimeFraction = 1,
}) {
  const range = getScenarioSpotRange({
    spot,
    anchorTs,
    expirationTimestamps,
    annualizedVol,
    standardDeviations,
    remainingTimeFraction,
  });
  const count = Math.max(1, Math.floor(Number(pointCount)));
  if (!range || !Number.isFinite(count)) return [];

  return Array.from({ length: count }, (_, scenarioIndex) => {
    const progress = count === 1 ? 0.5 : scenarioIndex / (count - 1);
    return {
      scenarioIndex,
      scenarioSpot:
        range.minSpot + (range.maxSpot - range.minSpot) * progress,
    };
  });
}
