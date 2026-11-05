<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { PositionLeg, OptionLeg, OptionType } from "../position.ts";
import type { ThalexInstrument } from "../thalex-instrument.ts";
import { blackScholesGreeks } from "../black-scholes.ts";
import StyledSelectMenu from "./StyledSelectMenu.vue";
import { formatCombinationTitle } from "../combination-title.js";

const props = withDefaults(defineProps<{
  appearance?: "default" | "minimal";
  title?: string;
  legs: PositionLeg[];
  spot: number;
  vol: number;
  T: number;
  showTte?: boolean;
  instruments?: ThalexInstrument[];
  tickerByInstrument?: Record<string, { data: unknown; fetchedAt: number }>;
  indexName?: string | null;
  showIndexSummary?: boolean;
  indexPrice?: number | null;
  indexFetchedAt?: number | null;
  valuationByLeg?: Record<string, {
    mark: number;
    iv: number;
    greeks: ReturnType<typeof blackScholesGreeks>;
  }>;
}>(), { showIndexSummary: true });

const emit = defineEmits<{
  (event: "update:legs", value: PositionLeg[]): void;
}>();

const MAX_LEGS = 4;
const RISK_FREE_RATE = 0.05;

const clampLegs = (legs: PositionLeg[]): PositionLeg[] => legs.slice(0, MAX_LEGS);

const legsModel = computed({
  get: () => clampLegs(props.legs),
  set: (value: PositionLeg[]) => emit("update:legs", clampLegs(value)),
});

watch(
  () => props.legs.length,
  (next) => {
    if (next > MAX_LEGS) {
      emit("update:legs", clampLegs(props.legs));
    }
  },
  { immediate: true },
);

const newLegId = (): string => {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ?? `leg_${Math.random().toString(36).slice(2, 10)}`;
};

const builderId = newLegId();

const roundToStep = (value: number, step: number): number => {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return value;
  return Math.round(value / step) * step;
};

const formatExpiry = (date: Date): string => {
  const day = String(date.getDate()).padStart(2, "0");
  const month = date.toLocaleString("en-US", { month: "short" });
  const year = String(date.getFullYear()).slice(-2);
  return `${day} ${month} ${year}`;
};

type NormalizedOptionInstrument = {
  instrument_name: string;
  index_name?: string;
  option_type?: "call" | "put";
  strike_price?: number;
  expiration_timestamp?: number;
  create_time?: number;
};

const monthMap: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

const parseFromName = (name: string): NormalizedOptionInstrument | null => {
  const match = name.match(/^[A-Z]+-(\d{2})([A-Z]{3})(\d{2})-(\d+)-([CP])$/);
  if (!match) return null;
  const [, dd, mmm, yy, strikeStr, cp] = match;
  const day = Number(dd);
  const month = monthMap[mmm.toLowerCase()];
  const year = 2000 + Number(yy);
  if (!Number.isFinite(day) || !Number.isFinite(month) || !Number.isFinite(year)) return null;
  const strike = Number(strikeStr);
  if (!Number.isFinite(strike)) return null;
  const expiration = Date.UTC(year, month, day, 8, 0, 0) / 1000;
  return {
    instrument_name: name,
    option_type: cp === "P" ? "put" : "call",
    strike_price: strike,
    expiration_timestamp: Math.floor(expiration),
  };
};

const parseTimestampToSeconds = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    const num = Number(value);
    return num > 1e12 ? Math.floor(num / 1000) : Math.floor(num);
  }
  if (typeof value === "string") {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) {
      return asNumber > 1e12 ? Math.floor(asNumber / 1000) : Math.floor(asNumber);
    }
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  return null;
};

const normalizeInstrument = (instrument: ThalexInstrument): NormalizedOptionInstrument | null => {
  if (!instrument?.instrument_name) return null;
  const kind = (instrument.kind ?? instrument.type)?.toLowerCase?.();
  const hasOptionKind = kind === "option" || kind === "options";
  const optionTypeRaw = instrument.option_type?.toLowerCase?.();
  const optionType =
    optionTypeRaw === "p" || optionTypeRaw === "put"
      ? "put"
      : optionTypeRaw === "c" || optionTypeRaw === "call"
        ? "call"
        : undefined;
  const strike = Number(instrument.strike_price);
  const expiration = parseTimestampToSeconds(instrument.expiration_timestamp);
  const createTime = parseTimestampToSeconds(instrument.create_time);

  if (
    hasOptionKind &&
    optionType &&
    Number.isFinite(strike) &&
    Number.isFinite(expiration)
  ) {
    return {
      instrument_name: instrument.instrument_name,
      index_name: instrument.index_name ?? instrument.underlying,
      option_type: optionType,
      strike_price: strike,
      expiration_timestamp: expiration,
      create_time: createTime ?? undefined,
    };
  }

  const parsed = parseFromName(instrument.instrument_name);
  if (!parsed) return null;
  return {
    ...parsed,
    index_name: instrument.index_name ?? instrument.underlying,
    create_time: createTime ?? undefined,
  };
};

const optionInstruments = computed(() =>
  (props.instruments ?? [])
    .map((instrument) => normalizeInstrument(instrument))
    .filter((instrument): instrument is NormalizedOptionInstrument => !!instrument),
);

const optionInstrumentsForContext = computed(() => {
  if (!props.indexName) return optionInstruments.value;
  const filtered = optionInstruments.value.filter(
    (instrument) => instrument.index_name === props.indexName,
  );
  return filtered.length ? filtered : optionInstruments.value;
});

const parseExpiryToSeconds = (expiry?: string): number | null => {
  if (!expiry) return null;
  const parts = expiry.split(" ");
  if (parts.length < 3) return null;
  const [dayStr, monthStr, yearStr] = parts;
  const day = Number(dayStr);
  const year = Number(yearStr);
  if (!Number.isFinite(day) || !Number.isFinite(year)) return null;
  const monthIdx = new Date(`${monthStr} 1, 2000`).getMonth();
  if (!Number.isFinite(monthIdx)) return null;
  const fullYear = year < 100 ? 2000 + year : year;
  const date = new Date(Date.UTC(fullYear, monthIdx, day));
  return Math.floor(date.getTime() / 1000);
};

const expiryOptions = computed(() => {
  if (optionInstrumentsForContext.value.length) {
    const unique = new Map<number, string>();
    for (const instrument of optionInstrumentsForContext.value) {
      const ts = Number(instrument.expiration_timestamp);
      if (!Number.isFinite(ts)) continue;
      if (!unique.has(ts)) {
        unique.set(ts, formatExpiry(new Date(ts * 1000)));
      }
    }
    const list = Array.from(unique.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, label]) => label);

    const custom = new Set<string>();
    for (const leg of props.legs) {
      if (leg.kind === "option" && leg.expiry && !list.includes(leg.expiry)) {
        custom.add(leg.expiry);
      }
    }
    return [...custom, ...list];
  }

  const horizonDays = Math.max(1, Math.round(props.T * 365.25));
  const offsets = new Set([horizonDays, 7, 14, 20, 30, 60, 90]);
  const base = new Date();
  return Array.from(offsets)
    .sort((a, b) => a - b)
    .map((days) => {
      const d = new Date(base);
      d.setDate(d.getDate() + days);
      return formatExpiry(d);
    });
});

const strikeOptionsFallback = computed(() => {
  const spot = props.spot || 95000;
  const step = 5000;
  const range = 10;
  const strikes: number[] = [];
  const baseStrike = roundToStep(spot, step);
  for (let i = -range; i <= range; i++) {
    strikes.push(baseStrike + i * step);
  }
  return strikes.filter((s) => s > 0);
});

const targetExpiryDays = computed(() => {
  const years = Number(props.T);
  if (!Number.isFinite(years) || years <= 0) return 30;
  return Math.max(1, Math.round(years * 365.25));
});

const expiryClosestToTarget = computed<string | undefined>(() => {
  const options = optionInstrumentsForContext.value;
  if (!options.length) return undefined;

  const now = Math.floor(Date.now() / 1000);
  const upcoming = options.filter(
    (instrument) => Number(instrument.expiration_timestamp) > now,
  );
  const source = upcoming.length ? upcoming : options;
  const expiries = Array.from(
    new Set(
      source
        .map((instrument) => Number(instrument.expiration_timestamp))
        .filter((ts) => Number.isFinite(ts)),
    ),
  ).sort((a, b) => a - b);
  if (!expiries.length) return undefined;

  const target = now + targetExpiryDays.value * 24 * 60 * 60;
  let chosenExpiryTs = expiries[0];
  let bestDiff = Math.abs(chosenExpiryTs - target);
  for (const expiryTs of expiries) {
    const diff = Math.abs(expiryTs - target);
    if (diff < bestDiff) {
      chosenExpiryTs = expiryTs;
      bestDiff = diff;
    }
  }

  return formatExpiry(new Date(chosenExpiryTs * 1000));
});

const defaultExpiry = (): string | undefined =>
  expiryClosestToTarget.value ?? expiryOptions.value[0];

const referenceIndexPrice = computed(() => {
  if (Number.isFinite(props.indexPrice) && Number(props.indexPrice) > 0) return Number(props.indexPrice);
  return Number.isFinite(props.spot) && props.spot > 0 ? props.spot : 95_000;
});

const optionLegs = computed(() =>
  legsModel.value.filter((leg): leg is OptionLeg => leg.kind === "option"),
);

const isMinimal = computed(() => props.appearance !== "default");
const perLegMaturities = ref(false);
const sharedExpiry = computed(() => {
  const expiry = optionLegs.value[0]?.expiry;
  return optionLegs.value.every((leg) => leg.expiry === expiry) ? expiry : undefined;
});
const showRowMaturity = computed(() => !isMinimal.value || perLegMaturities.value
  || (optionLegs.value.length > 0 && !sharedExpiry.value));
const maturitySelectOptions = computed(() => [
  ...(optionLegs.value.length && !sharedExpiry.value ? [{ label: "Mixed maturities", value: "mixed" }] : []),
  ...expirySelectOptions.value,
  { label: "Per-leg maturities", value: "per-leg" },
]);
const selectMaturity = (value: string | number): void => {
  if (value === "mixed") return;
  perLegMaturities.value = value === "per-leg";
  if (perLegMaturities.value) return;
  legsModel.value = legsModel.value.map((leg) => leg.kind === "option"
    ? { ...leg, expiry: String(value) } : leg);
};
const singleMaturity = computed(() => sharedExpiry.value ?? optionLegs.value[0]?.expiry ?? defaultExpiry());
const useSingleMaturity = (): void => {
  if (singleMaturity.value) selectMaturity(singleMaturity.value);
};

const resolveInstrumentForLeg = (leg: OptionLeg): NormalizedOptionInstrument | null => {
  const expirySeconds = parseExpiryToSeconds(leg.expiry);
  if (!expirySeconds) return null;
  const strike = Number(leg.strike);
  if (!Number.isFinite(strike)) return null;
  const type = leg.optionType?.toLowerCase();
  const candidates = optionInstrumentsForContext.value.filter((instrument) => {
    if (instrument.option_type !== type) return false;
    if (Number(instrument.strike_price) !== strike) return false;
    const ts = Number(instrument.expiration_timestamp);
    if (!Number.isFinite(ts)) return false;
    return Math.abs(ts - expirySeconds) <= 12 * 60 * 60;
  });
  return candidates[0] ?? null;
};

const combinationTitle = computed(() => props.title ?? formatCombinationTitle(
  optionLegs.value.flatMap((leg) => {
    const expirationTs = resolveInstrumentForLeg(leg)?.expiration_timestamp ?? parseExpiryToSeconds(leg.expiry);
    return expirationTs == null ? [] : [{
      expirationTs, strike: leg.strike, optionType: leg.optionType,
      signedQty: (leg.side === "sell" ? -1 : 1) * leg.qty,
    }];
  }),
  props.indexName?.startsWith("BTC") ? "Bitcoin"
    : props.indexName?.startsWith("ETH") ? "Ethereum" : props.indexName ?? "Position",
));

const getTickerForLeg = (leg: OptionLeg): Record<string, unknown> | null => {
  const instrument = resolveInstrumentForLeg(leg);
  if (!instrument?.instrument_name) return null;
  const snapshot = props.tickerByInstrument?.[instrument.instrument_name];
  if (!snapshot || typeof snapshot.data !== "object" || !snapshot.data) return null;
  return snapshot.data as Record<string, unknown>;
};

const extractTickerIV = (ticker: Record<string, unknown> | null): number | null => {
  if (!ticker) return null;
  const candidates = [ticker.iv_close, ticker.iv, ticker.mark_iv, ticker.implied_volatility];
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      const parsed = Number(candidate);
      if (Number.isFinite(parsed)) return parsed > 3 ? parsed / 100 : parsed;
    }
    if (Number.isFinite(candidate)) {
      const num = Number(candidate);
      return num > 3 ? num / 100 : num;
    }
  }
  return null;
};

const extractTickerMark = (ticker: Record<string, unknown> | null): number | null => {
  if (!ticker) return null;
  const candidates = [
    ticker.mark_price_close,
    ticker.close,
    ticker.mark_price,
    ticker.mark,
    ticker.last,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      const parsed = Number(candidate);
      if (Number.isFinite(parsed)) return parsed;
    }
    if (Number.isFinite(candidate)) {
      return Number(candidate);
    }
  }
  return null;
};

const extractTickerTs = (ticker: Record<string, unknown> | null): number | null => {
  if (!ticker) return null;
  const ts = ticker.ts;
  if (!Number.isFinite(ts)) return null;
  const num = Number(ts);
  return num > 1e12 ? Math.floor(num / 1000) : num;
};

const getLegTteSeconds = (leg: OptionLeg): number | null => {
  const instrument = resolveInstrumentForLeg(leg);
  const expiryTs =
    Number(instrument?.expiration_timestamp) || parseExpiryToSeconds(leg.expiry) || null;
  if (!Number.isFinite(expiryTs)) return null;

  const tickerTs = extractTickerTs(getTickerForLeg(leg));
  const indexTsRaw = Number(props.indexFetchedAt);
  const indexTs = Number.isFinite(indexTsRaw)
    ? (indexTsRaw > 1e12 ? Math.floor(indexTsRaw / 1000) : Math.floor(indexTsRaw))
    : null;
  const referenceTs = tickerTs ?? indexTs ?? Math.floor(Date.now() / 1000);

  return Math.max(0, Number(expiryTs) - referenceTs);
};

const formatTteForLeg = (leg: OptionLeg): string => {
  const seconds = getLegTteSeconds(leg);
  if (!Number.isFinite(seconds)) return "--";
  if (seconds <= 0) return "0m";

  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${Math.max(1, minutes)}m`;
};

const getLegGreeks = (leg: OptionLeg) => {
  const valuation = props.valuationByLeg?.[leg.id];
  if (valuation) return valuation.greeks;
  const ticker = getTickerForLeg(leg);
  const instrument = resolveInstrumentForLeg(leg);
  const tickerIv = extractTickerIV(ticker);
  const vol = tickerIv && tickerIv > 0 ? tickerIv : props.vol;
  let T = props.T > 0 ? props.T : 14 / 365.25;
  if (instrument?.expiration_timestamp) {
    const referenceTs = extractTickerTs(ticker) ?? Math.floor(Date.now() / 1000);
    const secondsLeft = Math.max(60, instrument.expiration_timestamp - referenceTs);
    T = secondsLeft / (365.25 * 24 * 60 * 60);
  }
  const spot = props.indexPrice && props.indexPrice > 0 ? props.indexPrice : props.spot;
  return blackScholesGreeks(spot, leg.strike, T, vol, RISK_FREE_RATE, leg.optionType);
};

const signedGreek = (leg: OptionLeg, value: number): number => {
  const sign = leg.side === "buy" ? 1 : -1;
  const qty = Number.isFinite(leg.qty) ? Math.max(0, Number(leg.qty)) : 0;
  return sign * qty * value;
};

const totalGreeks = computed(() => {
  let delta = 0;
  let gamma = 0;
  let theta = 0;
  let vega = 0;

  for (const leg of optionLegs.value) {
    const greeks = getLegGreeks(leg);
    const sign = leg.side === "buy" ? 1 : -1;
    const qty = Number.isFinite(leg.qty) ? Math.max(0, Number(leg.qty)) : 0;
    delta += sign * qty * greeks.delta;
    gamma += sign * qty * greeks.gamma;
    theta += sign * qty * greeks.theta;
    vega += sign * qty * greeks.vega;
  }

  return { delta, gamma, theta, vega };
});

const updateLeg = (id: string, updater: (leg: PositionLeg) => PositionLeg): void => {
  legsModel.value = legsModel.value.map((leg) => (leg.id === id ? updater(leg) : leg));
};

const removeLeg = (id: string): void => {
  legsModel.value = legsModel.value.filter((leg) => leg.id !== id);
};

const addOptionLeg = (): void => {
  if (legsModel.value.length >= MAX_LEGS) return;
  const id = newLegId();
  const expiry = (isMinimal.value && sharedExpiry.value) || defaultExpiry();
  const strikes = strikeOptionsFor("call", expiry);
  const strike = defaultStrikeFor(strikes);
  legsModel.value = [
    ...legsModel.value,
    {
      id,
      kind: "option",
      side: "buy",
      qty: 1,
      optionType: "call" as OptionType,
      strike,
      premium: 0,
      expiry,
    },
  ];
};

const toggleSide = (leg: OptionLeg): void => {
  updateLeg(leg.id, (l) => ({ ...l, side: l.side === "buy" ? "sell" : "buy" }));
};

const incrementQty = (id: string): void => {
  updateLeg(id, (l) => ({ ...l, qty: Math.min(99, l.qty + 1) }));
};

const decrementQty = (id: string): void => {
  updateLeg(id, (l) => ({ ...l, qty: Math.max(1, l.qty - 1) }));
};

const formatNumber = (value: number): string =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);

const formatMarkPrice = (
  value: number | null,
  side?: "buy" | "sell",
  alwaysShowSign: boolean = false,
  qty: number = 1,
): string => {
  if (!Number.isFinite(value)) return "--";
  const sign = side === "sell" ? -1 : 1;
  const normalizedQty = Number.isFinite(qty) ? Math.max(0, Number(qty)) : 0;
  const signed = sign * normalizedQty * Number(value);
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
    signDisplay: side || alwaysShowSign ? "exceptZero" : "auto",
  }).format(signed);
};

const formatIvPercent = (value: number | null): string =>
  Number.isFinite(value) ? `${(Number(value) * 100).toFixed(2)}%` : "--";

const strikeOptionsFor = (
  optionType: OptionType | undefined,
  expiry: string | undefined,
): number[] => {
  if (!optionInstrumentsForContext.value.length) return strikeOptionsFallback.value;
  const expirySeconds = parseExpiryToSeconds(expiry);
  const type = optionType?.toLowerCase();
  if (!expirySeconds || !type) return strikeOptionsFallback.value;

  const strikes = optionInstrumentsForContext.value
    .filter((instrument) => {
      if (instrument.option_type !== type) return false;
      const ts = Number(instrument.expiration_timestamp);
      if (!Number.isFinite(ts)) return false;
      return Math.abs(ts - expirySeconds) <= 12 * 60 * 60;
    })
    .map((instrument) => Number(instrument.strike_price))
    .filter((strike) => Number.isFinite(strike))
    .sort((a, b) => a - b);

  const unique = Array.from(new Set(strikes));
  return unique.length ? unique : strikeOptionsFallback.value;
};

const defaultStrikeFor = (strikes: number[]): number => {
  if (!strikes.length) return roundToStep(referenceIndexPrice.value, 5000);
  let nearest = strikes[0];
  let bestDistance = Math.abs(nearest - referenceIndexPrice.value);
  for (let i = 1; i < strikes.length; i += 1) {
    const strike = strikes[i];
    const distance = Math.abs(strike - referenceIndexPrice.value);
    if (distance < bestDistance || (distance === bestDistance && strike < nearest)) {
      nearest = strike;
      bestDistance = distance;
    }
  }
  return nearest;
};

const strikeOptionsForLeg = (leg: OptionLeg): number[] =>
  strikeOptionsFor(leg.optionType, leg.expiry);
const expirySelectOptions = computed(() =>
  expiryOptions.value.map((expiry) => ({ label: expiry, value: expiry })),
);
const strikeSelectOptionsForLeg = (leg: OptionLeg) =>
  strikeOptionsForLeg(leg).map((strike) => ({
    label: formatNumber(strike),
    value: strike,
  }));

const canStepStrike = (leg: OptionLeg, direction: number): boolean => {
  const strikes = strikeOptionsForLeg(leg);
  const index = strikes.indexOf(leg.strike);
  return index >= 0 && index + direction >= 0 && index + direction < strikes.length;
};
const stepStrike = (leg: OptionLeg, direction: number): void => {
  if (!canStepStrike(leg, direction)) return;
  const strikes = strikeOptionsForLeg(leg);
  updateLeg(leg.id, (current) => ({ ...current, strike: strikes[strikes.indexOf(leg.strike) + direction] }));
};

const formatSignedNumber = (value: number, decimals: number = 2): string => {
  if (!Number.isFinite(value)) return "--";
  if (Math.abs(value) < 0.0001) return `+${(0).toFixed(decimals)}`;
  const prefix = value >= 0 ? "+" : "";
  return `${prefix}${value.toFixed(decimals)}`;
};

const legDisplayById = computed(() => {
  const display: Record<
    string,
    {
      mark: number | null;
      iv: number | null;
      greeks: ReturnType<typeof blackScholesGreeks>;
    }
  > = {};

  for (const leg of optionLegs.value) {
    const ticker = getTickerForLeg(leg);
    display[leg.id] = props.valuationByLeg?.[leg.id] ?? {
      mark: extractTickerMark(ticker),
      iv: extractTickerIV(ticker),
      greeks: getLegGreeks(leg),
    };
  }

  return display;
});

const legDisplay = (leg: OptionLeg) =>
  legDisplayById.value[leg.id] ?? {
    mark: null,
    iv: null,
    greeks: getLegGreeks(leg),
  };

const totalMarkPrice = computed<number | null>(() => {
  let total = 0;
  let hasAny = false;
  for (const leg of optionLegs.value) {
    const mark = legDisplayById.value[leg.id]?.mark;
    if (!Number.isFinite(mark)) continue;
    const sign = leg.side === "buy" ? 1 : -1;
    const qty = Number.isFinite(leg.qty) ? Math.max(0, Number(leg.qty)) : 0;
    total += sign * qty * Number(mark);
    hasAny = true;
  }
  return hasAny ? total : null;
});
</script>

<template>
  <div class="payoff-builder" :class="{
    'payoff-builder--tte': Boolean(props.showTte) && !isMinimal,
    'payoff-builder--minimal': isMinimal,
    'payoff-builder--per-leg': isMinimal && showRowMaturity,
  }">
    <div v-if="isMinimal" class="builder-heading">
      <div class="combination-heading">
        <h1 v-if="combinationTitle">{{ combinationTitle }}</h1>
        <div class="maturity-summary">
          <StyledSelectMenu
            class="maturity-select"
            :id="`maturity-${builderId}`"
            label="Combination maturity"
            :model-value="sharedExpiry ?? (optionLegs.length ? 'mixed' : defaultExpiry() ?? '')"
            :options="maturitySelectOptions"
            @update:model-value="selectMaturity"
          />
          <span v-if="sharedExpiry && optionLegs.length" class="maturity-tte">{{ formatTteForLeg(optionLegs[0]) }}</span>
          <button
            v-if="!showRowMaturity && optionLegs.length"
            type="button"
            class="maturity-mode-button"
            aria-label="Edit maturities per leg"
            @click="selectMaturity('per-leg')"
          >Per-leg maturities</button>
          <button
            v-else-if="showRowMaturity && optionLegs.length"
            type="button"
            class="maturity-mode-button"
            aria-label="Use a single maturity"
            :title="`Set every leg to ${singleMaturity}`"
            @click="useSingleMaturity"
          >Single maturity</button>
        </div>
      </div>
    </div>
    <div class="legs-section">
      <div v-if="optionLegs.length" class="leg-greeks-header-row">
        <div v-if="indexName && props.showIndexSummary !== false" class="index-summary">
          <span class="index-label">{{ indexName }}</span>
          <span class="index-value">{{ indexPrice != null ? formatNumber(indexPrice) : "loading" }}</span>
        </div>
        <span v-else class="index-summary-spacer"></span>
        <span v-if="showRowMaturity" class="field-header maturity-header">{{ props.showTte || isMinimal ? "Maturity" : "" }}</span>
        <div class="strike-greeks-header">
          <span v-if="props.showTte || isMinimal" class="field-header strike-header">Strike</span>
          <span v-else class="strike-spacer"></span>
          <span v-if="props.showTte && !isMinimal" class="field-header tte-header">TTE</span>
          <div class="leg-greeks leg-greeks--header">
            <span class="leg-greek-header leg-greek-header--text">IV</span>
            <span class="leg-greek-header leg-greek-header--text">Mark</span>
            <span class="leg-greek-header">Δ</span>
            <span class="leg-greek-header">{{ isMinimal ? "Γ / $1K" : "Γ" }}</span>
            <span class="leg-greek-header">{{ isMinimal ? "Θ / day" : "Θ" }}</span>
            <span class="leg-greek-header">{{ isMinimal ? "ν / vol pt" : "ν" }}</span>
            <span class="leg-greek-header leg-greek-header--empty"></span>
          </div>
        </div>
      </div>

      <div v-for="leg in optionLegs" :key="leg.id" class="leg-row">
        <button
          type="button"
          class="side-pill"
          :class="leg.side === 'buy' ? 'side-pill--buy' : 'side-pill--sell'"
          :aria-label="`${leg.side === 'buy' ? 'Buy' : 'Sell'} leg; switch to ${leg.side === 'buy' ? 'sell' : 'buy'}`"
          @click="toggleSide(leg)"
        >
          {{ isMinimal ? (leg.side === 'buy' ? '+' : '−') : (leg.side === 'buy' ? 'Buy' : 'Sell') }}
        </button>

        <div class="qty-spinner" :class="{ 'qty-spinner--sell': leg.side === 'sell' }">
          <input
            type="number"
            class="qty-input"
            aria-label="Leg quantity"
            :name="`leg-qty-${leg.id}`"
            :value="leg.qty"
            min="1"
            max="99"
            inputmode="numeric"
            step="1"
            @change="
              updateLeg(leg.id, (l) => ({
                ...l,
                qty: Math.min(
                  99,
                  Math.max(1, Number(($event.target as HTMLInputElement).value || 1)),
                ),
              }))
            "
            @blur="
              updateLeg(leg.id, (l) => ({
                ...l,
                qty: Math.min(
                  99,
                  Math.max(1, Number(($event.target as HTMLInputElement).value || 1)),
                ),
              }))
            "
          />
          <div class="qty-arrows">
            <button type="button" class="qty-arrow" @click="incrementQty(leg.id)">▲</button>
            <button type="button" class="qty-arrow" @click="decrementQty(leg.id)">▼</button>
          </div>
        </div>

        <div class="type-toggle" aria-label="Option type">
          <button
            type="button"
            class="type-pill"
            aria-label="Toggle call or put"
            @click="
              updateLeg(leg.id, (l) => {
                const current = l as OptionLeg;
                const nextType: OptionType = current.optionType === 'call' ? 'put' : 'call';
                const strikes = strikeOptionsFor(nextType, current.expiry);
                const currentStrike = Number(current.strike);
                return {
                  ...current,
                  optionType: nextType,
                  strike: strikes.includes(currentStrike) ? currentStrike : defaultStrikeFor(strikes),
                };
              })
            "
          >
            {{ leg.optionType === "call" ? "Call" : "Put" }}
          </button>
        </div>

        <StyledSelectMenu
          v-if="showRowMaturity"
          class="leg-select"
          :id="`expiry-${builderId}-${leg.id}`"
          label="Option expiry"
          :model-value="leg.expiry ?? defaultExpiry()"
          :options="expirySelectOptions"
          @update:model-value="
            updateLeg(leg.id, (l) => ({
              ...(l as OptionLeg),
              expiry: String($event),
            }))
          "
        />

        <div class="strike-greeks">
          <div class="strike-control">
            <button v-if="isMinimal" type="button" class="strike-step" aria-label="Previous strike" :disabled="!canStepStrike(leg, -1)" @click="stepStrike(leg, -1)">‹</button>
            <StyledSelectMenu
              class="leg-select"
              :id="`strike-${builderId}-${leg.id}`"
              label="Option strike"
              :model-value="leg.strike"
              :options="strikeSelectOptionsForLeg(leg)"
              @update:model-value="
                updateLeg(leg.id, (l) => ({
                  ...(l as OptionLeg),
                  strike: Number($event),
                }))
              "
            />

            <button v-if="isMinimal" type="button" class="strike-step" aria-label="Next strike" :disabled="!canStepStrike(leg, 1)" @click="stepStrike(leg, 1)">›</button>
          </div>

          <span v-if="props.showTte && !isMinimal" class="tte-cell">{{ formatTteForLeg(leg) }}</span>

          <div class="leg-greeks">
            <span class="leg-greek">
              <span class="leg-greek-value">{{ formatIvPercent(legDisplay(leg).iv) }}</span>
            </span>
            <span class="leg-greek leg-greek--mark">
              <span class="leg-greek-value">
                {{ isMinimal ? formatMarkPrice(legDisplay(leg).mark) : formatMarkPrice(legDisplay(leg).mark, leg.side, false, leg.qty) }}
              </span>
            </span>
            <span class="leg-greek">
              <span class="leg-greek-value">
                {{ formatSignedNumber(signedGreek(leg, legDisplay(leg).greeks.delta)) }}
              </span>
            </span>
            <span class="leg-greek">
              <span class="leg-greek-value">
                {{ formatSignedNumber(signedGreek(leg, legDisplay(leg).greeks.gamma) * (isMinimal ? 1000 : 1), isMinimal ? 3 : 4) }}
              </span>
            </span>
            <span class="leg-greek">
              <span class="leg-greek-value">
                {{ formatSignedNumber(signedGreek(leg, legDisplay(leg).greeks.theta), 2) }}
              </span>
            </span>
            <span class="leg-greek">
              <span class="leg-greek-value">
                {{ formatSignedNumber(signedGreek(leg, legDisplay(leg).greeks.vega), 2) }}
              </span>
            </span>
            <button type="button" class="remove-btn" aria-label="Remove leg" @click="removeLeg(leg.id)">{{ isMinimal ? "×" : "−" }}</button>
          </div>
        </div>
      </div>

      <div class="legs-footer">
        <div class="footer-actions">
          <button
            v-if="legsModel.length < MAX_LEGS"
            type="button"
            class="add-leg-btn"
            @click="addOptionLeg"
          >
            + Add leg
          </button>
          <slot name="footer-actions" :legs-count="legsModel.length" :max-legs="MAX_LEGS" />
        </div>
        <div class="total-greeks">
          <span v-if="isMinimal" class="net-cost-label">{{ totalMarkPrice == null ? "Net premium" : totalMarkPrice < 0 ? "Net credit" : "Net debit" }}</span>
          <span class="strike-spacer"></span>
          <span class="tte-spacer"></span>
          <div class="leg-greeks">
            <span class="leg-greek leg-greek--spacer"></span>
            <span class="leg-greek">
              <span class="leg-greek-value total-mark">{{ formatMarkPrice(isMinimal && totalMarkPrice != null ? Math.abs(totalMarkPrice) : totalMarkPrice, undefined, !isMinimal, 1) }}</span>
            </span>
            <span class="leg-greek">
              <span class="leg-greek-value">{{ formatSignedNumber(totalGreeks.delta) }}</span>
            </span>
            <span class="leg-greek">
              <span class="leg-greek-value">{{ formatSignedNumber(totalGreeks.gamma * (isMinimal ? 1000 : 1), isMinimal ? 3 : 4) }}</span>
            </span>
            <span class="leg-greek">
              <span class="leg-greek-value">{{ formatSignedNumber(totalGreeks.theta, 2) }}</span>
            </span>
            <span class="leg-greek">
              <span class="leg-greek-value">{{ formatSignedNumber(totalGreeks.vega, 2) }}</span>
            </span>
            <span class="leg-greek leg-greek--spacer"></span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.payoff-builder {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 0;
  background: transparent;
  font-size: 12px;
  font-family: "Helvetica Neue", Helvetica, -apple-system, sans-serif;
}

.index-summary {
  display: flex;
  align-items: baseline;
  grid-column: 1 / 4;
  gap: 8px;
  min-width: 0;
  white-space: nowrap;
  font-size: 12px;
  color: #70767d;
}

.index-summary-spacer { grid-column: 1 / 4; }

.index-label {
  text-transform: uppercase;
  letter-spacing: 0.5px;
  font-size: 10px;
  font-weight: 600;
}

.index-value {
  font-weight: 500;
  color: #e8eaed;
}

.legs-section {
  display: flex;
  flex-direction: column;
  gap: 3px;
  --row-pad-y: 3px;
  --row-pad-x: 8px;
  --layout-gap: 9px;
  --col-side: 86px;
  --col-qty: 60px;
  --col-type: 68px;
  --col-expiry: 108px;
  --col-tte: 0px;
  --strike-width: 84px;
  --strike-greeks-gap: 12px;
  --strike-greeks-gap-extra: 0px;
  --greek-iv: 74px;
  --greek-mark: 106px;
  --greek-delta: 56px;
  --greek-gamma: 72px;
  --greek-theta: 72px;
  --greek-vega: 56px;
  --greek-remove: 32px;
  --leg-row-gap-total: calc(var(--layout-gap) * 4);
  --leg-greeks-gap-total: calc(var(--layout-gap) * 6);
  --greeks-shift-x: 0px;
  --control-height: 27px;
}

.payoff-builder--tte .legs-section {
  --col-tte: 72px;
  --strike-greeks-gap-extra: var(--strike-greeks-gap);
}

.leg-row {
  display: grid;
  grid-template-columns: var(--col-side) var(--col-qty) var(--col-type) var(--col-expiry) 1fr;
  gap: var(--layout-gap);
  align-items: center;
  padding: var(--row-pad-y) var(--row-pad-x);
  background: transparent;
  border: none;
}

.leg-greeks-header-row {
  display: grid;
  grid-template-columns: var(--col-side) var(--col-qty) var(--col-type) var(--col-expiry) 1fr;
  gap: var(--layout-gap);
  align-items: center;
  padding: 0 var(--row-pad-x) 1px;
}

.field-header {
  width: 100%;
  text-align: center;
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  color: #70767d;
}

.maturity-header {
  text-align: center;
}

.tte-cell {
  width: 100%;
  text-align: center;
  font-size: 11px;
  line-height: 1;
  color: #e8eaed;
  font-variant-numeric: tabular-nums;
}

.strike-greeks-header {
  display: grid;
  grid-template-columns: var(--strike-width) 1fr;
  align-items: center;
  gap: var(--strike-greeks-gap);
  min-width: 0;
}

.payoff-builder--tte .strike-greeks-header {
  grid-template-columns: var(--strike-width) var(--col-tte) 1fr;
}

.side-pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0;
  box-sizing: border-box;
  height: var(--control-height);
  padding: 0 6px;
  border-radius: 6px;
  font-size: 10px;
  font-family: inherit;
  line-height: 1;
  font-weight: 600;
  letter-spacing: 0;
  border: 1px solid rgba(255, 255, 255, 0.09);
  cursor: pointer;
  box-shadow: none;
  background: #111114;
}

.side-pill--sell {
  padding: 0 6px;
}

.side-pill--buy {
  color: #66d38f;
}

.side-pill--sell {
  color: #e46578;
}

.qty-spinner {
  display: flex;
  align-items: stretch;
  border-radius: 12px;
  background: transparent;
  border: none;
  overflow: hidden;
  width: 100%;
}

.qty-input {
  box-sizing: border-box;
  width: 100%;
  height: var(--control-height);
  min-height: var(--control-height);
  padding: 0 5px;
  line-height: var(--control-height);
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.09);
  background: #111114;
  color: #e8eaed;
  font-size: 10px;
  font-family: inherit;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.qty-input:hover {
  border-color: rgba(255, 255, 255, 0.18);
}

.qty-input:focus,
.qty-input:focus-visible {
  outline: none;
  border-color: rgba(255, 255, 255, 0.3);
}

.qty-input::-webkit-inner-spin-button,
.qty-input::-webkit-outer-spin-button {
  display: none;
}

.qty-arrows {
  display: none;
  flex-direction: column;
  border: none;
}

.qty-arrow {
  padding: 0 6px;
  border: none;
  background: transparent;
  color: #8b9198;
  font-size: 8px;
  line-height: 12px;
  cursor: pointer;
  box-shadow: none;
}

.qty-arrow:hover {
  color: #e8eaed;
  background: rgba(255, 255, 255, 0.08);
}

.qty-arrow:first-child {
  border-bottom: none;
}

.leg-select {
  box-sizing: border-box;
  height: var(--control-height);
  min-height: var(--control-height);
}

.leg-select :deep(.styledSelectTrigger) {
  width: 100%;
  height: var(--control-height);
  font-size: 10px;
  font-family: inherit;
  justify-content: center;
  padding: 0 4px;
}

.type-toggle {
  display: block;
  align-items: center;
  width: 100%;
}

.type-pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  box-sizing: border-box;
  height: var(--control-height);
  padding: 0 6px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.09);
  background: #111114;
  color: #e8eaed;
  font-size: 10px;
  font-family: inherit;
  line-height: 1;
  cursor: pointer;
}

.strike-greeks {
  display: grid;
  grid-template-columns: var(--strike-width) 1fr;
  align-items: center;
  gap: var(--strike-greeks-gap);
  min-width: 0;
}

.payoff-builder--tte .strike-greeks {
  grid-template-columns: var(--strike-width) var(--col-tte) 1fr;
}

.strike-control { min-width: 0; }

.strike-greeks .leg-select {
  width: var(--strike-width);
}

.leg-greeks {
  display: grid;
  grid-template-columns:
    var(--greek-iv)
    var(--greek-mark)
    var(--greek-delta)
    var(--greek-gamma)
    var(--greek-theta)
    var(--greek-vega)
    var(--greek-remove);
  align-items: center;
  justify-items: stretch;
  column-gap: var(--layout-gap);
  font-size: 11px;
  color: #8b9198;
  margin-left: var(--greeks-shift-x);
}

.leg-greek {
  display: block;
  width: 100%;
  white-space: nowrap;
  min-height: 16px;
  text-align: right;
}

.leg-greek--spacer {
  visibility: hidden;
}

.leg-greek-header {
  width: 100%;
  text-align: right;
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
  letter-spacing: 0.5px;
  text-transform: none;
  color: #70767d;
}

.leg-greek-header--text {
  letter-spacing: 0.5px;
  text-transform: uppercase;
}

.leg-greek-header--empty {
  visibility: hidden;
}

.leg-greek-value {
  width: 100%;
  text-align: right;
  font-size: 11px;
  line-height: 1;
  font-family: "Helvetica Neue", Helvetica, -apple-system, sans-serif;
  font-variant-numeric: tabular-nums;
  font-feature-settings: "tnum" 1, "lnum" 1;
  color: #e8eaed;
}

.remove-btn {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: none;
  background: rgba(255, 255, 255, 0.08);
  color: #8b9198;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: none;
  justify-self: center;
}

.remove-btn:hover {
  background: rgba(255, 255, 255, 0.15);
  color: #e8eaed;
}

.add-leg-btn {
  align-self: flex-start;
  padding: 3px 10px;
  border-radius: 999px;
  border: none;
  background: transparent;
  color: #8b9198;
  font-size: 11px;
  cursor: pointer;
  box-shadow: none;
}

.add-leg-btn:hover {
  color: #e8eaed;
  border-color: transparent;
}

.legs-divider {
  border-top: 0.5px solid rgba(148, 163, 184, 0.45);
  margin: 0 var(--row-pad-x);
  width: calc(100% - 2 * var(--row-pad-x));
}

.legs-footer {
  display: grid;
  grid-template-columns: var(--col-side) var(--col-qty) var(--col-type) var(--col-expiry) 1fr;
  align-items: center;
  gap: var(--layout-gap);
  padding: 1px var(--row-pad-x) 0;
}

.footer-actions {
  grid-column: 1 / 5;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 24px;
}

.total-greeks {
  display: grid;
  grid-template-columns: var(--strike-width) 1fr;
  align-items: center;
  gap: var(--strike-greeks-gap);
  padding: var(--row-pad-y) 0;
  font-size: 10px;
  color: #8b9198;
  grid-column: 5;
}

.strike-spacer {
  width: var(--strike-width);
}

.tte-spacer {
  display: none;
  width: var(--col-tte);
}

.payoff-builder--tte .total-greeks {
  grid-template-columns: var(--strike-width) var(--col-tte) 1fr;
}

.payoff-builder--tte .tte-spacer {
  display: block;
}

@media (max-width: 900px) {
  .leg-row {
    grid-template-columns: repeat(4, minmax(0, 1fr));
    grid-auto-rows: auto;
  }

  .leg-greeks {
    grid-template-columns: repeat(2, max-content);
    row-gap: 6px;
    justify-self: start;
    margin-left: 0;
  }
}

@media (min-width: 1200px) {
  .legs-section {
    width: 95.5%;
    --layout-gap: clamp(11px, 0.625vw, 16px);
    --strike-greeks-gap: clamp(16px, 0.9375vw, 24px);
  }

  .leg-greeks {
    justify-content: space-between;
  }
}
/* The app's chart container owns the width; the editor fills that same space. */
.payoff-builder--minimal {
  box-sizing: border-box; width: 100%; min-width: 0; margin: 0;
  padding: 16px 0 12px; gap: 16px; color: #fff; font-size: 13px;
}
.builder-heading { min-width: 0; }
.combination-heading { display: flex; align-items: center; gap: 16px; min-width: 0; overflow-x: auto; }
.combination-heading h1 {
  flex-shrink: 0; margin: 0; font-size: 13px; font-weight: 500;
  line-height: 26px; white-space: nowrap;
}
.maturity-summary { display: flex; flex-shrink: 0; align-items: center; gap: 12px; white-space: nowrap; }
.maturity-select :deep(.styledSelectTrigger) {
  height: 26px; padding: 0; gap: 12px; border: 0; border-radius: 0;
  background: transparent; font-size: 13px; color: #fff; cursor: pointer;
}

.maturity-tte { color: #8a8a8a; font-size: 11px; }
.maturity-mode-button {
  padding: 2px 0; border: 0; border-bottom: 1px dashed #444;
  background: transparent; color: #8a8a8a; font: inherit; font-size: 11px; cursor: pointer;
}
.maturity-mode-button:hover { color: #fff; border-color: #8a8a8a; }
.payoff-builder--minimal .index-label { font-size: 10px; font-weight: 400; color: #8a8a8a; letter-spacing: 0; }
.payoff-builder--minimal .index-value { font-size: 11px; color: #fff; }
.payoff-builder--minimal .legs-section {
  --selection-columns: 16px 38px 72px minmax(0, 1fr);
  --layout-gap: 10px;
  --strike-width: 126px;
  --strike-greeks-gap: 16px;
  --greek-iv: minmax(76px, 1fr);
  --greek-mark: minmax(96px, 1.15fr);
  --greek-delta: minmax(72px, 1fr);
  --greek-gamma: minmax(82px, 1fr);
  --greek-theta: minmax(90px, 1fr);
  --greek-vega: minmax(90px, 1fr);
  --greek-remove: 32px;
  --control-height: 32px;
  --row-pad-x: 12px;
  width: 100%; gap: 0; overflow-x: auto; padding-bottom: 4px;
}
.payoff-builder--per-leg .legs-section {
  --selection-columns: 16px 38px 64px 104px minmax(0, 1fr);
  --strike-width: 114px;
}
.payoff-builder--minimal .leg-row,
.payoff-builder--minimal .leg-greeks-header-row,
.payoff-builder--minimal .total-greeks {
  grid-template-columns: var(--selection-columns); gap: var(--layout-gap);
  min-width: 920px; box-sizing: border-box;
}
.payoff-builder--per-leg .leg-row,
.payoff-builder--per-leg .leg-greeks-header-row,
.payoff-builder--per-leg .total-greeks { min-width: 1020px; }
.payoff-builder--minimal .leg-greeks-header-row { padding: 0 12px 6px; }
.payoff-builder--minimal .leg-row {
  min-height: 40px; padding: 4px 12px; border-radius: 8px; transition: background 120ms ease;
}
.payoff-builder--minimal .leg-row:hover,
.payoff-builder--minimal .leg-row:focus-within { background: #0e0e0e; }
.payoff-builder--minimal .side-pill,
.payoff-builder--minimal .qty-input,
.payoff-builder--minimal .type-pill,
.payoff-builder--minimal .leg-select :deep(.styledSelectTrigger) {
  border: 0; background: transparent; border-radius: 0; box-shadow: none;
  font-size: 14px; font-weight: 400; padding: 0; cursor: pointer;
}
.payoff-builder--minimal .side-pill { font-size: 18px; }
.payoff-builder--minimal .side-pill--buy,
.payoff-builder--minimal .qty-input { color: #00bf9a; }
.payoff-builder--minimal .side-pill--sell,
.payoff-builder--minimal .qty-spinner--sell .qty-input { color: #ff4970; }
.payoff-builder--minimal .qty-spinner { border-radius: 0; }
.payoff-builder--minimal .qty-input { text-align: left; font-size: 16px; }
.payoff-builder--minimal .type-pill { justify-content: flex-start; color: #fff; }
.payoff-builder--minimal .leg-select :deep(.styledSelectTrigger) { color: #fff; font-weight: 500; }
.payoff-builder--per-leg .leg-row > .leg-select :deep(.styledSelectTrigger) { font-size: 12px; justify-content: flex-start; }
.payoff-builder--minimal .strike-greeks,
.payoff-builder--minimal .strike-greeks-header {
  grid-template-columns: var(--strike-width) minmax(0, 1fr); gap: var(--strike-greeks-gap);
}
.payoff-builder--minimal .strike-control {
  display: grid; grid-template-columns: 18px minmax(0, 1fr) 18px;
  align-items: center; height: var(--control-height); border-bottom: 1px solid transparent;
}
.payoff-builder--minimal .strike-control:hover,
.payoff-builder--minimal .strike-control:focus-within { border-color: #00bf9a; }
.payoff-builder--minimal .strike-control .leg-select { width: 100%; }
.payoff-builder--minimal .strike-control :deep(.styledSelectChevron) { display: none; }
.strike-step { border: 0; background: transparent; color: #8a8a8a; font: inherit; font-size: 14px; padding: 0; height: 32px; cursor: pointer; }
.strike-step:disabled { opacity: .2; cursor: default; }
.payoff-builder--minimal .leg-greeks {
  grid-template-columns: var(--greek-iv) var(--greek-mark) var(--greek-delta) var(--greek-gamma) var(--greek-theta) var(--greek-vega) var(--greek-remove);
  justify-self: stretch; justify-content: start; column-gap: var(--layout-gap); row-gap: 0;
}
.payoff-builder--minimal .field-header,
.payoff-builder--minimal .leg-greek-header { color: #8a8a8a; font-size: 9px; font-weight: 400; letter-spacing: 1px; text-transform: uppercase; }
.payoff-builder--minimal .strike-header { text-align: left; padding-left: 18px; box-sizing: border-box; }
.payoff-builder--minimal .leg-greek-value { font-size: 13px; color: #8a8a8a; }
.payoff-builder--minimal .leg-greek--mark .leg-greek-value { font-size: 13px; font-weight: 500; color: #fff; }
.payoff-builder--minimal .remove-btn { background: transparent; font-size: 18px; border-radius: 4px; opacity: 0; }
.payoff-builder--minimal .leg-row:hover .remove-btn,
.payoff-builder--minimal .leg-row:focus-within .remove-btn { opacity: 1; }
.payoff-builder--minimal .legs-footer { display: block; min-width: 920px; padding: 0; }
.payoff-builder--per-leg .legs-footer { min-width: 1020px; }
.payoff-builder--minimal .footer-actions { min-height: 34px; padding: 0 12px 4px; box-sizing: border-box; }
.payoff-builder--minimal .add-leg-btn { padding: 6px 0; font-size: 12px; color: #8a8a8a; }
.payoff-builder--minimal .add-leg-btn:hover { color: #fff; }
.payoff-builder--minimal .total-greeks { border-top: 1px solid #242427; padding: 10px 12px 4px; }
.payoff-builder--minimal .total-greeks > .strike-spacer,
.payoff-builder--minimal .total-greeks > .tte-spacer { display: none; }
.payoff-builder--minimal .net-cost-label { grid-column: 1 / -2; font-size: 9px; color: #8a8a8a; letter-spacing: 1px; text-transform: uppercase; white-space: nowrap; }
.payoff-builder--minimal .total-greeks > .leg-greeks { grid-column: -2 / -1; margin-left: calc(var(--strike-width) + var(--strike-greeks-gap)); }
.payoff-builder--minimal .total-greeks .leg-greek-value { color: #fff; }
.payoff-builder--minimal .total-greeks .total-mark { font-size: 13px; font-weight: 500; }
.payoff-builder--minimal button:focus-visible,
.payoff-builder--minimal .qty-input:focus-visible { outline: 1px solid #00bf9a; outline-offset: 3px; }
@media (hover: none) { .payoff-builder--minimal .remove-btn { opacity: 1; } }
@media (max-width: 650px) {
  .payoff-builder--minimal { padding: 12px 0; gap: 14px; }
}
</style>
