import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { asyncBufferFromFile, parquetReadObjects } from "hyparquet";

// Read the canonical files, not the backtest's open-IV/pricing-specific artifacts.
const root = fileURLToPath(new URL("../", import.meta.url));
const source = path.resolve(root, "../backtest/source-data/thalex");
const files = (await fs.readdir(source)).sort();
const now = Date.now() / 1000;
const cutoff = Math.floor(now / 3600) * 3600 - 2000 * 3600;
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
  const index = new Map(),
    expiries = new Map();
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
  console.log(
    `[${asset}] ${indexRows.length} OHLC bars, ${quoteCount} closing IVs, ${expiries.size} live expiries`,
  );
}
