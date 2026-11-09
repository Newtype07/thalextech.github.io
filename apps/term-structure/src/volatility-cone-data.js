import { CONE_TENORS } from "./volatility-cone.js";

// The cone is an independent Parquet-only artifact. Do not fall back to the
// live-expiry cache or REST: neither contains the expired year-long sample.
export async function loadVolatilityConeData(asset, { signal, fetchImpl = fetch } = {}) {
  if (!["BTC", "ETH"].includes(asset)) throw new Error(`Unsupported cone asset: ${asset}`);
  const base = `${import.meta.env?.BASE_URL || "/"}history-cache/${asset.toLowerCase()}/`;
  const read = async (filename, fresh = false) => {
    if (!/^[a-z0-9-]+\.json$/.test(filename)) throw new Error("Invalid cone cache filename");
    const response = await fetchImpl(base + filename, { signal, cache: fresh ? "no-cache" : "default" });
    if (!response.ok) throw new Error(`Cone cache HTTP ${response.status}; run npm run build:data`);
    if (/text\/html/i.test(response.headers?.get("content-type") || ""))
      throw new Error("Cone cache returned HTML; run npm run build:data");
    const payload = await response.json();
    signal?.throwIfAborted();
    return payload;
  };
  const manifest = await read("manifest.json", true);
  if (manifest.schema !== "thalex-term-history" || manifest.version !== 1 || manifest.asset !== asset ||
      typeof manifest.cone !== "string") throw new Error("Cone history unavailable; run npm run build:data");
  const data = await read(manifest.cone);
  if (data.schema !== "thalex-volatility-cone" || data.version !== 1 || data.asset !== asset ||
      data.source !== "backtest/source-data/thalex" ||
      data.sampling?.shortSeconds !== 3600 || data.sampling?.longSeconds !== 86400 || data.sampling?.longFromDays !== 180 ||
      data.sampling?.dailyUtcHour !== 0 || data.sampling?.timestampBasis !== "bar-close" ||
      data.methodology?.iv !== "atm-spot-close-total-variance" || data.methodology?.rv !== "garman-klass-hourly" ||
      data.methodology?.daysPerYear !== 365.25 || data.methodology?.minHourlyCoverage !== 0.99 ||
      JSON.stringify(data.tenors) !== JSON.stringify(CONE_TENORS)) throw new Error("Unsupported cone history");
  for (const kind of ["index", "marks"]) {
    const ts = data.sourceThrough?.[kind];
    if (ts !== null && (!Number.isFinite(ts) || ts % 3600 !== 0)) throw new Error("Invalid cone source boundary");
  }
  for (const field of ["implied", "realized", "latestRealized"]) {
    if (!Array.isArray(data[field])) throw new Error(`Invalid cone ${field}`);
    const seen = new Set();
    for (const p of data[field]) {
      const key = `${p.ts}:${p.tenorDays}`;
      if (!Number.isFinite(p.ts) || p.ts % 3600 !== 0 ||
          !CONE_TENORS.includes(p.tenorDays) || (p.iv !== null && (!Number.isFinite(p.iv) || p.iv < 0)) || seen.has(key) ||
          p.ts > data.sourceThrough[field === "implied" ? "marks" : "index"] && p.iv !== null)
        throw new Error(`Invalid cone ${field} observation`);
      if (field !== "implied" && (!Number.isInteger(p.count) || p.count < 0 || p.hours !== p.tenorDays * 24 ||
          p.count > p.hours || p.coverage !== p.count / p.hours || (p.coverage < 0.99 && p.iv !== null)))
        throw new Error("Invalid cone RV coverage");
      seen.add(key);
    }
  }
  return data;
}
