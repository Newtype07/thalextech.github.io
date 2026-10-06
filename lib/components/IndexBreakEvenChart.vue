<script setup>
import * as d3 from "d3";
import { onMounted, ref, watch } from "vue";
import { exportChartToPng } from "../export-png.js";

const props = defineProps({
  actualData: { type: Array, default: () => [] },
  projectedData: { type: Array, default: () => [] },
  breakEvenLow: { type: Number, default: null },
  breakEvenHigh: { type: Number, default: null },
  breakEvenLowLabel: { type: String, default: "BE Low" },
  breakEvenHighLabel: { type: String, default: "BE High" },
  breakEvenLabelColor: { type: String, default: null },
  breakEvenStrokeWidth: { type: Number, default: 2 },
  indexStrokeWidth: { type: Number, default: 1.75 },
  indexCurve: { type: Function, default: d3.curveBasis },
  currentIndex: { type: Number, default: null },
  expiryTs: { type: Number, default: null },
  title: { type: String, default: "BTC Straddle Break-Evens" },
  subtitle: { type: String, default: "" },
  loading: { type: Boolean, default: false },
});

const svgRef = ref(null);
const CHART_FONT_FAMILY =
  '"Helvetica Neue", Helvetica, -apple-system, sans-serif';
const PRICE_LABEL_BASELINE_OFFSET = 10;
const PRICE_LABEL_MIN_SPACING = 20;
const PRICE_LABEL_LEADER_THRESHOLD = 3;
const COMPACT_BREAK_EVEN_RANGE = 72;
const COMPACT_HIGH_LABEL_OFFSET = 14;
const COMPACT_LOW_LABEL_OFFSET = 20;
const CURRENT_LABEL_BASELINE_OFFSET = 4;

const layout = {
  width: 1800,
  height: 900,
  margin: { top: 96, right: 160, bottom: 78, left: 80 },
};

const axisStyle = (axisG) => {
  axisG.selectAll("line").remove();
  axisG.selectAll("path").remove();
  axisG
    .selectAll("text")
    .attr("fill", "#70767d")
    .style("font-size", "12px")
    .style("font-family", CHART_FONT_FAMILY);
};

// Resolve every right-edge price annotation together so nearby values cannot
// claim the same vertical space. The two passes preserve price order while
// keeping the resulting text baselines inside the plot.
const deCollidePriceLabels = (labels, minY, maxY) => {
  const sorted = [...labels].sort((a, b) => a.targetY - b.targetY);

  let previousY = minY - PRICE_LABEL_MIN_SPACING;
  for (const label of sorted) {
    label.y = Math.max(label.targetY, previousY + PRICE_LABEL_MIN_SPACING);
    previousY = label.y;
  }

  let nextY = maxY + PRICE_LABEL_MIN_SPACING;
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    sorted[index].y = Math.min(
      sorted[index].y,
      nextY - PRICE_LABEL_MIN_SPACING,
    );
    nextY = sorted[index].y;
  }
};

function exportPng({ filename = "straddle-break-even.png", scale = 4, padding = 24 } = {}) {
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

  const { width, height, margin } = layout;
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;

  svg.attr("viewBox", `0 0 ${width} ${height}`);
  svg.attr("preserveAspectRatio", "xMidYMid meet");

  svg
    .append("rect")
    .attr("width", width)
    .attr("height", height)
    .attr("fill", "#0a0b0e");

  svg
    .append("text")
    .attr("x", width / 2)
    .attr("y", 36)
    .attr("text-anchor", "middle")
    .attr("fill", "#e8eaed")
    .style("font-size", "18px")
    .style("font-weight", 650)
    .style("font-family", CHART_FONT_FAMILY)
    .text(props.title);

  if (props.subtitle) {
    svg
      .append("text")
      .attr("x", width / 2)
      .attr("y", 62)
      .attr("text-anchor", "middle")
      .attr("fill", "#70767d")
      .style("font-size", "14px")
      .style("font-family", CHART_FONT_FAMILY)
      .text(props.subtitle);
  }

  const actual = (props.actualData || []).filter(
    (d) => d?.date instanceof Date && Number.isFinite(d?.value),
  );

  if (!actual.length) {
    svg
      .append("text")
      .attr("x", width / 2)
      .attr("y", height / 2)
      .attr("text-anchor", "middle")
      .attr("fill", "#70767d")
      .style("font-size", "12px")
      .style("font-family", CHART_FONT_FAMILY)
      .text(props.loading ? "Loading..." : "No data available.");
    return;
  }

  const firstDate = actual[0].date;
  const lastActualDate = actual[actual.length - 1].date;
  const expiryDate = Number.isFinite(props.expiryTs)
    ? new Date(props.expiryTs * 1000)
    : null;
  const maxDate =
    expiryDate instanceof Date && expiryDate > lastActualDate
      ? expiryDate
      : lastActualDate;

  const yValues = [];
  for (const point of actual) {
    if (Number.isFinite(point.value)) yValues.push(point.value);
    if (Number.isFinite(point.low)) yValues.push(point.low);
    if (Number.isFinite(point.high)) yValues.push(point.high);
  }
  if (Number.isFinite(props.breakEvenLow)) yValues.push(props.breakEvenLow);
  if (Number.isFinite(props.breakEvenHigh)) yValues.push(props.breakEvenHigh);
  if (Number.isFinite(props.currentIndex)) yValues.push(props.currentIndex);

  const minBase = d3.min(yValues) ?? 0;
  const maxBase = d3.max(yValues) ?? 1;
  let domainMin = minBase * 0.99;
  let domainMax = maxBase * 1.01;
  if (domainMin === domainMax) {
    const pad = Math.abs(domainMin || 1) * 0.01;
    domainMin -= pad;
    domainMax += pad;
  }

  const x = d3.scaleUtc().domain([firstDate, maxDate]).range([0, innerWidth]);
  const y = d3
    .scaleLinear()
    .domain([domainMin, domainMax])
    .nice()
    .range([innerHeight, 0]);

  const g = svg
    .append("g")
    .attr("transform", `translate(${margin.left},${margin.top})`);

  g.append("g")
    .attr("transform", `translate(0,${innerHeight})`)
    .call(d3.axisBottom(x).ticks(10).tickSize(0).tickPadding(15))
    .call(axisStyle);

  g.append("g")
    .call(d3.axisLeft(y).ticks(5).tickSize(0).tickPadding(15).tickFormat(d3.format(",.0f")))
    .call(axisStyle);

  const line = d3
    .line()
    .x((d) => x(d.date))
    .y((d) => y(d.value))
    .curve(props.indexCurve);

  g.append("path")
    .datum(actual)
    .attr("fill", "none")
    .attr("stroke", "#f5f5f7")
    .attr("stroke-width", props.indexStrokeWidth)
    .attr("stroke-linecap", "round")
    .attr("stroke-linejoin", "round")
    .attr("d", line);

  const projected = (props.projectedData || []).filter(
    (d) => d?.date instanceof Date && Number.isFinite(d?.value),
  );
  if (projected.length >= 2) {
    g.append("path")
      .datum(projected)
      .attr("fill", "none")
      .attr("stroke", "#f5f5f7")
      .attr("stroke-width", props.indexStrokeWidth)
      .attr("stroke-linecap", "round")
      .attr("stroke-linejoin", "round")
      .attr("stroke-dasharray", "6,4")
      .attr("opacity", 0.8)
      .attr("d", line);
  }

  if (Number.isFinite(props.breakEvenLow)) {
    g.append("line")
      .attr("x1", 0)
      .attr("x2", innerWidth)
      .attr("y1", y(props.breakEvenLow))
      .attr("y2", y(props.breakEvenLow))
      .attr("stroke", "firebrick")
      .attr("stroke-width", props.breakEvenStrokeWidth)
      .attr("stroke-linecap", "round");
  }
  if (Number.isFinite(props.breakEvenHigh)) {
    g.append("line")
      .attr("x1", 0)
      .attr("x2", innerWidth)
      .attr("y1", y(props.breakEvenHigh))
      .attr("y2", y(props.breakEvenHigh))
      .attr("stroke", "forestgreen")
      .attr("stroke-width", props.breakEvenStrokeWidth)
      .attr("stroke-linecap", "round");
  }

  const formatPrice = d3.format(",.0f");
  const rightX = innerWidth - 8;
  const currentLabelX = innerWidth + 12;
  const hasCompactBreakEvenRange =
    Number.isFinite(props.breakEvenLow) &&
    Number.isFinite(props.breakEvenHigh) &&
    Math.abs(y(props.breakEvenLow) - y(props.breakEvenHigh)) <
      COMPACT_BREAK_EVEN_RANGE;
  const priceLabels = [
    {
      id: "break-even-low",
      value: props.breakEvenLow,
      color: props.breakEvenLabelColor ?? "firebrick",
      text: Number.isFinite(props.breakEvenLow)
        ? `${props.breakEvenLowLabel} = ${formatPrice(props.breakEvenLow)}`
        : "",
    },
    {
      id: "break-even-high",
      value: props.breakEvenHigh,
      color: props.breakEvenLabelColor ?? "forestgreen",
      text: Number.isFinite(props.breakEvenHigh)
        ? `${props.breakEvenHighLabel} = ${formatPrice(props.breakEvenHigh)}`
        : "",
    },
    {
      id: "current-index",
      value: props.currentIndex,
      color: "#f5f5f7",
      text: Number.isFinite(props.currentIndex)
        ? `Current = ${formatPrice(props.currentIndex)}`
        : "",
    },
  ]
    .filter((label) => Number.isFinite(label.value))
    .map((label) => ({
      ...label,
      anchorY: y(label.value),
      targetY: y(label.value) - PRICE_LABEL_BASELINE_OFFSET,
      x: rightX,
      textAnchor: "end",
    }));

  if (hasCompactBreakEvenRange) {
    for (const label of priceLabels) {
      if (label.id === "break-even-high") {
        label.y = Math.max(14, label.anchorY - COMPACT_HIGH_LABEL_OFFSET);
      } else if (label.id === "break-even-low") {
        label.y = Math.min(
          innerHeight - 6,
          label.anchorY + COMPACT_LOW_LABEL_OFFSET,
        );
      } else {
        label.x = currentLabelX;
        label.y = Math.max(
          14,
          Math.min(
            innerHeight - 6,
            label.anchorY + CURRENT_LABEL_BASELINE_OFFSET,
          ),
        );
        label.textAnchor = "start";
      }
    }
  } else {
    deCollidePriceLabels(priceLabels, 14, innerHeight - 6);
  }

  const leaderLines = hasCompactBreakEvenRange
    ? priceLabels
        .filter((label) => label.id === "current-index")
        .map((label) => ({
          ...label,
          x1: innerWidth,
          x2: label.x - 4,
          y1: label.anchorY,
          y2: label.anchorY,
        }))
    : priceLabels
        .filter(
          (label) =>
            Math.abs(label.y - label.targetY) >
            PRICE_LABEL_LEADER_THRESHOLD,
        )
        .map((label) => ({
          ...label,
          x1: innerWidth,
          x2: rightX + 2,
          y1: label.anchorY,
          y2: label.y + PRICE_LABEL_BASELINE_OFFSET,
        }));

  g.append("g")
    .attr("class", "priceLabelLeaders")
    .selectAll("line")
    .data(leaderLines, (label) => label.id)
    .join("line")
    .attr("x1", (label) => label.x1)
    .attr("x2", (label) => label.x2)
    .attr("y1", (label) => label.y1)
    .attr("y2", (label) => label.y2)
    .attr("stroke", (label) => label.color)
    .attr("stroke-width", 0.75)
    .attr("opacity", 0.65);

  g.append("g")
    .attr("class", "priceLabels")
    .selectAll("text")
    .data(priceLabels, (label) => label.id)
    .join("text")
    .attr("x", (label) => label.x)
    .attr("y", (label) => label.y)
    .attr("text-anchor", (label) => label.textAnchor)
    .attr("fill", (label) => label.color)
    .style("font-size", "14px")
    .style("font-family", CHART_FONT_FAMILY)
    .attr("paint-order", "stroke")
    .attr("stroke", "#0a0b0e")
    .attr("stroke-width", 3)
    .text((label) => label.text);
}

watch(
  () => [
    props.actualData,
    props.projectedData,
    props.breakEvenLow,
    props.breakEvenHigh,
    props.breakEvenLowLabel,
    props.breakEvenHighLabel,
    props.breakEvenLabelColor,
    props.breakEvenStrokeWidth,
    props.indexStrokeWidth,
    props.indexCurve,
    props.currentIndex,
    props.expiryTs,
    props.title,
    props.subtitle,
    props.loading,
  ],
  () => render(),
  { deep: false },
);

onMounted(() => render());
</script>

<template>
  <div class="chartWrap">
    <svg ref="svgRef" class="chartSvg" />
    <div v-if="loading" class="overlay">Loading...</div>
  </div>
</template>

<style scoped>
.chartWrap {
  position: relative;
  border-radius: 7px;
  overflow: hidden;
  background: #0a0b0e;
}

.chartSvg {
  display: block;
  width: 100%;
  height: auto;
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
