<script setup>
import { computed, ref, watch, useId } from "vue";
import { scaleLinear, line, area, curveStepAfter, extent, format } from "d3";

const props = defineProps({ result: { type: Object, required: true } });
const emit = defineEmits(["export"]);
const selected = ref(null);
const gradientId = `simulation-pnl-${useId()}`;
// Match Combo P&L's total mark curve; keep component lines neutral.
const GAIN = "#32e68a",
  LOSS = "#ff5c6c";
const signColor = (value) => (value > 0 ? GAIN : value < 0 ? LOSS : "#fff");
watch(
  () => props.result,
  () => {
    selected.value = null;
  },
);
const W = 1280,
  H = 420;
const PRICE_H = 320;
const margin = { top: 24, right: 38, bottom: 58, left: 78 };
const money = (value) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
const definitions = [
  {
    key: "option",
    label: "Option P&L",
    color: "#ffffff",
    value: (row) => row.optionPnl - row.optionFees,
  },
  {
    key: "hedge",
    label: "Hedge P&L",
    color: "#999999",
    value: (row) => row.hedgePnl - row.hedgeFees,
  },
  {
    key: "total",
    label: "Total P&L",
    color: GAIN,
    value: (row) => row.pnl,
  },
];
const mixedMaturities = computed(() =>
  props.result.legs.some((leg) => leg.maturity !== props.result.legs[0].maturity),
);
const exitDescription = computed(() => {
  if (!mixedMaturities.value) return "expiry";
  const last = Math.max(...props.result.legs.map(leg => leg.maturity));
  return props.result.config.horizon >= last - 1e-6 ? "last expiry" : "first expiry";
});
const exitLabel = computed(() => `At ${exitDescription.value}`);
const row = computed(
  () => props.result.rows[selected.value] || props.result.end,
);
const x = computed(() =>
  scaleLinear()
    .domain([0, props.result.config.horizon / 86400])
    .range([margin.left, W - margin.right]),
);
const y = computed(() => {
  const values = props.result.rows.flatMap((point) =>
    definitions.map((series) => series.value(point)),
  );
  values.push(0);
  const [low, high] = extent(values);
  const pad = (high - low || 1) * 0.08;
  return scaleLinear()
    .domain([low - pad, high + pad])
    .nice(6)
    .range([H - margin.bottom, margin.top]);
});
const curves = computed(() =>
  definitions.map((series) => ({
    ...series,
    path: line()
      .curve(curveStepAfter)
      .x((point) => x.value(point.elapsed / 86400))
      .y((point) => y.value(series.value(point)))(props.result.rows),
  })),
);
const zeroOffset = computed(
  () => (y.value(0) - margin.top) / (H - margin.bottom - margin.top),
);
const fillRange = computed(() => {
  const [low, high] = extent(props.result.rows, (point) => point.pnl);
  const gain = Math.max(0, high),
    loss = Math.min(0, low);
  return {
    top: y.value(gain),
    bottom: y.value(loss),
    zero: gain === loss ? 0.5 : gain / (gain - loss),
  };
});
const totalArea = computed(() =>
  area()
    .curve(curveStepAfter)
    .x((point) => x.value(point.elapsed / 86400))
    .y0(y.value(0))
    .y1((point) => y.value(point.pnl))(props.result.rows),
);
const priceY = computed(() => {
  const [low, high] = extent(props.result.rows, (point) => point.spot);
  const pad = (high - low || high * 0.01 || 1) * 0.08;
  return scaleLinear()
    .domain([low - pad, high + pad])
    .nice(5)
    .range([PRICE_H - margin.bottom, margin.top]);
});
const pricePath = computed(() =>
  line()
    .x((point) => x.value(point.elapsed / 86400))
    .y((point) => priceY.value(point.spot))(props.result.rows),
);
const inspectedDay = computed(() => row.value.elapsed / 86400);
function inspect(event) {
  const rect = event.currentTarget.getBoundingClientRect();
  const seconds =
    x.value.invert(((event.clientX - rect.left) / rect.width) * W) * 86400;
  const rows = props.result.rows;
  let low = 0,
    high = rows.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (rows[mid].elapsed <= seconds) low = mid;
    else high = mid - 1;
  }
  selected.value = low;
}
function keyInspect(event) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End", "Escape"].includes(event.key))
    return;
  event.preventDefault();
  if (event.key === "Escape") {
    selected.value = null;
    return;
  }
  const last = props.result.rows.length - 1;
  const current = selected.value ?? last;
  selected.value =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? last
        : Math.max(
            0,
            Math.min(last, current + (event.key === "ArrowRight" ? 1 : -1)),
          );
}
</script>

<template>
  <section
    class="sim-performance"
    aria-label="Simulation performance"
  >
    <div class="performance-actions">
      <span class="performance-time">{{
        selected == null ? exitLabel : `Day ${inspectedDay.toFixed(3)}`
      }}</span>
      <button type="button" class="performance-export" @click="emit('export')">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 3v12m-5-5 5 5 5-5M5 15v5h14v-5" /></svg
        >Export CSV
      </button>
    </div>
    <div class="performance-scroll" @pointerleave="selected = null">
      <div class="performance-plots">
        <header class="performance-heading pnl-heading">
          <div>
            <h2>{{ result.config.asset }} position P&L</h2>
            <p class="performance-subtitle">
              {{ result.legs.length }} option {{ result.legs.length === 1 ? "leg" : "legs" }} ·
              {{ (result.config.horizon / 86400).toFixed(2) }} days ·
              {{ mixedMaturities ? `exit at ${exitDescription}` : "hold to expiry" }}
            </p>
          </div>
          <div class="pnl-key" aria-label="P&L line legend">
            <span
              v-for="series in definitions"
              :key="series.key"
              class="performance-value"
              :data-series="series.key"
              ><i
                :class="`line-key-${series.key}`"
                :style="{
                  borderColor:
                    series.key === 'total' ? signColor(row.pnl) : series.color,
                }"
              ></i
              >{{ series.label }}
              <strong>{{ money(series.value(row)) }}</strong></span
            >
          </div>
        </header>
        <svg
          class="pnl-chart"
          :viewBox="`0 0 ${W} ${H}`"
          tabindex="0"
          role="img"
          aria-label="Option, hedge and total P&L in USD. Use left and right arrows to inspect; Escape returns to expiry."
          @pointermove="inspect"
          @pointerdown="inspect"
          @keydown="keyInspect"
        >
          <defs>
            <linearGradient
              :id="`${gradientId}-line`"
              gradientUnits="userSpaceOnUse"
              x1="0"
              :y1="margin.top"
              x2="0"
              :y2="H - margin.bottom"
            >
              <stop offset="0" :stop-color="GAIN" />
              <stop :offset="zeroOffset" :stop-color="GAIN" />
              <stop :offset="zeroOffset" :stop-color="LOSS" />
              <stop offset="1" :stop-color="LOSS" />
            </linearGradient>
            <linearGradient
              :id="`${gradientId}-area`"
              gradientUnits="userSpaceOnUse"
              x1="0"
              :y1="fillRange.top"
              x2="0"
              :y2="fillRange.bottom"
            >
              <stop offset="0" :stop-color="GAIN" stop-opacity=".42" />
              <stop
                :offset="fillRange.zero * 0.55"
                :stop-color="GAIN"
                stop-opacity=".22"
              />
              <stop
                :offset="fillRange.zero"
                :stop-color="GAIN"
                stop-opacity=".06"
              />
              <stop
                :offset="fillRange.zero"
                :stop-color="LOSS"
                stop-opacity=".06"
              />
              <stop
                :offset="fillRange.zero + (1 - fillRange.zero) * 0.45"
                :stop-color="LOSS"
                stop-opacity=".22"
              />
              <stop offset="1" :stop-color="LOSS" stop-opacity=".42" />
            </linearGradient>
          </defs>
          <path
            class="total-pnl-area"
            :d="totalArea"
            :fill="`url(#${gradientId}-area)`"
          />
          <g v-for="tick in y.ticks(6)" :key="tick">
            <text :x="margin.left - 12" :y="y(tick) + 4" text-anchor="end">
              {{ format(",.0f")(tick) }}
            </text>
          </g>
          <line
            :x1="margin.left"
            :x2="W - margin.right"
            :y1="y(0)"
            :y2="y(0)"
            stroke="#303030"
          />
          <path
            v-for="series in curves"
            :key="series.key"
            :data-series="series.key"
            :d="series.path"
            fill="none"
            :stroke="
              series.key === 'total' ? `url(#${gradientId}-line)` : series.color
            "
            :stroke-width="series.key === 'total' ? 1.5 : 1.35"
            stroke-linecap="round"
            stroke-linejoin="round"
            vector-effect="non-scaling-stroke"
          />
          <g v-if="selected != null" class="performance-cursor">
            <line
              :x1="x(inspectedDay)"
              :x2="x(inspectedDay)"
              :y1="margin.top"
              :y2="H - margin.bottom"
              stroke="#555555"
              stroke-dasharray="2 4"
            />
            <circle
              v-for="series in definitions"
              :key="series.key"
              :cx="x(inspectedDay)"
              :cy="y(series.value(row))"
              r="3"
              :fill="
                series.key === 'total'
                  ? signColor(series.value(row))
                  : series.color
              "
            />
          </g>
          <g v-for="tick in x.ticks(8)" :key="tick">
            <text :x="x(tick)" :y="H - margin.bottom + 22" text-anchor="middle">
              {{ format(".2~f")(tick) }}
            </text>
          </g>
          <text :x="margin.left" :y="14" class="performance-axis-label">
            P&L (USD)
          </text>
          <text
            :x="(margin.left + W - margin.right) / 2"
            :y="H - 10"
            text-anchor="middle"
            class="performance-axis-label"
          >
            Days from entry
          </text>
        </svg>
        <header class="performance-heading index-heading">
          <div>
            <h2>{{ result.config.asset }} index simulation</h2>
            <p class="performance-subtitle">
              {{ (result.config.horizon / 86400).toFixed(2) }} days · annual
              drift {{ (result.config.drift * 100).toFixed(2) }}%
            </p>
          </div>
          <div class="performance-legend">
            <span class="index-time">{{
              selected == null ? exitLabel : `Day ${inspectedDay.toFixed(3)}`
            }}</span>
            <span class="index-price">{{ money(row.spot) }}</span>
            <span class="hedge-dot-legend"
              ><i class="buy-dot"></i>Hedge buy</span
            >
            <span class="hedge-dot-legend"
              ><i class="sell-dot"></i>Hedge sell</span
            >
          </div>
        </header>
        <svg
          class="index-chart"
          :viewBox="`0 0 ${W} ${PRICE_H}`"
          tabindex="0"
          role="img"
          aria-label="Simulated index price in USD with green hedge buys and red hedge sells. Use arrow keys to inspect both charts."
          @pointermove="inspect"
          @pointerdown="inspect"
          @keydown="keyInspect"
        >
          <g v-for="tick in priceY.ticks(5)" :key="tick">
            <text :x="margin.left - 12" :y="priceY(tick) + 4" text-anchor="end">
              {{ format(",.0f")(tick) }}
            </text>
          </g>
          <path
            class="index-price-path"
            :d="pricePath"
            fill="none"
            stroke="#ffffff"
            stroke-width="1"
            vector-effect="non-scaling-stroke"
          />
          <circle
            v-for="(trade, i) in result.trades"
            :key="i"
            class="hedge-trade-dot"
            :class="trade.amount > 0 ? 'buy-dot' : 'sell-dot'"
            :data-side="trade.amount > 0 ? 'buy' : 'sell'"
            :data-trigger="trade.reason"
            :data-elapsed="trade.elapsed"
            :cx="x(trade.elapsed / 86400)"
            :cy="priceY(trade.spot)"
            r="4.5"
            stroke="#000000"
            stroke-width=".8"
          >
            <title>
              {{ trade.amount > 0 ? "Buy" : "Sell" }}
              {{ Math.abs(trade.amount).toFixed(5) }}
              {{ result.config.asset }} · {{ trade.reason }} · day
              {{ (trade.elapsed / 86400).toFixed(4) }} · {{ money(trade.spot) }}
            </title>
          </circle>
          <g v-if="selected != null" class="index-cursor">
            <line
              :x1="x(inspectedDay)"
              :x2="x(inspectedDay)"
              :y1="margin.top"
              :y2="PRICE_H - margin.bottom"
              stroke="#555555"
              stroke-dasharray="2 4"
            />
            <circle
              :cx="x(inspectedDay)"
              :cy="priceY(row.spot)"
              r="3"
              fill="#e8eaed"
            />
          </g>
          <g v-for="tick in x.ticks(8)" :key="tick">
            <text
              :x="x(tick)"
              :y="PRICE_H - margin.bottom + 22"
              text-anchor="middle"
            >
              {{ format(".2~f")(tick) }}
            </text>
          </g>
          <text :x="margin.left" :y="14" class="performance-axis-label">
            Index (USD)
          </text>
        </svg>
      </div>
    </div>
    <p class="performance-note">
      After execution costs · option and hedge P&L sum to total P&L.
    </p>
  </section>
</template>

<style scoped>
.sim-performance {
  --hedge-buy: #00bf8c;
  --hedge-sell: #ff1654;
  background: #000;
  color: #fff;
  padding-bottom: 16px;
}
.performance-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 38px 16px 78px;
}
.performance-time {
  color: #999999;
  font-size: 12px;
}
.performance-export {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  border: 0;
  padding: 0;
  color: #dedede;
  background: transparent;
  font: inherit;
  font-size: 14px;
  cursor: pointer;
}
.performance-export:hover {
  color: #fff;
}
.performance-export svg {
  width: 20px;
  height: 20px;
  min-width: 0;
}
.performance-export path {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.performance-heading {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 24px;
  padding: 0 38px 14px 78px;
}
h2 {
  color: #fff;
  font-size: 16px;
  font-weight: 500;
  margin: 0 0 8px;
}
.performance-subtitle {
  color: #999999;
  font-size: 12px;
  margin: 0;
  line-height: 1.6;
}
.index-heading .performance-legend {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  align-items: center;
  gap: 12px 20px;
  padding-top: 2px;
  font-size: 12px;
}
.performance-scroll {
  overflow-x: auto;
}
.performance-plots {
  min-width: 650px;
}
.index-heading {
  margin-bottom: 2px;
}
.index-time {
  color: #999999;
  font-size: 11px;
}
.index-price {
  color: #fff;
  font-size: 15px;
  font-variant-numeric: tabular-nums;
}
.hedge-dot-legend {
  white-space: nowrap;
  color: #bbbbbb;
}
.hedge-dot-legend i {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  margin: 0 6px 1px 0;
}
.buy-dot {
  fill: var(--hedge-buy);
  background: var(--hedge-buy);
}
.sell-dot {
  fill: var(--hedge-sell);
  background: var(--hedge-sell);
}
.hedge-trade-dot {
  cursor: help;
}
svg {
  display: block;
  width: 100%;
  min-width: 650px;
  touch-action: pan-y;
}
svg text {
  fill: #c8c8c8;
  font:
    12px "Helvetica Neue",
    Helvetica,
    -apple-system,
    sans-serif;
}
svg:focus-visible {
  outline: 1px solid #666;
  outline-offset: -1px;
}
svg .performance-axis-label {
  fill: #999999;
  font-size: 12px;
}
.performance-value strong {
  color: #fff;
  margin-left: 6px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}
.pnl-key {
  display: flex;
  gap: 20px;
  padding-top: 4px;
  color: #999999;
  font-size: 11px;
  white-space: nowrap;
}
.pnl-key i {
  display: inline-block;
  width: 18px;
  border-top: 1.15px solid;
  border-radius: 1px;
  margin: 0 7px 3px 0;
}
.pnl-key .line-key-total {
  border-top-width: 1.5px;
}
.performance-note {
  color: #999999;
  font-size: 11px;
  margin: 4px 38px 0 78px;
}
@media (max-width: 1100px) {
  .performance-heading {
    flex-direction: column;
    gap: 12px;
  }
  .index-heading .performance-legend {
    justify-content: flex-start;
  }
}
@media (max-width: 650px) {
  .performance-actions {
    padding: 8px 16px 16px;
  }
  .performance-heading {
    padding: 0 16px 14px;
  }
  .performance-note {
    margin-left: 16px;
  }
}
</style>
