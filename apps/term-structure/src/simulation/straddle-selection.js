// The normalized option chain contains expiry, strike and C/P side only.
// A straddle needs both legs at the same listed strike. Ties choose the lower strike.
export function nearestListedStrike(instruments, expiry, spot) {
  if (!(Number.isFinite(spot) && spot > 0)) return null;
  const sides = new Map();
  for (const instrument of instruments) {
    if (
      instrument.expiry !== expiry ||
      !Number.isFinite(instrument.strike) ||
      instrument.strike <= 0 ||
      !["C", "P"].includes(instrument.side)
    )
      continue;
    if (!sides.has(instrument.strike)) sides.set(instrument.strike, new Set());
    sides.get(instrument.strike).add(instrument.side);
  }
  return (
    [...sides]
      .filter(([, pair]) => pair.size === 2)
      .map(([strike]) => strike)
      .sort((a, b) => Math.abs(a - spot) - Math.abs(b - spot) || a - b)[0] ??
    null
  );
}
