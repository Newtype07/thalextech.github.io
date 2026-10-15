export const buildDecisionTimes = (plan, config) => {
  const times = new Set();
  const intervalMs =
    Math.max(1, Math.min(24, Math.round(config.hedgeIntervalHours))) *
    3_600_000;
  for (
    let hedgeMs = plan.entryTime.getTime();
    hedgeMs < plan.exitTime.getTime();
    hedgeMs += intervalMs
  ) {
    const hedgeTime = new Date(hedgeMs);
    if (hedgeTime < plan.exitTime) times.add(hedgeTime.getTime());
  }
  times.add(plan.exitTime.getTime());
  return [...times].sort((a, b) => a - b).map((ms) => new Date(ms));
};

export const advanceHedgePosition = ({
  quantity,
  previousPrice,
  pnlUsd,
  indexPrice,
  targetQuantity,
}) => {
  const nextPnlUsd =
    previousPrice != null && Number.isFinite(quantity) && Number.isFinite(indexPrice)
      ? pnlUsd + quantity * (indexPrice - previousPrice)
      : pnlUsd;
  const tradeQuantity = targetQuantity - quantity;
  return {
    quantity: targetQuantity,
    previousPrice: indexPrice,
    pnlUsd: nextPnlUsd,
    trade:
      Math.abs(tradeQuantity) > 1e-10
        ? {
            side: tradeQuantity > 0 ? "buy" : "sell",
            quantity: Math.abs(tradeQuantity),
            price: indexPrice,
          }
        : null,
  };
};

// Freeze opening delta and gamma for one bar. The sign of gamma determines
// whether a buy or sell trigger is above the open; price direction does not.
export const toleranceTriggers = ({ open, delta, gamma, quantity, tolerance, high, low }) => {
  if (![open, delta, gamma, quantity, tolerance, high, low].every(Number.isFinite)
    || open <= 0 || low <= 0 || low > open || high < open || tolerance <= 0
    || Math.abs(gamma) < 1e-14) return [];
  const netDelta = delta + quantity;
  return [-tolerance, tolerance].map((boundary) => ({
    price: open + (boundary - netDelta) / gamma,
    netDelta: boundary,
    targetQuantity: quantity - boundary,
  })).filter(({ price }) => Number.isFinite(price) && price >= low && price <= high);
};

// Opening delta/gamma define intrabar limits. The primary replay assumes the
// nearest touched limit first, then a reversal toward the opposite extreme.
// An opening fill counts toward the maximum of two hedge trades per hour.
export const createHedgeReplay = ({ plan, config, intrabarPath = null }) => {
  const toleranceMode = config.hedgeMode === "tolerance";
  const intrabarMode = toleranceMode;
  const scheduled = new Set(toleranceMode ? [] : buildDecisionTimes(plan, config).map(date => date.getTime() / 1000));
  const tolerance = config.hedgeDeltaTolerance * plan.optionQuantityBtc;
  let state = { quantity: 0, previousPrice: null, pnlUsd: 0 };
  let previousTs = null;
  return (row, risk = {}) => {
    const isEntry = row.ts === plan.entryTs;
    const isExit = row.ts === plan.exitTs;
    const trades = [];
    const validPrice = Number.isFinite(row.indexPrice) && row.indexPrice > 0;
    const dataGap = previousTs != null && toleranceMode && row.ts - previousTs !== 3_600;
    previousTs = row.ts;
    if (!validPrice) return {
      hedgePnlUsd: state.pnlUsd, hedgeQuantity: state.quantity,
      hedgeTrades: trades, hedgeTrade: null, invalidPrice: true, dataGap,
    };
    const execute = (price, targetQuantity, reason, netDeltaBefore) => {
      state = advanceHedgePosition({ ...state, indexPrice: price, targetQuantity });
      if (state.trade) trades.push({
        ...state.trade, ts: row.ts, reason, intrabar: reason === "tolerance_trigger",
        netDeltaBefore, netDeltaAfter: Number.isFinite(netDeltaBefore) ? 0 : null,
      });
    };
    execute(row.indexPrice, state.quantity, "mark");
    if (plan.underlyingQuantity > 0) {
      execute(row.indexPrice, isExit ? 0 : plan.underlyingQuantity, isExit ? "exit" : "entry");
    } else if (config.hedgeEnabled) {
      const netDelta = risk.delta + state.quantity;
      if (isExit) execute(row.indexPrice, 0, "exit", netDelta);
      else if (Number.isFinite(risk.delta)
        && (toleranceMode
          ? isEntry || Math.abs(netDelta) >= tolerance
          : scheduled.has(row.ts))) {
        execute(row.indexPrice, -risk.delta, isEntry ? "entry" : toleranceMode ? "tolerance_open" : "scheduled", netDelta);
      }
    }
    const marked = { hedgePnlUsd: state.pnlUsd, hedgeQuantity: state.quantity };
    let ambiguous = false;
    const missingRange = intrabarMode && config.hedgeEnabled && !isExit
      && !([row.high, row.low].every(Number.isFinite)
        && row.low > 0 && row.low <= row.indexPrice && row.high >= row.indexPrice);
    if (intrabarMode && config.hedgeEnabled && !isExit && !(plan.underlyingQuantity > 0)
      && row.ts + 3_600 <= plan.exitTs && !missingRange) {
      const triggers = toleranceTriggers({
        open: row.indexPrice, high: row.high, low: row.low,
        delta: risk.delta, gamma: risk.gamma, quantity: state.quantity, tolerance,
      });
      ambiguous = triggers.length > 1;
      if (triggers.length && trades.length < 2) {
        const nearest = [...triggers].sort((a, b) =>
          Math.abs(a.price - row.indexPrice) - Math.abs(b.price - row.indexPrice)
            || a.price - b.price);
        const firstDirection = intrabarPath === "high_first" ? 1 : -1;
        const trigger = intrabarPath
          ? triggers.find(trigger => (trigger.price - row.indexPrice) * firstDirection >= 0) || nearest[0]
          : nearest[0];
        execute(trigger.price, trigger.targetQuantity, "tolerance_trigger", trigger.netDelta);
        // Keep opening risk fixed, but include the newly flattened hedge when
        // solving the next boundary. Only the opposite path leg can fill again.
        if (ambiguous && trades.length < 2) {
          const extreme = trigger.price > row.indexPrice ? row.low : row.high;
          const direction = Math.sign(extreme - trigger.price);
          const next = toleranceTriggers({
            open: row.indexPrice, high: row.high, low: row.low,
            delta: risk.delta, gamma: risk.gamma, quantity: state.quantity, tolerance,
          }).filter(candidate => (candidate.price - trigger.price) * direction > 1e-10
            && (extreme - candidate.price) * direction >= -1e-10)
            .sort((a, b) => Math.abs(a.price - trigger.price) - Math.abs(b.price - trigger.price))[0];
          if (next) execute(next.price, next.targetQuantity, "tolerance_trigger", next.netDelta);
        }
      }
    }
    return {
      ...marked, intervalEndHedgeQuantity: state.quantity,
      hedgeTrades: trades, hedgeTrade: trades[0] || null,
      ambiguousHedgeBar: ambiguous, missingHedgeRange: missingRange, dataGap,
      missingHedgeRisk: toleranceMode && config.hedgeEnabled && !isExit
        && !(intrabarMode ? [risk.delta, risk.gamma] : [risk.delta]).every(Number.isFinite),
    };
  };
};
