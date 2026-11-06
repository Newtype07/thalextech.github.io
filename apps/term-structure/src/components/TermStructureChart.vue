<script setup>
import * as d3 from "d3";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { exportChartToPng } from "../../../../lib/export-png.js";
import { SNAPSHOT_RESOLUTIONS } from "../term-snapshots.js";
const props = defineProps({
  current: Array,
  expiries: { type: Array, default: () => [] },
  history: Array,
  chartStyle: { type: String, default: "scatter" },
  snapshots: { type: Array, default: () => [] },
  snapshotResolution: { type: String, default: "" },
  asset: String,
  sliceLabel: String,
  sourceLabel: String,
  view: { type: String, default: "iv" },
  snapshotTime: Number,
  rvDataRange: { type: Object, default: () => ({ start: null, end: null }) },
  loading: Boolean,
  realized: { type: Array, default: () => [] },
});
const svgRef = ref(null);
const tooltipVisible = ref(false);
const tooltipText = ref("");
const tooltipStyle = ref({});
const tooltipId = "term-structure-source-tooltip";
let tooltipHideTimer;
const W = 1280,
  H = 600,
  margin = { top: 114, right: 44, bottom: 82, left: 78 };
const date = d3.utcFormat("%d %b %y"),
  stamp = d3.utcFormat("%d %b %Y %H:%M UTC");
let renderedHistory = null;
let historyScaleKey = "";
let cachedHistoryLayer = null;
function sourceDetails() {
  const range = (start, end) => Number.isFinite(start) && Number.isFinite(end)
    ? `${stamp(new Date(start * 1000))} — ${stamp(new Date(end * 1000))}`
    : "Unavailable";
  const ivRange = d3.extent(props.history, point => point.ts);
  return [
    "IV data",
    range(...ivRange),
    "Thalex · hourly closing mark IV",
    "",
    "RV data",
    range(props.rvDataRange.start, props.rvDataRange.end),
    "Thalex · hourly index OHLC (Garman–Klass)",
  ].join("\n");
}
function keepSourceTooltip() {
  clearTimeout(tooltipHideTimer);
}
function hideSourceTooltip(immediate = false) {
  keepSourceTooltip();
  if (immediate) tooltipVisible.value = false;
  else tooltipHideTimer = setTimeout(() => { tooltipVisible.value = false; }, 150);
}
function showTooltip(event, text) {
  keepSourceTooltip();
  const bounds = event.currentTarget.getBoundingClientRect();
  const width = Math.min(720, window.innerWidth - 24);
  const top = Math.min(bounds.bottom + 10, window.innerHeight - 140);
  tooltipStyle.value = {
    width: `${width}px`,
    left: `${Math.max(12, Math.min(bounds.left + bounds.width / 2 - width / 2, window.innerWidth - width - 12))}px`,
    top: `${Math.max(12, top)}px`,
    maxHeight: `${Math.max(100, window.innerHeight - top - 16)}px`,
  };
  tooltipText.value = text;
  tooltipVisible.value = true;
}
function showSourceTooltip(event) {
  showTooltip(event, sourceDetails());
}
function dismissSourceTooltip(event) {
  if (event.key === "Escape") hideSourceTooltip(true);
}
function draw() {
  if (!svgRef.value) return;
  const svg = d3.select(svgRef.value);
  const linesMode = props.chartStyle === "lines";
  const plottedHistory = linesMode
    ? props.snapshots.flatMap(snapshot => snapshot.points.filter(Boolean))
    : props.history;
  const plottedCurrent = linesMode ? [] : props.current;
  // Retain the large dot cloud across live-quote and status updates.
  let historyLayer = svg.select(".history-cloud");
  if (historyLayer.empty() && cachedHistoryLayer) historyLayer = cachedHistoryLayer;
  historyLayer.remove();
  svg.selectAll("*").remove();
  svg
    .attr("viewBox", `0 0 ${W} ${H}`)
    .attr(
      "font-family",
      '"Helvetica Neue", Helvetica, -apple-system, sans-serif',
    );
  svg.append("rect").attr("width", W).attr("height", H).attr("fill", "#000000");
  svg
    .append("text")
    .attr("x", W / 2)
    .attr("y", 36)
    .attr("text-anchor", "middle")
    .attr("fill", "#e8eaed")
    .attr("font-size", 18)
    .attr("font-weight", 650)
    .text(
      `${props.asset} / ${props.sliceLabel} ${props.view === "forward" ? "forward volatility" : "volatility term structure"}${linesMode ? " snapshots" : ""}`,
    );
  svg
    .append("text")
    .attr("class", "chart-subtitle")
    .attr("tabindex", 0)
    .attr("x", W / 2)
    .attr("y", 62)
    .attr("text-anchor", "middle")
    .attr("fill", "#70767d")
    .attr("font-size", 12)
    .text(
      linesMode
        ? `Historical ${props.view === "forward" ? "forward-volatility" : "IV"} curves · Newer snapshots are brighter`
        : `${props.snapshotTime ? stamp(new Date(props.snapshotTime * 1000)) : "Awaiting live quotes"} · Solid white: ${props.view === "forward" ? "forward vol from " : ""}${props.sourceLabel.toLowerCase()} · History: ${props.view === "forward" ? "hourly forwards" : "hourly marks"}`,
    );
  if (props.history.length) {
    svg
      .append("text")
      .attr("class", "chart-subtitle")
      .attr("tabindex", 0)
      .attr("x", W / 2)
      .attr("y", 82)
      .attr("text-anchor", "middle")
      .attr("fill", "#70767d")
      .attr("font-size", 11)
      .text(
        `${linesMode ? "Solid: historical snapshots" : `Dots: hourly ${props.view === "forward" ? "forward vol" : "IV"}`}${props.realized.length ? " · Dashed: realized volatility" : ""}`,
      );
  }
  svg.selectAll(".chart-subtitle")
    .attr("aria-label", "View IV and RV source data")
    .attr("aria-describedby", tooltipId)
    .on("mouseenter.source focus.source", showSourceTooltip)
    .on("mouseleave.source blur.source", () => hideSourceTooltip())
    .on("keydown.source", event => {
      if (event.key === "Escape") hideSourceTooltip(true);
    });
  if (
    !plottedCurrent.length &&
    !plottedHistory.length &&
    !props.realized.some((p) => p.iv != null)
  ) {
    renderedHistory = null;
    historyScaleKey = "";
    cachedHistoryLayer = linesMode ? historyLayer : null;
    svg
      .append("text")
      .attr("x", W / 2)
      .attr("y", H / 2)
      .attr("text-anchor", "middle")
      .attr("fill", "#70767d")
      .attr("font-size", 16)
      .text(
        props.loading
          ? "Fetching live term structure…"
          : linesMode
            ? "No historical snapshots available for the selected period."
            : props.view === "forward"
            ? "No forward vol available. Both adjacent expiries and nonnegative forward variance are required."
            : "No interpolated IV available. Try ATM, Live marks or refresh.",
      );
    return;
  }
  const expiries = props.expiries.length
    ? props.expiries
    : [
        ...new Set([...props.current, ...props.history].map((p) => p.expiry)),
      ].sort((a, b) => a - b);
  const positions = new Map(expiries.map((expiry, index) => [expiry, index]));
  const shortDate = d3.utcFormat("%d %b");
  const periodLabel = (expiry) => {
    const index = positions.get(expiry);
    return props.view === "forward"
      ? `${index ? shortDate(new Date(expiries[index - 1] * 1000)) : "Now"} → ${date(new Date(expiry * 1000))}`
      : date(new Date(expiry * 1000));
  };
  const x = d3
    .scalePoint(expiries, [margin.left, W - margin.right])
    .padding(0.48);
  const [lo, hi] = d3.extent(
    [
      ...plottedCurrent,
      ...plottedHistory,
      ...props.realized.filter((p) => p.iv != null),
    ],
    (p) => p.iv,
  );
  const pad = Math.max((hi - lo) * 0.14, 0.015);
  const y = d3
    .scaleLinear(
      [Math.max(0, lo - pad), hi + pad],
      [H - margin.bottom, margin.top],
    )
    .nice(6);
  const grid = svg
    .append("g")
    .attr("transform", `translate(${margin.left},0)`)
    .call(
      d3
        .axisLeft(y)
        .ticks(6)
        .tickFormat(d3.format(".0%"))
        .tickSize(-(W - margin.left - margin.right))
        .tickPadding(16),
    );
  grid.select(".domain").remove();
  grid.selectAll("line").attr("stroke", "#23232a").attr("stroke-opacity", 0.7);
  grid.selectAll("text").attr("fill", "#70767d").attr("font-size", 12);
  const axis = svg
    .append("g")
    .attr("transform", `translate(0,${H - margin.bottom + 10})`)
    .call(d3.axisBottom(x).tickFormat(periodLabel).tickSize(0).tickPadding(13));
  axis.select(".domain").remove();
  axis.selectAll("text").attr("fill", "#70767d").attr("font-size", 12);
  svg
    .append("text")
    .attr("transform", `translate(16,${(margin.top + H - margin.bottom) / 2}) rotate(-90)`)
    .attr("text-anchor", "middle")
    .attr("fill", "#70767d")
    .attr("font-size", 11)
    .text("ANNUALIZED VOLATILITY");
  svg
    .append("text")
    .attr("x", (W + margin.left - margin.right) / 2)
    .attr("y", H - 20)
    .attr("text-anchor", "middle")
    .attr("fill", "#70767d")
    .attr("font-size", 11)
    .text(
      props.view === "forward"
        ? "EXPIRY INTERVAL · UTC"
        : "LISTED EXPIRY · UTC",
    );

  if (!linesMode) {
    historyLayer = historyLayer.empty()
      ? svg.append("g").attr("class", "history-cloud")
      : svg.append(() => historyLayer.node());
    const jitterWidth = Math.min(x.step() * 0.14, 20);
    // Stable decorative jitter: timestamps never change vertical observations.
    const jitter = (p) =>
      ((Math.sin(p.ts * 0.013 + p.expiry * 0.007) * 43758.5453) % 1) *
      jitterWidth;
    const scaleKey = JSON.stringify([expiries, y.domain(), props.view]);
    if (renderedHistory !== props.history || historyScaleKey !== scaleKey) {
      const dots = historyLayer
        .selectAll("circle")
        .data(props.history, p => `${p.expiry}:${p.ts}`)
        .join(enter => {
          const circle = enter.append("circle");
          circle.append("title");
          return circle;
        })
        .attr("cx", (p) => x(p.expiry) + jitter(p))
        .attr("cy", (p) => y(p.iv))
        .attr("r", 2.4)
        .attr("fill", "#ffffff")
        .attr("fill-opacity", 0.18);
      dots.select("title")
        .text(
          (p) =>
            `${periodLabel(p.expiry)} · ${(p.iv * 100).toFixed(2)}%\nHourly close: ${stamp(new Date(p.ts * 1000))}${p.clamped ? "\nNearest-strike ATM fallback in an IV input" : ""}`,
        );
      renderedHistory = props.history;
      historyScaleKey = scaleKey;
    }
  }
  cachedHistoryLayer = historyLayer.empty() ? null : historyLayer;
  const line = d3
    .line()
    .defined((p) => p != null)
    .x((p) => x(p.expiry))
    .y((p) => y(p.iv))
    .curve(d3.curveMonotoneX);
  if (linesMode && props.snapshots.length) {
    const spec = SNAPSHOT_RESOLUTIONS.find(item => item.value === props.snapshotResolution);
    const curves = svg.append("g").attr("class", "snapshot-curves")
      .selectAll("g").data(props.snapshots, snapshot => snapshot.ts).join("g")
      .attr("class", "snapshot-curve")
      .attr("data-timestamp", snapshot => snapshot.ts)
      .attr("opacity", snapshot => 0.2 + 0.45 * (1 - snapshot.ageIndex / Math.max(1, (spec?.count ?? props.snapshots.length) - 1)))
      .on("mouseenter.snapshot", (event, snapshot) => showTooltip(event, [
        `Historical ${props.view === "forward" ? "forward vol" : "IV"} snapshot: ${stamp(new Date(snapshot.ts * 1000))}`,
        ...snapshot.points.map((point, index) => point
          ? `${periodLabel(point.expiry)}: ${(point.iv * 100).toFixed(2)}%`
          : `${periodLabel(expiries[index])}: unavailable`),
      ].join("\n")))
      .on("mouseleave.snapshot", () => hideSourceTooltip());
    curves.append("path")
      .attr("class", "snapshot-line")
      .attr("d", snapshot => {
        // A term-structure curve joins the observations that actually exist.
        // Keep forward-interval gaps, where skipping a bucket changes meaning.
        const points = props.view === "iv" ? snapshot.points.filter(Boolean) : snapshot.points;
        const available = points.filter(Boolean);
        if (available.length === 1)
          return `M${x(available[0].expiry) - 3},${y(available[0].iv)}h6`;
        return line(points);
      })
      .attr("fill", "none")
      .attr("stroke", "#b4becd")
      .attr("stroke-width", 1.2);
  }
  if (props.realized.length) {
    const rvLine = d3
      .line()
      .defined((p) => p.iv != null)
      .x((p) => x(p.expiry))
      .y((p) => y(p.iv))
      .curve(d3.curveMonotoneX);
    svg
      .append("path")
      .datum(props.realized)
      .attr("d", rvLine)
      .attr("fill", "none")
      .attr("stroke", "#000000")
      .attr("stroke-width", 5)
      .attr("stroke-dasharray", "6 5");
    svg
      .append("path")
      .datum(props.realized)
      .attr("d", rvLine)
      .attr("fill", "none")
      .attr("stroke", "#e8eaed")
      .attr("stroke-width", 1.5)
      .attr("stroke-dasharray", "6 5");
    svg
      .append("g")
      .selectAll("circle")
      .data(props.realized.filter((p) => p.iv != null))
      .join("circle")
      .attr("cx", (p) => x(p.expiry))
      .attr("cy", (p) => y(p.iv))
      .attr("r", 4)
      .attr("fill", "#000000")
      .attr("stroke", "#e8eaed")
      .attr("stroke-width", 1.5)
      .append("title")
      .text(
        (p) =>
          `${periodLabel(p.expiry)} · RV ${(p.iv * 100).toFixed(2)}%\nGarman–Klass · ${p.count}/${p.hours} hourly bars (${(p.coverage * 100).toFixed(2)}%)${p.partial ? "\nEstimated from available bars; missing hours skipped" : ""}\n${stamp(new Date(p.start * 1000))} — ${stamp(new Date(p.end * 1000))}`,
      );
    svg
      .append("text")
      .attr("data-export-label", "Dashed: realized volatility")
      .attr("x", margin.left)
      .attr("y", H - 20)
      .attr("fill", "#70767d")
      .attr("font-size", 11)
      .text(
        `Dashed: ${props.view === "forward" ? "duration-matched trailing" : "matched-window"} RV`,
      );
  }
  if (!linesMode) {
    const currentByExpiry = new Map(props.current.map((p) => [p.expiry, p]));
    const currentPath = expiries.map((expiry) => currentByExpiry.get(expiry));
    svg
      .append("path")
      .datum(currentPath)
      .attr("d", line)
      .attr("fill", "none")
      .attr("stroke", "#000000")
      .attr("stroke-width", 7);
    svg
      .append("path")
      .datum(currentPath)
      .attr("d", line)
      .attr("fill", "none")
      .attr("stroke", "#f5f5f7")
      .attr("stroke-width", 2.5);
    const current = svg.append("g").selectAll("g").data(props.current).join("g");
    current
      .append("circle")
      .attr("cx", (p) => x(p.expiry))
      .attr("cy", (p) => y(p.iv))
      .attr("r", 5)
      .attr("fill", "#fff")
      .attr("stroke", "#000000")
      .attr("stroke-width", 2);
    current
      .append("text")
      .attr("x", (p) => x(p.expiry))
      .attr("y", (p) => y(p.iv) - 18)
      .attr("fill", "#f5f5f7")
      .attr("font-size", 13)
      .attr("font-weight", 600)
      .attr("text-anchor", "middle")
      .attr("stroke", "#000000")
      .attr("stroke-width", 4)
      .attr("paint-order", "stroke")
      .text((p) => `${(p.iv * 100).toFixed(1)}%`);
    current
      .append("title")
      .text(
        (p) =>
          `${periodLabel(p.expiry)} · Live ${(p.iv * 100).toFixed(2)}%\n${p.count} historical observations · ${p.rank == null ? "No rank" : p.rank.toFixed(1) + " percentile"}${p.clamped ? "\nNearest-strike ATM fallback in an IV input" : ""}`,
      );
  }
  if (!props.history.length)
    svg
      .append("text")
      .attr("data-export-omit", "")
      .attr("x", W - margin.right)
      .attr("y", H - 20)
      .attr("text-anchor", "end")
      .attr("fill", "#70767d")
      .attr("font-size", 11)
      .text(props.loading ? "History loading…" : "No history available");
}
onMounted(() => {
  draw();
  document.addEventListener("keydown", dismissSourceTooltip);
});
onBeforeUnmount(() => {
  clearTimeout(tooltipHideTimer);
  document.removeEventListener("keydown", dismissSourceTooltip);
});
watch(
  () => [
    props.current,
    props.expiries,
    props.history,
    props.chartStyle,
    props.snapshots,
    props.snapshotResolution,
    props.view,
    props.asset,
    props.sliceLabel,
    props.sourceLabel,
    props.loading,
    props.realized,
  ],
  draw,
);
defineExpose({
  exportPng: () =>
    exportChartToPng({
      element: svgRef.value,
      filename: `${props.asset}-${props.sliceLabel.replaceAll(/[^a-z0-9]/gi, "-")}-term-structure-${props.view}-${props.chartStyle}${props.chartStyle === "lines" ? `-${props.snapshotResolution}` : ""}.png`,
      background: "#000000",
      scale: 3,
      // Export only the SVG; page controls, details and data-status footnotes stay outside it.
      prepareSvgClone: (clone) => {
        clone
          .querySelectorAll("[data-export-omit], title")
          .forEach((node) => node.remove());
        clone.querySelectorAll("[data-export-label]").forEach((node) => {
          node.textContent = node.getAttribute("data-export-label");
        });
      },
    }),
});
</script>
<template>
  <div class="chart-scroll">
    <svg
      ref="svgRef"
      role="img"
      :aria-label="`${asset} ${sliceLabel} ${view === 'forward' ? 'forward volatility' : 'IV'} term structure with historical ${chartStyle === 'lines' ? 'snapshot lines' : 'dot clouds'}`"
    ></svg>
  </div>
  <Teleport to="body">
    <div
      v-if="tooltipVisible"
      :id="tooltipId"
      class="source-tooltip"
      role="tooltip"
      tabindex="0"
      :style="tooltipStyle"
      @mouseenter="keepSourceTooltip"
      @mouseleave="hideSourceTooltip()"
      @focusin="keepSourceTooltip"
      @focusout="hideSourceTooltip()"
      @keydown.esc="hideSourceTooltip(true)"
    >{{ tooltipText }}</div>
  </Teleport>
</template>

<style scoped>
.source-tooltip {
  position: fixed;
  z-index: 1000;
  box-sizing: border-box;
  overflow-y: auto;
  padding: 18px 20px;
  border: 1px solid #414751;
  border-radius: 8px;
  background: #15181d;
  color: #f0f2f5;
  box-shadow: 0 10px 32px rgba(0, 0, 0, 0.5);
  font-family: "Helvetica Neue", Helvetica, -apple-system, sans-serif;
  font-size: 14px;
  font-weight: 400;
  line-height: 1.65;
  white-space: pre-line;
  overflow-wrap: anywhere;
  cursor: default;
}
</style>
