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

// Use the expiry's nearest listed strike, rather than the selected legs' wing IVs.
// Reuse selected quotes and let missing ATM data leave only P-win unavailable.
export async function fetchAtmVolatility(instruments, expiry, forward, quotes, signal) {
  const candidates = instruments.filter((i) => i.expiration_ts === expiry &&
    Number.isFinite(i.strike) && i.strike > 0);
  if (!candidates.length || !(forward > 0)) return null;
  const nearest = candidates.reduce((best, i) =>
    Math.abs(Math.log(i.strike / forward)) < Math.abs(Math.log(best.strike / forward)) ? i : best);
  const names = [...new Set(candidates.filter((i) => i.strike === nearest.strike).map((i) => i.instrument_name))];
  const ivs = await Promise.all(names.map(async (name) => {
    try {
      const quote = quotes[name] ?? (await fetchPayoffQuotes([name], signal))[name];
      return Number.isFinite(quote.iv) && quote.iv >= 0 ? quote.iv : null;
    } catch {
      signal?.throwIfAborted();
      return null;
    }
  }));
  signal?.throwIfAborted();
  const valid = ivs.filter((iv) => iv !== null);
  return valid.length ? Math.sqrt(valid.reduce((sum, iv) => sum + iv ** 2, 0) / valid.length) : null;
}
