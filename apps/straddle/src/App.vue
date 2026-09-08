<script setup>
import {
  computed,
  nextTick,
  onMounted,
  onUnmounted,
  reactive,
  ref,
  watch,
} from "vue";
import StyledSelectMenu from "./components/StyledSelectMenu.vue";
import OptionPnlChart from "./components/OptionPnlChart.vue";
import StraddleBreakEvenChart from "./components/StraddleBreakEvenChart.vue";
import {
  computeGreeksPnlSeries,
  fetchIndexHistory,
  fetchInstruments,
  fetchMarkHistory,
} from "../../../lib/thalex.js";

const RESOLUTION_CONFIG = {
  60: { label: "1m", resolution: "1m", interval_seconds: 60 },
  300: { label: "5m", resolution: "5m", interval_seconds: 5 * 60 },
  900: { label: "15m", resolution: "15m", interval_seconds: 15 * 60 },
  3600: { label: "1h", resolution: "1h", interval_seconds: 60 * 60 },
  86400: { label: "1d", resolution: "1d", interval_seconds: 24 * 60 * 60 },
};
const DEFAULT_HISTORY_POINT_LIMIT = 1500;
const MIN_HISTORY_POINT_LIMIT = 100;
const MAX_HISTORY_POINT_LIMIT = 10000;
const HISTORY_POINT_DEBOUNCE_MS = 350;
const DEFAULT_CIRCLE_SIZE = 4;
const MIN_CIRCLE_SIZE = 2;
const MAX_CIRCLE_SIZE = 12;
const MIN_DATA_DATE = new Date("2025-09-30T00:00:00Z");

const UNDERLYING_OPTIONS = [
  { value: "BTCUSD", label: "BTC" },
  { value: "ETHUSD", label: "ETH" },
];

const ui = reactive({
  resolutionKey: "3600",
  optionMaturity: "",
  optionStrike: "",
  mode: "breakeven",
  maxPoints: DEFAULT_HISTORY_POINT_LIMIT,
  circleSize: DEFAULT_CIRCLE_SIZE,
  loading: false,
  error: "",
});
const underlying = ref("BTCUSD");
const allInstruments = ref([]);
const data = reactive({
  optionInstruments: [],
  callMark: {},
  putMark: {},
  index: {},
});
const chartRef = ref(null);
const breakEvenChartRef = ref(null);
const settingsMenuRef = ref(null);
const settingsButtonRef = ref(null);
const settingsOpen = ref(false);
const isInitializing = ref(true);
let prefetchedIndexForInitialLoad = null;
let loadRequestId = 0;
let maxPointsDebounceTimer = null;

const maturityFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "2-digit",
  year: "2-digit",
  timeZone: "UTC",
});
const strikeFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});

const requestedMaxPoints = computed(() => {
  const value = Math.floor(Number(ui.maxPoints));
  if (!Number.isFinite(value)) return DEFAULT_HISTORY_POINT_LIMIT;
  return Math.max(
    MIN_HISTORY_POINT_LIMIT,
    Math.min(MAX_HISTORY_POINT_LIMIT, value),
  );
});
const maxPointsToFetch = ref(DEFAULT_HISTORY_POINT_LIMIT);

const chartCircleSize = computed(() => {
  const value = Number(ui.circleSize);
  if (!Number.isFinite(value)) return DEFAULT_CIRCLE_SIZE;
  return Math.max(MIN_CIRCLE_SIZE, Math.min(MAX_CIRCLE_SIZE, value));
});

const toggleSettings = async () => {
  settingsOpen.value = !settingsOpen.value;
  if (settingsOpen.value) {
    await nextTick();
    settingsButtonRef.value?.focus?.();
  }
};

const closeSettings = () => {
  settingsOpen.value = false;
};

const handleDocumentPointerDown = (event) => {
  if (!settingsOpen.value) return;
  const target = event?.target;
  if (!(target instanceof Node)) return;
  if (settingsMenuRef.value?.contains(target)) return;
  closeSettings();
};

const normalizeCreateTimeSeconds = (value) => {
  const ts = Number(value);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  return ts;
};

const normalizeOptionInstrument = (instrument) => {
  if (!instrument || typeof instrument !== "object") return instrument;
  return {
    ...instrument,
    create_time_s: normalizeCreateTimeSeconds(
      instrument.create_time ?? instrument.create_time_ms,
    ),
    expiration_ts: Number(instrument.expiration_timestamp),
    strike: Number(instrument.strike_price),
    option_type_normalized: (instrument.option_type || "call").toLowerCase(),
  };
};

const getOldestOptionInstrument = (instruments) => {
  let oldest = null;
  for (const instrument of instruments || []) {
    const created = Number(instrument?.create_time_s);
    if (!oldest || created < Number(oldest.create_time_s)) {
      oldest = instrument;
    }
  }
  return oldest;
};

const getMiddleStrikeValue = (strikes) => {
  if (!strikes?.length) return "";
  const midIndex = Math.floor(strikes.length / 2);
  return strikes[midIndex]?.value ?? "";
};

const getClosestStrikeValue = (strikes, indexPrice) => {
  if (!strikes?.length) return "";
  if (!Number.isFinite(indexPrice)) return getMiddleStrikeValue(strikes);

  let bestValue = "";
  let bestDistance = Infinity;
  let bestNumeric = Infinity;
  for (const strikeOption of strikes) {
    const numeric = Number(strikeOption?.value);
    if (!Number.isFinite(numeric)) continue;
    const distance = Math.abs(numeric - indexPrice);
    if (
      distance < bestDistance ||
      (distance === bestDistance && numeric < bestNumeric)
    ) {
      bestDistance = distance;
      bestNumeric = numeric;
      bestValue = strikeOption.value;
    }
  }
  return bestValue || getMiddleStrikeValue(strikes);
};

const getLatestIndexClose = (rows) => {
  if (!rows?.length) return null;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const value = rows[i]?.index_price_close;
    if (Number.isFinite(value)) return value;
  }
  return null;
};

const getDefaultStrikeValue = ({
  maturityInstruments,
  indexPrice,
  fallbackStrikes,
}) => {
  const pairedStrikeSet = new Set(
    (fallbackStrikes || [])
      .map((strike) => Number(strike?.value))
      .filter((strike) => Number.isFinite(strike)),
  );
  const calls = (maturityInstruments || [])
    .filter(
      (instrument) =>
        instrument?.option_type_normalized === "call" &&
        Number.isFinite(instrument?.strike) &&
        (pairedStrikeSet.size === 0 || pairedStrikeSet.has(instrument.strike)),
    )
    .sort((a, b) => a.strike - b.strike);

  if (Number.isFinite(indexPrice) && calls.length) {
    const above = [];
    const seenStrikes = new Set();
    for (const instrument of calls) {
      if (instrument.strike <= indexPrice) continue;
      if (seenStrikes.has(instrument.strike)) continue;
      seenStrikes.add(instrument.strike);
      above.push(instrument);
      if (above.length === 2) break;
    }
    if (above.length) {
      let selected = above[0];
      for (const candidate of above.slice(1)) {
        const candidateCreated = Number(candidate?.create_time_s);
        const selectedCreated = Number(selected?.create_time_s);
        if (
          Number.isFinite(candidateCreated) &&
          (!Number.isFinite(selectedCreated) ||
            candidateCreated < selectedCreated)
        ) {
          selected = candidate;
        }
      }
      if (Number.isFinite(selected?.strike)) {
        return String(selected.strike);
      }
    }
  }

  return getMiddleStrikeValue(fallbackStrikes);
};

const getTimestampRange = () => {
  const now = Math.floor(Date.now() / 1000);
  const resolutionConfig = RESOLUTION_CONFIG[ui.resolutionKey];
  const resolution = resolutionConfig?.resolution;
  const seconds =
    resolutionConfig?.interval_seconds ?? Number(ui.resolutionKey) ?? 0;
  const safeSeconds = Number.isFinite(seconds) && seconds > 0 ? seconds : 3600;
  const to = now - (now % safeSeconds);
  return {
    resolution,
    from: to - safeSeconds * (maxPointsToFetch.value - 1),
    to,
  };
};

const optionMaturities = computed(() => {
  const expirations = Array.from(
    new Set(
      data.optionInstruments
        .map((instrument) => instrument?.expiration_ts)
        .filter((ts) => Number.isFinite(ts) && ts > 0),
    ),
  ).sort((a, b) => a - b);
  return expirations.map((ts) => ({
    value: String(ts),
    label: `${maturityFormatter.format(new Date(ts * 1000))} UTC`,
  }));
});

const selectedMaturityTs = computed(() => Number(ui.optionMaturity));
const selectedStrike = computed(() => Number(ui.optionStrike));

const optionInstrumentsForMaturity = computed(() => {
  const maturityTs = selectedMaturityTs.value;
  return data.optionInstruments.filter(
    (instrument) => instrument?.expiration_ts === maturityTs,
  );
});

const optionStrikes = computed(() => {
  const strikeTypes = new Map();
  for (const instrument of optionInstrumentsForMaturity.value) {
    const strike = instrument?.strike;
    const type = instrument?.option_type_normalized;
    if (!Number.isFinite(strike)) continue;
    if (type !== "call" && type !== "put") continue;
    const bucket = strikeTypes.get(strike) || { call: false, put: false };
    bucket[type] = true;
    strikeTypes.set(strike, bucket);
  }
  const strikes = Array.from(strikeTypes.entries())
    .filter(([, bucket]) => bucket.call && bucket.put)
    .map(([strike]) => strike)
    .sort((a, b) => a - b);
  return strikes.map((strike) => ({
    value: String(strike),
    label: strikeFormatter.format(strike),
  }));
});

const selectedCallInstrument = computed(() => {
  const maturityTs = selectedMaturityTs.value;
  const strike = selectedStrike.value;
  return (
    data.optionInstruments.find((instrument) => {
      const expirationMatch = instrument?.expiration_ts === maturityTs;
      const strikeMatch = instrument?.strike === strike;
      const typeMatch = instrument?.option_type_normalized === "call";
      return expirationMatch && strikeMatch && typeMatch;
    }) || null
  );
});

const selectedPutInstrument = computed(() => {
  const maturityTs = selectedMaturityTs.value;
  const strike = selectedStrike.value;
  return (
    data.optionInstruments.find((instrument) => {
      const expirationMatch = instrument?.expiration_ts === maturityTs;
      const strikeMatch = instrument?.strike === strike;
      const typeMatch = instrument?.option_type_normalized === "put";
      return expirationMatch && strikeMatch && typeMatch;
    }) || null
  );
});

const optionInstrumentName = computed(() => {
  const callName = selectedCallInstrument.value?.instrument_name || "";
  if (!callName) return "";
  const parts = callName.split("-");
  if (parts.length >= 2) {
    return `${parts[0]}-${parts[1]}-STRADDLE`;
  }
  return `${callName}-STRADDLE`;
});

const underlyingLabel = computed(
  () =>
    UNDERLYING_OPTIONS.find((option) => option.value === underlying.value)
      ?.label || underlying.value,
);
const breakEvenTitle = computed(
  () => `${underlyingLabel.value} Straddle Break-Evens`,
);
const breakEvenSubtitle = computed(() => {
  const expiryTs = selectedMaturityTs.value;
  const strike = selectedStrike.value;
  if (!Number.isFinite(expiryTs) || !Number.isFinite(strike)) return "";
  return `Expiry: ${maturityFormatter.format(new Date(expiryTs * 1000))} UTC Strike: ${strikeFormatter.format(strike)}`;
});

const latestMarkValue = (rows, fields) => {
  for (let i = (rows?.length || 0) - 1; i >= 0; i -= 1) {
    for (const field of fields) {
      const value = rows[i]?.[field];
      if (Number.isFinite(value)) return value;
    }
  }
  return null;
};

const latestMarkClose = (rows) => latestMarkValue(rows, ["mark_price_close"]);

const breakEvenMetrics = computed(() => {
  const strike = selectedStrike.value;
  if (!Number.isFinite(strike)) return null;
  const callClose = latestMarkClose(data.callMark[ui.resolutionKey] || []);
  const putClose = latestMarkClose(data.putMark[ui.resolutionKey] || []);
  if (!Number.isFinite(callClose) || !Number.isFinite(putClose)) return null;
  const straddleMark = callClose + putClose;
  return {
    straddleMark,
    breakEvenLow: strike - straddleMark,
    breakEvenHigh: strike + straddleMark,
  };
});

const breakEvenActualData = computed(() =>
  (data.index[ui.resolutionKey] || [])
    .filter((row) => Number.isFinite(row?.ts) && Number.isFinite(row?.index_price_close))
    .sort((a, b) => a.ts - b.ts)
    .slice(-maxPointsToFetch.value)
    .map((row) => ({
      date: new Date(row.ts * 1000),
      value: row.index_price_close,
      low: row.index_price_low,
      high: row.index_price_high,
    })),
);

const breakEvenProjectedData = computed(() => {
  const actual = breakEvenActualData.value;
  const expiryTs = selectedMaturityTs.value;
  if (!actual.length || !Number.isFinite(expiryTs)) return [];
  const lastActual = actual[actual.length - 1];
  const expiryDate = new Date(expiryTs * 1000);
  if (!(expiryDate > lastActual.date)) return [];
  return [
    { date: lastActual.date, value: lastActual.value },
    { date: expiryDate, value: lastActual.value },
  ];
});

const breakEvenCurrentIndex = computed(() => {
  const actual = breakEvenActualData.value;
  return actual.length ? actual[actual.length - 1].value : null;
});

const canSavePng = computed(() =>
  ui.mode === "straddle"
    ? mainSeries.value.length > 0
    : breakEvenActualData.value.length > 0,
);

const mainSeries = computed(() => {
  const index = data.index[ui.resolutionKey] || [];
  const callMark = data.callMark[ui.resolutionKey] || [];
  const putMark = data.putMark[ui.resolutionKey] || [];
  const callByTs = new Map();
  const putByTs = new Map();
  let callMinTs = null;
  let callMaxTs = null;
  let putMinTs = null;
  let putMaxTs = null;

  for (const row of callMark) {
    const ts = row?.ts;
    if (!Number.isFinite(ts)) continue;
    callByTs.set(ts, row);
    if (callMinTs == null || ts < callMinTs) callMinTs = ts;
    if (callMaxTs == null || ts > callMaxTs) callMaxTs = ts;
  }
  for (const row of putMark) {
    const ts = row?.ts;
    if (!Number.isFinite(ts)) continue;
    putByTs.set(ts, row);
    if (putMinTs == null || ts < putMinTs) putMinTs = ts;
    if (putMaxTs == null || ts > putMaxTs) putMaxTs = ts;
  }

  const result = [];
  for (const point of index) {
    const ts = point?.ts;
    if (!Number.isFinite(ts)) continue;
    if (ts * 1000 < MIN_DATA_DATE.getTime()) continue;
    if (
      Number.isFinite(callMinTs) &&
      Number.isFinite(callMaxTs) &&
      (ts < callMinTs || ts > callMaxTs)
    ) {
      continue;
    }
    if (
      Number.isFinite(putMinTs) &&
      Number.isFinite(putMaxTs) &&
      (ts < putMinTs || ts > putMaxTs)
    ) {
      continue;
    }

    const callPoint = callByTs.get(ts);
    const putPoint = putByTs.get(ts);
    if (!callPoint || !putPoint) continue;

    const straddleMark =
      Number.isFinite(callPoint.mark_price_close) &&
      Number.isFinite(putPoint.mark_price_close)
        ? callPoint.mark_price_close + putPoint.mark_price_close
        : null;
    if (!Number.isFinite(straddleMark)) continue;

    result.push({
      ...point,
      date: new Date(ts * 1000),
      iv_close: Number.isFinite(callPoint.iv_close) ? callPoint.iv_close : null,
      option_mark_price: straddleMark,
    });
  }
  return result.slice(-maxPointsToFetch.value);
});

const straddlePnlSeries = computed(() => {
  const callMark = data.callMark[ui.resolutionKey] || [];
  const putMark = data.putMark[ui.resolutionKey] || [];
  const index = data.index[ui.resolutionKey] || [];
  const callInstrument = selectedCallInstrument.value;
  const putInstrument = selectedPutInstrument.value;
  if (
    !callMark.length ||
    !putMark.length ||
    !index.length ||
    !callInstrument ||
    !putInstrument
  ) {
    return [];
  }

  const callSeries = computeGreeksPnlSeries({
    mark: callMark,
    index,
    instrument: callInstrument,
  });
  const putSeries = computeGreeksPnlSeries({
    mark: putMark,
    index,
    instrument: putInstrument,
  });
  if (!callSeries.length || !putSeries.length) return [];

  const sumNullable = (a, b) => {
    const hasA = Number.isFinite(a);
    const hasB = Number.isFinite(b);
    if (!hasA && !hasB) return null;
    return (hasA ? a : 0) + (hasB ? b : 0);
  };

  const putByTs = new Map(
    putSeries
      .filter((row) => row && Number.isFinite(row.ts))
      .map((row) => [row.ts, row]),
  );

  const merged = [];
  for (const callPoint of callSeries) {
    const ts = callPoint?.ts;
    if (!Number.isFinite(ts)) continue;
    const putPoint = putByTs.get(ts);
    if (!putPoint) continue;

    merged.push({
      ts,
      date: new Date(ts * 1000),
      PL: sumNullable(callPoint.PL, putPoint.PL),
      delta_PL: sumNullable(callPoint.delta_PL, putPoint.delta_PL),
      gamma_theta_PL: sumNullable(
        callPoint.gamma_theta_PL,
        putPoint.gamma_theta_PL,
      ),
      vega_PL: sumNullable(callPoint.vega_PL, putPoint.vega_PL),
      residual_PL: sumNullable(callPoint.residual_PL, putPoint.residual_PL),
    });
  }

  return merged
    .filter((point) => point.date >= MIN_DATA_DATE)
    .sort((a, b) => a.ts - b.ts)
    .slice(-maxPointsToFetch.value);
});

async function load({ callInstrument, putInstrument }) {
  if (!callInstrument && !putInstrument) return;
  const requestId = ++loadRequestId;

  ui.loading = true;
  ui.error = "";

  const { resolution, from, to } = getTimestampRange();
  const canUsePrefetchedIndex =
    prefetchedIndexForInitialLoad &&
    prefetchedIndexForInitialLoad.resolutionKey === ui.resolutionKey &&
    prefetchedIndexForInitialLoad.maxPoints === maxPointsToFetch.value;
  const prefetchedIndex = canUsePrefetchedIndex
    ? prefetchedIndexForInitialLoad.rows
    : null;
  if (canUsePrefetchedIndex) {
    prefetchedIndexForInitialLoad = null;
  }

  try {
    const indexName =
      callInstrument?.underlying || putInstrument?.underlying || underlying.value;
    const callName = callInstrument?.instrument_name || "";
    const putName = putInstrument?.instrument_name || "";

    const indexPromise = prefetchedIndex
      ? Promise.resolve(prefetchedIndex)
      : fetchIndexHistory({
          index_name: indexName,
          resolution,
          from,
          to,
          count: maxPointsToFetch.value,
        });

    const [mainIndex, callMark, putMark] = await Promise.all([
      indexPromise,
      callName
        ? fetchMarkHistory({
            instrument_name: callName,
            resolution,
            from,
            to,
            count: maxPointsToFetch.value,
          })
        : Promise.resolve([]),
      putName
        ? fetchMarkHistory({
            instrument_name: putName,
            resolution,
            from,
            to,
            count: maxPointsToFetch.value,
          })
        : Promise.resolve([]),
    ]);

    if (requestId !== loadRequestId) return;

    data.index[ui.resolutionKey] = mainIndex || [];
    data.callMark[ui.resolutionKey] = callMark || [];
    data.putMark[ui.resolutionKey] = putMark || [];
  } catch (e) {
    if (requestId !== loadRequestId) return;
    ui.error = e instanceof Error ? e.message : String(e);
    data.index = {};
    data.callMark = {};
    data.putMark = {};
  } finally {
    if (requestId === loadRequestId) {
      ui.loading = false;
    }
  }
}

function handleSavePng() {
  const base = optionInstrumentName.value || "straddle";
  const filenameBase = ui.resolutionKey ? `${base}-${ui.resolutionKey}` : base;
  if (ui.mode === "straddle") {
    if (!chartRef.value) return;
    chartRef.value.exportPng({ filename: `${filenameBase}.png` });
    return;
  }

  if (!breakEvenChartRef.value) return;
  breakEvenChartRef.value.exportPng({
    filename: `${filenameBase}-break-even.png`,
  });
}

const rebuildOptionInstruments = () => {
  data.optionInstruments = (allInstruments.value || [])
    .filter((i) => i?.type === "option" && i?.underlying === underlying.value)
    .map(normalizeOptionInstrument)
    .sort(
      (a, b) =>
        (a.expiration_ts || 0) - (b.expiration_ts || 0) ||
        (a.strike || 0) - (b.strike || 0),
    );
};

const switchUnderlying = async (next) => {
  if (next === underlying.value) return;
  if (!UNDERLYING_OPTIONS.some((opt) => opt.value === next)) return;
  loadRequestId += 1;
  ui.loading = true;
  ui.error = "";
  underlying.value = next;
  data.callMark = {};
  data.putMark = {};
  data.index = {};
  ui.optionMaturity = "";
  ui.optionStrike = "";
  prefetchedIndexForInitialLoad = null;
  isInitializing.value = true;
  try {
    rebuildOptionInstruments();
    const { resolution, from, to } = getTimestampRange();
    const prefetchedIndex = await fetchIndexHistory({
      index_name: next,
      resolution,
      from,
      to,
      count: maxPointsToFetch.value,
    });
    data.index[ui.resolutionKey] = prefetchedIndex || [];
    prefetchedIndexForInitialLoad = {
      resolutionKey: ui.resolutionKey,
      maxPoints: maxPointsToFetch.value,
      rows: prefetchedIndex || [],
    };

    const nowSeconds = Math.floor(Date.now() / 1000);
    const oneWeekAhead = nowSeconds + 7 * 24 * 60 * 60;
    const expiries = optionMaturities.value
      .map((option) => Number(option.value))
      .filter((ts) => Number.isFinite(ts));
    const upcomingExpiries = expiries.filter((ts) => ts > nowSeconds);
    const candidateExpiries = upcomingExpiries.length ? upcomingExpiries : expiries;
    const closestExpiry = candidateExpiries.reduce((best, ts) => {
      if (!Number.isFinite(best)) return ts;
      const bestDistance = Math.abs(best - oneWeekAhead);
      const currentDistance = Math.abs(ts - oneWeekAhead);
      return currentDistance < bestDistance ? ts : best;
    }, NaN);
    if (Number.isFinite(closestExpiry)) {
      ui.optionMaturity = String(closestExpiry);
    }
    const latestIndexClose = getLatestIndexClose(data.index[ui.resolutionKey]);
    ui.optionStrike = getDefaultStrikeValue({
      maturityInstruments: optionInstrumentsForMaturity.value,
      indexPrice: latestIndexClose,
      fallbackStrikes: optionStrikes.value,
    });
  } finally {
    isInitializing.value = false;
    ui.loading = false;
  }
};

onMounted(async () => {
  document.addEventListener("pointerdown", handleDocumentPointerDown);
  ui.loading = true;
  try {
    const { resolution, from, to } = getTimestampRange();
    const [fetchedInstruments, prefetchedIndex] = await Promise.all([
      fetchInstruments(),
      fetchIndexHistory({
        index_name: underlying.value,
        resolution,
        from,
        to,
        count: maxPointsToFetch.value,
      }),
    ]);

    allInstruments.value = fetchedInstruments || [];
    rebuildOptionInstruments();

    const nowSeconds = Math.floor(Date.now() / 1000);
    const oneWeekAhead = nowSeconds + 7 * 24 * 60 * 60;
    const expiries = optionMaturities.value
      .map((option) => Number(option.value))
      .filter((ts) => Number.isFinite(ts));
    const upcomingExpiries = expiries.filter((ts) => ts > nowSeconds);
    const candidateExpiries = upcomingExpiries.length ? upcomingExpiries : expiries;
    const closestExpiry = candidateExpiries.reduce((best, ts) => {
      if (!Number.isFinite(best)) return ts;
      const bestDistance = Math.abs(best - oneWeekAhead);
      const currentDistance = Math.abs(ts - oneWeekAhead);
      return currentDistance < bestDistance ? ts : best;
    }, NaN);
    if (Number.isFinite(closestExpiry)) {
      ui.optionMaturity = String(closestExpiry);
    }

    data.index[ui.resolutionKey] = prefetchedIndex || [];
    prefetchedIndexForInitialLoad = {
      resolutionKey: ui.resolutionKey,
      maxPoints: maxPointsToFetch.value,
      rows: prefetchedIndex || [],
    };

    const latestIndexClose = getLatestIndexClose(data.index[ui.resolutionKey]);
    ui.optionStrike = getDefaultStrikeValue({
      maturityInstruments: optionInstrumentsForMaturity.value,
      indexPrice: latestIndexClose,
      fallbackStrikes: optionStrikes.value,
    });
  } finally {
    isInitializing.value = false;
    ui.loading = false;
  }
});

onUnmounted(() => {
  document.removeEventListener("pointerdown", handleDocumentPointerDown);
  if (maxPointsDebounceTimer) clearTimeout(maxPointsDebounceTimer);
});

watch(requestedMaxPoints, (pointLimit) => {
  if (maxPointsDebounceTimer) clearTimeout(maxPointsDebounceTimer);
  maxPointsDebounceTimer = setTimeout(() => {
    maxPointsToFetch.value = pointLimit;
    maxPointsDebounceTimer = null;
  }, HISTORY_POINT_DEBOUNCE_MS);
});

watch(
  optionMaturities,
  (maturities) => {
    if (!maturities.length) {
      ui.optionMaturity = "";
      return;
    }
    const maturityValues = maturities.map((maturity) => maturity.value);
    if (maturityValues.includes(ui.optionMaturity)) return;
    const oldest = getOldestOptionInstrument(data.optionInstruments);
    ui.optionMaturity =
      oldest && Number.isFinite(oldest.expiration_ts)
        ? String(oldest.expiration_ts)
        : maturities[0].value;
  },
  { immediate: true },
);

watch(
  () => ui.optionMaturity,
  () => {
    if (isInitializing.value) return;
    const strikes = optionStrikes.value;
    if (!strikes.length) {
      ui.optionStrike = "";
      return;
    }
    const latestIndexClose = getLatestIndexClose(data.index[ui.resolutionKey] || []);
    ui.optionStrike = getClosestStrikeValue(strikes, latestIndexClose);
  },
);

watch(
  optionStrikes,
  (strikes) => {
    if (isInitializing.value) return;
    if (!strikes.length) {
      ui.optionStrike = "";
      return;
    }
    if (strikes.some((strike) => strike.value === ui.optionStrike)) return;
    const latestIndexClose = getLatestIndexClose(data.index[ui.resolutionKey] || []);
    ui.optionStrike = getClosestStrikeValue(strikes, latestIndexClose);
  },
  { immediate: true },
);

watch(
  () => [
    ui.resolutionKey,
    ui.optionMaturity,
    ui.optionStrike,
    maxPointsToFetch.value,
  ],
  async () => {
    const callInstrument = selectedCallInstrument.value;
    const putInstrument = selectedPutInstrument.value;
    if (!callInstrument && !putInstrument) return;
    await load({ callInstrument, putInstrument });
  },
  { immediate: false },
);
</script>

<template>
  <main class="app">
    <header class="topBar">
      <div class="wordmark">Straddle</div>
      <div class="divider"></div>
      <div class="controls">
        <div class="underlyingToggle" role="group" aria-label="Underlying">
          <button
            v-for="opt in UNDERLYING_OPTIONS"
            :key="opt.value"
            type="button"
            class="underlyingButton"
            :class="{ underlyingButtonActive: underlying === opt.value }"
            :disabled="ui.loading && underlying !== opt.value"
            @click="switchUnderlying(opt.value)"
          >
            {{ opt.label }}
          </button>
        </div>
        <div class="field">
          <label for="option-maturity">Maturity</label>
          <StyledSelectMenu
            id="option-maturity"
            v-model="ui.optionMaturity"
            label="Maturity"
            :options="optionMaturities"
          />
        </div>

        <div class="field">
          <label for="option-strike">Strike</label>
          <StyledSelectMenu
            id="option-strike"
            v-model="ui.optionStrike"
            label="Strike"
            :options="optionStrikes"
          />
        </div>

        <div class="field">
          <label for="resolution">Resolution</label>
          <StyledSelectMenu
            id="resolution"
            v-model="ui.resolutionKey"
            label="Resolution"
            :options="Object.entries(RESOLUTION_CONFIG).map(([value, config]) => ({ value, label: config.label }))"
          />
        </div>

        <div class="modeToggle" role="group" aria-label="Chart mode">
          <button
            type="button"
            class="modeToggleButton"
            :class="{ active: ui.mode === 'breakeven' }"
            @click="ui.mode = 'breakeven'"
          >
            Break-even
          </button>
          <button
            type="button"
            class="modeToggleButton"
            :class="{ active: ui.mode === 'straddle' }"
            @click="ui.mode = 'straddle'"
          >
            Straddle P&amp;L
          </button>
        </div>

        <button
          class="saveButton"
          type="button"
          @click="handleSavePng"
          :disabled="ui.loading || !canSavePng"
        >
          Save PNG
        </button>
      </div>
    </header>

    <div v-if="ui.error" class="error">{{ ui.error }}</div>

    <div class="chartPanel">
      <div class="settingsWrap settingsWrap--chart" ref="settingsMenuRef">
        <button
          ref="settingsButtonRef"
          class="settingsButton settingsButton--icon"
          type="button"
          title="Chart settings"
          aria-label="Chart settings"
          aria-haspopup="true"
          :aria-expanded="settingsOpen ? 'true' : 'false'"
          @click="toggleSettings"
        ></button>
        <div v-if="settingsOpen" class="settingsDropdown">
          <div class="settingsTitle">Chart settings</div>
          <div class="settingsHint">
            Historical data points: {{ requestedMaxPoints.toLocaleString() }}
          </div>
          <input
            v-model.number="ui.maxPoints"
            class="settingsSlider"
            type="range"
            aria-label="Historical data points"
            :min="MIN_HISTORY_POINT_LIMIT"
            :max="MAX_HISTORY_POINT_LIMIT"
            step="10"
          />
          <div class="settingsRange">
            <span>{{ MIN_HISTORY_POINT_LIMIT }}</span>
            <span>{{ MAX_HISTORY_POINT_LIMIT }}</span>
          </div>
          <template v-if="ui.mode === 'straddle'">
            <div class="settingsHint settingsHint--secondary">
              Circle size: {{ chartCircleSize.toFixed(1) }}
            </div>
            <input
              v-model.number="ui.circleSize"
              class="settingsSlider"
              type="range"
              aria-label="Chart circle size"
              :min="MIN_CIRCLE_SIZE"
              :max="MAX_CIRCLE_SIZE"
              step="0.5"
            />
            <div class="settingsRange">
              <span>{{ MIN_CIRCLE_SIZE }}</span>
              <span>{{ MAX_CIRCLE_SIZE }}</span>
            </div>
          </template>
        </div>
      </div>

      <OptionPnlChart
        v-if="ui.mode === 'straddle'"
        ref="chartRef"
        :data="mainSeries"
        :option-pnl-data="straddlePnlSeries"
        :option-instrument-name="optionInstrumentName"
        :circle-size="chartCircleSize"
        :loading="ui.loading"
      />
      <StraddleBreakEvenChart
        v-else
        ref="breakEvenChartRef"
        :actual-data="breakEvenActualData"
        :projected-data="breakEvenProjectedData"
        :break-even-low="breakEvenMetrics?.breakEvenLow"
        :break-even-high="breakEvenMetrics?.breakEvenHigh"
        :current-index="breakEvenCurrentIndex"
        :expiry-ts="selectedMaturityTs"
        :title="breakEvenTitle"
        :subtitle="breakEvenSubtitle"
        :loading="ui.loading"
      />
    </div>
  </main>
</template>

<style scoped>
:global(:root) {
  --color-bg: #0a0b0e;
  --color-surface: #131316;
  --color-text: #e8eaed;
  --color-text-muted: #70767d;
  --color-accent: #7dd3fc;
  --color-border-subtle: rgba(255, 255, 255, 0.06);
  --color-border: rgba(255, 255, 255, 0.09);
  --color-border-strong: rgba(255, 255, 255, 0.2);
}

:global(body) {
  min-width: 320px;
  background: var(--color-bg);
  color: var(--color-text);
  font-family: "Helvetica Neue", Helvetica, -apple-system, sans-serif;
  color-scheme: dark;
}

.app {
  width: 100%;
  max-width: none;
  min-height: 100vh;
  margin: 0;
  padding: 0;
  background: var(--color-bg);
}

.topBar {
  display: flex;
  align-items: center;
  min-height: 58px;
  padding: 9px 28px;
  border-bottom: 1px solid var(--color-border-subtle);
  gap: 20px;
}

.wordmark {
  flex: none;
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text);
}

.divider {
  flex: none;
  width: 1px;
  height: 20px;
  background: rgba(255, 255, 255, 0.08);
}

.controls {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  margin: 0;
}

.field,
.underlyingToggle,
.modeToggle {
  height: 36px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: transparent;
}

.field:hover,
.underlyingToggle:hover,
.modeToggle:hover {
  border-color: var(--color-border-strong);
}

.field {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 0 12px;
}

.field label {
  color: var(--color-text-muted);
  font-size: 12px;
}

.chartPanel {
  position: relative;
  min-height: 620px;
  margin: 10px 36px 16px 28px;
  border: 1px solid #23232a;
  border-radius: 8px;
  background: #08080a;
  overflow: hidden;
}

.settingsWrap {
  position: relative;
}

.settingsWrap--chart {
  position: absolute;
  top: 12px;
  right: 14px;
  z-index: 24;
}

.settingsButton {
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  box-shadow: none;
}

.settingsButton:hover {
  background: rgba(255, 255, 255, 0.05);
  color: var(--color-accent);
}

.settingsButton:focus-visible {
  outline: 1px solid rgba(255, 255, 255, 0.7);
  outline-offset: 2px;
}

.settingsButton--icon {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  line-height: 1;
}

.settingsButton--icon::before {
  content: "";
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: #e8ebf2;
}

.settingsDropdown {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  width: min(240px, calc(100vw - 40px));
  border: 1px solid rgba(255, 255, 255, 0.15);
  background: var(--color-bg);
  border-radius: 8px;
  padding: 10px 12px 12px;
  box-shadow: 0 10px 26px rgba(0, 0, 0, 0.35);
  z-index: 20;
  color: #a9abb6;
  font-size: 10px;
  font-weight: 600;
  font-family:
    ui-sans-serif,
    system-ui,
    -apple-system,
    Segoe UI,
    Roboto,
    Helvetica,
    Arial,
    sans-serif;
}

.settingsTitle {
  font-size: 10px;
  color: #a9abb6;
  font-weight: 700;
  margin-bottom: 10px;
}

.settingsHint {
  color: #a9abb6;
  font-size: 10px;
  font-weight: 600;
  margin-bottom: 6px;
}

.settingsHint--secondary {
  margin-top: 10px;
}

.settingsSlider {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  height: 14px;
  background: transparent;
  cursor: pointer;
}

.settingsSlider:focus {
  outline: none;
}

.settingsSlider::-webkit-slider-runnable-track {
  height: 2px;
  background: rgba(245, 245, 245, 0.45);
  border-radius: 999px;
}

.settingsSlider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 8px;
  height: 8px;
  margin-top: -3px;
  border-radius: 50%;
  border: none;
  background: #f5f5f7;
}

.settingsSlider::-moz-range-track {
  height: 2px;
  background: rgba(245, 245, 245, 0.45);
  border-radius: 999px;
}

.settingsSlider::-moz-range-thumb {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  border: none;
  background: #f5f5f7;
}

.settingsRange {
  margin-top: 4px;
  display: flex;
  justify-content: space-between;
  color: #a9abb6;
  font-size: 10px;
  font-weight: 600;
}

.underlyingToggle {
  display: inline-flex;
  overflow: hidden;
}

.underlyingButton {
  border: 0;
  background: transparent;
  color: var(--color-text-muted);
  font-size: 12px;
  padding: 0 13px;
  cursor: pointer;
  height: 100%;
}

.underlyingButton + .underlyingButton {
  border-left: 1px solid var(--color-border);
}

.underlyingButton:disabled {
  cursor: default;
  opacity: 0.5;
}

.underlyingButtonActive {
  background: rgba(255, 255, 255, 0.08);
  color: var(--color-text);
  font-weight: 500;
}

.modeToggle {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
}

.modeToggleButton {
  height: 30px;
  padding: 0 12px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--color-text-muted);
  font: inherit;
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
}

.modeToggleButton + .modeToggleButton {
  border-left: 0;
}

.modeToggleButton.active {
  background: rgba(255, 255, 255, 0.1);
  color: var(--color-text);
}

.saveButton {
  height: 30px;
  padding: 0 12px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 6px;
  background: transparent;
  color: var(--color-text-muted);
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}

.saveButton:hover:not(:disabled) {
  border-color: rgba(125, 211, 252, 0.3);
  color: var(--color-accent);
  background: rgba(255, 255, 255, 0.03);
}

.saveButton:disabled {
  opacity: 0.4;
  cursor: default;
}

.error {
  margin: 10px 28px 0;
  color: #f87171;
  font-size: 12px;
}

@media (max-width: 1080px) {
  .topBar {
    align-items: flex-start;
    flex-wrap: wrap;
  }

  .controls {
    flex: 1 0 100%;
    flex-wrap: wrap;
  }
}

@media (max-width: 640px) {
  .topBar {
    padding: 12px 16px;
    gap: 12px;
  }

  .chartPanel {
    margin: 8px;
    min-height: 0;
  }
}
</style>
