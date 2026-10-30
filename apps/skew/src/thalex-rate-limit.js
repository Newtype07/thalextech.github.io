export async function abortableDelay(ms, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export class RateLimitPausedError extends Error {
  constructor(ms) {
    super(
      `Thalex request queue paused after repeated rate-limit/network failures. Retry in ${Math.ceil(ms / 1000)}s; cached data remains available.`,
    );
    this.name = "RateLimitPausedError";
    this.isRateLimit = true;
  }
}

// State, rather than a client closure, survives HMR. Web Locks plus localStorage
// coordinate this origin's tabs/reloads; unrelated clients on the same IP remain external.
export function sharedBudgetStore(key) {
  const registryKey = Symbol.for("thalex.term-structure.budgets.v1");
  const memory = (globalThis[registryKey] ||= new Map());
  let storage;
  try {
    storage = globalThis.window?.localStorage;
  } catch {
    /* Private-mode fallback. */
  }
  const storageKey = `thalex-rest-budget-v1:${key}`;
  const locks = storage ? globalThis.navigator?.locks : null;
  return {
    load() {
      try {
        const raw = storage?.getItem(storageKey);
        if (raw) return JSON.parse(raw);
      } catch {
        /* Fall back to this tab. */
      }
      return memory.has(key) ? structuredClone(memory.get(key)) : null;
    },
    save(state) {
      memory.set(key, structuredClone(state));
      try {
        storage?.setItem(storageKey, JSON.stringify(state));
      } catch {
        /* Best effort. */
      }
    },
    lock(work, signal) {
      return locks
        ? locks.request(storageKey, signal ? { signal } : {}, work)
        : Promise.resolve().then(work);
    },
  };
}

export class ThalexTokenBucket {
  constructor({
    capacity = 1,
    refillPerSecond = 8,
    store,
    now = Date.now,
    sleep = abortableDelay,
  } = {}) {
    this.capacity = capacity;
    this.refillPerSecond = refillPerSecond;
    let state;
    this.store = store || {
      load: () => state && structuredClone(state),
      save: (value) => {
        state = structuredClone(value);
      },
      lock: (work) => Promise.resolve().then(work),
    };
    this.now = now;
    this.sleep = sleep;
  }
  state() {
    const loaded = this.store.load();
    if (
      !loaded ||
      ![
        loaded.tokens,
        loaded.updatedAt,
        loaded.blockedUntil,
        loaded.circuitUntil,
      ].every(Number.isFinite)
    )
      return {
        tokens: this.capacity,
        updatedAt: this.now(),
        blockedUntil: 0,
        circuitUntil: 0,
        failures: [],
        ratePerSecond: this.refillPerSecond,
        rateUpdatedAt: this.now(),
        burstRemaining: this.capacity,
        nextStartAt: 0,
      };
    loaded.tokens = Math.max(0, Math.min(this.capacity, loaded.tokens));
    if (!Array.isArray(loaded.failures)) loaded.failures = [];
    loaded.ratePerSecond =
      Number.isFinite(loaded.ratePerSecond) && loaded.ratePerSecond > 0
        ? Math.min(this.refillPerSecond, loaded.ratePerSecond)
        : this.refillPerSecond;
    if (!Number.isFinite(loaded.rateUpdatedAt)) loaded.rateUpdatedAt = this.now();
    loaded.burstRemaining = Math.max(
      0,
      Math.min(
        // Saved state has already served a request. Discard old burst credit
        // when capacity drops to one, preserving the next start deadline.
        this.capacity - 1,
        Number.isFinite(loaded.burstRemaining)
          ? loaded.burstRemaining
          : loaded.tokens,
      ),
    );
    if (!Number.isFinite(loaded.nextStartAt)) loaded.nextStartAt = 0;
    return loaded;
  }
  async take(signal) {
    for (;;) {
      signal?.throwIfAborted();
      const wait = await this.store.lock(() => {
        signal?.throwIfAborted();
        const state = this.state(),
          now = this.now();
        if (state.circuitUntil > now)
          throw new RateLimitPausedError(state.circuitUntil - now);
        if (state.blockedUntil > now) return state.blockedUntil - now;
        // Recover gradually after a quiet minute, without resetting the initial burst.
        if (
          state.ratePerSecond < this.refillPerSecond &&
          now - state.rateUpdatedAt >= 60000
        ) {
          state.ratePerSecond = Math.min(
            this.refillPerSecond,
            state.ratePerSecond + 1,
          );
          state.rateUpdatedAt = now;
        }
        const refillPerMs = state.ratePerSecond / 1000;
        // After the initial burst, space actual starts. Timer delays or idle
        // time must not bunch accumulated refill tokens into another burst.
        if (state.burstRemaining <= 0 && state.nextStartAt > now) {
          this.store.save(state);
          return Math.ceil(state.nextStartAt - now);
        }
        state.tokens = Math.min(
          this.capacity,
          state.tokens + Math.max(0, now - state.updatedAt) * refillPerMs,
        );
        state.updatedAt = Math.max(now, state.updatedAt);
        if (state.tokens < 1) {
          this.store.save(state);
          return Math.ceil((1 - state.tokens) / refillPerMs);
        }
        state.tokens--;
        state.burstRemaining = Math.max(0, state.burstRemaining - 1);
        state.nextStartAt = now + Math.ceil(1000 / state.ratePerSecond);
        this.store.save(state);
        return 0;
      }, signal);
      if (!wait) return;
      await this.sleep(wait, signal);
    }
  }
  async penalize(ms, { reduceRate = false } = {}) {
    await this.store.lock(() => {
      const state = this.state(),
        now = this.now();
      state.blockedUntil = Math.max(state.blockedUntil, now + ms);
      // Resume at the refill rate, never a second full burst after a 429.
      state.tokens = 0;
      state.burstRemaining = 0;
      state.updatedAt = state.blockedUntil;
      if (reduceRate) {
        state.ratePerSecond = Math.max(
          Math.min(1, this.refillPerSecond),
          state.ratePerSecond / 2,
        );
        state.rateUpdatedAt = state.blockedUntil;
      }
      state.failures = [
        ...(state.failures || []).filter((ts) => ts > now - 30000),
        now,
      ];
      if (state.failures.length >= 5)
        state.circuitUntil = Math.max(
          state.circuitUntil,
          now + 30000,
          state.blockedUntil,
        );
      state.blockedUntil = Math.max(state.blockedUntil, state.circuitUntil);
      state.updatedAt = state.blockedUntil;
      state.nextStartAt =
        state.blockedUntil + Math.ceil(1000 / state.ratePerSecond);
      this.store.save(state);
    });
  }
}
