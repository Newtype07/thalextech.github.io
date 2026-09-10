# Backtest app

## Data directories

- `source-data/thalex` contains the canonical, Git-tracked Parquet history.
- `public/runtime-data/thalex` contains generated JSON artifacts served to the browser.
- `dist/runtime-data/thalex` is disposable production-build output.

Run `npm run build:data` after adding or replacing source Parquet files. Both
`npm run dev` and `npm run build` also generate the runtime artifacts first.

## Covered call

Select **Covered call** under Instrument → Structure. Each cycle sells a call
selected by the strike-delta setting and holds an equal quantity of the underlying.
Sizing, maturity, entry, and exit settings apply as for the other strategies.
The underlying is held without delta rebalancing and closed at the cycle exit;
long-option and hedge-frequency controls do not apply.

Total P&L includes both the call and the underlying price change. The existing
hedge P&L and position fields carry the fixed underlying leg, including in daily
attribution and cycle detail. Simulated distributions include that leg as well.
This models index-price exposure without financing, custody, or trading costs.
