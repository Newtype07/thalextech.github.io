# Payoff

Build option combinations and view their profit/loss, break-even prices, and implied probability of profit. The app is published at `/payoff/` and replaces Combo Greeks.

```sh
npm ci
npm run dev
npm test
VITE_BASE_PATH=/payoff/ npm run build
```

The default view uses current option ticker marks as the entry cost. Refresh reloads those marks and forwards. The position builder still shows initial Greeks. One row of compact rounded-square selectors starts with a payoff-line icon, followed by Delta, Gamma, Theta, Vega, Vanna, Charm and Volga; there is no separate Payoff/Greeks switch. The time slider appears for Greek scenarios. Switching between Greeks reuses the loaded scenario data.

The summary shows Net Debit/Credit, a centered **P(win)**, and Max Return before fees, including in PNG exports. Same-expiry limits are calculated from payoff values at zero and each strike plus the unbounded call tail; they are not limited to the visible chart range. Mixed-expiry extrema remain estimates over the displayed range. The chart uses teal profits and pink losses on black with no grid lines. The forward marker is hidden in both the app and exports.

P(win) is the implied probability of strictly positive combined P&L in a forward-based lognormal model, using time to the first expiry and that expiry's current nearest-strike ATM IV. Call and put IVs are averaged in variance when both are available; one valid side suffices. Selected quotes are reused, with at most two additional ATM ticker requests. Missing ATM data displays a dash without substituting the selected legs' wing IVs or blocking the payoff. Same-expiry probabilities integrate all profitable intervals, including tails and disjoint regions, with zero-payoff regions excluded. For mixed maturities, P(win) is an estimate at the first expiry under the chart's unchanged-IV and relative-forward assumptions. Its root scan extends across nine standard deviations independently of the viewport; narrow features include strikes and chart crossings. Hovering P(win) explains the model. These are risk-neutral model probabilities, not forecasts of real-world win rates.

For a single maturity, profit/loss is signed intrinsic value minus signed current marks. Break-evens are solved exactly between strikes and on the tails, then included in the plotted range. Zero-payoff intervals are displayed as ranges rather than individual crossings. Fees are excluded.

For mixed maturities, the earliest expiry sets the valuation horizon and reference forward, regardless of leg order. Later options retain time value using each leg's current IV, zero rates, and unchanged forward ratios relative to the first maturity. These are scenario assumptions, not guaranteed future prices. The chart labels calendar break-evens as estimates within the displayed price range. Thalex's current mark pricing uses the relevant forward and zero-rate Black–Scholes: [option mark pricing](https://support.thalex.com/hc/en-us/articles/8778518422417-How-is-the-mark-price-of-options-calculated).

`payoff-market.js` isolates ticker normalization and fetching; `payoff.js` owns valuation and break-even calculations; `PayoffChart.vue` renders the result. Missing marks or forwards block the payoff rather than substituting an index price or zero cost. The home card uses an illustrative payoff thumbnail.

The payoff chart shares the Greeks chart’s 1800×900 coordinate system, plot margins and type scale. Its compact summary, smaller break-even labels, restrained area shading and line weights keep the payoff view consistent with the Greek scenarios while preserving the teal/pink gain and loss colours.

Four thin white curves show modelled P&L now and at 25%, 50% and 75% elapsed to the first expiry. They use the same underlying-price grid and original signed entry cost as the coloured expiry curve, with each leg's current IV and relative forward unchanged. These are time-value scenarios, not predictions of future marks. The right-side legend identifies each slice; hover selects the nearest curve and shows its time and P&L. Axes include all slices. If any IV is missing, time curves are omitted with a short explanation while a valid intrinsic expiry payoff remains available.
