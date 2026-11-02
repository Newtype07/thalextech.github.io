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
import { buildInitiallyHedgedThetaCone, buildThetaCone } from "./theta-cone.js";
import { getAvailableStraddles } from "./straddle-selection.js";
import { coneExpiryMarkerLabel, coneMarkerLabel, coneMarkerOffsets } from "./cone-markers.js";
import StyledSelectMenu from "./components/StyledSelectMenu.vue";
import OptionPnlChart from "./components/OptionPnlChart.vue";
import PnlAttribution from "./components/PnlAttribution.vue";
import { buildStraddlePnlHistory } from "./pnl-history.js";
import { exportStraddlePnlToPng } from "./export-pnl.js";
import StraddleBreakEvenChart from "./components/StraddleBreakEvenChart.vue";
import {
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
const ALL_MATURITIES_VALUE = "all";
const ALL_MATURITIES_MARK_POINTS = 30;
const ALL_MATURITIES_MARK_INTERVAL_SECONDS = 60;
const PUT_BREAK_EVEN_COLOR = "#ef4444";
const CALL_BREAK_EVEN_COLOR = "#22c55e";
const BREAK_EVEN_MAX_OPACITY = 0.9;
const BREAK_EVEN_MIN_OPACITY = 0.3;
const CONE_MODE_TOOLTIP = "Curves show the prices needed to break even when closing at each date; at expiry they reach strike ± premium. Assumes constant implied volatility, zero rates and no fees, from the latest loaded index close. The cone can be asymmetric when the straddle has directional exposure.";

const INITIAL_HEDGE_TOOLTIP = "Offsets each straddle’s initial delta with a fixed underlying hedge. Both cone edges start at the current price. Break-evens include the hedge’s profit or loss, so expiry levels differ from strike ± premium. The hedge is not rebalanced. Assumes constant implied volatility, zero rates and no fees.";

const UNDERLYING_OPTIONS = [
  { value: "BTCUSD", label: "BTC" },
  { value: "ETHUSD", label: "ETH" },
];

const ui = reactive({
  resolutionKey: "3600",
  optionMaturity: "",
  optionStrike: "",
  mode: "breakeven",
  coneMode: false,
  hedgeInitialDelta: false,
  showDayMarkers: true,
  maxPoints: DEFAULT_HISTORY_POINT_LIMIT,
  circleSize: DEFAULT_CIRCLE_SIZE,
  loading: false,
  error: "",
});
const isConeMode = computed(() => ui.mode === "breakeven" && ui.coneMode);
const isInitiallyHedgedCone = computed(() => isConeMode.value && ui.hedgeInitialDelta);
const coneModeTooltip = computed(() => isInitiallyHedgedCone.value ? INITIAL_HEDGE_TOOLTIP : CONE_MODE_TOOLTIP);
const underlying = ref("BTCUSD");
const allInstruments = ref([]);
const data = reactive({
  optionInstruments: [],
  callMark: {},
  putMark: {},
  index: {},
});
const allMaturityMarks = ref({});
const chartRef = ref(null);
const straddleWorkspaceRef = ref(null);
const pnlRange = ref(null);
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
const compactPriceFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const formatChartPrice = value => Math.abs(value) >= 1000
  ? compactPriceFormatter.format(value).toLowerCase()
  : strikeFormatter.format(value);


const requestedMaxPoints = computed(() => {
  const value = Math.floor(Number(ui.maxPoints));
  if (!Number.isFinite(value)) return DEFAULT_HISTORY_POINT_LIMIT;
  return Math.max(
    MIN_HISTORY_POINT_LIMIT,
    Math.min(MAX_HISTORY_POINT_LIMIT, value),
  );
});
const manualMaxPointsToFetch = ref(DEFAULT_HISTORY_POINT_LIMIT);
const maxPointsToFetch = computed(() => coneTimeWindow.value?.pointCount ?? manualMaxPointsToFetch.value);

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

const isAllMaturities = computed(() => ui.optionMaturity === ALL_MATURITIES_VALUE);
const selectedMaturityTs = computed(() => Number(ui.optionMaturity));
const selectedStrike = computed(() => Number(ui.optionStrike));
const availableStraddles = computed(() =>
  getAvailableStraddles(data.optionInstruments, Math.floor(Date.now() / 1000)),
);
const allMaturityStraddles = computed(() =>
  availableStraddles.value.filter(straddle => straddle.strike === selectedStrike.value),
);
const breakEvenHorizonTs = computed(() => isAllMaturities.value
  ? Math.max(...availableStraddles.value.map(straddle => straddle.expiryTs))
  : selectedMaturityTs.value,
);



// Keep the all-maturities comparison on the same horizon when the strike changes.
// The longest available maturity sets the lookahead, including skipped expiries.
// History occupies twice that duration.
const coneTimeWindow = computed(() => {
  if (!isConeMode.value) return null;
  const interval = RESOLUTION_CONFIG[ui.resolutionKey]?.interval_seconds || 3600;
  const rows = data.index[ui.resolutionKey] || [];
  const entryTs = rows.reduce((latest, row) =>
    Number.isFinite(row?.ts) && Number.isFinite(row?.index_price_close)
      ? Math.max(latest, row.ts) : latest, 0) || Math.floor(Date.now() / 1000 / interval) * interval;
  const expiryTs = breakEvenHorizonTs.value;
  const lookahead = expiryTs - entryTs;
  if (!Number.isFinite(lookahead) || lookahead <= 0) return null;
  return {
    from: entryTs - 2 * lookahead,
    to: expiryTs,
    pointCount: Math.min(MAX_HISTORY_POINT_LIMIT, Math.ceil(2 * lookahead / interval) + 1),
  };
});
const coneTimeDomain = computed(() => coneTimeWindow.value
  ? [new Date(coneTimeWindow.value.from * 1000), new Date(coneTimeWindow.value.to * 1000)]
  : null);


const maturityDropdownOptions = computed(() => {
  const base = optionMaturities.value;
  if (ui.mode === "breakeven" && base.length > 1) {
    return [{ value: ALL_MATURITIES_VALUE, label: "All maturities" }, ...base];
  }
  return base;
});

const optionInstrumentsForMaturity = computed(() => {
  const maturityTs = selectedMaturityTs.value;
  return data.optionInstruments.filter(
    (instrument) => instrument?.expiration_ts === maturityTs,
  );
});

const optionStrikes = computed(() => {
  const pairs = isAllMaturities.value ? availableStraddles.value
    : availableStraddles.value.filter(straddle => straddle.expiryTs === selectedMaturityTs.value);
  return [...new Set(pairs.map(straddle => straddle.strike))]
    .sort((a, b) => a - b)
    .map(strike => ({ value: String(strike), label: strikeFormatter.format(strike) }));
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
  () => `${underlyingLabel.value} Straddle ${isConeMode.value
    ? isInitiallyHedgedCone.value ? "Initially Hedged Theta Cone" : "Unhedged Theta Cone"
    : "Break-Evens"}`,
);
const breakEvenSubtitle = computed(() => {
  if (isAllMaturities.value) {
    const count = allMaturityStraddles.value.length;
    return `Strike: ${formatChartPrice(selectedStrike.value)} · ${count} of ${optionMaturities.value.length} maturities`;
  }
  const expiryTs = selectedMaturityTs.value;
  const strike = selectedStrike.value;
  if (!Number.isFinite(expiryTs) || !Number.isFinite(strike)) return "";
  return `Expiry: ${maturityFormatter.format(new Date(expiryTs * 1000))} UTC Strike: ${strikeFormatter.format(strike)}`;
});

const allMaturityBreakEvenLevels = computed(() => {
  if (!isAllMaturities.value) return [];
  const marks = allMaturityMarks.value;
  const straddles = allMaturityStraddles.value;
  const spot = getLatestIndexClose(data.index[ui.resolutionKey] || []);

  const entries = [];
  for (const s of straddles) {
    const call = marks[s.callInstrumentName];
    const put = marks[s.putInstrumentName];
    if (!Number.isFinite(call) || !Number.isFinite(put)) continue;
    const straddleMark = call + put;
    entries.push({
      expiryTs: s.expiryTs,
      low: s.strike - straddleMark,
      high: s.strike + straddleMark,
      date: maturityFormatter.format(new Date(s.expiryTs * 1000)),
    });
  }
  if (!entries.length) return [];

  const distances = Number.isFinite(spot)
    ? entries.flatMap((e) => [Math.abs(e.low - spot), Math.abs(e.high - spot)])
    : [];
  const minDist = distances.length ? Math.min(...distances) : 0;
  const maxDist = distances.length ? Math.max(...distances) : 0;
  const opacityFor = (value) => {
    if (!Number.isFinite(spot) || maxDist <= minDist) return BREAK_EVEN_MAX_OPACITY;
    const t = (Math.abs(value - spot) - minDist) / (maxDist - minDist);
    return BREAK_EVEN_MAX_OPACITY - (BREAK_EVEN_MAX_OPACITY - BREAK_EVEN_MIN_OPACITY) * t;
  };

  const levels = [];
  for (const e of entries) {
    levels.push({
      id: `be-low-${e.expiryTs}`,
      value: e.low,
      color: PUT_BREAK_EVEN_COLOR,
      opacity: opacityFor(e.low),
      label: `${e.date} ↓ ${formatChartPrice(e.low)}`,
      expiryTs: e.expiryTs,
    });
    levels.push({
      id: `be-high-${e.expiryTs}`,
      value: e.high,
      color: CALL_BREAK_EVEN_COLOR,
      opacity: opacityFor(e.high),
      label: `${e.date} ↑ ${formatChartPrice(e.high)}`,
      expiryTs: e.expiryTs,
    });
  }
  return levels;
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
    .filter(row => !coneTimeWindow.value || row.ts >= coneTimeWindow.value.from)
    .map((row) => ({
      date: new Date(row.ts * 1000),
      value: row.index_price_close,
      low: row.index_price_low,
      high: row.index_price_high,
    })),
);

const breakEvenProjectedData = computed(() => {
  const actual = breakEvenActualData.value;
  if (!actual.length) return [];
  const targetTs = breakEvenHorizonTs.value;
  if (!Number.isFinite(targetTs)) return [];
  const lastActual = actual[actual.length - 1];
  const targetDate = new Date(targetTs * 1000);
  if (!(targetDate > lastActual.date)) return [];
  return [
    { date: lastActual.date, value: lastActual.value },
    { date: targetDate, value: lastActual.value },
  ];
});

const breakEvenCurrentIndex = computed(() => {
  const actual = breakEvenActualData.value;
  return actual.length ? actual[actual.length - 1].value : null;
});

const thetaCones = computed(() => {
  if (!isConeMode.value) return [];
  const actual = breakEvenActualData.value;
  const latest = actual[actual.length - 1];
  if (!latest) return [];
  const entries = isAllMaturities.value
    ? allMaturityStraddles.value.map(straddle => ({
        ...straddle,
        premium: Number.isFinite(allMaturityMarks.value[straddle.callInstrumentName]) &&
          Number.isFinite(allMaturityMarks.value[straddle.putInstrumentName])
          ? allMaturityMarks.value[straddle.callInstrumentName] + allMaturityMarks.value[straddle.putInstrumentName]
          : NaN,
      }))
    : [{ expiryTs: selectedMaturityTs.value, strike: selectedStrike.value,
        premium: breakEvenMetrics.value?.straddleMark }];
  return entries.flatMap(entry => {
    const buildCone = isInitiallyHedgedCone.value ? buildInitiallyHedgedThetaCone : buildThetaCone;
    const cone = buildCone({
      spot: latest.value, strike: entry.strike, premium: entry.premium,
      entryTs: latest.date.getTime() / 1000, expiryTs: entry.expiryTs,
      holdingPeriods: ui.showDayMarkers
        ? coneMarkerOffsets(entry.expiryTs - latest.date.getTime() / 1000) : [],
    });
    return cone ? [{ ...cone, id: String(entry.expiryTs), expiryTs: entry.expiryTs }] : [];
  });
});

const coneDayMarkers = computed(() => {
  if (!ui.showDayMarkers || !thetaCones.value.length) return [];
  const cone = thetaCones.value.reduce((longest, candidate) =>
    candidate.expiryTs > longest.expiryTs ? candidate : longest);
  const entry = cone.points[0];
  const duration = cone.expiryTs - entry.date.getTime() / 1000;
  const markers = coneMarkerOffsets(duration).flatMap(seconds => {
    const point = cone.points.find(candidate =>
      candidate.date.getTime() === entry.date.getTime() + seconds * 1000);
    return point ? [{
      id: `hold-${seconds}`, date: point.date, low: point.low, high: point.high,
      referenceValue: breakEvenCurrentIndex.value, label: coneMarkerLabel(seconds),
    }] : [];
  });
  const terminal = cone.points[cone.points.length - 1];
  return [...markers, {
    id: "hold-expiry", date: terminal.date, low: terminal.low, high: terminal.high,
    referenceValue: breakEvenCurrentIndex.value, label: coneExpiryMarkerLabel(duration),
  }];
});

const chartBreakEvenLevels = computed(() => {
  if (!isConeMode.value) return allMaturityBreakEvenLevels.value;
  return thetaCones.value.flatMap(cone => {
    const terminal = cone.points[cone.points.length - 1];
    return ["low", "high"].map(side => ({
      id: `be-${side}-${cone.expiryTs}`,
      expiryTs: cone.expiryTs,
      value: terminal[side],
      color: side === "low" ? PUT_BREAK_EVEN_COLOR : CALL_BREAK_EVEN_COLOR,
      opacity: 0.8,
      label: `${maturityFormatter.format(terminal.date)} ${side === "low" ? "↓" : "↑"} ${formatChartPrice(terminal[side])}`,
      tooltip: isInitiallyHedgedCone.value
        ? "Expiry break-even including a fixed hedge of the initial delta. The curve includes both straddle and hedge P&L, at constant implied volatility and before fees."
        : "Expiry break-even. The curve shows earlier holding-period break-evens at constant implied volatility, before fees.",
      points: cone.points.map(point => ({ date: point.date, value: point[side] })),
    }));
  });
});
const coneUnavailableCount = computed(() => isConeMode.value
  ? (isAllMaturities.value ? allMaturityStraddles.value.length : 1) - thetaCones.value.length
  : 0);

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

const straddlePnlHistory = computed(() => {
  const series = mainSeries.value;
  const from = pnlRange.value?.from ?? series[0]?.ts;
  const to = pnlRange.value?.to ?? series.at(-1)?.ts;
  return buildStraddlePnlHistory({
    index: (data.index[ui.resolutionKey] || []).filter(row => row.ts >= from && row.ts <= to),
    callMark: data.callMark[ui.resolutionKey] || [],
    putMark: data.putMark[ui.resolutionKey] || [],
    callInstrument: selectedCallInstrument.value,
    putInstrument: selectedPutInstrument.value,
    intervalSeconds: RESOLUTION_CONFIG[ui.resolutionKey].interval_seconds,
  });
});

async function loadAllMaturities() {
  const requestId = ++loadRequestId;
  ui.loading = true;
  ui.error = "";

  const { resolution, from, to } = getTimestampRange();
  // Chart resolution controls the lookback, not the age of the entry prices.
  // A newly listed maturity may have minute marks before its first daily candle.
  const markTo = Math.floor(Date.now() / 1000 / ALL_MATURITIES_MARK_INTERVAL_SECONDS) * ALL_MATURITIES_MARK_INTERVAL_SECONDS;
  const markFrom = markTo - ALL_MATURITIES_MARK_INTERVAL_SECONDS * (ALL_MATURITIES_MARK_POINTS - 1);
  const snapshotRange = { resolution: "1m", from: markFrom, to: markTo, count: ALL_MATURITIES_MARK_POINTS };

  try {
    const [history, recentIndex] = await Promise.all([
      fetchIndexHistory({ index_name: underlying.value, resolution, from, to, count: maxPointsToFetch.value }),
      fetchIndexHistory({ index_name: underlying.value, ...snapshotRange }),
    ]);
    if (requestId !== loadRequestId) return;
    const snapshot = recentIndex.filter(row => Number.isFinite(row?.ts) && Number.isFinite(row?.index_price_close))
      .sort((a, b) => a.ts - b.ts).at(-1);
    if (!snapshot) throw new Error("No recent index price available for the all-maturities snapshot.");
    const index = [...history.filter(row => row.ts < snapshot.ts), snapshot];

    const straddles = allMaturityStraddles.value;

    if (!straddles.length) {
      data.index[ui.resolutionKey] = index;
      allMaturityMarks.value = {};
      return;
    }

    const names = [];
    for (const s of straddles) names.push(s.callInstrumentName, s.putInstrumentName);
    const results = await Promise.all(
      names.map((name) =>
        fetchMarkHistory({
          instrument_name: name,
          ...snapshotRange,
        }).catch(() => []),
      ),
    );
    if (requestId !== loadRequestId) return;

    const marks = {};
    results.forEach((rows, i) => {
      // Mixing spot and option closes from different times can put the premium
      // below intrinsic value and make an otherwise valid cone impossible to fit.
      const close = rows.find(row => row.ts === snapshot.ts)?.mark_price_close;
      if (Number.isFinite(close)) marks[names[i]] = close;
    });
    data.index[ui.resolutionKey] = index;
    allMaturityMarks.value = marks;
  } catch (e) {
    if (requestId !== loadRequestId) return;
    ui.error = e instanceof Error ? e.message : String(e);
  } finally {
    if (requestId === loadRequestId) {
      ui.loading = false;
    }
  }
}

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

function handleSelectBreakEven(id) {
  if (!isAllMaturities.value) return;
  const match = /^be-(?:low|high)-(\d+)$/.exec(String(id));
  if (!match) return;
  const expiryTs = match[1];
  const straddle = allMaturityStraddles.value.find((s) => String(s.expiryTs) === expiryTs);
  if (!straddle) return;
  ui.optionMaturity = expiryTs;
  ui.optionStrike = String(straddle.strike);
}

function handleSavePng() {
  const base = isAllMaturities.value
    ? `straddle-${selectedStrike.value}-all-maturities`
    : optionInstrumentName.value || "straddle";
  const filenameBase = ui.resolutionKey ? `${base}-${ui.resolutionKey}` : base;
  if (ui.mode === "straddle") {
    if (pnlRange.value) {
      exportStraddlePnlToPng(straddleWorkspaceRef.value, `${filenameBase}.png`);
      return;
    }
    if (!chartRef.value) return;
    chartRef.value.exportPng({ filename: `${filenameBase}.png` });
    return;
  }

  if (!breakEvenChartRef.value) return;
  breakEvenChartRef.value.exportPng({
    filename: `${filenameBase}-${isInitiallyHedgedCone.value ? "theta-cone-initial-hedge" : isConeMode.value ? "theta-cone" : "break-even"}.png`,
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
  const previousMaturity = ui.optionMaturity;
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

    const expiries = optionMaturities.value
      .map((option) => Number(option.value))
      .filter((ts) => Number.isFinite(ts));

    let preservedMaturity = "";
    if (previousMaturity === ALL_MATURITIES_VALUE) {
      preservedMaturity = ALL_MATURITIES_VALUE;
    } else if (previousMaturity && expiries.includes(Number(previousMaturity))) {
      preservedMaturity = previousMaturity;
    }

    if (preservedMaturity) {
      ui.optionMaturity = preservedMaturity;
    } else {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const oneWeekAhead = nowSeconds + 7 * 24 * 60 * 60;
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
    }
    const latestIndexClose = getLatestIndexClose(data.index[ui.resolutionKey]);
    ui.optionStrike = isAllMaturities.value
      ? getClosestStrikeValue(optionStrikes.value, latestIndexClose)
      : getDefaultStrikeValue({
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
    ui.optionStrike = isAllMaturities.value
      ? getClosestStrikeValue(optionStrikes.value, latestIndexClose)
      : getDefaultStrikeValue({
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
    manualMaxPointsToFetch.value = pointLimit;
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
    if (maturityValues.includes(ui.optionMaturity) ||
        (ui.optionMaturity === ALL_MATURITIES_VALUE && ui.mode === "breakeven" && maturities.length > 1)) return;
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
    if (strikes.some(strike => strike.value === ui.optionStrike)) return;
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
    if (isAllMaturities.value) {
      await loadAllMaturities();
      return;
    }
    const callInstrument = selectedCallInstrument.value;
    const putInstrument = selectedPutInstrument.value;
    if (!callInstrument && !putInstrument) return;
    await load({ callInstrument, putInstrument });
  },
  { immediate: false },
);

watch(
  () => ui.optionMaturity,
  (newMaturity, oldMaturity) => {
    if (newMaturity === ALL_MATURITIES_VALUE && oldMaturity !== ALL_MATURITIES_VALUE) {
      ui.resolutionKey = "86400";
    }
  },
);

watch(
  () => ui.mode,
  (mode) => {
    if (mode === "straddle") {
      ui.resolutionKey = "3600";
    }
    if (mode === "straddle" && ui.optionMaturity === ALL_MATURITIES_VALUE) {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const oneWeekAhead = nowSeconds + 7 * 24 * 60 * 60;
      const expiries = optionMaturities.value
        .map((option) => Number(option.value))
        .filter((ts) => Number.isFinite(ts));
      const upcoming = expiries.filter((ts) => ts > nowSeconds);
      const candidates = upcoming.length ? upcoming : expiries;
      const closest = candidates.reduce((best, ts) => {
        if (!Number.isFinite(best)) return ts;
        return Math.abs(ts - oneWeekAhead) < Math.abs(best - oneWeekAhead) ? ts : best;
      }, NaN);
      if (Number.isFinite(closest)) ui.optionMaturity = String(closest);
    }
  },
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
            :options="maturityDropdownOptions"
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
            Historical data points: {{ (isConeMode ? maxPointsToFetch : requestedMaxPoints).toLocaleString() }}
          </div>
          <div v-if="isConeMode" class="settingsHint">
            Auto-sized: ⅔ lookback · ⅓ lookahead.
          </div>
          <input
            v-else
            v-model.number="ui.maxPoints"
            class="settingsSlider"
            type="range"
            aria-label="Historical data points"
            :min="MIN_HISTORY_POINT_LIMIT"
            :max="MAX_HISTORY_POINT_LIMIT"
            step="10"
          />
          <div v-if="!isConeMode" class="settingsRange">
            <span>{{ MIN_HISTORY_POINT_LIMIT }}</span>
            <span>{{ MAX_HISTORY_POINT_LIMIT }}</span>
          </div>
          <label v-if="ui.mode === 'breakeven'" class="settingsConeToggle" :title="coneModeTooltip">
            <span>Theta cone</span>
            <input v-model="ui.coneMode" type="checkbox" role="switch" aria-describedby="cone-setting-hint" :title="coneModeTooltip" :aria-description="coneModeTooltip" />
          </label>
          <div v-if="ui.mode === 'breakeven'" id="cone-setting-hint" class="settingsHint">
            Break-evens by holding period, including time decay.
          </div>
          <template v-if="isConeMode">
            <label class="settingsConeToggle" title="Measure each break-even move from today’s spot. In all maturities, markers follow the longest displayed cone.">
              <span>Day markers from spot</span>
              <input v-model="ui.showDayMarkers" type="checkbox" role="switch" aria-describedby="day-markers-hint" />
            </label>
            <div id="day-markers-hint" class="settingsHint">
              Total move from current spot at each holding period.
              <span v-if="isAllMaturities">Markers follow the longest displayed expiry.</span>
            </div>
            <label class="settingsConeToggle" :title="INITIAL_HEDGE_TOOLTIP">
              <span>Hedge initial delta</span>
              <input
                v-model="ui.hedgeInitialDelta"
                type="checkbox"
                role="switch"
                aria-describedby="initial-hedge-hint"
                :title="INITIAL_HEDGE_TOOLTIP"
                :aria-description="INITIAL_HEDGE_TOOLTIP"
              />
            </label>
            <div id="initial-hedge-hint" class="settingsHint">
              Fixed hedge at entry; no rebalancing.
            </div>
          </template>
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

      <p v-if="isConeMode && !ui.loading && coneUnavailableCount" class="coneNote" role="status">
        {{ coneUnavailableCount }} cone(s) unavailable: missing prices, expired maturity,
        or premium outside the model’s supported range.
      </p>
      <div
        v-if="ui.mode === 'straddle'"
        ref="straddleWorkspaceRef"
        class="straddleWorkspace"
        :class="{ 'straddleWorkspace--selected': pnlRange }"
      >
        <OptionPnlChart
          ref="chartRef"
          :data="mainSeries"
          :option-instrument-name="optionInstrumentName"
          @select-range="pnlRange = $event"
          :compact="Boolean(pnlRange)"
          :circle-size="chartCircleSize"
          :loading="ui.loading"
        />
        <aside v-if="pnlRange" class="pnlPane" aria-label="Selected straddle P&L">
          <PnlAttribution
            :history="straddlePnlHistory"
            :loading="ui.loading"
          />
        </aside>
      </div>
      <StraddleBreakEvenChart
        v-else
        ref="breakEvenChartRef"
        :actual-data="breakEvenActualData"
        :projected-data="breakEvenProjectedData"
        :break-even-low="isAllMaturities || isConeMode ? null : breakEvenMetrics?.breakEvenLow"
        :break-even-high="isAllMaturities || isConeMode ? null : breakEvenMetrics?.breakEvenHigh"
        :break-even-levels="chartBreakEvenLevels"
        :range-bands="thetaCones"
        :range-measurements="coneDayMarkers"
        :price-formatter="formatChartPrice"
        :time-domain="coneTimeDomain"
        :current-index="breakEvenCurrentIndex"
        :expiry-ts="isAllMaturities ? null : selectedMaturityTs"
        :title="breakEvenTitle"
        :subtitle="breakEvenSubtitle"
        :loading="ui.loading"
        @select-break-even="handleSelectBreakEven"
      />
    </div>
  </main>
</template>

<style scoped>
.straddleWorkspace {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  align-items: stretch;
}

.straddleWorkspace--selected {
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
}

.pnlPane {
  min-width: 0;
  border-left: 1px solid #23232a;
  background: #0a0b0e;
}

.straddleWorkspace :deep(.chartWrap) {
  border-radius: 0;
}

@media (max-width: 900px) {
  .straddleWorkspace--selected {
    grid-template-columns: minmax(0, 1fr);
  }

  .pnlPane {
    border-left: 0;
    border-top: 1px solid #23232a;
  }
}

.settingsConeToggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-top: 16px;
  margin-bottom: 6px;
  font-size: 12px;
  cursor: pointer;
}

.settingsConeToggle input {
  accent-color: #7dd3fc;
  cursor: pointer;
}

.coneNote {
  margin: 0;
  padding: 12px 52px 0 16px;
  color: #fbbf24;
  font-size: 12px;
  line-height: 1.6;
}

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
  border: 0;
  border-radius: 0;
  background: var(--color-bg);
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
