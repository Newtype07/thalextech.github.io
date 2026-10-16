<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import HedgingChart from "./components/HedgingChart.vue";
import { buildHedgingSimulation, HEDGE_TRADING_COST_RATE } from "./hedgingSimulation.js";
import {
  fetchIndexHistory,
  fetchInstruments,
  fetchMarkHistory,
} from "../../../lib/thalex.js";

const RESOLUTION_CONFIG = {
  60: { label: "1m", resolution: "1m", intervalSeconds: 60 },
  300: { label: "5m", resolution: "5m", intervalSeconds: 5 * 60 },
  900: { label: "15m", resolution: "15m", intervalSeconds: 15 * 60 },
  3600: { label: "1h", resolution: "1h", intervalSeconds: 60 * 60 },
  86400: { label: "1d", resolution: "1d", intervalSeconds: 24 * 60 * 60 },
};
const MIN_HORIZON_HOURS = 1;
const MAX_HORIZON_HOURS = 30 * 24;
const MAX_POINTS_PER_FETCH = 10000;
const LOAD_DEBOUNCE_MS = 160;

const UNDERLYING_OPTIONS = [
  { value: "BTCUSD", label: "BTC" },
  { value: "ETHUSD", label: "ETH" },
];

const ui = reactive({
  resolutionKey: "3600",
  targetMaturity: "",
  targetStrike: "",
  targetType: "put",
  targetSide: "long",
  targetAmount: 1,
  horizonHours: 7 * 24,
  period: 10 * 60,
  threshold: 0.02,
  tolerance: 0.16,
  showOptionPrice: false,
  includeTradingCosts: false,
  loading: false,
  error: "",
});

const underlying = ref("BTCUSD");
const allInstruments = ref([]);
const data = reactive({
  options: [],
  hedges: [],
  targetMark: {},
  hedgeMark: {},
  index: {},
});
const chartRef = ref(null);
const initialized = ref(false);
let loadRequestId = 0;
let loadTimer = null;

const maturityFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "2-digit",
  year: "2-digit",
  timeZone: "UTC",
});
const strikeFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});
const amountFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 4,
});
const deltaFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 4,
});
const normalizeCreateTimeSeconds = (value) => {
  const ts = Number(value);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  return ts;
};

const normalizeInstrument = (instrument) => {
  if (!instrument || typeof instrument !== "object") return null;
  const type = String(instrument.type || instrument.kind || "").toLowerCase();
  return {
    ...instrument,
    type_normalized: type,
    create_time_s: normalizeCreateTimeSeconds(
      instrument.create_time ?? instrument.create_time_ms,
    ),
    expiration_ts: Number(instrument.expiration_timestamp),
    strike: Number(instrument.strike_price),
    option_type_normalized: String(
      instrument.option_type || "",
    ).toLowerCase(),
  };
};

const selectedHorizonHours = computed(() => {
  const horizonHours = Number(ui.horizonHours);
  return Number.isFinite(horizonHours)
    ? Math.min(MAX_HORIZON_HOURS, Math.max(MIN_HORIZON_HOURS, horizonHours))
    : 7 * 24;
});

const selectedHorizonSeconds = computed(
  () => selectedHorizonHours.value * 60 * 60,
);

const activeResolutionEntry = computed(() => {
  const requestedKey = Number(ui.resolutionKey);
  const candidates = Object.entries(RESOLUTION_CONFIG)
    .map(([key, config]) => ({ key, ...config }))
    .filter((entry) => entry.intervalSeconds >= requestedKey)
    .sort((a, b) => a.intervalSeconds - b.intervalSeconds);
  const fallback = candidates[candidates.length - 1] || {
    key: "3600",
    ...RESOLUTION_CONFIG[3600],
  };

  return (
    candidates.find(
      (entry) =>
        Math.floor(selectedHorizonSeconds.value / entry.intervalSeconds) + 1 <=
        MAX_POINTS_PER_FETCH,
    ) || fallback
  );
});

const activeResolutionKey = computed(() => activeResolutionEntry.value.key);
const activeResolutionLabel = computed(() => activeResolutionEntry.value.label);
const requestedResolutionLabel = computed(
  () => RESOLUTION_CONFIG[ui.resolutionKey]?.label || String(ui.resolutionKey),
);
const effectivePointCount = computed(
  () =>
    Math.floor(
      selectedHorizonSeconds.value / activeResolutionEntry.value.intervalSeconds,
    ) + 1,
);
const activeDataKey = computed(() => activeResolutionKey.value);
const effectiveResolutionSummary = computed(() => {
  const summary = `${activeResolutionLabel.value}, ${effectivePointCount.value} pts`;
  if (activeResolutionKey.value === String(ui.resolutionKey)) return summary;
  return `${requestedResolutionLabel.value} -> ${summary}`;
});

const getTimestampRange = () => {
  const now = Math.floor(Date.now() / 1000);
  const config = activeResolutionEntry.value;
  const horizonSeconds = selectedHorizonSeconds.value;
  const maxPoints = Math.min(
    MAX_POINTS_PER_FETCH,
    Math.floor(horizonSeconds / config.intervalSeconds) + 1,
  );
  const to = now - (now % config.intervalSeconds);
  return {
    resolutionKey: config.key,
    resolution: config.resolution,
    from: to - horizonSeconds,
    to,
    maxPoints,
  };
};

const getLatestIndexClose = (rows) => {
  for (let i = (rows?.length || 0) - 1; i >= 0; i -= 1) {
    const close = rows[i]?.index_price_close;
    if (Number.isFinite(close)) return close;
  }
  return null;
};

const optionMaturities = computed(() => {
  const expiries = Array.from(
    new Set(
      data.options
        .map((instrument) => instrument.expiration_ts)
        .filter((ts) => Number.isFinite(ts) && ts > 0),
    ),
  ).sort((a, b) => a - b);

  return expiries.map((ts) => ({
    value: String(ts),
    label: `${maturityFormatter.format(new Date(ts * 1000))} UTC`,
  }));
});

const selectedMaturityTs = computed(() => Number(ui.targetMaturity));

const targetOptionsForMaturity = computed(() =>
  data.options.filter(
    (instrument) => instrument.expiration_ts === selectedMaturityTs.value,
  ),
);

const targetOptionTypes = computed(() =>
  ui.targetType === "straddle" ? ["call", "put"] : [ui.targetType],
);

const targetStrikes = computed(() => {
  const strikeSets = targetOptionTypes.value.map(
    (optionType) =>
      new Set(
        targetOptionsForMaturity.value
          .filter(
            (instrument) => instrument.option_type_normalized === optionType,
          )
          .map((instrument) => instrument.strike)
          .filter((strike) => Number.isFinite(strike)),
      ),
  );
  const strikes = Array.from(strikeSets[0] || [])
    .filter((strike) => strikeSets.every((strikeSet) => strikeSet.has(strike)))
    .sort((a, b) => a - b);

  return strikes.map((strike) => ({
    value: String(strike),
    label: strikeFormatter.format(strike),
  }));
});

const targetInstruments = computed(() => {
  const strike = Number(ui.targetStrike);
  const instruments = targetOptionTypes.value.map((optionType) =>
    data.options.find(
      (instrument) =>
        instrument.expiration_ts === selectedMaturityTs.value &&
        instrument.strike === strike &&
        instrument.option_type_normalized === optionType,
    ),
  );
  return instruments.every(Boolean) ? instruments : [];
});

const hedgeInstrument = computed(
  () => data.hedges[0] || null,
);

const targetTitle = computed(() => {
  if (ui.targetType === "straddle") {
    const [call, put] = targetInstruments.value;
    if (!call || !put) return "";
    return `${call.instrument_name} + ${put.instrument_name}`;
  }
  return targetInstruments.value[0]?.instrument_name || "";
});
const targetAmountMagnitude = computed(() => {
  const amount = Number(ui.targetAmount);
  return Number.isFinite(amount) ? Math.abs(amount) : 0;
});
const signedTargetAmount = computed(() =>
  ui.targetSide === "short"
    ? -targetAmountMagnitude.value
    : targetAmountMagnitude.value,
);
const targetSideLabel = computed(() =>
  ui.targetSide === "short" ? "Short" : "Long",
);
const thresholdValue = computed(() => {
  const value = Number(ui.threshold);
  return Number.isFinite(value) ? Math.max(0, value) : 0;
});
const toleranceValue = computed(() => {
  const value = Number(ui.tolerance);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.max(thresholdValue.value, value);
});
const periodHours = computed(() => {
  const period = Number(ui.period);
  if (!Number.isFinite(period)) return "0h";
  if (period < 3600) return `${Math.round(period / 60)}m`;
  return `${Math.round((period / 3600) * 10) / 10}h`;
});
const horizonLabel = computed(() => {
  const hours = Number(ui.horizonHours);
  if (!Number.isFinite(hours)) return "0h";
  if (hours < 24) return `${Math.round(hours)}h`;
  return `${Math.round((hours / 24) * 10) / 10}d`;
});

const chartSubtitle = computed(() => {
  if (!targetTitle.value) return "";
  return `${targetSideLabel.value} ${targetTitle.value} x ${amountFormatter.format(targetAmountMagnitude.value)}, horizon ${horizonLabel.value}, resolution ${effectiveResolutionSummary.value}, threshold ${deltaFormatter.format(thresholdValue.value)}, tolerance ${deltaFormatter.format(toleranceValue.value)}, period ${periodHours.value}`;
});

const slugValue = (value) =>
  String(value ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

const simulation = computed(() =>
  buildHedgingSimulation({
    indexRows: data.index[activeDataKey.value] || [],
    targets: targetInstruments.value.map((instrument) => ({
      instrument,
      rows:
        data.targetMark[activeDataKey.value]?.[instrument.instrument_name] || [],
    })),
    hedgeRows: data.hedgeMark[activeDataKey.value] || [],
    hedge: hedgeInstrument.value,
    settings: {
      targetAmount: signedTargetAmount.value,
      tradingCostRate: ui.includeTradingCosts ? HEDGE_TRADING_COST_RATE : 0,
      threshold: ui.threshold,
      tolerance: ui.tolerance,
      period: ui.period,
    },
  }),
);

const simulationRows = computed(() => simulation.value.rows);
const trades = computed(() => simulation.value.trades);

const canSavePng = computed(() => simulationRows.value.length > 0);

function handleSavePng() {
  if (!chartRef.value) return;
  const base =
    ui.targetType === "straddle"
      ? `${underlying.value}-straddle-${ui.targetMaturity}-${ui.targetStrike}`
      : targetInstruments.value[0]?.instrument_name || "hedging";
  const parts = [
    base,
    ui.targetSide,
    "hedging",
    `horizon_${horizonLabel.value}`,
    `period_${periodHours.value}`,
    `threshold_${thresholdValue.value}`,
    `tolerance_${toleranceValue.value}`,
  ].map(slugValue);
  chartRef.value.exportPng({ filename: `${parts.join("-")}.png` });
}

const chooseClosestStrike = () => {
  const latestIndex = getLatestIndexClose(data.index[activeDataKey.value] || []);
  const strikes = targetStrikes.value;
  if (!strikes.length) {
    ui.targetStrike = "";
    return;
  }
  if (!Number.isFinite(latestIndex)) {
    ui.targetStrike = strikes[Math.floor(strikes.length / 2)].value;
    return;
  }

  let best = strikes[0];
  let bestDistance = Infinity;
  for (const strike of strikes) {
    const numeric = Number(strike.value);
    const distance = Math.abs(numeric - latestIndex);
    if (distance < bestDistance) {
      best = strike;
      bestDistance = distance;
    }
  }
  ui.targetStrike = best.value;
};

const chooseDefaultMaturity = () => {
  const maturities = optionMaturities.value.map((maturity) => Number(maturity.value));
  if (!maturities.length) {
    ui.targetMaturity = "";
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const nowDate = new Date(now * 1000);
  const currentMonth = nowDate.getUTCMonth();
  const targetMonth = (currentMonth + 1) % 12;
  const targetYear = nowDate.getUTCFullYear() + (currentMonth === 11 ? 1 : 0);
  const targetMonthMaturities = maturities.filter((ts) => {
    const date = new Date(ts * 1000);
    return (
      date.getUTCFullYear() === targetYear &&
      date.getUTCMonth() === targetMonth
    );
  });
  if (targetMonthMaturities.length) {
    ui.targetMaturity = String(targetMonthMaturities[targetMonthMaturities.length - 1]);
    return;
  }

  const target = now + 28 * 24 * 60 * 60;
  const upcoming = maturities.filter((ts) => ts > now);
  const candidates = upcoming.length ? upcoming : maturities;
  const best = candidates.reduce((currentBest, ts) => {
    if (!Number.isFinite(currentBest)) return ts;
    return Math.abs(ts - target) < Math.abs(currentBest - target)
      ? ts
      : currentBest;
  }, NaN);
  ui.targetMaturity = String(best);
};

const rebuildInstruments = () => {
  const normalized = (allInstruments.value || [])
    .map(normalizeInstrument)
    .filter(Boolean)
    .filter((instrument) => instrument.underlying === underlying.value);

  data.options = normalized
    .filter((instrument) => instrument.type_normalized === "option")
    .sort(
      (a, b) =>
        (a.expiration_ts || 0) - (b.expiration_ts || 0) ||
        (a.strike || 0) - (b.strike || 0),
    );

  data.hedges = normalized
    .filter((instrument) => instrument.type_normalized === "perpetual")
    .sort(
      (a, b) =>
        String(a.instrument_name).localeCompare(String(b.instrument_name)),
    );
};

async function loadSimulation() {
  const requestId = ++loadRequestId;
  const targets = targetInstruments.value;
  const hedge = hedgeInstrument.value;
  if (targets.length !== targetOptionTypes.value.length || !hedge) {
    ui.loading = false;
    return;
  }

  ui.loading = true;
  ui.error = "";

  const { resolutionKey, resolution, from, to, maxPoints } = getTimestampRange();
  try {
    const [indexRows, targetMarkRows, hedgeMarkRows] = await Promise.all([
      fetchIndexHistory({
        index_name: targets[0].underlying || underlying.value,
        resolution,
        from,
        to,
        count: maxPoints,
      }),
      Promise.all(
        targets.map((target) =>
          fetchMarkHistory({
            instrument_name: target.instrument_name,
            resolution,
            from,
            to,
            count: maxPoints,
          }),
        ),
      ),
      fetchMarkHistory({
        instrument_name: hedge.instrument_name,
        resolution,
        from,
        to,
        count: maxPoints,
      }),
    ]);

    if (requestId !== loadRequestId) return;
    data.index[resolutionKey] = indexRows || [];
    data.targetMark[resolutionKey] = Object.fromEntries(
      targets.map((target, index) => [
        target.instrument_name,
        targetMarkRows[index] || [],
      ]),
    );
    data.hedgeMark[resolutionKey] = hedgeMarkRows || [];
  } catch (error) {
    if (requestId !== loadRequestId) return;
    ui.error = error instanceof Error ? error.message : String(error);
    data.index[resolutionKey] = [];
    data.targetMark[resolutionKey] = {};
    data.hedgeMark[resolutionKey] = [];
  } finally {
    if (requestId === loadRequestId) ui.loading = false;
  }
}

function scheduleLoadSimulation() {
  if (loadTimer) clearTimeout(loadTimer);
  loadTimer = setTimeout(() => {
    loadTimer = null;
    loadSimulation();
  }, LOAD_DEBOUNCE_MS);
}

async function switchUnderlying(next) {
  if (next === underlying.value) return;
  if (!UNDERLYING_OPTIONS.some((option) => option.value === next)) return;
  underlying.value = next;
  data.index = {};
  data.targetMark = {};
  data.hedgeMark = {};
  rebuildInstruments();
  chooseDefaultMaturity();
  chooseClosestStrike();
  await loadSimulation();
}

onMounted(async () => {
  try {
    const { resolutionKey, resolution, from, to, maxPoints } = getTimestampRange();
    const [instruments, indexRows] = await Promise.all([
      fetchInstruments(),
      fetchIndexHistory({
        index_name: underlying.value,
        resolution,
        from,
        to,
        count: maxPoints,
      }),
    ]);
    allInstruments.value = instruments || [];
    data.index[resolutionKey] = indexRows || [];
    rebuildInstruments();
    chooseDefaultMaturity();
    chooseClosestStrike();
    initialized.value = true;
    await loadSimulation();
  } catch (error) {
    ui.error = error instanceof Error ? error.message : String(error);
  } finally {
    initialized.value = true;
  }
});

watch(
  () => [
    ui.resolutionKey,
    ui.horizonHours,
    activeResolutionKey.value,
    ui.targetMaturity,
    ui.targetStrike,
    ui.targetType,
  ],
  async () => {
    if (!initialized.value) return;
    const hasSelectedStrike = targetStrikes.value.some(
      (strike) => strike.value === ui.targetStrike,
    );
    if (!hasSelectedStrike) {
      chooseClosestStrike();
      return;
    }
    scheduleLoadSimulation();
  },
);

onBeforeUnmount(() => {
  if (loadTimer) {
    clearTimeout(loadTimer);
    loadTimer = null;
  }
});
</script>

<template>
  <div class="app">
    <header class="header">
      <div class="titleRow">
        <h1>Hedging Simulator</h1>
      </div>
    </header>

    <div class="workspace">
      <div class="chartToolbar">
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

        <div class="optionSelectorGroup" aria-label="Option position">
          <div
            class="optionTypeToggle"
            role="group"
            aria-label="Option position type"
          >
            <button
              type="button"
              class="toolbarButton"
              :class="{ toolbarButtonActive: ui.targetType === 'call' }"
              @click="ui.targetType = 'call'"
            >
              Call
            </button>
            <button
              type="button"
              class="toolbarButton"
              :class="{ toolbarButtonActive: ui.targetType === 'put' }"
              @click="ui.targetType = 'put'"
            >
              Put
            </button>
            <button
              type="button"
              class="toolbarButton"
              :class="{ toolbarButtonActive: ui.targetType === 'straddle' }"
              @click="ui.targetType = 'straddle'"
            >
              Straddle
            </button>
          </div>

          <div
            class="positionSideToggle"
            role="group"
            aria-label="Position side"
          >
            <button
              type="button"
              class="toolbarButton"
              :class="{ toolbarButtonActive: ui.targetSide === 'long' }"
              @click="ui.targetSide = 'long'"
            >
              Long
            </button>
            <button
              type="button"
              class="toolbarButton"
              :class="{ toolbarButtonActive: ui.targetSide === 'short' }"
              @click="ui.targetSide = 'short'"
            >
              Short
            </button>
          </div>

          <label class="toolbarField">
            <span>Maturity</span>
            <select v-model="ui.targetMaturity">
              <option
                v-for="maturity in optionMaturities"
                :key="maturity.value"
                :value="maturity.value"
              >
                {{ maturity.label }}
              </option>
            </select>
          </label>

          <label class="toolbarField toolbarFieldStrike">
            <span>Strike</span>
            <select v-model="ui.targetStrike">
              <option
                v-for="strike in targetStrikes"
                :key="strike.value"
                :value="strike.value"
              >
                {{ strike.label }}
              </option>
            </select>
          </label>

          <label class="toolbarField toolbarFieldAmount">
            <span>Amount</span>
            <input
              v-model.number="ui.targetAmount"
              aria-label="Position amount"
              type="number"
              min="0"
              step="0.01"
              @change="ui.targetAmount = targetAmountMagnitude"
            />
          </label>
        </div>

        <label class="toolbarSwitch">
          <span>Option Price</span>
          <input v-model="ui.showOptionPrice" type="checkbox" />
          <span class="toolbarSwitchTrack" aria-hidden="true"></span>
        </label>

        <div class="resolutionToggle" role="group" aria-label="Resolution">
          <button
            v-for="key in Object.keys(RESOLUTION_CONFIG)"
            :key="key"
            type="button"
            class="toolbarButton"
            :class="{ toolbarButtonActive: ui.resolutionKey === key }"
            @click="ui.resolutionKey = key"
          >
            {{ RESOLUTION_CONFIG[key].label }}
          </button>
        </div>

        <button
          class="saveButton"
          type="button"
          :disabled="ui.loading || !canSavePng"
          @click="handleSavePng"
        >
          Save PNG
        </button>
      </div>

      <HedgingChart
        ref="chartRef"
        :data="simulationRows"
        :trades="trades"
        :show-option-price="ui.showOptionPrice"
        :show-trading-costs="ui.includeTradingCosts"
        :subtitle="chartSubtitle"
        :loading="ui.loading"
      />

      <aside class="configPanel" aria-label="Hedging configuration">
        <p class="botDescription">
          Hedges the selected option position's delta with the perpetual. The
          bot allows delta to drift within the threshold for the selected
          period, then trades the perpetual back toward the option delta. If
          deviation exceeds tolerance, it hedges immediately.
        </p>

        <label class="panelField">
          <span>Time Horizon</span>
          <input
            v-model.number="ui.horizonHours"
            class="rangeInput"
            type="range"
            :min="MIN_HORIZON_HOURS"
            :max="MAX_HORIZON_HOURS"
            step="1"
          />
          <div class="rangeLabels">
            <span>1h</span>
            <strong>{{ horizonLabel }} | {{ effectiveResolutionSummary }}</strong>
            <span>30d</span>
          </div>
        </label>

        <label class="panelField">
          <span>Period</span>
          <input
            v-model.number="ui.period"
            class="rangeInput"
            type="range"
            min="60"
            max="86400"
            step="60"
          />
          <div class="rangeLabels">
            <span>1m</span>
            <strong>{{ periodHours }}</strong>
            <span>24h</span>
          </div>
        </label>

        <label class="panelField">
          <span>
            Threshold
            <span
              class="infoDot infoDotTooltip"
              tabindex="0"
              data-tooltip="The bot allows the deltas to stay outside of [target_delta - threshold, target_delta + threshold] for period seconds before making any adjustments to the portfolio."
            >i</span>
          </span>
          <input v-model.number="ui.threshold" type="number" min="0" step="0.01" />
        </label>

        <label class="panelField">
          <span>
            Tolerance
            <span
              class="infoDot infoDotTooltip"
              tabindex="0"
              data-tooltip="If the deltas are outside of [target_delta - tolerance, target_delta + tolerance], the bot will hedge them immediately, without waiting period seconds. Set to 0 to disable immediate hedging."
            >i</span>
          </span>
          <input v-model.number="ui.tolerance" type="number" min="0" step="0.01" />
        </label>

        <label class="toolbarSwitch tradingCostSwitch" title="Charges 1.5 bps of traded perpetual notional on every hedge adjustment, including the initial hedge.">
          <span>Trading costs (1.5 bps)</span>
          <input v-model="ui.includeTradingCosts" type="checkbox" />
          <span class="toolbarSwitchTrack" aria-hidden="true"></span>
        </label>

        <div v-if="ui.error" class="error">{{ ui.error }}</div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.app {
  max-width: none;
  width: 100%;
  padding: 18px 16px 20px;
}

.header {
  margin-bottom: 12px;
  padding: 16px 0 18px;
}

.titleRow {
  justify-content: center;
}

.titleRow h1 {
  font-size: 26px;
  text-align: center;
}

.workspace {
  display: grid;
  grid-template-columns: minmax(900px, 1fr) 320px;
  grid-template-rows: auto minmax(720px, 1fr);
  gap: 10px 14px;
  height: min(980px, calc(100vh - 82px));
  min-height: 780px;
  overflow-x: auto;
}

.chartToolbar {
  grid-column: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: clamp(10px, 0.9vw, 16px);
  min-width: 0;
}

.chartToolbar .underlyingToggle,
.optionTypeToggle,
.positionSideToggle,
.resolutionToggle {
  flex: 0 0 auto;
  display: inline-flex;
  height: 31px;
  overflow: hidden;
  border: 1px solid #3d3d42;
  border-radius: 6px;
  background: #050506;
}

.chartToolbar .underlyingButton,
.toolbarButton {
  height: 100%;
  border: 0;
  background: transparent;
  color: #f0f1f4;
  cursor: pointer;
  padding: 0 18px;
  font-size: 12px;
  font-weight: 500;
}

.chartToolbar .underlyingButton + .underlyingButton,
.optionTypeToggle .toolbarButton + .toolbarButton,
.positionSideToggle .toolbarButton + .toolbarButton,
.resolutionToggle .toolbarButton + .toolbarButton {
  border-left: 1px solid #2e2e32;
}

.chartToolbar .underlyingButtonActive,
.toolbarButtonActive {
  background: #252529;
  color: #fff;
  font-weight: 500;
}

.toolbarButton {
  padding: 0 13px;
}

.optionSelectorGroup {
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: clamp(10px, 0.9vw, 16px);
  min-width: 0;
  flex: 0 1 auto;
}

.toolbarField {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 6px;
  width: 190px;
  height: 31px;
  min-width: 0;
}

.toolbarFieldStrike {
  width: 132px;
}

.toolbarFieldAmount {
  width: 142px;
}

.toolbarField span {
  color: #aeb4c2;
  font-size: 11px;
  font-weight: 650;
  line-height: 1;
}

.toolbarField select,
.toolbarField input {
  width: 100%;
  height: 31px;
  min-width: 0;
  border: 1px solid #3d3d42;
  border-radius: 6px;
  background: #050506;
  color: #f0f1f4;
  padding: 0 9px;
  font-size: 12px;
  font-family: inherit;
}

.toolbarField input {
  appearance: textfield;
}

.toolbarField input::-webkit-outer-spin-button,
.toolbarField input::-webkit-inner-spin-button {
  margin: 0;
}

.toolbarField select:focus,
.toolbarField input:focus {
  outline: none;
  border-color: #6d86ff;
}

.toolbarSwitch {
  flex: 0 0 auto;
  display: inline-grid;
  grid-template-columns: auto auto;
  align-items: center;
  gap: 8px;
  height: 31px;
  color: #aeb4c2;
  font-size: 11px;
  font-weight: 650;
  cursor: pointer;
}

.tradingCostSwitch {
  align-self: flex-start;
}

.toolbarSwitch input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}

.toolbarSwitchTrack {
  position: relative;
  width: 42px;
  height: 22px;
  border: 1px solid #3d3d42;
  border-radius: 999px;
  background: #050506;
}

.toolbarSwitchTrack::after {
  content: "";
  position: absolute;
  top: 3px;
  left: 3px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #aeb4c2;
  transition:
    transform 130ms ease,
    background 130ms ease;
}

.toolbarSwitch input:checked + .toolbarSwitchTrack {
  border-color: #d28a6f;
}

.toolbarSwitch input:checked + .toolbarSwitchTrack::after {
  transform: translateX(19px);
  background: #d28a6f;
}

.toolbarSwitch input:focus-visible + .toolbarSwitchTrack {
  outline: 2px solid #6d86ff;
  outline-offset: 2px;
}

.chartToolbar .saveButton {
  flex: 0 0 auto;
  height: 31px;
  padding: 0 16px;
  border: 1px solid #3d3d42;
  border-radius: 6px;
  background: #050506;
  color: #f0f1f4;
  font-size: 12px;
  font-weight: 500;
}


.workspace :deep(.chartWrap) {
  grid-column: 1;
  grid-row: 2;
  height: 100%;
}

.workspace :deep(.chartSvg) {
  height: 100%;
}

.configPanel {
  grid-column: 2;
  grid-row: 2;
  display: flex;
  flex-direction: column;
  gap: 18px;
  height: 100%;
  min-height: 0;
  max-height: 100%;
  padding: 22px 20px;
  background: #020204;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 16px;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.02);
  overflow-y: auto;
}

.botDescription {
  margin: 0 0 2px;
  color: #bfc2cb;
  font-size: 13px;
  line-height: 1.45;
}

.panelField {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.panelField > span {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #f2f3f5;
  font-size: 14px;
  font-weight: 650;
}

.infoDot {
  display: inline-grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border: 1.5px solid #e5e7eb;
  border-radius: 50%;
  color: #e5e7eb;
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
}

.infoDotTooltip::after {
  content: attr(data-tooltip);
  position: absolute;
  left: 0;
  right: 0;
  bottom: calc(100% + 8px);
  z-index: 30;
  padding: 10px 12px;
  border: 1px solid #3f3f43;
  border-radius: 8px;
  background: #08090d;
  color: #e5e7eb;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.42);
  font-size: 12px;
  font-weight: 500;
  line-height: 1.35;
  text-align: left;
  opacity: 0;
  pointer-events: none;
  transform: translateY(4px);
  transition:
    opacity 120ms ease,
    transform 120ms ease;
}

.infoDotTooltip:hover::after,
.infoDotTooltip:focus-visible::after {
  opacity: 1;
  transform: translateY(0);
}

.panelField select,
.panelField input {
  width: 100%;
  min-width: 0;
  min-height: 42px;
  border: 1px solid #3f3f43;
  border-radius: 10px;
  background: transparent;
  color: #f3f4f6;
  padding: 0 14px;
  font-size: 14px;
  font-family: inherit;
}

.panelField select {
  color: #a6a6ad;
}

.panelField select:focus,
.panelField input:focus {
  outline: none;
  border-color: #6d86ff;
}

.rangeInput {
  -webkit-appearance: none;
  appearance: none;
  min-height: 18px;
  padding: 0;
  border: 0;
  cursor: pointer;
}

.rangeInput::-webkit-slider-runnable-track {
  height: 7px;
  background: #4a4a4a;
  border-radius: 999px;
}

.rangeInput::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 22px;
  height: 22px;
  margin-top: -7.5px;
  border: 3px solid #6d86ff;
  border-radius: 50%;
  background: #050506;
}

.rangeInput::-moz-range-track {
  height: 7px;
  background: #4a4a4a;
  border-radius: 999px;
}

.rangeInput::-moz-range-thumb {
  width: 18px;
  height: 18px;
  border: 3px solid #6d86ff;
  border-radius: 50%;
  background: #050506;
}

.rangeLabels {
  display: flex;
  justify-content: space-between;
  align-items: center;
  color: #a9abb6;
  font-size: 13px;
}

.rangeLabels strong {
  color: #f3f4f6;
  font-size: 12px;
  font-weight: 650;
  padding: 5px 12px;
  border: 1px solid #35353a;
  border-radius: 8px;
  background: #060607;
}

</style>
