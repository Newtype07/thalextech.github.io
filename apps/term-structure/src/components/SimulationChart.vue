<script setup>
import { computed, ref, watch } from "vue";
import { scaleLinear, line, extent, format } from "d3";

const props = defineProps({ result: { type: Object, required: true } });
const selected = ref(null);
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
    maximumFractionDigits: 2,
  }).format(value);
const definitions = [
  {
    key: "option",
    label: "Option P&L",
    color: "#85a7cf",
    value: (row) => row.optionPnl - row.optionFees,
  },
  {
    key: "hedge",
    label: "Hedge P&L",
    color: "#b69b76",
    value: (row) => row.hedgePnl - row.hedgeFees,
  },
  {
    key: "total",
    label: "Total P&L",
    color: "#e8eaed",
    value: (row) => row.pnl,
  },
];
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
      .x((point) => x.value(point.elapsed / 86400))
      .y((point) => y.value(series.value(point)))(props.result.rows),
  })),
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
    const mid = Math.floor((low + high) / 2);
    if (rows[mid].elapsed < seconds) low = mid + 1;
    else high = mid;
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
  <section class="sim-performance" aria-label="Simulation performance">
    <div class="performance-scroll" @pointerleave="selected = null">
      <div class="performance-plots">
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
              selected == null ? "At expiry" : `Day ${inspectedDay.toFixed(3)}`
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
            <line
              :x1="margin.left"
              :x2="W - margin.right"
              :y1="priceY(tick)"
              :y2="priceY(tick)"
              class="performance-grid"
            />
            <text :x="margin.left - 12" :y="priceY(tick) + 4" text-anchor="end">
              {{ format(",.0f")(tick) }}
            </text>
          </g>
          <path
            class="index-price-path"
            :d="pricePath"
            fill="none"
            stroke="#e8eaed"
            stroke-width="1.4"
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
            r="3.5"
            stroke="#08080a"
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
              stroke="#70767d"
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
        <header class="performance-heading pnl-heading">
          <div>
            <h2>{{ result.config.asset }} straddle P&L</h2>
            <p class="performance-subtitle">
              {{ result.config.side === "sell" ? "Short" : "Long" }} ·
              {{ result.config.quantity }} {{ result.config.asset }} per leg ·
              strike {{ money(result.config.strike) }} ·
              {{ (result.config.horizon / 86400).toFixed(2) }} days
            </p>
          </div>
          <div class="performance-legend" aria-live="off">
            <span class="performance-time">{{
              selected == null ? "At expiry" : `Day ${inspectedDay.toFixed(3)}`
            }}</span>
            <span
              v-for="series in definitions"
              :key="series.key"
              class="performance-value"
              :data-series="series.key"
              ><i :style="{ background: series.color }"></i>{{ series.label }}
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
          <g v-for="tick in y.ticks(6)" :key="tick">
            <line
              :x1="margin.left"
              :x2="W - margin.right"
              :y1="y(tick)"
              :y2="y(tick)"
              class="performance-grid"
            />
            <text :x="margin.left - 12" :y="y(tick) + 4" text-anchor="end">
              {{ format(",.0f")(tick) }}
            </text>
          </g>
          <line
            :x1="margin.left"
            :x2="W - margin.right"
            :y1="y(0)"
            :y2="y(0)"
            stroke="#555b63"
            stroke-dasharray="3 5"
          />
          <path
            v-for="series in curves"
            :key="series.key"
            :data-series="series.key"
            :d="series.path"
            fill="none"
            :stroke="series.color"
            :stroke-width="series.key === 'total' ? 2 : 1.25"
            vector-effect="non-scaling-stroke"
          />
          <g v-if="selected != null" class="performance-cursor">
            <line
              :x1="x(inspectedDay)"
              :x2="x(inspectedDay)"
              :y1="margin.top"
              :y2="H - margin.bottom"
              stroke="#70767d"
              stroke-dasharray="2 4"
            />
            <circle
              v-for="series in definitions"
              :key="series.key"
              :cx="x(inspectedDay)"
              :cy="y(series.value(row))"
              r="3"
              :fill="series.color"
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
      </div>
    </div>
    <p class="performance-note">
      After execution costs · option and hedge P&L sum to total P&L.
    </p>
  </section>
</template>

<style scoped>
.sim-performance {
  background: #08080a;
  padding: 22px 0 12px;
}
.performance-heading {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 24px;
  padding: 0 38px 14px 78px;
}
h2 {
  color: var(--color-text);
  font-size: 16px;
  font-weight: 600;
  margin: 0 0 8px;
}
.performance-subtitle {
  color: var(--color-text-muted);
  font-size: 11px;
  margin: 0;
  line-height: 1.6;
}
.performance-legend {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  align-items: center;
  gap: 12px 20px;
  padding-top: 2px;
  font-size: 11px;
}
.performance-time {
  width: 100%;
  text-align: right;
  color: var(--color-text-muted);
  font-size: 10px;
}
.performance-value {
  color: #9299a4;
  white-space: nowrap;
}
.performance-value i {
  display: inline-block;
  width: 14px;
  height: 2px;
  margin: 0 7px 3px 0;
}
.performance-value strong {
  color: var(--color-text);
  font-weight: 500;
  margin-left: 5px;
  font-variant-numeric: tabular-nums;
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
  color: var(--color-text-muted);
  font-size: 10px;
}
.index-price {
  color: var(--color-text);
  font-variant-numeric: tabular-nums;
}
.hedge-dot-legend {
  white-space: nowrap;
  color: #9299a4;
}
.hedge-dot-legend i {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  margin: 0 6px 1px 0;
}
.buy-dot {
  fill: #59b98c;
  background: #59b98c;
}
.sell-dot {
  fill: #d77171;
  background: #d77171;
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
  fill: var(--color-text-muted);
  font:
    10px "Helvetica Neue",
    Helvetica,
    -apple-system,
    sans-serif;
}
svg:focus-visible {
  outline: 1px solid var(--color-border-strong);
  outline-offset: -1px;
}
.performance-grid {
  stroke: #fff;
  stroke-opacity: 0.045;
}
svg .performance-axis-label {
  font-size: 11px;
}
.performance-note {
  color: var(--color-text-muted);
  font-size: 10px;
  margin: 4px 38px 0 78px;
}
@media (max-width: 1100px) {
  .performance-heading {
    flex-direction: column;
    gap: 12px;
  }
  .performance-legend {
    justify-content: flex-start;
  }
  .performance-time {
    width: auto;
    text-align: left;
  }
}
@media (max-width: 650px) {
  .performance-heading {
    padding: 0 16px 14px;
  }
  .performance-legend {
    gap: 10px 16px;
  }
  .performance-time {
    width: 100%;
  }
  .performance-note {
    margin-left: 16px;
  }
}
</style>
