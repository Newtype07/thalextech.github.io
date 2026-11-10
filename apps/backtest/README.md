# Backtest app

## Data directories

- `source-data/thalex` contains the canonical, Git-tracked Parquet history.
- `public/runtime-data/thalex` contains generated JSON artifacts served to the browser.
- `dist/runtime-data/thalex` is disposable production-build output.

Run `npm run build:data` after adding or replacing source Parquet files. Both
`npm run dev` and `npm run build` also generate the runtime artifacts first.

In the app's Parameter sweep view, **Roll frequency** compares the existing
"Roll every" day presets up to the selected maturity (the near-leg maturity for
calendars). Runs use the roll-after-days exit mode and keep the entry schedule,
option maturity, and other strategy settings fixed. Expiry can close a position
before its requested roll date. Selecting a result applies its roll interval
and exit mode to the single backtest.

## For agents / programmatic use

Run these commands from `apps/backtest` with Node.js 20+ and dependencies installed.
Run `npm run build:data` once after checkout or after changing source Parquet files.
The runner does not fetch history or rebuild artifacts automatically. `--help`
and JavaScript imports work without generated artifacts.

The default CLI strategy matches the initial BTC UI: short 7D straddle, Friday
08:00 UTC entry, 24h hedging, 7D roll, and $100,000 underlying notional. Start
defaults to `2024-10-07T09:00:00Z`; end resolves to the current time **per call**.
Only available observations contribute. Supply explicit dates and preserve the
repository revision and data hash when reproducing a run.

```sh
# Default UI strategy, full JSON report on stdout
node scripts/run-backtest.mjs --json

# Frozen period; stdout and result.json contain identical JSON
node scripts/run-backtest.mjs --start 2025-06-01 --end 2025-07-01 --json --output result.json

# Return only summary metrics as JSON (requires jq)
node scripts/run-backtest.mjs --start 2025-06-01 --end 2025-07-01 --json | jq '.summary'

# ETH with a 30D expiry target, or a calendar pair using UI expiry windows
node scripts/run-backtest.mjs --underlying ETH --maturity 30 --json
node scripts/run-backtest.mjs --structure calendar_spread --maturity 7-30 --json

# Existing sweep; each item uses the single-run report contract
node scripts/run-backtest.mjs --sweep entry_hour --start 2025-06-01 --end 2025-07-01 --json
```

### Config files and validation

`--config` accepts one JSON object containing partial config overrides:

```json
{
  "underlying": "ETH",
  "start": "2025-06-01",
  "end": "2025-07-01",
  "structure": "straddle",
  "targetDteDays": 30,
  "entryHourUtc": 8,
  "entryWeekday": 5,
  "hedgeEnabled": true,
  "hedgeIntervalHours": 24
}
```

```sh
node scripts/run-backtest.mjs --config config.json --hedge 12 --json --output result.json
```

Explicit CLI flags override corresponding file fields. Unknown fields/options,
invalid types/dates, and inconsistent parameters fail instead of falling back to
defaults. JSON booleans must be booleans, not strings. CLI boolean config flags
take `true` or `false`; `--json` and `--help` are standalone switches. All config
fields have kebab-case flags, such as `--far-target-dte-days`. Existing aliases
include `--entry-hour`, `--weekday`, `--exit-hour`, `--long`, `--hedge`, and `--maturity`.

[Config JSON Schema](schema/backtest-config.schema.json) enumerates accepted fields
and scalar constraints. Runtime validation also checks date ordering, alias
agreement, spread deltas, calendar ordering, and
`minWeeklyDteDays <= targetDteDays <= maxWeeklyDteDays`.

Dates accept `YYYY-MM-DD` or ISO UTC timestamps ending in `Z` (up to three
fractional-second digits). A date-only end means **00:00 UTC on that date**, not
end of day. Both observation bounds are inclusive. `entryWeekday: -1` means every
day; `0` is Sunday and `6` is Saturday. Hours are UTC integers from 0 to 23.

Targets 1, 2, 7, 14, 30, 60, 90, and 180 days select the same expiry windows as the
UI. Calendar pairs are 7–14, 7–30, 14–30, 30–60, 30–90, 30–180, 60–90, 60–180,
and 90–180 days. Custom targets/pairs require explicit `minWeeklyDteDays` and
`maxWeeklyDteDays`. Explicit windows override presets. Targets choose available
expiries; they do not guarantee an exact DTE. Entry schedules and roll settings
remain separately configurable.

`sizingMode: "btc"` and `btcQuantity` retain historical names: they denote fixed
underlying units for **either BTC or ETH**. Covered calls and collars force one
underlying unit, short-side semantics, and no delta hedging. The returned config
records these effective settings.

### JSON result contract

[Result JSON Schema](schema/backtest-result.schema.json) describes complete runs,
sweeps, and errors. Single-run reports contain these top-level fields:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Public report version, currently `1`; distinct from artifact version. |
| `config` | Fully resolved effective config with ISO UTC dates. Can be saved and supplied to `--config`. |
| `data` | Underlying, artifact schema/version, pricing conventions, resolution, hours/DTE buckets, available/loaded observation bounds, and a SHA-256 input fingerprint. |
| `summary` | Aggregate metrics, including `maxDrawdownUsd`. |
| `cycles` | All selected cycle rows, including `closed`, option legs, hedge diagnostics, and optional attribution. |
| `counts` | `closedCycles`, `totalCycles`, and `unclosedCycles`. |
| `warnings` | Objects with machine-readable `code` and explanatory `message`. |

Numeric fields use JSON numbers or `null` when unavailable; `NaN` and infinities
are never emitted. Dates are ISO UTC strings; fields ending in `Ts` are Unix
**seconds**. USD PnL fields are dollars, volatility/return fields are decimals,
and leg quantities are signed underlying units. `finalEquityUsd` and
`endingEquityUsd` mean **cumulative PnL**, not account balances.
`shortOptionPnlUsd` includes option PnL for both long and short strategies.

Sharpe uses annualized cycle returns and a zero risk-free rate. Annualized return
is an arithmetic mean, not CAGR. `maxDrawdownUsd` is non-positive, measured at
cycle ends from an initial PnL of zero; it excludes intra-cycle drawdowns.
Summaries include closed cycles only; inspect `closed` when processing rows.

Sweeps return `{ "schemaVersion": 1, "sweep": "entry_hour", "runs": [...] }`;
each run has the contract above. Supported presets are `entry_hour`,
`entry_weekday`, `hedge_frequency`, and `hedge_tolerance`. Maturity/delta sweeps and
arbitrary config arrays are not yet accepted by the CLI.

With `--json`, stdout contains only the report. Errors produce no stdout, a
nonzero exit status, and one JSON object on stderr:

```json
{"schemaVersion":1,"error":{"code":"INVALID_INPUT","message":"Invalid entryHourUtc: 24"}}
```

Error codes are `INVALID_INPUT`, `DATA_UNAVAILABLE`, and `BACKTEST_FAILED`.
`--output` writes JSON through a temporary file and atomic rename. Failures before
writing leave an existing destination intact. Without `--json`, stdout retains a
human-readable summary, even when `--output` is used. Parent directories must
exist; config and output paths must differ.

Warnings cover no closed cycles, unclosed cycle rows, requested ends beyond
available observations, and missing hedge data. Warning codes are enumerated in
the schema; warnings do not change the successful exit status.

### JavaScript API and batch correctness

```js
import {
  runBacktest,
  runBacktestBatch,
  buildBacktestReport,
} from "./scripts/run-backtest.mjs";

const output = await runBacktest({
  underlying: "ETH",
  start: "2025-06-01",
  end: "2025-07-01",
});
const report = buildBacktestReport(output); // Same JSON-safe contract as --json

const outputs = await runBacktestBatch([
  { start: "2025-06-01", end: "2025-07-01" },
  { underlying: "ETH", start: "2025-08-01", end: "2025-09-01" },
]);
const reports = outputs.map(buildBacktestReport);
```

The existing JS envelope remains `{ config, result, summary, cycles, counts }`,
with additive `data` provenance. JS dates remain `Date` objects and unavailable
engine numbers remain `NaN`; use `buildBacktestReport` for the public JSON shape.
Programmatic inputs accept dates as strings or `Date` objects.

Batch output order matches input order. Each config retains its underlying,
date range, maturity, and sampling hours. Prepared data is shared only for
identical loading requirements, so results match standalone runs regardless of
config order. This trades some sweep throughput for predictable semantics.
All configs are validated before loading; a failure rejects the whole batch.
An empty batch returns `[]`.

### Data coverage and reproducibility

Artifacts are generated for BTC and ETH at all 24 UTC hours with 1h resolution.
DTE shards cover `(0,10]`, `(10,28]`, `(28,60]`, `(60,75]`, `(75,135]`,
`(135,240]`, and `(240,infinity)` days. Shard availability does not imply every
instrument or timestamp has a quote. Freshness follows the tracked source
Parquet history; rebuilding does not obtain newer history.

`data.availableStart/End` describe index coverage in selected hour shards, before
date filtering. `data.loadedStart/End` describe observations inside the requested
range, or are `null` if none exist. These bounds do not promise complete quotes.
`data.sha256` hashes the manifest and selected shard filenames and bytes in sorted
hour/DTE order, including data outside the requested dates. It identifies inputs,
not the engine revision: preserve the Git revision too. Artifact version `4`
describes a format, not freshness.

See below for covered-call/collar holding and return accounting. Results model
historical marks and index exposure without fees, financing, custody, or trading
costs.

## Covered call

Select **Covered call** under Instrument → Structure. Hold 1 BTC (or 1 ETH)
continuously from the first available index observation in the selected range to
the last, and sell calls against that unit using the strike-delta and roll settings.
The $100k sizing, long-option, and delta-hedging controls do not apply. Premiums
remain cash; they are not reinvested and the underlying is not resized at rolls.

Total P&L is option P&L plus final spot minus initial spot. Returns use the initial
unit's USD value. For cycle reporting, uncovered moves before a call are allocated
to that call's cycle; trailing moves after the last call belong to the last cycle.
Daily attribution records those moves on their actual timestamps. Holding-window
dates and prices are exported separately from the option entry and exit dates.
The existing hedge P&L and position fields carry the underlying exposure.

The distribution view remains a conditional benchmark of **call-active periods**,
including their underlying leg; it excludes uncovered gaps and compares observed
P&L over those same call periods. It is not a full buy-and-hold portfolio forecast.
This models cash-settled options and index-price exposure without financing,
custody, or trading costs. For other fixed-unit strategies, aggregate return also
uses the first cycle's investment, while per-cycle returns use that cycle's spot.

## Call and put spreads

Select **Call spread** or **Put spread** with **Near strike delta** and
**Wing strike delta** (default 25D / 10D, using absolute deltas for puts).
Short sells the near leg and buys the wing in equal quantities; Long reverses
both legs. Calls have a higher-strike wing; puts have a lower-strike wing.

At each entry, selection minimizes the sum of the two delta-target errors over
distinct, correctly ordered out-of-the-money strikes with the same expiry.
Ties use ascending near strike, then ascending wing strike. Entries without a
valid pair are skipped. Dollar width varies with available strikes and volatility;
sizing remains underlying notional, not spread premium or maximum loss.
The delta sweep varies the near target while holding the wing target fixed.

CLI example: `--structure call_spread --target-delta 0.25 --wing-delta 0.1`.

## Butterfly and condor

Select **Iron butterfly** or **Iron condor** under Instrument → Structure. Both use iron
structures with four same-expiry option legs. Short sells the inner options and
buys the outer wings in equal quantities; Long reverses all four legs.

- **Butterfly:** the inner call and put share the closest available ATM strike
  that has both wings. Wing strike delta selects the higher-strike call and
  lower-strike put (default 10D). An equally close ATM strike uses the lower strike.
- **Condor:** the inner put is below spot and the inner call is above spot.
  Near strike delta and Wing strike delta select each vertical spread jointly
  (default 25D / 10D), using the same deterministic matching as call/put spreads.

Entries without a complete structure are skipped. Wings need not have equal dollar
widths; deltas determine the strikes. Sizing uses underlying notional, not premium
or maximum loss. The delta sweep varies wing delta for butterflies and near delta
for condors, holding the condor wing target fixed.

CLI examples: `--structure butterfly --wing-delta 0.1` and
`--structure condor --target-delta 0.25 --wing-delta 0.1`.

## Collar

Select **Collar** to own 1 BTC (or 1 ETH), sell a call, and buy a put. The selected
absolute delta applies to both options, which share an expiry and roll together.
The collar uses the covered call's continuous underlying holding, initial-value
return basis, and gap accounting. Side, investment sizing, and delta hedging do
not apply; option premiums remain cash.

Total P&L includes both option legs and final spot minus initial spot. The
distribution view includes the underlying during option-active periods only and
excludes uncovered holding gaps, as it does for covered calls.

CLI example: `--structure collar --target-delta 0.25`.
