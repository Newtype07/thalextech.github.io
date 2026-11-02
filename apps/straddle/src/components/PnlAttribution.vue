<script setup>
import { computed, ref, useId } from "vue";
import * as d3 from "d3";
import { attributePnlPath } from "../pnl-attribution.js";
import { exportChartToPng } from "../../../../lib/export-png.js";

const props = defineProps({
  history: { type: Object, required: true },
  loading: Boolean,
});
const svgRef = ref(null);
const positionSide = ref("long");
const hidden = ref(new Set());
const hoverIndex = ref(null);
const totalAreaId = `straddle-total-${useId()}`;
const SVG_FONT_FAMILY = '"Helvetica Neue", Helvetica, -apple-system, sans-serif';
const money = value => d3.format("$,.2f")(Math.abs(value) < 1e-7 ? 0 : value);
const date = ts => d3.utcFormat("%d %b %y %H:%M")(new Date(ts * 1000));
const state = computed(() => {
  try {
    const quantitySign = positionSide.value === "short" ? -1 : 1;
    return { result: props.history.legs.length ? attributePnlPath({
      ...props.history,
      legs: props.history.legs.map(leg => ({ ...leg, quantity: leg.quantity * quantitySign })),
    }) : null };
  } catch (error) {
    return { result: null, error: error.message };
  }
});
const result = computed(() => state.value.result);
const headline = computed(() => {
  if (!result.value || props.loading) return "P&L";
  const entryMark = Math.abs(result.value.path[0].mark);
  const roi = entryMark > 0 ? d3.format(".1%")(result.value.marked / entryMark) : "—";
  return `${positionSide.value === "short" ? "Short" : "Long"} P&L ${money(result.value.marked)} · ROI ${roi}`;
});
const rangeLabel = computed(() => result.value
  ? date(result.value.path[0].ts) + " - " + date(result.value.path.at(-1).ts) : "");
const palette = d3.schemeRdBu[9];
const seriesConfig = computed(() => [
  { key: "marked", label: "Total", color: palette[4], description: "Marked P&L." },
  { key: "direction", label: "Delta", color: palette[7], description: "Entry delta × index change. Delta stays fixed for the selected trade." },
  { key: "gammaTheta", label: "Gamma − Theta", color: palette[6], description: "Convexity after time decay: Gamma plus signed Theta P&L, both from full revaluation." },
  { key: "vol", label: "Vega", color: palette[2], description: "Full revaluation of fitted implied vol changes, holding spot and time fixed." },
  ...(result.value?.series.some(point => Math.abs(point.canonical.discrepancy) >= 0.005)
    ? [{ key: "discrepancy", label: "Model diff.", color: palette[3], description: "Change in mark minus model value, kept separate from the Greeks." }] : []),
]);
// Time P&L already carries its sign: adding it deducts decay from convexity.
const valueForSeries = (key, marked, buckets) => key === "marked" ? marked
  : key === "gammaTheta" ? buckets.convexity + buckets.time : buckets[key];
const composition = computed(() => result.value ? seriesConfig.value.map(item => ({
  ...item, value: valueForSeries(item.key, result.value.marked, result.value.totals.canonical),
})) : []);
const plot = computed(() => {
  if (!result.value) return null;
  const points = result.value.series;
  const start = points[0].ts;
  const end = points.at(-1).ts;
  const x = d3.scaleLinear().domain([start, end]).range([74, 602]);
  const series = seriesConfig.value.filter(item => !hidden.value.has(item.key)).map(item => ({
    ...item, values: points.map(point => ({ ts: point.ts,
      value: valueForSeries(item.key, point.marked, point.canonical) })),
  }));
  let low = 0;
  let high = 0;
  for (const item of series) for (const point of item.values) {
    low = Math.min(low, point.value);
    high = Math.max(high, point.value);
  }
  const pad = (high - low) * 0.08 || 1;
  const y = d3.scaleLinear().domain([low - pad, high + pad]).nice().range([566, 114]);
  const line = d3.line().x(point => x(point.ts)).y(point => y(point.value)).curve(d3.curveMonotoneX);
  const total = series.find(item => item.key === "marked");
  const totalArea = total ? {
    path: d3.area().x(point => x(point.ts)).y0(y(0)).y1(point => y(point.value)).curve(d3.curveMonotoneX)(total.values),
    zero: y(0),
    positiveY: y(d3.max(total.values, point => Math.max(0, point.value))),
    negativeY: y(d3.min(total.values, point => Math.min(0, point.value))),
  } : null;
  return { x, y, totalArea, series: series.map(item => ({ ...item, path: line(item.values) })),
    xTicks: d3.scaleUtc().domain([new Date(start * 1000), new Date(end * 1000)])
      .ticks(4).map(value => ({ x: x(value.getTime() / 1000), label: d3.utcFormat("%d %b %H:%M")(value) })),
    yTicks: y.ticks(6).map(value => ({ y: y(value), label: d3.format("$,.0f")(value) })),
  };
});
const hovered = computed(() => {
  const point = result.value?.series[hoverIndex.value];
  if (hoverIndex.value === null || !point || !plot.value) return null;
  return { ts: point.ts, x: plot.value.x(point.ts),
    values: plot.value.series.map(item => ({ ...item, value: valueForSeries(item.key, point.marked, point.canonical) })) };
});
const hover = event => {
  if (!plot.value) return;
  const bounds = svgRef.value.getBoundingClientRect();
  if (!bounds.width) return;
  const x = (event.clientX - bounds.left) / bounds.width * 640;
  const y = (event.clientY - bounds.top) / bounds.width * 640;
  if (x < 74 || x > 602 || y < 114 || y > 566) {
    hoverIndex.value = null;
    return;
  }
  hoverIndex.value = d3.bisector(point => point.ts).center(result.value.series, plot.value.x.invert(x));
};
const toggle = key => {
  const next = new Set(hidden.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  hidden.value = next;
};
const exportPng = () => exportChartToPng({
  element: svgRef.value, filename: "straddle-greeks-pnl.png", background: "#0a0b0e",
  prepareSvgClone: clone => clone.querySelectorAll("[data-export-omit]").forEach(node => node.remove()),
});
defineExpose({ exportPng });
</script>

<template>
  <section class="attribution" aria-labelledby="attribution-title" :aria-busy="loading">
    <div class="plot">
      <svg ref="svgRef" viewBox="0 0 640 620" role="img" :aria-label="`${positionSide} position cumulative Greek P&L with delta fixed at entry`" :font-family="SVG_FONT_FAMILY" font-size="11" fill="#70767d" @pointermove="hover" @pointerleave="hoverIndex = null">
        <title>{{ positionSide === "short" ? "Short" : "Long" }} position · Cumulative Greeks P&amp;L · fixed entry delta</title>
        <rect width="640" height="620" fill="#0a0b0e" />
        <defs v-if="plot?.totalArea">
          <linearGradient :id="totalAreaId + '-above'" gradientUnits="userSpaceOnUse" x1="0" x2="0" :y1="plot.totalArea.positiveY" :y2="plot.totalArea.zero">
            <stop offset="0%" :stop-color="palette[7]" stop-opacity="0.42" />
            <stop offset="55%" :stop-color="palette[7]" stop-opacity="0.22" />
            <stop offset="100%" :stop-color="palette[7]" stop-opacity="0.04" />
          </linearGradient>
          <linearGradient :id="totalAreaId + '-below'" gradientUnits="userSpaceOnUse" x1="0" x2="0" :y1="plot.totalArea.negativeY" :y2="plot.totalArea.zero">
            <stop offset="0%" :stop-color="palette[1]" stop-opacity="0.42" />
            <stop offset="55%" :stop-color="palette[1]" stop-opacity="0.22" />
            <stop offset="100%" :stop-color="palette[1]" stop-opacity="0.04" />
          </linearGradient>
          <clipPath :id="totalAreaId + '-above-clip'"><rect x="74" y="114" width="528" :height="plot.totalArea.zero - 114" /></clipPath>
          <clipPath :id="totalAreaId + '-below-clip'"><rect x="74" :y="plot.totalArea.zero" width="528" :height="566 - plot.totalArea.zero" /></clipPath>
        </defs>
        <text id="attribution-title" x="396" y="30" text-anchor="middle" fill="#e8eaed" font-size="16" font-weight="600">{{ headline }}</text>
        <text v-if="result && !loading" class="range" x="320" y="54" text-anchor="middle" font-size="11">Selected: {{ rangeLabel }}</text>
        <g class="position-toggle" data-export-omit role="group" aria-label="Position side" transform="translate(16,10)">
          <rect width="122" height="28" rx="8" fill="#1c1c1e" stroke="#ffffff" stroke-opacity="0.06" />
          <rect class="position-toggle-thumb" x="3" y="3" width="58" height="22" rx="6" fill="#58585c" stroke="#ffffff" stroke-opacity="0.12" :style="{ transform: `translateX(${positionSide === 'short' ? 58 : 0}px)`, filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.4))' }" />
          <g v-for="(side, index) in ['long', 'short']" :key="side" :transform="`translate(${3 + index * 58},0)`" role="button" tabindex="0" :aria-label="side === 'long' ? 'Long position' : 'Short position'" :aria-pressed="positionSide === side" @click="positionSide = side" @keydown.enter.prevent="positionSide = side" @keydown.space.prevent="positionSide = side">
            <rect class="position-toggle-target" width="58" height="28" rx="6" fill="transparent" />
            <text x="29" y="18" text-anchor="middle" font-size="11" font-weight="500" :fill="positionSide === side ? '#ffffff' : '#a1a1a6'">{{ side === "long" ? "Long" : "Short" }}</text>
          </g>
        </g>
        <text v-if="loading" x="320" y="310" text-anchor="middle" role="status">Loading…</text>
        <foreignObject v-else-if="state.error" x="74" y="114" width="528" height="400"><p class="error" role="alert">{{ state.error }}</p></foreignObject>
        <text v-else-if="!result" x="320" y="310" text-anchor="middle">Select two points to see P&amp;L.</text>
        <g v-else>
          <g class="legend" role="group" aria-label="P&L composition in USD; click a component to toggle its chart line">
            <g v-for="(item, index) in composition" :key="item.key" :data-series="item.key" :transform="'translate(' + (74 + (index + 0.5) * 528 / composition.length) + ',0)'" role="button" tabindex="0" :aria-label="item.label" :aria-pressed="!hidden.has(item.key)" @click="toggle(item.key)" @keydown.enter.prevent="toggle(item.key)" @keydown.space.prevent="toggle(item.key)">
              <title>{{ item.description }}</title>
              <g :opacity="hidden.has(item.key) ? 0.35 : 1">
                <text x="0" y="82" text-anchor="middle" font-size="10"><tspan :fill="item.color">━</tspan><tspan dx="5">{{ item.label }}</tspan></text>
              </g>
              <text class="composition-value" x="0" y="100" text-anchor="middle" fill="#a9abb6" font-size="11">{{ money(item.value) }}</text>
            </g>
          </g>
          <g v-for="tick in plot.yTicks" :key="tick.y">
            <line x1="74" x2="602" :y1="tick.y" :y2="tick.y" stroke="#20232c" />
            <text x="64" :y="tick.y + 4" text-anchor="end">{{ tick.label }}</text>
          </g>
          <g v-if="plot.totalArea" class="total-area" pointer-events="none">
            <path :d="plot.totalArea.path" :fill="'url(#' + totalAreaId + '-above)'" :clip-path="'url(#' + totalAreaId + '-above-clip)'" />
            <path :d="plot.totalArea.path" :fill="'url(#' + totalAreaId + '-below)'" :clip-path="'url(#' + totalAreaId + '-below-clip)'" />
          </g>
          <line x1="74" x2="602" :y1="plot.y(0)" :y2="plot.y(0)" stroke="#666d7a" stroke-dasharray="3 4" />
          <g v-for="tick in plot.xTicks" :key="tick.x"><text :x="tick.x" y="590" text-anchor="middle">{{ tick.label }}</text></g>
          <text x="338" y="618" text-anchor="middle">Date (UTC)</text>
          <text transform="translate(16,340) rotate(-90)" text-anchor="middle">Cumulative P&amp;L ($)</text>
          <path v-for="item in plot.series" :key="item.key" class="pnl-line" :data-series="item.key" :d="item.path" fill="none" :stroke="item.color" :stroke-width="item.key === 'marked' ? 2.6 : 1.7" stroke-linecap="round" stroke-linejoin="round" />
          <g v-if="hovered" pointer-events="none">
            <line :x1="hovered.x" :x2="hovered.x" y1="114" y2="566" stroke="#70767d" stroke-dasharray="3 4" />
            <circle v-for="item in hovered.values" :key="item.key" :cx="hovered.x" :cy="plot.y(item.value)" r="3" :fill="item.color" />
          </g>
        </g>
      </svg>
      <div v-if="hovered && !loading" class="tooltip" :class="{ 'tooltip--left': hovered.x > 338 }">
        <div class="tooltip-date">{{ date(hovered.ts) }} UTC</div>
        <div v-for="item in hovered.values" :key="item.key" class="tooltip-value"><span :style="{ color: item.color }">{{ item.label }}</span><span>{{ money(item.value) }}</span></div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.attribution { background: #0a0b0e; color: #e8eaed; font-family: "Helvetica Neue", Helvetica, -apple-system, sans-serif; }
.plot { position: relative; } svg { width: 100%; display: block; }
.legend [role="button"], .position-toggle [role="button"] { cursor: pointer; }
.legend [role="button"]:focus-visible { outline: 1px solid #b9caff; outline-offset: 4px; }
.position-toggle { user-select: none; }
.position-toggle-thumb { transition: transform 200ms cubic-bezier(0.2, 0.8, 0.2, 1); }
.position-toggle [role="button"] { outline: none; }
.position-toggle [role="button"]:hover text { fill: #ffffff; }
.position-toggle [role="button"]:focus-visible .position-toggle-target { stroke: #a8c7fa; stroke-width: 2; }
@media (prefers-reduced-motion: reduce) {
  .position-toggle-thumb { transition: none; }
}
.composition-value { font-variant-numeric: tabular-nums; }
.error { margin: 0; color: #a9abb6; font-size: 12px; line-height: 1.5; }
.tooltip { position: absolute; top: 20%; right: 12px; min-width: 145px; padding: 9px 11px; border: 1px solid #2e3040; border-radius: 6px; background: rgba(0, 0, 0, 0.9); pointer-events: none; font-size: 11px; line-height: 1.6; }
.tooltip--left { right: auto; left: 74px; }
.tooltip-date { color: #a3a9b4; margin-bottom: 4px; }
.tooltip-value { display: flex; justify-content: space-between; gap: 16px; font-variant-numeric: tabular-nums; }
</style>
