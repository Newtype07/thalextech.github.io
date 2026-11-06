<script setup>
import { computed, ref, watch, onMounted, onBeforeUnmount } from "vue";
import { scaleLinear, line, extent, format, bisector, brushX, select, utcFormat } from "d3";

const props = defineProps({ result: { type: Object, required: true } });
const emit = defineEmits(["export", "update:tradeWindow"]);
const brushContainer = ref(null), draftWindow = ref(null);
const selected = ref(null), chartContainer = ref(null), width = ref(1280);
const GAIN = "#32e68a", LOSS = "#ff5c6c";
const signColor = value => value > 0 ? GAIN : value < 0 ? LOSS : "#fff";
const H = 490;
const priceTop = 62, priceBottom = 280, divider = 302, pnlTop = 334, pnlBottom = 452;
const margin = computed(() => ({ left: width.value < 600 ? 62 : 78, right: width.value < 600 ? 16 : 38 }));
let observer;
onMounted(() => {
  const resize = () => { width.value = chartContainer.value?.getBoundingClientRect().width || 1280; };
  resize();
  observer = new window.ResizeObserver(resize);
  observer.observe(chartContainer.value);
  drawBrush();
});
onBeforeUnmount(() => observer?.disconnect());
watch(() => props.result, () => { selected.value = null; });
const money = value => new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 0,
}).format(value);
const definitions = [
  { key: "option", label: "Option", value: row => row.optionPnl - row.optionFees },
  { key: "hedge", label: "Hedge", value: row => row.hedgePnl - row.hedgeFees },
  { key: "total", label: "Total", value: row => row.pnl },
];
const pathRows = computed(() => props.result.pathRows || props.result.rows);
const tradeWindow = computed(() => props.result.tradeWindow || [0, props.result.config.horizon]);
const visibleWindow = computed(() => draftWindow.value || tradeWindow.value);
const hasSelection = computed(() => !!(draftWindow.value || props.result.config.tradeWindow));
const mixedMaturities = computed(() => props.result.legs.some(leg => leg.maturity !== props.result.legs[0].maturity));
const exitDescription = computed(() => {
  if (!props.result.legs.some(leg => Math.abs(leg.maturity - tradeWindow.value[1]) < 1e-6)) return "selected exit";
  if (!mixedMaturities.value) return "expiry";
  const last = Math.max(...props.result.legs.map(leg => leg.maturity));
  if (tradeWindow.value[1] >= last - 1e-6) return "last expiry";
  const first = Math.min(...props.result.legs.map(leg => leg.maturity));
  return Math.abs(tradeWindow.value[1] - first) < 1e-6 ? "first expiry" : "selected expiry";
});
const exitLabel = computed(() => `At ${exitDescription.value}`);
const row = computed(() => props.result.rows[selected.value] || props.result.end);
const inspectedDay = computed(() => row.value.elapsed / 86400);
const x = computed(() => scaleLinear().domain([0, props.result.config.horizon / 86400])
  .range([margin.value.left, width.value - margin.value.right]));
const priceY = computed(() => {
  const [low, high] = extent(pathRows.value, point => point.spot);
  const pad = (high - low || high * 0.01 || 1) * 0.08;
  return scaleLinear().domain([low - pad, high + pad]).nice(5).range([priceBottom, priceTop]);
});
const pnlY = computed(() => {
  const [low, high] = extent([0, ...props.result.rows.map(point => point.pnl)]);
  const pad = (high - low || 1) * .08;
  return scaleLinear().domain([low - pad, high + pad]).nice(3).range([pnlBottom, pnlTop]);
});
const pricePath = computed(() => line().x(point => x.value(point.elapsed / 86400))
  .y(point => priceY.value(point.spot))(pathRows.value));
const observationIndex = bisector(point => point.elapsed).right;
const indexAt = seconds => Math.max(0, Math.min(props.result.rows.length - 1, observationIndex(props.result.rows, seconds) - 1));
// Sample cumulative account values for readable bars. Never sum P&L observations;
// the full minute path and every hedge fill remain available for inspection/export.
const bars = computed(() => {
  const left = x.value(tradeWindow.value[0] / 86400), right = x.value(tradeWindow.value[1] / 86400);
  const count = Math.min(props.result.rows.length, Math.max(12, Math.min(160, Math.floor((right - left) / 12))));
  const spacing = (right - left) / Math.max(1, count - 1);
  return Array.from({ length: count }, (_, i) => {
    const seconds = tradeWindow.value[0] + (tradeWindow.value[1] - tradeWindow.value[0]) * i / Math.max(1, count - 1);
    const point = props.result.rows[indexAt(seconds)];
    const center = x.value(seconds / 86400);
    const start = Math.max(left, center - spacing / 2), end = Math.min(right, center + spacing / 2);
    return { point, start, width: Math.max(1, end - start - 1.5),
      top: Math.min(pnlY.value(0), pnlY.value(point.pnl)), height: Math.max(.8, Math.abs(pnlY.value(point.pnl) - pnlY.value(0))) };
  });
});
const xTicks = computed(() => x.value.ticks(width.value < 500 ? 3 : 7));
const boundaryTime = elapsed => props.result.config.curveTime
  ? utcFormat("%d %b %H:%M UTC")(new Date((props.result.config.curveTime + elapsed) * 1000))
  : `Day ${(elapsed / 86400).toFixed(3)}`;
const boundaries = computed(() => visibleWindow.value.map((elapsed, i) => {
  const point = pathRows.value[bisector(row => row.elapsed).left(pathRows.value, elapsed)];
  return { elapsed, label: i ? "Exit" : "Entry", x: x.value(elapsed / 86400),
    time: boundaryTime(elapsed), price: money(point?.spot),
    anchor: i ? "end" : "start", offset: i ? -6 : 6,
    y: !i && x.value(visibleWindow.value[1] / 86400) - x.value(visibleWindow.value[0] / 86400) < 340 ? priceTop - 26 : priceTop - 8 };
}));
function snapWindow(pixels) {
  if (!pixels) return null;
  const [from, to] = pixels.map(pixel => x.value.invert(pixel) * 86400);
  const times = pathRows.value;
  const first = bisector(row => row.elapsed).left(times, from - 1e-6);
  const last = bisector(row => row.elapsed).right(times, to + 1e-6) - 1;
  return last > first ? [times[first].elapsed, times[last].elapsed] : null;
}
function drawBrush() {
  if (!brushContainer.value) return;
  draftWindow.value = null;
  const group = select(brushContainer.value);
  const brush = brushX().extent([[margin.value.left, priceTop], [width.value - margin.value.right, priceBottom]])
    .filter(event => !event.ctrlKey && !event.button && event.detail < 2)
    .on("brush", event => {
      if (event.sourceEvent) draftWindow.value = snapWindow(event.selection);
    })
    .on("end", event => {
      if (!event.sourceEvent) return;
      emit("update:tradeWindow", snapWindow(event.selection));
      if (!snapWindow(event.selection)) group.call(brush.move, null);
    });
  group.call(brush);
  group.selectAll(".selection, .handle").attr("fill", "transparent").attr("stroke", "none");
  group.on("dblclick", () => {
    draftWindow.value = null;
    group.call(brush.move, null);
    emit("update:tradeWindow", null);
  });
  if (props.result.config.tradeWindow) group.call(brush.move, tradeWindow.value.map(elapsed => x.value(elapsed / 86400)));
  else group.call(brush.move, null);
}
watch([() => props.result, width], drawBrush, { flush: "post" });

function inspect(event) {
  const rect = event.currentTarget.getBoundingClientRect();
  if (!rect.width) return;
  const seconds = x.value.invert((event.clientX - rect.left) / rect.width * width.value) * 86400;
  selected.value = indexAt(seconds);
}
function keyInspect(event) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End", "Escape"].includes(event.key)) return;
  event.preventDefault();
  if (event.key === "Escape") { selected.value = null; return; }
  const last = props.result.rows.length - 1, current = selected.value ?? last;
  selected.value = event.key === "Home" ? 0 : event.key === "End" ? last
    : Math.max(0, Math.min(last, current + (event.key === "ArrowRight" ? 1 : -1)));
}
</script>

<template>
  <section class="sim-performance" aria-label="Simulation performance">
    <div class="performance-readout">
      <span class="performance-time index-time">{{ selected == null ? exitLabel : `Day ${inspectedDay.toFixed(3)}` }}</span>
      <span class="index-readout">Index <strong class="index-price">{{ money(row.spot) }}</strong></span>
      <div class="pnl-key" aria-label="P&L at the selected time">
        <span v-for="series in definitions" :key="series.key" class="performance-value" :data-series="series.key">
          {{ series.label }} <strong>{{ money(series.value(row)) }}</strong>
        </span>
      </div>
      <div class="performance-legend">
        <span class="hedge-dot-legend"><i class="buy-dot"></i>Hedge buy</span>
        <span class="hedge-dot-legend"><i class="sell-dot"></i>Hedge sell</span>
      </div>
      <button type="button" class="performance-export" @click="emit('export')">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5M5 15v5h14v-5" /></svg>Export CSV
      </button>
    </div>
    <div ref="chartContainer" class="performance-plots" @pointerleave="selected = null">
      <svg class="combined-chart" :viewBox="`0 0 ${width} ${H}`" tabindex="0" role="img"
        aria-label="Simulated index price with green hedge buys and red hedge sells above cumulative total P&L bars in USD, sharing one time axis. Use left and right arrows to inspect; Escape returns to exit. Drag the index chart to select trade entry and exit; drag the edges to adjust and double-click to reset."
        @pointermove="inspect" @pointerdown="inspect" @keydown="keyInspect">
        <text :x="margin.left" y="15" class="performance-axis-label">Index · USD</text>
        <g class="index-lane">
          <rect v-if="hasSelection" class="trade-window-background" :x="x(visibleWindow[0] / 86400)" :y="priceTop"
            :width="x(visibleWindow[1] / 86400) - x(visibleWindow[0] / 86400)" :height="priceBottom - priceTop" fill="#202020" />
          <g v-for="tick in priceY.ticks(4)" :key="tick">
            <text :x="margin.left - 12" :y="priceY(tick) + 4" text-anchor="end">{{ format(",.0f")(tick) }}</text>
          </g>
          <path class="index-price-path" :d="pricePath" fill="none" stroke="#fff" stroke-width="1.25" />
          <g v-if="selected != null" class="index-cursor">
            <circle :cx="x(inspectedDay)" :cy="priceY(row.spot)" r="3.5" fill="#eee" stroke="#000" />
          </g>
        </g>
        <g v-if="hasSelection" class="trade-window-spotlight" pointer-events="none" :data-entry-elapsed="visibleWindow[0]" :data-exit-elapsed="visibleWindow[1]">
          <rect class="trade-history-shade" :x="margin.left" :y="priceTop"
            :width="Math.max(0, x(visibleWindow[0] / 86400) - margin.left)" :height="priceBottom - priceTop + 26" fill="#000" fill-opacity=".78" />
          <rect class="trade-history-shade" :x="x(visibleWindow[1] / 86400)" :y="priceTop"
            :width="Math.max(0, width - margin.right - x(visibleWindow[1] / 86400))" :height="priceBottom - priceTop + 26" fill="#000" fill-opacity=".65" />
          <text v-for="boundary in boundaries" :key="boundary.label" class="trade-boundary-label"
            :x="boundary.x + boundary.offset" :y="boundary.y" :text-anchor="boundary.anchor">
            {{ boundary.label }} · {{ boundary.time }} · {{ boundary.price }}
          </text>
        </g>
        <g ref="brushContainer" class="brush" data-export-exclude="" />
        <g class="hedge-trades">
          <circle v-for="(trade, i) in result.trades" :key="i" class="hedge-trade-dot"
            :class="trade.amount > 0 ? 'buy-dot' : 'sell-dot'" :data-side="trade.amount > 0 ? 'buy' : 'sell'"
            :data-trigger="trade.reason" :data-elapsed="trade.elapsed"
            :cx="x(trade.elapsed / 86400)" :cy="priceY(trade.spot)" r="4.5" stroke="#000" stroke-width=".8">
            <title>{{ trade.amount > 0 ? "Buy" : "Sell" }} {{ Math.abs(trade.amount).toFixed(5) }} {{ result.config.asset }} · {{ trade.reason }} · day {{ (trade.elapsed / 86400).toFixed(4) }} · {{ money(trade.spot) }}</title>
          </circle>
        </g>
        <line :x1="margin.left" :x2="width - margin.right" :y1="divider" :y2="divider" stroke="#252528" />
        <text :x="margin.left" :y="pnlTop - 14" class="performance-axis-label">Cumulative P&L · USD</text>
        <g class="pnl-lane">
          <g v-for="tick in pnlY.ticks(3)" :key="tick">
            <text :x="margin.left - 12" :y="pnlY(tick) + 4" text-anchor="end">{{ Math.abs(tick) >= 1000 ? `$${format(".2~s")(tick)}` : money(tick) }}</text>
          </g>
          <line :x1="margin.left" :x2="width - margin.right" :y1="pnlY(0)" :y2="pnlY(0)" stroke="#303030" />
          <rect v-for="(bar, i) in bars" :key="i" class="cumulative-pnl-bar" :data-elapsed="bar.point.elapsed" :data-pnl="bar.point.pnl"
            :x="bar.start" :y="bar.top" :width="bar.width" :height="bar.height" :fill="signColor(bar.point.pnl)" fill-opacity=".45" />
          <g v-if="selected != null" class="performance-cursor">
            <circle :cx="x(inspectedDay)" :cy="pnlY(row.pnl)" r="3.5" :fill="signColor(row.pnl)" />
          </g>
        </g>
        <g class="shared-time-axis">
          <text v-for="(tick, i) in xTicks" :key="tick" :x="x(tick)" y="479"
            :text-anchor="i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'">{{ `${format('.2~f')(tick)}d` }}</text>
        </g>
      </svg>
    </div>
  </section>
</template>

<style scoped>
.sim-performance { --hedge-buy: #00bf8c; --hedge-sell: #ff1654; background: #000; color: #fff; padding: 8px 0 16px; }
.performance-export { display: inline-flex; flex-shrink: 0; align-items: center; gap: 9px; border: 0; padding: 0; color: #dedede; background: transparent; font: inherit; font-size: 12px; cursor: pointer; margin-left: auto; }
.performance-export:hover { color: #fff; }
.performance-export svg { width: 18px; height: 18px; }
.performance-export path { fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.performance-readout, .pnl-key { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 22px; font-size: 12px; color: #999; }
.performance-readout { margin-bottom: 16px; }
.performance-value strong, .index-readout strong { color: #fff; font-weight: 500; margin-left: 6px; font-variant-numeric: tabular-nums; }
.performance-legend { display: flex; flex-wrap: wrap; gap: 8px 20px; color: #bbb; font-size: 12px; margin: 0; }
.hedge-dot-legend { white-space: nowrap; }
.performance-legend i { display: inline-block; width: 7px; height: 7px; margin: 0 6px 1px 0; }
.hedge-dot-legend i { border-radius: 50%; }
.buy-dot { fill: var(--hedge-buy); background: var(--hedge-buy); }
.sell-dot { fill: var(--hedge-sell); background: var(--hedge-sell); }
.hedge-trade-dot { cursor: help; }
.performance-plots { width: 100%; min-width: 0; }
.combined-chart { display: block; width: 100%; touch-action: pan-y; outline: none; }
.combined-chart text { fill: #c8c8c8; font: 12px "Helvetica Neue", Helvetica, -apple-system, sans-serif; }
.combined-chart .trade-boundary-label { font-size: 10px; }
.combined-chart .performance-axis-label { fill: #aaa; }
</style>
