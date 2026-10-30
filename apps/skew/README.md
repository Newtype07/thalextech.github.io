# Skew by maturity

A fork of Term Structure focused on BTC / ETH call-minus-put implied volatility skew at **15Δ, 25Δ and 35Δ**. The white curve shows the current snapshot; historical skew curves compare the same currently listed expiries at earlier closes. Daily is the default resolution. Positive skew means calls are richer, negative means puts are richer. Units are volatility percentage points (50% call IV minus 55% put IV = −5 vol points).

```sh
npm ci
npm run dev
npm test
VITE_BASE_PATH=/skew/ npm run build
```

`dev` and `build` first regenerate ignored `public/history-cache/` shards from the canonical Parquet files in `../backtest/source-data/thalex`. The root `build_apps.sh` discovers this app automatically; `index.yml` registers its home catalogue entry. No API keys or backend are required. `VITE_THALEX_API_BASE` and `VITE_THALEX_WS_URL` have the same overrides as Term Structure. Local dev/preview use the existing same-origin Vite proxy.

## Calculation

- The delta selector defaults to 25Δ. For each listed maturity, interpolate **variance** separately in same-side Black–Scholes spot delta at +Δ for calls and −Δ for puts. Take the square root of each interpolated variance, then subtract **call IV − put IV**. Rates/carry are zero and the year is 365.25 days; this approximates exchange forward delta.
- Both wings must bracket their target. Missing, invalid or expired inputs omit that expiry’s value; curves connect the available maturities at their original positions. No wing extrapolation, nearest-strike fallback, absolute value, or division by ATM IV is used. Zero and negative skew are valid.
- Historical pairs require the **exact same expiry and completed UTC hour**. Each uses its own hour’s index close and remaining maturity. The window is the latest 2,000 completed hours; missing wings/hours and recent listings reduce coverage. Expiries are equally spaced. This is a listed-contract comparison, not a normalized/constant-tenor series.
- Percentiles rank the current signed skew within that expiry’s paired historical sample, using half weight for ties. A higher percentile means more call-rich skew.

## Data and presentation

The app retains the compact controls, dark styling, current white curve, collapsed expiry details, source tooltips and PNG export from Term Structure. Historical lines replace the scatter. The resolution selector reuses already interpolated history without new requests:

- **Daily** (default): 72 hourly closes covering the last three days.
- **Weekly**: 14 closes, one day apart.
- **Monthly**: 12 closes, one week apart.

The newest target is the latest completed UTC hour at refresh time. Every older target steps backwards from that hour (71 hours, 13 days, or 11 weeks to the oldest respectively). These are point-in-time closes, not daily/weekly averages. Partial snapshots are retained; only timestamps with no observations at all are omitted.

Missing internal maturities are estimated by **linear interpolation of signed skew in actual expiry time**, between the nearest observed maturities at that same snapshot timestamp. Observed sections are solid; any interval touching an interpolated value is dashed. Hover details label estimated values and identify their bracketing maturities. Unbracketed leading/trailing maturities remain unavailable: no end extrapolation or borrowing from other timestamps. Estimates are chart-only, with no estimated wing IVs, and never enter historical percentile samples or the expiry detail table. A lone observed maturity remains visible as a short solid stroke.

Historical curves transition from faded violet (oldest, 12% opacity), through blue, to bright cyan (newest, 85% opacity). The age scale uses the requested schedule, so missing dates do not change the remaining curves’ colors. The current curve stays white and uses the same solid/dashed convention; point markers and value labels appear only at observed live maturities. Hovering or focusing a historical curve highlights all its sections and shows its exact UTC timestamp and maturity values; PNG exports retain the dash patterns and restore age-based fading. Snapshot counts report all curves with observations, including partial ones. Axes fit the current curve and selected historical snapshots, with zero always included. The 2,000-hour input window already covers all twelve weekly targets.

There are no RV, forward-volatility, ATM or individual-wing controls. Detail rows show call IV, put IV, signed skew, percentile and sample count; missing live pairs remain visible as unavailable maturities. Source tooltips report the paired history range and the live quote collection range. PNG exports include titles, units, the current and selected historical curves, with delta, resolution and quote source in the filename. Percentiles always use the full available hourly sample, independently of the displayed resolution.

Live marks use the batched option WebSocket snapshot with REST filling missing instruments. Book-mid selection solves IV from usable books and falls back to each option’s mark. Historical comparisons always use closing **mark** IV. Live collection is sequential rather than an atomic exchange snapshot; quote timestamps are exposed and refresh collects a fresh snapshot.

The cache adapter and REST boundary retain Term Structure’s immutable Parquet source boundaries, session reuse, exact index/IV joins, bounded pagination, cancellation, rate pacing, shared origin budget, cooldown and retries. Backfill fetches **both sides’ full listed strike ladders once**; all three delta selections reuse those same inputs without new requests. A broad ladder is needed because historical delta depends on the observed IV. Only the 2,000-hour index window is fetched; index closes are delta inputs, not an RV overlay. Older gaps in the supplied Parquet history remain as supplied. Data notices disclose partial failures and cache fallback.

## Boundaries

`skew.js` owns paired-wing interpolation, exact historical pairing and signed-skew ranking. `skew-snapshots.js` selects exact timestamp schedules, retains partial snapshots and tags chart-only maturity estimates. `components/skew-curve.js` separates observed solid paths from interpolated dashed paths. `volatility.js` retains the spot-delta and book-price math. `market-data.js`, `history-cache.js`, `live-quotes.js` and `thalex-rest.js` contain the exchange/cache contracts; the app and chart consume normalized quotes and skew points. `App.vue` coordinates controls and loading; `SkewChart.vue` renders and exports.

This is an independent fork: transport/cache code is copied so Term Structure behavior stays isolated. Provider fixes should be applied to both apps until real shared changes justify extracting a common market-data boundary.

[Thalex API documentation](https://thalex.com/docs/) · [Historical data](https://thalex.com/historical-data)
