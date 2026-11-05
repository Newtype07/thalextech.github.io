export function createHedgeLedger() {
  return { position: 0, cash: 0, fees: 0, averageEntry: 0, realized: 0, turnover: 0, tradeCount: 0 };
}

// Mutates only this run's ledger. Fees stay separate from cash and gross P&L.
export function executeHedge(ledger, { time, price, target, reason, netDeltaBefore, hedgeUnitDelta = 1 }, hedgeBps) {
  const amount = target - ledger.position;
  if (Math.abs(amount) < 1e-12) return null;
  if (![time, price, target, amount, hedgeUnitDelta].every(Number.isFinite) || price <= 0)
    throw new Error("A hedge fill needs a valid time, price and quantity.");
  const previous = ledger.position;
  if (previous === 0 || previous * amount > 0) {
    ledger.averageEntry = (Math.abs(previous) * ledger.averageEntry + Math.abs(amount) * price) / Math.abs(target);
  } else {
    const closed = Math.min(Math.abs(previous), Math.abs(amount));
    ledger.realized += closed * Math.sign(previous) * (price - ledger.averageEntry);
    if (target * previous < 0) ledger.averageEntry = price;
    else if (Math.abs(target) < 1e-12) ledger.averageEntry = 0;
  }
  const notional = Math.abs(amount * price);
  const cost = notional * hedgeBps / 10000;
  ledger.cash -= amount * price;
  ledger.position = target;
  ledger.fees += cost;
  ledger.turnover += notional;
  ledger.tradeCount++;
  return { time, price, amount, position: target, reason, cost, netDeltaBefore,
    netDeltaAfter: Number.isFinite(netDeltaBefore) ? netDeltaBefore + amount * hedgeUnitDelta : null };
}

export function markHedge(ledger, price) {
  const grossPnl = Number.isFinite(price) && price > 0 ? ledger.cash + ledger.position * price : null;
  return { grossPnl, netPnl: grossPnl === null ? null : grossPnl - ledger.fees,
    realized: ledger.realized, unrealized: grossPnl === null ? null : grossPnl - ledger.realized };
}
