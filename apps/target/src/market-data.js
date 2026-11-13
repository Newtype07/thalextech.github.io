import { requestThalex as request } from '../../../lib/thalex-rest.js';
import { nearSpotOptions, normalizeQuote, streamQuoteSnapshot } from './quote-snapshot.js';
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
    Promise.resolve(from).then(start => loadHourlyTail(start ?? to - 7*86400, to, signal)),
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
export async function loadPremiums(options, signal, onProgress=()=>{}, {requestImpl=request, onQuotes=()=>{}, ...streamOptions}={}) {
  const priority = nearSpotOptions(options, streamOptions.spot);
  const executable = quote => (Number.isFinite(quote.premium)&&quote.premium>0&&quote.amount>0)
    || (Number.isFinite(quote.bid)&&quote.bid>0&&quote.bidAmount>0);
  const publish = (quotes, received) => {
    if (priority.every(option => received.has(option.name))) {
      const available = quotes.filter(executable);
      onQuotes({quotes:available, excluded:received.size-available.length,
        loaded:received.size, total:options.length});
    }
  };
  const streamed = await streamQuoteSnapshot(options, signal, onProgress, {...streamOptions, onQuotes:publish});
  const accumulated = new Map(streamed.quotes.map(quote => [quote.name, quote]));
  const received = new Set(streamed.received);
  let done=streamed.received.size;
  const priorityNames = new Set(priority.map(option => option.name));
  const missing = options.filter(option => !received.has(option.name))
    .sort((a,b) => Number(priorityNames.has(b.name))-Number(priorityNames.has(a.name))
      || Math.abs(a.strike-streamOptions.spot)-Math.abs(b.strike-streamOptions.spot));
  // Bound fallback work so wings cannot occupy the request queue ahead of ATM quotes.
  let next=0;
  await Promise.all(Array.from({length:Math.min(4,missing.length)}, async () => {
    while (next < missing.length) {
      signal.throwIfAborted();
      const option=missing[next++];
      try {
        const ticker=await requestImpl('ticker',{instrument_name:option.name},signal);
        accumulated.set(option.name,normalizeQuote(option,ticker));
      } catch { signal.throwIfAborted(); }
      received.add(option.name);
      onProgress(++done,options.length);
      publish([...accumulated.values()],received);
    }
  }));
  signal.throwIfAborted();
  const available=[...accumulated.values()].filter(executable);
  return {quotes:available,excluded:options.length-available.length};
}
