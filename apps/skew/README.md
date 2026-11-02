# Constant-maturity, constant-delta skew

BTC / ETH call-minus-put IV skew at **15Δ, 25Δ and 35Δ**, on fixed **7D, 14D, 30D, 60D, 90D and 180D** tenors. The chart plots skew through time, with one red-to-blue line per tenor. Shorter tenors are red; longer tenors are blue. The default visible lines are 1w, 1m, 3m and 6m, with 2w and 2m available through the legend.

```sh
npm ci
npm run dev
npm test
VITE_BASE_PATH=/skew/ npm run build
```

`dev` and `build` regenerate ignored `public/history-cache/` from the canonical Parquet files in `../backtest/source-data/thalex`. The root build discovers this app automatically and `index.yml` registers its home catalogue entry. No API keys or backend are needed. `VITE_THALEX_API_BASE` and `VITE_THALEX_WS_URL` override the public endpoints; local development/preview use the existing same-origin Vite proxy.

## Calculation

1. At each timestamp and listed expiry, interpolate **variance** separately within the call and put strike ladders to the selected absolute delta (+Δ calls, −Δ puts). Delta uses Black–Scholes spot delta, zero rates/carry and a 365.25-day year, approximating exchange forward delta. Each wing must bracket its target delta.
2. At a fixed tenor τ, find available expiries T₁ ≤ τ ≤ T₂ at **that timestamp**. Interpolate each wing's **total variance**, then recover its IV:

   `a = (τ − T₁) / (T₂ − T₁)`

   `IV_side(τ) = sqrt(((1 − a) × IV_side(T₁)² × T₁ + a × IV_side(T₂)² × T₂) / τ)`

3. Compute **skew = call IV(τ) − put IV(τ)** in volatility points. For example, 50% call IV minus 55% put IV is −5 vol points. An exact maturity node reproduces its input wing IVs.

Times T₁, T₂ and τ are remaining durations, using consistent units. Every historical close recomputes these from its own timestamp; a 30D point always means 30 days ahead of that close. Call and put use the same pair of bracketing expiries, and both wings come from the same historical hour. There is no linear interpolation of signed skew, time borrowing, delta extrapolation or maturity extrapolation. This is a constant-delta smile-slice interpolation, not an arbitrage-free fitted surface.

The chart uses calendar dates on the x-axis and skew on the left y-axis, titled **Call IV − put IV · Volatility points**, with a single zero reference line and no background grid. Each constant tenor has its own time series, with a stable red-to-blue color. The previous cross-sectional snapshot curves, common-tenor-axis filtering and age fading have been removed. Genuine unavailable UTC observations remain explicit gaps; they never cause another tenor or an entire timestamp to be hidden. The detail table retains all six requested tenors, with current wing IVs, skew, actual bracketing expiries, percentile and sample count.

Percentiles rank current constant-tenor skew against **that tenor's** equally spaced observations in the selected history bucket, with half weight for ties. They no longer compare a listed expiry's changing maturity through time.

Total-variance interpolation reference: [QuantLib BlackVarianceCurve implementation](https://github.com/lballabio/QuantLib/blob/master/ql/termstructures/volatility/equityfx/blackvariancecurve.cpp). The same interpolation primitive is applied separately to each fixed-delta wing here.

## Time-series chart and live data

| History bucket | Sampling | Approximate historical points per tenor |
| --- | --- | --- |
| 1 year | Daily UTC closes | 366–367 |
| 6 months | Daily UTC closes | 182–185 |
| 3 months (default) | 6-hourly UTC closes | 357–369 |
| 1 month | 2-hourly UTC closes | 337–373 |
| 1 week | Hourly UTC closes | 169 |

Months and years use calendar boundaries with end-of-month/leap-year clamping, not fixed 30/365-day substitutes. Each schedule includes both endpoints and is aligned to its UTC sampling grid. A fresh live mark may add one additional endpoint.
The newest historical target is the latest completed UTC boundary at the selected sampling interval. No neighbouring hour replaces a missing close. Cubic B-spline curves round each tenor's line for display, softening short-lived peaks within each uninterrupted run while retaining its endpoints. Hover values, calculations and percentiles use the original observations. Real data gaps remain unconnected. Shorter tenors start red, intermediate tenors transition through rose/purple, and the longest tenor is blue. Colors remain stable when a tenor is hidden or the history window changes.

The legend defaults to visible 1w / 1m / 3m / 6m lines; click or keyboard-activate entries to toggle any of the six tenors. Hover over the plot to inspect every visible tenor at the same UTC timestamp; focus the plot and use left/right arrows for keyboard inspection. A live value appends at the end of its tenor's line in the same color, with a small endpoint marker. There is no separate white current-maturity curve.

The **Index price** toggle adds faint neutral scatter points behind the skew lines, using a separately labelled USD scale on the right. It defaults off. Closing prices align to the selected history grid, use the same index inputs as delta calculations, appear in inspection tooltips, and are included in PNG exports when enabled. The cache includes sampled index closes across the full year, plus recent raw closes; toggling the overlay makes no additional API requests.

Live marks use one batched option WebSocket snapshot, with REST filling missing names. Only live mark IV is used; the inherited book-mid/fallback selector and its IV solver have been removed. Historical points also use closing **mark** IV. The tooltip labels live versus historical data. Live delta/maturity calculations share the refresh reference time, with actual sequential quote collection times in the source tooltip. Refresh collects a fresh snapshot. Switching delta reuses the prepared series and recent quotes, fetching additional delta brackets when needed. Switching history buckets reuses stored closes and only fetches newly needed tail inputs.

PNG exports include the date axis, left-side skew scale and y-axis title, title, selected tenor lines and legend. Crosshairs, inspection tooltips and the legend instruction are omitted.

## Historical expiry universe and backfill

Fixed-tenor history includes contracts that were alive at a historical timestamp but are expired today. The version-3 `thalex-skew-history` cache prepares a full calendar year directly from the canonical backtest Parquet files. Build time uses the union of the five sampling grids, computes all three delta surfaces using the same domain functions as runtime, and writes compact constant-tenor series. The browser decodes those small series before loading recent raw inputs; it does not download or recalculate a year of hourly strike ladders.

Only one recent week of raw option inputs is packaged for incremental supplementation. The build prunes obsolete content-hashed files in its generated output. Prepared history and API-derived observations merge by exact timestamp and tenor, with successful API additions replacing matching keys without dropping older history. Estimates and source conventions do not differ between the build and runtime models.

The adapter discovers contracts in the uncovered Parquet-to-present tail through `public/all_instruments`, paginating intervals no longer than three days. It merges those names with current listings and the recent cache. Both option wings and exact matching index closes are fetched only at the selected targets, bounded by listing/expiry times and immutable actual Parquet coverage. Daily buckets use native `1d` candles; 2/6-hourly buckets use `1h` request envelopes and reuse returned closes, since the API has no native 2h/6h resolution. Daily candle timestamps are normalized to the exact same UTC close as hourly inputs. Empty checks are remembered per resolution so a daily no-data response cannot suppress a later hourly check.

The incremental fetch selects only the listed expiries surrounding the requested constant tenors and the strikes surrounding each wing's selected delta. Cached or live IVs seed the search; historical calculations always use actual quotes from the matching close. Observed deltas determine whether neighbouring strikes are needed. Confirmed empty responses expand the search; failed requests remain retryable on refresh. This avoids requesting every strike in every expiry while retaining the same interpolation inputs as a full ladder.

Prepared Parquet series appear first, independently of live marks. Recent historical hours publish progressively once their required quote brackets are resolved, rather than displaying intermediate partial ladders. The chart labels the pending recent region while loading, and its footer reports loaded versus expected observations. The adaptive backfill uses two concurrent requests through the shared exchange transport. Skew and Term Structure share hard exchange ceilings of a 100-request burst per rolling second and 10/second thereafter. The public transport uses a stricter four requests/second with no initial burst, because live checks received Cloudflare 1015 responses at both 10/s and 5/s. WebSocket subscriptions, REST calls and retries all consume that same budget. Refresh/reload does not reset burst credit. Rate-limit errors, including errors inside HTTP 200 JSON responses, pause the whole queue and drain remaining burst credit.

Successful universe discovery and raw additions remain in memory for the session, enabling bucket revisits without repeat history calls. No IndexedDB or localStorage history persistence is used. Cache/discovery/API failures are disclosed; unavailable static history limits API fallback to the latest week to avoid an accidental year-wide option backfill. Older gaps inside supplied Parquet history remain as supplied. REST retains paced shared-origin limits, bounded concurrency, deduplication, cancellation, retries and adaptive cooldown. Index closes are delta inputs; there is no RV or forward-vol overlay.

[Official Thalex endpoint schema](https://thalex.com/docs/api.yaml) · [Historical data](https://thalex.com/historical-data)

## Boundaries

- `skew.js`: per-expiry constant-delta wing interpolation and signed-skew ranking.
- `constant-maturity.js`: separate-wing total-variance interpolation, constant-tenor history.
- `skew-history-plan.js`: pure selection of missing historical delta/maturity bracket inputs, including expansion past confirmed empty quotes.
- `skew-timeseries.js`: calendar lookback/sampling plans, prepared/API merge, and chronological per-tenor series with explicit missing observations and live endpoints.
- `history-cache.js`, `market-data.js`, `live-quotes.js`, `thalex-rest.js`: cache/exchange contracts and historical expiry discovery.
- `App.vue`: loading and control orchestration. `SkewChart.vue` and `components/skew-curve.js`: time-series rendering, stable tenor colors, hover inspection, legend toggles and export.

Chart calculations and history planning remain independent from Term Structure. Both apps re-export the same `lib/thalex-rest.js` and `lib/thalex-rate-limit.js` transport, keeping endpoint selection, request accounting, cooldown and retry policy together. The budget coordinates same-origin tabs through Web Locks and localStorage when available; requests from other origins or processes remain outside that browser budget.
