const DEFAULT_API_BASE = "https://thalex.com/api/v2/public";

function normalizeApiBase(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, "");
}

function resolveApiBase() {
  const globalOverride = normalizeApiBase(globalThis?.__THALEX_API_BASE);
  if (globalOverride) return globalOverride;

  // Optional build-time override, e.g. VITE_THALEX_API_BASE=/api/v2/public
  const envOverride = normalizeApiBase(import.meta?.env?.VITE_THALEX_API_BASE);
  if (envOverride) return envOverride;

  return DEFAULT_API_BASE;
}

const API_BASE = resolveApiBase();
export const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;
const SECONDS_PER_BS_YEAR = 365.25 * 24 * 60 * 60;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_PREFIX = "thalex-cache";
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function getLocalStorage() {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch (e) {
    return null;
  }
}

function isCacheFresh(timestamp) {
  return (
    typeof timestamp === "number" && Date.now() - timestamp <= CACHE_TTL_MS
  );
}

function readCache(key) {
  const storage = getLocalStorage();
  if (!storage) return null;
  const raw = storage.getItem(key);
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  if (!isCacheFresh(parsed.timestamp)) {
    storage.removeItem(key);
    return null;
  }
  if (!Array.isArray(parsed.rows)) {
    storage.removeItem(key);
    return null;
  }
  return {
    rows: parsed.rows,
    meta: parsed.meta,
  };
}

function getCacheKeys(storage) {
  const keys = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (typeof key === "string" && key.startsWith(CACHE_PREFIX)) {
      keys.push(key);
    }
  }
  return keys;
}

function pruneOldCacheEntries(storage) {
  const keys = getCacheKeys(storage);
  if (!keys.length) return;

  const entries = keys
    .map((key) => {
      let timestamp = 0;
      try {
        const raw = storage.getItem(key);
        const parsed = raw ? JSON.parse(raw) : null;
        if (Number.isFinite(parsed?.timestamp)) {
          timestamp = parsed.timestamp;
        }
      } catch (error) {
        timestamp = 0;
      }
      return { key, timestamp };
    })
    .sort((a, b) => a.timestamp - b.timestamp);

  const removeCount = Math.max(1, Math.ceil(entries.length * 0.5));
  for (let i = 0; i < removeCount; i += 1) {
    storage.removeItem(entries[i].key);
  }
}

function writeCache(key, rows, meta) {
  const storage = getLocalStorage();
  if (!storage) return;
  const payload = {
    timestamp: Date.now(),
    rows,
    meta,
  };
  const serialized = JSON.stringify(payload);

  try {
    storage.setItem(key, serialized);
  } catch (error) {
    if (error?.name === "QuotaExceededError") {
      try {
        pruneOldCacheEntries(storage);
        storage.setItem(key, serialized);
      } catch (retryError) {
        // Cache is best-effort: ignore quota errors after one prune+retry.
      }
      return;
    }
    console.error("Failed to write cache", error);
  }
}

function cacheCoversRange(meta, from, to) {
  if (!meta || typeof meta !== "object") return false;
  const cachedFrom = meta.from;
  const cachedTo = meta.to;
  if (!Number.isFinite(cachedFrom) || !Number.isFinite(cachedTo)) return false;
  if (Number.isFinite(from) && cachedFrom > from) return false;
  if (Number.isFinite(to) && cachedTo < to) return false;
  return true;
}

function filterRowsByRange(rows, from, to) {
  if (!Array.isArray(rows)) return [];
  const hasFrom = Number.isFinite(from);
  const hasTo = Number.isFinite(to);
  if (!hasFrom && !hasTo) return rows;
  return rows.filter((row) => {
    const ts = row?.[0];
    if (!Number.isFinite(ts)) return false;
    if (hasFrom && ts < from) return false;
    if (hasTo && ts > to) return false;
    return true;
  });
}

function isRetryableStatus(status) {
  return RETRYABLE_STATUS.has(status);
}

function isRetryableError(error) {
  if (!error) return false;
  if (error.name === "AbortError") return true;
  if (error instanceof TypeError) return true;
  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getJson(
  url,
  {
    timeoutMs = 20_000,
    maxRetries = 2,
    retryDelayMs = 500,
    retryDelaysMs = null,
  } = {},
) {
  const getRetryDelayMs = (attempt) => {
    if (Array.isArray(retryDelaysMs) && retryDelaysMs.length) {
      const idx = Math.min(attempt, retryDelaysMs.length - 1);
      const value = Number(retryDelaysMs[idx]);
      if (Number.isFinite(value) && value >= 0) return value;
    }
    return retryDelayMs * Math.pow(2, attempt);
  };

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, { signal: controller.signal });
      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        const message =
          json?.error?.message ||
          json?.message ||
          `Request failed (${res.status})`;
        const error = new Error(message);
        error.status = res.status;
        const retryAfter = res.headers.get("Retry-After");
        if (retryAfter) {
          const seconds = Number(retryAfter);
          error.retryAfterMs = Number.isFinite(seconds)
            ? Math.max(0, seconds * 1000)
            : Math.max(0, Date.parse(retryAfter) - Date.now()) || 0;
        }

        if (attempt < maxRetries && isRetryableStatus(res.status)) {
          const delay = getRetryDelayMs(attempt);
          await sleep(delay);
          continue;
        }
        throw error;
      }

      return json;
    } catch (error) {
      if (attempt < maxRetries && isRetryableError(error)) {
        const delay = getRetryDelayMs(attempt);
        await sleep(delay);
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function makeUrl(path, params = {}) {
  const search = new URLSearchParams(params);
  return `${API_BASE}${path}?${search}`;
}

export async function fetchInstruments() {
  const url = makeUrl("/instruments", {});
  const json = await getJson(url);
  return mapInstrumentsResult(json);
}

export async function fetchAllInstruments() {
  const url = makeUrl("/all_instruments", {});
  const json = await getJson(url);
  return mapInstrumentsResult(json);
}

function mapInstrumentsResult(json) {
  const result = json?.result;
  if (!Array.isArray(result)) return [];
  return result.map((instrument) => {
    if (!instrument || typeof instrument !== "object") return instrument;
    return {
      ...instrument,
      create_time_ms: instrument.create_time,
    };
  });
}

function mapIndexRow(row) {
  if (!Array.isArray(row) || row.length < 5) return null;
  const [ts, open, high, low, close] = row;
  if (![ts, open, high, low, close].every((value) => Number.isFinite(value))) {
    return null;
  }
  return {
    ts: Number(ts),
    index_price_open: Number(open),
    index_price_high: Number(high),
    index_price_low: Number(low),
    index_price_close: Number(close),
  };
}

export async function fetchIndexHistory({
  index_name,
  resolution,
  from,
  to,
  count,
  requestOptions,
} = {}) {
  const normalizedCount = Number.isFinite(Number(count))
    ? Math.max(1, Math.floor(Number(count)))
    : null;
  const cacheKey = `${CACHE_PREFIX}:index:${index_name}:${resolution}:${normalizedCount ?? "all"}`;
  const cached = readCache(cacheKey);
  if (cached && cacheCoversRange(cached.meta, from, to)) {
    const filtered = filterRowsByRange(cached.rows, from, to);
    return (filtered || []).map(mapIndexRow).filter((row) => row !== null);
  }

  const url = makeUrl("/index_price_historical_data", {
    index_name,
    resolution,
    from,
    to,
    ...(normalizedCount ? { count: normalizedCount } : {}),
  });
  const json = await getJson(url, requestOptions);
  const rows = json?.result?.index;
  if (!Array.isArray(rows)) throw new Error("Invalid history response: expected rows");

  writeCache(cacheKey, rows, {
    index_name,
    resolution,
    from,
    to,
    count: normalizedCount,
  });

  return rows.map(mapIndexRow).filter((row) => row !== null);
}

export async function fetchLatestIndexPrice(index_name, resolution = "1m") {
  const now = Math.floor(Date.now() / 1000);
  const candidates = [
    { resolution, lookbackSeconds: 2 * 60 * 60 },
    { resolution: "5m", lookbackSeconds: 24 * 60 * 60 },
    { resolution: "1h", lookbackSeconds: 7 * 24 * 60 * 60 },
    { resolution: "1d", lookbackSeconds: 90 * 24 * 60 * 60 },
  ];

  for (const candidate of candidates) {
    const from = now - candidate.lookbackSeconds;
    const rows = await fetchIndexHistory({
      index_name,
      resolution: candidate.resolution,
      from,
      to: now,
    });
    if (Array.isArray(rows) && rows.length) {
      return rows[rows.length - 1];
    }
  }

  return null;
}

function mapMarkRowByType(row) {
  if (!Array.isArray(row)) return null;

  const base = {
    ts: row[0],
    mark_price_open: row[1],
    mark_price_high: row[2],
    mark_price_low: row[3],
    mark_price_close: row[4],
    funding: null,
    tob: null,
    iv_open: null,
    iv_high: null,
    iv_low: null,
    iv_close: null,
  };

  if (row.length >= 9) {
    base.iv_open = row[5];
    base.iv_high = row[6];
    base.iv_low = row[7];
    base.iv_close = row[8];
    base.tob = row[9] ?? null;
  } else if (row.length >= 7) {
    base.funding = row[5];
    base.tob = row[6];
  } else if (row.length >= 6) {
    base.tob = row[5];
  }

  return base;
}

export async function fetchMarkHistory({
  instrument_name,
  resolution,
  from,
  to,
  count,
  requestOptions,
} = {}) {
  const normalizedCount = Number.isFinite(Number(count))
    ? Math.max(1, Math.floor(Number(count)))
    : null;
  const cacheKey = `${CACHE_PREFIX}:mark:${instrument_name}:${resolution}:${normalizedCount ?? "all"}`;
  const cached = readCache(cacheKey);
  if (cached && cacheCoversRange(cached.meta, from, to)) {
    const filtered = filterRowsByRange(cached.rows, from, to);
    return (filtered || [])
      .map((row) => mapMarkRowByType(row))
      .filter((row) => row !== null);
  }

  const url = makeUrl("/mark_price_historical_data", {
    instrument_name,
    resolution,
    from,
    to,
    ...(normalizedCount ? { count: normalizedCount } : {}),
  });
  const json = await getJson(url, requestOptions);
  const rows = json?.result?.mark;

  if (!Array.isArray(rows)) throw new Error("Invalid history response: expected rows");

  writeCache(cacheKey, rows, {
    instrument_name,
    resolution,
    from,
    to,
    count: normalizedCount,
  });

  return rows.map((row) => mapMarkRowByType(row)).filter((row) => row !== null);
}

export async function fetchLatestMarkPrice(instrument_name, resolution = "1m") {
  const now = Math.floor(Date.now() / 1000);
  const from = now - 2 * 60 * 60;
  const rows = await fetchMarkHistory({
    instrument_name,
    resolution,
    from,
    to: now,
  });
  if (!Array.isArray(rows) || !rows.length) return null;
  return rows[rows.length - 1];
}

export function buildBasisSeries({ mark, index, instrument }) {
  const indexByTs = new Map((index || []).map((row) => [row.ts, row]));
  const expiration = instrument?.expiration_timestamp;
  const instrumentName = instrument.instrument_name;

  const merged = [];
  for (const markPoint of mark || []) {
    const indexPoint = indexByTs.get(markPoint.ts);
    if (!indexPoint) continue;

    const tte = expiration - markPoint.ts;
    const basis_open = markPoint.mark_price_open - indexPoint.index_price_open;
    const basis_close = markPoint.mark_price_close - indexPoint.index_price_close;

    const basis_pct =
      indexPoint.index_price_close !== 0
        ? (basis_close / indexPoint.index_price_close) * (SECONDS_PER_YEAR / tte)
        : null;

    merged.push({
      ...markPoint,
      ...indexPoint,
      instrumentName,
      date: new Date(markPoint.ts * 1000),
      tte,
      basis_open,
      basis_close,
      basis_change: basis_close - basis_open,
      basis_pct,
    });
  }
  return merged;
}

export function buildFundingSeries({ mark, index, intervalSeconds }) {
  const indexByTs = new Map((index || []).map((row) => [row.ts, row]));
  const merged = [];

  for (const markPoint of mark || []) {
    const indexPoint = indexByTs.get(markPoint.ts);
    if (!indexPoint) continue;

    const annualizedFunding = Number.isFinite(markPoint.funding)
      ? ((markPoint.funding * -1) / indexPoint.index_price_close) *
        (SECONDS_PER_YEAR / intervalSeconds)
      : null;

    merged.push({
      ...markPoint,
      ...indexPoint,
      date: new Date(markPoint.ts * 1000),
      funding_rate_annualized: annualizedFunding,
    });
  }
  return merged;
}

function erfApprox(x) {
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const t = 1 / (1 + 0.5 * absX);
  const tau =
    t *
    Math.exp(
      -absX * absX -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t *
                          (0.27886807 +
                            t *
                              (-1.13520398 +
                                t *
                                  (1.48851587 +
                                    t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return sign * (1 - tau);
}

function normalPdf(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function normalCdf(x) {
  return 0.5 * (1 + erfApprox(x / Math.SQRT2));
}

function calcInputs(spot, strike, tteSeconds, iv) {
  const tau = tteSeconds / SECONDS_PER_BS_YEAR;
  if (!Number.isFinite(spot) || spot <= 0) return null;
  if (!Number.isFinite(strike) || strike <= 0) return null;
  if (!Number.isFinite(iv) || iv <= 0) return null;
  if (!Number.isFinite(tau) || tau <= 0) return null;
  const sqrtTau = Math.sqrt(tau);
  const d1 =
    (Math.log(spot / strike) + 0.5 * iv * iv * tau) / (iv * sqrtTau);
  return { tau, sqrtTau, d1 };
}

// Repricing counterpart of calcGreeks: same CDF, year basis and zero rates/carry.
export function calcOptionPrice(spot, strike, tteSeconds, iv, optionType = "call") {
  if (![spot, strike, tteSeconds, iv].every(Number.isFinite) ||
      spot <= 0 || strike <= 0 || iv < 0) return NaN;
  if (tteSeconds <= 0 || iv === 0) {
    return optionType === "put" ? Math.max(strike - spot, 0) : Math.max(spot - strike, 0);
  }
  const { d1, sqrtTau } = calcInputs(spot, strike, tteSeconds, iv);
  const d2 = d1 - iv * sqrtTau;
  return optionType === "put"
    ? strike * normalCdf(-d2) - spot * normalCdf(-d1)
    : spot * normalCdf(d1) - strike * normalCdf(d2);
}

export function calcGreeks(spot, strike, tteSeconds, iv, optionType = "call") {
  const inputs = calcInputs(spot, strike, tteSeconds, iv);
  if (!inputs) {
    return {
      delta: null,
      gamma: null,
      theta: null,
      vega: null,
      vanna: null,
      vomma: null,
    };
  }
  const { d1, sqrtTau } = inputs;
  const d2 = d1 - iv * sqrtTau;
  const pdf = normalPdf(d1);
  const cdf = normalCdf(d1);
  const delta = optionType === "put" ? cdf - 1 : cdf;
  const gamma = pdf / (spot * iv * sqrtTau);
  const vega = spot * pdf * sqrtTau;
  const vanna = -(pdf * d2) / iv;
  const vomma = (vega * d1 * d2) / iv;
  const thetaAnnual = -(spot * pdf * iv) / (2 * sqrtTau);
  const theta = thetaAnnual / 365.25;
  return { delta, gamma, theta, vega, vanna, vomma };
}

export function computeGreeksPnlSeries({ mark, index, instrument }) {
  const indexByTs = new Map((index || []).map((row) => [row.ts, row]));
  const strike = Number(instrument?.strike_price);
  const expiration = Number(instrument?.expiration_timestamp);
  const optionType =
    instrument?.option_type?.toLowerCase?.() === "put" ? "put" : "call";
  if (!Number.isFinite(strike) || !Number.isFinite(expiration)) return [];

  const merged = [];
  const sortedMark = (mark || [])
    .filter((row) => row && Number.isFinite(row.ts))
    .slice()
    .sort((a, b) => a.ts - b.ts);
  let prevTs = null;

  for (const m of sortedMark) {
    const i = indexByTs.get(m.ts);
    if (!i) continue;

    const tteSecondsOpen = expiration - m.ts;
    const greeksAtOpen = calcGreeks(
      i.index_price_open,
      strike,
      tteSecondsOpen,
      m.iv_open,
      optionType,
    );

    const tteSecondsClose = expiration - m.ts;
    const greeksAtClose = calcGreeks(
      i.index_price_close,
      strike,
      tteSecondsClose,
      m.iv_close,
      optionType,
    );

    const dS =
      Number.isFinite(i.index_price_close) &&
      Number.isFinite(i.index_price_open)
        ? i.index_price_close - i.index_price_open
        : null;
    const dIV =
      Number.isFinite(m.iv_close) && Number.isFinite(m.iv_open)
        ? m.iv_close - m.iv_open
        : null;
    const dT =
      Number.isFinite(prevTs) && Number.isFinite(m.ts)
        ? (m.ts - prevTs) / (24 * 60 * 60)
        : null;
    const pl =
      Number.isFinite(m.mark_price_close) &&
      Number.isFinite(m.mark_price_open)
        ? m.mark_price_close - m.mark_price_open
        : null;

    let delta_PL = null;
    let gamma_PL = null;
    let theta_PL = null;
    let vega_PL = null;
    let vanna_PL = null;
    let charm_PL = null;
    let vomma_PL = null;
    if (Number.isFinite(dS)) {
      if (Number.isFinite(greeksAtOpen.delta)) {
        delta_PL = greeksAtOpen.delta * dS;
      }
      if (Number.isFinite(greeksAtOpen.gamma)) {
        gamma_PL = greeksAtOpen.gamma * dS * dS * 0.5;
      }
    }
    if (Number.isFinite(dT) && Number.isFinite(greeksAtOpen.theta)) {
      theta_PL = greeksAtOpen.theta * dT;
    }
    if (Number.isFinite(dIV) && Number.isFinite(greeksAtOpen.vega)) {
      vega_PL = greeksAtOpen.vega * dIV;
    }
    if (
      Number.isFinite(dS) &&
      Number.isFinite(dIV) &&
      Number.isFinite(greeksAtOpen.vanna)
    ) {
      vanna_PL = greeksAtOpen.vanna * dS * dIV;
    }
    if (Number.isFinite(dIV) && Number.isFinite(greeksAtOpen.vomma)) {
      vomma_PL = 0.5 * greeksAtOpen.vomma * dIV * dIV;
    }
    if (
      Number.isFinite(dS) &&
      Number.isFinite(dT) &&
      Number.isFinite(greeksAtOpen.delta)
    ) {
      const dTSeconds = dT * 24 * 60 * 60;
      const tteShifted = tteSecondsOpen - dTSeconds;
      if (Number.isFinite(tteShifted) && tteShifted > 0) {
        const greeksAtTimeShift = calcGreeks(
          i.index_price_open,
          strike,
          tteShifted,
          m.iv_open,
          optionType,
        );
        if (Number.isFinite(greeksAtTimeShift.delta)) {
          charm_PL = (greeksAtTimeShift.delta - greeksAtOpen.delta) * dS;
        }
      }
    }

    let attributed_PL = null;
    if (
      [delta_PL, gamma_PL, theta_PL, vega_PL, vanna_PL, charm_PL, vomma_PL].some(
        (v) => Number.isFinite(v),
      )
    ) {
      attributed_PL = 0;
      if (Number.isFinite(delta_PL)) attributed_PL += delta_PL;
      if (Number.isFinite(gamma_PL)) attributed_PL += gamma_PL;
      if (Number.isFinite(theta_PL)) attributed_PL += theta_PL;
      if (Number.isFinite(vega_PL)) attributed_PL += vega_PL;
      if (Number.isFinite(vanna_PL)) attributed_PL += vanna_PL;
      if (Number.isFinite(charm_PL)) attributed_PL += charm_PL;
      if (Number.isFinite(vomma_PL)) attributed_PL += vomma_PL;
    }
    const residual_PL =
      attributed_PL != null && Number.isFinite(pl) ? pl - attributed_PL : null;
    const gamma_theta_PL =
      Number.isFinite(gamma_PL) || Number.isFinite(theta_PL)
        ? (Number.isFinite(gamma_PL) ? gamma_PL : 0) +
          (Number.isFinite(theta_PL) ? theta_PL : 0)
        : null;

    merged.push({
      ...m,
      ...i,
      date: new Date(m.ts * 1000),
      tte_seconds: tteSecondsClose,
      delta: greeksAtClose.delta,
      gamma: greeksAtClose.gamma,
      theta: greeksAtClose.theta,
      vega: greeksAtClose.vega,
      dS,
      dIV,
      dT,
      PL: pl,
      delta_PL,
      gamma_PL,
      theta_PL,
      vega_PL,
      vanna_PL,
      charm_PL,
      vomma_PL,
      attributed_PL,
      residual_PL,
      gamma_theta_PL,
    });

    prevTs = m.ts;
  }

  return merged;
}

export function computeVolatilitySeries({ index, resolution, windowSize = 20 }) {
  if (!index || index.length === 0) return [];

  const resolutionSeconds = {
    "1m": 60,
    "5m": 5 * 60,
    "15m": 15 * 60,
    "1h": 60 * 60,
    "1d": 24 * 60 * 60,
  }[resolution] || 24 * 60 * 60;

  const periodsPerYear = SECONDS_PER_YEAR / resolutionSeconds;
  const annualizationFactor = Math.sqrt(periodsPerYear);

  const returns = [];
  for (let i = 1; i < index.length; i++) {
    const prev = index[i - 1].index_price_close;
    const curr = index[i].index_price_close;

    if (prev > 0 && curr > 0 && Number.isFinite(prev) && Number.isFinite(curr)) {
      returns.push({
        ts: index[i].ts,
        date: new Date(index[i].ts * 1000),
        logReturn: Math.log(curr / prev),
        index_price_close: curr,
        index_price_open: index[i].index_price_open,
        index_price_high: index[i].index_price_high,
        index_price_low: index[i].index_price_low,
      });
    }
  }

  const result = [];
  for (let i = windowSize - 1; i < returns.length; i++) {
    const window = returns.slice(i - windowSize + 1, i + 1);
    const logReturns = window.map((r) => r.logReturn);

    const meanReturn =
      logReturns.reduce((sum, r) => sum + r, 0) / logReturns.length;
    const variance =
      logReturns.reduce((sum, r) => sum + Math.pow(r - meanReturn, 2), 0) /
      logReturns.length;
    const realizedVol = Math.sqrt(variance) * annualizationFactor * 100;

    const current = returns[i];
    result.push({
      ts: current.ts,
      date: current.date,
      index_price_close: current.index_price_close,
      index_price_open: current.index_price_open,
      index_price_high: current.index_price_high,
      index_price_low: current.index_price_low,
      realized_vol: Number.isFinite(realizedVol) ? realizedVol : null,
    });
  }

  return result;
}
