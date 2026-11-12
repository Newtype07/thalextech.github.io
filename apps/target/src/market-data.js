import { requestThalex as request } from '../../../lib/thalex-rest.js';
// The endpoint returns completed bars and may truncate a response to count.
// Page backward to the archive boundary; never interpolate missing hours.
export async function loadHourlyTail(from, to, signal, requestImpl = request) {
  const rows = new Map();
  let end = to;
  while (end >= from) {
    const result = await requestImpl('index_price_historical_data', {
      index_name: 'BTCUSD', resolution: '1h', from, to: end, count: 1000,
    }, signal);
    if (result.index === undefined && (result.no_data === true || Object.keys(result).length === 0)) break;
    if (!Array.isArray(result.index)) throw new Error('Invalid hourly index history.');
    if (!result.index.length) break;
    const timestamps = result.index.map(row => row[0]).filter(Number.isFinite);
    if (!timestamps.length) throw new Error('Hourly index history has no timestamps.');
    for (const row of result.index) if (row[0] >= from && row[0] <= to) rows.set(row[0], row);
    const oldest = Math.min(...timestamps);
    if (oldest <= from) break;
    if (oldest - 1 >= end) throw new Error('Hourly index history pagination did not advance.');
    end = oldest - 1;
  }
  return [...rows.values()].sort((a,b) => a[0]-b[0]);
}
export async function loadMarket(signal, { from = Date.now()/1000 - 7*86400 } = {}) {
  const to = Math.floor(Date.now()/1000), hour = Math.floor(to/3600)*3600;
  const [instruments, hourly, minuteResult] = await Promise.all([
    request('instruments', {}, signal),
    loadHourlyTail(from, to, signal),
    request('index_price_historical_data', {
      index_name: 'BTCUSD', resolution: '1m', from: hour, to, count: 60,
    }, signal),
  ]);
  const minutes = minuteResult.index ?? (minuteResult.no_data === true || Object.keys(minuteResult).length === 0 ? [] : null);
  if (!Array.isArray(minutes)) throw new Error('Invalid current-hour index history.');
  // Fetch this last: the active candle and spot label share this exact price,
  // observed after the historical OHLC request, rather than separate clocks.
  const index = await request('index', { underlying: 'BTCUSD' }, signal);
  if (!Array.isArray(instruments) || !Number.isFinite(index.price) || index.price<=0
    || !Number.isFinite(index.timestamp)) throw new Error('Invalid BTC market response.');
  const now = Date.now()/1000;
  return { spot: index.price, asOf: index.timestamp, hourly, minutes,
    options: instruments.filter(i=>i.type==='option' && i.underlying==='BTCUSD'
      && ['call','put'].includes(i.option_type) && i.expiration_timestamp>now)
      .map(i=>({name:i.instrument_name,strike:i.strike_price,expiry:i.expiration_timestamp,side:i.option_type})) };
}
export async function loadPremiums(options, signal, onProgress=()=>{}) {
  let done=0;
  const results=await Promise.allSettled(options.map(async option=> {
    const ticker=await request('ticker',{instrument_name:option.name},signal);
    if (!Number.isFinite(ticker.mark_timestamp) || Math.abs(Date.now()/1000-ticker.mark_timestamp)>120) throw new Error('Stale quote');
    onProgress(++done,options.length);
    return {...option,premium:ticker.best_ask_price,amount:ticker.best_ask_amount,ts:ticker.mark_timestamp};
  }));
  signal.throwIfAborted();
  const available=results.filter(r=>r.status==='fulfilled').map(r=>r.value).filter(c=>Number.isFinite(c.premium)&&c.premium>0&&c.amount>0);
  return {quotes:available,excluded:options.length-available.length};
}
