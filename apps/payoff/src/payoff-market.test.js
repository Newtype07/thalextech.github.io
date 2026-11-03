import assert from "node:assert/strict";
import test from "node:test";
import { fetchAtmVolatility } from "./payoff-market.js";

const expiry = 1_900_000_000;
const chain = [
  { instrument_name: "ATM-C", strike: 100, expiration_ts: expiry },
  { instrument_name: "ATM-P", strike: 100, expiration_ts: expiry },
  { instrument_name: "WING", strike: 150, expiration_ts: expiry },
  { instrument_name: "OTHER-EXPIRY", strike: 102, expiration_ts: expiry + 86400 },
];
const ticker = (iv) => ({ mark_price: 5, forward: 102, iv, index: 100, mark_timestamp: expiry - 86400 });

test("ATM IV uses the nearest strike for the requested expiry, reuses selected quotes and averages variance", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    calls.push(new URL(input).searchParams.get("instrument_name"));
    return { ok: true, json: async () => ({ result: ticker(0.6) }) };
  });
  const iv = await fetchAtmVolatility(chain, expiry, 102, { "ATM-C": { iv: 0.4 }, WING: { iv: 2 } });
  assert.deepEqual(calls, ["ATM-P"]);
  assert.ok(Math.abs(iv - Math.sqrt((0.4 ** 2 + 0.6 ** 2) / 2)) < 1e-12);
});

test("missing ATM quotes leave P-win unavailable without substituting wing IV", async (t) => {
  t.mock.method(globalThis, "fetch", async () => ({ ok: true, json: async () => ({ result: {} }) }));
  assert.equal(await fetchAtmVolatility(chain, expiry, 102, { WING: { iv: 0.8 } }), null);
  assert.equal(await fetchAtmVolatility(chain, expiry + 1, 102, {}), null);
  assert.equal(await fetchAtmVolatility(chain, expiry, 102, { "ATM-C": { iv: null }, "ATM-P": { iv: null } }), null);
});

test("ATM IV can use one valid side or zero IV and propagates cancellation", async () => {
  assert.equal(await fetchAtmVolatility(chain, expiry, 102, { "ATM-C": { iv: 0.4 }, "ATM-P": { iv: null } }), 0.4);
  assert.equal(await fetchAtmVolatility(chain, expiry, 102, { "ATM-C": { iv: 0 }, "ATM-P": { iv: 0 } }), 0);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fetchAtmVolatility(chain, expiry, 102, { "ATM-C": { iv: 0.4 }, "ATM-P": { iv: 0.4 } }, controller.signal), { name: "AbortError" });
});
