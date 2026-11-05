import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { buildCalibrationProfile } from "./calibration.js";

// Resolve the build dependency from the consumer, keeping browser modules dependency-free.
const require = createRequire(path.join(process.cwd(), "package.json"));
const { asyncBufferFromFile, parquetReadObjects } = await import(pathToFileURL(require.resolve("hyparquet")).href);
const source = fileURLToPath(new URL("../../apps/backtest/source-data/thalex/", import.meta.url));
const output = path.resolve(process.argv[2] ?? "public/calibration");
await fs.mkdir(output, { recursive: true });
const files = (await fs.readdir(source)).sort();
const manifest = { version: 1, profiles: [] };
for (const asset of ["BTC", "ETH"]) {
  const names = files.filter(name => new RegExp(`^${asset}USD_index_1h_\\d{6}\\.parquet$`).test(name));
  if (!names.length) throw new Error(`Missing ${asset} index Parquet history.`);
  const rows = new Map(), hash = createHash("sha256");
  for (const name of names) {
    const filename = path.join(source, name);
    hash.update(name).update(await fs.readFile(filename));
    const decoded = await parquetReadObjects({ file: await asyncBufferFromFile(filename), columns: ["ts", "index_price_close"] });
    for (const row of decoded) {
      const ts = Number(row.ts) + 3600, close = Number(row.index_price_close);
      if (Number.isFinite(ts) && ts <= Date.now() / 1000 && Number.isFinite(close) && close > 0) rows.set(ts, { ts, close });
    }
  }
  const history = [...rows.values()].sort((a, b) => a.ts - b.ts);
  const asOf = history.at(-1)?.ts;
  if (!asOf) throw new Error(`No completed ${asset} hourly bars.`);
  const sourceHash = hash.digest("hex");
  for (const lookbackDays of [30, 90, 180, 365]) {
    const profile = buildCalibrationProfile(history, { asset, lookbackDays, asOf, sourceHash });
    const text = JSON.stringify(profile);
    const digest = createHash("sha256").update(text).digest("hex").slice(0, 16);
    const file = `${asset.toLowerCase()}-${lookbackDays}-${digest}.json`;
    await fs.writeFile(path.join(output, file), text);
    manifest.profiles.push({ asset, lookbackDays, asOf, file });
    console.log(`${asset} ${lookbackDays}d: ${profile.status}, coverage ${(profile.training.coverage * 100).toFixed(2)}%, ${Buffer.byteLength(text)} bytes`);
  }
}
await fs.writeFile(path.join(output, "manifest.json"), JSON.stringify(manifest));
