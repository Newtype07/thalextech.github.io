// Static expiry payoff of the two options, before hedge trading and fees.
// Dynamic hedge results cannot be expressed as fixed terminal-price limits.
export function straddlePayoff({ strike, entryPrice, quantity, side }) {
  if (
    ![strike, entryPrice, quantity].every(
      (value) => Number.isFinite(value) && value > 0,
    ) ||
    !["buy", "sell"].includes(side)
  ) {
    throw new Error(
      "Straddle payoff needs a positive strike, premium and quantity, and a buy/sell side.",
    );
  }
  const premium = entryPrice * quantity;
  return {
    maxLoss: side === "buy" ? premium : Infinity,
    maxReturn: side === "buy" ? Infinity : premium,
    breakEvens: [strike - entryPrice, strike + entryPrice].filter(
      (price) => price >= 0,
    ),
  };
}
