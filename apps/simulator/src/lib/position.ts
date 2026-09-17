export type Side = "buy" | "sell";
export type OptionType = "call" | "put";

export type OptionLeg = {
  id: string;
  kind: "option";
  side: Side;
  qty: number;
  optionType: OptionType;
  strike: number;
  premium: number;
  expiry?: string;
};

export type FutureLeg = {
  id: string;
  kind: "future";
  side: Side;
  qty: number;
  entry: number;
  stopLoss?: number | null;
  takeProfit?: number | null;
  annualFundingRate?: number;
};

export type PositionLeg = OptionLeg | FutureLeg;
type PricePath = readonly number[] | Float64Array;

const clampNonNegative = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, value) : 0;

const sideSign = (side: Side): number => (side === "buy" ? 1 : -1);

export const payoffAtPriceForLeg = (leg: PositionLeg, price: number): number => {
  const qty = clampNonNegative(leg.qty);
  const sign = sideSign(leg.side);

  if (!Number.isFinite(price)) return 0;

  if (leg.kind === "option") {
    const strike = Number.isFinite(leg.strike) ? leg.strike : 0;
    const intrinsic =
      leg.optionType === "call"
        ? Math.max(0, price - strike)
        : Math.max(0, strike - price);
    const premium = Number.isFinite(leg.premium) ? leg.premium : 0;
    return sign * qty * (intrinsic - premium);
  }

  const entry = Number.isFinite(leg.entry) ? leg.entry : price;
  const stopLoss =
    leg.stopLoss == null || !Number.isFinite(leg.stopLoss) ? null : leg.stopLoss;

  let effectivePrice =
    stopLoss == null
      ? price
      : leg.side === "buy"
        ? Math.max(price, stopLoss)
        : Math.min(price, stopLoss);

  if (leg.takeProfit != null && Number.isFinite(leg.takeProfit)) {
    effectivePrice = leg.side === "buy"
      ? Math.min(effectivePrice, leg.takeProfit)
      : Math.max(effectivePrice, leg.takeProfit);
  }

  return sign * qty * (effectivePrice - entry);
};

export const payoffAtPrice = (legs: PositionLeg[], price: number): number =>
  legs.reduce((sum, leg) => sum + payoffAtPriceForLeg(leg, price), 0);

export const payoffForPath = (
  legs: PositionLeg[],
  path: PricePath,
): number => {
  if (legs.length === 0) return 0;
  const finalPrice = path[path.length - 1];
  if (!Number.isFinite(finalPrice)) return 0;

  let total = 0;
  for (const leg of legs) {
    const qty = clampNonNegative(leg.qty);
    const sign = sideSign(leg.side);
    if (leg.kind === "option") {
      total += payoffAtPriceForLeg(leg, finalPrice);
      continue;
    }

    const entry = Number.isFinite(leg.entry) ? leg.entry : finalPrice;
    const stopLoss =
      leg.stopLoss == null || !Number.isFinite(leg.stopLoss) ? null : leg.stopLoss;

    let exitPrice = finalPrice;
    for (const price of path) {
      if (!Number.isFinite(price)) continue;
      if (stopLoss != null && (leg.side === "buy" ? price <= stopLoss : price >= stopLoss)) {
        exitPrice = stopLoss;
        break;
      }
      if (leg.takeProfit != null && Number.isFinite(leg.takeProfit) &&
          (leg.side === "buy" ? price >= leg.takeProfit : price <= leg.takeProfit)) {
        exitPrice = leg.takeProfit;
        break;
      }
    }
    total += sign * qty * (exitPrice - entry);
  }

  return total;
};
