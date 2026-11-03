// Keep the original straddle API as a thin preset over the position engine.
import { simulatePosition } from "./position-simulation.js";
import { buildForwardCurve } from "./forward-curve.js";
export { ATTRIBUTION } from "./position-simulation.js";

export function simulateStraddle(config) {
  if (!["buy", "sell"].includes(config.side) ||
      !Number.isFinite(config.quantity) || config.quantity <= 0)
    throw new Error("Choose a buy/sell side and a positive quantity.");
  const signedQty = config.quantity * (config.side === "sell" ? -1 : 1);
  const result = simulatePosition({
    ...config,
    legs: ["call", "put"].map(optionType => ({
      optionType, strike: config.strike, maturity: config.maturity, signedQty,
    })),
  });
  const { intervals, entryIv } = buildForwardCurve(config.nodes, config.maturity);
  return {
    ...result,
    curve: { intervals, entryIv },
    entryPrice: result.legs.reduce((sum, leg) => sum + leg.entryPrice, 0),
  };
}
