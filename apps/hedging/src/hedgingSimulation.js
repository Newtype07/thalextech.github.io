import { createDeltaHedge } from "../../../lib/delta-hedging/index.js";
import { calcGreeks } from "../../../lib/thalex.js";

export const HEDGE_TRADING_COST_RATE = 1.5 / 10000;

const optionDelta = ({ instrument, markPoint, indexPoint }) => {
  const spot = Number(indexPoint?.index_price_close);
  const strike = Number(instrument?.strike);
  const expiration = Number(instrument?.expiration_ts);
  const ts = Number(markPoint?.ts);
  const iv = markPoint?.iv_close == null ? NaN : Number(markPoint.iv_close);
  const optionType =
    instrument?.option_type_normalized === "put" ? "put" : "call";
  if (Number.isFinite(expiration) && Number.isFinite(ts) && expiration <= ts) return 0;
  if (!Number.isFinite(iv) || iv <= 0) return null;
  const greeks = calcGreeks(spot, strike, expiration - ts, iv, optionType);
  return Number.isFinite(greeks.delta) ? greeks.delta : null;
};

const unitDelta = ({ instrument, markPoint, indexPoint }) => {
  if (!instrument) return null;
  if (instrument.type_normalized === "option") {
    return optionDelta({ instrument, markPoint, indexPoint });
  }
  return 1;
};

const optionVegaPnl = ({ instrument, markPoint, indexPoint, amount }) => {
  const spot = Number(indexPoint?.index_price_open);
  const strike = Number(instrument?.strike);
  const expiration = Number(instrument?.expiration_ts);
  const ts = Number(markPoint?.ts);
  const ivOpen = Number(markPoint?.iv_open);
  const ivClose = Number(markPoint?.iv_close);
  const optionType =
    instrument?.option_type_normalized === "put" ? "put" : "call";
  const dIV = ivClose - ivOpen;
  if (!Number.isFinite(dIV)) return null;

  const greeks = calcGreeks(spot, strike, expiration - ts, ivOpen, optionType);
  const vegaPnl = Number(amount) * Number(greeks.vega) * dIV;
  return Number.isFinite(vegaPnl) ? vegaPnl : null;
};

const markClose = (row, fallback = null) => {
  const value = row?.mark_price_close == null ? NaN : Number(row.mark_price_close);
  if (Number.isFinite(value)) return value;
  return Number.isFinite(fallback) ? fallback : null;
};

export function buildHedgingSimulation({
  indexRows,
  targets,
  hedgeRows,
  hedge,
  settings,
}) {
  if (!targets?.length || !hedge) return { rows: [], trades: [] };

  const indexByTs = new Map(
    (indexRows || [])
      .filter((row) => Number.isFinite(row?.ts))
      .map((row) => [row.ts, row]),
  );
  const targetLegs = targets.map(({ instrument, rows: targetRows }) => ({
    instrument,
    rowsByTs: new Map(
      (targetRows || [])
        .filter((row) => Number.isFinite(row?.ts))
        .map((row) => [row.ts, row]),
    ),
  }));
  const hedgeByTs = new Map(
    (hedgeRows || [])
      .filter((row) => Number.isFinite(row?.ts))
      .map((row) => [row.ts, row]),
  );

  const timestamps = Array.from(targetLegs[0].rowsByTs.keys())
    .filter(
      (ts) =>
        indexByTs.has(ts) &&
        hedgeByTs.has(ts) &&
        targetLegs.every((leg) => leg.rowsByTs.has(ts)),
    )
    .sort((a, b) => a - b);

  let initialTargetPrice = null;
  let cumulativeVegaPnl = 0;
  const engine = createDeltaHedge({
    enabled: settings.enabled !== false, threshold: settings.threshold, tolerance: settings.tolerance,
    period: settings.period, timing: settings.timing ?? "timer",
    hedgeBps: (settings.tradingCostRate ?? 0) * 10000,
    entry: settings.entry ?? "neutralize", exit: settings.exit ?? "hold",
  }, { observationSeconds: settings.observationSeconds ?? 0 });
  const rows = [];
  const trades = [];

  for (const ts of timestamps) {
    const indexPoint = indexByTs.get(ts);
    const hedgePoint = hedgeByTs.get(ts);
    const hedgePrice = markClose(hedgePoint, indexPoint.index_price_close);
    const targetPoints = targetLegs.map((leg) => ({
      instrument: leg.instrument,
      markPoint: leg.rowsByTs.get(ts),
    }));
    const targetPrices = targetPoints.map(({ markPoint }) => markClose(markPoint));
    const observedTime = ts + (settings.observationSeconds ?? 0);
    const targetDeltas = targetPoints.map(({ instrument, markPoint }) =>
      unitDelta({ instrument, markPoint: { ...markPoint, ts: observedTime }, indexPoint }),
    );
    const targetPrice = targetPrices.every(Number.isFinite)
      ? targetPrices.reduce((total, price) => total + price, 0)
      : null;
    const targetUnitDelta = targetDeltas.every(Number.isFinite)
      ? targetDeltas.reduce((total, delta) => total + delta, 0)
      : null;
    const hedgeUnitDelta = unitDelta({
      instrument: hedge,
      markPoint: { ...hedgePoint, ts: observedTime },
      indexPoint,
    });

    if (!Number.isFinite(targetUnitDelta) || !Number.isFinite(hedgeUnitDelta)) {
      engine.observe({ time: observedTime, price: hedgePrice, delta: null });
      continue;
    }
    if (!Number.isFinite(hedgePrice) || !Number.isFinite(targetPrice)) continue;
    if (Math.abs(hedgeUnitDelta) < 1e-8) continue;
    if (!Number.isFinite(initialTargetPrice)) initialTargetPrice = targetPrice;

    const targetAmount = Number(settings.targetAmount);
    const safeTargetAmount = Number.isFinite(targetAmount) ? targetAmount : 0;
    const targetDelta = targetUnitDelta * safeTargetAmount;
    const observed = engine.observe({ time: observedTime, price: hedgePrice, delta: targetDelta, hedgeUnitDelta,
      phase: rows.length === 0 ? "entry" : ts === timestamps.at(-1) ? "exit" : "observe" });
    const { position, cash, fees: cumulativeTradingCosts } = observed;
    const tradeAmount = observed.fill?.amount ?? 0;
    if (observed.fill) {
      const fill = observed.fill;
      trades.push({ ...fill, ts, date: new Date(fill.time * 1000),
        trigger: fill.reason === "timer" ? "period" : fill.reason, tradeAmount: fill.amount,
        tradingCost: fill.cost, targetDelta, deviationBefore: fill.netDeltaBefore, hedgePrice });
    }
    const botPnl = observed.grossPnl;
    const optionPnl = Number.isFinite(initialTargetPrice)
      ? safeTargetAmount * (targetPrice - initialTargetPrice)
      : 0;
    const cumulativePnl = optionPnl + botPnl;
    const vegaPnlSteps = targetPoints.map(({ instrument, markPoint }) =>
      optionVegaPnl({
        instrument,
        markPoint,
        indexPoint,
        amount: safeTargetAmount,
      }),
    );
    if (vegaPnlSteps.every(Number.isFinite)) {
      cumulativeVegaPnl += vegaPnlSteps.reduce((total, pnl) => total + pnl, 0);
    }

    rows.push({
      ts,
      date: new Date(observedTime * 1000),
      indexPrice: indexPoint.index_price_close,
      hedgePrice,
      targetPrice,
      targetDelta,
      portfolioDelta: position * hedgeUnitDelta,
      deviation: targetDelta + position * hedgeUnitDelta,
      targetUnitDelta,
      hedgeUnitDelta,
      position,
      cash,
      botPnl,
      hedgePnl: botPnl,
      optionPnl,
      cumulativePnl,
      cumulativeTradingCosts,
      pnlAfterCosts: cumulativePnl - cumulativeTradingCosts,
      vegaPnl: cumulativeVegaPnl,
      tradeAmount,
    });
  }

  return { rows, trades };
}

