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
import BreakEvenChart from "./components/BreakEvenChart.vue";
import StyledSelectMenu from "../../../lib/components/StyledSelectMenu.vue";
import {
  calcGreeks,
  fetchIndexHistory as fetchIndexHistoryRaw,
  fetchInstruments as fetchInstrumentsRaw,
  fetchMarkHistory,
} from "../../../lib/thalex.js";

import { createHistoryRequester } from "./lib/historyRequests.js";
import { fetchIndexHistoryInChunks } from "./lib/indexHistory.js";
import { findSameStrikeInstrument } from "./lib/trackSelection.js";

const requestHistory = createHistoryRequester();
const fetchIndexHistory = (params) => {
  const requestId = loadRequestId;
  return fetchIndexHistoryInChunks(params, chunk => requestHistory(
    () => fetchIndexHistoryRaw({ ...chunk, requestOptions: { maxRetries: 0, timeoutMs: 45000 } }),
    { isCanceled: () => requestId !== loadRequestId, cacheKey: JSON.stringify(["index", chunk]) },
  ));
};
const fetchInstruments = () => requestHistory(() => fetchInstrumentsRaw());

const RESOLUTION_CONFIG = {
  900: { label: "15m", resolution: "15m", interval_seconds: 15 * 60 },
  3600: { label: "1h", resolution: "1h", interval_seconds: 60 * 60 },
  86400: { label: "1d", resolution: "1d", interval_seconds: 24 * 60 * 60 },
};
const DEFAULT_LOOKBACK_POINT_LIMIT = 360;
const DEFAULT_PRICE_LOOKBACK_POINT_LIMIT = 800;
const MIN_LOOKBACK_POINT_LIMIT = 120;
const MAX_LOOKBACK_POINT_LIMIT = 1440;
const MAX_HOURLY_LOOKBACK_POINT_LIMIT = 10000;
const SECONDS_PER_DAY = 24 * 60 * 60;
const MARK_HISTORY_REQUEST_POINT_LIMIT = 360;
const MAX_ABS_DELTA = 0.55;

const UNDERLYING_OPTIONS = [
  { value: "BTCUSD", label: "BTC" },
  { value: "ETHUSD", label: "ETH" },
];

const ui = reactive({
  resolutionKey: "3600",
  optionMaturity: "",
  instrumentMaxPoints: DEFAULT_LOOKBACK_POINT_LIMIT,
  priceMaxPoints: DEFAULT_PRICE_LOOKBACK_POINT_LIMIT,
  loading: false,
  error: "",
});

const nowTs = ref(Math.floor(Date.now() / 1000));
const selectedMaturityTs = computed(() => Number(ui.optionMaturity));
const defaultPriceResolution = computed(() => {
  const secondsToExpiry = selectedMaturityTs.value - nowTs.value;
  return secondsToExpiry > 0 && secondsToExpiry < 7 * SECONDS_PER_DAY ? "3600" : "86400";
});
const underlying = ref("BTCUSD");
const selectedInstrument = ref(null);
const detailView = ref("break-even");
const overviewMetric = ref("break-even");
const overviewPriceActive = computed(() => !selectedInstrument.value);
const lastIntradayResolution = ref(ui.resolutionKey);
const priceViewActive = computed(() =>
  overviewPriceActive.value || (!!selectedInstrument.value && detailView.value === "break-even"),
);
const availableResolutionKeys = computed(() =>
  Object.keys(RESOLUTION_CONFIG).filter(key => key !== "86400" || priceViewActive.value),
);
watch(() => ui.resolutionKey, key => {
  if (key !== "86400") lastIntradayResolution.value = key;
}, { flush: "sync" });
watch([priceViewActive, overviewPriceActive, () => ui.optionMaturity, defaultPriceResolution], ([active]) => {
  if (active) {
    ui.resolutionKey = defaultPriceResolution.value;
  } else if (ui.resolutionKey === "86400") {
    ui.resolutionKey = lastIntradayResolution.value;
  }
}, { flush: "sync" });
const maxLookbackPointLimit = computed(() => ui.resolutionKey === "3600"
  ? MAX_HOURLY_LOOKBACK_POINT_LIMIT
  : MAX_LOOKBACK_POINT_LIMIT,
);
const historyPointLimit = computed({
  get: () => Math.min(maxLookbackPointLimit.value, priceViewActive.value
    ? ui.priceMaxPoints
    : ui.instrumentMaxPoints),
  set: value => {
    if (priceViewActive.value) ui.priceMaxPoints = value;
    else ui.instrumentMaxPoints = value;
  },
});
const allInstruments = ref([]);
const data = reactive({
  optionInstruments: [],
  index: {},
  markByInstrument: {},
});
const selectedOption = computed(() => data.optionInstruments.find(
  instrument => instrument.instrument_name === selectedInstrument.value,
));

const chartRef = ref(null);
const settingsMenuRef = ref(null);
const settingsButtonRef = ref(null);
const settingsOpen = ref(false);
const isInitializing = ref(true);
let loadRequestId = 0;
let nowTimer = null;

const maturityFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "2-digit",
  year: "2-digit",
  timeZone: "UTC",
});

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

const maxPointsToFetch = computed(() => {
  const value = Math.floor(Number(historyPointLimit.value));
  if (!Number.isFinite(value)) return DEFAULT_LOOKBACK_POINT_LIMIT;
  return Math.max(
    MIN_LOOKBACK_POINT_LIMIT,
    Math.min(maxLookbackPointLimit.value, value),
  );
});

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

const getLatestIndexPoint = (rows) => {
  if (!Array.isArray(rows) || !rows.length) return null;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (Number.isFinite(row?.ts) && Number.isFinite(row?.index_price_close)) {
      return row;
    }
  }
  return null;
};

const latestMarkValue = (row, fields) => {
  for (const field of fields) {
    const value = row?.[field];
    if (Number.isFinite(value)) return value;
  }
  return null;
};

const getLatestMarkSnapshot = (rows) => {
  if (!Array.isArray(rows) || !rows.length) return null;
  let latestIv = null;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    const iv = latestMarkValue(row, ["iv_close", "iv_open"]);
    if (Number.isFinite(iv)) {
      latestIv = iv;
      break;
    }
  }

  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    const ts = Number(row?.ts);
    const mark = Number(row?.mark_price_close);
    if (!Number.isFinite(ts) || !Number.isFinite(mark)) continue;
    const iv = latestMarkValue(row, ["iv_close", "iv_open"]);
    return {
      ts,
      mark,
      iv: Number.isFinite(iv) ? iv : latestIv,
    };
  }
  return null;
};

const getIntrinsicAtSpot = (optionType, strike, spot) => {
  if (optionType === "put") return Math.max(strike - spot, 0);
  return Math.max(spot - strike, 0);
};

const evolveMarkWithTheta = ({
  mark,
  optionType,
  strike,
  spot,
  iv,
  fromTs,
  toTs,
  expiryTs,
}) => {
  if (
    !Number.isFinite(mark) ||
    !Number.isFinite(fromTs) ||
    !Number.isFinite(toTs) ||
    !Number.isFinite(expiryTs)
  ) {
    return null;
  }

  const intrinsic = getIntrinsicAtSpot(optionType, strike, spot);
  let currentMark = Math.max(mark, intrinsic);
  let ts = fromTs;

  while (ts < toTs) {
    const remaining = expiryTs - ts;
    if (remaining <= 0) {
      currentMark = intrinsic;
      break;
    }

    const dtSeconds = Math.min(toTs - ts, remaining);
    let decay = null;

    if (Number.isFinite(iv) && iv > 0) {
      const theta = calcGreeks(
        spot,
        strike,
        Math.max(remaining, 1),
        iv,
        optionType,
      )?.theta;
      if (Number.isFinite(theta)) {
        decay = theta * (dtSeconds / SECONDS_PER_DAY);
      }
    }

    if (!Number.isFinite(decay)) {
      decay = ((intrinsic - currentMark) * dtSeconds) / remaining;
    }

    currentMark += decay;
    if (!Number.isFinite(currentMark) || currentMark < intrinsic) {
      currentMark = intrinsic;
    }
    ts += dtSeconds;
  }

  return Math.max(currentMark, intrinsic);
};

const buildHistoricalBreakEvenPoints = ({
  markRows,
  optionType,
  strike,
  spot,
  maxTs,
}) => {
  return (markRows || [])
    .filter(
      (row) =>
        Number.isFinite(row?.ts) &&
        Number.isFinite(row?.mark_price_close) &&
        row.ts <= maxTs,
    )
    .sort((a, b) => a.ts - b.ts)
    .map((row) => {
      const mark = row.mark_price_close;
      const rowIv = latestMarkValue(row, ["iv_close", "iv_open"]);
      const breakEven = optionType === "put" ? strike - mark : strike + mark;
      const move = breakEven - spot;
      return {
        ts: row.ts,
        date: new Date(row.ts * 1000),
        mark,
        iv: Number.isFinite(rowIv) ? rowIv : null,
        breakEven,
        move,
        movePct: spot !== 0 ? move / spot : null,
      };
    });
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

const optionInstrumentsForMaturity = computed(() => {
  const maturityTs = selectedMaturityTs.value;
  const byStrikeAndType = new Map();

  for (const instrument of data.optionInstruments) {
    if (instrument?.expiration_ts !== maturityTs) continue;
    const strike = instrument?.strike;
    const optionType = instrument?.option_type_normalized;
    if (!Number.isFinite(strike)) continue;
    if (optionType !== "call" && optionType !== "put") continue;

    const key = `${optionType}:${strike}`;
    const existing = byStrikeAndType.get(key);
    if (!existing) {
      byStrikeAndType.set(key, instrument);
      continue;
    }

    const candidateCreated = Number(instrument?.create_time_s);
    const existingCreated = Number(existing?.create_time_s);
    if (
      Number.isFinite(candidateCreated) &&
      (!Number.isFinite(existingCreated) || candidateCreated < existingCreated)
    ) {
      byStrikeAndType.set(key, instrument);
    }
  }

  return Array.from(byStrikeAndType.values()).sort((a, b) => a.strike - b.strike);
});

const currentIndexRows = computed(() => data.index[ui.resolutionKey] || []);

const latestIndexPoint = computed(() => getLatestIndexPoint(currentIndexRows.value));
const latestSpot = computed(() => latestIndexPoint.value?.index_price_close ?? null);
const latestSpotTs = computed(() => latestIndexPoint.value?.ts ?? null);
const chartIndexData = computed(() =>
  (currentIndexRows.value || [])
    .filter(
      (row) =>
        Number.isFinite(row?.ts) && Number.isFinite(row?.index_price_close),
    )
    .sort((a, b) => a.ts - b.ts)
    .map((row) => ({
      ts: row.ts,
      date: new Date(row.ts * 1000),
      value: row.index_price_close,
      low: row.index_price_low,
      high: row.index_price_high,
    })),
);
const chartIndexProjectedData = computed(() => {
  const actual = chartIndexData.value;
  const expiryTs = selectedMaturityTs.value;
  if (!actual.length || !Number.isFinite(expiryTs)) return [];
  const last = actual[actual.length - 1];
  const expiryDate = new Date(expiryTs * 1000);
  if (!(expiryDate > last.date)) return [];
  return [
    { ts: last.ts, date: last.date, value: last.value },
    { ts: expiryTs, date: expiryDate, value: last.value },
  ];
});

const breakEvenTracks = computed(() => {
  const expiryTs = selectedMaturityTs.value;
  const spot = latestSpot.value;
  const spotTs = latestSpotTs.value;
  if (
    !Number.isFinite(expiryTs) ||
    !Number.isFinite(spot) ||
    !Number.isFinite(spotTs)
  ) {
    return [];
  }

  const tracks = [];

  for (const instrument of optionInstrumentsForMaturity.value) {
    const optionType = instrument.option_type_normalized;
    const strike = instrument.strike;
    const instrumentName = instrument.instrument_name;
    const markRows = data.markByInstrument[instrumentName] || [];
    const snapshot = getLatestMarkSnapshot(markRows);
    if (!snapshot) continue;

    const anchorTs = Math.max(spotTs, snapshot.ts);
    if (!Number.isFinite(anchorTs) || anchorTs > expiryTs) continue;
    const tteSeconds = Math.max(expiryTs - anchorTs, 1);
    const delta = calcGreeks(
      spot,
      strike,
      tteSeconds,
      snapshot.iv,
      optionType,
    )?.delta;
    const isSelected = instrumentName === selectedInstrument.value;
    if (!isSelected && (!Number.isFinite(delta) || Math.abs(delta) >= MAX_ABS_DELTA)) continue;
    const isOutOfMoney =
      optionType === "call" ? strike >= spot : strike <= spot;
    if (!isSelected && !isOutOfMoney) continue;

    // Price context displays the latest observed premium, without forecasting
    // its decay or loading an option's entire history.
    if (overviewPriceActive.value) {
      tracks.push({
        instrumentName,
        optionType,
        strike,
        referenceIv: snapshot.iv,
        currentBreakEven: optionType === "put" ? strike - snapshot.mark : strike + snapshot.mark,
        points: [],
      });
      continue;
    }

    let markAtAnchor = snapshot.mark;
    if (snapshot.ts < anchorTs) {
      markAtAnchor = evolveMarkWithTheta({
        mark: snapshot.mark,
        optionType,
        strike,
        spot,
        iv: snapshot.iv,
        fromTs: snapshot.ts,
        toTs: anchorTs,
        expiryTs,
      });
    }
    if (!Number.isFinite(markAtAnchor)) continue;

    const points = buildHistoricalBreakEvenPoints({
      markRows,
      optionType,
      strike,
      spot,
      maxTs: anchorTs,
    });

    tracks.push({
      instrumentName,
      optionType,
      strike,
      referenceIv: snapshot.iv,
      currentBreakEven: optionType === "put" ? strike - markAtAnchor : strike + markAtAnchor,
      points,
    });
  }

  return tracks.sort((a, b) => {
    if (a.strike !== b.strike) return a.strike - b.strike;
    if (a.optionType === b.optionType) return 0;
    return a.optionType === "call" ? -1 : 1;
  });
});

const maturitySnapshots = computed(() => {
  const snapshots = [];
  for (const instrument of optionInstrumentsForMaturity.value) {
    const snapshot = getLatestMarkSnapshot(data.markByInstrument[instrument.instrument_name]);
    if (!snapshot || !Number.isFinite(snapshot.mark)) continue;
    snapshots.push({
      instrumentName: instrument.instrument_name,
      optionType: instrument.option_type_normalized,
      strike: instrument.strike,
      mark: snapshot.mark,
      iv: Number.isFinite(snapshot.iv) ? snapshot.iv : null,
    });
  }
  return snapshots;
});

const priceHistoryLabel = computed(() => ({ 900: "15-Minute", 3600: "Hourly", 86400: "Daily" })[ui.resolutionKey]);
const breakEvenTitle = computed(() => `${underlying.value.slice(0, 3)} Latest ${overviewMetric.value === "awp" ? "AWPs" : "Break-Evens"} and ${priceHistoryLabel.value} Price History`);
const breakEvenSubtitle = computed(() => {
  const expiryTs = selectedMaturityTs.value;
  if (!Number.isFinite(expiryTs)) return "";
  const resolutionLabel = overviewPriceActive.value
    ? `${RESOLUTION_CONFIG[ui.resolutionKey]?.label} · ${maxPointsToFetch.value} price points · Latest option marks`
    : RESOLUTION_CONFIG[ui.resolutionKey]?.label || "";
  return `Expiry: ${maturityFormatter.format(new Date(expiryTs * 1000))} UTC | Resolution: ${resolutionLabel} | OTM, |delta| < ${MAX_ABS_DELTA.toFixed(2)}`;
});

const canSavePng = computed(() => breakEvenTracks.value.length > 0);

async function fetchMarkHistoriesByInstrument({
  instruments,
  resolution,
  intervalSeconds,
  from,
  to,
  requestId,
  onInstrumentRows = null,
}) {
  const queue = (instruments || []).filter(
    (instrument) => typeof instrument?.instrument_name === "string",
  );

  if (!queue.length) {
    return { rowsByInstrument: {} };
  }

  const rowsByInstrument = {};
  let cursor = 0;
  const chunkSpanSeconds =
    Math.max(1, MARK_HISTORY_REQUEST_POINT_LIMIT - 1) *
    Math.max(1, Math.floor(Number(intervalSeconds) || 1));

  const buildChunkRanges = () => {
    const ranges = [];
    let chunkFrom = from;
    while (chunkFrom <= to) {
      const chunkTo = Math.min(to, chunkFrom + chunkSpanSeconds);
      ranges.push([chunkFrom, chunkTo]);
      if (chunkTo >= to) break;
      chunkFrom = chunkTo + Math.max(1, Math.floor(Number(intervalSeconds) || 1));
    }
    return ranges;
  };

  const fetchInstrumentRows = async (instrumentName) => {
    const ranges = buildChunkRanges();
    const mergedRows = [];

    for (const [chunkFrom, chunkTo] of ranges) {
      const fetchedRows = await requestHistory(
        () => fetchMarkHistory({
          instrument_name: instrumentName,
          resolution,
          from: chunkFrom,
          to: chunkTo,
          count: Math.min(MARK_HISTORY_REQUEST_POINT_LIMIT,
            Math.floor((chunkTo - chunkFrom) / intervalSeconds) + 1),
          requestOptions: { timeoutMs: 45000, maxRetries: 0 },
        }),
        {
          isCanceled: () => requestId !== loadRequestId,
          cacheKey: JSON.stringify(["mark", instrumentName, resolution, chunkFrom, chunkTo]),
        },
      );

      if (requestId !== loadRequestId) return [];

      if (Array.isArray(fetchedRows) && fetchedRows.length) {
        mergedRows.push(...fetchedRows);
      }
    }

    return mergedRows
      .filter((row) => Number.isFinite(row?.ts))
      .sort((a, b) => a.ts - b.ts)
      .filter((row, index, rows) => {
        if (index === 0) return true;
        return row.ts !== rows[index - 1].ts;
      });
  };

  const worker = async () => {
    while (cursor < queue.length) {
      if (requestId !== loadRequestId) return;
      const currentIndex = cursor;
      cursor += 1;
      const instrument = queue[currentIndex];
      const instrumentName = instrument.instrument_name;

      let rows = [];
      try {
        const fetchedRows = await fetchInstrumentRows(instrumentName);
        rows = Array.isArray(fetchedRows) ? fetchedRows : [];
        if (requestId !== loadRequestId) return;
      } catch (error) {
        if (requestId !== loadRequestId) return;
        throw new Error(`Incomplete data: failed to load ${instrumentName}: ${error.message}`, { cause: error });
      }

      rowsByInstrument[instrumentName] = rows;
      onInstrumentRows?.(rows, {
        instrumentName,
        index: currentIndex,
        total: queue.length,
      });
    }
  };

  await worker();
  return { rowsByInstrument };
}

async function load() {
  const maturityTs = selectedMaturityTs.value;
  if (!Number.isFinite(maturityTs)) return;

  const requestId = ++loadRequestId;
  ui.loading = true;
  ui.error = "";

  const instrumentName = selectedInstrument.value;
  const maturityInstruments = instrumentName
    ? optionInstrumentsForMaturity.value.filter(instrument => instrument.instrument_name === instrumentName)
    : optionInstrumentsForMaturity.value;
  if (instrumentName && !maturityInstruments.length) {
    ui.error = "The selected strike and option type are unavailable for this maturity. Choose another maturity or return to price context.";
    ui.loading = false;
    return;
  }
  const { resolution, from, to } = getTimestampRange();
  // Index price history and recent option marks have different lookbacks.
  const markConfig = RESOLUTION_CONFIG[overviewPriceActive.value ? lastIntradayResolution.value : ui.resolutionKey];
  const markTo = overviewPriceActive.value
    ? Math.floor(Date.now() / 1000 / markConfig.interval_seconds) * markConfig.interval_seconds
    : to;
  const markFrom = overviewPriceActive.value
    ? markTo - 23 * markConfig.interval_seconds
    : from;
  try {
    const indexRows = await fetchIndexHistory({
      index_name: underlying.value,
      resolution,
      from,
      to,
      count: maxPointsToFetch.value,
    });

    if (requestId !== loadRequestId) return;
    const normalizedIndexRows = Array.isArray(indexRows) ? indexRows : [];
    data.index[ui.resolutionKey] = normalizedIndexRows;
    if (!instrumentName) data.markByInstrument = {};

    const { rowsByInstrument } =
      await fetchMarkHistoriesByInstrument({
        instruments: maturityInstruments,
        resolution: markConfig.resolution,
        intervalSeconds: markConfig.interval_seconds,
        from: markFrom,
        to: markTo,
        requestId,
        onInstrumentRows: (rows, { instrumentName }) => {
          if (requestId !== loadRequestId) return;
          data.markByInstrument[instrumentName] = rows;
        },
      });

    if (requestId !== loadRequestId) return;

    data.markByInstrument = instrumentName
      ? { ...data.markByInstrument, ...rowsByInstrument }
      : rowsByInstrument || {};

  } catch (error) {
    if (requestId !== loadRequestId) return;
    ui.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (requestId === loadRequestId) {
      ui.loading = false;
    }
  }
}

function handleSavePng() {
  if (!chartRef.value) return;
  const expiryTs = selectedMaturityTs.value;
  const datePart = Number.isFinite(expiryTs)
    ? new Date(expiryTs * 1000).toISOString().slice(0, 10)
    : "expiry";
  chartRef.value.exportPng({
    filename: `break-even-${underlying.value}-${datePart}-${ui.resolutionKey}.png`,
  });
}

const rebuildOptionInstruments = () => {
  data.optionInstruments = (allInstruments.value || [])
    .filter((instrument) => instrument?.type === "option")
    .filter((instrument) => instrument?.underlying === underlying.value)
    .map(normalizeOptionInstrument)
    .sort(
      (a, b) =>
        (a.expiration_ts || 0) - (b.expiration_ts || 0) ||
        (a.strike || 0) - (b.strike || 0),
    );
};

const pickDefaultMaturity = () => {
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
  return Number.isFinite(closestExpiry) ? String(closestExpiry) : "";
};

const switchUnderlying = async (next) => {
  if (next === underlying.value) return;
  if (!UNDERLYING_OPTIONS.some((opt) => opt.value === next)) return;
  loadRequestId += 1;
  underlying.value = next;
  data.index = {};
  data.markByInstrument = {};
  ui.optionMaturity = "";
  isInitializing.value = true;
  try {
    rebuildOptionInstruments();
    ui.optionMaturity = pickDefaultMaturity();
  } catch (error) {
    ui.error = `Unable to load complete data: ${error.message}`;
  } finally {
    await nextTick();
    isInitializing.value = false;
    if (ui.optionMaturity) {
      await load();
    }
  }
};

onMounted(async () => {
  nowTs.value = Math.floor(Date.now() / 1000);
  nowTimer = window.setInterval(() => {
    nowTs.value = Math.floor(Date.now() / 1000);
  }, 30_000);

  document.addEventListener("pointerdown", handleDocumentPointerDown);
  try {
    allInstruments.value = await fetchInstruments() || [];
    rebuildOptionInstruments();
    ui.optionMaturity = pickDefaultMaturity();
  } catch (error) {
    ui.error = `Unable to load complete data: ${error.message}`;
  } finally {
    await nextTick();
    isInitializing.value = false;
    if (ui.optionMaturity) {
      await load();
    }
  }
});

onUnmounted(() => {
  loadRequestId += 1;
  document.removeEventListener("pointerdown", handleDocumentPointerDown);
  if (nowTimer) {
    window.clearInterval(nowTimer);
    nowTimer = null;
  }
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
  underlying,
  () => { selectedInstrument.value = null; },
  { flush: "sync" },
);

watch(() => ui.optionMaturity, () => {
  if (!selectedInstrument.value) return;
  const matchingInstrument = findSameStrikeInstrument(selectedOption.value, optionInstrumentsForMaturity.value);
  // Keep the selection intent if this expiry has no matching strike, so a
  // subsequent maturity change can find it without returning to the overview.
  if (matchingInstrument) selectedInstrument.value = matchingInstrument.instrument_name;
}, { flush: "sync" });

watch(selectedInstrument, (instrumentName, previous) => {
  if (instrumentName && !previous) detailView.value = "break-even";
}, { flush: "sync" });

watch(
  () => [ui.resolutionKey, ui.optionMaturity, maxPointsToFetch.value, selectedInstrument.value],
  async () => {
    if (isInitializing.value) return;
    if (!ui.optionMaturity) return;
    await load();
  },
  { immediate: false },
);
</script>

<template>
  <div class="app">
    <header class="header">
      <div class="titleRow">
        <h1>Break-even Analyzer</h1>
      </div>

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
          <label for="resolution">Resolution</label>
          <StyledSelectMenu
            id="resolution"
            v-model="ui.resolutionKey"
            label="Resolution"
            :options="availableResolutionKeys.map(value => ({ value, label: RESOLUTION_CONFIG[value].label }))"
          />
        </div>

        <div v-if="overviewPriceActive" class="overviewToggle" role="group" aria-label="Main chart price levels">
          <button type="button" :aria-pressed="overviewMetric === 'break-even'" @click="overviewMetric = 'break-even'">Break-even prices</button>
          <button type="button" :aria-pressed="overviewMetric === 'awp'" @click="overviewMetric = 'awp'">Average win prices</button>
        </div>

        <span v-if="overviewPriceActive" class="overviewHint">
          Click a line or label to explore.
        </span>

        <div class="controlsSpacer" />

        <button
          class="saveButton"
          type="button"
          @click="handleSavePng"
          :disabled="ui.loading || !!ui.error || !canSavePng"
        >
          Save PNG
        </button>

        <div class="settingsWrap" ref="settingsMenuRef">
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
              Historic data points{{ overviewPriceActive ? ' (index)' : selectedInstrument ? ' (selected instrument and index)' : '' }}: {{ maxPointsToFetch }}
            </div>
            <input
              v-model.number="historyPointLimit"
              class="settingsSlider"
              type="range"
              aria-label="Historic data points"
              :min="MIN_LOOKBACK_POINT_LIMIT"
              :max="maxLookbackPointLimit"
              step="10"
            />
            <div class="settingsRange">
              <span>{{ MIN_LOOKBACK_POINT_LIMIT }}</span>
              <span>{{ maxLookbackPointLimit.toLocaleString('en-US') }}</span>
            </div>
          </div>
        </div>
      </div>

      <div v-if="ui.error" class="error">{{ ui.error }}</div>
    </header>

    <div class="chartWrap">
      <BreakEvenChart
        ref="chartRef"
        v-model:selected-instrument="selectedInstrument"
        v-model:detail-view="detailView"
        :selected-option="selectedOption"
        :overview-metric="overviewMetric"
        :tracks="breakEvenTracks"
        :maturity-snapshots="maturitySnapshots"
        :index-data="chartIndexData"
        :index-projected-data="chartIndexProjectedData"
        :spot-price="latestSpot"
        :spot-ts="latestSpotTs"
        :expiry-ts="selectedMaturityTs"
        :current-ts="nowTs"
        :title="breakEvenTitle"
        :subtitle="breakEvenSubtitle"
        :loading="ui.loading"
      />
    </div>
  </div>
</template>

<style scoped>
.overviewHint {
  align-self: center;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.4;
  max-width: 260px;
}

@media (min-width: 960px) {
  .app {
    max-width: none;
    height: 100dvh;
    min-height: 680px;
    display: flex;
    flex-direction: column;
    padding: 12px 10px 14px;
  }

  .header { flex-shrink: 0; margin-bottom: 10px; }

  .app > .chartWrap {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }
}

.chartWrap {
  position: relative;
}

.controlsSpacer { flex: 1; }

.overviewToggle {
  display: flex;
  gap: 3px;
  padding: 3px;
  border: 1px solid #414751;
  border-radius: 8px;
  background: #15181d;
  align-self: center;
}

.overviewToggle button {
  padding: 6px 12px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: #a9b0ba;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.overviewToggle button:hover { color: white; }
.overviewToggle button[aria-pressed="true"] { background: #edf0f4; color: #15181d; font-weight: 600; }
.overviewToggle button:focus-visible { outline: 2px solid #aab8cc; outline-offset: 3px; }

.settingsWrap {
  position: relative;
  display: flex;
  align-items: center;
}

.settingsButton {
  border: none;
  background: rgba(255, 255, 255, 0.08);
  color: rgba(226, 232, 240, 0.7);
  cursor: pointer;
  box-shadow: none;
}

.settingsButton:hover {
  background: rgba(255, 255, 255, 0.15);
  color: #fff;
}

.settingsButton:focus-visible {
  outline: 1px solid rgba(255, 255, 255, 0.7);
  outline-offset: 2px;
}

.settingsButton--icon {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  line-height: 1;
}

.settingsButton--icon::before {
  content: "";
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #e8ebf2;
}

.settingsDropdown {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  width: 240px;
  border: 0.5px solid rgba(255, 255, 255, 0.9);
  background: #080a0f;
  border-radius: 6px;
  padding: 10px 12px 12px;
  box-shadow: 0 10px 26px rgba(0, 0, 0, 0.35);
  z-index: 20;
  color: #a9abb6;
  font-size: 10px;
  font-weight: 600;
  font-family: Arial, Helvetica, sans-serif;
}

.settingsTitle {
  font-size: 10px;
  color: #a9abb6;
  font-weight: 600;
  margin-bottom: 10px;
}

.settingsHint {
  color: #a9abb6;
  font-size: 10px;
  font-weight: 600;
  margin-bottom: 6px;
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

</style>
