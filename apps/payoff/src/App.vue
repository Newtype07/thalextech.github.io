<script setup>
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import PositionBuilder from "../../simulator/src/components/PositionBuilder.vue";
import Greeks from "./components/Greeks.vue";
import PayoffChart from "./components/PayoffChart.vue";
import { buildPayoff } from "./payoff.js";
import { fetchPayoffQuotes } from "./payoff-market.js";
import { requestThalex } from "../../../lib/thalex-rest.js";
import { buildScenarioSpotGrid } from "./scenario-range.js";
import {
  calcGreeks,
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
const CHART_OPTIONS = [
  { value: "payoff", label: "Payoff" },
  { value: "delta", label: "Delta", symbol: "\u03b4" },
  { value: "gamma", label: "Gamma", symbol: "\u0393" },
  { value: "theta", label: "Theta", symbol: "\u0398" },
  { value: "vega", label: "Vega", symbol: "\u03c3" },
  { value: "vanna", label: "Vanna", symbol: "va" },
  { value: "charm", label: "Charm", symbol: "ch" },
  { value: "volga", label: "Volga", symbol: "vo" },
];

const LEG_COLOR_PALETTE = [
  "#22d3ee",
  "#f43f5e",
  "#60a5fa",
  "#f59e0b",
  "#34d399",
  "#e879f9",
  "#fb7185",
  "#a3e635",
];

const DEFAULT_VOL = 0.4;
const DEFAULT_T = 30 / 365.25;
const DEFAULT_MAX_POINTS_PER_FETCH = 360;
const MIN_POINTS_PER_FETCH = 120;
const MAX_POINTS_PER_FETCH = 1000;
const MARK_CONCURRENCY = 10;
const LOAD_DEBOUNCE_MS = 140;
const SCENARIO_POINT_COUNT = 91;
const SCENARIO_RANGE_STANDARD_DEVIATIONS = 3;
const CHARM_FD_STEP_SECONDS = 24 * 60 * 60;
const LEG_VOL_MULTIPLIERS = [0.6, 0.7, 0.8, 0.9, 1.1, 1.2, 1.3, 1.4];
const LEG_VOL_LINE_OPACITY = 0.28;
const TOTAL_VOL_LINE_OPACITY = 0.28;

const UNDERLYING_OPTIONS = [
  { value: "BTCUSD", label: "BTC" },
  { value: "ETHUSD", label: "ETH" },
];

const FALLBACK_SPOT_BY_UNDERLYING = {
  BTCUSD: 95_000,
  ETHUSD: 3_000,
};

const ui = reactive({
  chart: "payoff",
  resolutionKey: "900",
  maxPoints: DEFAULT_MAX_POINTS_PER_FETCH,
  timeProgress: 0,
  loading: false,
  error: "",
});

const isPayoff = computed(() => ui.chart === "payoff");

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
const indexHistoryRows = ref([]);
const markHistoryByInstrument = ref({});
const simulationRows = ref([]);
const simulationAnchorTs = ref(null);
const simulationAnchorSpot = ref(null);
const chartRef = ref(null);
const payoffChartRef = ref(null);
const payoffQuotes = ref({});
let payoffController = null;
const payoffState = computed(() => {
  try {
    const active = selectedOptionLegs.value.filter((leg) => clampQty(leg.qty) > 0);
    if (hasUnsupportedLegs.value) return { error: "Only option legs are supported." };
    if (active.length !== selectedLegInstruments.value.length) return { error: "Select a listed instrument for every active leg." };
    const legs = selectedLegInstruments.value.map((leg) => {
      const quote = payoffQuotes.value[leg.instrumentName];
      if (!quote) throw new Error(`Current quote unavailable for ${leg.instrumentName}.`);
      return {
        optionType: leg.optionType, strike: leg.strike,
        signedQty: leg.signedQty, expirationTs: leg.expirationTs,
        premium: quote.premium, forward: quote.forward, iv: quote.iv,
      };
    });
    return { data: buildPayoff(legs) };
  } catch (error) {
    return { error: error.message };
  }
});
const payoff = computed(() => payoffState.value.data ?? null);
const formatPrice = (value) => new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", maximumFractionDigits: 0,
}).format(value);
const breakEvenText = computed(() => {
  if (!payoff.value) return "—";
  const { points, ranges } = payoff.value.breakEvens;
  return [
    ...points.map(formatPrice),
    ...ranges.map((r) => r.to === Infinity ? `${formatPrice(r.from)} and above` : `${formatPrice(r.from)} – ${formatPrice(r.to)}`),
  ].join(" / ") || (payoff.value.mixedMaturities ? "None in shown range" : "None");
});

const isBootstrapping = ref(true);
let loadRequestId = 0;
let loadTimer = null;
const knownLegIds = new Set();

const newLegId = () => {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ?? `leg_${Math.random().toString(36).slice(2, 10)}`;
};

const normalizeTimestampSeconds = (value) => {
  const ts = Number(value);
  if (!Number.isFinite(ts)) return null;
  return ts > 1e12 ? Math.floor(ts / 1000) : Math.floor(ts);
};

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

const pickNearestStrike = (strikes, reference) => {
  if (!strikes.length) return Math.round(reference / 1000) * 1000;
  const sorted = strikes.slice().sort((a, b) => a - b);
  let best = sorted[0];
  let bestDistance = Math.abs(best - reference);
  for (let i = 1; i < sorted.length; i += 1) {
    const strike = sorted[i];
    const distance = Math.abs(strike - reference);
    if (
      distance < bestDistance ||
      (distance === bestDistance && strike < best)
    ) {
      best = strike;
      bestDistance = distance;
    }
  }
  return best;
};

const formatExpiryFromTs = (ts) => {
  const date = new Date(Number(ts) * 1000);
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = date.toLocaleString("en-US", {
    month: "short",
    timeZone: "UTC",
  });
  const year = String(date.getUTCFullYear()).slice(-2);
  return `${day} ${month} ${year}`;
};

const normalizeIv = (value) => {
  const iv = Number(value);
  if (!Number.isFinite(iv) || iv <= 0) return null;
  return iv > 3 ? iv / 100 : iv;
};

const computeScenarioGreeks = (spot, strike, tteSeconds, iv, optionType) => {
  const base = calcGreeks(spot, strike, tteSeconds, iv, optionType);
  const volga = Number.isFinite(base?.vomma) ? Number(base.vomma) : null;

  let charm = null;
  const tauSeconds = Number(tteSeconds);
  if (
    Number.isFinite(base?.delta) &&
    Number.isFinite(tauSeconds) &&
    tauSeconds > 0
  ) {
    const shiftedTte = Math.max(60, tauSeconds - CHARM_FD_STEP_SECONDS);
    if (shiftedTte < tauSeconds) {
      const shifted = calcGreeks(spot, strike, shiftedTte, iv, optionType);
      if (Number.isFinite(shifted?.delta)) {
        const daysElapsed = (tauSeconds - shiftedTte) / (24 * 60 * 60);
        if (daysElapsed > 0) {
          charm = (Number(shifted.delta) - Number(base.delta)) / daysElapsed;
        }
      }
    } else {
      charm = 0;
    }
  }

  return {
    ...base,
    charm,
    volga,
  };
};

const extractMarkIv = (row) =>
  normalizeIv(
    row?.iv_close ?? row?.iv ?? row?.mark_iv ?? row?.implied_volatility,
  );

const extractMarkTs = (row) => normalizeTimestampSeconds(row?.ts);

const extractIndexClose = (row) => {
  const close = Number(
    row?.index_price_close ?? row?.close ?? row?.price ?? row?.index,
  );
  return Number.isFinite(close) ? close : null;
};

const extractIndexTs = (row) => normalizeTimestampSeconds(row?.ts);

const sortRowsByTs = (rows) =>
  (rows || [])
    .filter((row) => Number.isFinite(normalizeTimestampSeconds(row?.ts)))
    .slice()
    .sort(
      (a, b) =>
        normalizeTimestampSeconds(a?.ts) - normalizeTimestampSeconds(b?.ts),
    );

const findLastRow = (rows) =>
  Array.isArray(rows) && rows.length ? rows[rows.length - 1] : null;

const findLastAtOrBefore = (rows, anchorTs) => {
  const normalizedAnchor = normalizeTimestampSeconds(anchorTs);
  if (!Number.isFinite(normalizedAnchor)) return findLastRow(rows);
  if (!Array.isArray(rows) || !rows.length) return null;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const ts = normalizeTimestampSeconds(rows[i]?.ts);
    if (Number.isFinite(ts) && ts <= normalizedAnchor) return rows[i];
  }
  return rows[0] ?? null;
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

const normalizeOptionInstrument = (instrument) => {
  if (!instrument || typeof instrument !== "object") return null;
  const strike = Number(instrument.strike_price);
  const expiration = normalizeTimestampSeconds(instrument.expiration_timestamp);
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
        instrument.option_type_normalized === optionType &&
        instrument.strike === strike &&
        Math.abs(instrument.expiration_ts - expiryTs) <= 12 * 60 * 60,
    ) || null
  );
};

const selectedLegInstruments = computed(() => {
  const result = [];
  let paletteIndex = 0;
  for (const leg of selectedOptionLegs.value) {
    const instrument = resolveInstrumentForLeg(leg);
    if (!instrument?.instrument_name) continue;
    const qty = clampQty(leg.qty);
    if (!qty) continue;
    const side = String(leg.side || "buy").toLowerCase();
    const isSell = side === "sell";
    const sideSign = isSell ? -1 : 1;
    result.push({
      legId: leg.id,
      legLabel: `${isSell ? "Sell" : "Buy"} ${qty} ${instrument.instrument_name}`,
      color: LEG_COLOR_PALETTE[paletteIndex % LEG_COLOR_PALETTE.length],
      instrumentName: instrument.instrument_name,
      signedQty: sideSign * qty,
      optionType: instrument.option_type_normalized,
      strike: Number(instrument.strike),
      expirationTs: Number(instrument.expiration_ts),
      expiryLabel: formatExpiryFromTs(instrument.expiration_ts),
      underlying: instrument.underlying,
    });
    paletteIndex += 1;
  }
  return result;
});

const strikeOptionsForLeg = (leg) => {
  const expiryTs = parseExpiryToSeconds(leg?.expiry);
  const optionType = String(leg?.optionType || "").toLowerCase();
  if (!Number.isFinite(expiryTs)) return [];
  if (optionType !== "call" && optionType !== "put") return [];
  return Array.from(
    new Set(
      parsedOptionInstruments.value
        .filter(
          (instrument) =>
            instrument.option_type_normalized === optionType &&
            Math.abs(instrument.expiration_ts - expiryTs) <= 12 * 60 * 60,
        )
        .map((instrument) => Number(instrument.strike))
        .filter(Number.isFinite),
    ),
  ).sort((a, b) => a - b);
};

const selectedInstrumentNames = computed(() =>
  Array.from(
    new Set(selectedLegInstruments.value.map((entry) => entry.instrumentName)),
  ),
);

const activeIndexName = computed(() => underlying.value);

const indexDisplay = computed(() => {
  const snapshot = indexByName.value[activeIndexName.value];
  if (!snapshot) return null;
  const price = extractIndexClose(snapshot.data);
  if (!Number.isFinite(price)) return null;
  return {
    price,
    fetchedAt: snapshot.fetchedAt,
  };
});

const spot = computed(() => {
  const live = Number(indexDisplay.value?.price);
  if (Number.isFinite(live) && live > 0) return live;
  return FALLBACK_SPOT_BY_UNDERLYING[underlying.value] ?? 95_000;
});

const getFetchedReferenceSpot = () => {
  const fromIndex = Number(indexDisplay.value?.price);
  if (Number.isFinite(fromIndex) && fromIndex > 0) return fromIndex;
  const fromAnchor = Number(simulationAnchorSpot.value);
  if (Number.isFinite(fromAnchor) && fromAnchor > 0) return fromAnchor;
  return null;
};

const maxPointsPerFetch = computed(() => {
  const points = Math.floor(Number(ui.maxPoints));
  if (!Number.isFinite(points)) return DEFAULT_MAX_POINTS_PER_FETCH;
  return Math.max(MIN_POINTS_PER_FETCH, Math.min(MAX_POINTS_PER_FETCH, points));
});

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
    from: to - safeSeconds * (maxPointsPerFetch.value - 1),
    to,
  };
};

const loadInitialIndexSnapshot = async () => {
  const indexName = underlying.value;
  const result = await requestThalex("index", { underlying: indexName });
  const price = Number(result.price);
  if (!Number.isFinite(price) || price <= 0) throw new Error("Current index is unavailable.");
  indexByName.value = {
    [indexName]: { data: { index_price_close: price }, fetchedAt: Date.now() },
  };
};

const seedDefaultLegs = () => {
  if (selectedOptionLegs.value.length) return;
  const options = parsedOptionInstruments.value;
  if (!options.length) return;

  const now = Math.floor(Date.now() / 1000);
  const target = now + 30 * 24 * 60 * 60;
  const upcoming = options.filter(
    (instrument) => instrument.expiration_ts > now,
  );
  const source = upcoming.length ? upcoming : options;
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

  const referenceSpot = getFetchedReferenceSpot() ?? spot.value;
  const callStrike = pickNearestStrike(
    callStrikes.length ? callStrikes : fallbackStrikes,
    referenceSpot,
  );
  const putStrike = pickNearestStrike(
    putStrikes.length ? putStrikes : fallbackStrikes,
    referenceSpot,
  );
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

const rebuildBuilderSnapshots = (anchorTs = null) => {
  const nextTickerByInstrument = {};
  for (const instrumentName of selectedInstrumentNames.value) {
    const rows = markHistoryByInstrument.value[instrumentName] || [];
    const row = findLastAtOrBefore(rows, anchorTs) || findLastRow(rows);
    if (!row) continue;
    const ts = extractMarkTs(row);
    nextTickerByInstrument[instrumentName] = {
      data: {
        ...row,
        ts: Number.isFinite(ts) ? ts : row.ts,
      },
      fetchedAt: Number.isFinite(ts) ? ts * 1000 : Date.now(),
    };
  }
  tickerByInstrument.value = nextTickerByInstrument;

  const indexName = activeIndexName.value;
  if (!indexName) {
    indexByName.value = {};
    return;
  }
  const indexRow =
    findLastAtOrBefore(indexHistoryRows.value, anchorTs) ||
    findLastRow(indexHistoryRows.value);
  const indexClose = extractIndexClose(indexRow);
  const indexTs = extractIndexTs(indexRow);
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

const buildSimulationRows = (selected, indexRows, markByInstrument) => {
  if (!selected.length || !indexRows.length) {
    return {
      rows: [],
      anchorTs: null,
      anchorSpot: null,
    };
  }

  const sortedIndexRows = sortRowsByTs(indexRows);
  const latestIndexRow = findLastRow(sortedIndexRows);
  const latestIndexTs = extractIndexTs(latestIndexRow);
  const latestSpot = extractIndexClose(latestIndexRow);
  if (!Number.isFinite(latestIndexTs) || !Number.isFinite(latestSpot)) {
    return {
      rows: [],
      anchorTs: null,
      anchorSpot: null,
    };
  }

  let anchorTs = latestIndexTs;
  for (const leg of selected) {
    const markRows = sortRowsByTs(markByInstrument[leg.instrumentName] || []);
    const latestMarkRow = findLastRow(markRows);
    const latestMarkTs = extractMarkTs(latestMarkRow);
    if (!Number.isFinite(latestMarkTs)) {
      throw new Error(`Missing mark history for ${leg.instrumentName}.`);
    }
    anchorTs = Math.min(anchorTs, latestMarkTs);
  }

  const anchorIndexRow =
    findLastAtOrBefore(sortedIndexRows, anchorTs) || latestIndexRow;
  const anchorSpotRaw = extractIndexClose(anchorIndexRow);
  const anchorSpot =
    Number.isFinite(anchorSpotRaw) && anchorSpotRaw > 0
      ? anchorSpotRaw
      : latestSpot;
  const fastForwardRatio = Math.max(
    0,
    Math.min(1, Number(ui.timeProgress) / 100),
  );
  const scenarios = buildScenarioSpotGrid({
    spot: anchorSpot,
    anchorTs,
    expirationTimestamps: selected.map((leg) => leg.expirationTs),
    pointCount: SCENARIO_POINT_COUNT,
    annualizedVol: DEFAULT_VOL,
    standardDeviations: SCENARIO_RANGE_STANDARD_DEVIATIONS,
    remainingTimeFraction: 1 - fastForwardRatio,
  }).map((scenario) => {
    const scenarioSpot = Number(scenario.scenarioSpot);
    const scenarioM =
      Number.isFinite(anchorSpot) && anchorSpot > 0
        ? scenarioSpot / anchorSpot
        : null;
    return {
      ...scenario,
      scenarioSpot,
      scenarioM,
      scenarioShiftPct:
        Number.isFinite(anchorSpot) && anchorSpot > 0
          ? (scenarioSpot / anchorSpot - 1) * 100
          : null,
    };
  });

  const absQtySum = selected.reduce(
    (sum, leg) => sum + Math.abs(Number(leg.signedQty) || 0),
    0,
  );
  const weightedStrikeSum = selected.reduce(
    (sum, leg) =>
      sum + Math.abs(Number(leg.signedQty) || 0) * Number(leg.strike),
    0,
  );
  const comboReferenceStrike =
    absQtySum > 0 && Number.isFinite(weightedStrikeSum)
      ? weightedStrikeSum / absQtySum
      : anchorSpot;

  const totals = scenarios.map((scenario) => ({
    ...scenario,
    delta: 0,
    gamma: 0,
    theta: 0,
    vega: 0,
    vanna: 0,
    charm: 0,
    volga: 0,
  }));
  const totalVolOverlaysByMultiplier = new Map(
    LEG_VOL_MULTIPLIERS.map((multiplier) => [
      multiplier,
      scenarios.map((scenario) => ({
        ...scenario,
        delta: 0,
        gamma: 0,
        theta: 0,
        vega: 0,
        vanna: 0,
        charm: 0,
        volga: 0,
      })),
    ]),
  );

  const rows = [];
  for (const leg of selected) {
    const markRows = sortRowsByTs(markByInstrument[leg.instrumentName] || []);
    const anchorMarkRow =
      findLastAtOrBefore(markRows, anchorTs) || findLastRow(markRows);
    if (!anchorMarkRow) {
      throw new Error(
        `No mark snapshot for ${leg.instrumentName} at anchor time.`,
      );
    }

    let iv = extractMarkIv(anchorMarkRow);
    if (!Number.isFinite(iv)) {
      let ivSum = 0;
      let ivCount = 0;
      for (const row of markRows) {
        const nextIv = extractMarkIv(row);
        if (!Number.isFinite(nextIv)) continue;
        ivSum += nextIv;
        ivCount += 1;
      }
      iv = ivCount ? ivSum / ivCount : DEFAULT_VOL;
    }

    const markTs = extractMarkTs(anchorMarkRow);
    const referenceTs = Number.isFinite(markTs) ? markTs : anchorTs;
    const fullTteSeconds = Math.max(60, Number(leg.expirationTs) - referenceTs);
    const tteSeconds = Math.max(60, fullTteSeconds * (1 - fastForwardRatio));
    for (let i = 0; i < scenarios.length; i += 1) {
      const scenario = scenarios[i];
      const scenarioSpot = Number(scenario.scenarioSpot);
      if (!Number.isFinite(scenarioSpot) || scenarioSpot <= 0) continue;
      const scenarioShiftPct =
        Number.isFinite(anchorSpot) && anchorSpot > 0
          ? (scenarioSpot / anchorSpot - 1) * 100
          : null;
      const greeks = computeScenarioGreeks(
        scenarioSpot,
        leg.strike,
        tteSeconds,
        iv,
        leg.optionType,
      );
      if (!Number.isFinite(greeks?.delta)) continue;

      const signedDelta = Number(leg.signedQty) * Number(greeks.delta);
      const signedGamma = Number(leg.signedQty) * Number(greeks.gamma);
      const signedTheta = Number(leg.signedQty) * Number(greeks.theta);
      const signedVega = Number(leg.signedQty) * Number(greeks.vega);
      const signedVanna = Number(leg.signedQty) * Number(greeks.vanna);
      const signedCharm = Number(leg.signedQty) * Number(greeks.charm);
      const signedVolga = Number(leg.signedQty) * Number(greeks.volga);

      rows.push({
        leg_id: leg.legId,
        leg_label: leg.legLabel,
        leg_color: leg.color,
        line_opacity: 0.9,
        is_total: false,
        instrument_name: leg.instrumentName,
        option_type: leg.optionType,
        signed_qty: leg.signedQty,
        strike: leg.strike,
        expiry_date: leg.expiryLabel,
        tte: tteSeconds,
        iv_close: iv,
        ts: referenceTs,
        anchor_ts: anchorTs,
        anchor_spot: anchorSpot,
        index_price_close: scenarioSpot,
        scenario_shift_pct: scenarioShiftPct,
        m: scenario.scenarioM,
        delta: signedDelta,
        gamma: signedGamma,
        theta: signedTheta,
        vega: signedVega,
        vanna: signedVanna,
        charm: signedCharm,
        volga: signedVolga,
      });
      totals[i].delta += Number.isFinite(signedDelta) ? signedDelta : 0;
      totals[i].gamma += Number.isFinite(signedGamma) ? signedGamma : 0;
      totals[i].theta += Number.isFinite(signedTheta) ? signedTheta : 0;
      totals[i].vega += Number.isFinite(signedVega) ? signedVega : 0;
      totals[i].vanna += Number.isFinite(signedVanna) ? signedVanna : 0;
      totals[i].charm += Number.isFinite(signedCharm) ? signedCharm : 0;
      totals[i].volga += Number.isFinite(signedVolga) ? signedVolga : 0;

      for (const ivMultiplier of LEG_VOL_MULTIPLIERS) {
        const ivScenario = Math.max(1e-6, Number(iv) * ivMultiplier);
        const greeksAtScenarioIv = computeScenarioGreeks(
          scenarioSpot,
          leg.strike,
          tteSeconds,
          ivScenario,
          leg.optionType,
        );
        if (!Number.isFinite(greeksAtScenarioIv?.delta)) continue;

        rows.push({
          leg_id: `${leg.legId}-iv-${ivMultiplier.toFixed(2)}`,
          leg_label: leg.legLabel,
          leg_color: leg.color,
          line_opacity: LEG_VOL_LINE_OPACITY,
          line_width: 1.2,
          legend_hidden: true,
          is_total: false,
          instrument_name: leg.instrumentName,
          option_type: leg.optionType,
          signed_qty: leg.signedQty,
          strike: leg.strike,
          expiry_date: leg.expiryLabel,
          tte: tteSeconds,
          iv_close: ivScenario,
          ts: referenceTs,
          anchor_ts: anchorTs,
          anchor_spot: anchorSpot,
          index_price_close: scenarioSpot,
          scenario_shift_pct: scenarioShiftPct,
          m: scenario.scenarioM,
          delta: Number(leg.signedQty) * Number(greeksAtScenarioIv.delta),
          gamma: Number(leg.signedQty) * Number(greeksAtScenarioIv.gamma),
          theta: Number(leg.signedQty) * Number(greeksAtScenarioIv.theta),
          vega: Number(leg.signedQty) * Number(greeksAtScenarioIv.vega),
          vanna: Number(leg.signedQty) * Number(greeksAtScenarioIv.vanna),
          charm: Number(leg.signedQty) * Number(greeksAtScenarioIv.charm),
          volga: Number(leg.signedQty) * Number(greeksAtScenarioIv.volga),
        });

        const totalOverlay = totalVolOverlaysByMultiplier.get(ivMultiplier);
        if (totalOverlay) {
          totalOverlay[i].delta +=
            Number(leg.signedQty) * Number(greeksAtScenarioIv.delta);
          totalOverlay[i].gamma +=
            Number(leg.signedQty) * Number(greeksAtScenarioIv.gamma);
          totalOverlay[i].theta +=
            Number(leg.signedQty) * Number(greeksAtScenarioIv.theta);
          totalOverlay[i].vega +=
            Number(leg.signedQty) * Number(greeksAtScenarioIv.vega);
          totalOverlay[i].vanna +=
            Number(leg.signedQty) * Number(greeksAtScenarioIv.vanna);
          totalOverlay[i].charm +=
            Number(leg.signedQty) * Number(greeksAtScenarioIv.charm);
          totalOverlay[i].volga +=
            Number(leg.signedQty) * Number(greeksAtScenarioIv.volga);
        }
      }
    }
  }

  for (const total of totals) {
    rows.push({
      leg_id: "combo-total",
      leg_label: "Combo",
      leg_color: "#f8fafc",
      is_total: true,
      instrument_name: "COMBO",
      option_type: "mix",
      signed_qty: 1,
      strike: comboReferenceStrike,
      expiry_date: "Mixed",
      tte: null,
      iv_close: null,
      ts: anchorTs,
      anchor_ts: anchorTs,
      anchor_spot: anchorSpot,
      index_price_close: total.scenarioSpot,
      scenario_shift_pct: total.scenarioShiftPct,
      m: total.scenarioM,
      delta: total.delta,
      gamma: total.gamma,
      theta: total.theta,
      vega: total.vega,
      vanna: total.vanna,
      charm: total.charm,
      volga: total.volga,
    });
  }
  for (const ivMultiplier of LEG_VOL_MULTIPLIERS) {
    const totalOverlay = totalVolOverlaysByMultiplier.get(ivMultiplier) || [];
    for (const total of totalOverlay) {
      rows.push({
        leg_id: `combo-total-iv-${ivMultiplier.toFixed(2)}`,
        leg_label: "Combo",
        leg_color: "#f8fafc",
        line_opacity: TOTAL_VOL_LINE_OPACITY,
        line_width: 1.2,
        legend_hidden: true,
        is_total: true,
        instrument_name: "COMBO",
        option_type: "mix",
        signed_qty: 1,
        strike: comboReferenceStrike,
        expiry_date: "Mixed",
        tte: null,
        iv_close: null,
        ts: anchorTs,
        anchor_ts: anchorTs,
        anchor_spot: anchorSpot,
        index_price_close: total.scenarioSpot,
        scenario_shift_pct: total.scenarioShiftPct,
        m: total.scenarioM,
        delta: total.delta,
        gamma: total.gamma,
        theta: total.theta,
        vega: total.vega,
        vanna: total.vanna,
        charm: total.charm,
        volga: total.volga,
      });
    }
  }

  return {
    rows,
    anchorTs,
    anchorSpot,
  };
};

const resetSeriesState = () => {
  simulationRows.value = [];
  indexHistoryRows.value = [];
  markHistoryByInstrument.value = {};
  simulationAnchorTs.value = null;
  simulationAnchorSpot.value = null;
  tickerByInstrument.value = {};
  indexByName.value = {};
};

const recomputeSimulationFromCache = () => {
  const selected = selectedLegInstruments.value;
  if (!selected.length || !indexHistoryRows.value.length) {
    simulationRows.value = [];
    simulationAnchorTs.value = null;
    simulationAnchorSpot.value = null;
    return;
  }
  try {
    const { rows, anchorTs, anchorSpot } = buildSimulationRows(
      selected,
      indexHistoryRows.value,
      markHistoryByInstrument.value,
    );
    simulationRows.value = rows;
    simulationAnchorTs.value = anchorTs;
    simulationAnchorSpot.value = anchorSpot;
    rebuildBuilderSnapshots(anchorTs);
    if (!rows.length) {
      ui.error = "No simulation data available for the selected legs.";
    }
  } catch (error) {
    ui.error = error instanceof Error ? error.message : String(error);
    simulationRows.value = [];
    simulationAnchorTs.value = null;
    simulationAnchorSpot.value = null;
  }
};

const loadPayoff = async () => {
  const requestId = ++loadRequestId;
  payoffController?.abort();
  payoffController = new AbortController();
  payoffQuotes.value = {};
  tickerByInstrument.value = {};
  ui.error = "";
  if (hasUnsupportedLegs.value || !selectedInstrumentNames.value.length) {
    ui.loading = false;
    return;
  }
  ui.loading = true;
  const names = [...selectedInstrumentNames.value];
  const indexName = activeIndexName.value;
  try {
    const quotes = await fetchPayoffQuotes(names, payoffController.signal);
    if (requestId !== loadRequestId) return;
    payoffQuotes.value = quotes;
    tickerByInstrument.value = Object.fromEntries(Object.entries(quotes).map(([name, q]) => [name, {
      data: { mark_price: q.premium, iv: q.iv, ts: q.timestamp }, fetchedAt: q.timestamp * 1000,
    }]));
    const quote = quotes[names[0]];
    if (quote) indexByName.value = {
      [indexName]: { data: { index_price_close: quote.spot }, fetchedAt: quote.timestamp * 1000 },
    };
  } catch (error) {
    if (requestId === loadRequestId) ui.error = error.message;
  } finally {
    if (requestId === loadRequestId) ui.loading = false;
  }
};

const loadSeries = async () => {
  if (isPayoff.value) return loadPayoff();
  payoffController?.abort();
  const requestId = ++loadRequestId;

  if (hasUnsupportedLegs.value) {
    ui.error = "Only option legs are supported.";
    ui.loading = false;
    resetSeriesState();
    return;
  }

  const selected = selectedLegInstruments.value;
  if (!selected.length) {
    ui.error = "";
    ui.loading = false;
    resetSeriesState();
    return;
  }

  const { resolution, from, to } = getTimestampRange();
  ui.loading = true;
  ui.error = "";

  try {
    const indexRows = await fetchIndexHistory({
      index_name: activeIndexName.value,
      resolution,
      from,
      to,
    });

    const markByInstrument = {};
    await runWithConcurrency(
      selectedInstrumentNames.value,
      MARK_CONCURRENCY,
      async (instrumentName) => {
        markByInstrument[instrumentName] =
          (await fetchMarkHistory({
            instrument_name: instrumentName,
            resolution,
            from,
            to,
          })) || [];
      },
    );

    if (requestId !== loadRequestId) return;

    const sortedIndexRows = sortRowsByTs(indexRows);
    const sortedMarkByInstrument = {};
    for (const [instrumentName, rows] of Object.entries(markByInstrument)) {
      sortedMarkByInstrument[instrumentName] = sortRowsByTs(rows);
    }

    indexHistoryRows.value = sortedIndexRows;
    markHistoryByInstrument.value = sortedMarkByInstrument;
    recomputeSimulationFromCache();
  } catch (error) {
    if (requestId !== loadRequestId) return;
    ui.error = error instanceof Error ? error.message : String(error);
    resetSeriesState();
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

const headerTitle = "Payoff";
const timeSliderStyle = computed(() => {
  const progress = Math.max(0, Math.min(1, Number(ui.timeProgress) / 100));
  const tone = Math.round(244 - progress * 184);
  const borderAlpha = Math.max(0.18, 0.68 - progress * 0.5).toFixed(3);
  return {
    "--thumb-rgb": `${tone}, ${tone}, ${Math.min(255, tone + 6)}`,
    "--thumb-border-alpha": borderAlpha,
  };
});

const chartLoading = computed(
  () => ui.loading && simulationRows.value.length === 0,
);

const handleSavePng = () => {
  if (isPayoff.value) payoffChartRef.value?.exportPng();
  else chartRef.value?.exportPng({ filename: `payoff-${ui.chart}.png` });
};

watch(
  () => [isPayoff.value, ui.resolutionKey, maxPointsPerFetch.value, positionLegs.value],
  () => {
    if (isBootstrapping.value) return;
    scheduleLoad();
  },
  { deep: true },
);

watch(
  () => ui.timeProgress,
  () => {
    if (isBootstrapping.value) return;
    if (ui.loading || isPayoff.value) return;
    recomputeSimulationFromCache();
  },
);

watch(
  () => positionLegs.value,
  (legs) => {
    if (!Array.isArray(legs)) return;
    const activeIds = new Set(
      legs.map((leg) => leg?.id).filter((id) => typeof id === "string"),
    );
    for (const id of Array.from(knownLegIds)) {
      if (!activeIds.has(id)) knownLegIds.delete(id);
    }

    let mutated = false;
    const nextLegs = legs.map((leg) => {
      const legId = leg?.id;
      if (typeof legId !== "string" || knownLegIds.has(legId)) return leg;

      if (leg?.kind !== "option") return leg;
      const strikes = strikeOptionsForLeg(leg);
      if (!strikes.length) return leg;
      const reference = getFetchedReferenceSpot();
      if (!Number.isFinite(reference) || reference <= 0) return leg;
      const currentStrike = Number(leg.strike);
      const preferredStrike = pickNearestStrike(strikes, reference);
      if (!Number.isFinite(preferredStrike)) return leg;
      knownLegIds.add(legId);

      if (preferredStrike !== currentStrike) {
        mutated = true;
        return { ...leg, strike: preferredStrike };
      }

      return leg;
    });

    if (mutated) {
      positionLegs.value = nextLegs;
    }
  },
  { deep: true },
);

watch(
  () => [
    selectedInstrumentNames.value,
    activeIndexName.value,
    indexHistoryRows.value,
    markHistoryByInstrument.value,
    simulationAnchorTs.value,
  ],
  () => {
    if (!isPayoff.value) rebuildBuilderSnapshots(simulationAnchorTs.value);
  },
  { deep: true },
);

const switchUnderlying = async (next) => {
  if (next === underlying.value) return;
  if (!UNDERLYING_OPTIONS.some((opt) => opt.value === next)) return;
  ++loadRequestId;
  payoffController?.abort();
  payoffQuotes.value = {};
  underlying.value = next;
  positionLegs.value = [];
  indexByName.value = {};
  indexHistoryRows.value = [];
  markHistoryByInstrument.value = {};
  tickerByInstrument.value = {};
  simulationRows.value = [];
  simulationAnchorTs.value = null;
  simulationAnchorSpot.value = null;
  isBootstrapping.value = true;
  try {
    await loadInitialIndexSnapshot();
    seedDefaultLegs();
    if (loadTimer) {
      clearTimeout(loadTimer);
      loadTimer = null;
    }
    await loadSeries();
  } catch (error) {
    ui.error = error instanceof Error ? error.message : String(error);
  } finally {
    isBootstrapping.value = false;
  }
};

onMounted(async () => {
  try {
    allInstruments.value = (await fetchAllInstruments()) || [];

    await loadInitialIndexSnapshot();
    seedDefaultLegs();
    await loadSeries();
  } catch (error) {
    ui.error = error instanceof Error ? error.message : String(error);
  } finally {
    isBootstrapping.value = false;
  }
});

onUnmounted(() => {
  ++loadRequestId;
  payoffController?.abort();
  if (loadTimer) clearTimeout(loadTimer);
});
</script>

<template>
  <div class="appRoot">
    <header class="header">
      <div class="titleRow">
        <h1>{{ headerTitle }}</h1>
      </div>

      <div v-if="ui.error || (isPayoff && !ui.loading && payoffState.error)" class="error" role="alert">
        {{ ui.error || payoffState.error }}
      </div>
    </header>

    <main class="workspaceShell">
      <div class="underlyingRow">
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
      </div>
      <div class="builderRow">
        <div class="builderMain">
          <PositionBuilder
            :legs="positionLegs"
            :spot="spot"
            :vol="DEFAULT_VOL"
            :T="DEFAULT_T"
            :show-tte="true"
            :instruments="instruments"
            :ticker-by-instrument="tickerByInstrument"
            :index-name="activeIndexName"
            :index-price="indexDisplay?.price ?? null"
            :index-fetched-at="indexDisplay?.fetchedAt ?? null"
            @update:legs="positionLegs = $event"
          />
        </div>
      </div>
      <div class="chartShell">
        <div class="chartControlRow">
          <div class="greekBarRow">
            <div class="greekSymbolGrid" role="group" aria-label="Payoff and Greeks">
              <button v-for="option in CHART_OPTIONS" :key="option.value" type="button" class="greekSymbolButton" :class="{ active: ui.chart === option.value }" :aria-pressed="ui.chart === option.value" :aria-label="option.label" :title="option.label" @click="ui.chart = option.value">
                <svg v-if="option.value === 'payoff'" class="payoffSymbol" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7 L11 17 L21 5" /></svg>
                <template v-else>{{ option.symbol }}</template>
              </button>
            </div>
          </div>
          <div v-if="!isPayoff" class="timeSliderBar">
            <span class="timeSliderLabel">T</span>
            <input v-model.number="ui.timeProgress" class="timeSliderInput" :style="timeSliderStyle" type="range" min="0" max="100" step="1" aria-label="Fast forward time to expiry" />
          </div>
          <div class="viewActions">
            <button type="button" class="saveButton" :disabled="ui.loading" @click="loadSeries">Refresh</button>
            <button type="button" class="saveButton" :disabled="ui.loading || (isPayoff ? !payoff : !simulationRows.length)" @click="handleSavePng">Save PNG</button>
          </div>
        </div>
        <div v-if="isPayoff" class="payoffSummary" aria-live="polite">
          <div><span>{{ payoff?.mixedMaturities ? 'Max Loss · shown range' : 'Max Loss' }}</span><strong class="lossValue">{{ payoff ? (payoff.maxLoss === Infinity ? '∞' : formatPrice(payoff.maxLoss)) : '—' }}</strong></div>
          <div><span>{{ payoff?.mixedMaturities ? 'Estimated break-evens · shown range' : 'Break-even prices' }}</span><strong>{{ breakEvenText }}</strong></div>
          <div><span>{{ payoff?.mixedMaturities ? 'Max Return · shown range' : 'Max Return' }}</span><strong class="returnValue">{{ payoff ? (payoff.maxReturn === Infinity ? '∞' : formatPrice(payoff.maxReturn)) : '—' }}</strong></div>
        </div>
        <PayoffChart v-if="isPayoff" ref="payoffChartRef" :payoff="payoff" :asset="underlying === 'ETHUSD' ? 'ETH' : 'BTC'" :loading="ui.loading" />
        <Greeks
          v-if="!isPayoff"
          ref="chartRef"
          :data="simulationRows"
          title=""
          subtitle=""
          :loading="chartLoading"
          :greek="ui.chart"
        />
      </div>
    </main>
  </div>
</template>

<style scoped>
.viewActions { display: flex; align-items: center; gap: 8px; grid-column: 3; justify-self: end; }
.payoffSummary { display: grid; grid-template-columns: 1fr 1.5fr 1fr; gap: 16px; padding: 12px 12.2% 14px 5%; background: #000; }
.payoffSummary div { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.payoffSummary div:nth-child(2) { text-align: center; }
.payoffSummary div:last-child { text-align: right; }
.payoffSummary span { font-size: 10px; color: #999; }
.payoffSummary strong { font-size: 13px; font-weight: 500; color: #fff; overflow-wrap: anywhere; }
.payoffSummary .lossValue { color: #ff1654; }
.payoffSummary .returnValue { color: #00bf8c; }
button:disabled { opacity: 0.5; cursor: default; }
@media (max-width: 650px) { .payoffSummary { grid-template-columns: 1fr 1.5fr 1fr; padding: 12px 0; gap: 8px; }.payoffSummary strong { font-size: 12px; }.payoffSummary span { font-size: 9px; } }

.appRoot {
  max-width: 1320px;
  margin: 0 auto;
  padding: 28px 40px 40px;
  color: #e8e8ea;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.header {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.workspaceShell {
  --chart-left-inset: 1%;
  --chart-right-inset: 11%;
  width: 100%;
  max-width: 1160px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.underlyingRow {
  display: flex;
  justify-content: flex-start;
}

.underlyingToggle {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.05);
}

.underlyingButton {
  border: none;
  background: transparent;
  color: rgba(226, 232, 240, 0.55);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  padding: 4px 14px;
  border-radius: 999px;
  cursor: pointer;
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

.titleRow {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
}

h1 {
  margin: 0;
  width: 100%;
  text-align: center;
  font-size: 20px;
  font-weight: 600;
}

.greekSymbolGrid {
  display: inline-grid;
  grid-auto-flow: column;
  gap: 8px;
}

.greekSymbolButton {
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: #0f1318;
  color: #f8fafc;
  font-size: 10px;
  line-height: 1;
  width: 44px;
  height: 40px;
  border-radius: 12px;
  cursor: pointer;
}

.greekSymbolButton.active {
  color: #fff;
  background: #202329;
  border-color: rgba(255, 255, 255, 0.4);
  font-weight: 600;
}
.greekSymbolButton:focus-visible { outline: 1px solid #999; outline-offset: 2px; }
.payoffSymbol { display: block; width: 17px; height: 17px; margin: auto; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }

.saveButton {
  height: 40px;
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: #0f1318;
  color: #f8fafc;
  font-size: 10px;
  font-weight: 600;
  box-shadow: none;
}

.saveButton:hover {
  background: #141b24;
}

.builderRow {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  width: 100%;
  padding-left: var(--chart-left-inset);
  padding-right: var(--chart-right-inset);
  box-sizing: border-box;
}

.builderMain {
  flex: 1 1 auto;
  min-width: 0;
  width: 100%;
}

.builderMain :deep(.legs-section) {
  --layout-gap: 8px;
  --leg-row-gap-total: 32px;
  --leg-greeks-gap-total: 44px;
  --strike-greeks-gap: 10px;
}

.builderMain :deep(.index-summary) {
  font-size: 10px;
}

.builderMain :deep(.index-label) {
  font-size: 10px;
}

.builderMain :deep(.index-value) {
  font-size: 10px;
}

.builderMain :deep(.index-time) {
  font-size: 10px;
}

.builderMain :deep(.leg-greek-header) {
  font-size: 10px;
}

.builderMain :deep(.leg-greek-value) {
  font-size: 10px;
}

.builderMain :deep(.leg-greeks) {
  font-size: 10px;
}

.builderMain :deep(.total-greeks) {
  font-size: 10px;
}

.chartShell {
  margin-top: 6px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
}

.chartControlRow {
  display: grid;
  grid-template-columns: auto minmax(120px, 1fr) auto;
  align-items: center;
  column-gap: 16px;
  width: 100%;
  padding-left: var(--chart-left-inset);
  padding-right: var(--chart-right-inset);
  box-sizing: border-box;
}

.timeSliderBar {
  grid-column: 2;
  width: 100%;
  max-width: 520px;
  justify-self: center;
  height: 40px;
  padding: 0 12px;
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: #0f1318;
  display: flex;
  align-items: center;
  gap: 10px;
}

.timeSliderLabel {
  color: #d4d7e2;
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
  flex: 0 0 auto;
}

.timeSliderInput {
  -webkit-appearance: none;
  appearance: none;
  flex: 1 1 auto;
  width: auto;
  height: 20px;
  margin: 0;
  background: transparent;
  cursor: pointer;
}

.timeSliderInput:focus {
  outline: none;
}

.timeSliderInput::-webkit-slider-runnable-track {
  height: 8px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.18);
}

.timeSliderInput::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 8px;
  height: 8px;
  margin-top: 0;
  border-radius: 50%;
  border: 1px solid rgba(210, 220, 238, var(--thumb-border-alpha, 0.68));
  background: rgb(var(--thumb-rgb, 248, 248, 252));
  box-shadow: none;
}

.timeSliderInput::-moz-range-track {
  height: 8px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.18);
}

.timeSliderInput::-moz-range-thumb {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  border: 1px solid rgba(210, 220, 238, var(--thumb-border-alpha, 0.68));
  background: rgb(var(--thumb-rgb, 248, 248, 252));
  box-shadow: none;
}

.greekBarRow {
  grid-column: 1;
  justify-self: start;
}

.savePngRow {
  grid-column: 3;
  justify-self: end;
}

.error {
  color: #ff8282;
  font-size: 14px;
}

@media (max-width: 900px) {
  .appRoot {
    padding: 18px 14px 20px;
    gap: 14px;
  }

  .titleRow {
    flex-direction: column;
    align-items: flex-start;
  }

  .builderRow {
    flex-direction: column;
    gap: 10px;
  }

  .greekBarRow {
    justify-self: start;
  }

  .savePngRow {
    justify-self: end;
  }

  .chartControlRow {
    grid-template-columns: minmax(0, 1fr) auto;
    column-gap: 10px;
    row-gap: 10px;
  }
  .greekBarRow { grid-column: 1 / -1; }
  .greekSymbolGrid { display: flex; flex-wrap: wrap; gap: 6px; }
  .viewActions { grid-column: 2; }
  .timeSliderBar { grid-column: 1; }

  .timeSliderBar {
    max-width: 300px;
    height: 40px;
    padding: 0 10px;
  }
}
</style>
