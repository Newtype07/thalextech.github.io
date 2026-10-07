<script setup>
import * as d3 from "d3";
import { onMounted, onUnmounted, ref, watch } from "vue";
import { exportChartToPng } from "../export-png.js";

const props = defineProps({
  actualData: { type: Array, default: () => [] },
  projectedData: { type: Array, default: () => [] },
  breakEvenLow: { type: Number, default: null },
  breakEvenHigh: { type: Number, default: null },
  breakEvenLevels: { type: Array, default: () => [] },
  referenceLevels: { type: Array, default: () => [] },
  breakEvenLowLabel: { type: String, default: "BE Low" },
  breakEvenHighLabel: { type: String, default: "BE High" },
  breakEvenLabelColor: { type: String, default: null },
  breakEvenWinProbability: { type: Number, default: null },
  breakEvenStrokeWidth: { type: Number, default: 2 },
  indexStrokeWidth: { type: Number, default: 1.75 },
  indexCurve: { type: Function, default: d3.curveBasis },
  currentIndex: { type: Number, default: null },
  expiryTs: { type: Number, default: null },
  title: { type: String, default: "BTC Straddle Break-Evens" },
  subtitle: { type: String, default: "" },
  loading: { type: Boolean, default: false },
  enablePriceLevels: { type: Boolean, default: false },
  backgroundColor: { type: String, default: "#0a0b0e" },
  fitContainer: { type: Boolean, default: false },
});

const emit = defineEmits(["select-break-even"]);
const svgRef = ref(null);
let resizeObserver = null;
const priceLevels = ref([]);
const priceLevelHistory = ref([]);
let nextPriceLevelId = 0;
const commitPriceLevels = levels => {
  priceLevelHistory.value = [...priceLevelHistory.value.slice(-99), priceLevels.value];
  priceLevels.value = levels;
};
const undoPriceLevels = () => {
  if (!priceLevelHistory.value.length) return;
  priceLevels.value = priceLevelHistory.value[priceLevelHistory.value.length - 1];
  priceLevelHistory.value = priceLevelHistory.value.slice(0, -1);
};
const clearPriceLevels = () => { if (priceLevels.value.length) commitPriceLevels([]); };
const removePriceLevel = id => {
  commitPriceLevels(priceLevels.value.filter(level => level.id !== id));
};
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
  const spacing = Math.min(PRICE_LABEL_MIN_SPACING, (maxY - minY) / Math.max(1, sorted.length - 1));

  let previousY = minY - spacing;
  for (const label of sorted) {
    label.y = Math.max(label.targetY, previousY + spacing);
    previousY = label.y;
  }

  let nextY = maxY + spacing;
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    sorted[index].y = Math.min(
      sorted[index].y,
      nextY - spacing,
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
  svg.on("click.priceLevels", null);

  const levels = props.breakEvenLevels.filter(level => Number.isFinite(level?.value));
  const referenceLevels = props.referenceLevels.filter(level => Number.isFinite(level?.value));
  const bounds = props.fitContainer && window.matchMedia("(min-width: 960px)").matches
    ? svgEl.getBoundingClientRect() : null;
  const width = bounds?.width > 0 ? bounds.width : layout.width;
  const height = bounds?.height > 0 ? bounds.height : layout.height;
  const margin = levels.length ? { ...layout.margin, right: 420 } : layout.margin;
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;

  svg.attr("viewBox", `0 0 ${width} ${height}`);
  svg.attr("preserveAspectRatio", "xMidYMid meet");

  svg
    .append("rect")
    .attr("width", width)
    .attr("height", height)
    .attr("fill", props.backgroundColor);

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
  yValues.push(...levels.map(level => level.value));
  yValues.push(...referenceLevels.map(level => level.value));
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

  if (props.enablePriceLevels) {
    svg.on("click.priceLevels", event => {
      const [px, py] = d3.pointer(event, g.node());
      if (px < 0 || px > innerWidth || py < 0 || py > innerHeight) return;
      commitPriceLevels([...priceLevels.value, { id: ++nextPriceLevelId, price: y.invert(py) }]);
    });
  }

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

  const selectLevel = (event, level) => {
    event.stopPropagation();
    emit("select-break-even", level.id);
  };
  const levelLines = g.append("g")
    .attr("class", "breakEvenLevels")
    .selectAll("g")
    .data(levels, level => level.id)
    .join("g")
    .attr("role", "button").attr("tabindex", 0)
    .attr("aria-label", level => `Explore ${level.label}${level.tooltip ? `. ${level.tooltip}` : ""}`)
    .style("cursor", "pointer")
    .on("click", selectLevel)
    .on("keydown", (event, level) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectLevel(event, level);
      }
    });
  levelLines.append("line")
    .attr("x1", 0).attr("x2", innerWidth)
    .attr("y1", level => y(level.value)).attr("y2", level => y(level.value))
    .attr("stroke", level => level.color).attr("stroke-width", props.breakEvenStrokeWidth)
    .attr("opacity", 0.7);
  levelLines.append("line")
    .attr("x1", 0).attr("x2", innerWidth)
    .attr("y1", level => y(level.value)).attr("y2", level => y(level.value))
    .attr("stroke", "transparent").attr("stroke-width", 12);
  levelLines.append("title").text(level => level.tooltip ?? level.label);

  const referenceLines = g.append("g")
    .attr("class", "referencePriceLevels")
    .selectAll("line")
    .data(referenceLevels, level => level.id)
    .join("line")
    .attr("x1", 0).attr("x2", innerWidth)
    .attr("y1", level => y(level.value)).attr("y2", level => y(level.value))
    .attr("stroke", level => level.color)
    .attr("stroke-width", 1);
  referenceLines.append("title").text(level => level.tooltip ?? level.label);

  const formatPrice = d3.format(",.0f");
  const rightX = innerWidth - 8;
  const currentLabelX = innerWidth + 12;
  const hasCompactBreakEvenRange =
    !levels.length &&
    !referenceLevels.length &&
    Number.isFinite(props.breakEvenLow) &&
    Number.isFinite(props.breakEvenHigh) &&
    Math.abs(y(props.breakEvenLow) - y(props.breakEvenHigh)) <
      COMPACT_BREAK_EVEN_RANGE;
  const priceLabels = [
    ...referenceLevels.map(level => ({
      id: level.id,
      value: level.value,
      color: level.color,
      text: level.label,
      tooltip: level.tooltip,
    })),
    ...levels.map(level => ({
      id: level.id,
      value: level.value,
      color: level.color,
      text: level.label,
      tooltip: level.tooltip,
      selectable: true,
    })),
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
      targetY: y(label.value) - (levels.length ? 0 : PRICE_LABEL_BASELINE_OFFSET),
      x: levels.length ? currentLabelX : rightX,
      textAnchor: levels.length ? "start" : "end",
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
            levels.length || Math.abs(label.y - label.targetY) >
            PRICE_LABEL_LEADER_THRESHOLD,
        )
        .map((label) => ({
          ...label,
          x1: innerWidth,
          x2: levels.length ? currentLabelX - 4 : rightX + 2,
          y1: label.anchorY,
          y2: label.y + (levels.length ? 0 : PRICE_LABEL_BASELINE_OFFSET),
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
    .attr("stroke", props.backgroundColor)
    .attr("stroke-width", 3)
    .text((label) => label.text)
    .attr("role", label => label.selectable ? "button" : null)
    .attr("tabindex", label => label.selectable ? 0 : null)
    .style("cursor", label => label.selectable ? "pointer" : null)
    .on("click", (event, label) => { if (label.selectable) selectLevel(event, label); })
    .on("keydown", (event, label) => {
      if (label.selectable && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        selectLevel(event, label);
      }
    })
    .append("title").text(label => label.tooltip ?? label.text);

  if (Number.isFinite(props.breakEvenWinProbability)) {
    const breakEvenLabel = priceLabels.find(label => label.id.startsWith("break-even-"));
    if (breakEvenLabel) {
      g.append("text")
        .attr("class", "breakEvenWinProbability")
        .attr("x", innerWidth + 12).attr("y", breakEvenLabel.y)
        .attr("text-anchor", "start").attr("fill", "#f5f5f7")
        .style("font-size", "14px").style("font-family", CHART_FONT_FAMILY)
        .attr("paint-order", "stroke").attr("stroke", props.backgroundColor).attr("stroke-width", 3)
        .text(`P(win) = ${d3.format(".1%")(props.breakEvenWinProbability)}`)
        .append("title")
        .text("Model probability of expiring beyond the break-even price: above for calls, below for puts.");
    }
  }

  if (props.enablePriceLevels) {
    const levels = g.append("g").attr("class", "userPriceLevels");
    for (const level of priceLevels.value) {
      const levelY = y(level.price);
      if (levelY < 0 || levelY > innerHeight) continue;
      const annotation = levels.append("g")
        .attr("class", "userPriceLevel").attr("role", "button").attr("tabindex", 0)
        .attr("aria-label", `Price level ${formatPrice(level.price)}. Drag to move; click or press Delete to remove.`)
        .style("cursor", "ns-resize").style("touch-action", "none")
        .on("click", event => { event.stopPropagation(); removePriceLevel(level.id); })
        .on("keydown", event => {
          if (event.key === "Enter" || event.key === " " || event.key === "Delete") {
            event.preventDefault(); removePriceLevel(level.id);
          }
        });
      annotation.append("line")
        .attr("x1", 0).attr("x2", innerWidth).attr("y1", levelY).attr("y2", levelY)
        .attr("stroke", "#aab8cc").attr("stroke-width", 1).attr("stroke-dasharray", "5,4");
      annotation.append("line")
        .attr("x1", 0).attr("x2", innerWidth).attr("y1", levelY).attr("y2", levelY)
        .attr("stroke", "transparent").attr("stroke-width", 12);
      const label = annotation.append("text")
        .attr("x", 8).attr("y", Math.max(14, levelY - 8))
        .attr("fill", "#f5f5f7").style("font-size", "14px").style("font-family", CHART_FONT_FAMILY)
        .attr("paint-order", "stroke").attr("stroke", props.backgroundColor).attr("stroke-width", 3)
        .text(`Price = ${formatPrice(level.price)}`);
      let draggedPrice = level.price;
      annotation.call(d3.drag()
        .container(() => g.node())
        .subject(() => ({ x: 0, y: levelY }))
        .clickDistance(3)
        .on("start", () => { draggedPrice = level.price; })
        .on("drag", event => {
          const draggedY = Math.max(0, Math.min(innerHeight, event.y));
          draggedPrice = y.invert(draggedY);
          // Keep the dragged SVG node alive; commit once on release so the
          // complete move is one undo step and Vue does not rebuild mid-drag.
          annotation.selectAll("line").attr("y1", draggedY).attr("y2", draggedY);
          label.attr("y", Math.max(14, draggedY - 8)).text(`Price = ${formatPrice(draggedPrice)}`);
        })
        .on("end", () => {
          if (draggedPrice !== level.price) {
            commitPriceLevels(priceLevels.value.map(item => item.id === level.id
              ? { ...item, price: draggedPrice } : item));
          }
        }));
    }
  }
}

watch(
  () => [
    props.actualData,
    props.projectedData,
    props.breakEvenLow,
    props.breakEvenHigh,
    props.breakEvenLevels,
    props.referenceLevels,
    props.breakEvenLowLabel,
    props.breakEvenHighLabel,
    props.breakEvenLabelColor,
    props.breakEvenWinProbability,
    props.breakEvenStrokeWidth,
    props.indexStrokeWidth,
    props.indexCurve,
    props.currentIndex,
    props.expiryTs,
    props.title,
    props.subtitle,
    props.loading,
    props.enablePriceLevels,
    props.backgroundColor,
    props.fitContainer,
    priceLevels.value,
  ],
  () => render(),
  { deep: false },
);

onMounted(() => {
  render();
  if (props.fitContainer) {
    resizeObserver = new ResizeObserver(render);
    resizeObserver.observe(svgRef.value);
  }
});
onUnmounted(() => resizeObserver?.disconnect());
</script>

<template>
  <div class="chartWrap" :class="{ 'chartWrap--fit': fitContainer }" :style="{ background: backgroundColor }">
    <div v-if="enablePriceLevels" class="priceLevelControls">
      <span>Click to add a price level. Drag a line or label to move it; click it to remove.</span>
      <button type="button" :disabled="!priceLevelHistory.length" @click="undoPriceLevels">Undo</button>
      <button v-if="priceLevels.length" type="button" @click="clearPriceLevels">Clear levels</button>
    </div>
    <svg ref="svgRef" class="chartSvg" />
    <div v-if="loading" class="overlay">Loading...</div>
  </div>
</template>

<style scoped>
.priceLevelControls { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 6px 16px; color: #a9abb6; font-size: 12px; }
.priceLevelControls button { border: 1px solid #414751; border-radius: 5px; padding: 4px 8px; background: transparent; color: #e8e8ea; font: inherit; cursor: pointer; }
.priceLevelControls button:focus-visible { outline: 2px solid #aab8cc; outline-offset: 2px; }
.priceLevelControls button:disabled { opacity: 0.4; cursor: default; }
.chartWrap {
  position: relative;
  border-radius: 7px;
  overflow: hidden;
}

.chartSvg {
  display: block;
  width: 100%;
  height: auto;
}

@media (min-width: 960px) {
  .chartWrap--fit {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }

  .chartWrap--fit .priceLevelControls { flex-shrink: 0; }

  .chartWrap--fit .chartSvg {
    flex: 1;
    height: 0;
    min-height: 0;
  }
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
