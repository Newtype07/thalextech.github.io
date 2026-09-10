#!/usr/bin/env node
/**
 * Node.js runner for the Thalex backtest engine.
 * Allows programmatic / CLI usage of the backtest tool outside the browser UI.
 *
 * Usage examples:
 *   node scripts/run-backtest.mjs --help
 *   node scripts/run-backtest.mjs --start 2025-06-01 --end 2025-12-31 --entry-hour 8 --weekday 5 --hedge 24
 *   node scripts/run-backtest.mjs --sweep entry_hour
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  prepareBacktestData,
  runWeeklyStraddleBacktest,
  runWeeklyStraddleBacktestBatch,
  normalizeBacktestConfig,
  requiredQuoteDteDays,
  DEFAULT_BACKTEST_CONFIG,
  computeMaxDrawdown,
} from "../src/lib/weeklyStraddleBacktest.js";
import {
  decodeInstrumentDictionary,
  decodePreparedShard,
  selectDteBuckets,
} from "../src/lib/thalexParquet.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(PROJECT_ROOT, "public/runtime-data/thalex");

const manifest = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "prepared_manifest.json"), "utf8"));
const INSTRUMENTS = decodeInstrumentDictionary(manifest);
const DTE_BUCKETS = (manifest.dteBuckets || []).map((bucket) => ({
  ...bucket,
  maxInclusive:
    bucket.maxInclusive == null ? Number.POSITIVE_INFINITY : Number(bucket.maxInclusive),
}));

function loadShard(hour, bucketKey) {
  const filename =
    `prepared_1h_h${String(hour).padStart(2, "0")}utc_dte${bucketKey}.json`;
  const payload = JSON.parse(fs.readFileSync(path.join(DATA_DIR, filename), "utf8"));
  return decodePreparedShard({ payload });
}

/**
 * Compute the set of hourly offsets needed for a given config (entry + hedge steps).
 */
export function hoursForConfig(config) {
  if (config.structure === "covered_call") return Array.from({ length: 24 }, (_, hour) => hour);
  const entry = Number(config.entryHourUtc ?? config.hourlyOffset ?? 8);
  const enabled = config.hedgeEnabled !== false;
  const interval = Math.max(1, Math.min(24, Math.round(Number(config.hedgeIntervalHours) || 24)));

  const hs = new Set([entry, 8]);
  if (config.exitMode === "weekly_schedule") hs.add(Number(config.exitHourUtc));
  if (enabled) {
    const addHedgeCycle = (startHour) => {
      let h = startHour;
      do {
        hs.add(h);
        h = (h + interval) % 24;
      } while (h !== startHour);
    };
    addHedgeCycle(entry);
    if (config.exitMode === "after_days") addHedgeCycle(8);
  }
  return [...hs].sort((a, b) => a - b);
}

/**
 * Load prepared data for the required hours.
 * Returns { indexRows, quoteSnapshots, instruments, preparedData }
 */
export async function loadDataForHours(
  hours,
  start = null,
  end = null,
  maxDteDays = Number.POSITIVE_INFINITY,
) {
  let indexRows = [];
  let quoteSnapshots = [];

  const startTs = start ? Math.floor(start.getTime() / 1000) : Number.NEGATIVE_INFINITY;
  const endTs = end ? Math.floor(end.getTime() / 1000) : Number.POSITIVE_INFINITY;

  const buckets = selectDteBuckets(DTE_BUCKETS, maxDteDays);
  for (const hour of hours) {
    for (const bucket of buckets) {
      const decoded = loadShard(hour, bucket.key);
      const filteredIndex = start || end
        ? decoded.indexRows.filter(r => r.ts >= startTs && r.ts <= endTs)
        : decoded.indexRows;
      const filteredQuotes = start || end
        ? decoded.quoteSnapshots.filter(([ts]) => ts >= startTs && ts <= endTs)
        : decoded.quoteSnapshots;

      indexRows.push(...filteredIndex);
      quoteSnapshots.push(...filteredQuotes);
    }
  }

  // Sort just in case
  indexRows.sort((a, b) => a.ts - b.ts);
  quoteSnapshots.sort((a, b) => a[0] - b[0]);

  return { indexRows, quoteSnapshots, instruments: INSTRUMENTS };
}

/**
 * Main entry: run a single backtest configuration.
 * Accepts partial config overrides (same shape as UI + lib).
 */
export async function runBacktest(overrides = {}) {
  const config = normalizeBacktestConfig(overrides);
  const hours = hoursForConfig(config);

  const { indexRows, quoteSnapshots, instruments } = await loadDataForHours(
    hours,
    config.start,
    config.end,
    requiredQuoteDteDays(config),
  );

  const preparedData = prepareBacktestData({
    indexRows,
    quoteSnapshots,
    instruments,
    config,
  });

  const result = runWeeklyStraddleBacktest({ preparedData, config });

  return {
    config,
    result,
    summary: result.summary,
    cycles: result.cycleSummary,
    counts: result.counts,
  };
}

/**
 * Run a batch of configs efficiently (shares prepared data where possible).
 */
export async function runBacktestBatch(configList = []) {
  if (!configList.length) return [];

  // Determine union of required hours
  const allHours = new Set();
  const normalized = configList.map(c => {
    const nc = normalizeBacktestConfig(c);
    hoursForConfig(nc).forEach(h => allHours.add(h));
    return nc;
  });
  const hours = [...allHours].sort((a, b) => a - b);

  // Use the first config's date range for loading (they should be similar for sweeps)
  const refConfig = normalized[0];
  const maxDteDays = Math.max(...normalized.map(requiredQuoteDteDays));
  const { indexRows, quoteSnapshots, instruments } = await loadDataForHours(
    hours,
    refConfig.start,
    refConfig.end,
    maxDteDays,
  );

  const preparedData = prepareBacktestData({
    indexRows,
    quoteSnapshots,
    instruments,
    config: refConfig,
  });

  const runs = normalized.map(config => ({ config }));
  const outputs = runWeeklyStraddleBacktestBatch({ preparedData, runs });

  return outputs.map((out, i) => ({
    config: normalized[i],
    result: out,
    summary: out.summary,
    cycles: out.cycleSummary,
  }));
}

// ---------- CLI ----------

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      args.help = true;
    } else if (a === "--sweep") {
      args.sweep = argv[++i];
    } else if (a.startsWith("--")) {
      const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      let val = argv[++i];
      if (val === undefined) val = true;
      // Try to coerce numbers / booleans
      if (val === "true") val = true;
      if (val === "false") val = false;
      if (!isNaN(val) && val !== "" && val !== true && val !== false) val = Number(val);
      args[key] = val;
    }
  }
  return args;
}

function printHelp() {
  console.log(`
Thalex Backtest Runner (Node)

Usage:
  node scripts/run-backtest.mjs [options]

Options (examples):
  --start 2025-06-01
  --end 2026-01-01
  --entry-hour 8
  --weekday 5                 (0=Sun ... 6=Sat)
  --structure straddle        (straddle|strangle|risk_reversal|call|put|covered_call|call_spread|put_spread|calendar_spread)
  --maturity 7                or use targetDteDays
  --target-delta 0.25
  --wing-delta 0.10           (call/put spread outer strike)
  --hedge 24                  (hours, or 0/false to disable)
  --hold-to-expiry true
  --exit-hold-days 7
  --exit-mode weekly_schedule (after_days|weekly_schedule|expiry)
  --exit-weekday 0            (0=Sun ... 6=Sat)
  --exit-hour 20
  --long false                (short by default)
  --sizing-mode notional      (notional | btc)
  --notional-usd 100000
  --btc-quantity 1

Sweep mode:
  --sweep entry_hour          (or entry_weekday, maturity, hedge_frequency, delta_band)

Other:
  node scripts/run-backtest.mjs --sweep entry_hour --start 2025-07-01 --end 2025-10-01
`);
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const overrides = {
    start: args.start ? new Date(args.start) : undefined,
    end: args.end ? new Date(args.end) : undefined,
    entryHourUtc: args.entryHour,
    hourlyOffset: args.entryHour,
    entryWeekday: args.weekday,
    structure: args.structure,
    targetDteDays: args.targetDteDays ?? args.maturity,
    targetDelta: args.targetDelta,
    wingDelta: args.wingDelta,
    hedgeEnabled: args.hedge != null ? Number(args.hedge) > 0 : undefined,
    hedgeIntervalHours: args.hedge != null && Number(args.hedge) > 0 ? Number(args.hedge) : undefined,
    holdToExpiry: args.holdToExpiry,
    exitMode: args.exitMode,
    exitHoldDays: args.exitHoldDays,
    exitWeekday: args.exitWeekday,
    exitHourUtc: args.exitHour,
    longOption: args.long,
    sizingMode: args.sizingMode,
    notionalUsd: args.notionalUsd,
    btcQuantity: args.btcQuantity,
  };

  // Clean undefined
  Object.keys(overrides).forEach(k => overrides[k] === undefined && delete overrides[k]);

  try {
    if (args.sweep) {
      console.log(`Running sweep over dimension: ${args.sweep}`);
      // For simplicity, basic support for a couple dimensions
      let configs = [];
      if (args.sweep === "entry_hour") {
        configs = Array.from({ length: 24 }, (_, h) => ({ ...overrides, entryHourUtc: h, hourlyOffset: h }));
      } else if (args.sweep === "entry_weekday") {
        configs = Array.from({ length: 7 }, (_, w) => ({ ...overrides, entryWeekday: w }));
      } else if (args.sweep === "hedge_frequency") {
        const freqs = [1,2,3,4,6,8,12,24];
        configs = freqs.map(f => ({ ...overrides, hedgeEnabled: true, hedgeIntervalHours: f }));
      } else {
        console.error("Sweep dimension not yet supported in CLI helper:", args.sweep);
        process.exit(1);
      }

      const results = await runBacktestBatch(configs);
      console.log("\nSweep results:");
      const header = "Label      |     PnL | Sharpe |   MaxDD | Cycles |   OptPnL |  HedgePnL";
      console.log(header);
      console.log("-".repeat(header.length));
      let bestSharpe = { label: "", sharpe: -Infinity, pnl: 0 };
      let bestPnl = { label: "", sharpe: 0, pnl: -Infinity };
      for (const r of results) {
        const c = r.config;
        const s = r.summary;
        const cycleRows = r.cycles || r.result?.cycleSummary || [];
        const maxDD = computeMaxDrawdown(cycleRows);
        const label = args.sweep === "entry_hour" ? `${String(c.entryHourUtc).padStart(2,"0")}:00` :
                      args.sweep === "entry_weekday" ? ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][c.entryWeekday] :
                      `hedge ${c.hedgeIntervalHours}h`;
        const line = `${label.padEnd(10)} | ${s.finalEquityUsd.toFixed(0).padStart(7)} | ${(s.sharpeRatio||0).toFixed(2).padStart(6)} | ${maxDD.toFixed(0).padStart(7)} | ${String(r.result.counts.closedCycles).padStart(6)} | ${s.cumulativeOptionPnlUsd.toFixed(0).padStart(8)} | ${s.cumulativeHedgePnlUsd.toFixed(0).padStart(9)}`;
        console.log(line);
        const sharpe = s.sharpeRatio || 0;
        const pnl = s.finalEquityUsd;
        if (sharpe > bestSharpe.sharpe) bestSharpe = { label, sharpe, pnl };
        if (pnl > bestPnl.pnl) bestPnl = { label, sharpe, pnl };
      }
      console.log("-".repeat(header.length));
      console.log(`Best Sharpe: ${bestSharpe.label} (Sharpe ${bestSharpe.sharpe.toFixed(2)}, PnL ${bestSharpe.pnl.toFixed(0)})`);
      console.log(`Best PnL:    ${bestPnl.label} (PnL ${bestPnl.pnl.toFixed(0)}, Sharpe ${bestPnl.sharpe.toFixed(2)})`);
      return;
    }

    const { result, config } = await runBacktest(overrides);

    console.log("\n=== Backtest Result ===");
    console.log("Config:", {
      entry: `${["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][config.entryWeekday]} ${String(config.entryHourUtc).padStart(2,"0")}:00`,
      structure: config.structure,
      dte: config.targetDteDays,
      delta: config.targetDelta,
      hedge: config.hedgeEnabled ? `${config.hedgeIntervalHours}h` : "off",
      exit: config.exitMode === "expiry"
        ? "to expiry"
        : config.exitMode === "weekly_schedule"
          ? `${["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][config.exitWeekday]} ${String(config.exitHourUtc).padStart(2,"0")}:00 weekly`
          : `roll every ${config.exitHoldDays}D`,
      side: config.longOption ? "long" : "short",
    });
    console.log("Period:", config.start.toISOString().slice(0,10), "→", (config.end || new Date()).toISOString().slice(0,10));
    console.log("");
    console.log("Closed cycles:     ", result.counts.closedCycles);
    console.log("Final PnL (USD):   ", result.summary.finalEquityUsd.toFixed(2));
    console.log("Sharpe ratio:      ", (result.summary.sharpeRatio || 0).toFixed(3));
    console.log("Max drawdown:      ", computeMaxDrawdown(result.cycleSummary).toFixed(2));
    console.log("Option PnL:        ", result.summary.cumulativeOptionPnlUsd.toFixed(2));
    console.log("Hedge PnL:         ", result.summary.cumulativeHedgePnlUsd.toFixed(2));
    console.log("Mean entry IV:     ", (result.summary.meanEntryImpliedVol * 100).toFixed(1) + "%");
    console.log("Mean sampled RV:   ", (result.summary.meanSampledRealizedVol * 100).toFixed(1) + "%");
  } catch (err) {
    console.error("Backtest failed:", err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
