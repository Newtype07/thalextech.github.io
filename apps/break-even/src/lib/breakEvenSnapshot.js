const SECONDS_PER_BS_YEAR = 365.25 * 24 * 60 * 60;

const getNearestTrackPoint = (points, targetDate) => {
  if (!Array.isArray(points) || points.length === 0) return null;
  const first = points[0];
  const last = points[points.length - 1];
  if (!(first?.date instanceof Date) || !(last?.date instanceof Date)) return null;
  if (targetDate < first.date || targetDate > last.date) return null;

  const targetMs = targetDate.getTime();
  let left = 0;
  let right = points.length - 1;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if (points[middle].date.getTime() < targetMs) {
      left = middle + 1;
    } else {
      right = middle;
    }
  }

  const after = points[left];
  const before = points[Math.max(0, left - 1)];
  const nearest =
    Math.abs(after.date.getTime() - targetMs) <
    Math.abs(before.date.getTime() - targetMs)
      ? after
      : before;
  if (!(nearest?.date instanceof Date) || !Number.isFinite(nearest?.breakEven)) {
    return null;
  }
  return nearest;
};

const erfApprox = (x) => {
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const t = 1 / (1 + 0.5 * absX);
  const tau =
    t *
    Math.exp(
      -absX * absX -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t *
                          (0.27886807 +
                            t *
                              (-1.13520398 +
                                t *
                                  (1.48851587 +
                                    t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return sign * (1 - tau);
};

const normalCdf = (x) => 0.5 * (1 + erfApprox(x / Math.SQRT2));

const calcNd2 = ({ spot, strike, iv, tauSeconds }) => {
  if (!Number.isFinite(spot) || spot <= 0) return null;
  if (!Number.isFinite(strike) || strike <= 0) return null;
  if (!Number.isFinite(iv) || iv <= 0) return null;
  if (!Number.isFinite(tauSeconds)) return null;
  if (tauSeconds <= 0) {
    if (spot > strike) return 1;
    if (spot < strike) return 0;
    return 0.5;
  }
  const tau = tauSeconds / SECONDS_PER_BS_YEAR;
  if (!Number.isFinite(tau) || tau <= 0) return null;
  const sqrtTau = Math.sqrt(tau);
  const d2 = (Math.log(spot / strike) - 0.5 * iv * iv * tau) / (iv * sqrtTau);
  if (!Number.isFinite(d2)) return null;
  return normalCdf(d2);
};

export const calcOptionNd2 = ({ optionType, spot, strike, iv, tauSeconds }) => {
  const callNd2 = calcNd2({ spot, strike, iv, tauSeconds });
  if (!Number.isFinite(callNd2)) return null;
  return optionType === "put" ? 1 - callNd2 : callNd2;
};

export const interpolateSeriesValue = (points, targetDate) => {
  if (!Array.isArray(points) || points.length === 0) return null;
  const first = points[0];
  const last = points[points.length - 1];
  if (!(first?.date instanceof Date) || !(last?.date instanceof Date)) return null;
  if (targetDate <= first.date) return Number(first?.value);
  if (targetDate >= last.date) return Number(last?.value);

  const targetMs = targetDate.getTime();
  let left = 0;
  let right = points.length - 1;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if (points[middle].date.getTime() < targetMs) {
      left = middle + 1;
    } else {
      right = middle;
    }
  }

  const leftPoint = points[Math.max(0, left - 1)];
  const rightPoint = points[Math.min(points.length - 1, left)];
  const leftValue = Number(leftPoint?.value);
  const rightValue = Number(rightPoint?.value);
  if (!Number.isFinite(leftValue) && !Number.isFinite(rightValue)) return null;
  if (!Number.isFinite(leftValue)) return rightValue;
  if (!Number.isFinite(rightValue)) return leftValue;
  const t0 = leftPoint.date.getTime();
  const t1 = rightPoint.date.getTime();
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0) return leftValue;
  const ratio = (targetMs - t0) / (t1 - t0);
  return leftValue + (rightValue - leftValue) * ratio;
};

export const buildBreakEvenSnapshot = ({
  tracks,
  indexCurvePoints,
  targetDate,
  expiryTs,
  spotPrice,
}) => {
  if (!(targetDate instanceof Date)) {
    return { targetDate: null, spot: null, rows: [] };
  }

  const tauSeconds = Number.isFinite(expiryTs)
    ? expiryTs - targetDate.getTime() / 1000
    : null;
  const interpolatedSpot = interpolateSeriesValue(indexCurvePoints, targetDate);
  const spot = Number.isFinite(interpolatedSpot) ? interpolatedSpot : spotPrice;
  const rows = [];

  for (const track of tracks || []) {
    const nearest = getNearestTrackPoint(track.points, targetDate);
    if (!nearest) continue;
    const iv = Number.isFinite(nearest?.iv) ? nearest.iv : track.referenceIv;
    const nd2 = calcOptionNd2({
      optionType: track.optionType,
      spot,
      strike: track.strike,
      iv,
      tauSeconds,
    });
    rows.push({
      id: `${track.optionType}:${track.strike}`,
      optionType: track.optionType,
      strike: track.strike,
      breakEven: nearest.breakEven,
      nd2,
      nd2Label: track.optionType === "put" ? "N(-d2)" : "N(d2)",
      pointDate: nearest.date,
      color: track.color,
    });
  }

  return { targetDate, spot, rows };
};
