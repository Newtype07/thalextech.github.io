import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { asyncBufferFromFile, parquetReadObjects } from "hyparquet";
import { HISTORY_VIEWS, historyWindow } from "../src/skew-timeseries.js";
import { DELTAS, buildHistoricalSkew } from "../src/skew.js";
import { constantMaturityHistory } from "../src/constant-maturity.js";

// Read the canonical files, not the backtest's open-IV/pricing-specific artifacts.
const root = fileURLToPath(new URL("../", import.meta.url));
const source = path.resolve(root, "../backtest/source-data/thalex");
const files = (await fs.readdir(source)).sort();
const now = Date.now() / 1000;
const targets = new Set(HISTORY_VIEWS.flatMap(view => historyWindow(view.value, now).timestamps));
const cutoff = Math.min(...targets) - 3600;
const rawCutoff = Math.floor(now / 3600) * 3600 - 7 * 86400;
const cutoffMonth = new Date(cutoff * 1000)
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
  const index = new Map(), expiries = new Map(), sampledQuotes = [];
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
        values[0] >= cutoff &&
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
      if (
        !spec ||
        spec.expiry <= ts + 3600 ||
        ts < cutoff ||
        ts + 3600 > now ||
        !Number.isFinite(ts) ||
        !Number.isFinite(iv) ||
        iv <= 0
      )
        continue;
      if (targets.has(ts + 3600) && index.has(ts)) sampledQuotes.push({
        ...spec, ts: ts + 3600, iv, spot: index.get(ts)[4],
      });
      if (ts < rawCutoff) continue;
      if (!expiries.has(spec.expiry)) expiries.set(spec.expiry, new Map());
      const instruments = expiries.get(spec.expiry);
      if (!instruments.has(name))
        instruments.set(name, { ...spec, name, rows: new Map() });
      instruments.get(name).rows.set(ts, iv);
    }
  }
  const indexRows = [...index.values()].sort((a, b) => a[0] - b[0]);
  const manifest = {
    schema: "thalex-skew-history",
    version: 3,
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
    // Keep the sampled year for the optional price backdrop, plus recent raw
    // closes for incremental delta calculations. No extra browser API fetch.
    index: await write("index", { rows: indexRows.filter(row => row[0] >= rawCutoff || targets.has(row[0] + 3600)) }),
    prepared: {},
    expiries: {},
  };
  for (const { value, delta } of DELTAS) {
    const points = constantMaturityHistory(buildHistoricalSkew({ quotes: sampledQuotes, delta, limit: Infinity }));
    manifest.prepared[value] = await write(`prepared-${value}`, { version: 1, rows: points.map(p =>
      [p.ts, p.tenorDays, p.callIv, p.putIv, p.nearExpiry, p.farExpiry, p.weight]) });
    console.log(`[${asset}] ${value}Δ: ${points.length} prepared constant-tenor observations`);
  }
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
  const retained = new Set(["manifest.json", manifest.index, ...Object.values(manifest.expiries), ...Object.values(manifest.prepared)]);
  for (const file of await fs.readdir(out))
    if (/^(?:index|expiry-\d+|prepared-\d+)-[a-f0-9]{16}\.json$/.test(file) && !retained.has(file)) await fs.unlink(path.join(out, file));
  console.log(
    `[${asset}] ${indexRows.length} OHLC bars, ${quoteCount} closing IVs, ${expiries.size} historical/live expiries`,
  );
}
