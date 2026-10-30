<script setup>
import * as d3 from "d3";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { exportChartToPng } from "../../../../lib/export-png.js";
import { interpolateSkewMaturities, SNAPSHOT_RESOLUTIONS } from "../skew-snapshots.js";
import { skewCurvePaths } from "./skew-curve.js";
const props = defineProps({
  current: Array,
  expiries: { type: Array, default: () => [] },
  history: Array,
  snapshots: { type: Array, default: () => [] },
  resolution: { type: String, default: "daily" },
  referenceTime: Number,
  asset: String,
  deltaLabel: String,
  sourceLabel: String,
  snapshotTime: Number,
  snapshotEnd: Number,
  loading: Boolean,
});
const svgRef = ref(null);
const tooltipVisible = ref(false);
const tooltipText = ref("");
const tooltipStyle = ref({});
const tooltipId = "skew-source-tooltip";
let tooltipHideTimer;
const W = 1280,
  H = 600,
  margin = { top: 114, right: 44, bottom: 82, left: 78 };
const date = d3.utcFormat("%d %b %y"),
  stamp = d3.utcFormat("%d %b %Y %H:%M UTC");
function sourceDetails() {
  const range = (start, end) => Number.isFinite(start) && Number.isFinite(end)
    ? `${stamp(new Date(start * 1000))} — ${stamp(new Date(end * 1000))}`
    : "Unavailable";
  const ivRange = d3.extent(props.history, point => point.ts);
  const spec = SNAPSHOT_RESOLUTIONS.find(item => item.value === props.resolution);
  const latestClose = Number.isFinite(props.referenceTime) ? Math.floor(props.referenceTime / 3600) * 3600 : null;
  return [
    "Loaded hourly skew data",
    range(...ivRange),
    "Thalex · paired hourly closing call/put mark IV",
    "",
    `${spec.label} · ${props.snapshots.length}/${spec.count} snapshots`,
    range(latestClose == null ? null : latestClose - (spec.count - 1) * spec.step, latestClose),
    "Dashed: linear maturity interpolation at the same UTC close; no end extrapolation",
    "",
    "Live snapshot collection",
    range(props.snapshotTime, props.snapshotEnd),
    "Delta: Black–Scholes spot delta, zero rates/carry",
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
  const spec = SNAPSHOT_RESOLUTIONS.find(item => item.value === props.resolution);
  const plottedHistory = props.snapshots.flatMap(snapshot => snapshot.points.filter(Boolean));
  svg.selectAll("*").remove();
  svg
    .attr("viewBox", `0 0 ${W} ${H}`)
    .attr(
      "font-family",
      '"Helvetica Neue", Helvetica, -apple-system, sans-serif',
    );
  svg.append("rect").attr("width", W).attr("height", H).attr("fill", "#0a0b0e");
  svg
    .append("text")
    .attr("x", W / 2)
    .attr("y", 36)
    .attr("text-anchor", "middle")
    .attr("fill", "#e8eaed")
    .attr("font-size", 18)
    .attr("font-weight", 650)
    .text(`${props.asset} / ${props.deltaLabel} call−put skew by maturity`);
  svg
    .append("text")
    .attr("class", "chart-subtitle")
    .attr("tabindex", 0)
    .attr("x", W / 2)
    .attr("y", 62)
    .attr("text-anchor", "middle")
    .attr("fill", "#70767d")
    .attr("font-size", 12)
    .text(`${props.snapshotTime ? stamp(new Date(props.snapshotTime * 1000)) : "Awaiting live quotes"} · Solid white: ${props.sourceLabel.toLowerCase()}`);
  svg.append("text")
    .attr("class", "chart-subtitle").attr("tabindex", 0)
    .attr("x", W / 2).attr("y", 82).attr("text-anchor", "middle")
    .attr("fill", "#70767d").attr("font-size", 11)
    .text(`${spec.label} · ${props.snapshots.length}/${spec.count} snapshots · Older: faded violet → Newer: bright cyan`);
  svg.append("text").attr("x", W / 2).attr("y", 100).attr("text-anchor", "middle")
    .attr("fill", "#8b929d").attr("font-size", 10)
    .text("Solid: observed · Dashed: interpolated between maturities");
  svg.selectAll(".chart-subtitle")
    .attr("aria-label", "View skew source data")
    .attr("aria-describedby", tooltipId)
    .on("mouseenter.source focus.source", showSourceTooltip)
    .on("mouseleave.source blur.source", () => hideSourceTooltip())
    .on("keydown.source", event => {
      if (event.key === "Escape") hideSourceTooltip(true);
    });
  if (!props.current.length && !plottedHistory.length) {
    svg.append("text").attr("x", W / 2).attr("y", H / 2)
      .attr("text-anchor", "middle").attr("fill", "#70767d").attr("font-size", 16)
      .text(props.loading ? "Fetching call−put skew…" : "No skew observations available for the selected dates. Try another resolution or refresh.");
    return;
  }
  const expiries = props.expiries.length
    ? props.expiries
    : [
        ...new Set([...props.current, ...props.history].map((p) => p.expiry)),
      ].sort((a, b) => a - b);
  const periodLabel = expiry => date(new Date(expiry * 1000));
  const skewLabel = value => `${d3.format("+.2f")(value * 100)} vol pts`;
  const x = d3
    .scalePoint(expiries, [margin.left, W - margin.right])
    .padding(0.48);
  // Always include zero, retain negative skew, and pad even a flat zero curve.
  const [lo, hi] = d3.extent([0, ...props.current.map(p => p.skew), ...plottedHistory.map(p => p.skew)]);
  const pad = Math.max((hi - lo) * 0.14, 0.005);
  const y = d3.scaleLinear([lo - pad, hi + pad], [H - margin.bottom, margin.top]).nice(6);
  svg.append("line").attr("class", "zero-line")
    .attr("x1", margin.left).attr("x2", W - margin.right)
    .attr("y1", y(0)).attr("y2", y(0)).attr("stroke", "#646974")
    .attr("stroke-dasharray", "4 5").attr("stroke-opacity", 0.6);
  const grid = svg
    .append("g")
    .attr("transform", `translate(${margin.left},0)`)
    .call(
      d3
        .axisLeft(y)
        .ticks(6)
        .tickFormat(value => d3.format("+.1f")(value * 100))
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
    .text("CALL IV − PUT IV · VOL POINTS");
  svg
    .append("text")
    .attr("x", (W + margin.left - margin.right) / 2)
    .attr("y", H - 20)
    .attr("text-anchor", "middle")
    .attr("fill", "#70767d")
    .attr("font-size", 11)
    .text("LISTED EXPIRY · UTC");

  const curvePaths = points => skewCurvePaths(points, x, y);
  const recency = snapshot => 1 - snapshot.ageIndex / Math.max(1, spec.count - 1);
  const historyColor = d3.interpolateRgbBasis(["#a78bfa", "#638bff", "#22d3ee"]);
  const opacity = snapshot => 0.12 + 0.73 * recency(snapshot) ** 1.35;
  const snapshotDetails = snapshot => [
    `Historical ${props.deltaLabel} skew: ${stamp(new Date(snapshot.ts * 1000))}`,
    ...snapshot.points.map((point, index) => `${periodLabel(expiries[index])}: ${point ? skewLabel(point.skew) + (point.interpolated ? ` · interpolated (${periodLabel(point.leftExpiry)} → ${periodLabel(point.rightExpiry)})` : " · observed") : "unavailable (outside observed maturities)"}`),
  ].join("\n");
  const curves = svg.append("g").attr("class", "snapshot-curves")
    .selectAll("g").data(props.snapshots, snapshot => snapshot.ts).join("g")
    .attr("class", "snapshot-curve")
    .attr("data-timestamp", snapshot => snapshot.ts)
    .attr("tabindex", 0)
    .attr("aria-label", snapshotDetails)
    .attr("data-curve-opacity", opacity)
    .attr("opacity", opacity)
    .on("mouseenter.snapshot focus.snapshot", (event, snapshot) => {
      d3.select(event.currentTarget).attr("opacity", 1)
        .selectAll("path").attr("stroke-width", 2.2);
      showTooltip(event, snapshotDetails(snapshot));
    })
    .on("mouseleave.snapshot blur.snapshot", (event, snapshot) => {
      d3.select(event.currentTarget).attr("opacity", opacity(snapshot))
        .selectAll("path").attr("stroke-width", 1.35);
      hideSourceTooltip();
    });
  curves.each(function(snapshot) {
    const paths = curvePaths(snapshot.points);
    for (const kind of ["observed", "interpolated"]) {
      d3.select(this).append("path")
        .attr("class", `snapshot-line snapshot-line-${kind}`)
        .attr("d", paths[kind])
        .attr("fill", "none")
        .attr("stroke", historyColor(recency(snapshot)))
        .attr("stroke-width", 1.35)
        .attr("stroke-dasharray", kind === "interpolated" ? "5 4" : null);
    }
  });
  {
    const currentByExpiry = new Map(props.current.map((p) => [p.expiry, p]));
    const currentPoints = interpolateSkewMaturities(expiries.map(expiry => currentByExpiry.get(expiry) ?? null), expiries);
    const paths = curvePaths(currentPoints);
    for (const kind of ["observed", "interpolated"]) {
      svg.append("path").attr("d", paths[kind]).attr("fill", "none")
        .attr("stroke", "#0a0b0e").attr("stroke-width", 7);
      const path = svg.append("path").attr("d", paths[kind]).attr("fill", "none")
        .attr("stroke", "#f5f5f7").attr("stroke-width", 2.5)
        .attr("stroke-dasharray", kind === "interpolated" ? "5 4" : null);
      if (kind === "interpolated") path.append("title").text([
        "Current skew · interpolated between observed maturities",
        ...currentPoints.filter(p => p?.interpolated).map(p => `${periodLabel(p.expiry)}: ${skewLabel(p.skew)} · interpolated`),
      ].join("\n"));
    }
    const current = svg.append("g").selectAll("g").data(props.current).join("g");
    current
      .append("circle")
      .attr("cx", (p) => x(p.expiry))
      .attr("cy", (p) => y(p.skew))
      .attr("r", 5)
      .attr("fill", "#fff")
      .attr("stroke", "#0a0b0e")
      .attr("stroke-width", 2);
    current
      .append("text")
      .attr("x", (p) => x(p.expiry))
      .attr("y", (p) => y(p.skew) - 18)
      .attr("fill", "#f5f5f7")
      .attr("font-size", 13)
      .attr("font-weight", 600)
      .attr("text-anchor", "middle")
      .attr("stroke", "#0a0b0e")
      .attr("stroke-width", 4)
      .attr("paint-order", "stroke")
      .text((p) => d3.format("+.1f")(p.skew * 100));
    current
      .append("title")
      .text(
        (p) =>
          `${periodLabel(p.expiry)} · Live ${skewLabel(p.skew)}\nCall IV ${(p.callIv * 100).toFixed(2)}% · Put IV ${(p.putIv * 100).toFixed(2)}%\n${p.count} historical observations · ${p.rank == null ? "No rank" : p.rank.toFixed(1) + " percentile"}`,
      );
  }
  if (props.snapshots.length < spec.count)
    svg
      .append("text")
      .attr("data-export-omit", "")
      .attr("x", W - margin.right)
      .attr("y", H - 20)
      .attr("text-anchor", "end")
      .attr("fill", "#70767d")
      .attr("font-size", 11)
      .text(props.loading ? "History updating…" : `${spec.count - props.snapshots.length} snapshots unavailable: no observations at the requested close`);
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
    props.snapshots,
    props.resolution,
    props.asset,
    props.deltaLabel,
    props.sourceLabel,
    props.snapshotTime,
    props.snapshotEnd,
    props.loading,
  ],
  draw,
);
defineExpose({
  exportPng: () =>
    exportChartToPng({
      element: svgRef.value,
      filename: `${props.asset}-${props.deltaLabel.replace("Δ", "delta")}-skew-by-maturity-${props.resolution}-${props.sourceLabel.startsWith("Book") ? "book" : "mark"}.png`,
      background: "#0a0b0e",
      scale: 3,
      // Export only the SVG; page controls, details and data-status footnotes stay outside it.
      prepareSvgClone: (clone) => {
        // Preserve age fading even when a hovered curve is highlighted.
        clone.querySelectorAll(".snapshot-curve").forEach(node => {
          node.setAttribute("opacity", node.getAttribute("data-curve-opacity"));
          node.querySelectorAll("path").forEach(path => path.setAttribute("stroke-width", "1.35"));
        });
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
      :aria-label="`${asset} ${deltaLabel} call-minus-put skew by listed maturity with a current line and ${resolution} historical snapshot curves, in volatility points`"
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
