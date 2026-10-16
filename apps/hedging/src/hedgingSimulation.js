import { calcGreeks } from "../../../lib/thalex.js";

export const HEDGE_TRADING_COST_RATE = 1.5 / 10000;

const optionDelta = ({ instrument, markPoint, indexPoint }) => {
  const spot = Number(indexPoint?.index_price_close);
  const strike = Number(instrument?.strike);
  const expiration = Number(instrument?.expiration_ts);
  const ts = Number(markPoint?.ts);
  const iv = Number(markPoint?.iv_close);
  const optionType =
    instrument?.option_type_normalized === "put" ? "put" : "call";
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
  const value = Number(row?.mark_price_close);
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

  let position = 0;
  let cash = 0;
  let initialTargetPrice = null;
  let cumulativeVegaPnl = 0;
  let cumulativeTradingCosts = 0;
  const tradingCostRate = settings.tradingCostRate ?? 0;

  let breachStartTs = null;
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
    const targetDeltas = targetPoints.map(({ instrument, markPoint }) =>
      unitDelta({ instrument, markPoint, indexPoint }),
    );
    const targetPrice = targetPrices.every(Number.isFinite)
      ? targetPrices.reduce((total, price) => total + price, 0)
      : null;
    const targetUnitDelta = targetDeltas.every(Number.isFinite)
      ? targetDeltas.reduce((total, delta) => total + delta, 0)
      : null;
    const hedgeUnitDelta = unitDelta({
      instrument: hedge,
      markPoint: hedgePoint,
      indexPoint,
    });

    if (!Number.isFinite(targetUnitDelta) || !Number.isFinite(hedgeUnitDelta)) {
      continue;
    }
    if (!Number.isFinite(hedgePrice) || !Number.isFinite(targetPrice)) continue;
    if (Math.abs(hedgeUnitDelta) < 1e-8) continue;
    if (!Number.isFinite(initialTargetPrice)) initialTargetPrice = targetPrice;

    const targetAmount = Number(settings.targetAmount);
    const safeTargetAmount = Number.isFinite(targetAmount) ? targetAmount : 0;
    const targetDelta = targetUnitDelta * safeTargetAmount;
    const hedgeDeltaBefore = position * hedgeUnitDelta;
    const deviationBefore = targetDelta + hedgeDeltaBefore;
    const absDeviation = Math.abs(deviationBefore);
    const thresholdInput = Number(settings.threshold);
    const toleranceInput = Number(settings.tolerance);
    const periodInput = Number(settings.period);
    const threshold = Number.isFinite(thresholdInput)
      ? Math.max(0, thresholdInput)
      : 0;
    const tolerance =
      Number.isFinite(toleranceInput) && toleranceInput > 0
        ? Math.max(threshold, toleranceInput)
        : 0;
    const period = Number.isFinite(periodInput) ? Math.max(0, periodInput) : 0;

    const outsideTolerance = tolerance > 0 && absDeviation > tolerance;
    const outsideThreshold = absDeviation > threshold;
    let trigger = null;

    if (outsideTolerance) {
      trigger = "tolerance";
    } else if (outsideThreshold) {
      if (breachStartTs == null) breachStartTs = ts;
      if (ts - breachStartTs >= period) trigger = "period";
    } else {
      breachStartTs = null;
    }

    let tradeAmount = 0;
    let tradingCost = 0;
    if (trigger) {
      const nextPosition = -targetDelta / hedgeUnitDelta;
      tradeAmount = nextPosition - position;
      tradingCost = Math.abs(tradeAmount * hedgePrice) * tradingCostRate;
      cumulativeTradingCosts += tradingCost;
      cash -= tradeAmount * hedgePrice;
      position = nextPosition;
      breachStartTs = null;
      trades.push({
        ts,
        date: new Date(ts * 1000),
        trigger,
        tradeAmount,
        tradingCost,
        position,
        targetDelta,
        deviationBefore,
        hedgePrice,
      });
    }

    const botPnl = cash + position * hedgePrice;
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
      date: new Date(ts * 1000),
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

