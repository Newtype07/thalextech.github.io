<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import CycleDetailChart from "./components/CycleDetailChart.vue";
import FairValueDistributionPanel from "./components/FairValueDistributionPanel.vue";
import GreekPnlChart from "./components/GreekPnlChart.vue";
import HedgePerformanceChart from "./components/HedgePerformanceChart.vue";
import IvRvChart from "./components/IvRvChart.vue";
import StyledSelectMenu from "./components/StyledSelectMenu.vue";
import VarianceStandardizedVrHeatmap from "./components/VarianceStandardizedVrHeatmap.vue";
import VarianceRatioDashboard from "./components/VarianceRatioDashboard.vue";
import WeekdayHourHeatmap from "./components/WeekdayHourHeatmap.vue";
import WeekdayRvBoxplot from "./components/WeekdayRvBoxplot.vue";
import SweepResultsChart from "./components/SweepResultsChart.vue";
import WeeklyBacktestChart from "./components/WeeklyBacktestChart.vue";
import {
  hasWorkerDataset,
  runAttributionInWorker,
  runSingleInWorker,
  runSweepInWorker,
} from "./lib/backtestWorkerClient.js";
import { loadThalexHistory } from "./lib/thalexParquet.js";
import { getUnderlying, UNDERLYING_OPTIONS } from "./lib/underlyings.js";
import { buildDailyPnlRows } from "./lib/dailyPnl.js";
import {
  buildIvRvChartRows,
  buildHourlyIvHeatmap,
  buildHourlyIvRows,
  buildHourlyIvWeekdayGroups,
  buildHourlyParkinsonRows,
  buildHourlyRvHeatmap,
  buildHourlyRvWeekdayGroups,
  loadIvRvHistory,
  summarizeIvRvRows,
  summarizeRvWeekdayGroups,
} from "./lib/ivRv.js";
import { blackScholesPrice } from "./lib/optionPricing.js";
import { computeZeroMtmContours } from "./lib/zeroMtmContours.js";
import { buildWeeklyPnlCsv, downloadCsv } from "./lib/weeklyPnlCsv.js";
import {
  buildForwardVarianceRatioSeasonality,
  calculateVarianceRatioDashboard,
  RETURN_ADJUSTMENT,
} from "./lib/serialCorrelation.js";
import {
  DEFAULT_BACKTEST_CONFIG,
  buildCycleDetail,
  computeMaxDrawdown,
  computeBreakEvens,
  normalizeBacktestConfig,
  prepareCycleDetailData,
  requiredQuoteDteDays,
} from "./lib/weeklyStraddleBacktest.js";

const DEFAULT_MATURITY_DAYS = 7;
const DATA_RANGE_START = new Date(DEFAULT_BACKTEST_CONFIG.start);
const DATA_RANGE_END = new Date();
const DATA_RANGE_MIN_MS = 24 * 60 * 60 * 1000;
const DATA_RANGE_RUN_DEBOUNCE_MS = 300;
const DATA_RANGE_LABEL_UPDATE_MS = 180;
const DAILY_PNL_CYCLE_THRESHOLD = 24;
const underlying = ref("BTC");
const currentUnderlying = computed(() => getUnderlying(underlying.value));

const MATURITY_OPTIONS = [
  { value: 1, label: "1D", minDteDays: 0.25, maxDteDays: 1.5 },
  { value: 7, label: "7D", minDteDays: 4, maxDteDays: 10 },
  { value: 14, label: "14D", minDteDays: 7, maxDteDays: 28 },
  { value: 30, label: "30D", minDteDays: 14, maxDteDays: 60 },
  { value: 60, label: "60D", minDteDays: 45, maxDteDays: 75 },
  { value: 90, label: "90D", minDteDays: 75, maxDteDays: 135 },
  { value: 180, label: "180D", minDteDays: 135, maxDteDays: 240 },
];

const CALENDAR_MATURITY_OPTIONS = [
  {
    value: "7-14",
    label: "7–14D",
    nearDays: 7,
    farDays: 14,
    minDteDays: 5,
    maxDteDays: 10,
  },
  {
    value: "7-30",
    label: "7–30D",
    nearDays: 7,
    farDays: 30,
    minDteDays: 5,
    maxDteDays: 10,
  },
  {
    value: "14-30",
    label: "14–30D",
    nearDays: 14,
    farDays: 30,
    minDteDays: 7,
    maxDteDays: 28,
  },
  {
    value: "30-60",
    label: "30–60D",
    nearDays: 30,
    farDays: 60,
    minDteDays: 14,
    maxDteDays: 60,
  },
  {
    value: "30-90",
    label: "30–90D",
    nearDays: 30,
    farDays: 90,
    minDteDays: 14,
    maxDteDays: 60,
  },
  {
    value: "30-180",
    label: "30–180D",
    nearDays: 30,
    farDays: 180,
    minDteDays: 14,
    maxDteDays: 60,
  },
  {
    value: "60-90",
    label: "60–90D",
    nearDays: 60,
    farDays: 90,
    minDteDays: 45,
    maxDteDays: 75,
  },
  {
    value: "60-180",
    label: "60–180D",
    nearDays: 60,
    farDays: 180,
    minDteDays: 45,
    maxDteDays: 75,
  },
  {
    value: "90-180",
    label: "90–180D",
    nearDays: 90,
    farDays: 180,
    minDteDays: 75,
    maxDteDays: 135,
  },
];

const STRUCTURE_OPTIONS = [
  { value: "straddle", label: "Straddle" },
  { value: "strangle", label: "Strangle" },
  { value: "risk_reversal", label: "Risk reversal" },
  { value: "call", label: "Call" },
  { value: "covered_call", label: "Covered call" },
  { value: "put", label: "Put" },
  { value: "calendar_spread", label: "Calendar spread" },
];

const DELTA_OPTIONS = [
  { value: 0.05, label: "5D" },
  { value: 0.1, label: "10D" },
  { value: 0.15, label: "15D" },
  { value: 0.25, label: "25D" },
  { value: 0.35, label: "35D" },
  { value: 0.45, label: "45D" },
];
const DEFAULT_DELTA_OPTION = DELTA_OPTIONS.find(
  (option) => option.value === 0.25,
);

const WEEKDAY_OPTIONS = [
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
  { value: 0, label: "Sunday" },
];
const ENTRY_WEEKDAY_EVERY_DAY = -1;
const ENTRY_WEEKDAY_OPTIONS = [
  { value: ENTRY_WEEKDAY_EVERY_DAY, label: "Every day" },
  ...WEEKDAY_OPTIONS,
];

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, hour) => ({
  value: hour,
  label: `${String(hour).padStart(2, "0")}:00`,
}));
const MONTH_OPTIONS = [
  { value: 0, label: "Jan" },
  { value: 1, label: "Feb" },
  { value: 2, label: "Mar" },
  { value: 3, label: "Apr" },
  { value: 4, label: "May" },
  { value: 5, label: "Jun" },
  { value: 6, label: "Jul" },
  { value: 7, label: "Aug" },
  { value: 8, label: "Sep" },
  { value: 9, label: "Oct" },
  { value: 10, label: "Nov" },
  { value: 11, label: "Dec" },
];
const ALL_MONTHS = MONTH_OPTIONS.map((month) => month.value);
const SERIAL_ANCHOR_WEEKDAY_OPTIONS = [
  { value: -1, label: "All" },
  ...WEEKDAY_OPTIONS,
];

const HEDGE_FREQUENCY_OPTIONS = [
  { value: 1, label: "1h" },
  { value: 2, label: "2h" },
  { value: 3, label: "3h" },
  { value: 4, label: "4h" },
  { value: 6, label: "6h" },
  { value: 8, label: "8h" },
  { value: 12, label: "12h" },
  { value: 24, label: "24h" },
];

const ui = reactive({
  structure: "straddle",
  maturityDays: DEFAULT_MATURITY_DAYS,
  targetDelta: 0.25,
  entryWeekday: 5,
  entryHourUtc: 8,
  hedgeEnabled: true,
  hedgeIntervalHours: 24,
  exitMode: "after_days",
  exitHoldDays: 7,
  exitWeekday: 0,
  exitHourUtc: 20,
  longOption: false,
  investmentMode: "notional",
});

const maxExitHoldDays = computed(() => {
  return currentMaturity.value.nearDays ?? currentMaturity.value.value;
});

const maturityOptions = computed(() =>
  ui.structure === "calendar_spread"
    ? CALENDAR_MATURITY_OPTIONS
    : MATURITY_OPTIONS,
);
const currentMaturity = computed(
  () =>
    maturityOptions.value.find(
      (option) => String(option.value) === String(ui.maturityDays),
    ) ||
    maturityOptions.value.find(
      (option) => option.value === DEFAULT_MATURITY_DAYS,
    ) ||
    maturityOptions.value[0],
);
const showDelta = computed(
  () => !["straddle", "calendar_spread"].includes(ui.structure),
);
const rollDayOptions = computed(() =>
  [1, 2, 3, 4, 5, 6, 7, 14, 30, 60, 90, 180].filter(
    (days) => days <= maxExitHoldDays.value,
  ),
);

const openMenu = ref(null);
const dataRangeStart = ref(0);
const dataRangeEnd = ref(100);
const displayedDataRangeStart = ref(dataRangeStart.value);
const displayedDataRangeEnd = ref(dataRangeEnd.value);
const dataRangeAvailableEnd = ref(new Date(DATA_RANGE_END));
const dataRangeSpanMs = computed(
  () => dataRangeAvailableEnd.value.getTime() - DATA_RANGE_START.getTime(),
);
const dataRangeMinGap = computed(
  () => Math.max(0.1, (DATA_RANGE_MIN_MS / dataRangeSpanMs.value) * 100),
);
const selectedDataRange = computed(() => ({
  start: new Date(
    DATA_RANGE_START.getTime() +
      (dataRangeSpanMs.value * dataRangeStart.value) / 100,
  ),
  end: new Date(
    DATA_RANGE_START.getTime() +
      (dataRangeSpanMs.value * dataRangeEnd.value) / 100,
  ),
}));
const displayedDataRange = computed(() => ({
  start: new Date(
    DATA_RANGE_START.getTime() +
      (dataRangeSpanMs.value * displayedDataRangeStart.value) / 100,
  ),
  end: new Date(
    DATA_RANGE_START.getTime() +
      (dataRangeSpanMs.value * displayedDataRangeEnd.value) / 100,
  ),
}));
const dataRangeStartModel = computed({
  get: () => dataRangeStart.value,
  set: (value) => {
    dataRangeStart.value = Math.max(
      0,
      Math.min(Number(value), dataRangeEnd.value - dataRangeMinGap.value),
    );
  },
});
const dataRangeEndModel = computed({
  get: () => dataRangeEnd.value,
  set: (value) => {
    dataRangeEnd.value = Math.min(
      100,
      Math.max(Number(value), dataRangeStart.value + dataRangeMinGap.value),
    );
  },
});
const dataRangeStyle = computed(() => ({
  "--range-start": `${dataRangeStart.value}%`,
  "--range-end": `${dataRangeEnd.value}%`,
}));
const isAllDataRange = computed(
  () => dataRangeStart.value === 0 && dataRangeEnd.value === 100,
);
const dataRangeDateFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
const dataRangePillFormatter = new Intl.DateTimeFormat("en-GB", {
  month: "short",
  year: "2-digit",
  timeZone: "UTC",
});
const dataRangeLabel = computed(() => {
  if (
    displayedDataRangeStart.value === 0 &&
    displayedDataRangeEnd.value === 100
  )
    return "All";
  const range = displayedDataRange.value;
  return `${dataRangePillFormatter.format(range.start)} – ${dataRangePillFormatter.format(range.end)}`;
});
const dataRangeDetailLabel = computed(() => {
  const range = displayedDataRange.value;
  return `${dataRangeDateFormatter.format(range.start)} – ${dataRangeDateFormatter.format(range.end)}`;
});

let dataRangeLabelUpdateTimer = null;
function updateDisplayedDataRange() {
  displayedDataRangeStart.value = dataRangeStart.value;
  displayedDataRangeEnd.value = dataRangeEnd.value;
}

function scheduleDataRangeLabelUpdate() {
  if (dataRangeLabelUpdateTimer != null) return;
  dataRangeLabelUpdateTimer = setTimeout(() => {
    dataRangeLabelUpdateTimer = null;
    updateDisplayedDataRange();
  }, DATA_RANGE_LABEL_UPDATE_MS);
}

function resetDataRange() {
  dataRangeStart.value = 0;
  dataRangeEnd.value = 100;
  clearTimeout(dataRangeLabelUpdateTimer);
  dataRangeLabelUpdateTimer = null;
  updateDisplayedDataRange();
}

function toggleMenu(name) {
  openMenu.value = openMenu.value === name ? null : name;
}

function selectMaturity(value) {
  const previous = ui.maturityDays;
  ui.maturityDays = value;
  // 1D strategies default to a true daily roll at the entry hour.
  if (Number(value) === 1) {
    ui.entryWeekday = ENTRY_WEEKDAY_EVERY_DAY;
    if (ui.exitMode === "after_days") ui.exitHoldDays = 1;
    return;
  }
  if (
    Number(previous) === 1 &&
    Number(ui.entryWeekday) === ENTRY_WEEKDAY_EVERY_DAY
  ) {
    ui.entryWeekday = 5;
  }
}

// Close menu on outside click
watch(openMenu, (val) => {
  if (!val) return;
  const handler = (e) => {
    const targetPill = e.target.closest(".pill");
    if (!targetPill) {
      openMenu.value = null;
    }
    document.removeEventListener("click", handler);
  };
  setTimeout(() => {
    document.addEventListener("click", handler, { once: true });
  }, 0);
});

let runDebounce = null;
let dataRangeRunDebounce = null;

function updateHedgeInterval(val) {
  ui.hedgeIntervalHours = Number(val);
}

const hedgePct = computed(() => {
  const val = Number(ui.hedgeIntervalHours) || 1;
  return ((val - 1) / 23) * 100 + "%";
});

const mode = ref("single");
const ivRvChartRef = ref(null);
const ivRvSourceRows = ref([]);
const ivRvLoading = ref(false);
const ivRvError = ref("");
const ivRvTenor = ref(7);
const ivRvResolution = ref(24);
const ivRvShowIndex = ref(false);
const ivRvAlignForward = ref(false);
const ivRvRangeStart = ref(0);
const ivRvRangeEnd = ref(100);
const rvChartRef = ref(null);
const ivChartRef = ref(null);
const ivBoxplotRef = ref(null);
const rvBoxplotRef = ref(null);
const standardizedVrHeatmapRef = ref(null);
const showHeatmapDataLabels = ref(false);
const showIvHeatmapDataLabels = ref(false);
const rvHeatmapMetric = ref("average");
const ivHeatmapMetric = ref("average");
const varianceRatioRef = ref(null);
const serialAnchorHour = ref(8);
const serialAnchorWeekday = ref(5);
const rvBoxplotMonths = ref([...ALL_MONTHS]);
const ivBoxplotMonths = ref([...ALL_MONTHS]);
const rvRangeStart = ref(0);
const rvRangeEnd = ref(100);
const ivRangeStart = ref(0);
const ivRangeEnd = ref(100);
const IV_RV_TENORS = [7, 14, 30];
const IV_RV_RESOLUTIONS = [1, 4, 8, 24];
const fullIvRvRows = computed(() =>
  buildIvRvChartRows({
    rows: ivRvSourceRows.value,
    tenorDays: ivRvTenor.value,
    resolutionHours: ivRvResolution.value,
    alignForwardRv: ivRvAlignForward.value,
  }),
);
const ivRvExtent = computed(() => {
  const rows = fullIvRvRows.value;
  if (!rows.length) return null;
  return { min: rows[0].ts, max: rows.at(-1).ts };
});
const ivRvSelectedRange = computed(() => {
  const extent = ivRvExtent.value;
  if (!extent) return null;
  const span = extent.max - extent.min;
  return {
    start: extent.min + (span * ivRvRangeStart.value) / 100,
    end: extent.min + (span * ivRvRangeEnd.value) / 100,
  };
});
const ivRvRows = computed(() => {
  const range = ivRvSelectedRange.value;
  if (!range) return fullIvRvRows.value;
  return fullIvRvRows.value.filter(
    (row) => row.ts >= range.start && row.ts <= range.end,
  );
});
const ivRvRangeStartModel = computed({
  get: () => ivRvRangeStart.value,
  set: (value) => {
    ivRvRangeStart.value = Math.min(Number(value), ivRvRangeEnd.value - 0.1);
  },
});
const ivRvRangeEndModel = computed({
  get: () => ivRvRangeEnd.value,
  set: (value) => {
    ivRvRangeEnd.value = Math.max(Number(value), ivRvRangeStart.value + 0.1);
  },
});
const ivRvRangeStyle = computed(() => ({
  "--range-start": `${ivRvRangeStart.value}%`,
  "--range-end": `${ivRvRangeEnd.value}%`,
}));
const formatIvRvRangeDate = (ts) =>
  Number.isFinite(ts) ? new Date(ts * 1000).toISOString().slice(0, 10) : "—";
const ivRvRangeLabel = computed(() => {
  const range = ivRvSelectedRange.value;
  return range
    ? `${formatIvRvRangeDate(range.start)} – ${formatIvRvRangeDate(range.end)}`
    : "No range";
});
const ivRvSourceLatestLabel = computed(() => {
  const ts = ivRvSourceRows.value.at(-1)?.ts;
  return Number.isFinite(ts)
    ? `${new Date(ts * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`
    : "—";
});
const ivRvStats = computed(() => summarizeIvRvRows(ivRvRows.value));
const formatVol = (value) =>
  Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "—";
const aggregateVol = (values, metric) => {
  const sorted = values
    .filter(Number.isFinite)
    .sort((first, second) => first - second);
  if (!sorted.length) return Number.NaN;
  if (metric !== "median") {
    return sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  }
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};
const ivHourlyRows = computed(() =>
  buildHourlyIvRows(ivRvSourceRows.value, ivRvTenor.value),
);
const ivExtent = computed(() =>
  ivHourlyRows.value.length
    ? { min: ivHourlyRows.value[0].ts, max: ivHourlyRows.value.at(-1).ts }
    : null,
);
const ivSelectedRange = computed(() => {
  const extent = ivExtent.value;
  if (!extent) return null;
  const span = extent.max - extent.min;
  return {
    start: extent.min + (span * ivRangeStart.value) / 100,
    end: extent.min + (span * ivRangeEnd.value) / 100,
  };
});
const ivFilteredRows = computed(() => {
  const range = ivSelectedRange.value;
  return range
    ? ivHourlyRows.value.filter(
        (row) => row.ts >= range.start && row.ts <= range.end,
      )
    : ivHourlyRows.value;
});
const ivRangeStartModel = computed({
  get: () => ivRangeStart.value,
  set: (value) => {
    ivRangeStart.value = Math.min(Number(value), ivRangeEnd.value - 0.1);
  },
});
const ivRangeEndModel = computed({
  get: () => ivRangeEnd.value,
  set: (value) => {
    ivRangeEnd.value = Math.max(Number(value), ivRangeStart.value + 0.1);
  },
});
const ivRangeStyle = computed(() => ({
  "--range-start": `${ivRangeStart.value}%`,
  "--range-end": `${ivRangeEnd.value}%`,
}));
const ivRangeLabel = computed(() => {
  const range = ivSelectedRange.value;
  return range
    ? `${formatIvRvRangeDate(range.start)} – ${formatIvRvRangeDate(range.end)}`
    : "No range";
});
const ivHeatmapCells = computed(() =>
  buildHourlyIvHeatmap(ivFilteredRows.value, {
    metric: ivHeatmapMetric.value,
  }),
);
const ivMeasureLabel = computed(
  () => `${ivRvTenor.value}D constant-maturity IV`,
);
const ivHeatmapMethodology =
  "Method: exact total-variance interpolation · open/open marks.";
const ivBoxplotRows = computed(() => {
  const selected = new Set((ivBoxplotMonths.value || []).map(Number));
  if (selected.size === MONTH_OPTIONS.length) return ivFilteredRows.value;
  return ivFilteredRows.value.filter(
    (row) => row.date instanceof Date && selected.has(row.date.getUTCMonth()),
  );
});
const ivBoxplotGroups = computed(() =>
  buildHourlyIvWeekdayGroups(ivBoxplotRows.value),
);
const ivWeekdayInsights = computed(() =>
  summarizeRvWeekdayGroups(ivBoxplotGroups.value),
);
const ivHeatmapInsights = computed(() => {
  const rows = ivFilteredRows.value.filter((row) => Number.isFinite(row.iv));
  const cells = ivHeatmapCells.value.filter((cell) =>
    Number.isFinite(cell.average),
  );
  if (!rows.length || !cells.length) return null;
  const ranked = cells
    .slice()
    .sort((first, second) => first.average - second.average);
  return {
    average: aggregateVol(
      rows.map((row) => row.iv),
      ivHeatmapMetric.value,
    ),
    lowest: ranked[0],
    highest: ranked.at(-1),
    count: rows.length,
  };
});
const rvHourlyRows = computed(() =>
  buildHourlyParkinsonRows(ivRvSourceRows.value),
);
const rvExtent = computed(() =>
  rvHourlyRows.value.length
    ? { min: rvHourlyRows.value[0].ts, max: rvHourlyRows.value.at(-1).ts }
    : null,
);
const rvSelectedRange = computed(() => {
  const extent = rvExtent.value;
  if (!extent) return null;
  const span = extent.max - extent.min;
  return {
    start: extent.min + (span * rvRangeStart.value) / 100,
    end: extent.min + (span * rvRangeEnd.value) / 100,
  };
});
const rvFilteredRows = computed(() => {
  const range = rvSelectedRange.value;
  return range
    ? rvHourlyRows.value.filter(
        (row) => row.ts >= range.start && row.ts <= range.end,
      )
    : rvHourlyRows.value;
});
const rvRangeStartModel = computed({
  get: () => rvRangeStart.value,
  set: (value) => {
    rvRangeStart.value = Math.min(Number(value), rvRangeEnd.value - 0.1);
  },
});
const rvRangeEndModel = computed({
  get: () => rvRangeEnd.value,
  set: (value) => {
    rvRangeEnd.value = Math.max(Number(value), rvRangeStart.value + 0.1);
  },
});
const rvRangeStyle = computed(() => ({
  "--range-start": `${rvRangeStart.value}%`,
  "--range-end": `${rvRangeEnd.value}%`,
}));
const rvRangeLabel = computed(() => {
  const range = rvSelectedRange.value;
  return range
    ? `${formatIvRvRangeDate(range.start)} – ${formatIvRvRangeDate(range.end)}`
    : "No range";
});
const rvWeekdayGroups = computed(() =>
  buildHourlyRvWeekdayGroups(rvFilteredRows.value),
);
const rvBoxplotRows = computed(() => {
  const selected = new Set((rvBoxplotMonths.value || []).map(Number));
  if (selected.size === MONTH_OPTIONS.length) return rvFilteredRows.value;
  return rvFilteredRows.value.filter(
    (row) => row.date instanceof Date && selected.has(row.date.getUTCMonth()),
  );
});
const rvBoxplotGroups = computed(() =>
  buildHourlyRvWeekdayGroups(rvBoxplotRows.value),
);
const rvHeatmapCells = computed(() =>
  buildHourlyRvHeatmap(rvFilteredRows.value, {
    metric: rvHeatmapMetric.value,
  }),
);
const rvFilteredSourceRows = computed(() =>
  ivRvSourceRows.value.filter((row) => {
    const range = rvSelectedRange.value;
    return !range || (row.ts >= range.start && row.ts <= range.end);
  }),
);
const standardizedVrHeatmapCells = computed(() =>
  buildForwardVarianceRatioSeasonality(rvFilteredSourceRows.value, {
    adjustment: RETURN_ADJUSTMENT.VARIANCE_STANDARDIZED,
  }),
);
const varianceRatioAnalysis = computed(() =>
  calculateVarianceRatioDashboard(rvFilteredSourceRows.value, {
    adjustment: RETURN_ADJUSTMENT.RAW,
    closeHour: serialAnchorHour.value,
    closeWeekday: serialAnchorWeekday.value,
    anchorMode: "start",
    bootstrapReplications: 400,
  }),
);
const serialAnchorWeekdayLabel = computed(
  () =>
    WEEKDAY_OPTIONS.find((option) => option.value === serialAnchorWeekday.value)
      ?.label || "All weekdays",
);
const selectStandardizedVrCell = ({ weekday, hour }) => {
  serialAnchorWeekday.value = weekday;
  serialAnchorHour.value = hour;
};
const rvWeekdayInsights = computed(() =>
  summarizeRvWeekdayGroups(rvWeekdayGroups.value),
);
const sweepDimension = ref("entry_hour");
const sweepResults = ref([]);
const sweepRunning = ref(false);
const sweepProgress = ref("");
const sweepTiming = ref(null);
let sweepRunDebounce = null;
let sweepRerunPending = false;

const state = reactive({
  error: "",
  progress: "",
});

const result = ref(null);
let currentRunSequence = 0;

const SWEEP_DIMENSIONS = [
  { value: "entry_hour", label: "Entry hour" },
  { value: "entry_weekday", label: "Day of week" },
  { value: "maturity", label: "Maturity" },
  { value: "hedge_frequency", label: "Hedge frequency" },
  { value: "delta_band", label: "Strike delta" },
];

const availableSweepDimensions = computed(() =>
  SWEEP_DIMENSIONS.filter(
    (dimension) => (dimension.value !== "delta_band" || showDelta.value)
      && (dimension.value !== "hedge_frequency" || ui.structure !== "covered_call"),
  ),
);
const sweepDimensionLabel = computed(
  () =>
    SWEEP_DIMENSIONS.find(
      (dimension) => dimension.value === sweepDimension.value,
    )?.label || sweepDimension.value,
);

const formatUsd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const formatNumber = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
});

const hoursFor = (
  hour,
  enabled,
  interval,
  scheduledExitHour = null,
  includeExpiryRoll = false,
) => {
  const hs = new Set([Number(hour), 8]);
  if (Number.isInteger(Number(scheduledExitHour)))
    hs.add(Number(scheduledExitHour));
  if (enabled) {
    const step = Math.max(1, Math.min(24, Number(interval)));
    const addHedgeCycle = (startHour) => {
      let h = Number(startHour);
      do {
        hs.add(h);
        h = (h + step) % 24;
      } while (h !== Number(startHour));
    };
    addHedgeCycle(hour);
    if (includeExpiryRoll) addHedgeCycle(8);
  }
  return [...hs].sort((a, b) => a - b);
};
const requiredHours = computed(() =>
  hoursFor(
    ui.entryHourUtc,
    ui.hedgeEnabled,
    ui.hedgeIntervalHours,
    ui.exitMode === "weekly_schedule" ? ui.exitHourUtc : null,
    ui.exitMode === "after_days",
  ),
);
const requiredMaxDteDays = computed(() =>
  Math.max(
    Number(currentMaturity.value.maxDteDays) || 0,
    Number(currentMaturity.value.farDays) || 0,
  ),
);
const requiredDataKey = computed(
  () => `${underlying.value}|${requiredHours.value.join(",")}|dte:${requiredMaxDteDays.value}`,
);
let loadedDataKey = "";

const maxDrawdown = computed(() => {
  return computeMaxDrawdown(result.value?.cycleSummary);
});

const maturityConfigOverrides = (maturity) => ({
  targetDteDays: maturity.nearDays ?? maturity.value,
  farTargetDteDays: maturity.farDays,
  minWeeklyDteDays: maturity.minDteDays,
  maxWeeklyDteDays: maturity.maxDteDays,
});

const sweepConfigs = computed(() => {
  if (sweepDimension.value === "entry_hour") {
    return HOUR_OPTIONS.map((hour) => ({
      key: `hour-${hour.value}`,
      label: hour.label,
      overrides: { entryHourUtc: hour.value, hourlyOffset: hour.value },
    }));
  }
  if (sweepDimension.value === "entry_weekday") {
    return WEEKDAY_OPTIONS.map((weekday) => ({
      key: `weekday-${weekday.value}`,
      label: weekday.label,
      overrides: { entryWeekday: weekday.value },
    }));
  }
  if (sweepDimension.value === "maturity") {
    return maturityOptions.value.map((maturity) => ({
      key: `maturity-${maturity.value}`,
      label: maturity.label,
      maturityValue: maturity.value,
      overrides: maturityConfigOverrides(maturity),
    }));
  }
  if (sweepDimension.value === "hedge_frequency") {
    return HEDGE_FREQUENCY_OPTIONS.map((frequency) => ({
      key: `hedge-${frequency.value}`,
      label: frequency.label,
      overrides: { hedgeEnabled: true, hedgeIntervalHours: frequency.value },
    }));
  }
  if (!showDelta.value) return [];
  return DELTA_OPTIONS.map((delta) => ({
    key: `delta-${delta.value}`,
    label: delta.label,
    overrides: { targetDelta: delta.value },
  }));
});

const sweepInsights = computed(() => {
  const rows = sweepResults.value.filter((row) => Number.isFinite(row.pnl));
  if (!rows.length) return null;
  let bestPnl = rows[0];
  let bestSharpe = null;
  let profitable = 0;
  const pnlValues = [];
  for (const row of rows) {
    if (row.pnl > bestPnl.pnl) bestPnl = row;
    if (
      Number.isFinite(row.sharpe) &&
      (!bestSharpe || row.sharpe > bestSharpe.sharpe)
    ) {
      bestSharpe = row;
    }
    if (row.pnl > 0) profitable += 1;
    pnlValues.push(row.pnl);
  }
  const sortedPnl = pnlValues.sort((a, b) => a - b);
  const middle = Math.floor(sortedPnl.length / 2);
  const medianPnl =
    sortedPnl.length % 2
      ? sortedPnl[middle]
      : (sortedPnl[middle - 1] + sortedPnl[middle]) / 2;
  return {
    bestPnl,
    bestSharpe,
    medianPnl,
    profitable,
    total: rows.length,
  };
});

const entryWeekdayOption = computed(
  () =>
    ENTRY_WEEKDAY_OPTIONS.find(
      (option) => option.value === Number(ui.entryWeekday),
    ) || WEEKDAY_OPTIONS[4],
);

const exitModeExplanation = computed(() => {
  const entryWeekday = entryWeekdayOption.value;
  const exitWeekday =
    WEEKDAY_OPTIONS.find((option) => option.value === Number(ui.exitWeekday)) ||
    WEEKDAY_OPTIONS[0];
  const hourLabel = `${String(ui.entryHourUtc).padStart(2, "0")}:00`;
  const entryTime =
    entryWeekday.value === ENTRY_WEEKDAY_EVERY_DAY
      ? `daily ${hourLabel}`
      : `${entryWeekday.label.slice(0, 3)} ${hourLabel}`;
  const exitTime = `${exitWeekday.label.slice(0, 3)} ${String(ui.exitHourUtc).padStart(2, "0")}:00`;

  if (ui.exitMode === "expiry") {
    return `Keep each position open until its option expiry. Re-enter only at the first ${entryTime} UTC entry after it has closed.`;
  }
  if (ui.exitMode === "weekly_schedule") {
    if (entryWeekday.value === ENTRY_WEEKDAY_EVERY_DAY) {
      return `Close at the next ${exitTime} UTC after entry, then re-enter at the next daily ${hourLabel} UTC slot. If the option expires first, close at expiry.`;
    }
    const entryHourOfWeek =
      Number(ui.entryWeekday) * 24 + Number(ui.entryHourUtc);
    const exitHourOfWeek = Number(ui.exitWeekday) * 24 + Number(ui.exitHourUtc);
    let holdingHours = (exitHourOfWeek - entryHourOfWeek + 7 * 24) % (7 * 24);
    if (holdingHours === 0) holdingHours = 7 * 24;
    const days = Math.floor(holdingHours / 24);
    const hours = holdingHours % 24;
    const duration = [days ? `${days}d` : "", hours ? `${hours}h` : ""]
      .filter(Boolean)
      .join(" ");
    return `Close at the next ${exitTime} UTC after entry (${duration} later), then stay in cash until the next ${entryTime} entry. If the option expires first, close at expiry.`;
  }
  if (entryWeekday.value === ENTRY_WEEKDAY_EVERY_DAY) {
    return `Target a roll every ${ui.exitHoldDays} calendar day${ui.exitHoldDays === 1 ? "" : "s"} at ${hourLabel} UTC every day. If the option expires first, close at expiry and reopen at the next daily entry hour.`;
  }
  return `Target a roll every ${ui.exitHoldDays} calendar day${ui.exitHoldDays === 1 ? "" : "s"} at the configured entry hour, re-entering only on ${entryWeekday.label}s. If the option expires first, close at expiry and wait until that entry hour before reopening.`;
});

const strategyLabels = computed(() => {
  const maturity = currentMaturity.value;
  const structure =
    STRUCTURE_OPTIONS.find((option) => option.value === ui.structure) ||
    STRUCTURE_OPTIONS[0];
  const delta =
    DELTA_OPTIONS.find((option) => option.value === Number(ui.targetDelta)) ||
    DEFAULT_DELTA_OPTION;
  const weekday = entryWeekdayOption.value;
  const side = ui.structure === "covered_call" ? "" : ui.longOption ? "Long" : "Short";
  const hour = String(ui.entryHourUtc).padStart(2, "0");
  const exitWeekday =
    WEEKDAY_OPTIONS.find((option) => option.value === Number(ui.exitWeekday)) ||
    WEEKDAY_OPTIONS[0];
  const exitHour = String(ui.exitHourUtc).padStart(2, "0");
  const option = showDelta.value ? `${delta.label} ${structure.label}` : "ATM";
  const entryLabel =
    weekday.value === ENTRY_WEEKDAY_EVERY_DAY
      ? `Daily ${hour}:00`
      : `${weekday.label.slice(0, 3)} ${hour}:00`;

  let chartStrategy = `${side} straddle ${maturity.label}`;
  if (ui.structure === "covered_call") {
    chartStrategy = `Covered call ${maturity.label} (${delta.label}), long underlying`;
  } else if (ui.structure === "strangle") {
    chartStrategy = `${side} strangle ${maturity.label} (${delta.label})`;
  } else if (ui.structure === "risk_reversal") {
    chartStrategy = `Risk reversal ${maturity.label} (${delta.label} call ${ui.longOption ? "long" : "short"} / put ${ui.longOption ? "short" : "long"})`;
  } else if (ui.structure === "call" || ui.structure === "put") {
    chartStrategy = `${side} ${ui.structure} ${maturity.label} (${delta.label})`;
  } else if (ui.structure === "calendar_spread") {
    chartStrategy = `${side} ATM calendar spread ${maturity.label}`;
  }

  return {
    instrument: `${underlying.value} · ${side} ${structure.label} · ${maturity.label} ${option} · ${ui.investmentMode === "btc" ? `1 ${underlying.value}` : "$100k"}`,
    entry: entryLabel,
    weekday: weekday.label,
    hedge: ui.structure === "covered_call" ? "Fixed underlying" : !ui.hedgeEnabled
      ? "Off"
      : ui.hedgeIntervalHours === 24
        ? `Daily ${hour}:00`
        : `Every ${ui.hedgeIntervalHours}h`,
    exit:
      ui.exitMode === "expiry"
        ? "Option expiry"
        : ui.exitMode === "weekly_schedule"
          ? `Pick close · ${exitWeekday.label.slice(0, 3)} ${exitHour}:00`
          : `Roll every ${ui.exitHoldDays}D`,
    chart: ui.structure === "covered_call"
      ? chartStrategy
      : `${chartStrategy}, ${ui.hedgeEnabled ? `hedged every ${ui.hedgeIntervalHours}h` : "unhedged"}`,
  };
});

// Metrics for new design (only 3)
const finalPnlValue = computed(() => {
  if (!result.value?.summary) return "—";
  return formatUsd.format(result.value.summary.finalEquityUsd);
});

const sharpeValue = computed(() => {
  const s = result.value?.summary?.sharpeRatio;
  return Number.isFinite(s) ? formatNumber.format(s) : "—";
});

const maxDdValue = computed(() => {
  if (!result.value) return "—";
  const dd = maxDrawdown.value;
  return formatUsd.format(dd);
});

// Chart data and titles
const chartRef = ref(null);
const sweepChartRef = ref(null);
const chartMode = ref("weekly");
const distributionViewMode = ref("time");
const attributionRows = ref([]);
const attributionCycleRows = ref([]);
const attributionLoading = ref(false);
const attributionError = ref("");
const csvExporting = ref(false);
let attributionResult = null;
let attributionLoadPromise = null;
let attributionLoadResult = null;
let attributionDataResolution = null;
let attributionLoadResolution = null;
let currentAttributionSequence = 0;
const selectedCycle = ref(null);
const cycleDetailRows = ref([]);
const cycleBreakEvens = ref(null);
const cycleContours = ref(null);
const cycleDetailLoading = ref(false);
const cycleDetailError = ref("");
const cycleDetailCache = new Map();
let currentCycleDetailSequence = 0;
const cycleRows = computed(() => result.value?.cycleSummary || []);
const showDailyPnl = computed(
  () =>
    cycleRows.value.length > 0 &&
    cycleRows.value.length < DAILY_PNL_CYCLE_THRESHOLD,
);
const dailyPnlRows = computed(() =>
  buildDailyPnlRows({
    rows: attributionRows.value,
    // The attribution timeline contains closed cycles only. Let its first and
    // final observations define the chart bounds instead of padding cash days
    // at either edge of the requested market-data range.
  }),
);
const pnlChartRows = computed(() =>
  showDailyPnl.value ? dailyPnlRows.value : cycleRows.value,
);

const clearAttribution = () => {
  currentAttributionSequence += 1;
  attributionRows.value = [];
  attributionCycleRows.value = [];
  attributionLoading.value = false;
  attributionError.value = "";
  attributionResult = null;
  attributionLoadPromise = null;
  attributionLoadResult = null;
  attributionDataResolution = null;
  attributionLoadResolution = null;
};

const clearCycleDetail = ({ clearCache = false } = {}) => {
  currentCycleDetailSequence += 1;
  selectedCycle.value = null;
  cycleDetailRows.value = [];
  cycleBreakEvens.value = null;
  cycleContours.value = null;
  cycleDetailLoading.value = false;
  cycleDetailError.value = "";
  if (clearCache) cycleDetailCache.clear();
};

const chartTitle = computed(() => {
  if (selectedCycle.value) {
    const entry = new Date(selectedCycle.value.entryTime).toLocaleDateString(
      "en-GB",
      {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      },
    );
    return `${entry} cycle · hourly detail`;
  }
  return chartMode.value === "weekly" && showDailyPnl.value
    ? `${strategyLabels.value.chart} · daily PnL`
    : strategyLabels.value.chart;
});

const chartSubtitle = computed(() => {
  if (selectedCycle.value) {
    const legs = selectedCycle.value.legs
      .map((leg) => leg.instrumentName)
      .join(" · ");
    if (cycleBreakEvens.value) {
      const be = cycleBreakEvens.value;
      const fmt = (v) =>
        Number.isFinite(v)
          ? v.toLocaleString("en-US", { maximumFractionDigits: 0 })
          : null;
      const parts = [];
      if (Number.isFinite(be.lower)) parts.push(`BE low ${fmt(be.lower)}`);
      if (Number.isFinite(be.upper)) parts.push(`BE high ${fmt(be.upper)}`);
      if (parts.length) return `${legs}  ·  ${parts.join(" / ")}`;
    }
    return legs;
  }
  const weekday = entryWeekdayOption.value;
  const entryTime = `${String(ui.entryHourUtc).padStart(2, "0")}:00 UTC`;
  const exitWeekday =
    WEEKDAY_OPTIONS.find((o) => o.value === Number(ui.exitWeekday)) ||
    WEEKDAY_OPTIONS[0];
  const exit =
    ui.exitMode === "expiry"
      ? "Held to expiry"
      : ui.exitMode === "weekly_schedule"
        ? `Exited ${exitWeekday.label} at ${String(ui.exitHourUtc).padStart(2, "0")}:00 UTC; cash until next entry`
        : `Rolled every ${ui.exitHoldDays}D at ${entryTime}; expiry-first gaps allowed`;
  const sizing =
    ui.investmentMode === "btc"
      ? `1 ${underlying.value} per leg`
      : "$100k notional";
  const entryDay =
    weekday.value === ENTRY_WEEKDAY_EVERY_DAY ? "every day" : weekday.label;
  const strategyDetail = `Entered ${entryDay} at ${entryTime} · ${exit} · ${sizing}`;
  return chartMode.value === "weekly" && showDailyPnl.value
    ? `Daily UTC mark-to-market · ${strategyDetail}`
    : strategyDetail;
});

const chartSourceSubtitle = computed(() => {
  if (!result.value) return "Source: Thalex";
  const start = selectedDataRange.value.start;
  const end = result.value.dataEnd || new Date();
  const formatPeriodDate = (date) =>
    date.toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
  return `Source: Thalex · Backtest: ${formatPeriodDate(start)} – ${formatPeriodDate(end)}`;
});

const buildConfig = (overrides = {}) => {
  const m = currentMaturity.value;
  const range = selectedDataRange.value;
  return normalizeBacktestConfig({
    start: range.start,
    end: range.end,
    ...maturityConfigOverrides(m),
    structure: ui.structure,
    targetDelta: Number(ui.targetDelta),
    entryWeekday: Number(ui.entryWeekday),
    entryHourUtc: Number(ui.entryHourUtc),
    hourlyOffset: Number(ui.entryHourUtc),
    hedgeEnabled: ui.hedgeEnabled,
    hedgeIntervalHours: Number(ui.hedgeIntervalHours),
    exitMode: ui.exitMode,
    exitHoldDays: Number(ui.exitHoldDays),
    exitWeekday: Number(ui.exitWeekday),
    exitHourUtc: Number(ui.exitHourUtc),
    longOption: ui.longOption,
    sizingMode: ui.investmentMode,
    btcQuantity: 1,
    includeGreekAttribution: false,
    ...overrides,
  });
};

const runSweep = async () => {
  clearTimeout(sweepRunDebounce);
  sweepRunDebounce = null;
  if (!sweepConfigs.value.length) return;
  if (sweepRunning.value) {
    sweepRerunPending = true;
    return;
  }
  sweepRerunPending = false;
  sweepRunning.value = true;
  sweepResults.value = [];
  sweepTiming.value = null;
  state.error = "";
  const requestedUnderlying = underlying.value;
  const requestedDataRoot = currentUnderlying.value.dataRoot;
  // Let the running state paint before data preparation and synchronous simulations begin.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const cells = sweepConfigs.value;
  const configs = cells.map((cell) =>
    buildConfig({
      ...cell.overrides,
      includeGreekAttribution: false,
    }),
  );
  const sweepHours = [
    ...new Set(
      configs.flatMap((config) =>
        hoursFor(
          config.entryHourUtc,
          config.hedgeEnabled,
          config.hedgeIntervalHours,
          config.exitMode === "weekly_schedule" ? config.exitHourUtc : null,
          config.exitMode === "after_days",
        ),
      ),
    ),
  ].sort((a, b) => a - b);
  const sweepHoursKey = sweepHours.join(",");
  const sweepMaxDteDays = Math.max(...configs.map(requiredQuoteDteDays));
  const sweepDataKey = `${requestedUnderlying}|${sweepHoursKey}|dte:${sweepMaxDteDays}`;
  const startedAt = performance.now();
  try {
    const loadRequest = {
      start: DATA_RANGE_START,
      end: DATA_RANGE_END,
      hourlyOffsets: sweepHours,
      maxDteDays: sweepMaxDteDays,
      dataRoot: requestedDataRoot,
    };

    const progressiveResults = new Array(cells.length);
    const buildSweepResult = (run, index) => {
      const cell = cells[index];
      const thisConfig = configs[index];
      const weeklyReturns = (run.cycleSummary || []).map((cycle) => ({
        pnl: Number(cycle.cyclePnlUsd) || 0,
        hour: thisConfig.entryHourUtc,
        entryDate: cycle.entryTime,
      }));

      return {
        ...cell,
        config: thisConfig,
        sharpe: run.summary.sharpeRatio,
        pnl: run.summary.finalEquityUsd,
        optionPnl: run.summary.cumulativeOptionPnlUsd,
        hedgePnl: run.summary.cumulativeHedgePnlUsd,
        averageEntryDteDays: run.summary.meanEntryDteDays,
        averageHoldingPeriodDays: run.summary.meanHoldingPeriodDays,
        averageEntryIv: run.summary.meanEntryImpliedVol,
        averageSampledRealizedVol: run.summary.meanSampledRealizedVol,
        maxDrawdown: computeMaxDrawdown(run.cycleSummary),
        cycles: run.counts.closedCycles,
        returnOnNotional: run.summary.cumulativeReturnOnNotional,
        weeklyReturns,
      };
    };

    const workerResult = await runSweepInWorker({
      datasetKey: sweepDataKey,
      loadRequest,
      prepareConfig: {
        ...configs[0],
        start: DATA_RANGE_START,
        end: DATA_RANGE_END,
      },
      configs,
      onProgress: ({ message }) => {
        if (requestedUnderlying === underlying.value && message) {
          sweepProgress.value = message;
        }
      },
      onResult: ({ index, result: run }) => {
        if (requestedUnderlying !== underlying.value) return;
        const row = buildSweepResult(run, index);
        if (row.weeklyReturns.some(({ pnl }) => pnl !== 0)) {
          progressiveResults[index] = row;
        }
        sweepResults.value = progressiveResults.filter(Boolean);
        sweepProgress.value = `Completed ${index + 1}/${cells.length} configurations`;
      },
    });
    if (requestedUnderlying === underlying.value) {
      sweepTiming.value = {
        loadMs: workerResult.timing.loadMs,
        prepareMs: workerResult.timing.prepareMs,
        runMs: workerResult.timing.runMs,
        totalMs: performance.now() - startedAt,
        reusedPreparedData: workerResult.timing.reusedPreparedData,
        cells: cells.length,
      };
      sweepProgress.value = "";
    }
  } catch (error) {
    if (requestedUnderlying === underlying.value) {
      state.error = error?.message || "Sweep failed";
    }
  } finally {
    sweepRunning.value = false;
    if (requestedUnderlying !== underlying.value) sweepRerunPending = true;
    if (sweepRerunPending && mode.value === "sweep") {
      sweepRerunPending = false;
      void runSweep();
    }
  }
};

const scheduleSweep = () => {
  state.error = "";
  clearTimeout(sweepRunDebounce);
  if (mode.value !== "sweep") return;
  sweepResults.value = [];
  sweepTiming.value = null;
  if (!sweepRunning.value) sweepProgress.value = "";
  sweepRunDebounce = setTimeout(() => {
    sweepRunDebounce = null;
    if (mode.value === "sweep") void runSweep();
  }, 80);
};

const applySweepResult = (cell) => {
  if (sweepDimension.value === "entry_hour") {
    ui.entryHourUtc = cell.config.entryHourUtc;
  } else if (sweepDimension.value === "entry_weekday") {
    ui.entryWeekday = cell.config.entryWeekday;
  } else if (sweepDimension.value === "maturity") {
    ui.maturityDays = cell.maturityValue;
  } else if (sweepDimension.value === "hedge_frequency") {
    ui.hedgeEnabled = true;
    ui.hedgeIntervalHours = cell.config.hedgeIntervalHours;
  } else if (sweepDimension.value === "delta_band") {
    ui.targetDelta = cell.config.targetDelta;
  }
  mode.value = "single";
};

const switchMode = (nextMode) => {
  const previousMode = mode.value;
  mode.value = nextMode;
  selectedCycle.value = null;
  if (nextMode === "single") {
    if (!result.value) scheduleBacktest();
    else if (chartMode.value === "weekly" && showDailyPnl.value) {
      void loadAttribution({ resolution: "hourly" });
    }
  } else if (nextMode === "sweep" && previousMode !== "sweep") {
    void runSweep();
  } else if (
    ["iv-rv", "rv", "iv"].includes(nextMode) &&
    !ivRvSourceRows.value.length
  ) {
    loadIvRv();
  }
};

const selectSingleView = (nextChartMode) => {
  chartMode.value = nextChartMode;
  mode.value = "single";
  selectedCycle.value = null;
  if (!result.value) scheduleBacktest();
  else if (nextChartMode === "greeks") void loadAttribution();
  else if (nextChartMode === "weekly" && showDailyPnl.value) {
    void loadAttribution({ resolution: "hourly" });
  }
  requestAnimationFrame(() => {
    if (document.activeElement instanceof HTMLElement)
      document.activeElement.blur();
  });
};

const STUDY_MODES = ["rv", "iv", "iv-rv"];
const selectStudy = (nextMode) => {
  switchMode(nextMode);
  requestAnimationFrame(() => {
    if (document.activeElement instanceof HTMLElement)
      document.activeElement.blur();
  });
};

const loadIvRv = async () => {
  if (ivRvLoading.value) return;
  ivRvLoading.value = true;
  ivRvError.value = "";
  const requestedUnderlying = underlying.value;
  try {
    const rows = await loadIvRvHistory({
      dataRoot: currentUnderlying.value.dataRoot,
    });
    if (requestedUnderlying === underlying.value) ivRvSourceRows.value = rows;
  } catch (error) {
    if (requestedUnderlying === underlying.value) {
      ivRvError.value = error?.message || "Unable to load IV/RV data";
    }
  } finally {
    if (requestedUnderlying === underlying.value) ivRvLoading.value = false;
  }
};

const runCurrent = async () => {
  if (!hasWorkerDataset(loadedDataKey)) {
    await loadBacktest();
    return;
  }
  const runSequence = ++currentRunSequence;
  clearCycleDetail({ clearCache: true });
  clearAttribution();
  result.value = null;
  const config = buildConfig();
  state.progress = "Running strategy";
  try {
    const response = await runSingleInWorker({
      datasetKey: loadedDataKey,
      config,
      onProgress: ({ message }) => {
        if (runSequence === currentRunSequence && message)
          state.progress = message;
      },
    });
    if (runSequence !== currentRunSequence) return;
    result.value = response.result;
    state.progress = "";
    if (chartMode.value === "greeks") void loadAttribution();
    else if (chartMode.value === "weekly" && showDailyPnl.value) {
      void loadAttribution({ resolution: "hourly" });
    }
  } catch (error) {
    if (runSequence !== currentRunSequence) return;
    state.error = error?.message || "Backtest failed";
    state.progress = "";
  }
};

const loadAttribution = ({ resolution = "strategy" } = {}) => {
  const sourceResult = result.value;
  if (!sourceResult) return Promise.resolve();
  const hasRequiredResolution =
    attributionDataResolution === "hourly" ||
    attributionDataResolution === resolution;
  if (
    attributionResult === sourceResult &&
    attributionRows.value.length &&
    hasRequiredResolution
  ) {
    return Promise.resolve();
  }
  const pendingResolutionSatisfies =
    attributionLoadResolution === "hourly" ||
    attributionLoadResolution === resolution;
  if (
    attributionLoadPromise &&
    attributionLoadResult === sourceResult &&
    pendingResolutionSatisfies
  ) {
    return attributionLoadPromise;
  }

  const attributionSequence = ++currentAttributionSequence;
  attributionLoading.value = true;
  attributionError.value = "";
  attributionLoadResult = sourceResult;
  attributionLoadResolution = resolution;
  const request = (async () => {
    try {
      const range = selectedDataRange.value;
      const useHourlyData = resolution === "hourly";
      const hourlyDatasetKey = [
        underlying.value,
        "attribution-hourly",
        Math.floor(range.start.getTime() / 1_000),
        Math.floor(range.end.getTime() / 1_000),
        `dte:${requiredMaxDteDays.value}`,
      ].join("|");
      const response = await runAttributionInWorker({
        datasetKey: useHourlyData
          ? hourlyDatasetKey
          : loadedDataKey || requiredDataKey.value,
        loadRequest: useHourlyData
          ? {
              start: range.start,
              end: range.end,
              hourlyOffsets: Array.from({ length: 24 }, (_, hour) => hour),
              maxDteDays: requiredMaxDteDays.value,
              dataRoot: currentUnderlying.value.dataRoot,
            }
          : undefined,
        config: buildConfig(),
      });
      if (
        attributionSequence !== currentAttributionSequence ||
        sourceResult !== result.value
      )
        return;
      attributionRows.value = response.result?.timeline || [];
      attributionCycleRows.value = response.result?.cycles || [];
      attributionResult = sourceResult;
      attributionDataResolution = resolution;
    } catch (error) {
      if (attributionSequence !== currentAttributionSequence) return;
      attributionError.value =
        error?.message || "Unable to calculate PnL attribution";
    } finally {
      if (attributionSequence === currentAttributionSequence) {
        attributionLoading.value = false;
      }
    }
  })();
  attributionLoadPromise = request;
  request.finally(() => {
    if (attributionLoadPromise === request) {
      attributionLoadPromise = null;
      attributionLoadResult = null;
      attributionLoadResolution = null;
    }
  });
  return request;
};

const closeCycleDetail = () => {
  clearCycleDetail();
};

const handleCycleSelect = async (cycle) => {
  if (!cycle || cycleDetailLoading.value) return;
  selectedCycle.value = cycle;
  cycleBreakEvens.value = computeBreakEvens(cycle);
  cycleDetailError.value = "";
  const detailSequence = ++currentCycleDetailSequence;
  const cacheKey = [
    cycle.entryTs,
    cycle.exitTs,
    cycle.hedgeEnabled,
    cycle.hedgeIntervalHours,
  ].join("|");
  if (cycleDetailCache.has(cacheKey)) {
    const cached = cycleDetailCache.get(cacheKey);
    cycleDetailRows.value = cached.rows;
    cycleContours.value = cached.contours;
    return;
  }

  cycleDetailLoading.value = true;
  cycleDetailRows.value = [];
  try {
    const config = buildConfig({
      start: new Date(cycle.entryTime),
      end: new Date(cycle.exitTime),
    });
    const detailMaxDteDays = Math.max(
      ...cycle.legs.map((leg) => (leg.expirationTs - cycle.entryTs) / 86_400),
    );
    const loaded = await loadThalexHistory({
      start: config.start,
      end: config.end,
      hourlyOffsets: Array.from({ length: 24 }, (_, hour) => hour),
      maxDteDays: detailMaxDteDays,
      dataRoot: currentUnderlying.value.dataRoot,
    });
    const detailData = prepareCycleDetailData({
      plan: cycle,
      indexRows: loaded.indexRows,
      quoteSnapshots: loaded.quoteSnapshots,
      instruments: loaded.artifact.instruments,
      config,
    });
    const rows = buildCycleDetail({
      plan: cycle,
      preparedData: detailData,
      config,
    });
    const contours = computeZeroMtmContours({
      plan: cycle,
      preparedData: detailData,
      timestamps: rows.map((row) => row.ts),
      price: blackScholesPrice,
      surfaceMode: "sticky_strike",
    });
    if (detailSequence !== currentCycleDetailSequence) return;
    cycleDetailCache.set(cacheKey, { rows, contours });
    cycleDetailRows.value = rows;
    cycleContours.value = contours;
  } catch (error) {
    if (detailSequence !== currentCycleDetailSequence) return;
    cycleDetailError.value =
      error?.message || "Unable to load hourly cycle detail";
  } finally {
    if (detailSequence === currentCycleDetailSequence) {
      cycleDetailLoading.value = false;
    }
  }
};

const loadBacktest = async () => {
  const runSequence = ++currentRunSequence;
  clearCycleDetail({ clearCache: true });
  clearAttribution();
  result.value = null;
  state.error = "";
  state.progress = "Loading data";
  try {
    const config = buildConfig();
    const datasetKey = requiredDataKey.value;
    const response = await runSingleInWorker({
      datasetKey,
      loadRequest: {
        start: DATA_RANGE_START,
        end: DATA_RANGE_END,
        hourlyOffsets: requiredHours.value,
        maxDteDays: requiredMaxDteDays.value,
        dataRoot: currentUnderlying.value.dataRoot,
      },
      prepareConfig: {
        ...config,
        start: DATA_RANGE_START,
        end: DATA_RANGE_END,
      },
      config,
      onProgress: ({ message }) => {
        if (runSequence === currentRunSequence && message)
          state.progress = message;
      },
    });
    if (runSequence !== currentRunSequence) return;
    loadedDataKey = datasetKey;
    result.value = response.result;
    if (
      isAllDataRange.value &&
      response.result?.dataEnd instanceof Date &&
      response.result.dataEnd < dataRangeAvailableEnd.value
    ) {
      dataRangeAvailableEnd.value = new Date(response.result.dataEnd);
    }
    state.progress = "";
    if (chartMode.value === "greeks") void loadAttribution();
    else if (chartMode.value === "weekly" && showDailyPnl.value) {
      void loadAttribution({ resolution: "hourly" });
    }
  } catch (error) {
    if (runSequence !== currentRunSequence) return;
    state.error = error?.message || "Backtest failed";
    state.progress = "";
  }
};

const scheduleBacktest = () => {
  state.error = "";
  clearTimeout(runDebounce);
  if (mode.value !== "single") return;
  runDebounce = setTimeout(() => {
    if (
      requiredDataKey.value !== loadedDataKey ||
      !hasWorkerDataset(requiredDataKey.value)
    ) {
      void loadBacktest();
    } else {
      void runCurrent();
    }
  }, 80);
};

let scheduledUiKey = "";
watch(
  () => [
    ui.maturityDays,
    ui.structure,
    ui.targetDelta,
    ui.entryWeekday,
    ui.entryHourUtc,
    ui.hedgeEnabled,
    ui.hedgeIntervalHours,
    ui.exitMode,
    ui.exitHoldDays,
    ui.exitWeekday,
    ui.exitHourUtc,
    ui.longOption,
    ui.investmentMode,
  ],
  () => {
    if (ui.structure === "covered_call") {
      ui.longOption = false;
      ui.hedgeEnabled = false;
      if (sweepDimension.value === "hedge_frequency") sweepDimension.value = "entry_hour";
    }
    const isCalendarMaturity = CALENDAR_MATURITY_OPTIONS.some(
      (option) => String(option.value) === String(ui.maturityDays),
    );
    if (ui.structure === "calendar_spread" && !isCalendarMaturity) {
      ui.maturityDays = CALENDAR_MATURITY_OPTIONS[0].value;
    } else if (ui.structure !== "calendar_spread" && isCalendarMaturity) {
      ui.maturityDays = DEFAULT_MATURITY_DAYS;
    }
    if (ui.exitHoldDays > maxExitHoldDays.value) {
      ui.exitHoldDays = maxExitHoldDays.value;
    }
    if (!showDelta.value && sweepDimension.value === "delta_band") {
      sweepDimension.value = "entry_hour";
    }
    if (!ui.hedgeEnabled && chartMode.value === "hedge") {
      chartMode.value = "weekly";
    }
    const uiKey = [
      ui.maturityDays,
      ui.structure,
      ui.targetDelta,
      ui.entryWeekday,
      ui.entryHourUtc,
      ui.hedgeEnabled,
      ui.hedgeIntervalHours,
      ui.exitMode,
      ui.exitHoldDays,
      ui.exitWeekday,
      ui.exitHourUtc,
      ui.longOption,
      ui.investmentMode,
    ].join("|");
    if (uiKey === scheduledUiKey) return;
    scheduledUiKey = uiKey;
    if (mode.value === "sweep") {
      scheduleSweep();
    } else if (mode.value === "single") {
      scheduleBacktest();
    } else {
      result.value = null;
    }
  },
);

watch([dataRangeStart, dataRangeEnd], () => {
  scheduleDataRangeLabelUpdate();
  clearTimeout(dataRangeRunDebounce);
  dataRangeRunDebounce = setTimeout(() => {
    dataRangeRunDebounce = null;
    if (mode.value === "sweep") {
      scheduleSweep();
    } else if (mode.value === "single") {
      scheduleBacktest();
    }
  }, DATA_RANGE_RUN_DEBOUNCE_MS);
});

watch(sweepDimension, () => {
  scheduleSweep();
});

async function handleExportCsv() {
  const sourceResult = result.value;
  if (!sourceResult?.cycleSummary?.length || csvExporting.value) return;
  csvExporting.value = true;
  try {
    await loadAttribution();
    if (sourceResult !== result.value) return;
    const csv = buildWeeklyPnlCsv(
      sourceResult.cycleSummary,
      attributionResult === sourceResult ? attributionCycleRows.value : [],
      { underlying: underlying.value },
    );
    if (!csv) return;
    const date = new Date().toISOString().slice(0, 10);
    downloadCsv({
      csv,
      filename: `${underlying.value.toLowerCase()}-backtest-weekly-pnl-${date}.csv`,
    });
  } finally {
    csvExporting.value = false;
  }
}

function handleSavePng() {
  const date = new Date().toISOString().slice(0, 10);

  if (mode.value === "iv-rv") {
    if (!ivRvChartRef.value || !ivRvRows.value.length) return;
    ivRvChartRef.value.exportPng({
      filename: `rv-iv-${ivRvTenor.value}d-${ivRvResolution.value}h${ivRvAlignForward.value ? "-shifted" : ""}${ivRvShowIndex.value ? "-index" : ""}-${date}.png`,
      scale: 4,
      padding: 24,
    });
    return;
  }

  if (mode.value === "rv") {
    saveRvHeatmap(date);
    return;
  }

  if (mode.value === "iv") {
    saveIvHeatmap(date);
    return;
  }

  if (mode.value === "sweep") {
    if (!sweepChartRef.value) return;
    const filename = `sweep-${sweepDimension.value}-${date}.png`;
    sweepChartRef.value.exportPng({
      title: `Parameter Sweep: ${sweepDimensionLabel.value}`,
      subtitle: chartSubtitle.value,
      source: chartSourceSubtitle.value,
      filename,
      scale: 4,
      padding: 24,
    });
    return;
  }

  if (!chartRef.value) return;

  const filename = selectedCycle.value
    ? `cycle-detail-${date}.png`
    : chartMode.value === "greeks"
      ? `pnl-attribution-${date}.png`
      : chartMode.value === "distribution"
        ? `fair-value-distribution-${date}.png`
        : chartMode.value === "hedge"
          ? `hedge-performance-${date}.png`
          : `backtest-${date}.png`;
  chartRef.value.exportPng({
    filename,
    scale: 4,
    title: chartTitle.value,
    subtitle: chartSubtitle.value,
    source: chartSourceSubtitle.value,
    metrics:
      selectedCycle.value || chartMode.value !== "weekly"
        ? []
        : [
            { label: "FINAL PNL", value: finalPnlValue.value },
            { label: "SHARPE", value: sharpeValue.value },
            { label: "MAX DRAWDOWN", value: maxDdValue.value, muted: true },
          ],
  });
}

function saveRvHeatmap(date = new Date().toISOString().slice(0, 10)) {
  if (!rvWeekdayInsights.value) return;
  const chart = rvChartRef.value;
  if (!chart) return;
  chart.exportPng({
    filename: `rv-hourly-heatmap-${date}.png`,
    scale: 4,
    padding: 24,
  });
}

function saveIvHeatmap(date = new Date().toISOString().slice(0, 10)) {
  if (!ivHeatmapInsights.value || !ivChartRef.value) return;
  ivChartRef.value.exportPng({
    filename: `iv-${ivRvTenor.value}d-hourly-heatmap-${date}.png`,
    scale: 4,
    padding: 24,
  });
}

function saveIvBoxplot(date = new Date().toISOString().slice(0, 10)) {
  if (!ivBoxplotRef.value || !ivWeekdayInsights.value) return;
  ivBoxplotRef.value.exportPng({
    filename: `iv-${ivRvTenor.value}d-weekday-boxplot-${date}.png`,
    scale: 4,
    padding: 24,
  });
}

function saveRvBoxplot(date = new Date().toISOString().slice(0, 10)) {
  if (!rvBoxplotRef.value || !rvWeekdayInsights.value) return;
  rvBoxplotRef.value.exportPng({
    filename: `rv-weekday-boxplot-${date}.png`,
    scale: 4,
    padding: 24,
  });
}

function saveStandardizedVrHeatmap(
  date = new Date().toISOString().slice(0, 10),
) {
  if (
    !standardizedVrHeatmapRef.value ||
    !standardizedVrHeatmapCells.value.length
  )
    return;
  standardizedVrHeatmapRef.value.exportPng({
    filename: `${underlying.value.toLowerCase()}-variance-standardized-vr24-heatmap-${date}.png`,
    scale: 4,
    padding: 24,
  });
}

function saveVarianceRatio(date = new Date().toISOString().slice(0, 10)) {
  if (!varianceRatioRef.value || !varianceRatioAnalysis.value.sampleSize)
    return;
  varianceRatioRef.value.exportPng({
    filename: `${underlying.value.toLowerCase()}-forward-variance-ratio-raw-${serialAnchorWeekdayLabel.value.toLowerCase()}-${String(serialAnchorHour.value).padStart(2, "0")}utc-${date}.png`,
    scale: 4,
    padding: 24,
  });
}

function switchUnderlying(nextUnderlying) {
  if (nextUnderlying === underlying.value) return;
  underlying.value = nextUnderlying;
  dataRangeAvailableEnd.value = new Date(DATA_RANGE_END);
  result.value = null;
  ivRvSourceRows.value = [];
  ivRvError.value = "";
  ivRvLoading.value = false;
  clearCycleDetail({ clearCache: true });
  clearAttribution();
  if (mode.value === "single") void loadBacktest();
  else if (mode.value === "sweep") void runSweep();
  else void loadIvRv();
}

onMounted(loadBacktest);
</script>

<template>
  <main class="app">
    <!-- Top bar -->
    <div class="topBar">
      <div class="underlyingToggle" role="group" aria-label="Underlying">
        <button
          v-for="option in UNDERLYING_OPTIONS"
          :key="option.value"
          type="button"
          :class="{ active: underlying === option.value }"
          :aria-pressed="underlying === option.value"
          @click="switchUnderlying(option.value)"
        >
          {{ option.label }}
        </button>
      </div>
      <div class="divider"></div>

      <div class="configPills">
        <!-- Instrument -->
        <div
          class="pill instrumentPill"
          style="position: relative"
          @click="toggleMenu('instrument')"
        >
          <span class="pillLabel">Instrument</span>
          <span class="pillValue">{{ strategyLabels.instrument }}</span>
          <div
            v-if="openMenu === 'instrument'"
            class="dropdown instrument-dropdown"
            @click.stop
          >
            <div v-if="ui.structure !== 'covered_call'" class="inst-field">
              <label class="inst-label">Side</label>
              <div class="inst-choices side-choices">
                <div
                  :class="['inst-choice', { active: !ui.longOption }]"
                  @click="ui.longOption = false"
                >
                  Short
                </div>
                <div
                  :class="['inst-choice', { active: ui.longOption }]"
                  @click="ui.longOption = true"
                >
                  Long
                </div>
              </div>
            </div>
            <div class="inst-field">
              <label class="inst-label">Structure</label>
              <div class="inst-choices structure-choices">
                <div
                  v-for="s in STRUCTURE_OPTIONS"
                  :key="s.value"
                  :class="['inst-choice', { active: ui.structure === s.value }]"
                  @click="ui.structure = s.value"
                >
                  {{ s.label }}
                </div>
              </div>
            </div>
            <div class="inst-field">
              <label class="inst-label">Maturity</label>
              <div class="inst-choices maturity-choices">
                <div
                  v-for="m in maturityOptions"
                  :key="m.value"
                  :class="[
                    'inst-choice',
                    { active: String(ui.maturityDays) === String(m.value) },
                  ]"
                  @click="selectMaturity(m.value)"
                >
                  {{ m.label }}
                </div>
              </div>
            </div>
            <div v-if="showDelta" class="inst-field">
              <label class="inst-label">Delta</label>
              <div class="inst-choices delta-choices">
                <div
                  v-for="d in DELTA_OPTIONS"
                  :key="d.value"
                  :class="[
                    'inst-choice',
                    { active: Number(ui.targetDelta) === d.value },
                  ]"
                  @click="ui.targetDelta = d.value"
                >
                  {{ d.label }}
                </div>
              </div>
            </div>
            <div class="inst-field">
              <label class="inst-label">Investment amount</label>
              <div class="inst-choices side-choices">
                <div
                  :class="[
                    'inst-choice',
                    { active: ui.investmentMode === 'notional' },
                  ]"
                  @click="ui.investmentMode = 'notional'"
                >
                  $100k notional
                </div>
                <div
                  :class="[
                    'inst-choice',
                    { active: ui.investmentMode === 'btc' },
                  ]"
                  @click="ui.investmentMode = 'btc'"
                >
                  1 {{ underlying }}
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Entry -->
        <div
          class="pill entryPill"
          style="position: relative"
          @click="toggleMenu('entry')"
        >
          <span class="pillLabel">Entry</span>
          <span class="pillValue">{{ strategyLabels.entry }}</span>
          <div
            v-if="openMenu === 'entry'"
            class="dropdown entry-dropdown"
            @click.stop
          >
            <label class="inst-label" style="margin-bottom: 3px"
              >Entry days</label
            >
            <div class="inst-choices weekday-choices">
              <div
                v-for="w in ENTRY_WEEKDAY_OPTIONS"
                :key="w.value"
                :class="[
                  'inst-choice',
                  { active: Number(ui.entryWeekday) === w.value },
                ]"
                @click="ui.entryWeekday = w.value"
              >
                {{
                  w.value === ENTRY_WEEKDAY_EVERY_DAY
                    ? "Daily"
                    : w.label.slice(0, 3)
                }}
              </div>
            </div>
            <div class="entry-picker">
              <div class="entry-picker__header">
                <span class="entry-picker__day">{{
                  strategyLabels.weekday
                }}</span>
                <span class="entry-picker__time"
                  >{{ String(ui.entryHourUtc).padStart(2, "0") }}:00</span
                >
              </div>
              <div class="hour-grid">
                <button
                  v-for="h in 24"
                  :key="h - 1"
                  :class="{ active: ui.entryHourUtc === h - 1 }"
                  @click="
                    ui.entryHourUtc = h - 1;
                    openMenu = null;
                  "
                >
                  {{ String(h - 1).padStart(2, "0") }}
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- Hedge -->
        <div
          class="pill hedgePill"
          style="position: relative"
          @click="toggleMenu('hedge')"
        >
          <span class="pillLabel">Hedge</span>
          <span class="pillValue">{{ strategyLabels.hedge }}</span>
          <div v-if="openMenu === 'hedge'" class="dropdown" @click.stop>
            <p v-if="ui.structure === 'covered_call'">Holds one unit of the underlying per short call until the cycle closes.</p>
            <div class="freq-toggle-row">
              <span class="freq-row__label">Hedge</span>
              <label class="toggle-switch">
                <input type="checkbox" v-model="ui.hedgeEnabled" :disabled="ui.structure === 'covered_call'" />
                <span class="toggle-slider"></span>
              </label>
            </div>
            <label class="freq-row__label" for="freq">Frequency</label>
            <input
              id="freq"
              class="freq-slider"
              type="range"
              min="1"
              max="24"
              step="1"
              :value="ui.hedgeIntervalHours"
              @input="updateHedgeInterval(Number($event.target.value))"
              :style="{ '--pct': hedgePct }"
              :disabled="!ui.hedgeEnabled"
              @change="openMenu = null"
            />
            <div class="freq-footer">
              <span class="freq-footer__edge">1h</span>
              <span class="freq-footer__value"
                >Every {{ ui.hedgeIntervalHours }}h</span
              >
              <span class="freq-footer__edge">24h</span>
            </div>
          </div>
        </div>

        <!-- Exit -->
        <div
          class="pill exitPill"
          style="position: relative"
          @click="toggleMenu('exit')"
        >
          <span class="pillLabel">Exit</span>
          <span class="pillValue">{{ strategyLabels.exit }}</span>
          <div
            v-if="openMenu === 'exit'"
            class="dropdown exit-dropdown"
            @click.stop
          >
            <label class="freq-row__label">Close position</label>
            <div class="inst-choices exit-mode-choices">
              <button
                type="button"
                :class="[
                  'inst-choice',
                  { active: ui.exitMode === 'after_days' },
                ]"
                @click="ui.exitMode = 'after_days'"
              >
                Roll
              </button>
              <button
                type="button"
                :class="['inst-choice', { active: ui.exitMode === 'expiry' }]"
                @click="ui.exitMode = 'expiry'"
              >
                Option expiry
              </button>
              <button
                type="button"
                :class="[
                  'inst-choice',
                  { active: ui.exitMode === 'weekly_schedule' },
                ]"
                @click="ui.exitMode = 'weekly_schedule'"
              >
                Pick close
              </button>
            </div>
            <p class="exit-mode-explanation">{{ exitModeExplanation }}</p>
            <div v-if="ui.exitMode === 'after_days'" class="exit-mode-detail">
              <label class="freq-row__label">Roll every</label>
              <div class="inst-choices exit-day-choices">
                <button
                  v-for="days in rollDayOptions"
                  :key="days"
                  type="button"
                  :class="['inst-choice', { active: ui.exitHoldDays === days }]"
                  @click="
                    ui.exitHoldDays = days;
                    openMenu = null;
                  "
                >
                  {{ days }}D
                </button>
              </div>
            </div>
            <div
              v-else-if="ui.exitMode === 'weekly_schedule'"
              class="exit-mode-detail"
            >
              <label class="freq-row__label">Pick close day</label>
              <div class="inst-choices weekday-choices">
                <button
                  v-for="weekday in WEEKDAY_OPTIONS"
                  :key="weekday.value"
                  type="button"
                  :class="[
                    'inst-choice',
                    { active: Number(ui.exitWeekday) === weekday.value },
                  ]"
                  @click="ui.exitWeekday = weekday.value"
                >
                  {{ weekday.label.slice(0, 3) }}
                </button>
              </div>
              <div class="entry-picker exit-time-picker">
                <div class="entry-picker__header">
                  <span class="entry-picker__day">Pick close time</span>
                  <span class="entry-picker__time"
                    >{{ String(ui.exitHourUtc).padStart(2, "0") }}:00</span
                  >
                </div>
                <div class="hour-grid">
                  <button
                    v-for="hour in 24"
                    :key="hour - 1"
                    type="button"
                    :class="{ active: ui.exitHourUtc === hour - 1 }"
                    @click="
                      ui.exitHourUtc = hour - 1;
                      openMenu = null;
                    "
                  >
                    {{ String(hour - 1).padStart(2, "0") }}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Data range -->
        <div
          class="pill dataPill"
          style="position: relative"
          @click="toggleMenu('data')"
        >
          <span class="pillLabel">Data</span>
          <span class="pillValue">{{ dataRangeLabel }}</span>
          <div
            v-if="openMenu === 'data'"
            class="dropdown data-dropdown"
            @click.stop
          >
            <div class="dataRangeHeader">
              <span class="freq-row__label">Backtest period</span>
              <button
                type="button"
                class="dataRangeReset"
                :disabled="isAllDataRange"
                @click="resetDataRange"
              >
                All data
              </button>
            </div>
            <div class="dataRangeValue">{{ dataRangeDetailLabel }}</div>
            <div class="dateRangeSlider dataRangeSlider" :style="dataRangeStyle">
              <span class="dateRangeTrack" aria-hidden="true"></span>
              <span class="dateRangeSelection" aria-hidden="true"></span>
              <input
                v-model.number="dataRangeStartModel"
                class="dateRangeInput"
                type="range"
                min="0"
                max="100"
                step="0.1"
                aria-label="Backtest period start"
                :aria-valuetext="dataRangeDateFormatter.format(selectedDataRange.start)"
              />
              <input
                v-model.number="dataRangeEndModel"
                class="dateRangeInput"
                type="range"
                min="0"
                max="100"
                step="0.1"
                aria-label="Backtest period end"
                :aria-valuetext="dataRangeDateFormatter.format(selectedDataRange.end)"
              />
            </div>
            <div class="dataRangeEndpoints">
              <span>{{ dataRangeDateFormatter.format(DATA_RANGE_START) }}</span>
              <span>{{ dataRangeDateFormatter.format(dataRangeAvailableEnd) }}</span>
            </div>
            <p class="dataRangeHint">
              Drag either handle to limit every backtest result to that period.
            </p>
          </div>
        </div>
      </div>

      <div class="spacer"></div>

      <div class="segmented">
        <div class="viewMenu">
          <button
            type="button"
            :class="[
              'segment',
              'viewMenuTrigger',
              { active: mode === 'single' },
            ]"
            aria-haspopup="menu"
            @click="mode !== 'single' && switchMode('single')"
          >
            <span>Single run</span>
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
          <div class="viewDropdown" role="menu" aria-label="Single run view">
            <div class="viewDropdownSurface">
              <button
                type="button"
                role="menuitem"
                :class="{ active: mode === 'single' && chartMode === 'weekly' }"
                @click="selectSingleView('weekly')"
              >
                {{ showDailyPnl ? "Daily PnL" : "PnL by cycle" }}
              </button>
              <button
                type="button"
                role="menuitem"
                :class="{ active: mode === 'single' && chartMode === 'greeks' }"
                @click="selectSingleView('greeks')"
              >
                PnL attribution
              </button>
              <button
                v-if="ui.hedgeEnabled"
                type="button"
                role="menuitem"
                :class="{ active: mode === 'single' && chartMode === 'hedge' }"
                @click="selectSingleView('hedge')"
              >
                Hedge performance
              </button>
              <button
                type="button"
                role="menuitem"
                :class="{
                  active: mode === 'single' && chartMode === 'distribution',
                }"
                @click="selectSingleView('distribution')"
              >
                Distribution
              </button>
            </div>
          </div>
        </div>
        <button
          type="button"
          :class="['segment', { active: mode === 'sweep' }]"
          @click="switchMode('sweep')"
        >
          Sweep
        </button>
        <div class="viewMenu">
          <button
            type="button"
            :class="[
              'segment',
              'viewMenuTrigger',
              { active: STUDY_MODES.includes(mode) },
            ]"
            aria-haspopup="menu"
            @click="!STUDY_MODES.includes(mode) && switchMode('rv')"
          >
            <span>Study</span>
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
          <div class="viewDropdown" role="menu" aria-label="Study view">
            <div class="viewDropdownSurface">
              <button
                type="button"
                role="menuitem"
                :class="{ active: mode === 'rv' }"
                @click="selectStudy('rv')"
              >
                RV
              </button>
              <button
                type="button"
                role="menuitem"
                :class="{ active: mode === 'iv' }"
                @click="selectStudy('iv')"
              >
                IV
              </button>
              <button
                type="button"
                role="menuitem"
                :class="{ active: mode === 'iv-rv' }"
                @click="selectStudy('iv-rv')"
              >
                IV-RV
              </button>
            </div>
          </div>
        </div>
      </div>
      <div class="topActions">
        <button
          v-if="mode === 'single'"
          class="saveButton topSaveButton"
          type="button"
          :disabled="csvExporting || attributionLoading || !cycleRows.length"
          :title="
            csvExporting
              ? 'Preparing CSV…'
              : 'Export one attribution-ready row per closed cycle as CSV'
          "
          aria-label="Export CSV"
          @click="handleExportCsv"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M12 3v12" />
            <path d="M8 11l4 4 4-4" />
            <path d="M5 20h14" />
          </svg>
        </button>
        <button
          class="saveButton topSaveButton"
          type="button"
          title="Save current chart as PNG"
          aria-label="Save PNG"
          :disabled="
            mode === 'single'
              ? cycleDetailLoading || attributionLoading
              : mode === 'sweep'
                ? sweepRunning || !sweepResults.length
                : mode === 'rv'
                  ? ivRvLoading || !rvWeekdayInsights
                  : mode === 'iv'
                    ? ivRvLoading || !ivHeatmapInsights
                    : ivRvLoading || !ivRvRows.length
          "
          @click="handleSavePng"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path
              d="M14.5 4l1.4 2H20a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V8a2 2 0 012-2h4.1l1.4-2h5z"
            />
            <circle cx="12" cy="13" r="4" />
          </svg>
        </button>
      </div>
    </div>

    <div class="main">
      <!-- Left metrics column -->
      <div class="metricsColumn">
        <template v-if="mode === 'single'">
          <div class="metric">
            <div class="metricValue">{{ finalPnlValue }}</div>
            <div class="metricLabel">FINAL PNL</div>
          </div>
          <div class="metric">
            <div class="metricValue">{{ sharpeValue }}</div>
            <div class="metricLabel">SHARPE</div>
          </div>
          <div class="metric">
            <div class="metricValue maxdd">{{ maxDdValue }}</div>
            <div class="metricLabel">MAX DRAWDOWN</div>
          </div>
        </template>
        <template v-else-if="mode === 'sweep' && sweepInsights">
          <div class="metric">
            <div class="metricValue">{{ sweepInsights.bestPnl.label }}</div>
            <div class="metricLabel">
              BEST PNL · {{ formatUsd.format(sweepInsights.bestPnl.pnl) }}
            </div>
          </div>
          <div class="metric">
            <div class="metricValue">
              {{ sweepInsights.bestSharpe?.label || "—" }}
            </div>
            <div class="metricLabel">
              BEST SHARPE ·
              {{
                sweepInsights.bestSharpe
                  ? formatNumber.format(sweepInsights.bestSharpe.sharpe)
                  : "—"
              }}
            </div>
          </div>
          <div class="metric">
            <div class="metricValue">
              {{ sweepInsights.profitable }}/{{ sweepInsights.total }}
            </div>
            <div class="metricLabel">
              PROFIT · {{ formatUsd.format(sweepInsights.medianPnl) }}
            </div>
          </div>
        </template>
        <template v-else-if="mode === 'iv-rv' && ivRvStats">
          <div class="metric">
            <div class="metricValue">{{ formatVol(ivRvStats.averageIv) }}</div>
            <div class="metricLabel">AVERAGE ATM IV</div>
          </div>
          <div class="metric">
            <div class="metricValue">{{ formatVol(ivRvStats.averageRv) }}</div>
            <div class="metricLabel">AVERAGE PARKINSON RV</div>
          </div>
          <div class="metric">
            <div class="metricValue">{{ formatVol(ivRvStats.difference) }}</div>
            <div class="metricLabel">AVERAGE IV MINUS RV</div>
          </div>
        </template>
        <template v-else-if="mode === 'rv' && rvWeekdayInsights">
          <div class="metric">
            <div class="metricValue">
              {{ formatVol(rvWeekdayInsights.average) }}
            </div>
            <div class="metricLabel">AVERAGE HOURLY RV</div>
          </div>
          <div class="metric">
            <div class="metricValue">{{ rvWeekdayInsights.lowest.label }}</div>
            <div class="metricLabel">
              LOWEST MEDIAN · {{ formatVol(rvWeekdayInsights.lowest.median) }}
            </div>
          </div>
          <div class="metric">
            <div class="metricValue">{{ rvWeekdayInsights.highest.label }}</div>
            <div class="metricLabel">
              HIGHEST MEDIAN · {{ formatVol(rvWeekdayInsights.highest.median) }}
            </div>
          </div>
        </template>
        <template v-else-if="mode === 'iv' && ivHeatmapInsights">
          <div class="metric">
            <div class="metricValue">
              {{ formatVol(ivHeatmapInsights.average) }}
            </div>
            <div class="metricLabel">
              {{ ivHeatmapMetric === "median" ? "MEDIAN" : "AVERAGE" }}
              {{ ivMeasureLabel }}
            </div>
          </div>
          <div class="metric">
            <div class="metricValue">
              {{ ivHeatmapInsights.lowest.weekdayLabel }}
              {{ String(ivHeatmapInsights.lowest.hour).padStart(2, "0") }}:00
            </div>
            <div class="metricLabel">
              LOWEST BUCKET · {{ formatVol(ivHeatmapInsights.lowest.average) }}
            </div>
          </div>
          <div class="metric">
            <div class="metricValue">
              {{ ivHeatmapInsights.highest.weekdayLabel }}
              {{ String(ivHeatmapInsights.highest.hour).padStart(2, "0") }}:00
            </div>
            <div class="metricLabel">
              HIGHEST BUCKET ·
              {{ formatVol(ivHeatmapInsights.highest.average) }}
            </div>
          </div>
        </template>
      </div>

      <!-- Chart area -->
      <div class="chartColumn">
        <div v-if="mode === 'single'" class="chartHeader">
          <div class="chartTitleRow">
            <button
              v-if="selectedCycle"
              class="backButton"
              type="button"
              @click="closeCycleDetail"
              title="Back to cycles"
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2.25"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </button>
            <div class="chartTitle">
              <span>{{ chartTitle }}</span>
            </div>
          </div>
          <div class="chartSubtitle">{{ chartSubtitle }}</div>
          <div class="chartSourceSubtitle">{{ chartSourceSubtitle }}</div>
        </div>

        <div v-else-if="mode === 'sweep'" class="sweepHeader">
          <div>
            <div class="chartTitle">Parameter sweep</div>
            <div
              v-if="!sweepResults.length && !sweepRunning"
              class="chartSubtitle"
            >
              Compare one dimension while holding the current strategy settings
              fixed.
            </div>
          </div>
          <div class="sweepControls">
            <div
              class="sweepDimensionControl"
              role="group"
              aria-label="Sweep dimension"
            >
              <button
                v-for="dimension in availableSweepDimensions"
                :key="dimension.value"
                type="button"
                :class="{ active: sweepDimension === dimension.value }"
                :disabled="sweepRunning"
                @click="sweepDimension = dimension.value"
              >
                {{ dimension.label }}
              </button>
            </div>
          </div>
        </div>
        <div v-else-if="mode === 'iv-rv'" class="sweepHeader">
          <div>
            <div class="chartTitle">{{ underlying }} ATM IV vs Parkinson RV</div>
            <div class="chartSubtitle">
              Hourly source data through {{ ivRvSourceLatestLabel }} · RV uses the
              {{ ivRvAlignForward ? "following" : "trailing" }} tenor window
            </div>
          </div>
          <div class="ivRvRangeInline">
            <span class="ivRvRangeLabel">{{ ivRvRangeLabel }}</span>
            <div class="ivRvRangeControl">
              <div class="dateRangeSlider" :style="ivRvRangeStyle">
                <span class="dateRangeTrack" aria-hidden="true"></span>
                <span class="dateRangeSelection" aria-hidden="true"></span>
                <input
                  v-model.number="ivRvRangeStartModel"
                  class="dateRangeInput"
                  type="range"
                  min="0"
                  max="100"
                  step="0.1"
                  aria-label="Chart period start"
                />
                <input
                  v-model.number="ivRvRangeEndModel"
                  class="dateRangeInput"
                  type="range"
                  min="0"
                  max="100"
                  step="0.1"
                  aria-label="Chart period end"
                />
              </div>
            </div>
          </div>
          <div class="sweepControls">
            <div
              class="sweepDimensionControl"
              role="group"
              aria-label="Volatility tenor"
            >
              <button
                v-for="tenor in IV_RV_TENORS"
                :key="tenor"
                type="button"
                :class="{ active: ivRvTenor === tenor }"
                @click="ivRvTenor = tenor"
              >
                {{ tenor }}D
              </button>
            </div>
            <div
              class="sweepDimensionControl"
              role="group"
              aria-label="Chart sampling resolution"
            >
              <button
                v-for="resolution in IV_RV_RESOLUTIONS"
                :key="resolution"
                type="button"
                :class="{ active: ivRvResolution === resolution }"
                @click="ivRvResolution = resolution"
              >
                {{ resolution }}h
              </button>
            </div>
            <div
              class="sweepDimensionControl"
              role="group"
              aria-label="Chart overlays"
            >
              <button
                type="button"
                :class="{ active: ivRvShowIndex }"
                :aria-pressed="ivRvShowIndex"
                @click="ivRvShowIndex = !ivRvShowIndex"
              >
                Index
              </button>
              <button
                type="button"
                :class="{ active: ivRvAlignForward }"
                :aria-pressed="ivRvAlignForward"
                title="Compare each IV point with realized volatility over the following tenor"
                @click="ivRvAlignForward = !ivRvAlignForward"
              >
                Shift RV
              </button>
            </div>
          </div>
        </div>
        <div v-if="state.error" class="cycleDetailState error">
          {{ state.error }}
        </div>
        <div
          v-else-if="mode === 'single' && state.progress && !result"
          class="cycleDetailState"
        >
          {{ state.progress }}
        </div>
        <div
          v-else-if="
            mode === 'single' &&
            !selectedCycle &&
            chartMode === 'weekly' &&
            showDailyPnl &&
            attributionLoading
          "
          class="cycleDetailState"
        >
          Preparing daily PnL…
        </div>
        <div
          v-else-if="
            mode === 'single' &&
            !selectedCycle &&
            chartMode === 'weekly' &&
            showDailyPnl &&
            attributionError
          "
          class="cycleDetailState error"
        >
          {{ attributionError }}
        </div>
        <WeeklyBacktestChart
          v-else-if="
            mode === 'single' && !selectedCycle && chartMode === 'weekly'
          "
          ref="chartRef"
          :rows="pnlChartRows"
          :granularity="showDailyPnl ? 'daily' : 'cycle'"
          :design-spec="true"
          @select="handleCycleSelect"
        />
        <HedgePerformanceChart
          v-else-if="
            mode === 'single' && !selectedCycle && chartMode === 'hedge'
          "
          ref="chartRef"
          :rows="cycleRows"
          @select="handleCycleSelect"
        />
        <div
          v-else-if="
            mode === 'single' &&
            !selectedCycle &&
            chartMode === 'greeks' &&
            attributionLoading
          "
          class="cycleDetailState"
        >
          Calculating PnL attribution…
        </div>
        <div
          v-else-if="
            mode === 'single' &&
            !selectedCycle &&
            chartMode === 'greeks' &&
            attributionError
          "
          class="cycleDetailState error"
        >
          {{ attributionError }}
        </div>
        <GreekPnlChart
          v-else-if="
            mode === 'single' && !selectedCycle && chartMode === 'greeks'
          "
          ref="chartRef"
          :rows="attributionRows"
          :cycle-rows="attributionCycleRows"
          :underlying="underlying"
        />
        <FairValueDistributionPanel
          v-else-if="
            mode === 'single' && !selectedCycle && chartMode === 'distribution'
          "
          ref="chartRef"
          v-model:view-mode="distributionViewMode"
          :rows="cycleRows"
          :hedge-enabled="ui.hedgeEnabled"
          :underlying="underlying"
        />
        <div
          v-else-if="mode === 'single' && cycleDetailLoading"
          class="cycleDetailState"
        >
          Loading hourly detail…
        </div>
        <div
          v-else-if="mode === 'single' && cycleDetailError"
          class="cycleDetailState error"
        >
          {{ cycleDetailError }}
        </div>
        <CycleDetailChart
          v-else-if="mode === 'single'"
          ref="chartRef"
          :rows="cycleDetailRows"
          :break-evens="cycleBreakEvens"
          :zero-mtm-contours="cycleContours"
          :underlying="underlying"
        />

        <div v-else-if="mode === 'sweep'" class="sweepPanel">
          <div v-if="sweepRunning && !sweepResults.length" class="sweepEmpty">
            {{ sweepProgress || "Preparing sweep…" }}
          </div>

          <SweepResultsChart
            v-else-if="sweepResults.length"
            ref="sweepChartRef"
            class="sweepHistogram"
            :rows="sweepResults"
            :dimension="sweepDimension"
            :dimension-label="sweepDimensionLabel"
            @select="applySweepResult"
          />
          <div v-else class="sweepEmpty">
            No sweep results are available. Results include PnL, Sharpe,
            drawdown, and sample size.
          </div>
          <div v-if="sweepTiming" class="sweepPerformance">
            {{ sweepTiming.cells }} runs in
            {{ (sweepTiming.totalMs / 1000).toFixed(2) }}s · strategy
            {{ (sweepTiming.runMs / 1000).toFixed(2) }}s ·
            {{
              sweepTiming.reusedPreparedData
                ? "reused loaded data"
                : `load ${(sweepTiming.loadMs / 1000).toFixed(2)}s · prepare ${(sweepTiming.prepareMs / 1000).toFixed(2)}s`
            }}
          </div>
        </div>

        <div v-else-if="mode === 'iv-rv'" class="sweepPanel">
          <div v-if="ivRvError" class="sweepEmpty">{{ ivRvError }}</div>
          <IvRvChart
            v-else
            ref="ivRvChartRef"
            class="sweepHistogram"
            :rows="ivRvRows"
            :loading="ivRvLoading"
            :show-index="ivRvShowIndex"
          />
        </div>

        <div v-else-if="mode === 'iv'" class="sweepPanel rvCombinedPanel">
          <div v-if="ivRvError" class="sweepEmpty">{{ ivRvError }}</div>
          <div v-else class="rvCombinedCharts">
            <section class="rvChartSection rvHeatmapSection">
              <div class="rvSectionHeader">
                <div
                  class="sweepDimensionControl"
                  role="group"
                  aria-label="IV tenor"
                >
                  <button
                    v-for="tenor in IV_RV_TENORS"
                    :key="tenor"
                    type="button"
                    :class="{ active: ivRvTenor === tenor }"
                    @click="ivRvTenor = tenor"
                  >
                    {{ tenor }}D
                  </button>
                </div>
                <div class="ivRvRangeInline rvHeatmapRange">
                  <span class="ivRvRangeLabel">{{ ivRangeLabel }}</span>
                  <div class="ivRvRangeControl">
                    <div class="dateRangeSlider" :style="ivRangeStyle">
                      <span class="dateRangeTrack" aria-hidden="true"></span>
                      <span
                        class="dateRangeSelection"
                        aria-hidden="true"
                      ></span>
                      <input
                        v-model.number="ivRangeStartModel"
                        class="dateRangeInput"
                        type="range"
                        min="0"
                        max="100"
                        step="0.1"
                        aria-label="IV data period start"
                      />
                      <input
                        v-model.number="ivRangeEndModel"
                        class="dateRangeInput"
                        type="range"
                        min="0"
                        max="100"
                        step="0.1"
                        aria-label="IV data period end"
                      />
                    </div>
                  </div>
                </div>
                <div class="rvSectionActions">
                  <div
                    class="sweepDimensionControl heatmapMetricControl"
                    role="group"
                    aria-label="IV heatmap metric"
                  >
                    <button
                      type="button"
                      :class="{ active: ivHeatmapMetric === 'average' }"
                      @click="ivHeatmapMetric = 'average'"
                    >
                      Avg
                    </button>
                    <button
                      type="button"
                      :class="{ active: ivHeatmapMetric === 'median' }"
                      @click="ivHeatmapMetric = 'median'"
                    >
                      Median
                    </button>
                  </div>
                  <button
                    class="rvScreenshotButton rvDataLabelsButton"
                    :class="{ active: showIvHeatmapDataLabels }"
                    type="button"
                    :aria-pressed="showIvHeatmapDataLabels"
                    title="Show IV values in each heatmap cell"
                    @click="showIvHeatmapDataLabels = !showIvHeatmapDataLabels"
                  >
                    Data labels
                  </button>
                  <button
                    class="rvScreenshotButton"
                    type="button"
                    :disabled="ivRvLoading || !ivHeatmapInsights"
                    title="Save IV heatmap as PNG"
                    @click="saveIvHeatmap()"
                  >
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.8"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      aria-hidden="true"
                    >
                      <path
                        d="M14.5 4l1.4 2H20a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V8a2 2 0 012-2h4.1l1.4-2h5z"
                      />
                      <circle cx="12" cy="13" r="4" />
                    </svg>
                    Screenshot
                  </button>
                </div>
              </div>
              <WeekdayHourHeatmap
                ref="ivChartRef"
                :cells="ivHeatmapCells"
                :loading="ivRvLoading"
                :aggregate-label="
                  ivHeatmapMetric === 'median' ? 'Median' : 'Mean'
                "
                :legend-label="`${ivHeatmapMetric === 'median' ? 'Median' : 'Avg'} ${ivRvTenor}D IV`"
                loading-message="Loading hourly implied volatility…"
                empty-message="No hourly implied-volatility observations."
                :aria-label="`${ivMeasureLabel} by weekday and UTC hour`"
                gradient-id="iv-hourly-red-gradient"
                :show-data-labels="showIvHeatmapDataLabels"
                :chart-title="`${underlying} ${ivMeasureLabel.toUpperCase()} · WEEKDAY × UTC HOUR`"
                :methodology="ivHeatmapMethodology"
              />
            </section>
            <section class="rvChartSection rvBoxplotSection">
              <div class="rvBoxplotToolbar">
                <div class="rvSectionActions">
                  <StyledSelectMenu
                    v-model="ivBoxplotMonths"
                    label="Months"
                    :options="MONTH_OPTIONS"
                    multiple
                    all-selected-label="All"
                  />
                  <button
                    class="rvScreenshotButton"
                    type="button"
                    :disabled="ivRvLoading || !ivWeekdayInsights"
                    title="Save weekday IV boxplot as PNG"
                    @click="saveIvBoxplot()"
                  >
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.8"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      aria-hidden="true"
                    >
                      <path
                        d="M14.5 4l1.4 2H20a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V8a2 2 0 012-2h4.1l1.4-2h5z"
                      />
                      <circle cx="12" cy="13" r="4" />
                    </svg>
                    Screenshot
                  </button>
                </div>
              </div>
              <WeekdayRvBoxplot
                ref="ivBoxplotRef"
                :groups="ivBoxplotGroups"
                :loading="ivRvLoading"
                :chart-title="`${underlying} ${ivMeasureLabel.toUpperCase()} · DISTRIBUTION BY WEEKDAY`"
                methodology="Box = middle 50% · line = median · whiskers = 1.5× IQR · fill = mean IV"
                :y-axis-label="ivMeasureLabel"
                loading-message="Loading weekday implied volatility…"
                empty-message="No weekday implied-volatility observations."
                :aria-label="`${ivMeasureLabel} distribution by weekday`"
              />
            </section>
          </div>
        </div>

        <div v-else-if="mode === 'rv'" class="sweepPanel rvCombinedPanel">
          <div v-if="ivRvError" class="sweepEmpty">{{ ivRvError }}</div>
          <div v-else class="rvCombinedCharts">
            <section class="rvChartSection rvHeatmapSection">
              <div class="rvSectionHeader">
                <div class="ivRvRangeInline rvHeatmapRange">
                  <span class="ivRvRangeLabel">{{ rvRangeLabel }}</span>
                  <div class="ivRvRangeControl">
                    <div class="dateRangeSlider" :style="rvRangeStyle">
                      <span class="dateRangeTrack" aria-hidden="true"></span>
                      <span
                        class="dateRangeSelection"
                        aria-hidden="true"
                      ></span>
                      <input
                        v-model.number="rvRangeStartModel"
                        class="dateRangeInput"
                        type="range"
                        min="0"
                        max="100"
                        step="0.1"
                        aria-label="RV data period start"
                      />
                      <input
                        v-model.number="rvRangeEndModel"
                        class="dateRangeInput"
                        type="range"
                        min="0"
                        max="100"
                        step="0.1"
                        aria-label="RV data period end"
                      />
                    </div>
                  </div>
                </div>
                <div class="rvSectionActions">
                  <div
                    class="sweepDimensionControl heatmapMetricControl"
                    role="group"
                    aria-label="RV heatmap metric"
                  >
                    <button
                      type="button"
                      :class="{ active: rvHeatmapMetric === 'average' }"
                      @click="rvHeatmapMetric = 'average'"
                    >
                      Avg
                    </button>
                    <button
                      type="button"
                      :class="{ active: rvHeatmapMetric === 'median' }"
                      @click="rvHeatmapMetric = 'median'"
                    >
                      Median
                    </button>
                  </div>
                  <button
                    class="rvScreenshotButton rvDataLabelsButton"
                    :class="{ active: showHeatmapDataLabels }"
                    type="button"
                    :aria-pressed="showHeatmapDataLabels"
                    title="Show values in both heatmaps"
                    @click="showHeatmapDataLabels = !showHeatmapDataLabels"
                  >
                    Data labels
                  </button>
                  <button
                    class="rvScreenshotButton"
                    type="button"
                    :disabled="ivRvLoading || !rvWeekdayInsights"
                    title="Save heatmap as PNG"
                    @click="saveRvHeatmap()"
                  >
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.8"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      aria-hidden="true"
                    >
                      <path
                        d="M14.5 4l1.4 2H20a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V8a2 2 0 012-2h4.1l1.4-2h5z"
                      />
                      <circle cx="12" cy="13" r="4" />
                    </svg>
                    Screenshot
                  </button>
                </div>
              </div>
              <WeekdayHourHeatmap
                ref="rvChartRef"
                :cells="rvHeatmapCells"
                :loading="ivRvLoading"
                :aggregate-label="
                  rvHeatmapMetric === 'median' ? 'Median' : 'Mean'
                "
                :legend-label="
                  rvHeatmapMetric === 'median'
                    ? 'Median RV (ann.)'
                    : 'Avg RV (ann.)'
                "
                :measure-label="`${rvHeatmapMetric === 'median' ? 'Median' : 'Mean'} annualized hourly RV`"
                :show-data-labels="showHeatmapDataLabels"
                chart-title="HOURLY REALIZED VOLATILITY · WEEKDAY × UTC HOUR"
                :methodology="`Method: ${rvHeatmapMetric === 'median' ? 'median' : 'mean'} annualized Parkinson RV within each UTC weekday/hour bucket; raw 1h observations.`"
              />
            </section>
            <section class="rvChartSection rvBoxplotSection">
              <div class="rvBoxplotToolbar">
                <div class="rvSectionActions">
                  <StyledSelectMenu
                    v-model="rvBoxplotMonths"
                    label="Months"
                    :options="MONTH_OPTIONS"
                    multiple
                    all-selected-label="All"
                  />
                  <button
                    class="rvScreenshotButton"
                    type="button"
                    :disabled="ivRvLoading || !rvWeekdayInsights"
                    title="Save weekday RV boxplot as PNG"
                    @click="saveRvBoxplot()"
                  >
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.8"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      aria-hidden="true"
                    >
                      <path
                        d="M14.5 4l1.4 2H20a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V8a2 2 0 012-2h4.1l1.4-2h5z"
                      />
                      <circle cx="12" cy="13" r="4" />
                    </svg>
                    Screenshot
                  </button>
                </div>
              </div>
              <WeekdayRvBoxplot
                ref="rvBoxplotRef"
                :groups="rvBoxplotGroups"
                :loading="ivRvLoading"
              />
            </section>
            <section class="rvChartSection rvSecondaryAnalysisSection">
              <div class="rvSecondaryHeatmapBlock">
                <div class="rvSecondaryHeatmapToolbar">
                  <button
                    class="rvScreenshotButton"
                    type="button"
                    :disabled="
                      ivRvLoading || !standardizedVrHeatmapCells.length
                    "
                    title="Save variance-standardized VR(24) heatmap as PNG"
                    @click="saveStandardizedVrHeatmap()"
                  >
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.8"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      aria-hidden="true"
                    >
                      <path
                        d="M14.5 4l1.4 2H20a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V8a2 2 0 012-2h4.1l1.4-2h5z"
                      />
                      <circle cx="12" cy="13" r="4" />
                    </svg>
                    Screenshot
                  </button>
                </div>
                <div class="rvSecondaryHeatmap">
                  <VarianceStandardizedVrHeatmap
                    ref="standardizedVrHeatmapRef"
                    :cells="standardizedVrHeatmapCells"
                    :loading="ivRvLoading"
                    :show-data-labels="showHeatmapDataLabels"
                    @select="selectStandardizedVrCell"
                  />
                </div>
              </div>
              <div class="rvTermStructureBlock">
                <div class="rvTermStructureToolbar">
                  <div class="rvSectionActions">
                    <StyledSelectMenu
                      v-model="serialAnchorWeekday"
                      label="Entry weekday"
                      :options="SERIAL_ANCHOR_WEEKDAY_OPTIONS"
                    />
                    <StyledSelectMenu
                      v-model="serialAnchorHour"
                      label="Entry hour UTC"
                      :options="HOUR_OPTIONS"
                    />
                    <button
                      class="rvScreenshotButton"
                      type="button"
                      :disabled="
                        ivRvLoading || !varianceRatioAnalysis.sampleSize
                      "
                      title="Save variance-ratio analysis as PNG"
                      @click="saveVarianceRatio()"
                    >
                      <svg
                        width="13"
                        height="13"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.8"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        aria-hidden="true"
                      >
                        <path
                          d="M14.5 4l1.4 2H20a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V8a2 2 0 012-2h4.1l1.4-2h5z"
                        />
                        <circle cx="12" cy="13" r="4" />
                      </svg>
                      Screenshot
                    </button>
                  </div>
                </div>
                <VarianceRatioDashboard
                  ref="varianceRatioRef"
                  :analysis="varianceRatioAnalysis"
                  :loading="ivRvLoading"
                  :underlying="underlying"
                />
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  </main>
</template>

<style scoped>
:global(:root) {
  --color-bg: #0a0b0e;
  --color-surface: #131316;
  --color-surface-raised: #1a1a1f;
  --color-text: #e8eaed;
  --color-text-muted: #70767d;
  --color-accent: #7dd3fc;
  --color-border-subtle: rgba(255, 255, 255, 0.06);
  --color-border: rgba(255, 255, 255, 0.09);
  --color-border-strong: rgba(255, 255, 255, 0.2);
  --color-overlay: rgba(0, 0, 0, 0.5);
}

:global(*) {
  box-sizing: border-box;
}

:global(body) {
  margin: 0;
  min-width: 320px;
  background: var(--color-bg);
  color: var(--color-text);
  font-family:
    "Helvetica Neue",
    Helvetica,
    -apple-system,
    sans-serif;
  color-scheme: dark;
}

.app {
  max-width: none;
  width: 100%;
  min-height: 100vh;
  padding: 0;
  background: var(--color-bg);
  display: flex;
  flex-direction: column;
}

.topBar {
  display: flex;
  align-items: center;
  height: 58px;
  padding: 0 28px;
  border-bottom: 1px solid var(--color-border-subtle);
  gap: 20px;
  flex-shrink: 0;
}

.underlyingToggle {
  display: inline-flex;
  align-items: center;
  height: 30px;
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: transparent;
}

.underlyingToggle button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: 0 14px;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--color-text-muted);
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  cursor: pointer;
}

.underlyingToggle button + button {
  border-left: 1px solid var(--color-border);
}

.underlyingToggle button:hover:not(.active) {
  color: var(--color-text);
  background: var(--color-surface);
}

.underlyingToggle button.active {
  color: var(--color-text);
  background: var(--color-surface);
  font-weight: 600;
}

.divider {
  width: 1px;
  height: 20px;
  background: rgba(255, 255, 255, 0.08);
}

.configPills {
  display: flex;
  gap: 8px;
}

.instrumentPill {
  order: 0;
}
.hedgePill {
  order: 1;
}
.entryPill {
  order: 2;
}
.exitPill {
  order: 3;
}
.dataPill {
  order: 4;
  box-sizing: border-box;
  width: 158px;
}

.dataPill .pillValue {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pill {
  display: flex;
  gap: 7px;
  align-items: center;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 7px 13px;
  font-size: 12px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  position: relative;
  overflow: visible;
}

.pill:hover {
  border-color: var(--color-border-strong);
}

/* Ensure controls are visible and usable on hover */
.pill select,
.pill input {
  cursor: pointer;
}

.pill select,
.pill input[type="range"],
.pill input[type="checkbox"] {
  font-size: 11px;
  background: #000;
  color: #fff;
  border: 1px solid var(--color-border-strong);
  border-radius: 4px;
  padding: 2px 6px;
  cursor: pointer;
  appearance: none;
  -webkit-appearance: none;
  -moz-appearance: none;
}

.pill select option,
.dropdown select option {
  background: var(--color-bg);
  color: var(--color-text);
}

/* In dropdowns, no borders on inner inputs */
.dropdown select {
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: var(--color-bg);
  color: var(--color-text);
  padding: 6px 8px;
  width: 100%;
  margin-bottom: 4px;
  border-radius: 4px;
  appearance: none;
  -webkit-appearance: none;
  -moz-appearance: none;
  font-size: 12px;
  color-scheme: dark;
}

.dropdown .freq-toggle-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.pillLabel {
  color: #70767d;
  font-size: 14px;
  line-height: 1;
  white-space: nowrap;
}

.pillValue {
  color: #e8eaed;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
}

.pillValue.off {
  color: #565c63;
}

.dropdown {
  position: absolute;
  top: 100%;
  left: 0;
  min-width: 340px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
  background: #0a0b0e;
  padding: 10px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.15);
  z-index: 10;
}

.instrument-dropdown {
  width: min(460px, calc(100vw - 20px));
  min-width: min(460px, calc(100vw - 20px));
  left: -1px;
  right: auto;
  background: #0a0b0e;
  border: 0;
  border-radius: 0;
  box-shadow: none;
  padding: 14px 12px;
}

/* Make the content inside instrument dropdown scale horizontally to the new width */
.instrument-dropdown .inst-field {
  width: 100%;
}
.instrument-dropdown .inst-choices {
  width: 100%;
}

/* Ensure no inner borders on dropdown content */
.dropdown .freq-toggle-row,
.dropdown .freq-row__label,
.dropdown .freq-footer {
  border: none;
}

/* Base dropdown selects are styled via the .dropdown select rule above */

.entry-dropdown {
  min-width: 340px;
  background: #0f0f12;
  border: 1px solid rgba(255, 255, 255, 0.09);
  border-radius: 18px;
  padding: 10px;
  box-shadow:
    0 24px 60px -12px rgba(0, 0, 0, 0.8),
    0 0 0 1px rgba(255, 255, 255, 0.02);
}

.exit-dropdown {
  width: 340px;
  background: #0f0f12;
  border-color: rgba(255, 255, 255, 0.09);
  border-radius: 12px;
}

.data-dropdown {
  right: 0;
  left: auto;
  box-sizing: border-box;
  width: 390px;
  min-width: 0;
  max-width: calc(100vw - 20px);
  min-height: 160px;
  padding: 15px 16px 13px;
  border-color: rgba(255, 255, 255, 0.09);
  border-radius: 12px;
  background: #0f0f12;
}

.dataRangeHeader,
.dataRangeEndpoints {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.dataRangeReset {
  padding: 4px 7px;
  border: 0;
  border-radius: 5px;
  background: rgba(255, 255, 255, 0.07);
  color: #cfd2d6;
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}

.dataRangeReset:disabled {
  color: #555b62;
  cursor: default;
}

.dataRangeValue {
  height: 18px;
  margin-top: 13px;
  color: #e8eaed;
  font-size: 13px;
  line-height: 18px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.dataRangeSlider {
  margin-top: 12px;
}

.pill .data-dropdown input.dateRangeInput {
  -webkit-appearance: none;
  appearance: none;
  position: absolute;
  inset: 0;
  width: 100%;
  height: 26px;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
  pointer-events: none;
}

.dataRangeEndpoints {
  margin-top: 3px;
  color: #626870;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}

.dataRangeEndpoints span {
  white-space: nowrap;
}

.dataRangeHint {
  margin: 11px 0 0;
  color: #777d85;
  font-size: 11px;
  line-height: 1.4;
}

.exit-mode-choices {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin-top: 5px;
}

.exit-mode-choices .inst-choice {
  width: 100%;
  font: inherit;
}

.exit-mode-detail {
  margin-top: 12px;
}

.exit-mode-explanation {
  margin: 9px 2px 0;
  color: #8b9198;
  font-size: 11px;
  line-height: 1.45;
}

.exit-time-picker {
  margin-top: 8px;
}

.entry-picker {
  margin-top: 10px;
  background: transparent;
}

.entry-picker__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  background: #131316;
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 12px;
  margin: 2px 2px 8px;
}

.entry-picker__day {
  font-size: 13px;
  font-weight: 600;
  color: #e7e7ea;
}

.entry-picker__time {
  font-size: 12px;
  font-weight: 500;
  color: #71717a;
  font-variant-numeric: tabular-nums;
}

.hour-grid {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: 2px;
  padding: 1px 1px 1px;
}

.hour-grid button {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 6px 0;
  background: #131316;
  color: #e7e7ea;
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 4px;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  transition:
    background 0.12s,
    border-color 0.12s;
}

.hour-grid button:hover {
  background: #1a1a1f;
  border-color: rgba(255, 255, 255, 0.16);
}

.hour-grid button.active {
  background: #f4f4f5;
  color: #0a0a0b;
  border-color: #f4f4f5;
  font-weight: 700;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5);
}

.inst-field {
  background: transparent;
  border-radius: 0;
  padding: 0;
  margin-bottom: 16px;
}
.inst-field:last-child {
  margin-bottom: 0;
}

.inst-label {
  display: block;
  color: #70767d;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  margin-bottom: 4px;
}

.inst-choices {
  display: flex;
  gap: 4px;
}

.side-choices {
  gap: 0;
}
.side-choices .inst-choice {
  flex: 1;
  border-radius: 0;
}
.side-choices .inst-choice:first-child {
  border-radius: 3px 0 0 3px;
}
.side-choices .inst-choice:last-child {
  border-radius: 0 3px 3px 0;
  border-left: none;
}
.side-choices .inst-choice + .inst-choice {
  margin-left: -1px;
}

.delta-choices {
  gap: 0;
}
.delta-choices .inst-choice {
  flex: 1;
  border-radius: 0;
}
.delta-choices .inst-choice:first-child {
  border-radius: 3px 0 0 3px;
}
.delta-choices .inst-choice:last-child {
  border-radius: 0 3px 3px 0;
  border-left: none;
}
.delta-choices .inst-choice + .inst-choice {
  margin-left: -1px;
}

.structure-choices,
.maturity-choices {
  gap: 0;
}
.structure-choices .inst-choice,
.maturity-choices .inst-choice {
  flex: 1;
  border-radius: 0;
}
.structure-choices .inst-choice {
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1.15;
}
.structure-choices .inst-choice:first-child,
.maturity-choices .inst-choice:first-child {
  border-radius: 3px 0 0 3px;
}
.structure-choices .inst-choice:last-child,
.maturity-choices .inst-choice:last-child {
  border-radius: 0 3px 3px 0;
  border-left: none;
}
.structure-choices .inst-choice + .inst-choice,
.maturity-choices .inst-choice + .inst-choice {
  margin-left: -1px;
}

.structure-choices {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 4px;
}
.structure-choices .inst-choice {
  margin: 0;
  border-radius: 0;
  border: 0;
}
.structure-choices .inst-choice:nth-child(3n + 2),
.structure-choices .inst-choice:nth-child(3n + 3) {
  margin-left: 0;
  border-left: 1px solid rgba(255, 255, 255, 0.18);
}
.structure-choices .inst-choice:nth-child(n + 4) {
  margin-top: 0;
  border-top: 1px solid rgba(255, 255, 255, 0.18);
}

.maturity-choices {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 4px;
}
.maturity-choices .inst-choice {
  margin: 0;
  border: 0;
  border-radius: 0;
}
.maturity-choices .inst-choice:nth-child(3n + 2),
.maturity-choices .inst-choice:nth-child(3n + 3) {
  margin-left: 0;
  border-left: 1px solid rgba(255, 255, 255, 0.18);
}
.maturity-choices .inst-choice:nth-child(n + 4) {
  margin-top: 0;
  border-top: 1px solid rgba(255, 255, 255, 0.18);
}

.weekday-choices .inst-choice {
  font-size: 10px;
  padding: 4px 2px;
}

.exit-day-choices {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 4px;
}

.exit-day-choices .inst-choice {
  width: 100%;
  font: inherit;
}

.inst-choice {
  flex: 1;
  text-align: center;
  padding: 5px 6px;
  font-size: 11px;
  background: #0a0b0e;
  color: #e8eaed;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 3px;
  cursor: pointer;
  transition: all 0.1s;
  user-select: none;
}

.inst-choice:hover:not(.is-disabled) {
  background: #111114;
  border-color: rgba(255, 255, 255, 0.3);
}

.inst-choice.active {
  background: #7dd3fc;
  color: #000;
  border-color: #7dd3fc;
  font-weight: 500;
}

.inst-choice.is-disabled {
  opacity: 0.45;
  cursor: not-allowed;
  background: #0a0b0e;
}

/* Frequency Dropdown Menu styles from spec */
.freq-menu {
  position: relative;
  font-family: var(
    --font,
    "Inter Tight",
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif
  );
  -webkit-font-smoothing: antialiased;
  width: auto;
}

.freq-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  padding: 7px 13px;
  background: var(--surface, #131316);
  border: 1px solid var(--border, rgba(255, 255, 255, 0.09));
  border-radius: 8px;
  color: var(--text, #f4f4f5);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition:
    background 0.15s,
    border-color 0.15s;
  min-width: 120px;
}
.freq-trigger:hover {
  background: var(--surface-hover, #1a1a1f);
  border-color: var(--border-hover, rgba(255, 255, 255, 0.14));
}
.freq-trigger__lead {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
.freq-trigger__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #7dd3fc;
  box-shadow: 0 0 6px #7dd3fc;
}

.freq-panel {
  position: absolute;
  top: 100%;
  left: 0;
  margin-top: 4px;
  background: var(--panel, #0f0f12);
  border: 1px solid var(--border, rgba(255, 255, 255, 0.09));
  border-radius: 18px;
  padding: 8px;
  box-shadow:
    0 24px 60px -12px rgba(0, 0, 0, 0.8),
    0 0 0 1px rgba(255, 255, 255, 0.02);
  z-index: 10;
  min-width: 220px;
}
.freq-menu[data-open="false"] .freq-panel {
  display: none;
}

.freq-row {
  padding: 12px 10px 10px;
  border-radius: 12px;
  transition: background 0.15s;
}
.freq-row:hover {
  background: var(--row-hover, rgba(255, 255, 255, 0.02));
}
.freq-row__label {
  display: block;
  margin-bottom: 12px;
  color: var(--text-2, #e7e7ea);
  font-size: 12px;
  font-weight: 600;
}

.freq-slider {
  -webkit-appearance: none;
  -moz-appearance: none;
  appearance: none;
  width: 100%;
  height: 22px;
  background: transparent;
  outline: none;
  border: none;
  box-shadow: none;
  cursor: pointer;
  --pct: 32%;
}
.freq-slider::-webkit-slider-runnable-track {
  height: 6px;
  border-radius: 99px;
  background: linear-gradient(
    to right,
    var(--fill, #f4f4f5) 0 var(--pct),
    var(--track, #2b2b30) var(--pct) 100%
  );
}
.freq-slider::-moz-range-track {
  height: 6px;
  border-radius: 99px;
  background: var(--track, #2b2b30);
}
.freq-slider::-moz-range-progress {
  height: 6px;
  border-radius: 99px;
  background: var(--fill, #f4f4f5);
}
.freq-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 14px;
  height: 14px;
  margin-top: -4px;
  border-radius: 50%;
  border: none;
  background: var(--handle, #ffffff);
  box-shadow:
    0 1px 4px rgba(0, 0, 0, 0.5),
    0 0 0 1px rgba(0, 0, 0, 0.06);
}
.freq-slider::-moz-range-thumb {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: none;
  background: var(--handle, #ffffff);
  box-shadow:
    0 1px 4px rgba(0, 0, 0, 0.5),
    0 0 0 1px rgba(0, 0, 0, 0.06);
}

.freq-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 10px;
}
.freq-footer__edge {
  color: var(--text-muted, #71717a);
  font-size: 11px;
  font-weight: 500;
}
.freq-footer__value {
  padding: 4px 10px;
  background: var(--surface-hover, #1a1a1f);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  color: var(--text, #f4f4f5);
  font-size: 11px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

/* More padding below toggle and slider */
.freq-toggle-row {
  margin-bottom: 16px;
}

.freq-row .freq-slider {
  margin-bottom: 8px;
}

/* Nice round toggle switch */
.toggle-switch {
  position: relative;
  display: inline-block;
  width: 36px;
  height: 20px;
}

.toggle-switch input {
  opacity: 0;
  width: 0;
  height: 0;
}

.toggle-slider {
  position: absolute;
  cursor: pointer;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: #333;
  border-radius: 20px;
  transition: 0.3s;
  border: 1px solid rgba(255, 255, 255, 0.2);
}

.toggle-slider:before {
  position: absolute;
  content: "";
  height: 14px;
  width: 14px;
  left: 2px;
  bottom: 2px;
  background-color: white;
  border-radius: 50%;
  transition: 0.3s;
}

.toggle-switch input:checked + .toggle-slider {
  background-color: #7dd3fc;
  border-color: #7dd3fc;
}

.toggle-switch input:checked + .toggle-slider:before {
  transform: translateX(16px);
}

/* Grey out slider when hedging is off */
.freq-slider:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.freq-slider:disabled::-webkit-slider-thumb {
  background: #666;
}

.freq-slider:disabled::-moz-range-thumb {
  background: #666;
}

.spacer {
  flex: 1;
}

.segmented {
  display: flex;
  align-items: center;
  height: 30px;
  box-sizing: border-box;
  background: rgba(255, 255, 255, 0.05);
  border-radius: 8px;
  padding: 2px;
}

.segment {
  border: 0;
  background: transparent;
  font-family: inherit;
  font-size: 12px;
  font-weight: 500;
  color: #70767d;
  height: 26px;
  padding: 0 14px;
  line-height: 1;
  border-radius: 6px;
  cursor: pointer;
}

.segment.active {
  background: rgba(255, 255, 255, 0.1);
  color: #e8eaed;
}

.viewMenu {
  position: relative;
  height: 26px;
}

.viewMenuTrigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}

.viewMenuTrigger svg {
  color: #70767d;
  transition: transform 120ms ease;
}

.viewMenu:hover .viewMenuTrigger svg,
.viewMenu:focus-within .viewMenuTrigger svg {
  transform: rotate(180deg);
}

.viewDropdown {
  position: absolute;
  top: 100%;
  right: 0;
  width: 184px;
  padding-top: 8px;
  visibility: hidden;
  opacity: 0;
  pointer-events: none;
  transform: translateY(-3px);
  transition:
    opacity 100ms ease,
    transform 100ms ease,
    visibility 100ms;
  z-index: 30;
}

.viewMenu:hover .viewDropdown,
.viewMenu:focus-within .viewDropdown {
  visibility: visible;
  opacity: 1;
  pointer-events: auto;
  transform: translateY(0);
}

.viewDropdownSurface {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 5px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  background: #0f0f12;
  box-shadow: 0 16px 38px rgba(0, 0, 0, 0.58);
}

.viewDropdown button {
  width: 100%;
  padding: 8px 10px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: #8b9198;
  font: inherit;
  font-size: 11px;
  font-weight: 500;
  text-align: left;
  cursor: pointer;
}

.viewDropdown button:hover,
.viewDropdown button:focus-visible {
  background: rgba(255, 255, 255, 0.06);
  color: #e8eaed;
  outline: none;
}

.viewDropdown button.active {
  background: rgba(255, 255, 255, 0.1);
  color: #e8eaed;
}

.sweepHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  min-height: 44px;
  padding: 0 4px 5px;
}

.sweepHeader .chartTitle,
.sweepHeader .chartSubtitle {
  text-align: left;
}

.sweepHeader .chartTitle {
  font-size: 17px;
}
.sweepHeader .chartSubtitle {
  font-size: 15px;
}

.sweepControls {
  display: flex;
  align-items: center;
  gap: 8px;
}

.sweepDimensionControl {
  display: flex;
  align-items: center;
  height: 30px;
  box-sizing: border-box;
  padding: 2px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 7px;
  background: #0d0e11;
}

.sweepDimensionControl button {
  height: 24px;
  box-sizing: border-box;
  border: 0;
  border-radius: 5px;
  padding: 0 11px;
  background: transparent;
  color: #747a82;
  font:
    500 12px/1 "Helvetica Neue",
    Helvetica,
    -apple-system,
    sans-serif;
  cursor: pointer;
  transition:
    background 0.12s,
    color 0.12s,
    border-color 0.12s;
}

.sweepDimensionControl button:hover:not(:disabled) {
  color: #d8dadd;
  background: rgba(255, 255, 255, 0.045);
}

.sweepDimensionControl button.active {
  color: #f0f1f2;
  background: rgba(255, 255, 255, 0.1);
}

.sweepDimensionControl button:disabled {
  cursor: default;
  opacity: 0.5;
}

.sweepPanel {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.055);
  border-radius: 8px;
  background: #090a0d;
}

.rvCombinedPanel {
  overflow: hidden;
}

.rvCombinedPanel :deep(.styledSelect) {
  font-size: 10px;
}
.rvCombinedPanel :deep(.styledSelectMenu button) {
  font-size: 11px;
}
.rvCombinedPanel :deep(.styledSelectCheck) {
  font-size: 12px;
}

.rvCombinedCharts {
  --study-edge-x: 18px;
  --study-edge-y: 16px;
  --study-section-gap: 24px;
  --study-divider-offset: 12px;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  padding: var(--study-edge-y) var(--study-edge-x) 28px;
}

.rvChartSection {
  width: 100%;
  min-width: 0;
  height: 470px;
  display: flex;
  flex-direction: column;
}

.rvHeatmapSection {
  --heatmap-plot-left: max(84px, calc((100% - 1186px) / 2));
  height: 544px;
  position: relative;
}

.rvHeatmapSection :deep(.chartWrap) {
  margin-top: 0;
}

.rvHeatmapSection .rvSectionHeader {
  position: absolute;
  z-index: 8;
  top: 0;
  right: 0;
  left: 0;
  min-height: 0;
  padding: 0;
  display: grid;
  grid-template-columns: auto auto;
  grid-template-rows: 30px 24px;
  justify-content: end;
  align-items: center;
  column-gap: 7px;
  row-gap: 8px;
  pointer-events: none;
}

.rvHeatmapSection .rvSectionHeader > .sweepDimensionControl {
  grid-column: 1;
  grid-row: 1;
  pointer-events: auto;
}

.rvHeatmapSection .rvSectionActions {
  grid-column: 2;
  grid-row: 1;
  pointer-events: auto;
}

.rvHeatmapSection .rvHeatmapRange {
  position: absolute;
  top: 60px;
  left: var(--heatmap-plot-left);
  margin: 0;
  pointer-events: auto;
}

.rvBoxplotSection {
  height: 450px;
  position: relative;
  margin-top: var(--study-section-gap);
}

.rvBoxplotSection::before {
  content: "";
  position: absolute;
  top: calc(-1 * var(--study-divider-offset));
  left: 0;
  right: 0;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}

.rvBoxplotToolbar {
  position: absolute;
  z-index: 8;
  top: 0;
  right: 0;
}

.rvSecondaryAnalysisSection {
  height: auto;
  min-height: 750px;
  position: relative;
  margin-top: var(--study-section-gap);
}

.rvSecondaryAnalysisSection::before {
  content: "";
  position: absolute;
  top: calc(-1 * var(--study-divider-offset));
  left: 0;
  right: 0;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}

.rvSectionHeader {
  flex: 0 0 auto;
  min-height: 30px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 12px;
}

.rvSecondaryHeatmapBlock {
  position: relative;
}

.rvSecondaryHeatmap {
  display: flex;
  flex: 0 0 486px;
  width: 100%;
  min-width: 0;
  height: 486px;
}

.rvSecondaryHeatmapToolbar {
  position: absolute;
  z-index: 8;
  top: 0;
  right: 0;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding: 0;
}

.rvTermStructureBlock {
  position: relative;
  margin-top: var(--study-section-gap);
}

.rvTermStructureBlock::before {
  content: "";
  position: absolute;
  top: calc(-1 * var(--study-divider-offset));
  left: 0;
  right: 0;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}

.rvTermStructureToolbar {
  min-height: 30px;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding: 0 0 8px;
}

.rvSectionActions {
  display: flex;
  align-items: center;
  gap: 7px;
}

.rvScreenshotButton {
  height: 24px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 9px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 5px;
  background: rgba(255, 255, 255, 0.025);
  color: #8f949b;
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
}

.rvScreenshotButton:hover:not(:disabled) {
  border-color: rgba(255, 255, 255, 0.2);
  background: rgba(255, 255, 255, 0.06);
  color: #f2f3f5;
}

.rvScreenshotButton:disabled {
  cursor: default;
  opacity: 0.45;
}

.rvDataLabelsButton.active {
  border-color: rgba(255, 255, 255, 0.28);
  background: rgba(255, 255, 255, 0.12);
  color: #f2f3f5;
}

.rvChartSection :deep(.chartWrap) {
  flex: 1;
  height: auto;
}

.sweepHistogram {
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: auto;
}

.sweepEmpty {
  height: 100%;
  display: grid;
  place-items: center;
  color: #666c73;
  font-size: 13px;
}

.sweepPerformance {
  position: absolute;
  right: 12px;
  bottom: 8px;
  padding: 5px 8px;
  border-radius: 5px;
  background: rgba(10, 11, 14, 0.88);
  color: #626870;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  pointer-events: none;
}

.ivRvRangeControl {
  width: 220px;
}

.ivRvRangeInline {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-left: auto;
}

.rvHeatmapRange {
  height: 24px;
  margin-left: 0;
}

.ivRvRangeLabel {
  color: #626870;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.dateRangeSlider {
  position: relative;
  height: 18px;
}

.dateRangeTrack,
.dateRangeSelection {
  position: absolute;
  top: 7px;
  height: 3px;
  border-radius: 999px;
  pointer-events: none;
}

.dateRangeTrack {
  left: 0;
  right: 0;
  background: rgba(245, 245, 245, 0.2);
}

.dateRangeSelection {
  left: var(--range-start);
  right: calc(100% - var(--range-end));
  background: #d8dadd;
}

.dateRangeInput {
  -webkit-appearance: none;
  appearance: none;
  position: absolute;
  inset: 0;
  width: 100%;
  height: 18px;
  margin: 0;
  background: transparent;
  pointer-events: none;
}

.dateRangeInput:focus {
  outline: none;
}
.dateRangeInput::-webkit-slider-runnable-track {
  height: 3px;
  background: transparent;
}
.dateRangeInput::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 8px;
  height: 8px;
  margin-top: -2.5px;
  border: 0;
  border-radius: 50%;
  background: #f5f5f7;
  cursor: pointer;
  pointer-events: auto;
}
.dateRangeInput::-moz-range-track {
  height: 3px;
  background: transparent;
}
.dateRangeInput::-moz-range-thumb {
  width: 8px;
  height: 8px;
  border: 0;
  border-radius: 50%;
  background: #f5f5f7;
  cursor: pointer;
  pointer-events: auto;
}

.dataRangeSlider {
  height: 26px;
}

.dataRangeSlider .dateRangeTrack,
.dataRangeSlider .dateRangeSelection {
  top: 11px;
  height: 4px;
}

.dataRangeSlider .dateRangeSelection {
  background: #fff;
}

.dataRangeSlider .dateRangeInput {
  height: 26px;
}

.dataRangeSlider .dateRangeInput::-webkit-slider-thumb {
  width: 14px;
  height: 14px;
  margin-top: -5px;
  border: 2px solid #0f0f12;
  background: #fff;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.32);
}

.dataRangeSlider .dateRangeInput::-moz-range-thumb {
  width: 14px;
  height: 14px;
  border: 2px solid #0f0f12;
  background: #fff;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.32);
}

.configCluster {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  min-width: 0;
}

.modeToggle button,
.field select,
.runButton {
  height: 36px;
  border: 1px solid #35353a;
  border-radius: 6px;
  background: #111114;
  color: #f4f4f5;
  font: inherit;
  outline: none;
}

.modeToggle {
  display: inline-flex;
  gap: 4px;
  padding: 3px;
  border: 1px solid #303035;
  border-radius: 8px;
  background: #0d0d10;
}

.modeToggle button {
  height: 30px;
  padding: 0 13px;
  border: 0;
  background: transparent;
  color: #a6a6ad;
  cursor: pointer;
  font-weight: 600;
}

.modeToggle button.active {
  background: #c7ddff;
  color: #163f7d;
}

.main {
  flex: 1;
  display: flex;
  align-items: stretch;
  gap: 8px;
  padding: 10px 36px 16px 28px;
  min-height: 0;
  height: 0; /* allow flex child to grow */
}

.metricsColumn {
  display: flex;
  flex-direction: column;
  gap: 28px;
  width: 160px;
  flex: none;
  padding-top: 44px;
}

.metric {
  display: flex;
  flex-direction: column;
  gap: 5px;
  white-space: nowrap;
  background: transparent;
  border: none;
  padding: 0;
  min-height: auto;
}

.metricValue {
  font-size: 22px;
  font-weight: 300;
  letter-spacing: -0.3px;
  color: #e8eaed;
}

.metricValue.maxdd {
  color: #9aa0a6;
}

.metricLabel {
  font-size: 12px;
  letter-spacing: 1.2px;
  text-transform: uppercase;
  color: #70767d;
}

.chartColumn {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-height: 0;
}

.chartHeader {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  flex: none;
}

.chartTitle {
  width: 100%;
  text-align: center;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.1px;
  color: #e8eaed;
}

.chartSubtitle {
  font-size: 14px;
  line-height: 1.35;
  color: #70767d;
}

.chartSourceSubtitle {
  font-size: 14px;
  line-height: 1.35;
  color: #70767d;
}

.chartTitleRow {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  padding: 0 36px;
}

.backButton {
  position: absolute;
  left: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  background: transparent;
  color: #70767d;
  cursor: pointer;
  transition: all 0.1s;
}

.backButton:hover {
  color: #7dd3fc;
  border-color: rgba(125, 211, 252, 0.3);
  background: rgba(255, 255, 255, 0.03);
}

.saveButton {
  flex: none;
  font-size: 11px;
  font-weight: 600;
  padding: 3px 9px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 4px;
  background: transparent;
  color: #70767d;
  cursor: pointer;
  transition: all 0.1s;
}

.saveButton:hover {
  color: #7dd3fc;
  border-color: rgba(125, 211, 252, 0.3);
  background: rgba(255, 255, 255, 0.03);
}

.topSaveButton {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  box-sizing: border-box;
  padding: 0;
  border-radius: 6px;
}

.topActions {
  display: flex;
  align-items: center;
  gap: 7px;
}

.saveButton:disabled {
  opacity: 0.4;
  cursor: default;
}

.cycleDetailState {
  flex: 1;
  display: grid;
  place-items: center;
  color: #70767d;
  font-size: 13px;
}

.cycleDetailState.error {
  color: #f87171;
}

.strategyHeader {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 18px;
  min-width: 0;
  margin-bottom: 18px;
}

.strategyHeader p,
.strategyHeader h2 {
  margin: 0;
  letter-spacing: 0;
}

.strategyHeader p {
  flex: 0 0 auto;
  color: #8d8d96;
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
}

.strategyHeader h2 {
  min-width: 0;
  color: #f5f5f7;
  font-size: 20px;
  font-weight: 650;
  line-height: 1.25;
  text-align: right;
}

.chartPanel {
  width: 100%;
  min-height: 620px;
  margin-bottom: 20px;
  padding: 12px;
  border: 1px solid #23232a;
  border-radius: 8px;
  background: #08080a;
}

.status {
  display: flex;
  min-height: 520px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: #a6a6ad;
  text-align: center;
}

.status strong {
  color: #f4f4f5;
  font-size: 16px;
  font-weight: 650;
}

.status.error strong {
  color: #ff6b7a;
}

.runFacts {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.runFacts span {
  min-height: 34px;
  padding: 8px 12px;
  border: 1px solid #2c2c31;
  border-radius: 6px;
  color: #d2d2d8;
  background: #101014;
  font-size: 13px;
}

.positive {
  color: #66d38f;
}

.negative {
  color: #e46578;
}

@media (max-width: 1280px) {
  .topBar {
    padding-inline: 16px;
    gap: 12px;
  }

  .configPills {
    gap: 6px;
  }

  .pill {
    gap: 5px;
    padding: 6px 9px;
    font-size: 11px;
  }

  .pillLabel {
    font-size: 12px;
  }

  .segment {
    padding-inline: 10px;
  }
}

@media (max-width: 1080px) {
  .topBar {
    padding-inline: 12px;
    gap: 8px;
  }

  .divider {
    display: none;
  }

  .configPills {
    gap: 4px;
  }

  .pill {
    gap: 4px;
    padding: 5px 7px;
    font-size: 10px;
  }

  .pillLabel {
    font-size: 11px;
  }

  .dataPill {
    width: 140px;
  }

  .segment {
    padding-inline: 8px;
  }
}

@media (max-width: 960px) {
  .header {
    align-items: flex-start;
    flex-direction: column;
    padding: 16px;
  }

  .configCluster {
    width: 100%;
    justify-content: flex-start;
  }

  .workspace {
    grid-template-columns: 1fr;
  }

  .rail {
    min-height: auto;
    border-right: 0;
    border-bottom: 1px solid #26262a;
  }

  .strategyHeader {
    align-items: stretch;
    flex-direction: column;
  }

  .strategyHeader h2 {
    text-align: left;
  }

  .chartPanel {
    padding: 10px;
  }
}
</style>
