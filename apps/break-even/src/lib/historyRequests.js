// User-specified Thalex budget: 100 initial requests, then 10 requests/second.
// Requests remain sequential; response latency counts toward the 100 ms interval.
// Shared across loads: neither idle time nor cooldowns replenish the burst.
export function createHistoryRequester({
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  intervalMs = 100,
  burstLimit = 100,
  cacheTtlMs = 5 * 60 * 1000,
  maxCacheEntries = 500,
} = {}) {
  const cache = new Map();
  const getCached = (key) => {
    const entry = cache.get(key);
    if (entry && entry.expiresAt > now()) return entry;
    cache.delete(key);
    return null;
  };
  let pending = Promise.resolve();
  let nextRequestAt = 0;
  let burstRemaining = burstLimit;
  const checkCanceled = (isCanceled) => {
    if (isCanceled()) throw new Error('Request canceled');
  };
  const waitUntil = async (deadline, isCanceled) => {
    while (now() < deadline) {
      checkCanceled(isCanceled);
      await sleep(Math.min(100, deadline - now()));
    }
    checkCanceled(isCanceled);
  };

  return (fetcher, { isCanceled = () => false, cacheKey } = {}) => {
    const run = async () => {
      checkCanceled(isCanceled);
      const cached = cacheKey ? getCached(cacheKey) : null;
      if (cached) return cached.result;
      let failures = 0;
      while (true) {
        await waitUntil(nextRequestAt, isCanceled);
        if (burstRemaining > 0) burstRemaining -= 1;
        if (burstRemaining === 0) nextRequestAt = now() + intervalMs;
        try {
          const result = await fetcher();
          checkCanceled(isCanceled);
          if (cacheKey) {
            cache.delete(cacheKey);
            cache.set(cacheKey, { result, expiresAt: now() + cacheTtlMs });
            while (cache.size > maxCacheEntries) cache.delete(cache.keys().next().value);
          }
          return result;
        } catch (error) {
          checkCanceled(isCanceled);
          const retryable = [408, 429, 500, 502, 503, 504].includes(Number(error?.status)) ||
            error instanceof TypeError || error?.name === 'AbortError';
          if (!retryable) throw error;
          // A temporary failure ends the initial burst, including unused slots.
          burstRemaining = 0;
          // Retry this exact chunk until it succeeds or the user changes selection.
          const delay = Math.max(
            Math.min(60000, 2000 * 2 ** Math.min(failures++, 5)),
            Number(error.retryAfterMs) || 0,
          );
          nextRequestAt = now() + delay;
        }
      }
    };
    // Cache hits do not consume request slots or wait behind network retries.
    const cached = cacheKey ? getCached(cacheKey) : null;
    if (cached) {
      return Promise.resolve().then(() => {
        checkCanceled(isCanceled);
        return cached.result;
      });
    }
    const result = pending.then(run);
    pending = result.catch(() => {});
    return result;
  };
}
