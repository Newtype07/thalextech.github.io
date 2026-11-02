import {
  abortableDelay,
  sharedBudgetStore,
  ThalexTokenBucket,
} from "./thalex-rate-limit.js";

const DEFAULT_API = "https://thalex.com/api/v2/public";
const configuredApi = import.meta.env?.VITE_THALEX_API_BASE?.replace(
  /\/+$/,
  "",
);
const localPreview =
  typeof window !== "undefined" &&
  ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
const previewProxy = localPreview
  ? `${import.meta.env?.BASE_URL || "/"}thalex-api`
  : null;
const devProxy = import.meta.env?.DEV
  ? `${import.meta.env.BASE_URL}thalex-api`
  : null;
// Use Vite's built-in environment instead of an optional custom define.
// Dev modules use Vite's proxy path; local preview detects loopback at runtime.
// Static builds deployed elsewhere call Thalex directly.
export const THALEX_API_BASE =
  configuredApi || devProxy || previewProxy || DEFAULT_API;
const exchangeApi = configuredApi || DEFAULT_API;
export const THALEX_WS_URL =
  import.meta.env?.VITE_THALEX_WS_URL ||
  (/^https:\/\/(testnet\.)?thalex.com\/api\/v2\/public$/.test(exchangeApi)
    ? exchangeApi
        .replace("https:", "wss:")
        .replace("/api/v2/public", "/ws/api/v2")
    : null);

export function retryAfterMs(value, now = Date.now()) {
  if (value == null || value.trim() === "") return 0;
  const seconds = Number(value);
  return (
    Math.max(
      0,
      Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now,
    ) || 0
  );
}

function invalidJsonResponse(url, contentType, cause) {
  const hint = url.includes("/thalex-api/")
    ? "The local API proxy is not active. Restart this app's development server, then reload the page."
    : "Check the configured API URL and that its server returns JSON.";
  return new Error(
    `Expected JSON from ${url}, but received ${contentType || "a non-JSON response"}. ${hint}`,
    { cause },
  );
}

function concurrencyGate(limit) {
  let active = 0;
  const queue = [];
  const drain = () => {
    while (active < limit && queue.length) {
      const job = queue.shift();
      job.signal?.removeEventListener("abort", job.abort);
      if (job.signal?.aborted) {
        job.reject(job.signal.reason);
        continue;
      }
      active++;
      Promise.resolve()
        .then(() => {
          job.signal?.throwIfAborted();
          return job.work();
        })
        .then(job.resolve, job.reject)
        .finally(() => {
          active--;
          drain();
        });
    }
  };
  return (work, signal) =>
    new Promise((resolve, reject) => {
      signal?.throwIfAborted();
      const job = {
        work,
        signal,
        resolve,
        reject,
        abort: () => {
          const index = queue.indexOf(job);
          if (index >= 0) {
            queue.splice(index, 1);
            reject(signal.reason);
          }
        },
      };
      signal?.addEventListener("abort", job.abort, { once: true });
      queue.push(job);
      drain();
    });
}

export function createThalexClient({
  baseUrl = THALEX_API_BASE,
  bucket = sharedBucket,
  fetchImpl = (...args) => fetch(...args),
  maxConcurrent = 4,
  maxRetries = 3,
  sleep = abortableDelay,
  random = Math.random,
} = {}) {
  const run = concurrencyGate(maxConcurrent),
    bySignal = new WeakMap(),
    withoutSignal = new Map();
  async function perform(url, signal) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await run(async () => {
          let response;
          try {
            response = await bucket.take(signal, () => {
              signal?.throwIfAborted();
              return fetchImpl(url, {
                cache: "no-store",
                signal: AbortSignal.any([
                  signal || new AbortController().signal,
                  AbortSignal.timeout(25000),
                ]),
              });
            });
          } catch (error) {
            signal?.throwIfAborted();
            // Browsers cannot expose the status of a CORS-blocked 429. Treat
            // network/timeout failures conservatively as a shared cooldown too.
            if (error instanceof TypeError || error.name === "TimeoutError") {
              await bucket.penalize(
                Math.min(60000, 10000 * 2 ** attempt) +
                  Math.floor(random() * 500),
                { reduceRate: true },
              );
              error.retryable = attempt < 1;
            }
            throw error;
          }
          signal?.throwIfAborted();
          if (!response.ok) {
            const error = new Error(`Thalex HTTP ${response.status}`);
            error.status = response.status;
            error.retryable = [408, 429, 500, 502, 503, 504].includes(
              response.status,
            );
            error.isRateLimit = response.status === 429;
            if (error.isRateLimit)
              await bucket.penalize(
                Math.max(
                  retryAfterMs(response.headers?.get("Retry-After")),
                  Math.min(60000, 10000 * 2 ** attempt),
                ) + Math.floor(random() * 500),
                { reduceRate: true },
              );
            await response.body?.cancel();
            throw error;
          }
          const contentType = response.headers?.get("content-type") || "";
          if (/text\/html|application\/xhtml\+xml/i.test(contentType)) {
            await response.body?.cancel();
            throw invalidJsonResponse(url, contentType);
          }
          let body;
          try {
            body = await response.json();
          } catch (error) {
            if (error instanceof SyntaxError)
              throw invalidJsonResponse(url, contentType, error);
            throw error;
          }
          signal?.throwIfAborted();
          if (body.error) {
            const error = thalexApiError(body.error);
            if (error.isRateLimit)
              await bucket.penalize(Math.max(retryAfterMs(response.headers?.get("Retry-After")),
                Math.min(60000, 10000 * 2 ** attempt)) + Math.floor(random() * 500), { reduceRate: true });
            throw error;
          }
          if (body.result == null) throw new Error("Thalex returned no result");
          return body.result;
        }, signal);
      } catch (error) {
        signal?.throwIfAborted();
        if (attempt >= maxRetries || !error.retryable) throw error;
        // 429/network retries rejoin the shared queue. Only transient server
        // errors need a per-request delay in addition to the global budget.
        if (error.status && error.status !== 429)
          await sleep(
            Math.min(30000, 1000 * 2 ** attempt) + Math.floor(random() * 500),
            signal,
          );
      }
    }
  }
  return (path, params = {}, signal) => {
    signal?.throwIfAborted();
    let pending = withoutSignal;
    if (signal) {
      if (!bySignal.has(signal)) bySignal.set(signal, new Map());
      pending = bySignal.get(signal);
    }
    const search = new URLSearchParams(params);
    search.sort();
    const url = `${baseUrl}/${path}?${search}`;
    if (!pending.has(url))
      pending.set(
        url,
        perform(url, signal).finally(() => pending.delete(url)),
      );
    return pending.get(url);
  };
}

const budgetKey = exchangeApi;
// The exchange ceiling is 100 burst / 10 sustained. The public HTTP edge also
// returned Cloudflare 1015 at an observed 10/s (and again at 5/s). Stay below
// that observed edge threshold; do not spend fresh burst credit on page load.
const sharedBucket = new ThalexTokenBucket({ capacity: 1, refillPerSecond: 4,
  store: sharedBudgetStore(budgetKey) });
export function takeThalexRequest(signal, dispatch) {
  return sharedBucket.take(signal, dispatch);
}
function thalexApiError(detail) {
  const error = new Error(detail.message || JSON.stringify(detail));
  error.code = detail.code;
  error.isRateLimit = detail.code === 429 || /rate[\s_-]*limit|too many (?:requests|messages)|request (?:rate |limit)|burst limit/i.test(error.message);
  error.retryable = error.isRateLimit;
  return error;
}
export async function reportThalexStreamError(detail) {
  const error = thalexApiError(detail);
  if (error.isRateLimit) await sharedBucket.penalize(10000, { reduceRate: true });
  return error;
}
export function getThalexQueueStatus() {
  const state = sharedBucket.state();
  return {
    blockedUntil: Math.max(state.blockedUntil, state.circuitUntil),
    ratePerSecond: state.ratePerSecond,
  };
}
export const requestThalex = createThalexClient({
  bucket: sharedBucket,
});
