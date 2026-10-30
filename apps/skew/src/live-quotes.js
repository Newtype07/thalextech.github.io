import { bookMidIv } from "./volatility.js";

// REST and batched WebSocket tickers share one normalization boundary.
export function normalizeTicker(instrument, ticker) {
  if (!(
    Number.isFinite(ticker.iv) &&
    ticker.iv > 0 &&
    Number.isFinite(ticker.index) &&
    ticker.index > 0 &&
    Number.isFinite(ticker.mark_timestamp)
  ))
    throw new Error("Missing live IV/index");
  if (Math.abs(Date.now() / 1000 - ticker.mark_timestamp) > 120)
    throw new Error("Live mark is over two minutes old");
  const quote = {
    ...instrument,
    iv: ticker.iv,
    spot: ticker.index,
    ts: ticker.mark_timestamp,
  };
  return {
    ...quote,
    bookIv: bookMidIv({
      ...quote,
      bid: ticker.best_bid_price,
      ask: ticker.best_ask_price,
      forward: ticker.forward,
    }),
  };
}

export function fetchStreamSnapshot(
  chain,
  {
    url,
    WebSocketImpl,
    signal,
    onQuotes = () => {},
    onUnavailable = () => {},
    timeoutMs = 8000,
  },
) {
  signal?.throwIfAborted();
  if (!WebSocketImpl || !url || !chain.length) return Promise.resolve([]);
  const instruments = new Map(chain.map((i) => [i.name, i]));
  const channels = new Set(
    chain.map((i) => `lwt_options.${i.name.split("-")[0]}USD.all.1000ms`),
  );
  return new Promise((resolve, reject) => {
    let socket,
      timer,
      settleTimer,
      settled = false;
    const quotes = new Map();
    const received = new Set();
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(settleTimer);
      signal?.removeEventListener("abort", abort);
      if (socket) {
        socket.removeEventListener("open", open);
        socket.removeEventListener("message", message);
        socket.removeEventListener("error", failed);
        socket.removeEventListener("close", failed);
        socket.close();
      }
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve([...quotes.values()]);
    };
    const abort = () => finish(signal.reason);
    const failed = () => finish(); // REST fills only the missing names.
    const open = () =>
      socket.send(
        JSON.stringify({
          id: 1,
          method: "public/subscribe",
          params: { channels: [...channels] },
        }),
      );
    const message = (event) => {
      let body;
      try {
        body = JSON.parse(event.data);
      } catch {
        return;
      }
      if (
        body.error ||
        (body.id === 1 &&
          Array.isArray(body.result) &&
          body.result.length === 0)
      ) {
        finish();
        return;
      }
      if (!channels.has(body.channel_name) || !body.notification?.tickers) return;
      const previousCount = received.size;
      for (const [name, row] of Object.entries(body.notification.tickers)) {
        const instrument = instruments.get(name);
        if (!instrument) continue;
        received.add(name);
        try {
          if (!Array.isArray(row)) throw new Error("Invalid live ticker");
          quotes.set(
            name,
            normalizeTicker(instrument, {
              mark_timestamp: row[0],
              index: row[2],
              forward: row[3],
              iv: row[4],
              best_bid_price: row[5]?.[0],
              best_ask_price: row[6]?.[0],
            }),
          );
        } catch (error) {
          quotes.delete(name);
          onUnavailable(name, error);
        }
      }
      onQuotes([...quotes.values()]);
      if (received.size === instruments.size) finish();
      else if (received.size > previousCount) {
        clearTimeout(settleTimer);
        settleTimer = setTimeout(() => finish(), 1500);
      }
    };
    try {
      socket = new WebSocketImpl(url);
      socket.addEventListener("open", open);
      socket.addEventListener("message", message);
      socket.addEventListener("error", failed);
      socket.addEventListener("close", failed);
      signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => finish(), timeoutMs);
    } catch (error) {
      finish(error);
    }
  });
}
