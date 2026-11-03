import { requestThalex } from "../../../lib/thalex-rest.js";

// Keep the exchange's ticker shape outside the payoff calculation.
export function normalizePayoffQuote(ticker, instrumentName) {
  const { mark_price: premium, forward, iv, index: spot, mark_timestamp: timestamp } = ticker;
  if (!Number.isFinite(premium) || premium < 0 ||
      !Number.isFinite(forward) || forward <= 0 ||
      !Number.isFinite(spot) || spot <= 0 || !Number.isFinite(timestamp)) {
    throw new Error(`Missing current mark or forward for ${instrumentName}.`);
  }
  return { premium, forward, iv: Number.isFinite(iv) && iv >= 0 ? iv : null, spot, timestamp };
}

export async function fetchPayoffQuotes(instrumentNames, signal) {
  const entries = await Promise.all(instrumentNames.map(async (name) => {
    const ticker = await requestThalex("ticker", { instrument_name: name }, signal);
    return [name, normalizePayoffQuote(ticker, name)];
  }));
  return Object.fromEntries(entries);
}
