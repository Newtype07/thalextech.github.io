import { THALEX_WS_URL, takeThalexRequest, reportThalexStreamError } from '../../../lib/thalex-rest.js';

// Keep REST objects and lightweight WebSocket tuples behind the same quote boundary.
export function normalizeQuote(option, ticker) {
  if (!Number.isFinite(ticker?.mark_timestamp) || Math.abs(Date.now()/1000-ticker.mark_timestamp)>120)
    throw new Error('Stale or missing quote timestamp');
  return {...option, premium:ticker.best_ask_price, amount:ticker.best_ask_amount ?? 0,
    bid:ticker.best_bid_price, bidAmount:ticker.best_bid_amount ?? 0, ts:ticker.mark_timestamp};
}

export function nearSpotOptions(options, spot) {
  if (!(spot > 0)) return [];
  const strikes = [...new Set(options.map(option => option.strike))].sort((a,b) => a-b);
  const nearest = new Set([...strikes.filter(strike => strike <= spot).slice(-2),
    ...strikes.filter(strike => strike > spot).slice(0,2)]);
  return options.filter(option => nearest.has(option.strike));
}

export function streamQuoteSnapshot(options, signal, onProgress, {
  WebSocketImpl = globalThis.WebSocket, url = THALEX_WS_URL, timeoutMs = 4000,
  dispatch = takeThalexRequest, spot, onQuotes = () => {},
} = {}) {
  signal?.throwIfAborted();
  if (!WebSocketImpl || !url || !options.length) return Promise.resolve({quotes:[], received:new Set()});
  const instruments = new Map(options.map(option => [option.name, option]));
  const channel = 'lwt_options.BTCUSD.all.1000ms';
  const priority = nearSpotOptions(options, spot);
  const priorityChannels = new Map(priority.map(option => [`ticker.${option.name}.1000ms`, option]));
  return new Promise((resolve, reject) => {
    const connection = new AbortController();
    const requestSignal = signal ? AbortSignal.any([signal, connection.signal]) : connection.signal;
    const quotes = new Map(), received = new Set();
    let socket, timer, settled = false, bulkRequested = !priority.length;
    function finish(error) {
      if (settled) return;
      settled = true;
      connection.abort();
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (socket) {
        socket.removeEventListener('open', open);
        socket.removeEventListener('message', message);
        socket.removeEventListener('error', failed);
        socket.removeEventListener('close', failed);
        socket.close();
      }
      if (error) reject(error);
      else resolve({quotes:[...quotes.values()], received});
    }
    const abort = () => finish(signal.reason);
    const failed = () => finish();
    const subscribe = channels => dispatch(requestSignal, () => socket.send(JSON.stringify({
      id:bulkRequested ? 2 : 1, method:'public/subscribe', params:{channels},
    }))).catch(error => finish(error));
    const open = () => subscribe(priority.length ? [...priorityChannels.keys()] : [channel]);
    const message = event => {
      let body;
      try { body = JSON.parse(event.data); } catch { return; }
      if (body.error) {
        void reportThalexStreamError(body.error).then(error => finish(error));
        return;
      }
      if (body.id && Array.isArray(body.result) && !body.result.length) return finish();
      const direct = priorityChannels.get(body.channel_name);
      if (!direct && (body.channel_name !== channel || !body.notification?.tickers)) return;
      const entries = direct ? [[direct.name, body.notification]] : Object.entries(body.notification.tickers);
      for (const [name, row] of entries) {
        const option = instruments.get(name);
        if (!option) continue;
        received.add(name);
        try {
          if (!direct && !Array.isArray(row)) throw new Error('Invalid quote');
          quotes.set(name, normalizeQuote(option, direct ? row : {mark_timestamp:row[0],
            best_bid_price:row[5]?.[0], best_bid_amount:row[5]?.[1],
            best_ask_price:row[6]?.[0], best_ask_amount:row[6]?.[1]}));
        } catch { quotes.delete(name); }
      }
      onProgress?.(received.size, instruments.size);
      onQuotes([...quotes.values()], new Set(received));
      if (received.size === instruments.size) finish();
      else if (!bulkRequested && priority.every(option => received.has(option.name))) {
        bulkRequested = true;
        clearTimeout(timer);
        timer = setTimeout(() => finish(), timeoutMs);
        void subscribe([channel]);
      }
    };
    try {
      socket = new WebSocketImpl(url);
      socket.addEventListener('open', open);
      socket.addEventListener('message', message);
      socket.addEventListener('error', failed);
      socket.addEventListener('close', failed);
      signal?.addEventListener('abort', abort, {once:true});
      timer = setTimeout(() => finish(), timeoutMs);
    } catch { finish(); }
  });
}
