<script setup>
import * as d3 from "d3";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { exportChartToPng } from "../../../../lib/export-png.js";
import { calcConditionalWinningPrice, calcOptionNd2 } from "../lib/breakEvenSnapshot.js";
import IndexBreakEvenChart from "../../../../lib/components/IndexBreakEvenChart.vue";

import { buildTrackProbabilityHistory } from "../lib/trackSelection.js";

const props = defineProps({
  tracks: { type: Array, default: () => [] },
  indexData: { type: Array, default: () => [] },
  indexProjectedData: { type: Array, default: () => [] },
  spotPrice: { type: Number, default: null },
  spotTs: { type: Number, default: null },
  expiryTs: { type: Number, default: null },
  currentTs: { type: Number, default: null },
  title: { type: String, default: "BTC Latest Break-Evens and Price History" },
  subtitle: { type: String, default: "" },
  loading: { type: Boolean, default: false },
  selectedInstrument: { type: String, default: null },
  selectedOption: { type: Object, default: null },
  detailView: { type: String, default: "break-even" },
});

const emit = defineEmits(["update:selectedInstrument", "update:detailView"]);
const svgRef = ref(null);
let resizeObserver = null;
const selectedInstrument = computed({
  get: () => props.selectedInstrument,
  set: value => emit("update:selectedInstrument", value),
});
const detailView = computed({
  get: () => props.detailView,
  set: value => emit("update:detailView", value),
});
const priceChartRef = ref(null);
const overviewPriceChartRef = ref(null);
const selectedTrack = computed(() => props.tracks.find(track => track.instrumentName === selectedInstrument.value));
const selectedLabel = computed(() => {
  const strike = selectedTrack.value?.strike ?? props.selectedOption?.strike;
  const type = selectedTrack.value?.optionType ?? props.selectedOption?.option_type_normalized;
  return Number.isFinite(strike) ? `${type === "put" ? "Put" : "Call"} ${formatPrice(strike)}` : "";
});
const clearSelection = () => { selectedInstrument.value = null; };

const layout = {
  width: 1800,
  height: 900,
  margin: { top: 96, right: 140, bottom: 78, left: 140 },
};

const CHART_FONT_FAMILY = '"Helvetica Neue", Helvetica, -apple-system, sans-serif';
const formatPrice = d3.format(",.0f");
const formatProb = d3.format(".1%");
const timeToExpiry = computed(() => {
  const valuationTs = Number.isFinite(props.currentTs) ? props.currentTs : props.spotTs;
  return Number.isFinite(props.expiryTs) && Number.isFinite(valuationTs)
    ? props.expiryTs - valuationTs : null;
});
const getWinProbability = track => {
  if (!track) return null;
  return calcOptionNd2({
    optionType: track.optionType,
    spot: props.spotPrice,
    strike: track.currentBreakEven,
    iv: track.referenceIv,
    tauSeconds: timeToExpiry.value,
  });
};
const selectedWinProbability = computed(() => getWinProbability(selectedTrack.value));
const selectedWinningPriceLevels = computed(() => {
  const track = selectedTrack.value;
  if (!track) return [];
  const value = calcConditionalWinningPrice({
    optionType: track.optionType,
    spot: props.spotPrice,
    breakEven: track.currentBreakEven,
    iv: track.referenceIv,
    tauSeconds: timeToExpiry.value,
  });
  return Number.isFinite(value) ? [{
    id: "average-winning-price",
    value,
    label: `AWP = ${formatPrice(value)}`,
    color: "#ffffff",
    tooltip: `Expected terminal index price conditional on expiring ${track.optionType === "put" ? "below" : "above"} break-even, using the same zero-rate, zero-carry lognormal IV model as P(win).`,
  }] : [];
});
const overviewLevels = computed(() => props.tracks.map(track => {
  const probability = getWinProbability(track);
  const probabilityText = Number.isFinite(probability) ? formatProb(probability) : "n/a";
  return {
    id: track.instrumentName,
    value: track.currentBreakEven,
    label: `${track.optionType === "put" ? "P" : "C"} ${formatPrice(track.strike)} · BE ${formatPrice(track.currentBreakEven)} · P(win)=${probabilityText}`,
    tooltip: `Model probability of expiring ${track.optionType === "put" ? "below" : "above"} the break-even price, using the latest implied volatility.`,
    color: track.optionType === "put" ? "#f87171" : "#4ade80",
  };
}));
const selectedSubtitle = computed(() => {
  const track = selectedTrack.value;
  if (!track) return props.subtitle;
  const probabilityAboveStrike = calcOptionNd2({
    optionType: "call",
    spot: props.spotPrice,
    strike: track.strike,
    iv: track.referenceIv,
    tauSeconds: props.expiryTs - props.spotTs,
  });
  const expiry = Number.isFinite(props.expiryTs)
    ? new Date(props.expiryTs * 1000).toISOString().slice(0, 10) : "n/a";
  const probability = Number.isFinite(probabilityAboveStrike) ? formatProb(probabilityAboveStrike) : "n/a";
  return `Expiry ${expiry} · Current probability of expiring above the strike N(d2): ${probability}`;
});
const Y_AXIS_LABEL_PADDING = 72;

const axisStyle = (axisG) => {
  axisG.selectAll("line").remove();
  axisG.selectAll("path").remove();
  axisG
    .selectAll("text")
    .attr("fill", "#70767d")
    .style("font-size", "12px")
    .style("font-family", CHART_FONT_FAMILY);
};

function exportPng({ filename = "break-even.png", scale = 4, padding = 24 } = {}) {
  if (!selectedInstrument.value) {
    overviewPriceChartRef.value?.exportPng({ filename, scale, padding });
    return;
  }
  if (selectedTrack.value && detailView.value === "break-even") {
    priceChartRef.value?.exportPng({ filename, scale, padding });
    return;
  }
  exportChartToPng({
    element: svgRef.value,
    filename,
    scale,
    padding,
  });
}

defineExpose({ exportPng });

function render() {
  const svgEl = svgRef.value;
  if (!svgEl) return;

  const svg = d3.select(svgEl);
  svg.selectAll("*").remove();
  const selected = selectedTrack.value;
  if (!selected || detailView.value !== "probability") return;

  const bounds = window.matchMedia("(min-width: 960px)").matches
    ? svgEl.getBoundingClientRect() : null;
  const width = bounds?.width > 0 ? bounds.width : layout.width;
  const height = bounds?.height > 0 ? bounds.height : layout.height;
  const { margin } = layout;
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;

  svg.attr("viewBox", `0 0 ${width} ${height}`);
  svg.attr("preserveAspectRatio", "xMidYMid meet");

  svg
    .append("rect")
    .attr("width", width)
    .attr("height", height)
    .attr("fill", "black");

  svg
    .append("text")
    .attr("x", width / 2)
    .attr("y", 36)
    .attr("text-anchor", "middle")
    .attr("fill", "#e8eaed")
    .style("font-size", "18px")
    .style("font-weight", 650)
    .style("font-family", CHART_FONT_FAMILY)
    .text(`${selectedLabel.value} · Probability and Index History`);

  if (props.subtitle) {
    svg
      .append("text")
      .attr("x", width / 2)
      .attr("y", 62)
      .attr("text-anchor", "middle")
      .attr("fill", "#70767d")
      .style("font-size", "14px")
      .style("font-family", CHART_FONT_FAMILY)
      .text(selectedSubtitle.value);
  }

  const indexActual = (props.indexData || []).filter(
    (point) => point?.date instanceof Date && Number.isFinite(point?.value),
  );
  const probabilityLabel = selected?.optionType === "put" ? "N(-d2)" : "N(d2)";
  const probabilityColor = "#f5f5f7";
  const probabilityHistory = buildTrackProbabilityHistory(selected, indexActual, props.expiryTs);
  if (!probabilityHistory.length) {
    svg.append("text").attr("x", width / 2).attr("y", height / 2)
      .attr("text-anchor", "middle").attr("fill", "#aaa")
      .text("No matching historical IV and index marks available for this selection.");
    return;
  }

  let [domainStart, domainEnd] = d3.extent(probabilityHistory, point => point.date);
  if (+domainStart === +domainEnd) {
    // Center a lone observation using the loaded history's sampling interval.
    const interval = d3.min(d3.pairs(indexActual, (a, b) => +b.date - +a.date).filter(value => value > 0));
    const padding = (interval ?? 60 * 60 * 1000) / 2;
    domainStart = new Date(+domainStart - padding);
    domainEnd = new Date(+domainEnd + padding);
  }
  const visibleIndex = indexActual.filter(point => point.date >= domainStart && point.date <= domainEnd);
  const yValues = visibleIndex.map(point => point.value);

  const minValue = d3.min(yValues) ?? 0;
  const maxValue = d3.max(yValues) ?? 1;
  const range = Math.max(maxValue - minValue, Math.abs(maxValue) * 0.02, 1);
  const domainMin = minValue - range * 0.08;
  const domainMax = maxValue + range * 0.08;

  const x = d3.scaleUtc().domain([domainStart, domainEnd]).range([0, innerWidth]);
  const y = d3
    .scaleLinear()
    .domain([domainMin, domainMax])
    .nice()
    .range([innerHeight, 0]);

  const g = svg
    .append("g")
    .attr("transform", `translate(${margin.left},${margin.top})`);

  const timeAxis = d3.axisBottom(x).ticks(10).tickSize(0).tickPadding(15);
  const ticks = x.ticks(10);
  const tickInterval = ticks.length > 1 ? +ticks[1] - +ticks[0] : +domainEnd - +domainStart;
  timeAxis.tickFormat(d3.utcFormat(tickInterval < 60 * 1000
    ? "%b %d %H:%M:%S"
    : tickInterval < 24 * 60 * 60 * 1000 ? "%b %d %H:%M" : "%b %d"));

  g.append("g")
    .attr("transform", `translate(0,${innerHeight})`)
    .call(timeAxis)
    .call(axisStyle);

  g.append("g")
    .attr("transform", `translate(${innerWidth + 14},0)`)
    .call(
      d3.axisRight(y).ticks(6).tickSize(0).tickPadding(15).tickFormat(d3.format(",.0f")),
    )
    .call(axisStyle);

  g.append("text")
    .attr("x", innerWidth / 2)
    .attr("y", innerHeight + 58)
    .attr("text-anchor", "middle")
    .attr("fill", "#70767d")
    .style("font-size", "12px")
    .style("font-family", CHART_FONT_FAMILY)
    .text("Date (UTC)");

  g.append("text")
    .attr("transform", "rotate(-90)")
    .attr("x", -innerHeight / 2)
    .attr("y", -Y_AXIS_LABEL_PADDING)
    .attr("text-anchor", "middle")
    .attr("fill", "#70767d")
    .style("font-size", "12px")
    .style("font-family", CHART_FONT_FAMILY)
    .text(probabilityLabel);

  const [minProbability, maxProbability] = d3.extent(probabilityHistory, point => point.probability);
  const probabilitySpan = maxProbability - minProbability;
  const probabilityPadding = probabilitySpan > 0
    ? probabilitySpan * 0.1
    : Math.max(Math.abs(maxProbability) * 0.01, 1e-12);
  const probabilityDomain = Number.isFinite(minProbability)
    ? [Math.max(0, minProbability - probabilityPadding), Math.min(1, maxProbability + probabilityPadding)]
    : [0, 1];
  const probabilityY = d3.scaleLinear().domain(probabilityDomain).nice(5).range([innerHeight, 0]);
  probabilityY.domain(probabilityY.domain().map(value => Math.max(0, Math.min(1, value))));
  const latestProbability = probabilityHistory[probabilityHistory.length - 1].probability;
  const latestProbabilityY = probabilityY(latestProbability);
  g.append("line")
    .attr("class", "latestProbabilityLevel")
    .attr("x1", 0).attr("x2", innerWidth)
    .attr("y1", latestProbabilityY).attr("y2", latestProbabilityY)
    .attr("stroke", probabilityColor).attr("stroke-width", 1)
    .attr("opacity", 0.6).attr("pointer-events", "none");
  g.append("g")
    .call(d3.axisLeft(probabilityY).ticks(5).tickSize(0).tickPadding(12).tickFormat(probabilityY.tickFormat(5, "%")))
    .call(axisStyle);
  g.append("text").attr("transform", `translate(${innerWidth + 100},${innerHeight / 2}) rotate(90)`)
    .attr("text-anchor", "middle").attr("fill", "#70767d").style("font-size", "12px")
    .style("font-family", CHART_FONT_FAMILY)
    .text("Index price (USD)");
  const historicalIndexLine = d3.line()
    .x(point => x(point.date))
    .y(point => y(point.value))
    .curve(d3.curveBasis);
  g.append("path").datum(visibleIndex)
    .attr("class", "historicalIndexLine").attr("fill", "none")
    .attr("stroke", "#858b94").attr("stroke-width", 2)
    .attr("stroke-linecap", "round").attr("stroke-linejoin", "round")
    .attr("pointer-events", "none").attr("d", historicalIndexLine);
  if (visibleIndex.length === 1) {
    const point = visibleIndex[0];
    g.append("circle").attr("cx", x(point.date)).attr("cy", y(point.value))
      .attr("r", 2).attr("fill", "#858b94");
  }
  const probabilityLine = d3.line()
    .x(point => x(point.date))
    .y(point => probabilityY(point.probability))
    .curve(d3.curveBasis);
  g.append("path").datum(probabilityHistory)
    .attr("class", "probabilityLine").attr("fill", "none")
    .attr("stroke", probabilityColor).attr("stroke-width", 2)
    .attr("stroke-linecap", "round").attr("stroke-linejoin", "round")
    .attr("d", probabilityLine);
  if (probabilityHistory.length === 1) {
    const point = probabilityHistory[0];
    g.append("circle").attr("cx", x(point.date)).attr("cy", probabilityY(point.probability))
      .attr("r", 2).attr("fill", probabilityColor);
  }
  g.append("text")
    .attr("class", "latestProbabilityLabel")
    .attr("x", innerWidth - 8).attr("y", latestProbabilityY - 10)
    .attr("text-anchor", "end").attr("fill", probabilityColor)
    .attr("paint-order", "stroke").attr("stroke", "#000").attr("stroke-width", 3)
    .attr("pointer-events", "none")
    .style("font-size", "14px").style("font-family", CHART_FONT_FAMILY)
    .text(`Latest ${probabilityLabel} = ${formatProb(latestProbability)}`);
}

watch(
  () => [
    props.tracks,
    props.indexData,
    props.indexProjectedData,
    props.spotPrice,
    props.spotTs,
    props.expiryTs,
    props.currentTs,
    props.title,
    props.subtitle,
    props.loading,
    selectedInstrument.value,
    detailView.value,
  ],
  () => render(),
  { deep: true },
);

onMounted(() => {
  render();
  resizeObserver = new ResizeObserver(render);
  resizeObserver.observe(svgRef.value);
});
onUnmounted(() => resizeObserver?.disconnect());
</script>

<template>
  <div class="chartWrap" @keydown.esc="clearSelection">
    <div class="selectionToolbar" :class="{ 'selectionToolbar--instrument': selectedInstrument }">
      <button v-if="selectedInstrument" class="backButton" type="button" @click="clearSelection">← Back to price context</button>
      <div v-if="selectedInstrument" class="detailToggle" role="group" aria-label="Instrument chart view">
        <button type="button" :aria-pressed="detailView === 'break-even'" @click="detailView = 'break-even'">Break-even price</button>
        <button type="button" :aria-pressed="detailView === 'probability'" @click="detailView = 'probability'">Probability</button>
      </div>
      <span class="selectionLabel">{{ selectedInstrument ? `${selectedLabel} selected` : 'Latest break-even prices · Calls in green, puts in red · Click a line or label to explore.' }}</span>
    </div>
    <IndexBreakEvenChart
      v-if="!selectedInstrument"
      class="priceChart"
      fit-container
      background-color="#000"
      ref="overviewPriceChartRef"
      :actual-data="indexData"
      :projected-data="indexProjectedData"
      :break-even-levels="overviewLevels"
      :index-stroke-width="2"
      :index-curve="d3.curveNatural"
      :current-index="spotPrice"
      :expiry-ts="expiryTs"
      :title="title"
      :subtitle="subtitle"
      :loading="loading"
      @select-break-even="selectedInstrument = $event"
    />
    <IndexBreakEvenChart
      v-if="selectedTrack && detailView === 'break-even'"
      class="priceChart"
      fit-container
      background-color="#000"
      :key="selectedInstrument"
      ref="priceChartRef"
      :actual-data="indexData"
      :projected-data="indexProjectedData"
      :break-even-low="selectedTrack.optionType === 'put' ? selectedTrack.currentBreakEven : null"
      :break-even-high="selectedTrack.optionType === 'call' ? selectedTrack.currentBreakEven : null"
      break-even-low-label="BE"
      break-even-high-label="BE"
      :break-even-label-color="selectedTrack.optionType === 'put' ? '#f87171' : '#4ade80'"
      :break-even-win-probability="selectedWinProbability"
      :reference-levels="selectedWinningPriceLevels"
      :break-even-stroke-width="4"
      :index-stroke-width="2"
      :index-curve="d3.curveNatural"
      :current-index="spotPrice"
      :expiry-ts="expiryTs"
      :title="`${selectedLabel} · Break-Even and Index History`"
      :subtitle="selectedSubtitle"
      :loading="loading"
    />
    <div v-if="selectedInstrument && !selectedTrack" class="selectionEmpty" role="status">{{ loading ? 'Loading selected instrument history…' : 'No history available for this strike and maturity.' }}</div>
    <svg v-show="selectedTrack && detailView === 'probability'" ref="svgRef" class="chartSvg" />
    <div v-if="loading" class="overlay">Loading...</div>
  </div>
</template>

<style scoped>
.selectionToolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 14px; min-height: 36px; padding: 8px 16px; color: #aaa; font-size: 12px; }
.selectionToolbar--instrument { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); }
.selectionToolbar--instrument .detailToggle { justify-self: center; }
.selectionToolbar--instrument .selectionLabel { justify-self: end; text-align: right; }
.selectionToolbar button { padding: 6px 12px; font: inherit; cursor: pointer; }
.selectionToolbar button:focus-visible { outline: 2px solid #aab8cc; outline-offset: 3px; }
.detailToggle { display: flex; gap: 3px; padding: 3px; border: 1px solid #414751; border-radius: 8px; background: #15181d; }
.detailToggle button { border: 0; border-radius: 5px; background: transparent; color: #a9b0ba; }
.detailToggle button:hover { color: white; }
.detailToggle button[aria-pressed="true"] { background: #edf0f4; color: #15181d; font-weight: 600; }
.selectionToolbar .backButton { justify-self: start; border: 1px solid #414751; border-radius: 5px; background: transparent; color: #c2c7cf; }
.selectionToolbar .backButton:hover { background: #20252c; color: white; }
.selectionEmpty { min-height: 320px; display: grid; place-items: center; color: #aaa; font-size: 14px; }
.chartWrap {
  position: relative;
  border-radius: 14px;
  overflow: hidden;
  background: #000;
}

.chartSvg {
  display: block;
  width: 100%;
  height: auto;
}

@media (max-width: 640px) {
  .selectionToolbar--instrument { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  .selectionToolbar--instrument .backButton { grid-column: 1; grid-row: 1; }
  .selectionToolbar--instrument .selectionLabel { grid-column: 2; grid-row: 1; }
  .selectionToolbar--instrument .detailToggle { grid-column: 1 / -1; grid-row: 2; }
}

@media (min-width: 960px) {
  .chartWrap {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }

  .selectionToolbar { flex-shrink: 0; }
  .priceChart { flex: 1; min-height: 0; }
  .chartSvg { flex: 1; height: 0; min-height: 0; }
}

.overlay {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: #fff;
  background: color-mix(in oklab, #000, transparent 40%);
  font-size: 14px;
}
</style>
