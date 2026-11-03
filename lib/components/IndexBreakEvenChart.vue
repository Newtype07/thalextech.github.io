<script setup>
import * as d3 from "d3";
import { nextTick, onMounted, onUnmounted, ref, useId, watch } from "vue";
import { exportChartToPng } from "../export-png.js";
import { priceLabelPositions } from "../price-label-positions.js";

const props = defineProps({
  actualData: { type: Array, default: () => [] },
  projectedData: { type: Array, default: () => [] },
  breakEvenLow: { type: Number, default: null },
  breakEvenHigh: { type: Number, default: null },
  breakEvenLevels: { type: Array, default: () => [] },
  referenceLevels: { type: Array, default: () => [] },
  rangeBands: { type: Array, default: () => [] },
  rangeMeasurements: { type: Array, default: () => [] },
  timeDomain: { type: Array, default: null },
  priceLabelsOnRight: { type: Boolean, default: false },
  priceFormatter: { type: Function, default: d3.format(",.0f") },
  breakEvenLowLabel: { type: String, default: "BE Low" },
  breakEvenHighLabel: { type: String, default: "BE High" },
  breakEvenLowTooltip: { type: String, default: "Lower terminal index price at which expiry profit is zero, before fees." },
  breakEvenHighTooltip: { type: String, default: "Upper terminal index price at which expiry profit is zero, before fees." },
  breakEvenLabelColor: { type: String, default: null },
  breakEvenWinProbability: { type: Number, default: null },
  breakEvenWinProbabilityTooltip: { type: String, default: "Model probability of expiring beyond the break-even price: above for calls, below for puts." },
  breakEvenStrokeWidth: { type: Number, default: 2 },
  indexStrokeWidth: { type: Number, default: 1.75 },
  indexCurve: { type: Function, default: d3.curveBasis },
  currentIndex: { type: Number, default: null },
  currentIndexTooltip: { type: String, default: "Current — latest available closing price of the underlying index in the loaded history. This is the spot-price input to the chart." },
  expiryTs: { type: Number, default: null },
  title: { type: String, default: "BTC Straddle Break-Evens" },
  subtitle: { type: String, default: "" },
  subtitleTooltip: { type: String, default: "" },
  loading: { type: Boolean, default: false },
  enablePriceLevels: { type: Boolean, default: false },
  backgroundColor: { type: String, default: "#0a0b0e" },
  fitContainer: { type: Boolean, default: false },
});

const emit = defineEmits(["select-break-even"]);
const svgRef = ref(null);
const tooltipRef = ref(null);
const tooltip = ref(null);
const tooltipId = `price-tooltip-${useId()}`;
const projectionClipId = `price-projection-clip-${useId()}`;
let tooltipRequestId = 0;
const hideTooltip = () => {
  tooltipRequestId += 1;
  tooltip.value = null;
};
const showTooltip = async (event, text) => {
  if (!text) return;
  const requestId = ++tooltipRequestId;
  const anchor = event.currentTarget.getBoundingClientRect();
  const x = Number.isFinite(event.clientX) ? event.clientX : anchor.right;
  const y = Number.isFinite(event.clientY) ? event.clientY : anchor.bottom;
  tooltip.value = { text, x: x + 12, y: y + 12 };
  await nextTick();
  if (requestId !== tooltipRequestId || !tooltipRef.value) return;
  const bounds = tooltipRef.value.getBoundingClientRect();
  tooltip.value = {
    text,
    x: Math.max(12, Math.min(x + 12, window.innerWidth - bounds.width - 12)),
    y: Math.max(12, Math.min(y + 12, window.innerHeight - bounds.height - 12)),
  };
};
const dismissTooltipOnEscape = event => {
  if (event.key === "Escape" && tooltip.value) {
    event.stopPropagation();
    hideTooltip();
  }
};
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

function exportPng({ filename = "straddle-break-even.png", scale = 4, padding = 24, priceLabelFontSize } = {}) {
  exportChartToPng({
    element: svgRef.value,
    filename,
    scale,
    padding,
    prepareSvgClone: clone => {
      if (Number.isFinite(priceLabelFontSize) && priceLabelFontSize > 0) {
        d3.select(clone).selectAll(".priceLabels text").style("font-size", `${priceLabelFontSize}px`);
      }
    },
  });
}

defineExpose({ exportPng });

function render() {
  hideTooltip();
  const svgEl = svgRef.value;
  if (!svgEl) return;
  const svg = d3.select(svgEl);
  const formatPrice = props.priceFormatter;
  svg.selectAll("*").remove();
  svg.on("click.priceLevels", null);

  const levels = props.breakEvenLevels.filter(level => Number.isFinite(level?.value));
  const rangeBands = props.rangeBands.map(band => ({
    ...band,
    points: (band.points || []).filter(point => point?.date instanceof Date &&
      Number.isFinite(point.low) && Number.isFinite(point.high)),
  }));
  const referenceLevels = props.referenceLevels.filter(level => Number.isFinite(level?.value));
  const bounds = props.fitContainer && window.matchMedia("(min-width: 960px)").matches
    ? svgEl.getBoundingClientRect() : null;
  const width = bounds?.width > 0 ? bounds.width : layout.width;
  const height = bounds?.height > 0 ? bounds.height : layout.height;
  const margin = {
    ...layout.margin,
    right: levels.length ? 320 : props.priceLabelsOnRight ? 200 : layout.margin.right,
  };
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
      .text(props.subtitle)
      .attr("tabindex", props.subtitleTooltip ? 0 : null)
      .attr("aria-label", props.subtitleTooltip ? `${props.subtitle}. ${props.subtitleTooltip}` : null)
      .attr("aria-describedby", props.subtitleTooltip ? tooltipId : null)
      .style("cursor", props.subtitleTooltip ? "pointer" : null)
      .on("pointerenter", event => showTooltip(event, props.subtitleTooltip))
      .on("pointerleave", hideTooltip)
      .on("focus", event => showTooltip(event, props.subtitleTooltip))
      .on("blur", hideTooltip)
      .on("keydown", dismissTooltipOnEscape);
  }

  const actual = (props.actualData || []).filter(
    (d) => d?.date instanceof Date && Number.isFinite(d?.value),
  );

  if (!actual.length) {
    if (props.loading) return;
    svg
      .append("text")
      .attr("x", width / 2)
      .attr("y", height / 2)
      .attr("text-anchor", "middle")
      .attr("fill", "#70767d")
      .style("font-size", "12px")
      .style("font-family", CHART_FONT_FAMILY)
      .text("No data available.");
    return;
  }

  let firstDate = actual[0].date;
  const lastActualDate = actual[actual.length - 1].date;
  const expiryDate = Number.isFinite(props.expiryTs)
    ? new Date(props.expiryTs * 1000)
    : null;
  let maxDate = lastActualDate;
  if (expiryDate instanceof Date && expiryDate > maxDate) maxDate = expiryDate;
  for (const level of levels) {
    if (!Number.isFinite(level?.expiryTs)) continue;
    const levelDate = new Date(level.expiryTs * 1000);
    if (levelDate > maxDate) maxDate = levelDate;
  }

  for (const series of [...levels, ...rangeBands]) {
    for (const point of series.points || []) {
      if (point.date instanceof Date && point.date > maxDate) maxDate = point.date;
    }
  }

  if (props.timeDomain?.length === 2 && props.timeDomain.every(date =>
    date instanceof Date && Number.isFinite(date.getTime())) &&
    props.timeDomain[1] > props.timeDomain[0]) {
    [firstDate, maxDate] = props.timeDomain;
  }

  const yValues = [];
  for (const point of actual) {
    if (Number.isFinite(point.value)) yValues.push(point.value);
    if (Number.isFinite(point.low)) yValues.push(point.low);
    if (Number.isFinite(point.high)) yValues.push(point.high);
  }
  if (Number.isFinite(props.breakEvenLow)) yValues.push(props.breakEvenLow);
  if (Number.isFinite(props.breakEvenHigh)) yValues.push(props.breakEvenHigh);
  for (const level of levels) {
    for (const point of level.points || []) {
      if (Number.isFinite(point.value)) yValues.push(point.value);
    }
  }
  for (const band of rangeBands) {
    for (const point of band.points) yValues.push(point.low, point.high);
  }
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
    .call(d3.axisLeft(y).ticks(5).tickSize(0).tickPadding(15).tickFormat(formatPrice))
    .call(axisStyle);

  const bandArea = d3.area()
    .x(point => x(point.date))
    .y0(point => y(point.low))
    .y1(point => y(point.high));
  g.append("g").attr("class", "rangeBands")
    .selectAll("path").data(rangeBands, band => band.id).join("path")
    .attr("d", band => bandArea(band.points))
    .attr("fill", band => band.color || "#7dd3fc")
    .attr("fill-opacity", band => band.opacity ?? 0.06)
    .attr("pointer-events", "none");

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
    // The projection can target an expiry beyond the displayed maturities.
    g.append("clipPath")
      .attr("id", projectionClipId)
      .append("rect")
      .attr("width", innerWidth)
      .attr("height", innerHeight);
    g.append("path")
      .datum(projected)
      .attr("clip-path", `url(#${projectionClipId})`)
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
  const levelEndX = level => Number.isFinite(level?.expiryTs)
    ? x(new Date(level.expiryTs * 1000))
    : innerWidth;
  const levelOpacity = level => Number.isFinite(level?.opacity) ? level.opacity : 0.7;
  // Levels may supply a dated path; other consumers retain horizontal lines.
  const levelPath = level => level.points?.length
    ? d3.line().x(point => x(point.date)).y(point => y(point.value))(level.points)
    : `M0,${y(level.value)}H${levelEndX(level)}`;
  levelLines.append("path")
    .attr("d", levelPath).attr("fill", "none")
    .attr("stroke", level => level.color).attr("stroke-width", props.breakEvenStrokeWidth)
    .attr("opacity", levelOpacity);
  levelLines.append("path")
    .attr("d", levelPath).attr("fill", "none")
    .attr("stroke", "transparent").attr("stroke-width", 12);

  const measurements = props.rangeMeasurements.filter(marker =>
    marker?.date instanceof Date && [marker.low, marker.high, marker.referenceValue].every(Number.isFinite));
  const measurementGroup = g.append("g").attr("class", "rangeMeasurements");
  for (const marker of measurements) {
    const markerX = x(marker.date);
    // Keep labels at the final expiry inside the plot, clear of right-edge prices.
    const atRightEdge = markerX > innerWidth - 60;
    const markerLabelX = atRightEdge ? markerX - 10 : markerX;
    const markerLabelAnchor = atRightEdge ? "end" : "middle";
    const referenceY = y(marker.referenceValue);
    const group = measurementGroup.append("g").attr("role", "img");
    const signedMove = value => `${value < marker.referenceValue ? "−" : "+"}${formatPrice(Math.abs(value - marker.referenceValue))}`;
    const description = `${marker.label} from today’s spot: upper break-even ${formatPrice(marker.high)} (${signedMove(marker.high)}), lower break-even ${formatPrice(marker.low)} (${signedMove(marker.low)}).`;
    group.attr("aria-label", description).attr("tabindex", 0)
      .on("pointerenter", event => showTooltip(event, description))
      .on("pointerleave", hideTooltip)
      .on("focus", event => showTooltip(event, description))
      .on("blur", hideTooltip)
      .on("keydown", dismissTooltipOnEscape);
    group.append("title").text(description);
    group.append("line")
      .attr("x1", markerX).attr("x2", markerX)
      .attr("y1", y(marker.high) - 24).attr("y2", y(marker.low) + 24)
      .attr("stroke", "transparent").attr("stroke-width", 16);
    for (const [value, color, labelY] of [
      [marker.high, "#22c55e", y(marker.high) - 10],
      [marker.low, "#ef4444", y(marker.low) + 22],
    ]) {
      group.append("line")
        .attr("x1", markerX).attr("x2", markerX)
        .attr("y1", referenceY).attr("y2", y(value))
        .attr("stroke", color).attr("stroke-opacity", 0.7)
        .attr("stroke-width", 1.2).attr("stroke-dasharray", "3,5");
      group.append("circle").attr("cx", markerX).attr("cy", y(value))
        .attr("r", 3.5).attr("fill", color);
      group.append("text").attr("x", markerLabelX).attr("y", labelY)
        .attr("text-anchor", markerLabelAnchor).attr("fill", color)
        .style("font-family", CHART_FONT_FAMILY).style("font-size", "14px")
        .attr("paint-order", "stroke").attr("stroke", props.backgroundColor).attr("stroke-width", 4)
        .text(signedMove(value));
    }
    group.append("circle").attr("cx", markerX).attr("cy", referenceY)
      .attr("r", 2.5).attr("fill", "#d1d5db");
    group.append("text").attr("x", markerLabelX).attr("y", referenceY - 10)
      .attr("text-anchor", markerLabelAnchor).attr("fill", "#d1d5db")
      .style("font-family", CHART_FONT_FAMILY).style("font-size", "13px")
      .attr("paint-order", "stroke").attr("stroke", props.backgroundColor).attr("stroke-width", 4)
      .text(marker.label);
  }

  g.append("g")
    .attr("class", "referencePriceLevels")
    .selectAll("line")
    .data(referenceLevels, level => level.id)
    .join("line")
    .attr("x1", 0).attr("x2", innerWidth)
    .attr("y1", level => y(level.value)).attr("y2", level => y(level.value))
    .attr("stroke", level => level.color)
    .attr("stroke-width", 1);

  const rightX = innerWidth - 8;
  const currentLabelX = innerWidth + 12;
  const hasCompactBreakEvenRange =
    !levels.length &&
    !referenceLevels.length &&
    !props.priceLabelsOnRight &&
    Number.isFinite(props.breakEvenLow) &&
    Number.isFinite(props.breakEvenHigh) &&
    Math.abs(y(props.breakEvenLow) - y(props.breakEvenHigh)) <
      COMPACT_BREAK_EVEN_RANGE;
  const winProbabilityValue = Number.isFinite(props.breakEvenLow) ? props.breakEvenLow : props.breakEvenHigh;
  const hasWinProbability = Number.isFinite(props.breakEvenWinProbability) && Number.isFinite(winProbabilityValue);
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
      color: level.labelColor ?? level.color,
      text: level.label,
      tooltip: level.tooltip,
      selectable: true,
      expiryTs: level.expiryTs,
      opacity: level.opacity,
    })),
    {
      id: "break-even-low",
      tooltip: props.breakEvenLowTooltip,
      value: props.breakEvenLow,
      color: props.breakEvenLabelColor ?? "firebrick",
      text: Number.isFinite(props.breakEvenLow)
        ? `${props.breakEvenLowLabel} = ${formatPrice(props.breakEvenLow)}`
        : "",
    },
    {
      id: "break-even-high",
      tooltip: props.breakEvenHighTooltip,
      value: props.breakEvenHigh,
      color: props.breakEvenLabelColor ?? "forestgreen",
      text: Number.isFinite(props.breakEvenHigh)
        ? `${props.breakEvenHighLabel} = ${formatPrice(props.breakEvenHigh)}`
        : "",
    },
    {
      id: "current-index",
      tooltip: props.currentIndexTooltip,
      value: props.currentIndex,
      color: "#f5f5f7",
      text: Number.isFinite(props.currentIndex)
        ? `Current = ${formatPrice(props.currentIndex)}`
        : "",
    },
    ...(hasWinProbability ? [{
      id: "win-probability",
      value: winProbabilityValue,
      color: "#f5f5f7",
      text: `P(win) = ${d3.format(".1%")(props.breakEvenWinProbability)}`,
      tooltip: props.breakEvenWinProbabilityTooltip,
    }] : []),
  ]
    .filter((label) => Number.isFinite(label.value))
    .map((label) => {
      const outside = !!levels.length || props.priceLabelsOnRight || label.id === "win-probability";
      return {
        ...label,
        outside,
        anchorY: y(label.value),
        targetY: y(label.value) - (props.priceLabelsOnRight || levels.length ? 0 : PRICE_LABEL_BASELINE_OFFSET),
        x: outside ? currentLabelX : rightX,
        textAnchor: outside ? "start" : "end",
      };
    });

  const probabilityLabel = priceLabels.find(label => label.id === "win-probability");
  const breakEvenLabel = priceLabels.find(label => label.id.startsWith("break-even-") && label.value === winProbabilityValue);

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
  } else if (props.priceLabelsOnRight) {
    const labels = priceLabels.filter(label => label.id !== "win-probability");
    const positions = priceLabelPositions(labels.map(label => label.targetY), 14, innerHeight - 6);
    labels.forEach((label, index) => { label.y = positions[index]; });
  } else {
    const collidable = priceLabels.filter(label => label.id !== "win-probability");
    const currentLabel = collidable.find(label => label.id === "current-index");
    if (currentLabel && levels.length > 0) {
      currentLabel.y = Math.max(14, Math.min(innerHeight - 6, currentLabel.targetY));
      const upper = collidable.filter(label => label !== currentLabel && label.targetY < currentLabel.y);
      const lower = collidable.filter(label => label !== currentLabel && label.targetY >= currentLabel.y);
      deCollidePriceLabels(upper, 14, Math.max(14, currentLabel.y - PRICE_LABEL_MIN_SPACING));
      deCollidePriceLabels(lower, Math.min(innerHeight - 6, currentLabel.y + PRICE_LABEL_MIN_SPACING), innerHeight - 6);
    } else {
      deCollidePriceLabels(collidable, 14, innerHeight - 6);
    }
  }

  if (probabilityLabel && breakEvenLabel) {
    probabilityLabel.y = breakEvenLabel.y;
  }

  const leaderLines = props.priceLabelsOnRight ? [] : hasCompactBreakEvenRange
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
            label.outside || Math.abs(label.y - label.targetY) >
            PRICE_LABEL_LEADER_THRESHOLD,
        )
        .map((label) => ({
          ...label,
          x1: Number.isFinite(label.expiryTs) ? x(new Date(label.expiryTs * 1000)) : innerWidth,
          x2: label.outside ? currentLabelX - 4 : rightX + 2,
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
    .attr("opacity", label => Number.isFinite(label?.opacity) ? label.opacity * 0.9 : 0.65);

  g.append("g")
    .attr("class", "priceLabels")
    .selectAll("text")
    .data(priceLabels, (label) => label.id)
    .join("text")
    .attr("class", label => label.id === "win-probability" ? "breakEvenWinProbability" : null)
    .attr("x", (label) => label.x)
    .attr("y", (label) => label.y)
    .attr("text-anchor", (label) => label.textAnchor)
    .attr("dominant-baseline", props.priceLabelsOnRight ? "middle" : null)
    .attr("fill", (label) => label.color)
    .style("font-size", "14px")
    .style("font-family", CHART_FONT_FAMILY)
    .attr("paint-order", "stroke")
    .attr("stroke", props.backgroundColor)
    .attr("stroke-width", 3)
    .attr("opacity", label => Number.isFinite(label?.opacity) ? label.opacity : null)
    .text((label) => label.text)
    .attr("role", label => label.selectable ? "button" : null)
    .attr("tabindex", label => label.selectable || label.tooltip ? 0 : null)
    .attr("aria-label", label => label.tooltip ? `${label.text}. ${label.tooltip}` : label.text)
    .attr("aria-describedby", label => label.tooltip ? tooltipId : null)
    .style("cursor", label => label.selectable || label.tooltip ? "pointer" : null)
    .on("pointerenter", (event, label) => showTooltip(event, label.tooltip))
    .on("pointerleave", hideTooltip)
    .on("focus", (event, label) => showTooltip(event, label.tooltip))
    .on("blur", hideTooltip)
    .on("click", (event, label) => { if (label.selectable) selectLevel(event, label); })
    .on("keydown", (event, label) => {
      dismissTooltipOnEscape(event);
      if (label.selectable && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        selectLevel(event, label);
      }
    });

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
    props.rangeBands,
    props.rangeMeasurements,
    props.timeDomain,
    props.priceLabelsOnRight,
    props.priceFormatter,
    props.breakEvenLowLabel,
    props.breakEvenHighLabel,
    props.breakEvenLowTooltip,
    props.breakEvenHighTooltip,
    props.breakEvenLabelColor,
    props.breakEvenWinProbability,
    props.breakEvenWinProbabilityTooltip,
    props.breakEvenStrokeWidth,
    props.indexStrokeWidth,
    props.indexCurve,
    props.currentIndex,
    props.currentIndexTooltip,
    props.expiryTs,
    props.title,
    props.subtitle,
    props.subtitleTooltip,
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
onUnmounted(() => {
  hideTooltip();
  resizeObserver?.disconnect();
});
</script>

<template>
  <div class="chartWrap" :class="{ 'chartWrap--fit': fitContainer }" :style="{ background: backgroundColor }">
    <div v-if="enablePriceLevels" class="priceLevelControls">
      <span>Click to add a price level. Drag a line or label to move it; click it to remove.</span>
      <button type="button" :disabled="!priceLevelHistory.length" @click="undoPriceLevels">Undo</button>
      <button v-if="priceLevels.length" type="button" @click="clearPriceLevels">Clear levels</button>
    </div>
    <svg ref="svgRef" class="chartSvg" />
    <div v-if="loading" class="overlay" role="status">Loading...</div>
    <Teleport to="body">
      <div
        v-if="tooltip"
        ref="tooltipRef"
        :id="tooltipId"
        role="tooltip"
        class="labelTooltip"
        :style="{ left: `${tooltip.x}px`, top: `${tooltip.y}px` }"
      >{{ tooltip.text }}</div>
    </Teleport>
  </div>
</template>

<style scoped>
.labelTooltip {
  position: fixed;
  z-index: 1000;
  width: max-content;
  max-width: min(420px, calc(100vw - 24px));
  max-height: calc(100dvh - 24px);
  overflow: auto;
  padding: 12px 14px;
  border: 1px solid #414751;
  border-radius: 8px;
  background: #15181d;
  color: #e8e8ea;
  box-shadow: 0 8px 28px #0009;
  font-size: 13px;
  line-height: 1.5;
  white-space: pre-line;
  pointer-events: none;
}
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
