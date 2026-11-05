import { requestThalex } from "../thalex-rest.js";

export function atmCurveFromQuotes(quotes, spot, asOf) {
  const expiries = new Map();
  for (const quote of quotes) {
    if (![quote.expiry, quote.strike, quote.iv, quote.ts].every(Number.isFinite) || quote.expiry <= asOf ||
      quote.iv <= 0 || Math.abs(asOf - quote.ts) > 120) continue;
    const strikes = expiries.get(quote.expiry) ?? new Map();
    const values = strikes.get(quote.strike) ?? [];
    values.push(quote.iv ** 2); strikes.set(quote.strike, values); expiries.set(quote.expiry, strikes);
  }
  return [...expiries].flatMap(([expiry, strikes]) => {
    const points = [...strikes].map(([strike, values]) => ({ strike, variance: values.reduce((a, b) => a + b, 0) / values.length }))
      .sort((a, b) => a.strike - b.strike);
    const lower = points.filter(row => row.strike <= spot).at(-1), upper = points.find(row => row.strike >= spot);
    if (!lower || !upper) return []; // No silent nearest-strike extrapolation.
    const weight = upper.strike === lower.strike ? 0 : (spot - lower.strike) / (upper.strike - lower.strike);
    return [{ seconds: expiry - asOf, iv: Math.sqrt(lower.variance * (1 - weight) + upper.variance * weight) }];
  }).sort((a, b) => a.seconds - b.seconds);
}

export async function fetchForwardSnapshot({ instruments, spot, asset, signal, request = requestThalex, now = () => Date.now() / 1000 }) {
  const started = now(), expiries = new Map();
  for (const instrument of instruments) {
    const name = instrument.instrument_name;
    const expiry = Number(instrument.expiration_timestamp), strike = Number(instrument.strike_price);
    if (!name?.startsWith(`${asset}-`) || !Number.isFinite(expiry) || expiry <= started || !Number.isFinite(strike)) continue;
    const rows = expiries.get(expiry) ?? []; rows.push({ name, expiry, strike }); expiries.set(expiry, rows);
  }
  const selected = [...expiries.values()].flatMap(rows => {
    const strikes = [...new Set(rows.map(row => row.strike))].sort((a, b) => a - b);
    const low = strikes.filter(strike => strike <= spot).at(-1), high = strikes.find(strike => strike >= spot);
    return rows.filter(row => row.strike === low || row.strike === high);
  });
  const quotes = [], failures = [];
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, selected.length) }, async () => {
    while (cursor < selected.length) {
      signal?.throwIfAborted();
      const instrument = selected[cursor++];
      try {
        const ticker = await request("ticker", { instrument_name: instrument.name }, signal);
        quotes.push({ ...instrument, iv: ticker.iv, ts: ticker.mark_timestamp });
      } catch (error) { signal?.throwIfAborted(); failures.push(`${instrument.name}: ${error.message}`); }
    }
  }));
  const asOf = now();
  const nodes = atmCurveFromQuotes(quotes, spot, asOf);
  if (!nodes.length) throw new Error(failures[0] ?? "No fresh ATM forward-curve quotes are available.");
  return { nodes, asOf, spot, failures, source: "Live ATM ticker snapshot" };
}
