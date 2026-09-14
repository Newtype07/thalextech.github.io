export type OptionStopComparison = {
  leverage: number;
  stopPrice: number;
  premium: number;
  delta: number;
};

/** Delta-matched linear exposure with a loss budget equal to net premium. */
export const inferOptionStop = (
  spot: number,
  delta: number,
  premium: number,
): OptionStopComparison | null => {
  if (![spot, delta, premium].every(Number.isFinite)
    || spot <= 0 || premium <= 0 || Math.abs(delta) < 1e-8) return null;
  const stopPrice = spot - premium / delta;
  if (stopPrice <= 0) return null;
  return { leverage: Math.abs(delta * spot / premium), stopPrice, premium, delta };
};

export const hitsOptionStop = (spot: number, stop: OptionStopComparison): boolean =>
  stop.delta > 0 ? spot <= stop.stopPrice : spot >= stop.stopPrice;
