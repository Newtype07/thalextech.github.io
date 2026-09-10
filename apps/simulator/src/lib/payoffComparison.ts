export type PayoffDifferenceSummary = {
  sortedDifferences: number[];
  optionWinRate: number;
  medianAdvantage: number;
};

export type SharedTerminalCumulativePoint = {
  terminalPrice: number;
  primaryContribution: number;
  comparisonContribution: number;
};

/** Accumulate signed EV across price-ordered bins, starting at zero. */
export const buildBinnedCumulativeEV = (
  bins: ReadonlyArray<{ x0: number; x1: number; sumPayoff: number }>,
  totalPathCount: number,
): Array<{ terminalPrice: number; contribution: number }> => {
  if (!bins.length || totalPathCount <= 0) return [];
  let sumPayoff = 0;
  return [
    { terminalPrice: bins[0].x0, contribution: 0 },
    ...bins.map((bin) => {
      sumPayoff += bin.sumPayoff;
      return {
        terminalPrice: bin.x1,
        contribution: sumPayoff / totalPathCount,
      };
    }),
  ];
};

export const buildSharedTerminalCumulativeSeries = (
  terminalPrices: ArrayLike<number>,
  primaryPayoffs: ArrayLike<number>,
  comparisonPayoffs: ArrayLike<number>,
  sampleLimit = 700,
): SharedTerminalCumulativePoint[] => {
  const count = Math.min(
    terminalPrices.length,
    primaryPayoffs.length,
    comparisonPayoffs.length,
  );
  const outcomes: Array<{
    terminalPrice: number;
    primaryPayoff: number;
    comparisonPayoff: number;
  }> = [];
  for (let index = 0; index < count; index += 1) {
    const terminalPrice = Number(terminalPrices[index]);
    const primaryPayoff = Number(primaryPayoffs[index]);
    const comparisonPayoff = Number(comparisonPayoffs[index]);
    if (
      !Number.isFinite(terminalPrice) ||
      !Number.isFinite(primaryPayoff) ||
      !Number.isFinite(comparisonPayoff)
    ) {
      continue;
    }
    outcomes.push({ terminalPrice, primaryPayoff, comparisonPayoff });
  }
  outcomes.sort((left, right) => left.terminalPrice - right.terminalPrice);
  if (!outcomes.length) return [];

  const points: SharedTerminalCumulativePoint[] = new Array(outcomes.length);
  let primaryContribution = 0;
  let comparisonContribution = 0;
  for (let index = 0; index < outcomes.length; index += 1) {
    primaryContribution += outcomes[index].primaryPayoff / outcomes.length;
    comparisonContribution +=
      outcomes[index].comparisonPayoff / outcomes.length;
    points[index] = {
      terminalPrice: outcomes[index].terminalPrice,
      primaryContribution,
      comparisonContribution,
    };
  }

  const limit = Math.max(2, Math.floor(sampleLimit));
  if (points.length <= limit) return points;
  return Array.from({ length: limit }, (_, index) => {
    const sourceIndex = Math.round(
      (index / (limit - 1)) * (points.length - 1),
    );
    return points[sourceIndex];
  });
};

export const smoothSharedTerminalCumulativeSeries = (
  points: SharedTerminalCumulativePoint[],
  windowRadius = Math.max(2, Math.round(points.length / 90)),
): SharedTerminalCumulativePoint[] => {
  if (points.length < 4 || windowRadius <= 0) return points.slice();
  const radius = Math.min(Math.floor(windowRadius), points.length - 1);
  const lastIndex = points.length - 1;
  const smoothValues = (
    key: "primaryContribution" | "comparisonContribution",
  ): number[] => {
    const values = points.map((point, index) => {
      const start = Math.max(0, index - radius);
      const end = Math.min(lastIndex, index + radius);
      let weightedSum = 0;
      let weightSum = 0;
      for (let cursor = start; cursor <= end; cursor += 1) {
        const weight = radius + 1 - Math.abs(cursor - index);
        weightedSum += points[cursor][key] * weight;
        weightSum += weight;
      }
      return weightSum > 0 ? weightedSum / weightSum : points[index][key];
    });
    const startCorrection = points[0][key] - values[0];
    const endCorrection = points[lastIndex][key] - values[lastIndex];
    return values.map((value, index) => {
      const progress = index / lastIndex;
      return (
        value +
        startCorrection * (1 - progress) +
        endCorrection * progress
      );
    });
  };

  const primary = smoothValues("primaryContribution");
  const comparison = smoothValues("comparisonContribution");
  return points.map((point, index) => ({
    terminalPrice: point.terminalPrice,
    primaryContribution: primary[index],
    comparisonContribution: comparison[index],
  }));
};

export const computePayoffBinValue = (
  sumPayoff: number,
  binCount: number,
  totalCount: number,
  mode: "payoff" | "frequency",
): number => {
  const denominator = mode === "frequency" ? totalCount : binCount;
  return denominator > 0 ? sumPayoff / denominator : 0;
};

export const buildPayoffDifferenceSummary = (
  optionPayoffs: ArrayLike<number>,
  perpPayoffs: ArrayLike<number>,
): PayoffDifferenceSummary => {
  const count = Math.min(optionPayoffs.length, perpPayoffs.length);
  const sortedDifferences: number[] = [];
  let optionWins = 0;

  for (let index = 0; index < count; index += 1) {
    const difference = Number(optionPayoffs[index]) - Number(perpPayoffs[index]);
    if (!Number.isFinite(difference)) continue;
    sortedDifferences.push(difference);
    if (difference > 0) optionWins += 1;
  }

  sortedDifferences.sort((left, right) => left - right);
  const length = sortedDifferences.length;
  const middle = Math.floor(length / 2);
  const medianAdvantage =
    length === 0
      ? 0
      : length % 2 === 1
        ? sortedDifferences[middle]
        : (sortedDifferences[middle - 1] + sortedDifferences[middle]) / 2;

  return {
    sortedDifferences,
    optionWinRate: length > 0 ? optionWins / length : 0,
    medianAdvantage,
  };
};
