import { spotDelta } from "./volatility.js";
import { TENORS } from "./constant-maturity.js";
const HOUR = 3600, DAY = 86400;

// Choose real quote inputs for each hour's delta and constant-tenor brackets.
// Seed IVs only choose where to start looking; they never become observations.
// Confirmed empty inputs expand the search. Failed requests remain unresolved.
export function planSkewHistory({ chain, cache, spots, hours, delta, tenors = TENORS,
  period = HOUR, now = Date.now(), seedIvs = new Map() }) {
  const byExpiry = new Map();
  const seeds = new Map();
  const requests = new Map(), readyHours = new Set(), needed = new Map();
  const request = (instrument, ts) => {
    if (!requests.has(instrument.name)) requests.set(instrument.name, { instrument, hours: new Set() });
    requests.get(instrument.name).hours.add(ts);
  };
  for (const instrument of chain) {
    if (!byExpiry.has(instrument.expiry)) byExpiry.set(instrument.expiry, []);
    byExpiry.get(instrument.expiry).push(instrument);
    let seed = seedIvs.get(instrument.name), latest = -Infinity;
    if (!(seed > 0 && Number.isFinite(seed))) for (const [ts, iv] of cache.marks.get(instrument.name)?.rows || []) {
      if (ts > latest && iv > 0 && Number.isFinite(iv)) { seed = iv; latest = ts; }
    }
    if (seed > 0 && Number.isFinite(seed)) seeds.set(instrument.name, seed);
  }
  const expiries = [...byExpiry.keys()].sort((a, b) => a - b);
  const seedValues = [...seeds.values()].sort((a, b) => a - b);
  const fallbackIv = seedValues[Math.floor(seedValues.length / 2)] || 0.5;
  for (const list of byExpiry.values()) list.sort((a, b) => a.strike - b.strike);
  const checkedEmpty = (instrument, ts) => (cache.checked.get(instrument.name) || []).some(r =>
    (r.period ?? HOUR) === period && ts >= r.from && ts <= r.to && (r.expires == null || r.expires > now));

  for (const ts of [...hours].sort((a, b) => b - a)) {
    const spot = spots.get(ts), close = ts + HOUR;
    if (!(spot > 0)) continue;
    const memo = new Map();
    const wing = (instruments, side) => {
      const target = side === "P" ? -delta : delta;
      const candidates = instruments.filter(i => i.side === side && (i.listedAt == null || i.listedAt <= ts));
      const available = [], unknown = [];
      for (let index = 0; index < candidates.length; index++) {
        const instrument = candidates[index];
        const iv = cache.marks.get(instrument.name)?.rows.get(ts);
        if (iv > 0 && Number.isFinite(iv)) available.push({ index, instrument,
          delta: spotDelta({ ...instrument, iv, spot, ts: close }) });
        else if (instrument.fetchable !== false && !checkedEmpty(instrument, ts)) unknown.push({ index, instrument });
      }
      const low = available.filter(p => p.delta <= target).sort((a, b) => b.delta - a.delta)[0];
      const high = available.filter(p => p.delta >= target).sort((a, b) => a.delta - b.delta)[0];
      if (low && high) {
        const lo = Math.min(low.index, high.index), hi = Math.max(low.index, high.index);
        const inside = unknown.filter(p => p.index > lo && p.index < hi);
        return inside.length ? { status: "pending", inputs: inside.map(p => p.instrument) } : { status: "ready", inputs: [] };
      }
      if (low || high) {
        // Delta decreases with strike on either wing. Search outward from an
        // actual observed delta, skipping only confirmed empty inputs.
        const edge = low || high;
        const next = low ? unknown.filter(p => p.index < edge.index).at(-1) : unknown.find(p => p.index > edge.index);
        return next ? { status: "pending", inputs: [next.instrument] } : { status: "unavailable", inputs: [] };
      }
      const predicted = unknown.map(p => ({ ...p, delta: spotDelta({ ...p.instrument,
        iv: seeds.get(p.instrument.name) || fallbackIv, spot, ts: close }) }));
      const below = predicted.filter(p => p.delta <= target).sort((a, b) => b.delta - a.delta)[0];
      const above = predicted.filter(p => p.delta >= target).sort((a, b) => a.delta - b.delta)[0];
      const inputs = [...new Map([below, above].filter(Boolean).map(p => [p.instrument.name, p.instrument])).values()];
      return { status: inputs.length ? "pending" : "unavailable", inputs };
    };
    const inspect = expiry => {
      if (memo.has(expiry)) return memo.get(expiry);
      const instruments = byExpiry.get(expiry);
      const call = wing(instruments, "C"), put = wing(instruments, "P");
      const status = call.status === "unavailable" || put.status === "unavailable" ? "unavailable"
        : call.status === "ready" && put.status === "ready" ? "ready" : "pending";
      const result = { status, inputs: status === "pending" ? [...call.inputs, ...put.inputs] : [] };
      memo.set(expiry, result); return result;
    };
    let pending = false;
    for (const tenor of tenors) {
      const target = close + tenor * DAY;
      for (const side of [expiries.filter(e => e > close && e <= target).reverse(), expiries.filter(e => e >= target)]) {
        for (const expiry of side) {
          const result = inspect(expiry);
          if (result.status === "unavailable") continue;
          if (!needed.has(expiry)) needed.set(expiry, new Set());
          needed.get(expiry).add(ts);
          for (const input of result.inputs) request(input, ts);
          if (result.status === "pending") pending = true;
          break;
        }
      }
    }
    if (!pending) readyHours.add(ts);
  }
  return { requests: [...requests.values()], readyHours, needed };
}
