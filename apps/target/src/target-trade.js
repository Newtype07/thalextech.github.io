// Pure rule: no provider contracts or UI state cross this boundary.
export function optionSide(target, spot) {
  if (![target, spot].every(value => Number.isFinite(value) && value > 0)) return null;
  return target < spot ? 'put' : 'call';
}
export function rankOptions(options, target, spot) {
  const side = optionSide(target, spot);
  if (!side) return [];
  const chain = options.filter(option => option.side === side
    && Number.isFinite(option.strike) && option.strike > 0
    && !(Number.isFinite(option.bid) && Number.isFinite(option.premium) && option.premium > 0 && option.bid > option.premium));
  const direction = side === 'call' ? 1 : -1;
  const intrinsic = strike => Math.max(direction * (target - strike), 0);
  const candidates = [];
  for (const long of chain) {
    if (!(Number.isFinite(long.premium) && long.premium > 0)
      || (long.amount !== undefined && !(long.amount > 0))) continue;
    const longPayout = intrinsic(long.strike);
    if (longPayout <= 0) continue;
    candidates.push({ ...long, type: 'single', longPremium: long.premium,
      payout: longPayout, multiple: longPayout / long.premium, required: long.premium / longPayout });
    for (const short of chain) {
      if (short.expiry !== long.expiry || direction * (short.strike - long.strike) <= 0
        || !(Number.isFinite(short.bid) && short.bid > 0 && short.bidAmount > 0)) continue;
      const debit = long.premium - short.bid;
      const payout = longPayout - intrinsic(short.strike);
      if (!(debit > 0 && payout > 0)) continue;
      candidates.push({ ...long, type: 'vertical',
        name: `${long.name}/${short.name}`, longName: long.name, shortName: short.name,
        shortStrike: short.strike, longPremium: long.premium, shortPremium: short.bid,
        premium: debit, amount: Math.min(long.amount ?? Infinity, short.bidAmount),
        payout, maxPayout: Math.abs(short.strike - long.strike),
        multiple: payout / debit, required: debit / payout });
    }
  }
  return candidates.sort((a, b) => {
    const difference = b.multiple - a.multiple;
    if (Math.abs(difference) > 1e-10 * Math.max(1, a.multiple, b.multiple)) return difference;
    // Keep the simpler trade unless the extra leg improves the target multiple.
    return (a.type === 'vertical') - (b.type === 'vertical')
      || a.strike - b.strike || (a.shortStrike ?? 0) - (b.shortStrike ?? 0);
  });
}
export function historicalFrequency(candles, move, horizonSeconds) {
  // The source is hourly. Round the horizon to its nearest observable hour.
  const hours = Math.max(1, Math.round(horizonSeconds / 3600));
  if (!Number.isFinite(move) || move <= -1 || !Number.isFinite(horizonSeconds) || horizonSeconds <= 0) return null;
  const rows = [...new Map(candles.map(c => [c[0], c])).values()].sort((a,b)=>a[0]-b[0]);
  const byTime = new Map(rows.map((r,i)=>[r[0],i]));
  const gaps = rows.map((r,i) => i && r[0] - rows[i-1][0] !== 3600 ? 1 : 0);
  for (let i=1;i<gaps.length;i++) gaps[i]+=gaps[i-1];
  // Sliding extrema cover the hours AFTER each entry close. Including the
  // entry candle would count touches that occurred before the trade began.
  const highs = [], lows = [], rollingHigh = [], rollingLow = [];
  let highHead = 0, lowHead = 0;
  for (let end = 0; end < rows.length; end++) {
    while (highs.length > highHead && rows[highs.at(-1)][2] <= rows[end][2]) highs.pop();
    while (lows.length > lowHead && rows[lows.at(-1)][3] >= rows[end][3]) lows.pop();
    highs.push(end);
    lows.push(end);
    while (highs[highHead] <= end - hours) highHead++;
    while (lows[lowHead] <= end - hours) lowHead++;
    rollingHigh[end] = rows[highs[highHead]][2];
    rollingLow[end] = rows[lows[lowHead]][3];
  }
  let hits=0, touchHits=0, total=0;
  for (let i=0;i<rows.length;i++) {
    const j=byTime.get(rows[i][0]+hours*3600);
    if (j==null || gaps[j]!==gaps[i] || !(rows[i][4]>0) || !(rows[j][4]>0)) continue;
    const change=rows[j][4]/rows[i][4]-1;
    total++;
    if (move>=0 ? change>=move-1e-12 : change<=move+1e-12) hits++;
    const extreme = move >= 0 ? rollingHigh[j] : rollingLow[j];
    const touched = move >= 0 ? extreme/rows[i][4]-1 >= move-1e-12 : extreme/rows[i][4]-1 <= move+1e-12;
    if (move === 0 || touched) touchHits++;
  }
  return { hits, touchHits, total, frequency: total ? hits/total : null,
    touchFrequency: total ? touchHits/total : null, hours };
}
export function verdict(trade, history) {
  if (!trade || history?.frequency == null) return 'UNAVAILABLE';
  if (history.frequency > trade.required) return 'BUY';
  if (history.frequency < trade.required && history.touchFrequency > trade.required) return 'MAYBE';
  return 'PASS';
}
export function aggregateCandles(rows, seconds=86400, anchor=0) {
  const buckets=new Map();
  for (const r of rows) {
    const ts=Math.floor((r[0]-anchor)/seconds)*seconds+anchor, c=buckets.get(ts);
    if (c) { c[2]=Math.max(c[2],r[2]); c[3]=Math.min(c[3],r[3]); c[4]=r[4]; }
    else buckets.set(ts,[ts,...r.slice(1)]);
  }
  return [...buckets.values()];
}
