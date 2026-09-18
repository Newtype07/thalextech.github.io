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
import OptionPnlChart from "./components/OptionPnlChart.vue";
import StyledSelectMenu from "./components/StyledSelectMenu.vue";
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
const RESOLUTION_KEYS = Object.keys(RESOLUTION_CONFIG);
const RESOLUTION_OPTIONS = RESOLUTION_KEYS.map((key) => ({
  value: key,
  label: RESOLUTION_CONFIG[key].label,
}));
const DEFAULT_LOOKBACK_POINT_LIMIT = 360;
const MIN_LOOKBACK_POINT_LIMIT = 120;
const MAX_LOOKBACK_POINT_LIMIT = 10_000;
const HISTORY_POINT_DEBOUNCE_MS = 350;
const MIN_DATA_DATE = new Date("2025-09-30T00:00:00Z");
const MIN_DATA_TS = Math.floor(MIN_DATA_DATE.getTime() / 1000);

const UNDERLYING_OPTIONS = [
  { value: "BTCUSD", label: "BTC" },
  { value: "ETHUSD", label: "ETH" },
];

const ui = reactive({
  resolutionKey: "900",
  optionMaturity: "",
  optionStrike: "",
  optionType: "call",
  maxPoints: DEFAULT_LOOKBACK_POINT_LIMIT,
  pnlAttributionMethod: "pathwise",
  loading: false,
  error: "",
});
const underlying = ref("BTCUSD");
const allInstruments = ref([]);
const data = reactive({
  optionInstruments: [],
  optionMark: {},
  index: {},
});
const chartRef = ref(null);
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

const createStableOptionsBuilder = ({ toValue, toLabel }) => {
  let prevKeys = [];
  let prevOptions = [];
  return (keys) => {
    const unchanged =
      keys.length === prevKeys.length &&
      keys.every((key, idx) => key === prevKeys[idx]);
    if (unchanged) return prevOptions;
    prevKeys = [...keys];
    prevOptions = keys.map((key) => ({
      value: toValue(key),
      label: toLabel(key),
    }));
    return prevOptions;
  };
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

const requestedMaxPoints = computed(() => {
  const value = Math.floor(Number(ui.maxPoints));
  if (!Number.isFinite(value)) return DEFAULT_LOOKBACK_POINT_LIMIT;
  return Math.max(
    MIN_LOOKBACK_POINT_LIMIT,
    Math.min(MAX_LOOKBACK_POINT_LIMIT, value),
  );
});
const maxPointsToFetch = ref(DEFAULT_LOOKBACK_POINT_LIMIT);

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

const getMiddleStrikeValue = (strikes) => {
  if (!strikes?.length) return "";
  const midIndex = Math.floor(strikes.length / 2);
  return strikes[midIndex]?.value ?? "";
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
  optionType,
  indexPrice,
  fallbackStrikes,
}) => {
  const typedInstruments = (maturityInstruments || [])
    .filter(
      (instrument) =>
        instrument?.option_type_normalized === optionType &&
        Number.isFinite(instrument?.strike),
    )
    .sort((a, b) => a.strike - b.strike);

  if (Number.isFinite(indexPrice) && typedInstruments.length) {
    const above = [];
    const seenStrikes = new Set();
    for (const instrument of typedInstruments) {
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

  const typedStrikes = Array.from(
    new Set(typedInstruments.map((instrument) => instrument.strike)),
  )
    .sort((a, b) => a - b)
    .map((strike) => ({ value: String(strike) }));
  const strikeOptions = typedStrikes.length ? typedStrikes : fallbackStrikes;
  return getMiddleStrikeValue(strikeOptions);
};

const getTimestampRange = () => {
  const now = Math.floor(Date.now() / 1000);
  const resolutionConfig = RESOLUTION_CONFIG[ui.resolutionKey];
  const resolution = resolutionConfig?.resolution;
  const seconds =
    resolutionConfig?.interval_seconds ?? Number(ui.resolutionKey) ?? 0;
  const safeSeconds = Number.isFinite(seconds) && seconds > 0 ? seconds : 900;
  const to = now - (now % safeSeconds);
  return {
    resolution,
    from: to - safeSeconds * (maxPointsToFetch.value - 1),
    to,
  };
};

const buildMaturityOptions = createStableOptionsBuilder({
  toValue: (ts) => String(ts),
  toLabel: (ts) => `${maturityFormatter.format(new Date(ts * 1000))} UTC`,
});

const optionMaturities = computed(() => {
  const expirations = Array.from(
    new Set(
      data.optionInstruments
        .map((instrument) => instrument?.expiration_ts)
        .filter((ts) => Number.isFinite(ts) && ts > 0),
    ),
  ).sort((a, b) => a - b);
  return buildMaturityOptions(expirations);
});

const selectedMaturityTs = computed(() => Number(ui.optionMaturity));

const optionInstrumentsForMaturity = computed(() => {
  const maturityTs = selectedMaturityTs.value;
  return data.optionInstruments.filter(
    (instrument) => instrument?.expiration_ts === maturityTs,
  );
});

const buildStrikeOptions = createStableOptionsBuilder({
  toValue: (strike) => String(strike),
  toLabel: (strike) => strikeFormatter.format(strike),
});

const optionStrikes = computed(() => {
  const strikes = Array.from(
    new Set(
      optionInstrumentsForMaturity.value.map(
        (instrument) => instrument?.strike,
      ),
    ),
  ).sort((a, b) => a - b);
  return buildStrikeOptions(strikes);
});

const selectedStrike = computed(() => Number(ui.optionStrike));

const attributionMethods = [
  { value: "pathwise", label: "Pathwise Greeks" },
  { value: "end_state", label: "End-state" },
];

const optionTypes = [
  { value: "call", label: "Call" },
  { value: "put", label: "Put" },
];

const selectedOptionInstrument = computed(() => {
  const maturityTs = selectedMaturityTs.value;
  const strike = selectedStrike.value;
  const type = ui.optionType;
  return (
    data.optionInstruments.find((instrument) => {
      const expirationMatch = instrument?.expiration_ts === maturityTs;
      const strikeMatch = instrument?.strike === strike;
      const typeMatch = instrument?.option_type_normalized === type;
      return expirationMatch && strikeMatch && typeMatch;
    }) || null
  );
});

const optionInstrumentName = computed(
  () => selectedOptionInstrument.value?.instrument_name || "",
);

const mainSeries = computed(() => {
  const index = data.index[ui.resolutionKey] || [];
  const optionMark = data.optionMark[ui.resolutionKey] || [];
  const optionDataByTs = new Map();
  let optionMinTs = null;
  let optionMaxTs = null;
  for (const row of optionMark) {
    const ts = row?.ts;
    if (!Number.isFinite(ts)) continue;
    optionDataByTs.set(ts, {
      iv_close: row.iv_close,
      option_mark_price: row.mark_price_close,
    });
    if (optionMinTs == null || ts < optionMinTs) optionMinTs = ts;
    if (optionMaxTs == null || ts > optionMaxTs) optionMaxTs = ts;
  }
  const result = [];
  for (const point of index) {
    const ts = point.ts;
    if (!Number.isFinite(ts)) continue;
    if (ts < MIN_DATA_TS) continue;
    if (
      Number.isFinite(optionMinTs) &&
      Number.isFinite(optionMaxTs) &&
      (ts < optionMinTs || ts > optionMaxTs)
    ) {
      continue;
    }
    const date = new Date(ts * 1000);
    const optionData = optionDataByTs.get(point.ts);
    result.push({
      ...point,
      date,
      iv_close: optionData?.iv_close ?? null,
      option_mark_price: optionData?.option_mark_price ?? null,
    });
  }
  return result.slice(-maxPointsToFetch.value);
});

const optionPnlSeries = computed(() => {
  const mark = data.optionMark[ui.resolutionKey] || [];
  const index = data.index[ui.resolutionKey] || [];
  const instrument = selectedOptionInstrument.value;
  if (!mark.length || !index.length || !instrument) return [];
  const series = computeGreeksPnlSeries({
    mark,
    index,
    instrument,
  });
  const filtered = [];
  for (const point of series) {
    if (Number.isFinite(point?.ts) && point.ts >= MIN_DATA_TS) {
      filtered.push(point);
    }
  }
  return filtered.slice(-maxPointsToFetch.value);
});

async function load(instrument) {
  if (!instrument) return;
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
    const optionInstrument = instrument;
    const indexName = optionInstrument?.underlying || underlying.value;
    const optionName = optionInstrument?.instrument_name || "";
    const indexPromise = prefetchedIndex
      ? Promise.resolve(prefetchedIndex)
      : fetchIndexHistory({
          index_name: indexName,
          resolution,
          from,
          to,
          count: maxPointsToFetch.value,
        });
    const [mainIndex, optionMark] = await Promise.all([
      indexPromise,
      optionName
        ? fetchMarkHistory({
            instrument_name: optionName,
            resolution,
            from,
            to,
            count: maxPointsToFetch.value,
          })
        : Promise.resolve([]),
    ]);

    if (requestId !== loadRequestId) return;

    data.index[ui.resolutionKey] = mainIndex || [];
    data.optionMark[ui.resolutionKey] = optionMark || [];
  } catch (e) {
    if (requestId !== loadRequestId) return;
    ui.error = e instanceof Error ? e.message : String(e);
    data.index = {};
    data.optionMark = {};
  } finally {
    if (requestId === loadRequestId) {
      ui.loading = false;
    }
  }
}

function clearActiveSeries() {
  const resolutionKey = ui.resolutionKey;
  data.index[resolutionKey] = [];
  data.optionMark[resolutionKey] = [];
}

function handleSavePng() {
  if (!chartRef.value) return;
  const base = optionInstrumentName.value || "option-pnl";
  const filename = ui.resolutionKey
    ? `${base}-${ui.resolutionKey}.png`
    : `${base}.png`;
  chartRef.value.exportPng({ filename });
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
  underlying.value = next;
  data.optionMark = {};
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
    const oldest = getOldestOptionInstrument(data.optionInstruments);
    if (oldest && Number.isFinite(oldest.expiration_ts)) {
      ui.optionMaturity = String(oldest.expiration_ts);
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
      optionType: ui.optionType,
      indexPrice: latestIndexClose,
      fallbackStrikes: optionStrikes.value,
    });
  } finally {
    isInitializing.value = false;
  }
};

onMounted(async () => {
  document.addEventListener("pointerdown", handleDocumentPointerDown);
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

    const oldest = getOldestOptionInstrument(data.optionInstruments);
    if (oldest && Number.isFinite(oldest.expiration_ts)) {
      ui.optionMaturity = String(oldest.expiration_ts);
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
      optionType: ui.optionType,
      indexPrice: latestIndexClose,
      fallbackStrikes: optionStrikes.value,
    });
  } catch (e) {
    ui.error = e instanceof Error ? e.message : String(e);
    data.optionInstruments = [];
    data.index = {};
    data.optionMark = {};
  } finally {
    isInitializing.value = false;
  }
});

onUnmounted(() => {
  document.removeEventListener("pointerdown", handleDocumentPointerDown);
  if (maxPointsDebounceTimer) {
    window.clearTimeout(maxPointsDebounceTimer);
    maxPointsDebounceTimer = null;
  }
});

watch(requestedMaxPoints, (pointLimit) => {
  if (maxPointsDebounceTimer) window.clearTimeout(maxPointsDebounceTimer);
  maxPointsDebounceTimer = window.setTimeout(() => {
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
  optionStrikes,
  (strikes) => {
    if (isInitializing.value) return;
    if (!strikes.length) {
      ui.optionStrike = "";
      return;
    }
    if (strikes.some((strike) => strike.value === ui.optionStrike)) return;
    ui.optionStrike = getMiddleStrikeValue(strikes);
  },
  { immediate: true },
);

const reloadSelectedInstrument = async () => {
  const instrument = selectedOptionInstrument.value;
  if (!instrument) {
    loadRequestId += 1;
    ui.loading = false;
    clearActiveSeries();
    return;
  }
  await load(instrument);
};

watch(
  () => [
    ui.resolutionKey,
    ui.optionMaturity,
    ui.optionStrike,
    ui.optionType,
    maxPointsToFetch.value,
  ],
  async () => {
    await reloadSelectedInstrument();
  },
  { immediate: false },
);
</script>

<template>
  <div class="app">
    <header class="header">
      <div class="titleRow">
        <h1>Option P&amp;L Analyzer</h1>
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
          <span class="fieldLabel">Maturity</span>
          <StyledSelectMenu
            v-model="ui.optionMaturity"
            label="Maturity"
            :options="optionMaturities"
          />
        </div>

        <div class="field">
          <span class="fieldLabel">Strike</span>
          <StyledSelectMenu
            v-model="ui.optionStrike"
            label="Strike"
            :options="optionStrikes"
          />
        </div>

        <div class="field">
          <span class="fieldLabel">Type</span>
          <StyledSelectMenu
            v-model="ui.optionType"
            label="Option type"
            :options="optionTypes"
          />
        </div>

        <div class="field">
          <span class="fieldLabel">Resolution</span>
          <StyledSelectMenu
            v-model="ui.resolutionKey"
            label="Resolution"
            :options="RESOLUTION_OPTIONS"
          />
        </div>

        <div class="field">
          <span class="fieldLabel">P&amp;L attribution</span>
          <StyledSelectMenu
            v-model="ui.pnlAttributionMethod"
            label="P&L attribution"
            :options="attributionMethods"
          />
        </div>

        <button
          class="saveButton"
          type="button"
          @click="handleSavePng"
          :disabled="ui.loading || !mainSeries.length"
        >
          Save PNG
        </button>
      </div>

      <div v-if="ui.error" class="error">{{ ui.error }}</div>
    </header>

    <div class="chartArea">
      <div class="chartTopBar">
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
              Historic data points: {{ requestedMaxPoints.toLocaleString() }}
            </div>
            <input
              v-model.number="ui.maxPoints"
              class="settingsSlider"
              type="range"
              aria-label="Historic data points"
              :min="MIN_LOOKBACK_POINT_LIMIT"
              :max="MAX_LOOKBACK_POINT_LIMIT"
              step="10"
            />
            <div class="settingsRange">
              <span>{{ MIN_LOOKBACK_POINT_LIMIT }}</span>
              <span>{{ MAX_LOOKBACK_POINT_LIMIT.toLocaleString() }}</span>
            </div>
          </div>
        </div>
      </div>

      <p class="attributionHint">
        {{ ui.pnlAttributionMethod === "end_state"
          ? "End-state: Spot, Volatility and Time decay explain the change from the selected entry to each timestamp, independent of the path. Total is current mark minus entry mark; Residual includes other mark effects."
          : "Pathwise Greeks: accumulated local Greek P&L along the selected price and volatility path. Legacy Total sums candle P&L and can differ from end-state Total across gaps." }}
      </p>
      <OptionPnlChart
        ref="chartRef"
        :data="mainSeries"
        :option-pnl-data="optionPnlSeries"
        :option-instrument-name="optionInstrumentName"
        :loading="ui.loading"
        :attribution-method="ui.pnlAttributionMethod"
        :instrument="selectedOptionInstrument || {}"
      />
    </div>
  </div>
</template>

<style scoped>
.attributionHint {
  color: var(--muted);
  font-size: 12px;
  margin: 0 6px 10px;
}

.fieldLabel {
  color: var(--muted);
  font-size: 13px;
}

.chartArea {
  position: relative;
}

.chartTopBar {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  min-height: 30px;
  margin-bottom: 10px;
  padding-right: 6px;
}

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
