const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const finiteOrBlank = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : "";
};

const isoFromSeconds = (timestamp) => {
  const numeric = Number(timestamp);
  if (!Number.isFinite(numeric)) return "";
  const date = new Date(numeric * 1_000);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
};

const weekdayFromSeconds = (timestamp) => {
  const numeric = Number(timestamp);
  if (!Number.isFinite(numeric)) return "";
  const date = new Date(numeric * 1_000);
  return Number.isNaN(date.getTime()) ? "" : WEEKDAYS[date.getUTCDay()];
};

const meanFinite = (values) => {
  const finite = values.map(Number).filter(Number.isFinite);
  return finite.length
    ? finite.reduce((sum, value) => sum + value, 0) / finite.length
    : "";
};

const percentChange = (from, to) => {
  const start = Number(from);
  const end = Number(to);
  return Number.isFinite(start) && start !== 0 && Number.isFinite(end)
    ? ((end / start) - 1) * 100
    : "";
};

const greekValue = (attribution, cycle, key, nestedKey) => {
  const direct = Number(attribution?.[key]);
  if (Number.isFinite(direct)) return direct;
  return finiteOrBlank(cycle?.greekPnl?.[nestedKey]);
};

const legColumns = (leg, legNumber, unit = "btc") => ({
  [`leg_${legNumber}_instrument`]: leg?.instrumentName || "",
  [`leg_${legNumber}_option_type`]: leg?.optionType || "",
  [`leg_${legNumber}_strike_usd`]: finiteOrBlank(leg?.strike),
  [`leg_${legNumber}_expiration_utc`]: isoFromSeconds(leg?.expirationTs),
  [`leg_${legNumber}_quantity_${unit}`]: finiteOrBlank(leg?.quantity),
  [`leg_${legNumber}_entry_mark_usd_per_${unit}`]: finiteOrBlank(leg?.entryPrice),
  [`leg_${legNumber}_exit_mark_usd_per_${unit}`]: finiteOrBlank(leg?.exitPrice),
  [`leg_${legNumber}_mark_change_usd_per_${unit}`]:
    Number.isFinite(Number(leg?.entryPrice)) && Number.isFinite(Number(leg?.exitPrice))
      ? Number(leg.exitPrice) - Number(leg.entryPrice)
      : "",
  [`leg_${legNumber}_entry_iv_decimal`]: finiteOrBlank(leg?.entryImpliedVol),
  [`leg_${legNumber}_exit_iv_decimal`]: finiteOrBlank(leg?.exitImpliedVol),
  [`leg_${legNumber}_iv_change_points`]:
    Number.isFinite(Number(leg?.entryImpliedVol))
      && Number.isFinite(Number(leg?.exitImpliedVol))
      ? (Number(leg.exitImpliedVol) - Number(leg.entryImpliedVol)) * 100
      : "",
  [`leg_${legNumber}_entry_delta`]: finiteOrBlank(leg?.entryDelta),
  [`leg_${legNumber}_exit_delta`]: finiteOrBlank(leg?.exitDelta),
});

export const buildWeeklyPnlExportRows = (
  cycles = [],
  attributionCycles = [],
  { underlying = "BTC" } = {},
) => {
  const unit = String(underlying || "BTC").toLowerCase();
  const closedCycles = cycles.filter((cycle) => cycle?.closed !== false);
  const attributionByCycle = new Map(
    attributionCycles.map((cycle) => [Number(cycle?.cycle), cycle]),
  );
  const maxLegs = Math.max(0, ...closedCycles.map((cycle) => cycle?.legs?.length || 0));

  return closedCycles.map((cycle) => {
    const legs = cycle.legs || [];
    const attribution = attributionByCycle.get(Number(cycle.cycle));
    const entryIv = meanFinite(legs.map((leg) => leg.entryImpliedVol));
    const exitIv = meanFinite(legs.map((leg) => leg.exitImpliedVol));
    const entryIndex = finiteOrBlank(cycle.entryIndexPrice);
    const exitIndex = finiteOrBlank(cycle.exitIndexPrice);
    const gammaPnl = greekValue(attribution, cycle, "gammaPnlUsd", "gamma");
    const thetaPnl = greekValue(attribution, cycle, "thetaPnlUsd", "theta");
    const directGammaThetaPnl = Number(attribution?.gammaThetaPnlUsd);
    const row = {
      cycle: finiteOrBlank(cycle.cycle),
      structure: cycle.structure || "",
      side: cycle.longOption ? "long" : "short",
      entry_time_utc: isoFromSeconds(cycle.entryTs),
      entry_weekday_utc: weekdayFromSeconds(cycle.entryTs),
      exit_time_utc: isoFromSeconds(cycle.exitTs),
      exit_weekday_utc: weekdayFromSeconds(cycle.exitTs),
      expiration_time_utc: isoFromSeconds(cycle.expirationTs),
      holding_period_days: finiteOrBlank(cycle.holdingPeriodDays),
      entry_dte_days: finiteOrBlank(cycle.dteDays),
      exit_at_expiry: cycle.exitAtExpiry === true,
      hedge_enabled: cycle.hedgeEnabled === true,
      hedge_interval_hours: cycle.hedgeEnabled
        ? finiteOrBlank(cycle.hedgeIntervalHours)
        : "",
      sizing_mode:
        cycle.sizingMode === "btc" ? unit : cycle.sizingMode || "",
      requested_notional_usd: finiteOrBlank(cycle.notionalUsd),
      [`configured_${unit}_quantity`]: finiteOrBlank(cycle.btcQuantity),
      investment_usd: finiteOrBlank(cycle.investmentUsd),
      underlying_holding_start_utc: isoFromSeconds(cycle.holdingStartTs),
      underlying_holding_end_utc: isoFromSeconds(cycle.holdingEndTs),
      underlying_holding_start_price_usd: finiteOrBlank(cycle.holdingStartPrice),
      underlying_holding_end_price_usd: finiteOrBlank(cycle.holdingEndPrice),
      [`option_quantity_${unit}`]: finiteOrBlank(cycle.optionQuantityBtc),
      entry_index_price_usd: entryIndex,
      exit_index_price_usd: exitIndex,
      index_move_usd: entryIndex !== "" && exitIndex !== "" ? exitIndex - entryIndex : "",
      index_return_pct: percentChange(entryIndex, exitIndex),
      absolute_index_return_pct: (() => {
        const value = percentChange(entryIndex, exitIndex);
        return value === "" ? "" : Math.abs(value);
      })(),
      [`entry_structure_mark_usd_per_${unit}`]: finiteOrBlank(cycle.entryStraddleMark),
      [`exit_structure_mark_usd_per_${unit}`]: finiteOrBlank(cycle.exitStructureMark),
      [`structure_mark_change_usd_per_${unit}`]:
        Number.isFinite(Number(cycle.entryStraddleMark))
          && Number.isFinite(Number(cycle.exitStructureMark))
          ? Number(cycle.exitStructureMark) - Number(cycle.entryStraddleMark)
          : "",
      mean_entry_iv_decimal: entryIv,
      mean_exit_iv_decimal: exitIv,
      mean_iv_change_points:
        entryIv !== "" && exitIv !== "" ? (exitIv - entryIv) * 100 : "",
      entry_option_market_value_usd: finiteOrBlank(cycle.entryOptionMarketValueUsd),
      exit_option_market_value_usd: finiteOrBlank(cycle.exitOptionMarketValueUsd),
      entry_option_cashflow_usd: finiteOrBlank(cycle.entryOptionCashflowUsd),
      option_pnl_usd: finiteOrBlank(cycle.shortOptionPnlUsd),
      hedge_pnl_usd: finiteOrBlank(cycle.hedgePnlUsd),
      total_pnl_usd: finiteOrBlank(cycle.cyclePnlUsd),
      cycle_return_pct: Number.isFinite(Number(cycle.cycleReturnOnNotional))
        ? Number(cycle.cycleReturnOnNotional) * 100
        : "",
      ending_equity_usd: finiteOrBlank(cycle.endingEquityUsd),
      sampled_realized_vol_decimal: finiteOrBlank(cycle.sampledRealizedVol),
      sampled_realized_variance: finiteOrBlank(cycle.sampledRealizedVariance),
      sampled_return_count: finiteOrBlank(cycle.sampledReturnCount),
      attribution_steps: finiteOrBlank(
        attribution?.attributionSteps ?? cycle.attributionSteps,
      ),
      attribution_interval_hours: finiteOrBlank(
        attribution?.meanAttributionIntervalHours ?? cycle.meanAttributionIntervalHours,
      ),
      net_delta_pnl_usd: greekValue(attribution, cycle, "netDeltaPnlUsd", "netDelta"),
      gamma_pnl_usd: gammaPnl,
      theta_pnl_usd: thetaPnl,
      gamma_theta_pnl_usd: Number.isFinite(directGammaThetaPnl)
        ? directGammaThetaPnl
        : gammaPnl !== "" && thetaPnl !== "" ? gammaPnl + thetaPnl : "",
      vega_pnl_usd: greekValue(attribution, cycle, "vegaPnlUsd", "vega"),
      vanna_pnl_usd: greekValue(attribution, cycle, "vannaPnlUsd", "vanna"),
      volga_pnl_usd: greekValue(attribution, cycle, "volgaPnlUsd", "volga"),
      residual_pnl_usd: greekValue(attribution, cycle, "residualPnlUsd", "residual"),
    };
    for (let index = 0; index < maxLegs; index += 1) {
      Object.assign(row, legColumns(legs[index], index + 1, unit));
    }
    return row;
  });
};

const escapeCsvCell = (value) => {
  const text = value == null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

export const serializeCsv = (rows = []) => {
  if (!rows.length) return "";
  const columns = Object.keys(rows[0]);
  return [
    columns.join(","),
    ...rows.map((row) => columns.map((column) => escapeCsvCell(row[column])).join(",")),
  ].join("\r\n");
};

export const buildWeeklyPnlCsv = (
  cycles = [],
  attributionCycles = [],
  options = {},
) => serializeCsv(buildWeeklyPnlExportRows(cycles, attributionCycles, options));

export const downloadCsv = ({ csv, filename }) => {
  const blob = new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
};
