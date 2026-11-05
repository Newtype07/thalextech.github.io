export type CalibrationProfile = { version: number; asset: string; lookbackDays: number; asOf: number; sourceHash: string;
  status: "ready" | "rv-only" | "unavailable"; rv: number | null; message: string; daysPerYear: number;
  correlationSource: string; training: { start: number; end: number; observations: number; expected: number; coverage: number };
  variance: { kappa: number; theta: number; sigma: number; rho: number; initialVariance: number } | null;
  jumps: { intensity: number; logMean: number; logStdDev: number; logSecondMoment: number; compensatorMean: number } | null };
export type MarketModel = { shape: "flat" | "forward"; dynamics: "constant" | "stochastic" | "jumps"; rv: number;
  rvMultiplier: number; profile: CalibrationProfile | null; lookbackDays?: number;
  manual?: { volOfVol: number; correlation: number; jumpIntensity?: number; jumpMean?: number; jumpVol?: number } };
export type MarketState = { spot: number; bates: any; expectedVariance: number; cappedJumpSteps: number };
export function createMarketProcess(config: MarketModel & { horizon: number; nodes?: { seconds: number; iv: number }[] }): {
  createState(spot: number): MarketState;
  advance(state: MarketState, start: number, seconds: number, normal: () => number, uniform: () => number, drift?: number): number;
  varianceAt(time: number): number; totalVariance: number; targetRv: number;
  intervals: { start: number; end: number; iv: number }[]; modelVersion: string; daysPerYear: number };
