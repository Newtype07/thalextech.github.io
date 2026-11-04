# Shared delta hedging: review and implementation plan

Status: proposed, 4 November 2026. This is a source review and implementation plan; application behavior has not been changed.

## Goal and architectural decision

Use the same delta hedge policy, accounting and controls in Simulator, Combo P&L and Term Structure. A user should be able to replay a historical move or simulate future paths, vary threshold/tolerance/period, and compare the resulting net P&L, costs and exposure on identical market paths.

Build a small domain module in `lib/delta-hedging/` and a shared Vue panel. Each app supplies timestamped portfolio delta and executable hedge prices. The shared code decides when to hedge and accounts for fills. Apps retain market fetching, pricing, path generation, option settlement, chart layout and option P&L attribution.

The central problem is duplicated ownership of hedge behavior, not the number of components. Sharing only the input fields would leave decisions and P&L inconsistent; moving all simulation code into one component would couple unrelated pricing models and data sources.

## Existing implementations

| Implementation | Current behavior | Useful foundation / change pressure |
| --- | --- | --- |
| `apps/term-structure/src/simulation/delta-hedge.js` | Pure decision function: sustained threshold breach or scheduled checks; tolerance overrides either. | Best starting point for shared policy. Validation still lives in the position simulator; scheduled checks require exact clock alignment. |
| `apps/term-structure/src/simulation/position-simulation.js` | Combines path generation, term-curve pricing, option settlement/attribution and a spot hedge ledger. Always neutralizes at entry and unwinds at exit; charges configurable option and hedge costs. | Preserve pricing and settlement together; replace only its hedge policy/accounting. Do not make the other apps depend on this simulator. |
| `apps/term-structure/src/components/PositionSimulator.vue` | Owns hedge controls and reruns automatically with a new random seed, including on hedge-setting changes. | Extract controls. Keep the market snapshot and seed batch fixed during comparisons; the underlying engine already preserves paths for a fixed seed across policy changes. |
| `apps/hedging/src/hedgingSimulation.js` | Historical marks, a duplicate sustained-breach/tolerance policy, perpetual fills, cash ledger and optional hedge costs. | Include this app in migration to avoid retaining a competing implementation. It waits for a policy trigger at entry, has no final unwind and silently raises positive tolerance to threshold when too small. |
| `apps/combo-pnl/src/App.vue`, `applyTimeBasedDeltaHedge` | Interval-only rehedging with average-cost realized/unrealized P&L, embedded in Vue. No hedge fees or final unwind in this function. | Extract decision/accounting from the screen; preserve chart output through an adapter. Threshold/tolerance hedging is a behavior addition here. |
| `apps/simulator/src/workers/sim.worker.ts` | Monte Carlo paths, option/future valuation and stop logic; no dynamic delta hedge implementation found. | Integrate the shared engine into the worker's portfolio valuation loop. A static future leg or an option-stop comparison is not a dynamic delta hedge. |
| `apps/backtest/src/lib/hedgeLifecycle.js` | Scheduled mode or tolerance-only mode. Tolerance scales with option quantity; hourly opening delta/gamma estimate intrabar trigger prices. Assumes trigger ordering and at most two trades per hour. | Review as an additional implementation, but retain its intrabar execution model separately. It cannot establish sustained breach duration from OHLC alone. Migrate later with explicit execution-model semantics. |

### Differences that must be resolved explicitly

1. **Entry and exit:** Term Structure opens and unwinds automatically; Hedging waits at entry and leaves the final hedge marked; Combo P&L opens immediately and leaves the final hedge marked. Provide explicit lifecycle choices, with current mappings recorded during migration. Recommended comparable closed-run preset: neutralize at entry, unwind at exit. Historical monitoring may instead start unhedged and leave the position open.
2. **Units:** Term Structure and Hedging use absolute underlying delta; Backtest scales a per-position tolerance. Canonical engine inputs use signed BTC or ETH delta, including quantities. Any normalized display converts once at the app boundary and displays both the convention and effective band. Do not silently change band size when a leg changes.
3. **Validation:** Term Structure rejects tolerance below threshold; Hedging silently adjusts it. Share validation and reject this combination with a visible explanation. Tolerance zero disables the override. Period zero can mean immediate threshold hedging in sustained-breach mode; scheduled checks require a positive period.
4. **Observation versus execution:** Term Structure checks one-minute steps; historical apps use chosen bars. “Immediate” means the next valid observation, not an unseen intrabar price. Historical close observations must carry their actual availability time, rather than treating a bar's start timestamp as its close time.
5. **Incomplete risk:** Combo P&L accepts aggregate delta when any leg has valid delta (`hasCombinedDelta`), and the hedge function converts values with `Number`, which can turn null into zero. Require all live legs' delta before new hedge decisions. Missing risk must remain missing.
6. **Historical causality:** Combo P&L's first hedge uses `combined_delta` from closing Greeks but executes at the first bar's open. Use opening risk for an opening fill, or make the first decision/fill at the close. Record this as a deliberate correction, not an extraction regression.
7. **Accounting:** Keep hedge gross P&L, hedge fees and net P&L distinct. Option entry/exit fees belong to app valuation, not the hedge ledger. Preserve realized/unrealized hedge fields used by Combo P&L through shared average-cost accounting reconciled against the cash ledger.

## Shared policy and behavior

Recommended default policy: **threshold + sustained breach period + tolerance override**. Scheduled checks remain an explicitly selected baseline; they do not determine how finely paths are sampled.

For a zero net-delta target, deviation is signed portfolio delta plus hedge quantity times hedge-unit delta. For the initial release, use a linear spot/perpetual proxy with hedge-unit delta one. The sample contract keeps hedge price distinct from index spot so historical perpetual marks can be used. Do not claim funding, basis or margin realism beyond the app's actual inputs and model.

- Inside or exactly on the threshold: hold; reset the breach timer.
- Outside threshold: start or continue the timer. On an observed return inside, reset it.
- Outside tolerance, when nonzero: rebalance at this observation without waiting for the timer or schedule.
- After the configured sustained period: rebalance if the threshold is still breached.
- A completed rebalance returns net delta to zero and clears the timer.
- A scheduled policy checks against anchored deadlines, hedging only when outside threshold; tolerance still overrides it. Use the first observation at or after a missed deadline, never an invented fill at the missing timestamp. Do not require floating-point exact divisibility.
- Standardize strict `>` comparisons and numerical epsilon in one place. Backtest's existing boundary-touch behavior remains part of its separate intrabar model until intentionally migrated.
- Entry and exit actions are explicit lifecycle commands and have distinct reasons. When options continue to exist after a hedge-only unwind, record actual residual delta; do not hard-code post-fill delta to zero.

Missing price or risk means no new rebalance. Emit a quality flag, preserve the existing hedge, and mark P&L only where the price is valid. A data gap invalidates evidence of a sustained breach: restart the timer at the next valid observation and disclose the gap. Do not carry a timer across an unobserved interval as proof that the breach persisted. Expected observation spacing belongs to the run's data contract, not the hedge period.

These rules follow the current local threshold/tolerance implementations and bot help text. Exact parity with a production bot still requires its authoritative contract, especially entry behavior, target delta, rounding, minimum trade sizes and execution latency. Do not invent those constraints or claim parity from matching control names.

## Proposed code boundary

```text
lib/
  delta-hedging/
    policy.js          # validation, defaults, decisions and timer state
    ledger.js          # quantities, cash, fills, fees, realized/unrealized P&L
    replay.js          # observed-sample replay over policy and ledger
    compare.js         # bounded policy grid over identical observations/paths
    index.d.ts         # public contracts for TypeScript consumers
    *.test.js
  components/
    DeltaHedgeControls.vue
    DeltaHedgeComparison.vue
```

Use ordinary modules and explicit per-run state, matching the repository's existing shared-library approach. No framework dependency in the engine, app-source imports, global mutable settings, provider interfaces or plugin registry. The controls import shared policy defaults/validation; they do not own the simulation or fetch data.

The narrow app input is an observation such as `{ timeSeconds, portfolioDelta, hedgePrice }`, plus run metadata such as asset, observation spacing and execution-model label. App code aggregates legs, applies signed quantities, handles settled legs and converts API shapes before constructing observations. Provider field names such as `iv_close`, `combined_delta` and `index_price_close` stay in adapters.

Keep the streaming and batch paths equivalent: one observation advances an explicit run state; replay folds the same transition over observations. Simulator can call that transition inside its existing worker without allocating a complete path-by-policy-by-step object graph. Retain full fills only for inspected paths; use compact statistics elsewhere.

Use a single fill contract: observed time, execution price, signed trade quantity, resulting hedge quantity, trigger reason, net delta before/after and fee. Ledger state includes cash, hedge quantity, accumulated fees and average entry/realized amounts. Require:

```text
hedgeGrossPnl = cash + hedgeQuantity * currentHedgePrice
hedgeGrossPnl = realizedHedgePnl + unrealizedHedgePnl
hedgeNetPnl   = hedgeGrossPnl - hedgeFees
totalNetPnl   = appPositionPnlAfterItsOwnCosts + hedgeNetPnl
```

Rebalancing creates no immediate gross P&L at the same price; only its fee changes net P&L. Fills belong in a ledger; chart rows are projections. Combo P&L's adapter maps this result to its existing `hedge_PL`, cumulative, realized and unrealized fields without teaching the engine chart naming conventions.

## Shared user experience

One panel owns enablement, Threshold, Tolerance, Breach period, timing selection, hedge cost and entry/exit choices. Use the same labels, help text, validation and scoped visual styles in each app. Default the timing selection to sustained breach; place the scheduled comparison under advanced settings. Use the existing shared select control.

Always show delta units and the effective observation interval. Explain tolerance zero next to the field. If the data or path step is coarser than the requested waiting period, show that the requested timing cannot be resolved; never silently rewrite the selected policy or invent higher-frequency observations. Validate immediately, rerun valid changes with debounce, and preserve the last valid result with a stale-result indication during errors.

Controls are controlled by props/emits; app state remains in the app. Mount the same panel in each app's existing settings area. Keep option trading costs, path count, curve assumptions and instrument selection in their current app-owned controls. Offer a shared comparison table/heatmap, while each app keeps its primary charts.

## Comparing settings and historical events

Add a separate **Compare hedge settings** action: choose threshold/tolerance ranges and a breach period, with period sweeps as a subsequent option. Evaluate only valid combinations. Include unhedged and scheduled baselines using the same lifecycle, prices and cost assumptions.

Historical replay freezes the selected time window, instruments, size, market observations and valuation conventions. Forward comparison freezes the market snapshot and an ordered seed list; every policy receives identical paths and observation times. Store seeds in run state. Only an explicit **New paths** action changes them. Do not consume randomness or change adaptive path substeps as a consequence of hedge settings; Simulator's stop-related adaptive sampling needs a regression test here.

Rank historical settings by net P&L after costs by default. Display gross hedge P&L, fees, turnover, fill count, maximum drawdown, maximum observed absolute net delta and time-weighted absolute delta alongside it. Let users choose a risk constraint or ranking metric. “Best” means best for the chosen objective, path, resolution and assumptions. A result selected on one event is a hindsight result; assess robustness on other historical windows or held-out simulated paths.

Forward results should report expected/median net P&L, loss-tail metrics, drawdown and trading activity across the shared path batch. Show paired net-P&L differences versus baseline, using the same path per pair. Do not rank from independently rerolled paths or from a pointwise median chart alone.

Export the selected policies, lifecycle, fees, asset/size, data window or seeds, observation interval, execution model/version, quality flags and summary metrics. Reuse loaded market inputs when changing hedge settings; no new API requests are needed unless the requested observation resolution changes.

Historical OHLC does not reveal the order or duration of intrabar breaches. Initially label replay as **observed-close execution**. Backtest's delta/gamma intrabar estimates stay a separately labeled approximation, with its assumptions and scenario ranges visible. A V-shaped move inside a coarse bar cannot be faithfully reconstructed just by sharing code. Compare resolutions where finer source data is available.

## Implementation sequence and acceptance gates

1. **Specify and characterize behavior.** Pin policy semantics, lifecycle presets, units and fees; add deterministic fixtures for threshold re-entry, tolerance override, missing observations and a V-shaped path. Capture current app outputs where behavior should be preserved. Separate planned behavior corrections from extraction changes.
2. **Extract policy and ledger; prove reuse in two apps.** Start from Term Structure's pure decision function and tested cash accounting. Migrate Term Structure and the dedicated Hedging app to the same engine, with explicit mappings for their current entry/exit differences. Move the old Term Structure import to a temporary re-export if needed. Gate: existing accounting reconciles, policy traces agree for identical normalized observations, and no copied decision logic remains in these apps.
3. **Ship shared controls and stable comparison inputs.** Replace their duplicate controls, centralize defaults/validation, preserve seeds and market snapshot on policy edits, and keep new-path generation explicit. Gate: shared rendered-control tests and the same sampled spot path before/after changing bands, costs or policy mode.
4. **Migrate Combo P&L.** Isolate historical observation normalization and result projection; remove `applyTimeBasedDeltaHedge` from Vue. Add threshold/tolerance behavior, configurable costs and lifecycle through shared controls. Correct first-fill causality and incomplete portfolio risk handling with explicit fixtures. Gate: chart/exports reconcile; legacy scheduled outputs match except documented corrections; no forward information enters fills.
5. **Integrate Simulator.** Add the shared policy contract to the worker request. Compute aggregate live position delta at observations, including active futures and excluding expired/stopped exposure; add shared hedge net P&L to all path statistics, intermediate drawdowns and inspected paths. Preserve its pricing and path models. Gate: unhedged outputs stay unchanged; fixed market paths are identical across policies; worker and replay produce the same fills on a fixed fixture. Benchmark representative 20,000-path runs and bound comparison grid size.
6. **Add comparisons through the shared runner and view.** Start with historical replay in Combo P&L and the same seed batch in Term Structure, then enable Simulator batches. Add cancellation/progress in existing workers, deterministic ranking and export metadata. Gate: identical policy yields identical output, input changes invalidate cached comparisons, and an end-to-end V-shaped fixture reconciles every fill and fee.
7. **Consider Backtest convergence separately.** Reuse the ledger where its trade model permits, explicitly convert quantity-normalized tolerance, and preserve versioned result/export contracts. Do not add a fake sustained-breach timer to hourly OHLC. Broader intrabar execution unification is optional follow-on work, not a prerequisite for the three requested apps.

This order establishes shared ownership first, then applies it to historical analysis and the more expensive Monte Carlo path loop. Each migration removes its old policy/accounting implementation rather than leaving two active engines behind a switch.

## Verification and tradeoffs

Shared tests should independently reconstruct cash and fees; cover long/short positions, partial reductions, reversals, entry/unwind, tolerance disabled, period zero, exact boundaries, irregular schedules and missing data. Use a V-shaped path where a transient threshold breach resets before the period, a larger breach forces a tolerance hedge, and a reversal changes the next fill. Do not assume tighter bands always improve P&L; assert the actual ledger and ranking for the fixture.

Adapter tests should cover signed ratio quantities, all-leg risk completeness, seconds/year conversions, bar availability timestamps, settlement changes and chart projections. Cross-app parity means identical normalized inputs and model assumptions produce identical fills and hedge P&L; different pricing/data/execution models need not produce identical totals. Shared-control tests cover field semantics, units and errors. Build every consumer and include shared-module tests in CI so a change is checked against all apps.

Focused existing baseline tests passed during this review: Term Structure simulation/position/ensemble, dedicated Hedging accounting, Backtest hedge lifecycle, and Simulator's current TypeScript tests. Combo P&L currently has no test script; its extraction needs a new focused replay/adapter test suite. No live exchange execution or production-bot parity was verified.

The cost is a small shared contract, thin adapters and coordinated regression checks across apps. The benefit is that changing a timer rule, cost calculation or control help text has one owner. Keeping pricing, data acquisition and intrabar inference outside that boundary avoids turning one shared hedge engine into a shared simulation framework. Start with this module and shared controls; a general strategy framework or a full simulator merger has no demonstrated need here.
