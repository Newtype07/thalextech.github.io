<script setup>
import { computed, ref, watch } from 'vue';
import { scaleLinear, scaleUtc } from 'd3';
import { aggregateCandles } from './target-trade.js';
import StyledSelectMenu from '../../../lib/components/StyledSelectMenu.vue';
const props=defineProps({candles:{type:Array,default:()=>[]},spot:Number,target:Number,expiry:Number,now:Number,strike:Number});
const emit = defineEmits(['update:target']);
const TARGET_TICK = 5;
const range=ref(90),hover=ref(null),dragging=ref(false);
let dragScale, dragOffset = 0;
// Keep the price scale independent of the target and selected strike, so neither
// the candles nor the handle move away from the pointer while repricing.

const defaultIntervals = { 30: 14400, 90: 86400, 180: 86400, 365: 604800, 730: 604800 };
const intervalOptions = [
  { value: 3600, label: '1-hour candles' },
  { value: 14400, label: '4-hour candles' },
  { value: 43200, label: '12-hour candles' },
  { value: 86400, label: 'Daily candles' },
  { value: 604800, label: 'Weekly candles' },
];
// Range presets choose the initial density; an explicit interval remains the
// user's choice when changing the displayed history window.
const selectedInterval = ref(null);
const candleView = computed(() => {
  const seconds = selectedInterval.value ?? defaultIntervals[range.value];
  return { seconds, label: intervalOptions.find(option => option.value === seconds).label,
    anchor: seconds === 604800 ? 4 * 86400 : 0 };
});
const rows = computed(() => {
  const from = (props.candles.at(-1)?.[0] ?? 0) - range.value * 86400;
  return aggregateCandles(props.candles.filter(row => row[0] >= from),
    candleView.value.seconds, candleView.value.anchor);
});
const candleDate = ts => candleView.value.seconds < 86400
  ? `${date(ts)} ${new Date(ts * 1000).toISOString().slice(11, 16)} UTC`
  : date(ts);
const x=computed(()=>scaleUtc().domain([new Date((rows.value[0]?.[0]||props.now)*1000),new Date(Math.max(props.now,props.expiry||0)*1000)]).range([15,1320]));
const priceDomain = ref([1, 2]);
watch(rows, () => {
  const values = rows.value.flatMap(r => [r[2], r[3]])
    .filter(value => Number.isFinite(value) && value > 0);
  if (!values.length) return;
  const low = Math.min(...values), high = Math.max(...values);
  const padding = Math.max((high - low) * .05, high * .001, 1);
  priceDomain.value = [Math.max(1, low - padding), high + padding];
}, { immediate: true });
const y = computed(() => scaleLinear().domain(priceDomain.value).range([590, 35]));
const xpos=ts=>x.value(new Date(ts*1000));
const width=computed(()=>Math.max(1,Math.min(9,(xpos((rows.value[0]?.[0]||0)+candleView.value.seconds)-xpos(rows.value[0]?.[0]||0))*.65)));
const money=v=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0}).format(v);
const date=ts=>new Date(ts*1000).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'});
// References outside the candle-fit domain stay reachable at the plot edge.
// The arrow identifies an off-screen price without widening the candle scale.
const referenceY = value => Math.min(590, Math.max(35, y.value(value)));
const offscreen = value => value > priceDomain.value[1] ? ' ↑' : value < priceDomain.value[0] ? ' ↓' : '';
const targetY = computed(() => referenceY(props.target));
const references=computed(()=>[{value:props.target,label:'Target',kind:'target'},{value:props.spot,label:'Spot',kind:'spot'},{value:props.strike,label:'Strike',kind:'strike'}].filter(r=>Number.isFinite(r.value)&&r.value>0));
// All price annotations use the same scale and label anchor. Do not move
// individual labels into lanes: that makes a strike appear at another price.
const labels = computed(() => references.value.map(reference => ({
  ...reference, top: referenceY(reference.value),
})));

const targetLabel = computed(() => labels.value.find(r => r.kind === 'target'));
const targetX = computed(() => props.expiry ? xpos(props.expiry) : 1320);
const targetMin = computed(() => Math.max(TARGET_TICK, Math.ceil(y.value.domain()[0] / TARGET_TICK) * TARGET_TICK));
const targetMax = computed(() => Math.max(TARGET_TICK, Math.floor(y.value.domain()[1] / TARGET_TICK) * TARGET_TICK));
function pointerY(event) {
  const svg = event.currentTarget.ownerSVGElement;
  const matrix = svg?.getScreenCTM();
  if (!matrix) return null;
  const point = svg.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  return point.matrixTransform(matrix.inverse()).y;
}
function updateTarget(value) {
  emit('update:target', Math.max(TARGET_TICK, Math.round(value / TARGET_TICK) * TARGET_TICK));
}
function startDrag(event) {
  if (event.button !== 0) return;
  const position = pointerY(event);
  if (position == null) return;
  event.preventDefault();
  event.currentTarget.focus();
  event.currentTarget.setPointerCapture(event.pointerId);
  dragScale = y.value.copy();
  dragOffset = position - targetY.value;
  dragging.value = true;
  hover.value = null;
}
function moveDrag(event) {
  if (!dragging.value) return;
  const position = pointerY(event);
  if (position != null) updateTarget(dragScale.invert(position - dragOffset));
}
function endDrag() {
  dragging.value = false;
}
function keyTarget(event) {
  const step = event.shiftKey ? 100 : TARGET_TICK;
  const values = { ArrowUp: props.target + step, ArrowRight: props.target + step,
    ArrowDown: props.target - step, ArrowLeft: props.target - step,
    Home: targetMin.value, End: targetMax.value };
  if (!(event.key in values)) return;
  event.preventDefault();
  updateTarget(values[event.key]);
}
</script>
<template>
<section class="chart" aria-label="BTC candlesticks and expiry target">
  <div class="chart-meta"><StyledSelectMenu class="toolbar-select" id="candle-interval" :model-value="candleView.seconds" label="Candle interval" :options="intervalOptions" @update:model-value="selectedInterval = Number($event)"/><slot name="controls"/><div class="ranges"><button v-for="d in [30,90,180,365,730]" :key="d" :class="{active:range===d}" @click="range=d">{{ d>=365?`${d/365}Y`:`${d}D` }}</button></div></div>
  <div class="ohlc muted" aria-live="polite"><template v-if="hover">{{candleDate(hover[0])}} &nbsp; O {{money(hover[1])}} &nbsp; H {{money(hover[2])}} &nbsp; L {{money(hover[3])}} &nbsp; C {{money(hover[4])}}</template><template v-else>Observed history · hover a candle for OHLC</template></div>
  <div v-if="rows.length" class="chart-scroll"><svg viewBox="0 0 1440 640" role="group" :aria-label="`Observed Bitcoin ${candleView.label} with draggable target at expiry`">
    <g class="axis"><text v-for="t in x.ticks(5)" :key="+t" :x="x(t)" y="630" text-anchor="middle">{{t.toLocaleDateString('en-GB',{day:'numeric',month:'short',timeZone:'UTC'})}}</text></g>
    <g v-for="r in rows" :key="r[0]" v-memo="[r, x, y, width]" :class="['candle',r[4]>=r[1]?'up':'down']" @mouseenter="hover=r" @mouseleave="hover=null"><title>{{candleDate(r[0])}} · O {{money(r[1])}} H {{money(r[2])}} L {{money(r[3])}} C {{money(r[4])}}</title><line :x1="xpos(r[0])" :x2="xpos(r[0])" :y1="y(r[2])" :y2="y(r[3])"/><rect :x="xpos(r[0])-width/2" :y="Math.min(y(r[1]),y(r[4]))" :width="width" :height="Math.max(1,Math.abs(y(r[1])-y(r[4])))"/><rect class="hitbox" :x="xpos(r[0])-width" y="30" :width="width*2" height="570"/></g>
    <line v-for="r in references.filter(r => r.kind === 'strike' && !offscreen(r.value))" :key="r.kind" :class="['reference',r.kind]" x1="15" x2="1330" :y1="y(r.value)" :y2="y(r.value)"/>
    <g v-if="expiry && target>0"><line class="expiry" :x1="xpos(expiry)" :x2="xpos(expiry)" y1="30" y2="600"/><text class="expiry-label" :x="xpos(expiry)-8" y="20" text-anchor="end">{{date(expiry)}} · expiry</text></g>
    <g v-for="r in labels.filter(r => r.kind !== 'target')" :key="r.kind"><text :class="['direct',r.kind]" x="1348" :y="r.top-4">{{r.label}}{{offscreen(r.value)}}</text><text class="direct value" x="1348" :y="r.top+10">{{money(r.value)}}</text></g>
    <g v-if="targetLabel" class="target-control" :class="{dragging}" role="slider" tabindex="0"
      aria-label="Target price in USD" aria-orientation="vertical" :aria-valuenow="target"
      :aria-valuemin="Math.min(target, targetMin)" :aria-valuemax="Math.max(target, targetMax)" :aria-valuetext="money(target)"
      aria-describedby="target-help" @keydown="keyTarget" @pointerdown="startDrag"
      @pointermove="moveDrag" @pointerup="endDrag" @pointercancel="endDrag" @lostpointercapture="endDrag">
      <line class="target-hit" x1="15" :x2="targetX" :y1="targetY" :y2="targetY"/>
      <line class="target-line" x1="15" :x2="targetX" :y1="targetY" :y2="targetY"/>
      <circle :cx="targetX" :cy="targetY" r="4" fill="white"/>
      <path class="target-label-hit" :d="`M1338,${targetLabel.top-22} h100 v48 h-100 Z`"/>
      <circle class="target-dot-hit" :cx="targetX" :cy="targetY" r="16"/>
      <text class="direct target" x="1348" :y="targetLabel.top-4">Target{{offscreen(target) || ' ↕'}}</text>
      <text class="direct value" x="1348" :y="targetLabel.top+10">{{money(target)}}</text>
    </g>
  </svg></div>
  <div v-else class="chart-empty">Loading observed BTC candles…</div>
  <div class="chart-foot muted"><span>White: up · grey: down · <span id="target-help">Drag the target line or its price label · arrow keys adjust $5</span></span><span v-if="candles.length">Latest candle in progress</span></div>
</section>
</template>
<style scoped>
.chart{min-width:0}.chart-scroll{overflow-x:auto}@media(max-width:600px){.chart-scroll svg{min-width:700px}}.chart-meta,.chart-foot{display:flex;justify-content:space-between;gap:16px;font-size:12px}.chart-meta{align-items:center;flex-wrap:wrap;padding-right:8.333333%}.ranges{display:flex;gap:14px;margin-left:auto}.ranges button{padding:0;border:0;background:none;color:#777;font:inherit;cursor:pointer}.ranges button.active{color:#fff}.ohlc{height:30px;padding-top:10px;font-size:11px}svg{width:100%;display:block;overflow:visible}.axis{fill:#777;font-size:11px}.candle line{stroke-width:1}.up{stroke:#eee;fill:#eee}.down{stroke:#777;fill:#444}.hitbox{fill:transparent;stroke:none}.reference{stroke:#555;stroke-width:.7;fill:none;stroke-dasharray:3 5}.reference.strike{stroke:#777}.target-control{cursor:ns-resize;touch-action:none;-webkit-tap-highlight-color:transparent}.target-control,.target-control:hover,.target-control:focus,.target-control:focus-visible{outline:none;border:none;box-shadow:none}.target-hit{stroke:transparent;stroke-width:32;pointer-events:stroke}.target-line{stroke:#eee;stroke-width:1;pointer-events:none}.target-label-hit,.target-dot-hit{fill:transparent;stroke:none;pointer-events:all}.target-control text{pointer-events:bounding-box;user-select:none;outline:none}.target-control.dragging .target-line{stroke-width:1.5}.expiry{stroke:#333;stroke-dasharray:2 5}.direct{font-size:10px;fill:#aaa}.direct.target,.value{fill:#eee}.expiry-label{font-size:11px;fill:#aaa}.chart-foot{font-size:11px;margin-top:12px;flex-wrap:wrap}.chart-empty{min-height:360px;display:grid;place-items:center;color:#777}
</style>
