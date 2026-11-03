<script setup>
import { computed, ref, watch } from "vue";
import { bisectRight, extent, format, line, scaleLinear, curveStepAfter } from "d3";

const props = defineProps({ result: { type: Object, required: true } });
const emit = defineEmits(["export"]);
const selected = ref(null);
watch(() => props.result, () => { selected.value = null; });
const W = 1280, H = 520;
const margin = { top: 24, right: 38, bottom: 58, left: 78 };
const money = format("$,.0f");
const index = computed(() => selected.value ?? props.result.elapsed.length - 1);
const day = computed(() => props.result.elapsed[index.value] / 86400);
const x = computed(() => scaleLinear()
  .domain([0, props.result.config.horizon / 86400])
  .range([margin.left, W - margin.right]));
const y = computed(() => {
  let low = 0, high = 0;
  for (const path of props.result.paths) {
    const limits = extent(path.pnl);
    low = Math.min(low, limits[0]);
    high = Math.max(high, limits[1]);
  }
  const pad = (high - low || 1) * 0.08;
  return scaleLinear().domain([low - pad, high + pad]).nice(6)
    .range([H - margin.bottom, margin.top]);
});
const draw = computed(() => line().curve(curveStepAfter)
  .x((_, i) => x.value(props.result.elapsed[i] / 86400))
  .y(value => y.value(value)));
const paths = computed(() => props.result.paths.map(path => ({ seed: path.seed, d: draw.value(path.pnl) })));
const medianPath = computed(() => draw.value(props.result.median));
function inspect(event) {
  const rect = event.currentTarget.getBoundingClientRect();
  const seconds = x.value.invert((event.clientX - rect.left) / rect.width * W) * 86400;
  selected.value = Math.max(0, Math.min(props.result.elapsed.length - 1,
    bisectRight(props.result.elapsed, seconds) - 1));
}
function keyInspect(event) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End", "Escape"].includes(event.key)) return;
  event.preventDefault();
  const last = props.result.elapsed.length - 1;
  selected.value = event.key === "Escape" ? null : event.key === "Home" ? 0 : event.key === "End" ? last
    : Math.max(0, Math.min(last, index.value + (event.key === "ArrowRight" ? 1 : -1)));
}
</script>

<template>
  <section class="sim-ensemble" aria-label="100-run P&L simulation">
    <div class="ensemble-actions">
      <span>{{ selected == null ? 'At exit' : `Day ${day.toFixed(3)}` }}</span>
      <button type="button" @click="emit('export')">Export CSV</button>
    </div>
    <header class="ensemble-heading">
      <div>
        <h2>{{ result.config.asset }} P&L · 100 runs</h2>
        <p>{{ (result.config.horizon / 86400).toFixed(2) }} days · total P&L after option and hedge costs</p>
      </div>
      <div class="ensemble-legend">
        <span><i class="paths-key"></i>100 individual runs</span>
        <span><i class="median-key"></i>Median <strong>{{ money(result.median[index]) }}</strong></span>
      </div>
    </header>
    <div class="ensemble-scroll" @pointerleave="selected = null">
      <svg class="ensemble-chart" :viewBox="`0 0 ${W} ${H}`" role="img" tabindex="0"
        aria-label="100 total P&L paths and their median in USD. Use left and right arrows to inspect; Escape returns to exit."
        @pointermove="inspect" @pointerdown="inspect" @keydown="keyInspect">
        <g v-for="tick in y.ticks(6)" :key="tick">
          <text :x="margin.left - 12" :y="y(tick) + 4" text-anchor="end">{{ format(',.0f')(tick) }}</text>
        </g>
        <line :x1="margin.left" :x2="W - margin.right" :y1="y(0)" :y2="y(0)" stroke="#303030" />
        <path v-for="path in paths" :key="path.seed" class="ensemble-path" :d="path.d"
          fill="none" stroke="#aaaaaa" stroke-opacity=".22" stroke-width=".8" vector-effect="non-scaling-stroke" />
        <path class="ensemble-median" :d="medianPath" fill="none" stroke="#00bf8c"
          stroke-width="2.5" vector-effect="non-scaling-stroke" />
        <g v-if="selected != null" class="ensemble-cursor">
          <line :x1="x(day)" :x2="x(day)" :y1="margin.top" :y2="H - margin.bottom"
            stroke="#666" stroke-dasharray="2 4" />
          <circle :cx="x(day)" :cy="y(result.median[index])" r="4" fill="#00bf8c" />
        </g>
        <g v-for="tick in x.ticks(8)" :key="tick">
          <text :x="x(tick)" :y="H - margin.bottom + 22" text-anchor="middle">{{ format('.2~f')(tick) }}</text>
        </g>
        <text :x="margin.left" y="14">P&L (USD)</text>
        <text :x="(margin.left + W - margin.right) / 2" :y="H - 10" text-anchor="middle">Days from entry</text>
      </svg>
    </div>
    <p class="ensemble-note">The median is calculated across all 100 runs at each time; it is not an individual run.
      The chart and CSV show up to 1,200 sampled timestamps per run. Simulation and hedging use one-minute steps.</p>
  </section>
</template>

<style scoped>
.sim-ensemble { color: #999; background: #000; }
.ensemble-actions { display: flex; align-items: center; justify-content: space-between; padding: 8px 38px 24px 78px; font-size: 11px; }
.ensemble-actions button { border: 0; background: transparent; color: #dedede; font: inherit; font-size: 14px; cursor: pointer; }
.ensemble-actions button:hover { color: #fff; }
.ensemble-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; padding: 0 38px 14px 78px; }
h2 { color: #fff; font-size: 16px; font-weight: 500; margin: 0 0 8px; }
.ensemble-heading p { margin: 0; font-size: 12px; line-height: 1.6; }
.ensemble-legend { display: flex; flex-wrap: wrap; gap: 12px 20px; padding-top: 4px; font-size: 11px; white-space: nowrap; }
.ensemble-legend i { display: inline-block; width: 18px; margin: 0 7px 3px 0; border-top: 1px solid #888; }
.ensemble-legend .median-key { border-top: 2.5px solid #00bf8c; }
.ensemble-legend strong { color: #fff; font-weight: 500; margin-left: 6px; font-variant-numeric: tabular-nums; }
.ensemble-scroll { overflow-x: auto; }
svg { display: block; width: 100%; min-width: 650px; touch-action: pan-y; }
svg text { fill: #c8c8c8; font: 12px "Helvetica Neue", Helvetica, sans-serif; }
svg:focus-visible, button:focus-visible { outline: 1px solid #666; outline-offset: -1px; }
.ensemble-note { margin: 8px 38px 0 78px; font-size: 11px; line-height: 1.7; }
@media (max-width: 1100px) { .ensemble-heading { flex-direction: column; gap: 12px; } }
@media (max-width: 650px) {
  .ensemble-actions { padding: 8px 16px 20px; }
  .ensemble-heading { padding: 0 16px 14px; }
  .ensemble-note { margin-left: 16px; margin-right: 16px; }
}
</style>
