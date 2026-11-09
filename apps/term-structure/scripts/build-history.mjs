import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { asyncBufferFromFile, parquetReadObjects } from "hyparquet";
import { buildHistoricalSeries } from "../src/volatility.js";
import { coneWindow, CONE_TENORS, impliedConeHistory, realizedConeHistory } from "../src/volatility-cone.js";

// Read the canonical files, not the backtest's open-IV/pricing-specific artifacts.
const root = fileURLToPath(new URL("../", import.meta.url));
const source = path.resolve(root, "../backtest/source-data/thalex");
const files = (await fs.readdir(source)).sort();
const now = Date.now() / 1000;
const cutoff = Math.floor(now / 3600) * 3600 - 2000 * 3600;
const coneSchedule = [...new Set([...coneWindow(now).timestamps, ...coneWindow(now, "3m").timestamps])].sort((a, b) => a - b);
const coneTargets = new Set(coneSchedule);
const coneCutoff = coneSchedule[0] - 3600;
const cutoffMonth = new Date(Math.min(cutoff, coneCutoff) * 1000)
  .toISOString()
  .slice(0, 7)
  .replace("-", "");
const months = {
  JAN: 0,
  FEB: 1,
  MAR: 2,
  APR: 3,
  MAY: 4,
  JUN: 5,
  JUL: 6,
  AUG: 7,
  SEP: 8,
  OCT: 9,
  NOV: 10,
  DEC: 11,
};
const parseName = (name) => {
  const m = /^[A-Z]+-(\d{2})([A-Z]{3})(\d{2})-(\d+(?:\.\d+)?)-([CP])$/.exec(
    name,
  );
  return m && months[m[2]] != null
    ? {
        expiry:
          Date.UTC(2000 + Number(m[3]), months[m[2]], Number(m[1]), 8) / 1000,
        strike: Number(m[4]),
        side: m[5],
      }
    : null;
};
const read = async (name, columns) =>
  parquetReadObjects({
    file: await asyncBufferFromFile(path.join(source, name)),
    columns,
  });
for (const asset of ["BTC", "ETH"]) {
  const out = path.join(root, "public/history-cache", asset.toLowerCase());
  await fs.mkdir(out, { recursive: true });
  const write = async (prefix, payload) => {
    const text = JSON.stringify(payload);
    const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
    const filename = `${prefix}-${hash}.json`;
    await fs.writeFile(path.join(out, filename), text);
    return filename;
  };
  const index = new Map(),
    expiries = new Map();
  const coneQuotes = [], coneExpiries = new Set();
  let marksThrough = null;
  const indexFiles = files.filter((n) =>
    new RegExp(`^${asset}USD_index_1h_\\d{6}\\.parquet$`).test(n),
  );
  const markFiles = files.filter(
    (n) =>
      new RegExp(`^O${asset}USD_marks_1h_\\d{6}\\.parquet$`).test(n) &&
      n.slice(-14, -8) >= cutoffMonth,
  );
  if (!indexFiles.length)
    throw new Error(`Missing ${asset} source Parquet files`);
  for (const filename of indexFiles) {
    for (const row of await read(filename, [
      "ts",
      "index_price_open",
      "index_price_high",
      "index_price_low",
      "index_price_close",
    ])) {
      const values = [
        row.ts,
        row.index_price_open,
        row.index_price_high,
        row.index_price_low,
        row.index_price_close,
      ].map(Number);
      if (
        values.every(Number.isFinite) &&
        values.slice(1).every((v) => v > 0) &&
        values[0] + 3600 <= now
      )
        index.set(values[0], values);
    }
  }
  for (const filename of markFiles) {
    console.log(`[${asset}] ${filename}`);
    for (const row of await read(filename, [
      "ts",
      "instrument_name",
      "iv_close",
    ])) {
      const ts = Number(row.ts),
        iv = Number(row.iv_close),
        name = String(row.instrument_name || "");
      const spec = parseName(name);
      if (
        spec &&
        Number.isFinite(ts) &&
        Number.isFinite(iv) &&
        iv > 0 &&
        ts + 3600 <= now
      )
        marksThrough = Math.max(marksThrough ?? 0, ts + 3600);
      // Include expired contracts at their own sampled close, matched to that
      // hour's index close. The ordinary curve cache still keeps live expiries.
      if (spec && spec.expiry > ts + 3600 && coneTargets.has(ts + 3600) &&
          Number.isFinite(iv) && iv > 0 && index.has(ts)) {
        coneQuotes.push({ ...spec, ts: ts + 3600, iv, spot: index.get(ts)[4] });
        coneExpiries.add(spec.expiry);
      }
      if (
        !spec ||
        spec.expiry <= now ||
        ts < cutoff ||
        ts + 3600 > now ||
        !Number.isFinite(ts) ||
        !Number.isFinite(iv) ||
        iv <= 0
      )
        continue;
      if (!expiries.has(spec.expiry)) expiries.set(spec.expiry, new Map());
      const instruments = expiries.get(spec.expiry);
      if (!instruments.has(name))
        instruments.set(name, { ...spec, name, rows: new Map() });
      instruments.get(name).rows.set(ts, iv);
    }
  }
  const indexRows = [...index.values()].sort((a, b) => a[0] - b[0]);
  const manifest = {
    schema: "thalex-term-history",
    version: 1,
    asset,
    resolution: 3600,
    timestampBasis: "bar-start",
    // Exclusive end of actual source bars, independent of the build time or
    // whether a currently listed expiry already has a Parquet shard.
    sourceThrough: {
      index: indexRows.length ? indexRows.at(-1)[0] + 3600 : null,
      marks: marksThrough,
    },
    ivBasis: "close",
    index: await write("index", { rows: indexRows }),
    expiries: {},
  };
  const indexBars = indexRows.map(([ts, open, high, low, close]) => ({ ts, open, high, low, close }));
  const latestClose = manifest.sourceThrough.index;
  const rv = realizedConeHistory(indexBars, [...new Set([...coneSchedule, ...(latestClose == null ? [] : [latestClose])])]);
  const cone = {
    schema: "thalex-volatility-cone", version: 1, asset,
    source: "backtest/source-data/thalex", sourceFiles: [...indexFiles, ...markFiles],
    sourceThrough: manifest.sourceThrough,
    sampling: { shortSeconds: 3600, longSeconds: 86400, longFromDays: 180, dailyUtcHour: 0, timestampBasis: "bar-close" },
    methodology: { iv: "atm-spot-close-total-variance", rv: "garman-klass-hourly", daysPerYear: 365.25, minHourlyCoverage: 0.99 },
    tenors: CONE_TENORS,
    implied: impliedConeHistory(buildHistoricalSeries({ history: coneQuotes, slice: "atm", limit: Infinity, expiries: [...coneExpiries] })),
    realized: rv.filter(p => coneTargets.has(p.ts)),
    latestRealized: rv.filter(p => p.ts === latestClose),
  };
  manifest.cone = await write("cone", cone);
  console.log(`[${asset}] cone: ${cone.implied.filter(p => p.iv != null).length} sampled IVs, ${cone.realized.filter(p => p.iv != null).length} sampled RVs`);
  let quoteCount = 0;
  for (const [expiry, instruments] of expiries) {
    const rows = [...instruments.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((i) => {
        const bars = [...i.rows].sort((a, b) => a[0] - b[0]);
        quoteCount += bars.length;
        return { name: i.name, strike: i.strike, side: i.side, rows: bars };
      });
    manifest.expiries[expiry] = await write(`expiry-${expiry}`, {
      expiry,
      instruments: rows,
    });
  }
  await fs.writeFile(path.join(out, "manifest.json"), JSON.stringify(manifest));
  for (const filename of await fs.readdir(out)) {
    if (/^cone-[a-f0-9]{16}\.json$/.test(filename) && filename !== manifest.cone)
      await fs.unlink(path.join(out, filename));
  }
  console.log(
    `[${asset}] ${indexRows.length} OHLC bars, ${quoteCount} closing IVs, ${expiries.size} live expiries`,
  );
}
