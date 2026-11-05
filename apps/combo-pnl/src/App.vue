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
import DeltaHedgeControls from "../../../lib/components/DeltaHedgeControls.vue";
import DeltaHedgeToggle from "../../../lib/components/DeltaHedgeToggle.vue";
import SettingsSidePanel from "../../../lib/components/SettingsSidePanel.vue";
import { DEFAULT_HEDGE_POLICY } from "../../../lib/delta-hedging/index.js";
import { applyDeltaHedge, summarizeComboHedge } from "./delta-hedging.js";
import { tradeChartResolution } from "./chart-resolution.js";
import { tradeWindowRows } from "./trade-window.js";
import { createMinuteHistoryLoader } from "../../../lib/minute-history.js";
import PositionBuilder from "../../../lib/components/PositionBuilder.vue";
import IndexMarkComboChart from "./components/Chart.vue";
import {
  calcGreeks,
  computeGreeksPnlSeries,
  fetchAllInstruments,
  fetchIndexHistory,
  fetchMarkHistory,
} from "../../../lib/thalex.js";

const RESOLUTION_CONFIG = {
  60: { label: "1m", resolution: "1m", interval_seconds: 60 },
  300: { label: "5m", resolution: "5m", interval_seconds: 5 * 60 },
  900: { label: "15m", resolution: "15m", interval_seconds: 15 * 60 },
  3600: { label: "1h", resolution: "1h", interval_seconds: 60 * 60 },
  86400: { label: "1d", resolution: "1d", interval_seconds: 24 * 60 * 60 },
};
const RESOLUTION_OPTIONS = Object.entries(RESOLUTION_CONFIG).map(
  ([key, cfg]) => ({
    key,
    label: cfg.label,
  }),
);
const DEFAULT_MAX_POINTS_PER_FETCH = 360;
const MIN_POINTS_PER_FETCH = 100;
const MAX_POINTS_PER_FETCH = 10000;
const DEFAULT_VOL = 0.4;
const DEFAULT_T = 30 / 365.25;
const MARK_CONCURRENCY = 10;
const LOAD_DEBOUNCE_MS = 140;
const HEDGE_OBSERVATION_SECONDS = 60;
const HISTORY_WINDOW_UNIT_SECONDS = 900;
const loadMinuteIndex = createMinuteHistoryLoader(fetchIndexHistory);
const loadMinuteMarks = createMinuteHistoryLoader(fetchMarkHistory);
const GREEK_EVOLUTION_POINT_COUNT = 101;

const UNDERLYING_OPTIONS = [
  { value: "BTCUSD", label: "BTC" },
  { value: "ETHUSD", label: "ETH" },
];

const ui = reactive({
  resolutionKey: "900",
  maxPoints: DEFAULT_MAX_POINTS_PER_FETCH,
  showHigherOrderGreeks: false,
  loading: false,
  error: "",
});

const hedgePolicy = ref({ ...DEFAULT_HEDGE_POLICY, enabled: false, exit: "hold" });
const hedgeError = ref("");
const underlying = ref("BTCUSD");
const positionLegs = ref([]);

const allInstruments = ref([]);
const instruments = computed(() =>
  (allInstruments.value || []).filter(
    (instrument) =>
      instrument?.type === "option" && instrument?.underlying === underlying.value,
  ),
);
const tickerByInstrument = ref({});
const indexByName = ref({});
const indexSeries = ref([]);
const comboBaseSeries = ref([]);
const comboSeries = ref([]);
const minuteIndexSeries = ref([]);
const minuteComboSeries = ref([]);
const hedgeTrades = computed(() => minuteComboSeries.value.flatMap(row => row.hedge_fill
  ? [{ ...row.hedge_fill, barTs: row.ts }] : []));
const hedgeHistoryGaps = computed(() => minuteComboSeries.value.filter(row => row.hedge_quality?.gap || row.hedge_quality?.missingRisk).length);
const historyTo = ref(Math.floor(Date.now() / 60000) * 60 - 60);
const indexHistoryRows = ref([]);
const markHistoryByInstrument = ref({});
const chartAnchorTs = ref(null);
const chartRangeTs = ref(null);
const tradeMinuteSeries = computed(() => tradeWindowRows(minuteComboSeries.value, chartRangeTs.value));
const hedgeSummary = computed(() => summarizeComboHedge(tradeMinuteSeries.value));
const pnlMoney = value => Number.isFinite(value)
  ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", signDisplay: "exceptZero", maximumFractionDigits: 2 }).format(value)
  : "—";
const costMoney = value => Number.isFinite(value)
  ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value)
  : "—";
const chartLowerMode = ref("mark");
const chartRef = ref(null);
const chartBlockRef = ref(null);
const comboEditorScale = ref(1);
const comboEditorHeight = ref(null);
const builderMainRef = ref(null);
const topSettingsMenuRef = ref(null);
const bottomSettingsMenuRef = ref(null);
const settingsOpenTarget = ref(null);
const settingsLeftPx = ref(null);

let loadRequestId = 0;
let loadTimer = null;
let chartResizeObserver = null;

const clampQty = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.abs(n);
};

const parseExpiryToSeconds = (expiry) => {
  if (!expiry || typeof expiry !== "string") return null;
  const parts = expiry.split(" ");
  if (parts.length < 3) return null;
  const [dayStr, monthStr, yearStr] = parts;
  const day = Number(dayStr);
  const year = Number(yearStr);
  if (!Number.isFinite(day) || !Number.isFinite(year)) return null;
  const monthIdx = new Date(`${monthStr} 1, 2000`).getMonth();
  if (!Number.isFinite(monthIdx)) return null;
  const fullYear = year < 100 ? 2000 + year : year;
  return Math.floor(Date.UTC(fullYear, monthIdx, day, 8, 0, 0) / 1000);
};

const formatExpiryFromTs = (expiryTs) => {
  const date = new Date(Number(expiryTs) * 1000);
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = date.toLocaleString("en-US", {
    month: "short",
    timeZone: "UTC",
  });
  const year = String(date.getUTCFullYear()).slice(-2);
  return `${day} ${month} ${year}`;
};

const newLegId = () => {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ?? `leg_${Math.random().toString(36).slice(2, 10)}`;
};

const normalizeOptionInstrument = (instrument) => {
  if (!instrument || typeof instrument !== "object") return null;
  const strike = Number(instrument.strike_price);
  const expiration = Number(instrument.expiration_timestamp);
  const optionType = (instrument.option_type || "").toLowerCase();
  const type = (instrument.type || instrument.kind || "").toLowerCase();
  if (!instrument.instrument_name) return null;
  const isOption = type === "option" || type === "options" || optionType;
  if (!isOption) return null;
  if (!Number.isFinite(strike) || !Number.isFinite(expiration)) return null;
  return {
    ...instrument,
    strike,
    expiration_ts: expiration,
    option_type_normalized:
      optionType === "put" || optionType === "p" ? "put" : "call",
  };
};

const parsedOptionInstruments = computed(() =>
  (instruments.value || [])
    .map((instrument) => normalizeOptionInstrument(instrument))
    .filter(Boolean)
    .sort((a, b) => a.expiration_ts - b.expiration_ts || a.strike - b.strike),
);

const selectedOptionLegs = computed(() =>
  (positionLegs.value || []).filter((leg) => leg?.kind === "option"),
);

const hasUnsupportedLegs = computed(() =>
  (positionLegs.value || []).some((leg) => leg?.kind !== "option"),
);

const resolveInstrumentForLeg = (leg) => {
  const expiryTs = parseExpiryToSeconds(leg.expiry);
  const strike = Number(leg.strike);
  const optionType = (leg.optionType || "").toLowerCase();
  if (!Number.isFinite(expiryTs) || !Number.isFinite(strike)) return null;
  if (optionType !== "call" && optionType !== "put") return null;

  return (
    parsedOptionInstruments.value.find(
      (instrument) =>
        instrument.expiration_ts === expiryTs &&
        instrument.strike === strike &&
        instrument.option_type_normalized === optionType,
    ) || null
  );
};

const selectedLegInstruments = computed(() => {
  const result = [];

  for (const leg of selectedOptionLegs.value) {
    const instrument = resolveInstrumentForLeg(leg);
    if (!instrument?.instrument_name) continue;
    const qty = clampQty(leg.qty);
    if (!qty) continue;
    const side = String(leg.side || "buy").toLowerCase();
    const isSell = side === "sell";
    const sideSign = isSell ? -1 : 1;
    result.push({
      label: `${isSell ? "Sell" : "Buy"} ${qty} ${instrument.instrument_name}`,
      instrumentName: instrument.instrument_name,
      signedQty: sideSign * qty,
      optionType: instrument.option_type_normalized,
      strike: Number(instrument.strike),
      expirationTs: Number(instrument.expiration_ts),
      underlying: instrument.underlying,
      expiryDate: instrument.expiry_date
    });
  }

  return result;
});

const selectedInstrumentNames = computed(() =>
  Array.from(
    new Set(selectedLegInstruments.value.map((entry) => entry.instrumentName)),
  ),
);

const formatSignedLegQty = (value) => {
  const qty = Math.abs(Number(value));
  if (!Number.isFinite(qty)) return "0";
  return Number.isInteger(qty)
    ? String(qty)
    : qty.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
};

const exportPageTitle = computed(() =>
  [
    selectedLegInstruments.value
      .map((entry) => {
        const signedQty = Number(entry.signedQty);
        const sign = signedQty < 0 ? "-" : "+";
        return `${sign}${formatSignedLegQty(signedQty)} ${entry.instrumentName}`;
      })
      .join(" "),
    hedgePolicy.value.enabled
      ? `Delta hedge: threshold ${hedgePolicy.value.threshold}, tolerance ${hedgePolicy.value.tolerance}, period ${hedgePolicy.value.period / 60} min`
      : "",
  ]
    .filter(Boolean)
    .join("\n"),
);

const activeIndexName = computed(() => underlying.value);

const chartSubtitle = computed(() => {
  const rows = indexSeries.value;
  if (!rows.length) return "";
  const fmt = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  });
  const from = fmt.format(rows[0].date);
  const to = fmt.format(rows[rows.length - 1].date);
  return `${from} - ${to}`;
});

const handleSavePng = () => {
  if (!chartRef.value) return;
  chartRef.value.exportPng({
    filename: `combo-pnl-${activeResolutionLabel.value}.png`,
    pageTitle: exportPageTitle.value,
  });
};

const indexDisplay = computed(() => {
  const snapshot = indexByName.value[activeIndexName.value];
  if (!snapshot) return null;
  const data = snapshot.data;
  const price = Number(data?.index_price_close ?? data?.close ?? data?.price);
  if (!Number.isFinite(price)) return null;
  return {
    price,
    fetchedAt: snapshot.fetchedAt,
  };
});

const FALLBACK_SPOT_BY_UNDERLYING = {
  BTCUSD: 95_000,
  ETHUSD: 3_000,
};

const spot = computed(() => {
  const live = Number(indexDisplay.value?.price);
  if (Number.isFinite(live) && live > 0) return live;
  return FALLBACK_SPOT_BY_UNDERLYING[underlying.value] ?? 95_000;
});

const pickNearestStrike = (strikes, targetPrice) => {
  if (!strikes?.length) return null;
  let chosenStrike = Number(strikes[0]);
  let bestDistance = Math.abs(chosenStrike - targetPrice);
  for (let i = 1; i < strikes.length; i += 1) {
    const strike = Number(strikes[i]);
    const distance = Math.abs(strike - targetPrice);
    if (distance < bestDistance || (distance === bestDistance && strike < chosenStrike)) {
      chosenStrike = strike;
      bestDistance = distance;
    }
  }
  return chosenStrike;
};

const thalexUrl = computed(() => {
  if (selectedLegInstruments.value.length === 0) {
    return undefined;
  }

  let url = "https://thalex.com/exchange/options";

  for (let i = 0; i < selectedLegInstruments.value.length; i++) {
    const { signedQty, instrumentName, underlying, expiryDate } = selectedLegInstruments.value[i];

    if (i === 0) {
      url += `?underlying=${underlying}&expiration=${expiryDate}`;
    }

    url += `&instruments[${i}][0]=${instrumentName}&instruments[${i}][1]=${signedQty}`;
  }

  return url;
});

const seedDefaultLegs = () => {
  if (selectedOptionLegs.value.length) return;
  const options = parsedOptionInstruments.value;
  if (!options.length) return;

  const now = Math.floor(Date.now() / 1000);
  const latestChartCandleTs = getTimestampRange().to;
  // A new expiry can appear in all_instruments before its first mark candle.
  const optionsWithMarkCoverage = options.filter((instrument) => {
    const createTs = normalizeTimestampSeconds(
      instrument.create_time ?? instrument.create_time_ms,
    );
    return !Number.isFinite(createTs) || createTs <= latestChartCandleTs;
  });
  const defaultableOptions = optionsWithMarkCoverage.length
    ? optionsWithMarkCoverage
    : options;
  const target =
    now + Math.max(1, Math.round(DEFAULT_T * 365.25)) * 24 * 60 * 60;
  const upcoming = defaultableOptions.filter(
    (instrument) => instrument.expiration_ts > now,
  );
  const source = upcoming.length ? upcoming : defaultableOptions;
  const expiries = Array.from(
    new Set(source.map((instrument) => instrument.expiration_ts)),
  ).sort((a, b) => a - b);
  if (!expiries.length) return;

  let chosenExpiry = expiries[0];
  let bestDiff = Math.abs(chosenExpiry - target);
  for (const expiryTs of expiries) {
    const diff = Math.abs(expiryTs - target);
    if (diff < bestDiff) {
      chosenExpiry = expiryTs;
      bestDiff = diff;
    }
  }

  const forExpiry = source.filter(
    (instrument) => instrument.expiration_ts === chosenExpiry,
  );
  const callStrikes = Array.from(
    new Set(
      forExpiry
        .filter((instrument) => instrument.option_type_normalized === "call")
        .map((instrument) => instrument.strike),
    ),
  ).sort((a, b) => a - b);
  const putStrikes = Array.from(
    new Set(
      forExpiry
        .filter((instrument) => instrument.option_type_normalized === "put")
        .map((instrument) => instrument.strike),
    ),
  ).sort((a, b) => a - b);
  const fallbackStrikes = Array.from(
    new Set(forExpiry.map((instrument) => instrument.strike)),
  ).sort((a, b) => a - b);

  const referenceSpot = spot.value;
  const callStrike = pickNearestStrike(
    callStrikes.length ? callStrikes : fallbackStrikes,
    referenceSpot,
  );
  const putStrike = pickNearestStrike(
    putStrikes.length ? putStrikes : fallbackStrikes,
    referenceSpot,
  );
  if (!Number.isFinite(callStrike) || !Number.isFinite(putStrike)) return;

  const expiryLabel = formatExpiryFromTs(chosenExpiry);
  positionLegs.value = [
    {
      id: newLegId(),
      kind: "option",
      side: "buy",
      qty: 1,
      optionType: "call",
      strike: callStrike,
      premium: 0,
      expiry: expiryLabel,
    },
    {
      id: newLegId(),
      kind: "option",
      side: "buy",
      qty: 1,
      optionType: "put",
      strike: putStrike,
      premium: 0,
      expiry: expiryLabel,
    },
  ];
};

const maxPointsPerFetch = computed(() => {
  const points = Math.floor(Number(ui.maxPoints));
  if (!Number.isFinite(points)) return DEFAULT_MAX_POINTS_PER_FETCH;
  return Math.max(MIN_POINTS_PER_FETCH, Math.min(MAX_POINTS_PER_FETCH, points));
});

const activeResolutionConfig = computed(
  () => RESOLUTION_CONFIG[ui.resolutionKey] || null,
);

const activeResolutionSeconds = computed(() => {
  const fromConfig = Number(activeResolutionConfig.value?.interval_seconds);
  if (Number.isFinite(fromConfig) && fromConfig > 0) return fromConfig;
  const fromKey = Number(ui.resolutionKey);
  if (Number.isFinite(fromKey) && fromKey > 0) return fromKey;
  return 900;
});

const activeResolutionLabel = computed(() => {
  const label = activeResolutionConfig.value?.label;
  if (label) return label;
  const seconds = activeResolutionSeconds.value;
  return Number.isFinite(seconds) && seconds > 0 ? `${seconds}s` : "n/a";
});

const getTimestampRange = () => {
  return {
    resolution: "1m",
    from: historyTo.value - HISTORY_WINDOW_UNIT_SECONDS * (maxPointsPerFetch.value - 1),
    to: historyTo.value,
  };
};

const toggleSettings = (target) => {
  settingsOpenTarget.value =
    settingsOpenTarget.value === target ? null : target;
};

const alignSettingsToBuilderMinusX = async () => {
  const chartBlockEl = chartBlockRef.value;
  if (!chartBlockEl) return;
  const chartRect = chartBlockEl.getBoundingClientRect();
  // Match the SVG's 1200-unit viewBox scale without reflowing the leg table.
  comboEditorScale.value = Math.min(1, Math.max(1, chartRect.width) / 1200);
  await nextTick();
  const editor = builderMainRef.value?.querySelector(".comboPositionBuilder");
  if (editor) comboEditorHeight.value = editor.getBoundingClientRect().height;
  const removeBtn = document.querySelector(".builderMain .remove-btn");
  if (!(removeBtn instanceof HTMLElement)) return;
  const removeRect = removeBtn.getBoundingClientRect();
  const centeredLeft =
    removeRect.left - chartRect.left + (removeRect.width - 22) / 2;
  if (!Number.isFinite(centeredLeft)) return;
  settingsLeftPx.value = Math.round(Math.max(0, Math.min(centeredLeft, chartRect.width - 22)));
};

const settingsWrapStyle = computed(() => {
  if (!Number.isFinite(settingsLeftPx.value)) return {};
  return {
    left: `${settingsLeftPx.value}px`,
    right: "auto",
  };
});

const handleDocumentPointerDown = (event) => {
  if (!settingsOpenTarget.value) return;
  const target = event?.target;
  if (!(target instanceof Node)) return;
  const activeMenuRef =
    settingsOpenTarget.value === "bottom"
      ? bottomSettingsMenuRef.value
      : topSettingsMenuRef.value;
  if (!activeMenuRef?.contains(target)) {
    settingsOpenTarget.value = null;
  }
};

const runWithConcurrency = async (items, limit, worker) => {
  const safeLimit = Math.max(1, Math.floor(limit));
  const queue = [...items];
  const workers = Array.from(
    { length: Math.min(safeLimit, queue.length) },
    async () => {
      while (queue.length) {
        const next = queue.shift();
        await worker(next);
      }
    },
  );
  await Promise.all(workers);
};

const normalizeTimestampSeconds = (value) => {
  const ts = Number(value);
  if (!Number.isFinite(ts)) return null;
  return ts > 1e12 ? Math.floor(ts / 1000) : Math.floor(ts);
};

const sortRowsByTs = (rows) =>
  (rows || [])
    .filter((row) => Number.isFinite(normalizeTimestampSeconds(row?.ts)))
    .slice()
    .sort(
      (a, b) =>
        normalizeTimestampSeconds(a?.ts) - normalizeTimestampSeconds(b?.ts),
    );

const loadInitialAnchoredIndexSnapshot = async () => {
  const indexName = underlying.value;
  try {
    const { resolution, from, to } = getTimestampRange();
    const rows = await loadMinuteIndex({
      index_name: indexName,
      resolution,
      from,
      to,
    });
    const sorted = sortRowsByTs(rows);
    if (!sorted.length) return;
    indexHistoryRows.value = sorted;
    const anchored = sorted[0];
    const price = Number(
      anchored?.index_price_close ?? anchored?.close ?? anchored?.price,
    );
    if (!Number.isFinite(price)) return;
    const ts = normalizeTimestampSeconds(anchored?.ts);
    indexByName.value = {
      [indexName]: {
        data: {
          ...anchored,
          index_price_close: price,
          ts: Number.isFinite(ts) ? ts : anchored.ts,
        },
        fetchedAt: Number.isFinite(ts) ? ts * 1000 : Date.now(),
      },
    };
  } catch {
    // Non-fatal: if snapshot fetch fails, seedDefaultLegs falls back to spot.
  }
};

const getAnchorRow = (rows, anchorTs) => {
  if (!rows?.length) return null;
  if (!Number.isFinite(anchorTs)) return rows[0] ?? null;
  const normalizedAnchorTs = normalizeTimestampSeconds(anchorTs);
  if (!Number.isFinite(normalizedAnchorTs)) return rows[0] ?? null;
  const firstAtOrAfter = rows.find(
    (row) => normalizeTimestampSeconds(row?.ts) >= normalizedAnchorTs,
  );
  return firstAtOrAfter ?? rows[rows.length - 1] ?? null;
};

const getLastRowAtOrBefore = (rows, anchorTs) => {
  const normalizedAnchorTs = normalizeTimestampSeconds(anchorTs);
  if (!rows?.length || !Number.isFinite(normalizedAnchorTs)) return null;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const rowTs = normalizeTimestampSeconds(rows[i]?.ts);
    if (Number.isFinite(rowTs) && rowTs <= normalizedAnchorTs) {
      return rows[i];
    }
  }
  return null;
};

const normalizeIv = (value) => {
  const iv = Number(value);
  if (!Number.isFinite(iv) || iv <= 0) return null;
  return iv > 3 ? iv / 100 : iv;
};

const resolveGreekEvolutionState = (anchorTs, label) => {
  const indexRow = getAnchorRow(indexHistoryRows.value, anchorTs);
  const indexPrice = Number(
    indexRow?.index_price_close ?? indexRow?.close ?? indexRow?.price,
  );
  const ts = normalizeTimestampSeconds(indexRow?.ts ?? anchorTs);
  if (!Number.isFinite(indexPrice) || !Number.isFinite(ts)) return null;

  const selected = selectedLegInstruments.value;
  const legs = selected
    .map((leg) => {
      const markRow = getAnchorRow(
        markHistoryByInstrument.value[leg.instrumentName] || [],
        ts,
      );
      const iv = normalizeIv(
        markRow?.iv_close ??
          markRow?.iv ??
          markRow?.mark_iv ??
          markRow?.implied_volatility,
      );
      if (!Number.isFinite(iv)) return null;
      return {
        signedQty: Number(leg.signedQty),
        strike: Number(leg.strike),
        expirationTs: Number(leg.expirationTs),
        optionType: leg.optionType,
        iv,
      };
    })
    .filter(Boolean);

  if (!legs.length || legs.length !== selected.length) return null;
  const hedgeRow = hedgePolicy.value.enabled
    ? getLastRowAtOrBefore(minuteComboSeries.value, ts)
    : null;
  const hedgeRatio = Number(hedgeRow?.hedge_ratio);
  return {
    label,
    ts,
    indexPrice,
    legs,
    hedgeRatio: Number.isFinite(hedgeRatio) ? hedgeRatio : 0,
  };
};

const greekEvolutionData = computed(() => {
  const history = indexHistoryRows.value || [];
  if (!history.length || !selectedLegInstruments.value.length) return [];

  const explicitRange = Array.isArray(chartRangeTs.value)
    ? chartRangeTs.value.map(normalizeTimestampSeconds)
    : [];
  const firstTs = normalizeTimestampSeconds(history[0]?.ts);
  const lastTs = normalizeTimestampSeconds(history[history.length - 1]?.ts);
  const startTs = Number.isFinite(explicitRange[0])
    ? explicitRange[0]
    : firstTs;
  const endTs = Number.isFinite(explicitRange[1]) ? explicitRange[1] : lastTs;
  const states = [
    resolveGreekEvolutionState(startTs, "Start"),
    resolveGreekEvolutionState(endTs, "End"),
  ].filter(Boolean);
  if (states.length !== 2) return [];

  const domainReferences = [
    ...states.map((state) => state.indexPrice),
    ...selectedLegInstruments.value.map((leg) => Number(leg.strike)),
  ].filter((value) => Number.isFinite(value) && value > 0);
  if (!domainReferences.length) return [];

  const minReference = Math.min(...domainReferences);
  const maxReference = Math.max(...domainReferences);
  const minPrice = Math.max(1, minReference * 0.65);
  const maxPrice = maxReference * 1.35;
  const scenarioPrices = Array.from(
    { length: GREEK_EVOLUTION_POINT_COUNT },
    (_unused, index) =>
      minPrice +
      ((maxPrice - minPrice) * index) /
        Math.max(1, GREEK_EVOLUTION_POINT_COUNT - 1),
  );
  scenarioPrices.push(...states.map((state) => state.indexPrice));
  const uniquePrices = Array.from(
    new Set(scenarioPrices.map((price) => Number(price.toFixed(8)))),
  ).sort((a, b) => a - b);

  return states.map((state) => {
    const points = uniquePrices.map((price) => {
      const totals = {
        delta: state.hedgeRatio,
        gamma: 0,
        theta: 0,
        vega: 0,
      };
      for (const leg of state.legs) {
        const tteSeconds = leg.expirationTs - state.ts;
        if (!Number.isFinite(tteSeconds) || tteSeconds <= 0) continue;
        const greeks = calcGreeks(
          price,
          leg.strike,
          tteSeconds,
          leg.iv,
          leg.optionType,
        );
        for (const key of Object.keys(totals)) {
          const value = Number(greeks?.[key]);
          if (Number.isFinite(value)) {
            totals[key] += leg.signedQty * value;
          }
        }
      }
      return { price, ...totals };
    });

    return {
      label: state.label,
      ts: state.ts,
      indexPrice: state.indexPrice,
      points,
    };
  });
});

const resolveEffectiveAnchorTs = () => {
  const explicitAnchor = normalizeTimestampSeconds(chartAnchorTs.value);
  if (Number.isFinite(explicitAnchor)) return explicitAnchor;
  const firstIndexTs = normalizeTimestampSeconds(
    indexHistoryRows.value?.[0]?.ts,
  );
  return Number.isFinite(firstIndexTs) ? firstIndexTs : null;
};

const rebuildBuilderSnapshots = () => {
  const nextTickerByInstrument = {};
  const effectiveAnchorTs = resolveEffectiveAnchorTs();

  for (const instrumentName of selectedInstrumentNames.value) {
    const rows = markHistoryByInstrument.value[instrumentName] || [];
    const row = getAnchorRow(rows, effectiveAnchorTs);
    if (!row) continue;
    const ts = normalizeTimestampSeconds(row?.ts);
    const markClose = Number(
      row?.mark_price_close ?? row?.close ?? row?.mark_price,
    );
    const ivClose = Number(
      row?.iv_close ?? row?.iv ?? row?.mark_iv ?? row?.implied_volatility,
    );
    const data = { ...row };
    if (Number.isFinite(ts)) data.ts = ts;
    if (Number.isFinite(markClose)) data.mark_price_close = markClose;
    if (Number.isFinite(ivClose)) data.iv_close = ivClose;
    nextTickerByInstrument[instrumentName] = {
      data,
      fetchedAt: Number.isFinite(ts) ? ts * 1000 : Date.now(),
    };
  }
  tickerByInstrument.value = nextTickerByInstrument;

  const indexName = activeIndexName.value;
  if (!indexName) {
    indexByName.value = {};
    return;
  }
  const indexRow = getAnchorRow(indexHistoryRows.value, effectiveAnchorTs);
  const indexClose = Number(
    indexRow?.index_price_close ?? indexRow?.close ?? indexRow?.price,
  );
  const indexTs = normalizeTimestampSeconds(indexRow?.ts);
  if (indexRow && Number.isFinite(indexClose)) {
    indexByName.value = {
      [indexName]: {
        data: {
          ...indexRow,
          index_price_close: indexClose,
          ts: Number.isFinite(indexTs) ? indexTs : indexRow?.ts,
        },
        fetchedAt: Number.isFinite(indexTs) ? indexTs * 1000 : Date.now(),
      },
    };
  } else {
    indexByName.value = {};
  }
};

const rebuildChartSeries = () => {
  indexSeries.value = tradeChartResolution(minuteIndexSeries.value, activeResolutionSeconds.value, chartRangeTs.value);
  comboSeries.value = tradeChartResolution(minuteComboSeries.value, activeResolutionSeconds.value, chartRangeTs.value);
};
const clearChartSeries = () => {
  minuteIndexSeries.value = [];
  minuteComboSeries.value = [];
  comboBaseSeries.value = [];
  rebuildChartSeries();
};
const rebuildDisplayedComboSeries = () => {
  try {
    minuteComboSeries.value = hedgePolicy.value.enabled
      ? applyDeltaHedge(comboBaseSeries.value, hedgePolicy.value, HEDGE_OBSERVATION_SECONDS, chartRangeTs.value)
      : [...comboBaseSeries.value];
    rebuildChartSeries();
    hedgeError.value = "";
  } catch (error) { hedgeError.value = error.message; }
};

const loadSeries = async () => {
  const requestId = ++loadRequestId;

  if (hasUnsupportedLegs.value) {
    clearChartSeries();
    ui.error = "Only option legs are supported in Option Strike.";
    indexSeries.value = [];
    comboBaseSeries.value = [];
    comboSeries.value = [];
    indexHistoryRows.value = [];
    markHistoryByInstrument.value = {};
    tickerByInstrument.value = {};
    indexByName.value = {};
    return;
  }

  const selected = selectedLegInstruments.value;
  if (!selected.length) {
    clearChartSeries();
    ui.error = "";
    indexSeries.value = [];
    comboBaseSeries.value = [];
    comboSeries.value = [];
    indexHistoryRows.value = [];
    markHistoryByInstrument.value = {};
    tickerByInstrument.value = {};
    indexByName.value = {};
    return;
  }

  const { resolution, from, to } = getTimestampRange();
  ui.loading = true;
  ui.error = "";

  try {
    const indexRows = await loadMinuteIndex({
      index_name: activeIndexName.value,
      resolution,
      from,
      to,
    }, () => requestId === loadRequestId);

    const markByInstrument = {};
    await runWithConcurrency(
      selectedInstrumentNames.value,
      MARK_CONCURRENCY,
      async (instrumentName) => {
        markByInstrument[instrumentName] =
          (await loadMinuteMarks({
            instrument_name: instrumentName,
            resolution,
            from,
            to,
          }, () => requestId === loadRequestId)) || [];
      },
    );

    if (requestId !== loadRequestId) return;

    indexHistoryRows.value = sortRowsByTs(indexRows);
    const sortedMarkByInstrument = {};
    for (const [instrumentName, rows] of Object.entries(markByInstrument)) {
      sortedMarkByInstrument[instrumentName] = sortRowsByTs(rows);
    }
    markHistoryByInstrument.value = sortedMarkByInstrument;
    rebuildBuilderSnapshots();

    const indexByTs = new Map(
      (indexRows || [])
        .map((row) => [Number(row?.ts), row])
        .filter(([ts, row]) => Number.isFinite(ts) && row),
    );

    const legSeries = selected
      .map((entry) => {
        const map = new Map();
        for (const row of markByInstrument[entry.instrumentName] || []) {
          const ts = Number(row?.ts);
          const markClose = row?.mark_price_close == null ? NaN : Number(row.mark_price_close);
          const ivClose = row?.iv_close == null ? NaN : Number(row.iv_close);
          if (!Number.isFinite(ts) || !Number.isFinite(markClose)) continue;
          map.set(ts, {
            markClose,
            ivClose: Number.isFinite(ivClose) ? ivClose : null,
          });
        }

        const greeksPnlSeries = computeGreeksPnlSeries({
          mark: markByInstrument[entry.instrumentName] || [],
          index: indexRows || [],
          instrument: {
            strike_price: Number(entry.strike),
            expiration_timestamp: Number(entry.expirationTs),
            option_type: entry.optionType,
          },
        });
        const greeksPnlByTs = new Map();
        for (const point of greeksPnlSeries) {
          const ts = Number(point?.ts);
          if (!Number.isFinite(ts)) continue;
          greeksPnlByTs.set(ts, point);
        }

        return {
          signedQty: entry.signedQty,
          label: entry.label,
          optionType: entry.optionType,
          strike: entry.strike,
          expirationTs: entry.expirationTs,
          byTs: map,
          greeksPnlByTs,
        };
      })
      .filter((entry) => entry.byTs.size > 0);

    if (legSeries.length !== selected.length) {
      clearChartSeries();
      indexSeries.value = [];
      comboBaseSeries.value = [];
      comboSeries.value = [];
      ui.error = "Missing mark history for one or more selected legs.";
      rebuildBuilderSnapshots();
      return;
    }

    const baseTs = Array.from(legSeries[0].byTs.keys()).sort((a, b) => a - b);
    const top = [];
    const bottom = [];

    for (const ts of baseTs) {
      if (!legSeries.every((entry) => entry.byTs.has(ts))) continue;
      const indexRow = indexByTs.get(ts);
      const indexClose = indexRow?.index_price_close == null ? NaN : Number(indexRow.index_price_close);
      if (!Number.isFinite(indexClose) || indexClose <= 0) continue;

      let totalMark = 0;
      let ivSum = 0;
      let ivCount = 0;
      let totalPL = 0;
      let totalDeltaPL = 0;
      let totalGammaThetaPL = 0;
      let totalVegaPL = 0;
      let totalVannaPL = 0;
      let totalCharmPL = 0;
      let totalVommaPL = 0;
      let totalResidualPL = 0;
      let totalCombinedDelta = 0;
      let totalCombinedGamma = 0;
      let hasPL = false;
      let hasDeltaPL = false;
      let hasGammaThetaPL = false;
      let hasVegaPL = false;
      let hasVannaPL = false;
      let hasCharmPL = false;
      let hasVommaPL = false;
      let hasResidualPL = false;
      let validDeltaLegs = 0;
      let hasCombinedGamma = false;
      for (const entry of legSeries) {
        const point = entry.byTs.get(ts);
        totalMark += entry.signedQty * Number(point.markClose);
        if (Number.isFinite(point.ivClose)) {
          ivSum += Number(point.ivClose);
          ivCount += 1;
        }

        const legPnlPoint = entry.greeksPnlByTs.get(ts);
        const signedQty = Number(entry.signedQty);
        if (Number.isFinite(legPnlPoint?.PL)) {
          totalPL += signedQty * Number(legPnlPoint.PL);
          hasPL = true;
        }
        if (Number.isFinite(legPnlPoint?.delta_PL)) {
          totalDeltaPL += signedQty * Number(legPnlPoint.delta_PL);
          hasDeltaPL = true;
        }
        if (Number.isFinite(legPnlPoint?.gamma_theta_PL)) {
          totalGammaThetaPL += signedQty * Number(legPnlPoint.gamma_theta_PL);
          hasGammaThetaPL = true;
        }
        if (Number.isFinite(legPnlPoint?.vega_PL)) {
          totalVegaPL += signedQty * Number(legPnlPoint.vega_PL);
          hasVegaPL = true;
        }
        if (Number.isFinite(legPnlPoint?.vanna_PL)) {
          totalVannaPL += signedQty * Number(legPnlPoint.vanna_PL);
          hasVannaPL = true;
        }
        if (Number.isFinite(legPnlPoint?.charm_PL)) {
          totalCharmPL += signedQty * Number(legPnlPoint.charm_PL);
          hasCharmPL = true;
        }
        if (Number.isFinite(legPnlPoint?.vomma_PL)) {
          totalVommaPL += signedQty * Number(legPnlPoint.vomma_PL);
          hasVommaPL = true;
        }
        if (Number.isFinite(legPnlPoint?.residual_PL)) {
          totalResidualPL += signedQty * Number(legPnlPoint.residual_PL);
          hasResidualPL = true;
        }
        const remaining = entry.expirationTs - ts - HEDGE_OBSERVATION_SECONDS;
        const closingRisk = remaining <= 0 ? { delta: 0, gamma: 0 }
          : Number.isFinite(point.ivClose) && point.ivClose > 0
            ? calcGreeks(indexClose, entry.strike, remaining, point.ivClose, entry.optionType)
            : { delta: null, gamma: null };
        if (Number.isFinite(closingRisk.delta)) {
          totalCombinedDelta += signedQty * closingRisk.delta;
          validDeltaLegs++;
        }
        if (Number.isFinite(closingRisk.gamma)) {
          totalCombinedGamma += signedQty * closingRisk.gamma;
          hasCombinedGamma = true;
        }
      }

      const date = new Date(ts * 1000);
      const ivClose = ivCount > 0 ? ivSum / ivCount : null;
      top.push({
        ts,
        date,
        index_price_open: Number(indexRow?.index_price_open),
        index_price_close: indexClose,
        iv_close: ivClose,
      });

      bottom.push({
        ts,
        date,
        index_price_open: Number(indexRow?.index_price_open),
        index_price_close: indexClose,
        mark_price_close: totalMark,
        iv_close: ivClose,
        PL: hasPL ? totalPL : null,
        delta_PL: hasDeltaPL ? totalDeltaPL : null,
        gamma_theta_PL: hasGammaThetaPL ? totalGammaThetaPL : null,
        vega_PL: hasVegaPL ? totalVegaPL : null,
        vanna_PL: hasVannaPL ? totalVannaPL : null,
        charm_PL: hasCharmPL ? totalCharmPL : null,
        vomma_PL: hasVommaPL ? totalVommaPL : null,
        residual_PL: hasResidualPL ? totalResidualPL : null,
        combined_delta: validDeltaLegs === legSeries.length ? totalCombinedDelta : null,
        combined_gamma: hasCombinedGamma ? totalCombinedGamma : null,
      });
    }

    minuteIndexSeries.value = top;
    comboBaseSeries.value = bottom;
    rebuildDisplayedComboSeries();

    if (!indexSeries.value.length || !comboSeries.value.length) {
      ui.error = "No overlapping index/mark history for selected legs.";
    }
    rebuildBuilderSnapshots();
  } catch (error) {
    if (requestId !== loadRequestId) return;
    clearChartSeries();
    ui.error = error instanceof Error ? error.message : String(error);
    indexSeries.value = [];
    comboBaseSeries.value = [];
    comboSeries.value = [];
    indexHistoryRows.value = [];
    markHistoryByInstrument.value = {};
    tickerByInstrument.value = {};
    indexByName.value = {};
  } finally {
    if (requestId === loadRequestId) {
      ui.loading = false;
    }
  }
};

const scheduleLoad = () => {
  if (loadTimer) clearTimeout(loadTimer);
  loadTimer = setTimeout(() => {
    loadTimer = null;
    loadSeries();
  }, LOAD_DEBOUNCE_MS);
};

watch(
  () => [maxPointsPerFetch.value, positionLegs.value],
  () => {
    scheduleLoad();
  },
  { deep: true },
);

watch(
  () => hedgePolicy.value,
  () => {
    rebuildDisplayedComboSeries();
  },
);
watch(activeResolutionSeconds, rebuildChartSeries);
watch(chartRangeTs, rebuildDisplayedComboSeries);

watch(
  () => [
    chartAnchorTs.value,
    selectedInstrumentNames.value,
    activeIndexName.value,
    indexHistoryRows.value,
    markHistoryByInstrument.value,
  ],
  () => {
    rebuildBuilderSnapshots();
  },
  { deep: true },
);

const switchUnderlying = async (next) => {
  if (next === underlying.value) return;
  if (!UNDERLYING_OPTIONS.some((opt) => opt.value === next)) return;
  underlying.value = next;
  clearChartSeries();
  positionLegs.value = [];
  chartRangeTs.value = null;
  indexHistoryRows.value = [];
  indexByName.value = {};
  markHistoryByInstrument.value = {};
  tickerByInstrument.value = {};
  indexSeries.value = [];
  comboBaseSeries.value = [];
  comboSeries.value = [];
  await loadInitialAnchoredIndexSnapshot();
  seedDefaultLegs();
  if (loadTimer) {
    clearTimeout(loadTimer);
    loadTimer = null;
  }
  await loadSeries();
  await nextTick();
  alignSettingsToBuilderMinusX();
};

onMounted(async () => {
  document.addEventListener("pointerdown", handleDocumentPointerDown);
  window.addEventListener("resize", alignSettingsToBuilderMinusX);
  chartResizeObserver = new ResizeObserver(alignSettingsToBuilderMinusX);
  if (chartBlockRef.value) chartResizeObserver.observe(chartBlockRef.value);
  if (builderMainRef.value?.firstElementChild) chartResizeObserver.observe(builderMainRef.value.firstElementChild);
  allInstruments.value = (await fetchAllInstruments()) || [];

  await loadInitialAnchoredIndexSnapshot();
  seedDefaultLegs();
  if (loadTimer) {
    clearTimeout(loadTimer);
    loadTimer = null;
  }
  await loadSeries();
  await nextTick();
  alignSettingsToBuilderMinusX();
});

onUnmounted(() => {
  if (loadTimer) clearTimeout(loadTimer);
  document.removeEventListener("pointerdown", handleDocumentPointerDown);
  window.removeEventListener("resize", alignSettingsToBuilderMinusX);
  chartResizeObserver?.disconnect();
});

watch(
  () => positionLegs.value,
  async () => {
    await nextTick();
    alignSettingsToBuilderMinusX();
  },
  { deep: true },
);
</script>

<template>
  <div class="settings-workspace combo-workspace">
  <div class="appRoot">
    <div class="underlyingRow">
      <div class="underlyingActions">
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
        <a v-if="thalexUrl" :href="thalexUrl" class="tradeThalexButton" target="_blank" rel="noopener">
          Trade on Thalex
        </a>
      </div>
      <button
        class="savePngButton"
        type="button"
        @click="handleSavePng"
        :disabled="ui.loading || !comboSeries.length"
      >
        Save PNG
      </button>
    </div>
    <div class="builderRow">
      <div ref="builderMainRef" class="builderMain" :style="{ '--combo-editor-scale': comboEditorScale, height: comboEditorHeight === null ? undefined : `${comboEditorHeight}px` }">
        <PositionBuilder
          class="comboPositionBuilder"
          title=""
          :legs="positionLegs"
          :spot="spot"
          :vol="DEFAULT_VOL"
          :T="DEFAULT_T"
          :instruments="instruments"
          :ticker-by-instrument="tickerByInstrument"
          :index-name="activeIndexName"
          :index-price="indexDisplay?.price ?? null"
          :index-fetched-at="indexDisplay?.fetchedAt ?? null"
          @update:legs="positionLegs = $event"
        />

      </div>
    </div>

    <div class="sharedHedgeSettings">
      <DeltaHedgeToggle :model-value="hedgePolicy.enabled" @update:model-value="hedgePolicy = { ...hedgePolicy, enabled: $event }" />
      <SettingsSidePanel target="#combo-settings-dock" title="Hedge settings">
      <DeltaHedgeControls v-model="hedgePolicy" :asset="underlying.slice(0, 3)" :observation-seconds="HEDGE_OBSERVATION_SECONDS" />
      <section v-if="hedgePolicy.enabled && hedgeSummary" class="hedge-run-summary" aria-label="Selected trade hedge results">
        <dl class="hedge-pnl-breakdown">
          <div><dt>Option P&amp;L</dt><dd>{{ pnlMoney(hedgeSummary.optionPnl) }}</dd></div>
          <div><dt>Hedge P&amp;L · after execution costs</dt><dd>{{ pnlMoney(hedgeSummary.hedgePnl) }}</dd></div>
          <div class="hedge-pnl-total"><dt>Total P&amp;L</dt><dd>{{ pnlMoney(hedgeSummary.totalPnl) }}</dd></div>
        </dl>
        <p>Hedge trading P&amp;L before costs: {{ pnlMoney(hedgeSummary.grossHedgePnl) }}.
          Modeled execution costs: {{ costMoney(hedgeSummary.executionCosts) }}. Exchange trading fees are not separately itemized.</p>
        <p>{{ hedgeSummary.triggers.period }} hedges triggered by period · {{ hedgeSummary.triggers.tolerance }} by tolerance.
          Entry: {{ hedgeSummary.triggers.entry }} · Exit: {{ hedgeSummary.triggers.exit }}<template v-if="hedgeSummary.triggers.other"> · Other: {{ hedgeSummary.triggers.other }}</template> · {{ hedgeSummary.fills }} fills in total.</p>
        <p>For the selected trade window. Total P&amp;L = option P&amp;L + hedge P&amp;L after execution costs.
          Option P&amp;L is mark-to-mark; option execution costs, funding and basis are excluded.
          Chart {{ activeResolutionLabel }}; hedging stays on the one-minute replay.</p>
      </section>
      <p v-if="hedgePolicy.enabled && hedgeHistoryGaps" class="hedge-run-summary" role="status">
        {{ hedgeHistoryGaps }} gaps or missing risk observations. The threshold timer restarts after each gap; missing prices or risk are not interpolated.
      </p>
      </SettingsSidePanel>
    </div>
    <p v-if="hedgeError" class="error" role="alert">{{ hedgeError }}</p>


    <div class="statusRow" v-if="ui.loading || ui.error">
      <span v-if="ui.loading">Loading mark history...</span>
      <span v-else class="error">{{ ui.error }}</span>
    </div>

    <div class="chartBlock" ref="chartBlockRef">
      <div
        class="settingsWrap settingsWrap--chart"
        ref="topSettingsMenuRef"
        :style="settingsWrapStyle"
      >
        <button
          class="settingsButton settingsButton--icon"
          type="button"
          title="Settings"
          aria-label="Settings"
          aria-haspopup="true"
          :aria-expanded="settingsOpenTarget === 'top' ? 'true' : 'false'"
          @click="toggleSettings('top')"
        ></button>
        <div v-if="settingsOpenTarget === 'top'" class="settingsDropdown">
          <div class="settingsHint">
            History window · {{ ((maxPointsPerFetch - 1) * HISTORY_WINDOW_UNIT_SECONDS / 86400).toFixed(1) }} days
          </div>
          <input
            v-model.number="ui.maxPoints"
            class="settingsSlider"
            type="range"
            :min="MIN_POINTS_PER_FETCH"
            :max="MAX_POINTS_PER_FETCH"
            step="10"
          />
          <div class="settingsRange">
            <span>{{ MIN_POINTS_PER_FETCH }}</span>
            <span>{{ MAX_POINTS_PER_FETCH }}</span>
          </div>
        </div>
      </div>
      <div
        v-if="chartLowerMode !== 'greekEvolution'"
        class="settingsWrap settingsWrap--chart-lower"
        ref="bottomSettingsMenuRef"
        :style="settingsWrapStyle"
      >
        <button
          class="settingsButton settingsButton--icon"
          type="button"
          title="Settings"
          aria-label="Settings"
          aria-haspopup="true"
          :aria-expanded="settingsOpenTarget === 'bottom' ? 'true' : 'false'"
          @click="toggleSettings('bottom')"
        ></button>
        <div v-if="settingsOpenTarget === 'bottom'" class="settingsDropdown">
          <div class="settingsToggleRow">
            <span class="settingsToggleLabel">Show higher-order greeks</span>
            <button
              type="button"
              class="settingsToggleButton"
              :class="{ settingsToggleButtonActive: ui.showHigherOrderGreeks }"
              @click="ui.showHigherOrderGreeks = !ui.showHigherOrderGreeks"
            >
              {{ ui.showHigherOrderGreeks ? "On" : "Off" }}
            </button>
          </div>
        </div>
      </div>

      <IndexMarkComboChart
        ref="chartRef"
        :index-data="indexSeries"
        :observation-data="minuteIndexSeries"
        :time-range-ts="chartRangeTs"
        :combo-data="comboSeries"
        :hedge-trades="hedgeTrades"
        :delta-hedge-enabled="hedgePolicy.enabled"
        :option-instrument-name="activeIndexName"
        :subtitle="chartSubtitle"
        :loading="ui.loading"
        :resolution-key="ui.resolutionKey"
        :resolution-options="RESOLUTION_OPTIONS"
        :show-higher-order-greeks="ui.showHigherOrderGreeks"
        :greek-evolution-data="greekEvolutionData"
        @update:resolution-key="ui.resolutionKey = $event"
        @update:time-anchor-ts="chartAnchorTs = $event"
        @update:time-range-ts="chartRangeTs = $event"
        @update:lower-mode="chartLowerMode = $event"
      />
    </div>
  </div>
  <div id="combo-settings-dock" class="settings-dock"></div>
  </div>
</template>

<style scoped>
.combo-workspace { --settings-panel-width: 50vw; }
.hedge-run-summary { color: #aaa; font-size: 11px; line-height: 1.6; margin-top: 20px; }
.hedge-run-summary p { margin: 10px 0 0; }
.hedge-pnl-breakdown { margin: 0; color: #ddd; }
.hedge-pnl-breakdown > div { display: flex; justify-content: space-between; gap: 16px; padding: 5px 0; }
.hedge-pnl-breakdown dd { margin: 0; white-space: nowrap; font-variant-numeric: tabular-nums; }
.hedge-pnl-total { border-top: 1px solid #353539; margin-top: 4px; color: #fff; }
.sharedHedgeSettings { display: flex; align-items: center; gap: 4px; margin: 12px 28px; font-size: 12px; }
.appRoot {
  container-type: inline-size;
  container-name: combo-workspace;
  --selector-section-width: 100%;
  max-width: 1320px;
  margin: 0 auto;
  padding: 28px 40px 40px;
  color: #e8e8ea;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  gap: 0;
}

.underlyingRow {
  --top-control-height: 31px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  width: calc(var(--selector-section-width) - 8px);
  margin-left: 8px;
  margin-bottom: 12px;
}

.underlyingActions {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.underlyingToggle {
  box-sizing: border-box;
  height: var(--top-control-height);
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.05);
}

.underlyingButton {
  box-sizing: border-box;
  height: calc(var(--top-control-height) - 4px);
  border: none;
  background: transparent;
  color: rgba(226, 232, 240, 0.55);
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
  letter-spacing: 0.02em;
  padding: 0 14px;
  border-radius: 999px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.underlyingButton:hover:not(:disabled):not(.underlyingButtonActive) {
  color: #fff;
  background: rgba(255, 255, 255, 0.08);
}

.underlyingButtonActive {
  background: rgba(255, 255, 255, 0.14);
  color: #fff;
}

.underlyingButton:disabled {
  cursor: default;
  opacity: 0.5;
}

.settingsWrap {
  position: relative;
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

.settingsButton--icon {
  width: 22px;
  height: 22px;
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
  font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
}

.settingsWrap--chart {
  position: absolute;
  top: 5px;
  right: 40px;
  z-index: 25;
}

.settingsWrap--chart-lower {
  position: absolute;
  top: calc(47% + 8px);
  right: 40px;
  z-index: 25;
}

.tradeThalexButton {
  box-sizing: border-box;
  height: var(--top-control-height);
  padding: 0 16px;
  border: 1px solid #3d3d42;
  border-radius: 999px;
  background: #050506;
  color: #f0f1f4;
  font-size: 11px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
  text-decoration: none;
  white-space: nowrap;
}

.savePngButton {
  box-sizing: border-box;
  flex: 0 0 auto;
  height: var(--top-control-height);
  padding: 0 16px;
  border-radius: 999px;
  border: 1px solid #3d3d42;
  background: #11141a;
  color: #f0f1f4;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  box-shadow: none;
}

.savePngButton:hover:not(:disabled) {
  background: #1c2029;
  border-color: #596171;
  color: #fff;
}

.savePngButton:disabled {
  cursor: default;
  opacity: 0.45;
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
  letter-spacing: 0;
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

.settingsToggleRow {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.settingsToggleLabel {
  color: #a9abb6;
  font-size: 10px;
  font-weight: 600;
}

.settingsToggleButton {
  min-width: 44px;
  height: 20px;
  border-radius: 999px;
  border: 1px solid #2a2f3b;
  background: #12161e;
  color: #a9abb6;
  font-size: 10px;
  font-weight: 600;
  cursor: pointer;
}

.settingsToggleButtonActive {
  border-color: #2f855a;
  background: #163125;
  color: #8ad5a1;
}

.builderRow {
  display: flex;
  align-items: flex-start;
  gap: 16px;
}

.builderMain {
  flex: 1 1 auto;
  width: 100%;
  min-width: 0;
}

.builderMain > .comboPositionBuilder {
  padding-bottom: 0;
  width: calc(100% / var(--combo-editor-scale, 1));
  transform: scale(var(--combo-editor-scale, 1));
  transform-origin: top left;
}

.builderMain :deep(.builder-heading) {
  box-sizing: border-box;
  padding-left: calc(8px / var(--combo-editor-scale, 1));
}

.hedgeControls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 16px;
  margin: 0;
  padding: 20px 12px;
}

.deltaHedgeButton {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  height: 28px;
  padding: 0;
  margin: 0;
  line-height: 1;
  border-radius: 999px;
  border: none;
  background: transparent;
  color: rgba(226, 232, 240, 0.7);
  font-size: 10px;
  cursor: pointer;
  box-shadow: none;
}

.deltaHedgeButton:hover {
  color: #fff;
}

.deltaHedgeButtonActive {
  color: #8ad5a1;
}

.hedgeFrequencyControl {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  height: 28px;
  margin: 0;
  line-height: 1;
  gap: 6px;
  min-width: 150px;
  color: rgba(226, 232, 240, 0.72);
  font-size: 10px;
  font-weight: 600;
}

.hedgeFrequencyControlDisabled {
  opacity: 0.45;
}

.hedgeFrequencyLabel,
.hedgeFrequencyValue {
  flex: 0 0 auto;
  font-variant-numeric: tabular-nums;
}

.hedgeFrequencyValue {
  min-width: 20px;
  color: #8ad5a1;
}

.hedgeFrequencySlider {
  -webkit-appearance: none;
  appearance: none;
  flex: 1 1 auto;
  min-width: 64px;
  height: 14px;
  display: block;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
}

.hedgeFrequencySlider:disabled {
  cursor: default;
}

.hedgeFrequencySlider:focus {
  outline: none;
}

.hedgeFrequencySlider::-webkit-slider-runnable-track {
  height: 2px;
  background: rgba(245, 245, 245, 0.42);
  border-radius: 999px;
}

.hedgeFrequencySlider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 8px;
  height: 8px;
  margin-top: -3px;
  border-radius: 50%;
  border: none;
  background: #f5f5f7;
}

.hedgeFrequencySlider::-moz-range-track {
  height: 2px;
  background: rgba(245, 245, 245, 0.42);
  border-radius: 999px;
}

.hedgeFrequencySlider::-moz-range-thumb {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  border: none;
  background: #f5f5f7;
}



.chartBlock {
  margin-top: 0;
  width: calc(var(--selector-section-width) - 8px);
  margin-left: 8px;
  display: flex;
  flex-direction: column;
  gap: 0;
  position: relative;
}

.statusRow {
  min-height: 20px;
  color: #9ea5bc;
  font-size: 14px;
}

.error {
  color: #ff8282;
}

@media (min-width: 1200px) {
  .appRoot {
    --selector-section-width: 95.5%;
  }
}

@media (max-width: 900px) {
  .appRoot {
    padding: 18px 14px 20px;
  }
}

@container combo-workspace (max-width: 900px) {
  .settingsWrap--chart {
    right: 12px;
  }

  .settingsWrap--chart-lower {
    right: 12px;
  }

  .builderRow {
    flex-direction: column;
    gap: 10px;
  }

  .builderMain :deep(.builder-heading) {
    padding-left: 0;
  }

  .underlyingRow {
    width: 100%;
    margin-left: 0;
  }

  .chartBlock {
    width: 100%;
    margin-left: 0;
  }
}
</style>
