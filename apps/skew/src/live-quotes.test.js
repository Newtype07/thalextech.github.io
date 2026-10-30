import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTicker, fetchStreamSnapshot } from "./live-quotes.js";
import { fetchLiveQuotes } from "./market-data.js";
const chain = ["C", "P"].map((side) => ({
  name: `BTC-TEST-${side}`,
  side,
  strike: 100,
  expiry: Date.now() / 1000 + 86400,
}));
const row = (iv = 0.5, bid = [], ask = []) => [
  Date.now() / 1000,
  10,
  100,
  100,
  iv,
  bid,
  ask,
  null,
];
class FakeSocket extends EventTarget {
  static onSend = () => {};
  static last;
  constructor() {
    super();
    FakeSocket.last = this;
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }
  send(text) {
    this.request = JSON.parse(text);
    FakeSocket.onSend(this);
  }
  emit(tickers) {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          channel_name: "lwt_options.BTCUSD.all.1000ms",
          notification: { tickers },
        }),
      }),
    );
  }
  close() {
    this.closed = true;
  }
}
test("bulk ticker chunks publish progressively; empty books preserve mark IV", async () => {
  FakeSocket.onSend = (socket) => {
    socket.emit({ [chain[0].name]: row() });
    queueMicrotask(() => socket.emit({ [chain[1].name]: row(0.6) }));
  };
  const sizes = [];
  const result = await fetchStreamSnapshot(chain, {
    WebSocketImpl: FakeSocket,
    url: "wss://example.test",
    onQuotes: (rows) => sizes.push(rows.length),
  });
  assert.deepEqual(sizes, [1, 2]);
  assert.deepEqual(
    result.map((q) => q.iv),
    [0.5, 0.6],
  );
  assert.equal(result[0].bookIv, null);
  assert.equal(FakeSocket.last.closed, true);
  assert.equal(FakeSocket.last.request.method, "public/subscribe");
  assert.deepEqual(
    FakeSocket.last.request.params.channels,
    ["lwt_options.BTCUSD.all.1000ms"],
  );
});
test("a complete bulk snapshot needs no per-option REST requests", async (t) => {
  FakeSocket.onSend = socket => socket.emit(Object.fromEntries(chain.map(i => [i.name, row()])));
  t.mock.method(globalThis, "fetch", () => assert.fail("bulk snapshot must not fetch REST tickers"));
  const result = await fetchLiveQuotes(chain, { WebSocketImpl: FakeSocket });
  assert.equal(result.transport, "websocket");
  assert.equal(result.quotes.length, chain.length);
  assert.deepEqual(result.failures, []);
});
test("stale and invalid streamed marks stay unavailable without REST fan-out", async (t) => {
  const stale = row();
  stale[0] -= 300;
  FakeSocket.onSend = socket => socket.emit({ [chain[0].name]: stale, [chain[1].name]: null });
  t.mock.method(globalThis, "fetch", () => assert.fail("known unavailable marks must not be retried through REST"));
  const result = await fetchLiveQuotes(chain, { WebSocketImpl: FakeSocket });
  assert.deepEqual(result.quotes, []);
  assert.equal(result.failures.length, 2);
  assert.match(result.failures[0], /two minutes/);
  assert.match(result.failures[1], /Invalid live ticker/);
  assert.equal(result.transport, "websocket");
  assert.equal(FakeSocket.last.closed, true);
});
test("bulk snapshot ignores other instruments and retains valid quotes when later chunks arrive", async () => {
  FakeSocket.onSend = socket => {
    socket.emit({ "BTC-OTHER-C": row(), [chain[0].name]: row() });
    queueMicrotask(() => socket.emit({ [chain[1].name]: row(0.6) }));
  };
  const result = await fetchStreamSnapshot(chain, { WebSocketImpl: FakeSocket, url: "wss://example.test" });
  assert.deepEqual(result.map(q => q.name), chain.map(i => i.name));
});
test("REST fills only names missing from a partial stream", async (t) => {
  FakeSocket.onSend = (socket) => {
    socket.emit({ [chain[0].name]: row() });
    socket.dispatchEvent(new Event("close"));
  };
  const requested = [],
    sizes = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    requested.push(new URL(input).searchParams.get("instrument_name"));
    return {
      ok: true,
      json: async () => ({
        result: {
          iv: 0.6,
          index: 100,
          forward: 100,
          mark_timestamp: Date.now() / 1000,
        },
      }),
    };
  });
  const result = await fetchLiveQuotes(chain, {
    WebSocketImpl: FakeSocket,
    onQuotes: (rows) => sizes.push(rows.length),
  });
  assert.deepEqual(requested, [chain[1].name]);
  assert.deepEqual(sizes, [1, 2]);
  assert.equal(result.transport, "mixed");
  assert.equal(result.quotes.length, 2);
});
test("stream cancellation closes its socket and rejects without further updates", async () => {
  FakeSocket.onSend = () => {};
  const controller = new AbortController();
  const promise = fetchStreamSnapshot(chain, {
    WebSocketImpl: FakeSocket,
    url: "wss://example.test",
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(promise, { name: "AbortError" });
  assert.equal(FakeSocket.last.closed, true);
});
test("a stalled stream times out so REST can take over", async () => {
  FakeSocket.onSend = () => {};
  assert.deepEqual(
    await fetchStreamSnapshot(chain, {
      WebSocketImpl: FakeSocket,
      url: "wss://example.test",
      timeoutMs: 1,
    }),
    [],
  );
  assert.equal(FakeSocket.last.closed, true);
});
test("stale mark data is rejected independently of book availability", () => {
  assert.throws(
    () =>
      normalizeTicker(chain[0], {
        iv: 0.5,
        index: 100,
        mark_timestamp: Date.now() / 1000 - 300,
      }),
    /two minutes/,
  );
});
