<script setup>
import * as d3 from "d3";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { exportChartToPng } from "../../../../lib/export-png.js";

const props = defineProps({
  data: { type: Array, default: () => [] },
  optionInstrumentName: { type: String, default: "" },
  circleSize: { type: Number, default: 4 },
  compact: { type: Boolean, default: false },
  loading: { type: Boolean, default: false },
});

const emit = defineEmits(["select-range"]);
const svgRef = ref(null);
const tooltipRef = ref(null);
const gradientId = `iv-gradient-${Math.random().toString(16).slice(2)}`;
const SVG_FONT_FAMILY =
  '"Helvetica Neue", Helvetica, -apple-system, sans-serif';

const layout = {
  mainWidth: 1316,
  height: 620,
  margin: { top: 86, right: 38, bottom: 54, left: 74 },
};
const MAIN_TOP_INSET = 28;
const LEGEND_TOP_OFFSET = 14;

const TEXT_STYLES = {
  axisText: { fill: "#70767d", size: "10px" },
  axisLabel: { fill: "#70767d", size: "11px", weight: 400 },
  mainTitle: { fill: "#e8eaed", size: "16px", weight: 600 },
  mainSubtitle: { fill: "#70767d", size: "11px" },
  legendTitle: { fill: "#70767d", size: "11px" },
  legendLabel: { fill: "#70767d", size: "10px" },
  noData: { fill: "#70767d", size: "12px" },
};

const chartState = {
  gradient: null,
  background: null,
  mainTitleText: null,
  mainSubtitleText: null,
  mainGroup: null,
  xAxisGroup: null,
  yAxisGroup: null,
  pointsGroup: null,
  selectionLine: null,
  selectionLabel: null,
  mainXAxisLabel: null,
  mainYAxisLabel: null,
  legendGroup: null,
  legendTitle: null,
  legendRect: null,
  legendMinText: null,
  legendMaxText: null,
  legendVisible: false,
  currentXScale: null,
  currentYScale: null,
  noDataText: null,
};

const getPointRadius = () => {
  const radius = Number(props.circleSize);
  if (!Number.isFinite(radius)) return 4;
  return Math.max(2, Math.min(12, radius));
};

const getDimmedPointRadius = () => Math.max(1.4, getPointRadius() * 0.7);

const getHoverPointRadius = () => Math.max(getPointRadius() + 4, getPointRadius() * 2);
const HOVER_RELEASE_HITBOX_PX = 14;
const TAP_SELECT_HITBOX_PX = 22;
const TOOLTIP_HITBOX_PX = 18;
const TOOLTIP_FADE_DELAY_MS = 1000;
let hoveredDatum = null;
let selectedDatums = [];
let selectedRange = null;
let suppressClearClick = false;
let tooltipDatum = null;
let lastPointerInMain = null;
let tooltipFadeTimer = null;

const clearTooltipFadeTimer = () => {
  if (tooltipFadeTimer) {
    clearTimeout(tooltipFadeTimer);
    tooltipFadeTimer = null;
  }
};

const isCursorInTooltipDatumHitbox = (datum) => {
  const x = chartState.currentXScale;
  const y = chartState.currentYScale;
  if (!datum || !x || !y || !lastPointerInMain) return false;
  if (!(datum.date instanceof Date)) return false;
  if (!Number.isFinite(datum.index_price_close)) return false;
  const px = x(datum.date);
  const py = y(datum.index_price_close);
  if (!Number.isFinite(px) || !Number.isFinite(py)) return false;
  return (
    Math.abs(lastPointerInMain.x - px) <= TOOLTIP_HITBOX_PX &&
    Math.abs(lastPointerInMain.y - py) <= TOOLTIP_HITBOX_PX
  );
};

const scheduleTooltipAutoFade = () => {
  clearTooltipFadeTimer();
  tooltipFadeTimer = setTimeout(() => {
    tooltipFadeTimer = null;
    if (!tooltipDatum) return;
    if (isCursorInTooltipDatumHitbox(tooltipDatum)) {
      scheduleTooltipAutoFade();
      return;
    }
    hideTooltip();
  }, TOOLTIP_FADE_DELAY_MS);
};

const getDatumTs = (datum) => {
  const ts = datum?.ts;
  if (Number.isFinite(ts)) return ts;
  const date = datum?.date;
  return date instanceof Date ? Math.round(date.getTime() / 1000) : null;
};

const findClosestDatumByTs = (data, targetTs, excludedDatum = null) => {
  if (!Number.isFinite(targetTs)) return null;
  let closest = null;
  let bestDist = Infinity;
  for (const datum of data || []) {
    const ts = getDatumTs(datum);
    if (!Number.isFinite(ts)) continue;
    if (excludedDatum && datum === excludedDatum) continue;
    const dist = Math.abs(ts - targetTs);
    if (dist < bestDist) {
      bestDist = dist;
      closest = datum;
    }
  }
  return closest;
};

const normalizeRange = (range) => {
  if (!range) return null;
  const from = Number(range.from);
  const to = Number(range.to);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return from <= to ? { from, to } : { from: to, to: from };
};

const updateSelectedRange = () => {
  if (selectedDatums.length !== 2) {
    selectedRange = null;
    return;
  }
  const firstTs = getDatumTs(selectedDatums[0]);
  const secondTs = getDatumTs(selectedDatums[1]);
  if (!Number.isFinite(firstTs) || !Number.isFinite(secondTs)) {
    selectedRange = null;
    return;
  }
  selectedRange = normalizeRange({ from: firstTs, to: secondTs });
};

const syncSelectionWithData = (data) => {
  if (!Array.isArray(data) || !data.length) {
    selectedDatums = [];
    selectedRange = null;
    return;
  }

  selectedDatums = selectedDatums.filter((datum) => data.includes(datum));
  if (selectedDatums.length === 2) {
    updateSelectedRange();
    return;
  }

  const range = normalizeRange(selectedRange);
  if (!range) {
    selectedRange = null;
    return;
  }

  const first = findClosestDatumByTs(data, range.from);
  if (!first) {
    selectedDatums = [];
    selectedRange = null;
    return;
  }
  const second = findClosestDatumByTs(data, range.to, first);
  if (!second) {
    selectedDatums = [first];
    selectedRange = null;
    return;
  }
  selectedDatums = [first, second];
  updateSelectedRange();
};

const handleChartClick = (event) => {
  if (suppressClearClick) {
    suppressClearClick = false;
    return;
  }
  const target = event?.target;
  const isPoint = target?.closest?.("circle.main-point");
  if (isPoint) return;
  if (selectedDatums.length) {
    selectedDatums = [];
    selectedRange = null;
    render();
    resetHoverStyles();
    hideTooltip();
  }
};

const mainTitle = computed(() =>
  props.optionInstrumentName ? props.optionInstrumentName : "Options",
);

const subtitle = computed(() => {
  const fmt = d3.utcFormat("%d %b %y %H:%M");
  const data = props.data;
  if (!data.length) return "";
  const start = data[0].date;
  const end = data[data.length - 1].date;
  return `${fmt(start)} - ${fmt(end)}`;
});

const applyTextStyle = (node, styleKey) => {
  const style = TEXT_STYLES[styleKey];
  if (!style) return node;
  node.style("font-family", SVG_FONT_FAMILY);
  if (style.fill) node.attr("fill", style.fill);
  if (style.size) node.style("font-size", style.size);
  if (style.weight != null) node.style("font-weight", style.weight);
  return node;
};

const axisStyle = (axisG) => {
  axisG.selectAll("line").remove();
  axisG.selectAll("path").remove();
  applyTextStyle(axisG.selectAll("text"), "axisText");
};

const formatDate = d3.utcFormat("%d %b %y %H:%M");
const formatIndex = d3.format(",.2f");
const formatIndexAxis = d3.format(",.0f");
const formatVol = d3.format(".1%");

const applySelectionStyles = () => {
  if (!chartState.pointsGroup) return;
  const points = chartState.pointsGroup
    .selectAll("circle.main-point")
    .attr("stroke", (d) =>
      selectedDatums.includes(d) ? "#000" : "transparent",
    )
    .attr("stroke-width", (d) => (selectedDatums.includes(d) ? 2.6 : 0))
    .attr("r", (d) => {
      if (selectedDatums.includes(d)) return getHoverPointRadius();
      if (selectedDatums.length === 2) return getDimmedPointRadius();
      return getPointRadius();
    })
    .attr("opacity", (d) =>
      selectedDatums.length > 0 && !selectedDatums.includes(d) ? 0.4 : 0.8,
    );
  points.filter((d) => selectedDatums.includes(d)).raise();
};

const updateSelectionLine = () => {
  const line = chartState.selectionLine;
  const x = chartState.currentXScale;
  const y = chartState.currentYScale;
  const label = chartState.selectionLabel;
  if (!line || !x || !y || !label) return;

  let lineStart = null;
  let lineEnd = null;
  if (selectedDatums.length === 2) {
    [lineStart, lineEnd] = selectedDatums;
  } else if (selectedDatums.length === 1 && hoveredDatum) {
    lineStart = selectedDatums[0];
    lineEnd = hoveredDatum;
  }

  if (
    lineStart?.date instanceof Date &&
    lineEnd?.date instanceof Date &&
    Number.isFinite(lineStart.index_price_close) &&
    Number.isFinite(lineEnd.index_price_close)
  ) {
    const x1 = x(lineStart.date);
    const y1 = y(lineStart.index_price_close);
    const x2 = x(lineEnd.date);
    const y2 = y(lineEnd.index_price_close);
    line
      .attr("display", null)
      .attr("x1", x1)
      .attr("y1", y1)
      .attr("x2", x2)
      .attr("y2", y2)
      .attr("opacity", 0.8);
    const days =
      Math.abs(lineEnd.date - lineStart.date) / (24 * 60 * 60 * 1000);
    label
      .attr("x", (x1 + x2) / 2)
      .attr("y", (y1 + y2) / 2 - 10)
      .text(`${days.toFixed(1)} days`)
      .attr("display", null);
  } else {
    line.attr("display", "none");
    label.attr("display", "none");
  }
};

const resetHoverStyles = () => {
  if (!chartState.pointsGroup) return;
  chartState.pointsGroup
    .selectAll("circle.main-point")
    .attr("opacity", 0.8)
    .attr("r", getPointRadius());
  applySelectionStyles();
};

const showTooltip = (event, datum) => {
  const tooltip = tooltipRef.value;
  const svgEl = svgRef.value;
  const wrapper = svgEl?.closest(".chartWrap");
  if (!tooltip || !wrapper || !svgEl) return;
  const mainNode = chartState.mainGroup?.node();
  if (mainNode) {
    const [px, py] = d3.pointer(event, mainNode);
    if (Number.isFinite(px) && Number.isFinite(py)) {
      lastPointerInMain = { x: px, y: py };
    }
  }
  tooltipDatum = datum;
  clearTooltipFadeTimer();
  const wrapperRect = wrapper.getBoundingClientRect();
  const x = event.clientX - wrapperRect.left;
  const y = event.clientY - wrapperRect.top;
  const indexValue = Number.isFinite(datum.index_price_close)
    ? formatIndex(datum.index_price_close)
    : "n/a";
  const ivValue = Number.isFinite(datum.iv_close)
    ? formatVol(datum.iv_close)
    : "n/a";
  const optionMarkValue = Number.isFinite(datum.option_mark_price)
    ? formatIndex(datum.option_mark_price)
    : "n/a";
  tooltip.innerHTML = `
    <div class="tooltip-title">${formatDate(datum.date)}</div>
    <div>Index: ${indexValue}</div>
    <div>Option Mark: ${optionMarkValue}</div>
    <div>IV: ${ivValue}</div>
  `;
  const xScale = chartState.currentXScale;
  const yScale = chartState.currentYScale;
  let anchorX = x;
  let anchorY = y;
  if (
    xScale &&
    yScale &&
    datum?.date instanceof Date &&
    Number.isFinite(datum?.index_price_close)
  ) {
    const viewBox = svgEl.viewBox?.baseVal;
    const viewBoxWidth = Number(viewBox?.width);
    const viewBoxHeight = Number(viewBox?.height);
    const anchorSvgX = layout.margin.left + xScale(datum.date);
    const anchorSvgY = layout.margin.top + yScale(datum.index_price_close);
    const svgRect = svgEl.getBoundingClientRect();
    const wrapperOffsetX = svgRect.left - wrapperRect.left;
    const wrapperOffsetY = svgRect.top - wrapperRect.top;
    if (
      Number.isFinite(viewBoxWidth) &&
      viewBoxWidth > 0 &&
      Number.isFinite(viewBoxHeight) &&
      viewBoxHeight > 0
    ) {
      anchorX = wrapperOffsetX + (anchorSvgX / viewBoxWidth) * svgRect.width;
      anchorY = wrapperOffsetY + (anchorSvgY / viewBoxHeight) * svgRect.height;
    } else {
      anchorX = anchorSvgX;
      anchorY = anchorSvgY;
    }
  }
  tooltip.style.left = `${anchorX}px`;
  tooltip.style.top = `${anchorY}px`;
  tooltip.style.opacity = "1";
  const tooltipRect = tooltip.getBoundingClientRect();
  const wrapperRectUpdated = wrapper.getBoundingClientRect();
  const edgePadding = 8;
  const verticalGap = 36;
  const centeredLeft = anchorX - tooltipRect.width / 2;
  const clampedLeft = Math.max(
    edgePadding,
    Math.min(
      wrapperRectUpdated.width - tooltipRect.width - edgePadding,
      centeredLeft,
    ),
  );
  const minTop = layout.margin.top + 4;
  const maxTop = Math.max(
    minTop,
    wrapperRectUpdated.height - tooltipRect.height - edgePadding,
  );
  const aboveTop = anchorY - tooltipRect.height - verticalGap;
  tooltip.style.left = `${clampedLeft}px`;
  tooltip.style.top = `${Math.max(minTop, Math.min(maxTop, aboveTop))}px`;
  scheduleTooltipAutoFade();
};

const hideTooltip = () => {
  const tooltip = tooltipRef.value;
  if (!tooltip) return;
  tooltip.style.opacity = "0";
  tooltipDatum = null;
  clearTooltipFadeTimer();
};

const handlePointerMove = (event) => {
  const mainNode = chartState.mainGroup?.node();
  if (!mainNode) return;
  const [px, py] = d3.pointer(event, mainNode);
  if (Number.isFinite(px) && Number.isFinite(py)) {
    lastPointerInMain = { x: px, y: py };
    if (
      hoveredDatum &&
      chartState.currentXScale &&
      chartState.currentYScale &&
      hoveredDatum.date instanceof Date &&
      Number.isFinite(hoveredDatum.index_price_close)
    ) {
      const hx = chartState.currentXScale(hoveredDatum.date);
      const hy = chartState.currentYScale(hoveredDatum.index_price_close);
      const cursorOutsideHoveredDot =
        !Number.isFinite(hx) ||
        !Number.isFinite(hy) ||
        Math.abs(px - hx) > HOVER_RELEASE_HITBOX_PX ||
        Math.abs(py - hy) > HOVER_RELEASE_HITBOX_PX;
      if (cursorOutsideHoveredDot) {
        hoveredDatum = null;
        resetHoverStyles();
        updateSelectionLine();
        if (tooltipDatum) {
          scheduleTooltipAutoFade();
        }
      }
    }
  }
};

const handlePointerLeave = () => {
  lastPointerInMain = null;
  if (hoveredDatum) {
    hoveredDatum = null;
    resetHoverStyles();
    updateSelectionLine();
  }
  if (tooltipDatum) {
    scheduleTooltipAutoFade();
  }
};

const ensureChartElements = () => {
  const svgEl = svgRef.value;
  if (!svgEl) return null;
  const svg = d3.select(svgEl);

  const appendText = (parent, styleKey, { anchor, text } = {}) => {
    const node = parent.append("text");
    applyTextStyle(node, styleKey);
    if (anchor) node.attr("text-anchor", anchor);
    if (text != null) node.text(text);
    return node;
  };

  const appendAxisLabel = (parent, text) =>
    appendText(parent, "axisLabel", { anchor: "middle", text });

  if (!chartState.gradient) {
    const defs = svg.append("defs");
    chartState.gradient = defs
      .append("linearGradient")
      .attr("id", gradientId)
      .attr("x1", "0%")
      .attr("x2", "100%")
      .attr("y1", "0%")
      .attr("y2", "0%");
  }

  if (!chartState.background) {
    chartState.background = svg.append("rect").attr("fill", "#0a0b0e");
  }

  if (!chartState.mainTitleText) {
    chartState.mainTitleText = appendText(svg, "mainTitle", {
      anchor: "middle",
    });
  }

  if (!chartState.mainSubtitleText) {
    chartState.mainSubtitleText = appendText(svg, "mainSubtitle", {
      anchor: "middle",
    });
  }

  if (!chartState.legendGroup) {
    chartState.legendGroup = svg.append("g");
    chartState.legendTitle = appendText(chartState.legendGroup, "legendTitle", {
      text: "Implied volatility",
    });
    chartState.legendRect = chartState.legendGroup
      .append("rect")
      .attr("stroke", "#2e3040");
    chartState.legendMinText = appendText(
      chartState.legendGroup,
      "legendLabel",
    );
    chartState.legendMaxText = appendText(
      chartState.legendGroup,
      "legendLabel",
      { anchor: "end" },
    );
    chartState.legendGroup.attr("opacity", 1);
  }

  if (!chartState.noDataText) {
    chartState.noDataText = appendText(svg, "noData", { anchor: "middle" });
  }

  if (!chartState.mainGroup) {
    chartState.mainGroup = svg.append("g");
    chartState.xAxisGroup = chartState.mainGroup.append("g");
    chartState.yAxisGroup = chartState.mainGroup.append("g");
    chartState.selectionLine = chartState.mainGroup
      .append("line")
      .attr("stroke", "#fff")
      .attr("stroke-width", 1.6)
      .attr("stroke-dasharray", "6 6")
      .attr("stroke-linecap", "round")
      .attr("opacity", 0.8)
      .attr("display", "none")
      .attr("pointer-events", "none");
    chartState.selectionLabel = chartState.mainGroup
      .append("text")
      .attr("text-anchor", "middle")
      .attr("fill", "#e8e8ea")
      .style("font-family", SVG_FONT_FAMILY)
      .style("font-size", "11px")
      .style("font-weight", 600)
      .attr("paint-order", "stroke")
      .attr("stroke", "#000")
      .attr("stroke-width", 3)
      .attr("display", "none")
      .attr("pointer-events", "none");
    chartState.pointsGroup = chartState.mainGroup.append("g");
    chartState.mainXAxisLabel = appendAxisLabel(
      chartState.mainGroup,
      "Date (UTC)",
    );
    chartState.mainYAxisLabel = appendAxisLabel(
      chartState.mainGroup,
      "Index Price (Close)",
    );
  }


  return svg;
};

function exportPng({
  filename = "option-chart.png",
  scale = 4,
  padding = 24,
} = {}) {
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
  const data = props.data;

  const svg = ensureChartElements();
  if (!svg) return;

  const { height, margin } = layout;
  syncSelectionWithData(data);
  emit("select-range", selectedDatums.length === 2 ? { ...selectedRange } : null);
  if (hoveredDatum && !data.includes(hoveredDatum)) hoveredDatum = null;
  const mainWidth = props.compact ? 640 : layout.mainWidth;
  const width = mainWidth;
  const innerWidth = mainWidth - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;

  svg.attr("viewBox", `0 0 ${width} ${height}`).attr("role", "img");
  chartState.background
    .attr("x", 0)
    .attr("y", 0)
    .attr("width", width)
    .attr("height", height);

  chartState.mainTitleText
    .attr("x", mainWidth / 2)
    .attr("y", 30)
    .text(mainTitle.value);
  chartState.mainSubtitleText
    .attr("x", mainWidth / 2)
    .attr("y", 54)
    .text(subtitle.value);

  if (!data.length) {
    chartState.noDataText
      .attr("x", width / 2)
      .attr("y", height / 2)
      .attr("visibility", props.loading ? "hidden" : "visible")
      .text("No data for this range.");
    chartState.pointsGroup
      .selectAll("circle.main-point")
      .data([])
      .join("circle");
    chartState.legendGroup.attr("display", "none");
    chartState.legendVisible = false;
    hideTooltip();
    return;
  }

  chartState.noDataText.attr("visibility", "hidden");
  chartState.legendVisible = true;
  chartState.legendGroup.interrupt().attr("display", null).attr("opacity", 1);

  chartState.mainGroup.attr(
    "transform",
    `translate(${margin.left},${margin.top})`,
  );

  const validDates = [];
  const validIndex = [];
  const ivValues = [];
  for (const d of data) {
    if (d.date instanceof Date) validDates.push(d.date);
    if (Number.isFinite(d.index_price_close))
      validIndex.push(d.index_price_close);
    if (Number.isFinite(d.iv_close)) ivValues.push(d.iv_close);
  }
  const xDomain = d3.extent(validDates);
  const yDomain = d3.extent(validIndex);
  const [extentMin, extentMax] = d3.extent(ivValues);

  const x = d3.scaleUtc().domain(xDomain).range([0, innerWidth]);
  const y = d3
    .scaleLinear()
    .domain(yDomain)
    .nice()
    .range([innerHeight, MAIN_TOP_INSET]);
  chartState.currentXScale = x;
  chartState.currentYScale = y;
  const hasValidExtent =
    Number.isFinite(extentMin) && Number.isFinite(extentMax);
  const domainMin = hasValidExtent ? Math.max(extentMin, 0) : 0;
  const domainMax = hasValidExtent ? extentMax : 0;
  const domainSpan = domainMax - domainMin;
  const hasSpread = hasValidExtent && domainSpan !== 0;
  const fallbackColor = "#7c7f8f";
  const colorForVol = (value) => {
    if (!Number.isFinite(value) || !hasValidExtent) {
      return fallbackColor;
    }
    if (!hasSpread) {
      return d3.interpolateRdBu(0.5);
    }
    const normalized = (value - domainMin) / domainSpan;
    const clamped = Math.max(0, Math.min(1, normalized));
    const ramp = 0.12 + 0.88 * clamped;
    return d3.interpolateRdBu(1 - ramp);
  };
  const formatVolPct = (value) =>
    Number.isFinite(value) ? formatVol(value) : "n/a";

  const axisTitlePadding = 10;

  const mainTickCount = props.compact ? 5 : 10;
  const xAxis = d3
    .axisBottom(x)
    .ticks(mainTickCount)
    .tickSize(0)
    .tickPadding(10);
  const yAxis = d3
    .axisLeft(y)
    .ticks(6)
    .tickSize(0)
    .tickPadding(10)
    .tickFormat(formatIndexAxis);

  const xAxisSelection = chartState.xAxisGroup
    .attr("transform", `translate(0,${innerHeight})`)
    .call(xAxis);
  const yAxisSelection = chartState.yAxisGroup.call(
    yAxis,
  );
  xAxisSelection.call(axisStyle);
  yAxisSelection.call(axisStyle);
  chartState.mainXAxisLabel
    .attr("x", innerWidth / 2)
    .attr("y", innerHeight + 42 + axisTitlePadding);
  chartState.mainYAxisLabel
    .attr("transform", "rotate(-90)")
    .attr("x", -innerHeight / 2)
    .attr("y", -52 - axisTitlePadding);

  updateSelectionLine();

  const mainPoints = chartState.pointsGroup
    .selectAll("circle.main-point")
    .data(data, (d) => (d.date ? d.date.getTime() : d.index_price_close));

  const handlePointSelect = (event, datum) => {
    event.stopPropagation();
    if (event.type === "pointerdown") {
      event.preventDefault();
    }
    // Opening the pane resizes the chart before pointerup. The following
    // click can consequently target the background instead of this circle.
    suppressClearClick = true;
    if (selectedDatums.includes(datum)) return;
    if (selectedDatums.length < 2) {
      selectedDatums = [...selectedDatums, datum];
    } else {
      const [first, second] = selectedDatums;
      const firstDate = first?.date;
      const secondDate = second?.date;
      const nextDate = datum?.date;
      if (
        firstDate instanceof Date &&
        secondDate instanceof Date &&
        nextDate instanceof Date
      ) {
        const distToFirst = Math.abs(nextDate - firstDate);
        const distToSecond = Math.abs(nextDate - secondDate);
        const keep = distToFirst <= distToSecond ? second : first;
        selectedDatums = [keep, datum];
      } else {
        selectedDatums = [second || first, datum].filter(Boolean);
      }
    }
    updateSelectedRange();
    render();
  };

  const findNearestDatumForTap = (event) => {
    const mainNode = chartState.mainGroup?.node();
    if (!mainNode) return null;
    const [px, py] = d3.pointer(event, mainNode);
    if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
    if (
      px < -TAP_SELECT_HITBOX_PX ||
      px > innerWidth + TAP_SELECT_HITBOX_PX ||
      py < MAIN_TOP_INSET - TAP_SELECT_HITBOX_PX ||
      py > innerHeight + TAP_SELECT_HITBOX_PX
    ) {
      return null;
    }
    let nearest = null;
    let bestDistSq = TAP_SELECT_HITBOX_PX * TAP_SELECT_HITBOX_PX + 1;
    for (const datum of data) {
      if (!(datum?.date instanceof Date)) continue;
      if (!Number.isFinite(datum?.index_price_close)) continue;
      const dx = x(datum.date) - px;
      const dy = y(datum.index_price_close) - py;
      if (Math.abs(dx) > TAP_SELECT_HITBOX_PX || Math.abs(dy) > TAP_SELECT_HITBOX_PX) {
        continue;
      }
      const distSq = dx * dx + dy * dy;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        nearest = datum;
      }
    }
    return nearest;
  };

  chartState.mainGroup.on("pointerdown.nearest-select", (event) => {
    const target = event?.target;
    if (target?.closest?.("circle.main-point")) return;
    const nearest = findNearestDatumForTap(event);
    if (!nearest) return;
    handlePointSelect(event, nearest);
  });

  const pointUpdate = mainPoints
    .join((enter) => {
      const circles = enter
        .append("circle")
        .attr("class", "main-point")
        .attr("r", getPointRadius())
        .attr("stroke", "transparent")
        .attr("stroke-width", 0)
        .attr("opacity", 0.8);
      return circles;
    })
    .attr("fill", (d) => colorForVol(d.iv_close))
    .on("mouseenter", (event, datum) => {
      hoveredDatum = datum;
      updateSelectionLine();
      applySelectionStyles();
      d3.select(event.currentTarget)
        .attr("r", getHoverPointRadius())
        .attr("stroke", "#000")
        .attr("stroke-width", 1.1)
        .attr("opacity", 1)
        .raise();
      showTooltip(event, datum);
    })
    .on("mousemove", (event, datum) => {
      hoveredDatum = datum;
      updateSelectionLine();
      showTooltip(event, datum);
    })
    .on("mouseleave", (event) => {
      hoveredDatum = null;
      resetHoverStyles();
      updateSelectionLine();
      scheduleTooltipAutoFade();
    })
    .on("pointerdown", (event, datum) => handlePointSelect(event, datum));

  pointUpdate
    .attr("cx", (d) => x(d.date))
    .attr("cy", (d) => y(d.index_price_close));

  applySelectionStyles();
  if (hoveredDatum) {
    chartState.pointsGroup
      .selectAll("circle.main-point")
      .filter((d) => d === hoveredDatum)
      .attr("r", getHoverPointRadius())
      .attr("stroke", "#000")
      .attr("stroke-width", 1.1)
      .attr("opacity", 1)
      .raise();
  }


  const gradientStops = hasValidExtent
    ? [
        { offset: "0%", value: domainMin },
        { offset: "50%", value: domainMin + domainSpan / 2 },
        { offset: "100%", value: domainMax },
      ]
    : [
        { offset: "0%", value: 0 },
        { offset: "100%", value: 0 },
      ];

  chartState.gradient
    .selectAll("stop")
    .data(gradientStops)
    .join((enter) => enter.append("stop"))
    .attr("offset", (d) => d.offset)
    .attr("stop-color", (d) => colorForVol(d.value));

  const legendWidth = 220;
  const legendHeight = 10;
  const legendX = mainWidth - margin.right - legendWidth;
  const legendY = margin.top - LEGEND_TOP_OFFSET;
  chartState.legendGroup.attr(
    "transform",
    `translate(${legendX},${legendY})`,
  );
  const legendPaddingY = 8;
  const legendTitleY = legendPaddingY;
  const legendBarTop = legendTitleY + 14;
  const legendLabelY = legendBarTop + legendHeight + 16;

  chartState.legendTitle?.attr("x", 0).attr("y", legendTitleY);
  chartState.legendRect
    .attr("x", 0)
    .attr("y", legendBarTop)
    .attr("width", legendWidth)
    .attr("height", legendHeight)
    .attr("fill", `url(#${gradientId})`);
  chartState.legendMinText
    .attr("x", 0)
    .attr("y", legendLabelY)
    .text(formatVolPct(extentMin));
  chartState.legendMaxText
    .attr("x", legendWidth)
    .attr("y", legendLabelY)
    .text(formatVolPct(domainMax));
}

watch(
  () => [
    props.data,
    props.optionInstrumentName,
    props.circleSize,
    props.compact,
  ],
  () => render(),
  { deep: false },
);

onMounted(() => render());
onUnmounted(() => {
  clearTooltipFadeTimer();
});
</script>

<template>
  <div
    class="chartWrap"
    @click="handleChartClick"
    @pointermove="handlePointerMove"
    @pointerleave="handlePointerLeave"
  >
    <svg ref="svgRef" />
    <div ref="tooltipRef" class="tooltip" />
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

svg {
  display: block;
  width: 100%;
  height: auto;
  position: relative;
  z-index: 1;
}

.tooltip {
  position: absolute;
  left: 0;
  top: 0;
  transform: translate3d(0, 0, 0);
  pointer-events: none;
  opacity: 0;
  transition: opacity 120ms ease;
  background: rgba(0, 0, 0, 0.85);
  border: 1px solid #2e3040;
  color: #e8e8ea;
  font-size: 12px;
  line-height: 1.4;
  padding: 8px 10px;
  border-radius: 8px;
  white-space: nowrap;
  z-index: 3;
}

.tooltip-title {
  font-weight: 600;
  margin-bottom: 4px;
}

.overlay {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: #fff;
  background: color-mix(in oklab, #000, transparent 40%);
  font-size: 14px;
  z-index: 2;
}
</style>
