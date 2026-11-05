export type SimulationStats = {
  meanHedgeFees?: number;
  meanHedgeTrades?: number;
  meanPayoff: number;
  medianPayoff: number;
  payoffMin: number;
  payoffMax: number;
  p05Payoff: number;
  p10Payoff: number;
  p25Payoff: number;
  p50Payoff: number;
  p75Payoff: number;
  p90Payoff: number;
  p95Payoff: number;
  winRate: number;
  maxLossRate: number;
  /** Expected price opportunity cost from stopped paths that later recovered. */
  opportunityCost: number;
  /** Underlying prices where mean payoff crosses zero. Up to a handful. */
  breakEvenPrices?: number[];
};

/** Metrics for paths ending in a single histogram price bin. */
export type HistogramBinStats = {
  priceMin: number;
  priceMax: number;
  count: number;
  totalCount: number;
  meanPayoff: number;
  medianPayoff: number;
  p10Payoff: number;
  p25Payoff: number;
  p50Payoff: number;
  p75Payoff: number;
  p90Payoff: number;
  winRate: number;
  maxLossRate: number;
  opportunityCost: number;
};

export type HistogramBinHover = {
  primary: HistogramBinStats | null;
  comparison: HistogramBinStats | null;
};
