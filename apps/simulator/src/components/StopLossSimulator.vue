<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import CloudChart from "./CloudChart.vue";
import StyledSelectMenu from "./StyledSelectMenu.vue";
import type { AtmOptionExpiryQuote } from "../lib/atmOptionChain";
import {
  blackScholesGreeks,
  computeOptionOmega,
} from "../lib/blackScholes";
import type { GBMParams } from "../lib/gbm";
import type { PathModelParams } from "../lib/pathModel";
import type { PositionLeg } from "../lib/position";
import {
  closestExpirationTs,
  displayedDaysToExpiry,
  horizonOptionsForQuotes,
  maturityOptionsForQuotes,
  resolveHorizonSeconds,
  selectableExpiryQuotes,
} from "../lib/stopLossMaturity";
import type {
  HistogramBinHover,
  HistogramBinStats,
  SimulationStats,
} from "../lib/simulation";

const props = defineProps<{
  seed: number;
  params: GBMParams;
  pathModel: PathModelParams;
  valuationTs: number;
  samplePathLimit: number;
  colorMin: number;
  colorMax: number;
  histBinsMultiplier: number;
  expiryQuotes: AtmOptionExpiryQuote[];
}>();

const emit = defineEmits<{
  (event: "set-mu", value: number): void;
  (event: "set-vol", value: number): void;
  (event: "resimulate"): void;
}>();

const SECONDS_PER_DAY = 24 * 60 * 60;
const DAYS_PER_YEAR = 365.25;
const STOP_LOSS_STEP_SECONDS = 60 * 60;
const RV_MIN_PERCENT = 10;
const RV_MAX_PERCENT = 120;
const DRIFT_MIN_PERCENT = -500;
const DRIFT_MAX_PERCENT = 500;
const MATURITY_DAYS = [7, 14, 30, 60, 90, 180] as const;
const DEFAULT_MATURITY_DAYS = 60;
const EMPTY_OPTION_PRICING = Object.freeze({});
const OPTION_STRUCTURE_OPTIONS = [
  { label: "Call", value: "call" },
  { label: "Call spread", value: "call-spread" },
  { label: "Put", value: "put" },
  { label: "Put spread", value: "put-spread" },
];
type OptionStructure = "call" | "call-spread" | "put" | "put-spread";
const payoffDisplayMode = ref<"payoff" | "frequency">("payoff");
const payoffChartMode = ref<"terminal" | "cumulative">("terminal");
const optionStructure = ref<OptionStructure>("call");
const optionType = computed<"call" | "put">(() =>
  optionStructure.value.startsWith("put") ? "put" : "call",
);
const isSpread = computed(() => optionStructure.value.endsWith("spread"));
const longStrike = ref(0);
const shortStrike = ref(0);
const riskBudget = ref(10_000);
const leverage = ref(10);
const leverageDraft = ref(10);
const leverageOverridden = ref(false);
const targetVrpPoints = ref<number | null>(0);
const annualFundingPercent = ref(8);
const horizonDays = ref(14);
const selectedExpirationTs = ref(0);
const optionStats = ref<SimulationStats | null>(null);
const perpStats = ref<SimulationStats | null>(null);
const hoveredBinStats = ref<HistogramBinHover | null>(null);

type TableStats = Pick<
  SimulationStats,
  | "meanPayoff"
  | "p10Payoff"
  | "p25Payoff"
  | "p50Payoff"
  | "p75Payoff"
  | "p90Payoff"
  | "winRate"
  | "maxLossRate"
>;

const payoffPercentileRows = [
  { label: "10th percentile", key: "p10Payoff" },
  { label: "25th percentile", key: "p25Payoff" },
  { label: "50th percentile", key: "p50Payoff" },
  { label: "75th percentile", key: "p75Payoff" },
  { label: "90th percentile", key: "p90Payoff" },
] as const;

const binToTableStats = (
  bin: HistogramBinStats | null | undefined,
): TableStats | null => {
  if (!bin) return null;
  return {
    meanPayoff: bin.meanPayoff,
    p10Payoff: bin.p10Payoff,
    p25Payoff: bin.p25Payoff,
    p50Payoff: bin.p50Payoff,
    p75Payoff: bin.p75Payoff,
    p90Payoff: bin.p90Payoff,
    winRate: bin.winRate,
    maxLossRate: bin.maxLossRate,
  };
};


const leverageDetailsRef = ref<HTMLDetailsElement | null>(null);

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const setRiskBudget = (value: number): void => {
  riskBudget.value = Number.isFinite(value)
    ? clamp(value, 1, 10_000_000)
    : 10_000;
};

const applyLeverage = (value: number): void => {
  const next = Number.isFinite(value)
    ? Math.round(clamp(value, 1, 100) * 100) / 100
    : 10;
  leverage.value = next;
  leverageDraft.value = next;
};

const setLeverage = (value: number): void => {
  leverageOverridden.value = true;
  applyLeverage(value);
};
const LEVERAGE_DEBOUNCE_MS = 180;
const LEVERAGE_AUTOCLOSE_MS = 2000;
let leverageDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let leverageAutocloseTimer: ReturnType<typeof setTimeout> | null = null;

const clearLeverageAutocloseTimer = (): void => {
  if (leverageAutocloseTimer != null) {
    clearTimeout(leverageAutocloseTimer);
    leverageAutocloseTimer = null;
  }
};

const closeLeveragePopover = (): void => {
  if (leverageDetailsRef.value) {
    leverageDetailsRef.value.open = false;
  }
  clearLeverageAutocloseTimer();
};

const scheduleLeverageAutoclose = (): void => {
  clearLeverageAutocloseTimer();
  if (!leverageDetailsRef.value?.open) return;
  leverageAutocloseTimer = setTimeout(
    closeLeveragePopover,
    LEVERAGE_AUTOCLOSE_MS,
  );
};

const handleLeverageDetailsToggle = (): void => {
  if (leverageDetailsRef.value?.open) {
    scheduleLeverageAutoclose();
  } else {
    clearLeverageAutocloseTimer();
  }
};

const handleOutsidePointerDown = (event: PointerEvent): void => {
  const details = leverageDetailsRef.value;
  if (
    details?.open &&
    event.target instanceof Node &&
    !details.contains(event.target)
  ) {
    closeLeveragePopover();
  }
};

const setLeverageDraft = (value: number): void => {
  leverageDraft.value = Number.isFinite(value) ? clamp(value, 1, 100) : 10;
  scheduleLeverageAutoclose();
  if (leverageDebounceTimer != null) {
    clearTimeout(leverageDebounceTimer);
  }
  leverageDebounceTimer = setTimeout(() => {
    leverageDebounceTimer = null;
    setLeverage(leverageDraft.value);
  }, LEVERAGE_DEBOUNCE_MS);
};

onMounted(() => {
  document.addEventListener("pointerdown", handleOutsidePointerDown);
});

onUnmounted(() => {
  if (leverageDebounceTimer != null) {
    clearTimeout(leverageDebounceTimer);
  }
  clearLeverageAutocloseTimer();
  document.removeEventListener("pointerdown", handleOutsidePointerDown);
});

const setFunding = (value: number): void => {
  annualFundingPercent.value = Number.isFinite(value)
    ? clamp(value, -100, 100)
    : 8;
};

const setLongStrike = (value: number): void => {
  if (longStrikeOptions.value.some((option) => option.value === value)) {
    longStrike.value = value;
  }
};

const setShortStrike = (value: number): void => {
  if (shortStrikeOptions.value.some((option) => option.value === value)) {
    shortStrike.value = value;
  }
};

const setRealizedVolPercent = (value: number): void => {
  if (!Number.isFinite(value)) return;
  targetVrpPoints.value = null;
  emit(
    "set-vol",
    clamp(value, RV_MIN_PERCENT, RV_MAX_PERCENT) / 100,
  );
};

const setDriftPercent = (value: number): void => {
  if (!Number.isFinite(value)) return;
  emit(
    "set-mu",
    clamp(value, DRIFT_MIN_PERCENT, DRIFT_MAX_PERCENT) / 100,
  );
};

const selectAssumptionInput = (event: FocusEvent): void => {
  (event.currentTarget as HTMLInputElement | null)?.select();
};

const selectableQuotes = computed(() =>
  selectableExpiryQuotes(
    props.expiryQuotes,
    props.valuationTs,
    horizonDays.value,
    optionType.value === "put" ? "down" : "up",
  ),
);

const maturityOptions = computed(() =>
  maturityOptionsForQuotes(selectableQuotes.value, props.valuationTs),
);

const horizonOptions = computed(() =>
  horizonOptionsForQuotes(
    props.expiryQuotes,
    props.valuationTs,
    MATURITY_DAYS,
  ),
);

watch(
  selectableQuotes,
  (quotes) => {
    if (
      quotes.some(
        (quote) => quote.expirationTs === selectedExpirationTs.value,
      )
    ) {
      return;
    }
    const targetExpirationTs =
      selectedExpirationTs.value ||
      props.valuationTs + DEFAULT_MATURITY_DAYS * SECONDS_PER_DAY;
    selectedExpirationTs.value =
      closestExpirationTs(quotes, targetExpirationTs) ?? 0;
  },
  { immediate: true },
);

const selectedExpiryQuote = computed(
  () =>
    selectableQuotes.value.find(
      (quote) => quote.expirationTs === selectedExpirationTs.value,
    ) ?? null,
);

const listedStrikes = computed(() => {
  const quote = selectedExpiryQuote.value;
  return (optionType.value === "put" ? quote?.putStrikes : quote?.callStrikes) ?? [];
});
const longStrikeOptions = computed(() => listedStrikes.value
  .filter((strike) => !isSpread.value || listedStrikes.value.some((other) =>
    optionType.value === "put" ? other < strike : other > strike))
  .map((value) => ({ label: value.toLocaleString("en-US"), value })));
const shortStrikeOptions = computed(() => listedStrikes.value
  .filter((strike) => optionType.value === "put" ? strike < longStrike.value : strike > longStrike.value)
  .map((value) => ({ label: value.toLocaleString("en-US"), value })));

const nearestStrike = (options: { value: number }[], target: number): number =>
  options.reduce((nearest, option) =>
    Math.abs(option.value - target) < Math.abs(nearest - target) ? option.value : nearest,
    options[0]?.value ?? 0);

watch(longStrikeOptions, (options) => {
  if (!options.some(({ value }) => value === longStrike.value)) {
    longStrike.value = nearestStrike(options, selectedExpiryQuote.value?.strike ?? 0);
  }
}, { immediate: true });
watch(shortStrikeOptions, (options) => {
  if (!options.some(({ value }) => value === shortStrike.value)) {
    shortStrike.value = nearestStrike(options, longStrike.value * (optionType.value === "put" ? 0.9 : 1.1));
  }
}, { immediate: true });

const selectedOptionIv = computed(() =>
  optionType.value === "put"
    ? selectedExpiryQuote.value?.putIv ?? selectedExpiryQuote.value?.callIv
    : selectedExpiryQuote.value?.callIv,
);

const hasOptionIv = computed(() =>
  selectedOptionIv.value != null &&
  Number.isFinite(selectedOptionIv.value) && Number(selectedOptionIv.value) > 0,
);
const vrpPoints = computed(() => hasOptionIv.value
  ? (Number(selectedOptionIv.value) - props.params.vol) * 100
  : null);
const canMatchIv = computed(() => hasOptionIv.value &&
  Number(selectedOptionIv.value) >= RV_MIN_PERCENT / 100 &&
  Number(selectedOptionIv.value) <= RV_MAX_PERCENT / 100);

const setVrpPoints = (value: number): void => {
  if (!hasOptionIv.value || !Number.isFinite(value)) return;
  targetVrpPoints.value = value;
};

watch(
  [selectedOptionIv, targetVrpPoints],
  ([iv, vrp]) => {
    if (!hasOptionIv.value || vrp == null) return;
    emit(
      "set-vol",
      clamp(Number(iv) - vrp / 100, RV_MIN_PERCENT / 100, RV_MAX_PERCENT / 100),
    );
  },
  { immediate: true },
);

const selectedInstrumentName = computed(() => {
  const quote = selectedExpiryQuote.value;
  if (!quote) return "ATM option";
  const expiry = quote.callInstrumentName.split("-").slice(0, -2).join("-");
  const typeCode = optionType.value === "put" ? "P" : "C";
  if (isSpread.value) {
    return `${expiry}-${longStrike.value}-${typeCode} / ${expiry}-${shortStrike.value}-${typeCode}`;
  }
  return `${expiry}-${longStrike.value}-${typeCode}`;
});

const setPayoffDisplayMode = (mode: "payoff" | "frequency"): void => {
  payoffDisplayMode.value = mode;
  hoveredBinStats.value = null;
};

const setPayoffChartMode = (
  mode: "terminal" | "cumulative",
): void => {
  payoffChartMode.value = mode;
  hoveredBinStats.value = null;
};

watch(
  () => [
    props.seed,
    props.params.s0,
    props.params.mu,
    props.params.vol,
    riskBudget.value,
    leverage.value,
    annualFundingPercent.value,
    horizonDays.value,
    selectedExpirationTs.value,
    selectedOptionIv.value,
    optionStructure.value,
    longStrike.value,
    shortStrike.value,
  ],
  () => {
    optionStats.value = null;
    perpStats.value = null;
    hoveredBinStats.value = null;
  },
);

const comparisonParams = computed<GBMParams>(() => {
  const horizonSeconds = resolveHorizonSeconds(
    horizonDays.value,
    selectedExpirationTs.value,
    props.valuationTs,
  );
  const T = horizonSeconds / (DAYS_PER_YEAR * SECONDS_PER_DAY);
  return {
    ...props.params,
    T,
    dt: STOP_LOSS_STEP_SECONDS / (DAYS_PER_YEAR * SECONDS_PER_DAY),
  };
});

const perpSide = computed<"buy" | "sell">(() =>
  optionType.value === "put" ? "sell" : "buy",
);
const optionLabel = computed(() =>
  isSpread.value
    ? `${longStrike.value.toLocaleString("en-US")} / ${shortStrike.value.toLocaleString("en-US")} ${optionType.value} spread`
    : `Long ${longStrike.value.toLocaleString("en-US")} ${optionType.value}`,
);
const perpLabel = computed(() =>
  optionType.value === "put" ? "Short perpetual" : "Long perpetual",
);

// Keep the IV=RV comparison model-fair: the same mark IV and pricing model
// determine both the entry premium and every simulated option value.
const optionTimeToExpiry = computed(() => {
  const quote = selectedExpiryQuote.value;
  return quote == null
    ? 0
    : Math.max(0, quote.expirationTs - props.valuationTs) /
      (DAYS_PER_YEAR * SECONDS_PER_DAY);
});

const longOptionGreeks = computed(() => {
  const spot = Number(props.params.s0);
  const strike = Number(longStrike.value);
  const iv = Number(selectedOptionIv.value);
  const timeToExpiry = optionTimeToExpiry.value;
  if (
    !Number.isFinite(spot) ||
    !Number.isFinite(strike) ||
    !Number.isFinite(iv) ||
    timeToExpiry <= 0
  ) {
    return null;
  }
  return blackScholesGreeks(
    spot,
    strike,
    timeToExpiry,
    iv,
    0,
    optionType.value,
  );
});

const shortOptionGreeks = computed(() => {
  const spot = Number(props.params.s0);
  const iv = Number(selectedOptionIv.value);
  const timeToExpiry = optionTimeToExpiry.value;
  if (
    !Number.isFinite(spot) ||
    !Number.isFinite(iv) ||
    timeToExpiry <= 0
  ) {
    return null;
  }
  return blackScholesGreeks(
    spot,
    shortStrike.value,
    timeToExpiry,
    iv,
    0,
    optionType.value,
  );
});

const optionPremium = computed(() => {
  const longPremium = longOptionGreeks.value?.price ?? 0;
  if (!isSpread.value) return longPremium;
  return Math.max(0, longPremium - (shortOptionGreeks.value?.price ?? 0));
});

const optionOmega = computed(() => {
  const spot = Number(props.params.s0);
  const premium = optionPremium.value;
  const longDelta = longOptionGreeks.value?.delta;
  const shortDelta = shortOptionGreeks.value?.delta;
  if (
    !Number.isFinite(spot) ||
    !Number.isFinite(longDelta) ||
    (isSpread.value && !Number.isFinite(shortDelta))
  ) {
    return null;
  }
  const netDelta = Number(longDelta) -
    (isSpread.value ? Number(shortDelta) : 0);
  return computeOptionOmega(netDelta, spot, premium);
});

watch(
  optionOmega,
  (omega) => {
    if (leverageOverridden.value || omega == null) return;
    applyLeverage(omega);
  },
  { immediate: true },
);

const optionContracts = computed(() =>
  optionPremium.value > 0 ? riskBudget.value / optionPremium.value : 0,
);

const optionLegs = computed<PositionLeg[]>(() => {
  const legs: PositionLeg[] = [{
    id: "stop-loss-option",
    kind: "option",
    side: "buy",
    qty: optionContracts.value,
    optionType: optionType.value,
    strike: longStrike.value,
    premium: longOptionGreeks.value?.price ?? 0,
  }];
  if (isSpread.value) {
    legs.push({
      id: "stop-loss-option-cap",
      kind: "option",
      side: "sell",
      qty: optionContracts.value,
      optionType: optionType.value,
      strike: shortStrike.value,
      premium: shortOptionGreeks.value?.price ?? 0,
    });
  }
  return legs;
});

const optionPricing = computed(() => {
  const pricing: Record<string, {
    iv: number | null;
    mark: number;
    expirationTs: number | null;
  }> = {
    "stop-loss-option": {
      iv: selectedOptionIv.value ?? null,
      mark: longOptionGreeks.value?.price ?? 0,
      expirationTs: selectedExpiryQuote.value?.expirationTs ?? null,
    },
  };
  if (isSpread.value) {
    pricing["stop-loss-option-cap"] = {
      iv: selectedOptionIv.value ?? null,
      mark: shortOptionGreeks.value?.price ?? 0,
      expirationTs: selectedExpiryQuote.value?.expirationTs ?? null,
    };
  }
  return pricing;
});

const perpContracts = computed(() => {
  const spot = Number(props.params.s0);
  if (!Number.isFinite(spot) || spot <= 0) return 0;
  return (riskBudget.value * leverage.value) / spot;
});

const stopDistance = computed(() =>
  perpContracts.value > 0 ? riskBudget.value / perpContracts.value : 0,
);
const stopPrice = computed(() =>
  optionType.value === "put"
    ? props.params.s0 + stopDistance.value
    : Math.max(0, props.params.s0 - stopDistance.value),
);
const takeProfitPrice = computed(() => isSpread.value
  ? props.params.s0 + (perpSide.value === "buy" ? 1 : -1) * Math.abs(shortStrike.value - longStrike.value)
  : null);
const perpLegs = computed<PositionLeg[]>(() => [
  {
    id: "stop-loss-perp",
    kind: "future",
    side: perpSide.value,
    qty: perpContracts.value,
    entry: props.params.s0,
    stopLoss: stopPrice.value,
    takeProfit: takeProfitPrice.value,
    annualFundingRate: annualFundingPercent.value / 100,
  },
]);

const formatUsd = (value: number, digits = 0): string => {
  if (!Number.isFinite(value)) return "—";
  const sign = value < 0 ? "−" : "";
  return `${sign}$${Math.abs(value).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
};

const formatSignedUsd = (value: number): string => {
  if (!Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}$${Math.abs(value).toLocaleString("en-US", {
    maximumFractionDigits: Math.abs(value) < 100 ? 2 : 0,
  })}`;
};

const formatPercent = (value: number): string =>
  Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "—";

const formatSignedPercentagePoints = (value: number): string => {
  if (!Number.isFinite(value)) return "—";
  const points = value * 100;
  const sign = points > 0 ? "+" : points < 0 ? "−" : "";
  return `${sign}${Math.abs(points).toFixed(1)} pp`;
};

const payoffChartContext = computed(() => {
  const iv = Number(selectedOptionIv.value);
  const maturityDays = selectedExpirationTs.value > props.valuationTs
    ? displayedDaysToExpiry(selectedExpirationTs.value, props.valuationTs)
    : 0;
  const funding = Number(annualFundingPercent.value.toFixed(1));
  return [
    selectedInstrumentName.value,
    `IV ${Number.isFinite(iv) ? `${(iv * 100).toFixed(1)}%` : "—"}`,
    `RV ${(props.params.vol * 100).toFixed(1)}%`,
    `Drift ${(props.params.mu * 100).toFixed(1)}%`,
    `Risk ${formatUsd(riskBudget.value)}`,
    `Perp ${leverage.value.toFixed(2)}×`,
    ...(takeProfitPrice.value != null ? [`Take profit ${formatUsd(takeProfitPrice.value)}`] : []),
    `Funding ${funding}%/yr`,
    `Horizon ${horizonDays.value}d`,
    `Maturity ${maturityDays}d`,
  ].join(" · ");
});

const optionMarketReady = computed(
  () =>
    Number.isFinite(selectedOptionIv.value) &&
    Number(selectedOptionIv.value) > 0 &&
    optionPremium.value > 0 &&
    longStrikeOptions.value.some(({ value }) => value === longStrike.value) &&
    (!isSpread.value || shortStrikeOptions.value.some(({ value }) => value === shortStrike.value)),
);

const optionResultStats = computed(() =>
  optionMarketReady.value ? optionStats.value : null,
);

const optionDisplayStats = computed<TableStats | null>(() => {
  if (!optionMarketReady.value) return null;
  if (hoveredBinStats.value) {
    return binToTableStats(hoveredBinStats.value.primary);
  }
  return optionResultStats.value;
});

const perpDisplayStats = computed<TableStats | null>(() => {
  if (hoveredBinStats.value) {
    return binToTableStats(hoveredBinStats.value.comparison);
  }
  return perpStats.value;
});

const hoveredPriceRangeLabel = computed(() => {
  const primary = hoveredBinStats.value?.primary;
  const comparison = hoveredBinStats.value?.comparison;
  const bin = primary ?? comparison;
  if (!bin) return null;
  return `${formatUsd(bin.priceMin)} – ${formatUsd(bin.priceMax)}`;
});
</script>

<template>
  <section class="stop-loss-simulator">
    <div class="comparison-shell">
      <div class="comparison-bar">
        <div class="control-pill select-pill option-structure-pill">
          <span class="pill-label">Option</span>
          <span class="pill-value">
            <StyledSelectMenu
              v-model="optionStructure"
              label="Option structure"
              :options="OPTION_STRUCTURE_OPTIONS"
              embedded
            />
          </span>
        </div>
        <div class="control-pill control-pill--strike">
          <span class="pill-label">Long K</span>
          <span class="pill-value">
            <StyledSelectMenu
              :model-value="longStrike"
              :label="`Long ${optionType} strike`"
              :options="longStrikeOptions"
              embedded
              @update:model-value="setLongStrike(Number($event))"
            />
          </span>
        </div>
        <div v-if="isSpread" class="control-pill control-pill--strike">
          <span class="pill-label">Short K</span>
          <span class="pill-value">
            <StyledSelectMenu
              :model-value="shortStrike"
              :label="`Short ${optionType} strike`"
              :options="shortStrikeOptions"
              embedded
              @update:model-value="setShortStrike(Number($event))"
            />
          </span>
        </div>
      <label class="control-pill control-pill--risk">
        <span class="pill-label">Risk</span>
        <span class="pill-value">
          $
          <input
            type="number"
            min="1"
            max="10000000"
            step="100"
            :value="riskBudget"
            aria-label="Risk budget in US dollars"
            @focus="selectAssumptionInput"
            @change="
              setRiskBudget(Number(($event.target as HTMLInputElement).value))
            "
            @blur="
              setRiskBudget(Number(($event.target as HTMLInputElement).value))
            "
          />
        </span>
      </label>
      <details
        ref="leverageDetailsRef"
        class="control-pill leverage-control"
        @toggle="handleLeverageDetailsToggle"
      >
        <summary>
          <span class="pill-label">Leverage</span>
          <span class="pill-value">{{ leverageDraft }}×</span>
        </summary>
        <div class="leverage-popover">
          <div class="leverage-popover-head">
            <span>Leverage</span>
            <strong>{{ leverageDraft }}×</strong>
          </div>
          <input
            class="leverage-slider"
            type="range"
            min="1"
            max="100"
            step="0.1"
            :value="leverageDraft"
            aria-label="Perpetual leverage"
            @input="
              setLeverageDraft(
                Number(($event.target as HTMLInputElement).value),
              )
            "
          />
          <div class="leverage-scale">
            <span>1×</span>
            <span>100×</span>
          </div>
        </div>
      </details>
      <label class="control-pill control-pill--funding">
        <span class="pill-label">Funding</span>
        <span class="pill-value">
          <input
            type="number"
            min="-100"
            max="100"
            step="0.5"
            :value="annualFundingPercent"
            aria-label="Annual funding percentage"
            @focus="selectAssumptionInput"
            @change="
              setFunding(Number(($event.target as HTMLInputElement).value))
            "
            @blur="
              setFunding(Number(($event.target as HTMLInputElement).value))
            "
          />
          % / yr
        </span>
      </label>
      <div class="control-pill select-pill">
        <span class="pill-label">Horizon</span>
        <span class="pill-value">
          <StyledSelectMenu
            v-model="horizonDays"
            label="Horizon"
            :options="horizonOptions"
            embedded
          />
        </span>
      </div>
      <div class="control-pill select-pill maturity-pill">
        <span class="pill-label">Maturity</span>
        <span class="pill-value">
          <StyledSelectMenu
            v-if="maturityOptions.length"
            v-model="selectedExpirationTs"
            label="Maturity"
            :options="maturityOptions"
            embedded
          />
          <span v-else>—</span>
        </span>
      </div>
      <label class="control-pill control-pill--rv">
        <span class="pill-label">RV</span>
        <span class="pill-value">
          <input
            type="number"
            :min="RV_MIN_PERCENT"
            :max="RV_MAX_PERCENT"
            step="0.1"
            :value="Number((params.vol * 100).toFixed(1))"
            aria-label="Annual realized volatility percentage"
            @focus="selectAssumptionInput"
            @change="
              setRealizedVolPercent(
                Number(($event.target as HTMLInputElement).value),
              )
            "
            @blur="
              setRealizedVolPercent(
                Number(($event.target as HTMLInputElement).value),
              )
            "
          />
          %
        </span>
      </label>
      <div class="control-pill control-pill--vrp" title="VRP = IV − RV, in volatility points">
        <label class="vrp-input-label">
          <span class="pill-label">VRP</span>
          <span class="pill-value">
            <input
              type="number"
              step="0.1"
              :disabled="!hasOptionIv"
              :value="vrpPoints == null ? '' : Number(vrpPoints.toFixed(1))"
              aria-label="Volatility risk premium in volatility points (IV minus RV)"
              @focus="selectAssumptionInput"
              @change="setVrpPoints(Number(($event.target as HTMLInputElement).value))"
            />
            pts
          </span>
        </label>
        <button
          type="button"
          class="vrp-zero-button"
          :disabled="!canMatchIv"
          :aria-pressed="targetVrpPoints === 0 && canMatchIv"
          aria-label="Set VRP to zero: match RV to IV"
          :title="canMatchIv ? 'Set RV equal to IV' : 'IV must be available and within the RV range'"
          @click="setVrpPoints(0)"
        >0</button>
      </div>
      <label class="control-pill control-pill--drift">
        <span class="pill-label">Drift</span>
        <span class="pill-value">
          <input
            type="number"
            :min="DRIFT_MIN_PERCENT"
            :max="DRIFT_MAX_PERCENT"
            step="0.1"
            :value="Number((params.mu * 100).toFixed(1))"
            aria-label="Annual drift percentage"
            @focus="selectAssumptionInput"
            @change="
              setDriftPercent(
                Number(($event.target as HTMLInputElement).value),
              )
            "
            @blur="
              setDriftPercent(
                Number(($event.target as HTMLInputElement).value),
              )
            "
          />
          %
        </span>
      </label>
      <div class="comparison-view-toggles">
        <button
          type="button"
          class="control-pill resimulate-button"
          @click="emit('resimulate')"
        >
          Resimulate
        </button>
        <div
          class="path-mode-toggle chart-mode-toggle"
          role="group"
          aria-label="Chart organization"
        >
          <button
            type="button"
            :class="{ 'is-active': payoffChartMode === 'terminal' }"
            :aria-pressed="payoffChartMode === 'terminal'"
            @click="setPayoffChartMode('terminal')"
          >
            Terminal
          </button>
          <button
            type="button"
            :class="{ 'is-active': payoffChartMode === 'cumulative' }"
            :aria-pressed="payoffChartMode === 'cumulative'"
            @click="setPayoffChartMode('cumulative')"
          >
            EV
          </button>
        </div>
        <div
          v-if="payoffChartMode === 'terminal'"
          class="path-mode-toggle"
          role="group"
          aria-label="Payoff display mode"
        >
          <button
            type="button"
            :class="{ 'is-active': payoffDisplayMode === 'payoff' }"
            :aria-pressed="payoffDisplayMode === 'payoff'"
            @click="setPayoffDisplayMode('payoff')"
          >
            Payoff
          </button>
          <button
            type="button"
            :class="{ 'is-active': payoffDisplayMode === 'frequency' }"
            :aria-pressed="payoffDisplayMode === 'frequency'"
            @click="setPayoffDisplayMode('frequency')"
          >
            Freq × Payoff
          </button>
        </div>
      </div>
      </div>

      <article class="comparison-row">
      <header>
        <div class="comparison-chart-title">
          <div class="instrument-meta">
            <span>{{ selectedInstrumentName }}</span>
            <small>
              IV
              {{
                Number.isFinite(selectedOptionIv)
                  ? `${(Number(selectedOptionIv) * 100).toFixed(1)}%`
                  : "—"
              }}
            </small>
            <small>
              RV
              {{
                Number.isFinite(params.vol)
                  ? `${(params.vol * 100).toFixed(1)}%`
                  : "—"
              }}
            </small>
          </div>
        </div>
      </header>
      <div class="comparison-main comparison-main--cumul">
        <div
          class="comparison-chart"
          :class="{ 'is-terminal': payoffChartMode === 'terminal' }"
        >
          <CloudChart
            v-if="optionMarketReady"
            :seed="seed"
            :params="comparisonParams"
            :pathModel="pathModel"
            :valuationTs="valuationTs"
            :samplePathLimit="samplePathLimit"
            :muMin="-5"
            :muMax="5"
            :volMin="0.1"
            :volMax="1.2"
            :histogramOpacity="0.45"
            :colorMin="colorMin"
            :colorMax="colorMax"
            :histBinsMultiplier="histBinsMultiplier"
            :legs="optionLegs"
            :optionPricingByLegId="optionPricing"
            :comparisonLegs="perpLegs"
            :comparisonOptionPricingByLegId="EMPTY_OPTION_PRICING"
            :primarySeriesLabel="optionLabel"
            :comparisonSeriesLabel="perpLabel"
            :comparisonReferencePrice="stopPrice"
            :payoffDisplayMode="payoffDisplayMode"
            :payoffChartMode="payoffChartMode"
            :payoffChartContext="payoffChartContext"
            @set-mu="emit('set-mu', $event)"
            @set-vol="setRealizedVolPercent($event * 100)"
            @stats-update="optionStats = $event"
            @comparison-stats-update="perpStats = $event"
            @histogram-bin-hover="hoveredBinStats = $event"
          />
          <div v-else class="comparison-chart-loading">
            Loading selected option quote…
          </div>
        </div>
      </div>
      <div
        class="comparison-table-wrap"
        :class="{
          'is-bin-filtered': hoveredBinStats != null,
          'is-cumul': true,
        }"
        aria-live="polite"
      >
        <table class="comparison-table">
          <thead>
            <tr>
              <th scope="col">
                Metric
                <small v-if="hoveredPriceRangeLabel" class="bin-filter-label">
                  {{ hoveredPriceRangeLabel }}
                </small>
              </th>
              <th scope="col"><i class="option-swatch"></i>Option</th>
              <th scope="col"><i class="perp-swatch"></i>Perp</th>
              <th scope="col">Option − perp</th>
            </tr>
          </thead>
          <tbody>
            <tr class="pnl-row">
              <th scope="row">Average PnL (MC)</th>
              <td>
                {{ formatSignedUsd(optionDisplayStats?.meanPayoff ?? NaN) }}
              </td>
              <td>{{ formatSignedUsd(perpDisplayStats?.meanPayoff ?? NaN) }}</td>
              <td>
                {{
                  formatSignedUsd(
                    (optionDisplayStats?.meanPayoff ?? NaN) -
                      (perpDisplayStats?.meanPayoff ?? NaN),
                  )
                }}
              </td>
            </tr>
            <tr
              v-for="percentile in payoffPercentileRows"
              :key="percentile.key"
              class="pnl-row"
            >
              <th scope="row">{{ percentile.label }}</th>
              <td>
                {{
                  formatSignedUsd(
                    optionDisplayStats?.[percentile.key] ?? NaN,
                  )
                }}
              </td>
              <td>
                {{
                  formatSignedUsd(
                    perpDisplayStats?.[percentile.key] ?? NaN,
                  )
                }}
              </td>
              <td>
                {{
                  formatSignedUsd(
                    (optionDisplayStats?.[percentile.key] ?? NaN) -
                      (perpDisplayStats?.[percentile.key] ?? NaN),
                  )
                }}
              </td>
            </tr>
            <tr>
              <th scope="row">Win probability</th>
              <td>{{ formatPercent(optionDisplayStats?.winRate ?? NaN) }}</td>
              <td>{{ formatPercent(perpDisplayStats?.winRate ?? NaN) }}</td>
              <td>
                {{
                  formatSignedPercentagePoints(
                    (optionDisplayStats?.winRate ?? NaN) -
                      (perpDisplayStats?.winRate ?? NaN),
                  )
                }}
              </td>
            </tr>
            <tr class="max-loss-row">
              <th scope="row">Max loss probability</th>
              <td>{{ formatPercent(optionDisplayStats?.maxLossRate ?? NaN) }}</td>
              <td>{{ formatPercent(perpDisplayStats?.maxLossRate ?? NaN) }}</td>
              <td>
                {{
                  formatSignedPercentagePoints(
                    (optionDisplayStats?.maxLossRate ?? NaN) -
                      (perpDisplayStats?.maxLossRate ?? NaN),
                  )
                }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      </article>
    </div>
  </section>
</template>

<style scoped>
.stop-loss-simulator {
  box-sizing: border-box;
  width: 100%;
  padding: 6px 0 56px;
  color: var(--color-text);
}

.comparison-shell {
  --comparison-control-height: clamp(36px, 2.25cqw, 46px);
  --comparison-gap: clamp(6px, 0.375cqw, 9px);
  --comparison-padding: clamp(6px, 0.375cqw, 9px);
  --comparison-font-small: clamp(10px, 0.625cqw, 13px);
  --comparison-font-body: clamp(11px, 0.6875cqw, 14px);
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  container-type: inline-size;
}

.comparison-shell > .comparison-bar,
.comparison-shell > .comparison-row {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  max-width: none;
}

.comparison-bar {
  position: relative;
  display: flex;
  align-items: center;
  box-sizing: border-box;
  width: 100%;
  gap: var(--comparison-gap);
  min-width: 0;
  padding: var(--comparison-padding);
  border: 1px solid var(--color-border);
  background: #0b0c0f;
  font-family: "Helvetica Neue", Helvetica, -apple-system, BlinkMacSystemFont,
    "Segoe UI", sans-serif;
}

.control-pill {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  box-sizing: border-box;
  height: var(--comparison-control-height);
  gap: clamp(10px, 0.625cqw, 13px);
  min-width: 0;
  padding: 0 clamp(11px, 0.6875cqw, 15px);
  border: 1px solid var(--color-border);
  border-radius: 7px;
  background: transparent;
  color: inherit;
  white-space: nowrap;
}

.control-pill:hover,
.control-pill:focus-within {
  border-color: rgba(255, 255, 255, 0.22);
}

.resimulate-button {
  cursor: pointer;
  background: rgba(255, 255, 255, 0.025);
  font: inherit;
  font-size: var(--comparison-font-body);
  font-weight: 600;
}

.resimulate-button:active {
  background: rgba(255, 255, 255, 0.07);
}

.pill-label {
  color: #70767d;
  font-size: var(--comparison-font-small);
  font-family: inherit;
  font-weight: 500;
  letter-spacing: 0.01em;
  line-height: 1;
}

.pill-value {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  color: #e8eaed;
  font-size: var(--comparison-font-body);
  font-weight: 500;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}

.pill-value input {
  min-width: 0;
  outline: 0;
  color: inherit;
  font: inherit;
  font-variant-numeric: inherit;
}

.pill-value input {
  width: 40px;
  padding: 0;
  border: 0;
  background: transparent;
  text-align: left;
  appearance: textfield;
}

.control-pill--risk .pill-value,
.control-pill--funding .pill-value,
.control-pill--rv .pill-value,
.control-pill--drift .pill-value,
.control-pill--strike .pill-value {
  gap: 3px;
}

.control-pill--risk .pill-value input {
  width: 8ch;
}

.control-pill--funding .pill-value input {
  width: 5ch;
}

.control-pill--rv .pill-value input,
.control-pill--drift .pill-value input {
  width: 6ch;
}

.vrp-input-label {
  display: flex;
  align-items: center;
  gap: clamp(10px, 0.625cqw, 13px);
}

.control-pill--vrp .pill-value {
  gap: 3px;
}

.control-pill--vrp .pill-value input {
  width: 5ch;
}

.vrp-zero-button {
  padding: 2px 6px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: #1a1c21;
  color: #e8eaed;
  font: inherit;
  font-size: var(--comparison-font-body);
  cursor: pointer;
}

.vrp-zero-button:hover:not(:disabled),
.vrp-zero-button[aria-pressed="true"] {
  border-color: #70767d;
}

.vrp-zero-button:disabled {
  opacity: 0.4;
  cursor: default;
}

.pill-value input::-webkit-inner-spin-button,
.pill-value input::-webkit-outer-spin-button {
  margin: 0;
  -webkit-appearance: none;
}

.select-pill {
  flex: 0 0 auto;
}

.leverage-control {
  position: relative;
  padding: 0;
}

.leverage-control summary {
  display: flex;
  align-items: center;
  box-sizing: border-box;
  height: calc(var(--comparison-control-height) - 2px);
  gap: clamp(10px, 0.625cqw, 13px);
  padding: 0 clamp(11px, 0.6875cqw, 15px);
  cursor: pointer;
  list-style: none;
}

.leverage-control summary::-webkit-details-marker {
  display: none;
}

.leverage-popover {
  position: absolute;
  z-index: 20;
  top: calc(100% + 8px);
  left: 50%;
  width: 220px;
  padding: 11px 12px 9px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 10px;
  background: rgba(9, 13, 20, 0.97);
  box-shadow: 0 10px 26px rgba(0, 0, 0, 0.42);
  transform: translateX(-50%);
}

.leverage-popover-head,
.leverage-scale {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.leverage-popover-head {
  margin-bottom: 8px;
  color: #7c848d;
  font-size: 9px;
  font-family: inherit;
  text-transform: uppercase;
}

.leverage-popover-head strong {
  color: #e8eaed;
  font-size: 11px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}

.leverage-slider {
  width: 100%;
  height: 16px;
  appearance: none;
  background: transparent;
  cursor: pointer;
}

.leverage-slider::-webkit-slider-runnable-track {
  height: 4px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.24);
}

.leverage-slider::-webkit-slider-thumb {
  width: 12px;
  height: 12px;
  margin-top: -4px;
  border: 1px solid rgba(2, 6, 23, 0.9);
  border-radius: 50%;
  appearance: none;
  background: #f8fafc;
}

.leverage-slider::-moz-range-track {
  height: 4px;
  border: 0;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.24);
}

.leverage-slider::-moz-range-thumb {
  width: 12px;
  height: 12px;
  border: 1px solid rgba(2, 6, 23, 0.9);
  border-radius: 50%;
  background: #f8fafc;
}

.leverage-scale {
  margin-top: 2px;
  color: #8b9198;
  font-size: 9px;
  font-variant-numeric: tabular-nums;
}

.select-pill :deep(.styled-select) {
  width: 28px;
}

.maturity-pill :deep(.styled-select) {
  width: auto;
}

.option-structure-pill :deep(.styled-select) {
  width: auto;
  min-width: 68px;
}

.comparison-controls {
  display: grid;
  grid-template-columns:
    repeat(4, minmax(116px, 1fr))
    minmax(330px, 2.3fr)
    minmax(154px, auto);
  gap: 8px;
  padding: 14px;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  background: #0e0f12;
}

.comparison-controls label {
  display: grid;
  gap: 7px;
  min-width: 0;
  color: #777f88;
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.input-shell {
  display: flex;
  align-items: center;
  height: 34px;
  padding: 0 9px;
  border: 1px solid rgba(255, 255, 255, 0.11);
  border-radius: 7px;
  background: #15161a;
  color: #818992;
  font-size: 11px;
  text-transform: none;
}

.input-shell:focus-within {
  border-color: rgba(255, 255, 255, 0.28);
}

.input-shell input {
  min-width: 0;
  width: 100%;
  height: 100%;
  padding: 0 4px;
  border: 0;
  outline: 0;
  background: transparent;
  color: #eef0f2;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  appearance: textfield;
}

.input-shell select {
  min-width: 0;
  width: 100%;
  height: 100%;
  border: 0;
  outline: 0;
  background: transparent;
  color: #eef0f2;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.input-shell--select {
  padding-right: 6px;
}

.input-shell input::-webkit-inner-spin-button,
.input-shell input::-webkit-outer-spin-button {
  appearance: none;
}

.input-shell--suffix input {
  text-align: right;
}

.market-source {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 28px;
  padding: 0 15px;
  border-right: 1px solid var(--color-border);
  border-bottom: 1px solid var(--color-border);
  border-left: 1px solid var(--color-border);
  border-radius: 0 0 9px 9px;
  color: #646c74;
  font-size: 9px;
  font-variant-numeric: tabular-nums;
}

.market-source strong {
  color: #899098;
  font-size: 9px;
  font-weight: 600;
}

.market-source-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #6c737a;
}

.market-source.is-live .market-source-dot {
  background: #8bc2a5;
}

.market-source span + span::before {
  margin-right: 10px;
  color: #3f454b;
  content: "·";
}

.comparison-summary {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-top: 12px;
}

.summary-card {
  padding: 16px;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  background: #0d0e11;
}

.summary-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 14px;
}

.summary-card-head strong {
  color: #e9ebed;
  font-size: 12px;
  font-weight: 600;
}

.product-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

.summary-card--option .product-dot,
.option-swatch {
  background: #8fc5ed;
}

.summary-card--perp .product-dot,
.perp-swatch {
  background: #f8b36f;
}

.product-tag {
  margin-left: auto;
  padding: 3px 6px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.06);
  color: #89919a;
  font-size: 8px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.summary-card dl {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px;
  margin: 0;
}

.summary-card dl div {
  min-width: 0;
}

.summary-card dt {
  margin-bottom: 5px;
  color: #626a72;
  font-size: 8px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.summary-card dd {
  overflow: hidden;
  margin: 0;
  color: #cbd0d5;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.comparison-row {
  box-sizing: border-box;
  width: 100%;
  overflow: hidden;
  margin-top: 2px;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  background: #0b0c0f;
}

.comparison-row > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  box-sizing: border-box;
  height: clamp(30px, 1.875cqw, 38px);
  min-height: 0;
  padding: 0 clamp(16px, 1cqw, 22px);
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}

.comparison-chart-title {
  display: flex;
  align-items: center;
  height: 100%;
  gap: 20px;
  min-width: 0;
  font-size: clamp(9px, 0.5625cqw, 12px);
  font-variant-numeric: tabular-nums;
}

.instrument-meta {
  display: inline-flex;
  flex: 0 1 auto;
  align-items: center;
  min-width: 0;
  gap: clamp(12px, 0.75cqw, 16px);
  line-height: 1;
}

.instrument-meta span {
  overflow: hidden;
  color: #a9afb5;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.instrument-meta small {
  flex: 0 0 auto;
  color: #666e76;
  font-size: inherit;
}

.comparison-chart-title .stop-summary-inline {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  color: #7e868e;
  line-height: 1;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-number {
  color: #4f565e;
  font-size: 9px;
  font-variant-numeric: tabular-nums;
}

.row-stats span {
  color: #606870;
}

.row-stats strong {
  margin-left: 3px;
  color: #aeb4ba;
  font-variant-numeric: tabular-nums;
}

.stopped-path-filter {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
  margin-left: 8px;
  padding: 0;
  color: #6f7780;
  font-size: 9px;
  font-weight: 400;
  line-height: 1;
  text-align: left;
}

.stopped-path-filter i {
  box-sizing: border-box;
  width: 10px;
  height: 10px;
  border: 1px solid rgba(242, 245, 247, 0.82);
  border-radius: 1px;
  background: transparent;
}

.stopped-path-filter:hover,
.stopped-path-filter.is-active {
  color: #d8dcdf;
}

.stopped-path-filter.is-active i {
  border-color: #f2f5f7;
  background: #f2f5f7;
  box-shadow: none;
}

.stopped-path-filter span {
  color: #8f969d;
}

.histogram-mode-button {
  box-sizing: border-box;
  height: 36px;
  padding: 0 12px;
  border: 1px solid var(--color-border);
  border-radius: 7px;
  background: rgba(255, 255, 255, 0.025);
  color: #d4d8dc;
  font-family: inherit;
  font-size: 10px;
  font-weight: 500;
  white-space: nowrap;
}

.histogram-mode-button:hover,
.histogram-mode-button:focus-visible {
  border-color: rgba(255, 255, 255, 0.22);
}

.comparison-view-toggles {
  display: flex;
  align-items: center;
  gap: var(--comparison-gap);
  margin-left: auto;
}

.comparison-view-toggles .path-mode-toggle {
  margin-left: 0;
}

.path-mode-toggle {
  display: grid;
  grid-template-columns: 1fr 1fr;
  box-sizing: border-box;
  height: var(--comparison-control-height);
  margin-left: auto;
  padding: 3px;
  border-radius: 7px;
  background: #111216;
}

.chart-mode-toggle {
  grid-template-columns: repeat(2, 1fr);
}

.path-mode-toggle button {
  min-width: 48px;
  padding: 0 10px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: #7b828a;
  font-family: inherit;
  font-size: var(--comparison-font-small);
  font-weight: 500;
  white-space: nowrap;
}

.path-mode-toggle button:hover {
  color: #d4d8dc;
}

.path-mode-toggle button.is-active {
  background: #1a1c21;
  color: #f1f3f5;
}

.comparison-main {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
}

.comparison-main--cumul {
  min-height: 0;
}

.comparison-chart {
  position: relative;
  width: 100%;
  aspect-ratio: 2.15 / 1;
  --chart-header-height: 0px;
  --chart-legend-height: 0px;
}

.comparison-main--cumul .comparison-chart {
  min-height: 0;
  aspect-ratio: 1200 / 520;
}

.comparison-main--cumul .comparison-chart.is-terminal {
  aspect-ratio: 1200 / 720;
}

.comparison-chart-loading {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: #626971;
  font-size: 10px;
}

.comparison-table-wrap {
  position: relative;
  z-index: 3;
  box-sizing: border-box;
  width: 100%;
  overflow-x: auto;
  margin-top: -68px;
  padding: clamp(10px, 0.75cqw, 16px) 4% clamp(14px, 1cqw, 22px)
    6.8333%;
  border-top: 1px solid rgba(255, 255, 255, 0.07);
  background: #0b0c0f;
}

.comparison-table-wrap.is-cumul {
  margin-top: 0;
}

.comparison-table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
  color: #cbd0d5;
  font-size: var(--comparison-font-body);
  font-variant-numeric: tabular-nums;
}

.comparison-table th,
.comparison-table td {
  padding: clamp(8px, 0.5cqw, 11px) clamp(16px, 1cqw, 22px);
  border-bottom: 1px solid rgba(255, 255, 255, 0.055);
  text-align: right;
}

.comparison-table th:first-child,
.comparison-table td:first-child {
  text-align: left;
}

.comparison-table thead th {
  color: #6f7780;
  font-size: clamp(9px, 0.5625cqw, 12px);
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  font-family: "Helvetica Neue", Helvetica, -apple-system, BlinkMacSystemFont,
    "Segoe UI", sans-serif;
}

.comparison-table thead th .bin-filter-label {
  display: block;
  margin-top: 3px;
  color: #9aa3ab;
  font-size: 8px;
  font-weight: 500;
  letter-spacing: 0.02em;
  text-transform: none;
}

.comparison-table-wrap.is-bin-filtered .comparison-table tbody td {
  transition: color 80ms ease;
}

.comparison-table thead th:last-child {
  font-weight: 400;
}

.comparison-table tbody th {
  color: #8e969e;
  font-weight: 500;
}

.comparison-table tbody td:last-child {
  color: #e1e4e7;
  font-weight: 400;
}

.comparison-table .pnl-row th,
.comparison-table .pnl-row td {
  background: rgba(255, 255, 255, 0.025);
}

.comparison-table .pnl-row td:nth-child(2) {
  color: #9fcdf0;
  background: rgba(102, 174, 232, 0.08);
}

.comparison-table .pnl-row td:nth-child(3) {
  color: #efaa63;
  background: rgba(223, 127, 36, 0.08);
}

.comparison-table i {
  display: inline-block;
  width: 7px;
  height: 7px;
  margin-right: 6px;
  border-radius: 2px;
  opacity: 0.75;
}

.comparison-table tbody tr:last-child th,
.comparison-table tbody tr:last-child td {
  border-bottom: 0;
}

@media (max-width: 1050px) {
  .comparison-bar {
    flex-wrap: wrap;
  }

  .comparison-controls {
    grid-template-columns: repeat(4, minmax(120px, 1fr));
  }

  .expiry-field {
    grid-column: span 3;
  }

}

@media (max-width: 1280px) {
  .comparison-bar {
    flex-wrap: wrap;
  }

  .comparison-view-toggles {
    flex: 1 1 100%;
    justify-content: flex-end;
  }
}

@media (max-width: 760px) {
  .comparison-view-toggles {
    align-items: stretch;
    flex-direction: column;
  }

  .comparison-view-toggles .path-mode-toggle {
    width: 100%;
  }

  .control-pill {
    flex: 1 1 calc(50% - 6px);
  }

  .comparison-controls {
    grid-template-columns: repeat(2, minmax(120px, 1fr));
  }

  .expiry-field {
    grid-column: 1 / -1;
  }

  .comparison-summary {
    grid-template-columns: 1fr;
  }

  .market-source {
    align-items: flex-start;
    flex-wrap: wrap;
    height: auto;
    padding-top: 8px;
    padding-bottom: 8px;
  }

  .summary-card dl {
    grid-template-columns: 1fr 1fr;
  }

  .comparison-row > header {
    align-items: flex-start;
    flex-direction: column;
    gap: 8px;
    padding-top: 12px;
    padding-bottom: 12px;
  }

  .comparison-main--cumul .comparison-chart {
    min-height: 0;
    aspect-ratio: 1200 / 520;
  }

  .comparison-main--cumul .comparison-chart.is-terminal {
    aspect-ratio: 1200 / 720;
  }

  .comparison-table-wrap {
    margin-top: -40px;
  }
}
</style>
