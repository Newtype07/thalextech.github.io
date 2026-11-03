# Payoff

Build option combinations and view their profit/loss, break-even prices, and current forward. The app is published at `/payoff/` and replaces Combo Greeks.

```sh
npm ci
npm run dev
npm test
VITE_BASE_PATH=/payoff/ npm run build
```

The default view uses current option ticker marks as the entry cost. Refresh reloads those marks and forwards. The position builder still shows initial Greeks; the Greeks tab retains the existing scenario chart.

For a single maturity, profit/loss is signed intrinsic value minus signed current marks. Break-evens are solved exactly between strikes and on the tails, then included in the plotted range. Zero-payoff intervals are displayed as ranges rather than individual crossings. Fees are excluded.

For mixed maturities, the earliest expiry sets the valuation horizon and reference forward, regardless of leg order. Later options retain time value using each leg's current IV, zero rates, and unchanged forward ratios relative to the first maturity. These are scenario assumptions, not guaranteed future prices. The chart labels calendar break-evens as estimates within the displayed price range. Thalex's current mark pricing uses the relevant forward and zero-rate Black–Scholes: [option mark pricing](https://support.thalex.com/hc/en-us/articles/8778518422417-How-is-the-mark-price-of-options-calculated).

`payoff-market.js` isolates ticker normalization and fetching; `payoff.js` owns valuation and break-even calculations; `PayoffChart.vue` renders the result. Missing marks or forwards block the payoff rather than substituting an index price or zero cost. The home card uses an illustrative payoff thumbnail.
