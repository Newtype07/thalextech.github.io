import { nearestListedStrike } from "./straddle-selection.js";
import { buildForwardCurve } from "./forward-curve.js";
import { calcGreeks, calcOptionPrice } from "../../../../lib/thalex.js";

// PositionBuilder's display dates and instrument fields stay at this boundary.
export const builderExpiry = (expiry) => {
  const date = new Date(expiry * 1000);
  return `${String(date.getDate()).padStart(2, "0")} ${date.toLocaleString("en-US", { month: "short" })} ${String(date.getFullYear()).slice(-2)}`;
};

export function builderInstruments(chain, asset) {
  return chain.map((instrument) => ({
    instrument_name: instrument.name,
    type: "option",
    underlying: `${asset}USD`,
    option_type: instrument.side === "P" ? "put" : "call",
    strike_price: instrument.strike,
    expiration_timestamp: instrument.expiry,
  }));
}

export function defaultShortStraddle(chain, nodes, spot, asOf) {
  const candidates = nodes.map((node) => {
    const expiry = asOf + node.seconds;
    return { expiry, strike: nearestListedStrike(chain, expiry, spot) };
  }).filter((node) => node.strike > 0);
  candidates.sort((a, b) => Math.abs(a.expiry - asOf - 30 * 86400) - Math.abs(b.expiry - asOf - 30 * 86400));
  if (!candidates.length) return [];
  const { expiry, strike } = candidates[0];
  return ["call", "put"].map((optionType) => ({
    id: `default-${optionType}`, kind: "option", side: "sell", qty: 1,
    optionType, strike, premium: 0, expiry: builderExpiry(expiry),
  }));
}

export function resolvePosition(legs, chain, asOf) {
  if (!legs.length) throw new Error("Add an option leg to simulate a position.");
  if (legs.length > 4) throw new Error("Choose up to four option legs.");
  return legs.map((leg) => {
    if (leg.kind !== "option" || !["buy", "sell"].includes(leg.side) ||
        !Number.isFinite(leg.qty) || leg.qty <= 0)
      throw new Error("Every option leg needs a buy/sell side and a positive quantity.");
    const instrument = chain.find((instrument) =>
      instrument.side === (leg.optionType === "call" ? "C" : "P") &&
      ["call", "put"].includes(leg.optionType) &&
      instrument.strike === leg.strike && builderExpiry(instrument.expiry) === leg.expiry);
    if (!instrument || instrument.expiry <= asOf)
      throw new Error("Select a currently listed expiry and strike for every leg.");
    return {
      id: leg.id, instrumentName: instrument.name,
      optionType: leg.optionType, strike: instrument.strike,
      maturity: instrument.expiry - asOf,
      signedQty: leg.qty * (leg.side === "sell" ? -1 : 1),
    };
  });
}

export function entryValuations(legs, nodes, spot) {
  return Object.fromEntries(legs.map((leg) => {
    const iv = buildForwardCurve(nodes, leg.maturity).entryIv;
    const mark = calcOptionPrice(spot, leg.strike, leg.maturity, iv, leg.optionType);
    const greeks = calcGreeks(spot, leg.strike, leg.maturity, iv, leg.optionType);
    return [leg.id, { mark, iv, greeks: { ...greeks, price: mark, vega: greeks.vega / 100 } }];
  }));
}
