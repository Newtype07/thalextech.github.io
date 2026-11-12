// Pure rule: no provider contracts or UI state cross this boundary.
export function optionSide(target, spot) {
  if (![target, spot].every(value => Number.isFinite(value) && value > 0)) return null;
  return target < spot ? 'put' : 'call';
}
export function rankOptions(options, target, spot) {
  const side = optionSide(target, spot);
  if (!side) return [];
  return options.filter(option => option.side === side && Number.isFinite(option.strike) && option.strike > 0
      && Number.isFinite(option.premium) && option.premium > 0)
    .map(option => {
      const payout = side === 'put' ? option.strike - target : target - option.strike;
      return { ...option, payout, multiple: payout / option.premium,
        required: payout > 0 ? option.premium / payout : Infinity };
    })
    .filter(option => option.payout > 0)
    .sort((a,b) => b.multiple - a.multiple || a.strike - b.strike);
}
export function historicalFrequency(candles, move, horizonSeconds) {
  // The source is hourly. Round the horizon to its nearest observable hour.
  const hours = Math.max(1, Math.round(horizonSeconds / 3600));
  if (!Number.isFinite(move) || move <= -1 || !Number.isFinite(horizonSeconds) || horizonSeconds <= 0) return null;
  const rows = [...new Map(candles.map(c => [c[0], c])).values()].sort((a,b)=>a[0]-b[0]);
  const byTime = new Map(rows.map((r,i)=>[r[0],i]));
  const gaps = rows.map((r,i) => i && r[0] - rows[i-1][0] !== 3600 ? 1 : 0);
  for (let i=1;i<gaps.length;i++) gaps[i]+=gaps[i-1];
  let hits=0, total=0;
  for (let i=0;i<rows.length;i++) {
    const j=byTime.get(rows[i][0]+hours*3600);
    if (j==null || gaps[j]!==gaps[i] || !(rows[i][4]>0) || !(rows[j][4]>0)) continue;
    const change=rows[j][4]/rows[i][4]-1;
    total++;
    if (move>=0 ? change>=move-1e-12 : change<=move+1e-12) hits++;
  }
  return { hits, total, frequency: total ? hits/total : null, hours };
}
export function verdict(trade, history) {
  if (!trade || history?.frequency == null) return 'UNAVAILABLE';
  return history.frequency > trade.required ? 'BUY' : 'PASS';
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
