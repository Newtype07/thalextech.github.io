export type PriceBin = { x0: number; x1: number };

/** Bin terminal outcomes in display coordinates; expose boundaries in dollars. */
export const buildTerminalPriceBins = (
  prices: Float64Array,
  scale: "linear" | "log",
  maxBins: number,
  multiplier: number,
): PriceBin[] => {
  if (!prices.length) return [];
  const useLog = scale === "log";
  const sorted = Float64Array.from(prices);
  sorted.sort();
  const minimum = sorted[0];
  const maximum = sorted[sorted.length - 1];
  if (useLog) {
    for (let i = 0; i < sorted.length; i += 1) {
      sorted[i] = Math.log(Math.max(Number.MIN_VALUE, sorted[i]));
    }
  }
  let low = sorted[0];
  let high = sorted[sorted.length - 1];
  const constantPrice = low === high;
  if (constantPrice) {
    const padding = useLog ? 1e-6 : Math.max(Math.abs(low) * 1e-6, 1e-6);
    low -= padding;
    high += padding;
    if (!useLog) low = Math.max(0, low);
  }
  const range = high - low;
  const quantile = (p: number): number => {
    const index = (sorted.length - 1) * p;
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
  };
  // Freedman–Diaconis width in the same coordinates as the displayed axis.
  let binWidth = 2 * (quantile(0.75) - quantile(0.25)) * Math.pow(sorted.length, -1 / 3);
  if (!Number.isFinite(binWidth) || binWidth <= 0) {
    binWidth = range / Math.max(10, Math.round(Math.sqrt(sorted.length)));
  }
  const count = Math.min(maxBins, Math.max(10, Math.round(
    Math.min(maxBins, Math.max(10, Math.ceil(range / binWidth))) * multiplier,
  )));
  const edges = Array.from({ length: count + 1 }, (_, index) => {
    const value = low + range * (index / count);
    return useLog ? Math.exp(value) : value;
  });
  // Preserve exact extrema: log/exp rounding must not put a tail outside its bin.
  if (!constantPrice) {
    edges[0] = minimum;
    edges[count] = maximum;
  }
  return Array.from({ length: count }, (_, index) => ({
    x0: edges[index], x1: edges[index + 1],
  }));
};

/** Left-inclusive bins, with the maximum included in the last bin. */
export const findPriceBinIndex = (bins: readonly PriceBin[], price: number): number => {
  if (!bins.length || !Number.isFinite(price)) return -1;
  let low = 0;
  let high = bins.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (price < bins[middle].x1) high = middle;
    else low = middle + 1;
  }
  return low;
};
