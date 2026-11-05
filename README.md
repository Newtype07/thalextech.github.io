# Thalex second screen apps

### Build
To build all apps, run `./build_apps.sh`

If you want to build an individual app, `cd` into the app directory and execute npm commands following the app's README.

### Shared instrument selection

`lib/components/PositionBuilder.vue` owns the option-leg inputs used by Payoff, Simulator, Term Structure's position simulator, and Combo P&L. Its default layout includes the combination heading, shared or per-leg maturities, inline controls, and aggregate Greeks. Apps supply their instruments, quotes or valuations, and leg state.

The builder uses the shared select menu and the position, option-pricing, instrument-contract, and combination-title modules in `lib/`; it has no dependency on app source. The simulator's former position and pricing modules re-export those shared modules to preserve existing imports.

The app's central chart container owns the editor width. The builder fills that container without its own maximum width, border, or background; chart and editor should share a grid column or parent width, with sidebars outside that column.

For charts with internal SVG margins, align the editor to the plotted content using the chart's layout values. Simulator shares its chart width and margins between the renderer and the editor's responsive insets.


### Shared delta hedging and market assumptions

`lib/delta-hedging/` owns threshold/tolerance decisions, sustained-breach timers, fill accounting and observed-path replay. Simulator, Combo P&L, Term Structure and Hedging use the same engine and `lib/components/DeltaHedgeControls.vue`. Simulator and Combo P&L dock settings beside the main content using the shared `SettingsSidePanel.vue`, which owns the two-column layout and stacks it on narrow screens.

The interactive controls now expose threshold, tolerance and period sliders, a resettable threshold timer, immediate entry neutralization, and an exit choice. Legacy scheduled/entry-policy fields remain supported by the replay API for saved scenarios. Combo P&L splits the chart and settings equally and loads closed one-minute observations through bounded, cached pages in `lib/minute-history.js`; chart resolution aggregates the completed replay without fetching, changing the history window, or changing fills and costs. All minute fills remain visible as trade markers. The dedicated Hedging app also evaluates at one minute and samples results for display. Missing observations reset the threshold timer and are not interpolated or replaced by coarse history.

Strategy Monte Carlo paths use a separate one-minute evaluation clock, including when hedging is off; the graph step count only controls sampled output. This preserves outcomes across display resolutions without allocating a full minute-path matrix. Fine evaluation is more expensive: a local 100-path, 14-day GBM run with hedging and sampled output took about 0.7 seconds. Large path counts and long horizons take substantially longer; slider changes cancel obsolete worker runs. Term Structure continues to evaluate on its existing one-minute clock.

`lib/market-model/` owns flat/forward variance schedules, stochastic/jump paths and historical calibration profiles. Simulator and Term Structure generate small BTC/ETH lookback profiles from the tracked Backtest index Parquet in their prebuild/predev steps. The browser loads profiles, not Parquet. `MarketAssumptions.vue` applies estimates explicitly and records the training date; realized return/variance-shock correlation is used. Live forward snapshots remain separate from historical calibration.

Run shared regression tests with `node --test lib/delta-hedging/*.test.js lib/market-model/*.test.js`, then each consumer's `npm test` and `npm run build`. See [the implementation plan](DELTA_HEDGING_PLAN.md) for model conventions and remaining calibration work.


## Automated Secrets Scanning

The build pipeline automatically scans pull requests for leaked secrets before
allowing a merge to main. This scan is performed using an open source tool
called [TruffleHog](https://trufflesecurity.com/trufflehog).

### What to do if Secrets are Detected

By default, TruffleHog's output is human readable, and quite useful. If you're
working with scripts or automation, use the `--json` flag to work with JSON
output instead. If you need to read the JSON, it can be made human readable via
`jq '.' scan_result.json`.  Each entry in the JSON represents one detected
secret, and the rest is decently self-explanatory.

For each secret detected, follow the Revoke and Remove sections below.

#### Revoke

1. Decided whether the secret is sensitive or not. If it protects any data or
   access to anything at all, it's sensitive.
2. For sensitive secrets, determine whether the secret has been published.
   If it has been published, the secret is burnt. You need to revoke/rotate it
   before moving on to the Remove section. NOTE: If it was in a PR or branch,
   you should consider it to have been revealed publicly.
3. If it is not sensitive, there is no need to revoke it, so you can move to
   the Remove section.

#### Remove

Even if it's a non-sensitive secret, you need to remove the secret from the
repo so that it will stop triggering TruffleHog. Non-sensitive secrets should
be removed from the repo the same way sensitives ones are; however, if it's a
test secret and not truly sensitive, you can use one of the methods mentioned
in the Ignoring Non-secret Secrets section to ignore the secret, but only if
you can't use best practices to remove it from the final image.

### Ignoring Non-secret Secrets

There are three ways to ask TruffleHog to ignore a secret.

1. Ignore entire files: --exclude-paths
   This flag takes a comma-separated list of paths to files that will be
   ignored by the scanner. To take advantage of it in the CI/CD pipeline,
   append each path you'd like to ignore to `.thog-exclude-paths` in the
   repository root. There should be one path per line in this file.
2. Ignore comment: `trufflehog:ignore`
   Adding this trailing comment to a line will skip that line.
3. Ignore specific secret: Comming soon. Awaiting PR merge.
   https://github.com/trufflesecurity/trufflehog/pull/4436
