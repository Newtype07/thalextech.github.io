<script setup>
import * as d3 from "d3";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { exportChartToPng } from "../../../../lib/export-png.js";
import { HISTORY_VIEWS } from "../skew-timeseries.js";
import { skewTimeSeriesPath, TENOR_COLORS, tenorLegendLabel } from "./skew-curve.js";
const props = defineProps({
  data: { type: Object, required: true },
  tenors: { type: Array, default: () => [] },
  visibleTenors: { type: Array, default: () => [] },
  history: { type: Array, default: () => [] },
  indexPoints: { type: Array, default: () => [] },
  showIndex: Boolean,
  resolution: { type: String, default: "3m" },
  asset: String, deltaLabel: String,
  snapshotTime: Number, snapshotEnd: Number, loading: Boolean,
});
const emit = defineEmits(["toggle-tenor"]);
const svgRef = ref(null), tooltipVisible = ref(false), tooltipText = ref(""), tooltipStyle = ref({});
const W = 1440, H = 760;
const baseMargin = { top: 88, right: 30, bottom: 118, left: 105 };
const stamp = d3.utcFormat("%d %b %Y %H:%M UTC");
const signed = value => `${d3.format("+.2f")(value * 100)} vol pts`;
let hideTimer;
function keepTooltip() { clearTimeout(hideTimer); }
function hideTooltip(immediate = false) {
  clearTimeout(hideTimer);
  if (immediate) tooltipVisible.value = false;
  else hideTimer = setTimeout(() => { tooltipVisible.value = false; }, 100);
}
function showTooltip(event, text) {
  clearTimeout(hideTimer);
  const bounds = event.currentTarget.getBoundingClientRect();
  const width = Math.min(440, window.innerWidth - 24);
  const clientX = Number.isFinite(event.clientX) ? event.clientX : bounds.left + bounds.width / 2;
  const clientY = Number.isFinite(event.clientY) ? event.clientY : bounds.bottom;
  tooltipStyle.value = {
    width: `${width}px`,
    left: `${Math.max(12, Math.min(clientX + 16, window.innerWidth - width - 12))}px`,
    top: `${Math.max(12, Math.min(clientY + 16, window.innerHeight - 280))}px`,
    maxHeight: `${Math.max(100, window.innerHeight - 32)}px`,
  };
  tooltipText.value = text; tooltipVisible.value = true;
}
function sourceDetails() {
  const range = (start, end) => Number.isFinite(start) && Number.isFinite(end)
    ? `${stamp(new Date(start * 1000))} — ${stamp(new Date(end * 1000))}` : "Unavailable";
  const spec = HISTORY_VIEWS.find(item => item.value === props.resolution);
  return ["Constant-maturity, constant-delta skew", range(...d3.extent(props.history, p => p.ts)),
    "Thalex · Parquet closing mark IV with API tail updates · separate-wing total-variance interpolation",
    "", `${spec.label} · ${spec.sampling}`, "Historical values: call IV − put IV, at the same UTC close.",
    "", "Latest live quote collection", range(props.snapshotTime, props.snapshotEnd), "Live marks",
  ].join("\n");
}
function draw() {
  if (!svgRef.value) return;
  const margin = { ...baseMargin, right: props.showIndex ? 115 : baseMargin.right };
  hideTooltip(true);
  const svg = d3.select(svgRef.value);
  svg.selectAll("*").remove();
  svg.attr("viewBox", `0 0 ${W} ${H}`).attr("font-family", '"Helvetica Neue", Helvetica, Arial, sans-serif');
  svg.append("rect").attr("width", W).attr("height", H).attr("fill", "#0a0b0e");
  svg.append("text").attr("x", W / 2).attr("y", 43).attr("text-anchor", "middle")
    .attr("fill", "#f2f2f4").attr("font-size", 23).attr("font-weight", 550)
    .text(`${props.asset} ${props.deltaLabel.replace("Δ", "")} Delta Skew`);
  svg.append("text").attr("x", W / 2).attr("y", 67).attr("text-anchor", "middle")
    .attr("fill", "#777b83").attr("font-size", 11).attr("tabindex", 0)
    .attr("aria-label", "View skew sources and calculation")
    .on("mouseenter focus", event => showTooltip(event, sourceDetails()))
    .on("mouseleave blur", () => hideTooltip())
    .on("keydown", event => { if (event.key === "Escape") hideTooltip(true); })
    .text("Call IV − put IV · Constant maturity · UTC");

  const legendWidth = props.tenors.length * 86;
  const legend = svg.append("g").attr("class", "tenor-legend")
    .attr("transform", `translate(${(W - legendWidth) / 2},${H - 40})`)
    .selectAll("g").data(props.tenors).join("g")
    .attr("class", "tenor-legend-item").attr("transform", (_, i) => `translate(${i * 86},0)`)
    .attr("role", "button").attr("tabindex", 0)
    .attr("aria-label", tenor => `Toggle ${tenorLegendLabel(tenor)} tenor`)
    .attr("aria-pressed", tenor => props.visibleTenors.includes(tenor))
    .attr("opacity", tenor => props.visibleTenors.includes(tenor) ? 1 : 0.28)
    .style("cursor", "pointer")
    .on("click", (_, tenor) => emit("toggle-tenor", tenor))
    .on("keydown", (event, tenor) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); emit("toggle-tenor", tenor); }
    });
  legend.append("rect").attr("x", -5).attr("y", -18).attr("width", 82).attr("height", 30).attr("fill", "transparent");
  legend.append("line").attr("x1", 0).attr("x2", 22).attr("y1", -5).attr("y2", -5)
    .attr("stroke", tenor => TENOR_COLORS[tenor]).attr("stroke-width", 2);
  legend.append("text").attr("x", 30).attr("fill", "#e8eaed").attr("font-size", 15)
    .text(tenorLegendLabel);
  svg.append("text").attr("data-export-omit", "").attr("x", W / 2).attr("y", H - 13)
    .attr("text-anchor", "middle").attr("fill", "#666b74").attr("font-size", 10)
    .text("Click a tenor to show or hide it");

  const visible = props.data.series.filter(s => props.visibleTenors.includes(s.tenorDays));
  const points = visible.flatMap(s => s.points.filter(Boolean));
  if (!points.length || !props.data.timestamps.length) {
    svg.append("text").attr("x", W / 2).attr("y", H / 2).attr("text-anchor", "middle")
      .attr("fill", "#777b83").attr("font-size", 15)
      .text(!props.visibleTenors.length ? "Select a tenor below" : props.loading ? "Loading skew history…" : "No observations available for this history window.");
    return;
  }
  let from = props.data.from, to = props.data.to;
  if (from === to) { from -= 1800; to += 1800; }
  const x = d3.scaleUtc([new Date(from * 1000), new Date(to * 1000)], [margin.left, W - margin.right]);
  const xPosition = ts => x(new Date(ts * 1000));
  const [lo, hi] = d3.extent([0, ...points.map(p => p.skew)]);
  const pad = Math.max((hi - lo) * 0.12, 0.005);
  const y = d3.scaleLinear([lo - pad, hi + pad], [H - margin.bottom, margin.top]).nice(7);
  const yTicks = y.ticks(7);
  const tickFormat = value => d3.format(yTicks.length > 1 && yTicks[1] - yTicks[0] < 0.0099 ? ".1f" : ".0f")(value * 100);
  // Price has its own scale and stays behind the skew curves, without another line.
  const indexPoints = props.indexPoints.filter(p => p.ts >= from && p.ts <= to && Number.isFinite(p.price) && p.price > 0);
  const indexByTime = new Map(indexPoints.map(p => [p.ts, p.price]));
  if (props.showIndex && indexPoints.length) {
    const [priceLow, priceHigh] = d3.extent(indexPoints, p => p.price);
    const pricePad = Math.max((priceHigh - priceLow) * 0.12, priceHigh * 0.005);
    const priceY = d3.scaleLinear([priceLow - pricePad, priceHigh + pricePad], [H - margin.bottom, margin.top]).nice(6);
    svg.append("g").attr("class", "index-scatter").attr("pointer-events", "none")
      .selectAll("circle").data(indexPoints).join("circle")
      .attr("cx", p => xPosition(p.ts)).attr("cy", p => priceY(p.price))
      .attr("r", 2).attr("fill", "#b2bac9").attr("fill-opacity", 0.3);
    const priceAxis = svg.append("g").attr("class", "index-axis")
      .attr("transform", `translate(${W - margin.right},0)`)
      .call(d3.axisRight(priceY).ticks(6).tickFormat(d3.format(",.0f")).tickSize(0).tickPadding(14));
    priceAxis.select(".domain").remove();
    priceAxis.selectAll("text").attr("fill", "#8993a3").attr("font-size", 12);
    svg.append("text").attr("transform", `translate(${W - 18},${(margin.top + H - margin.bottom) / 2}) rotate(90)`)
      .attr("text-anchor", "middle").attr("fill", "#8993a3").attr("font-size", 11)
      .text(`${props.asset} INDEX · USD`);
  }
  svg.append("line").attr("x1", margin.left).attr("x2", W - margin.right)
    .attr("y1", y(0)).attr("y2", y(0)).attr("stroke", "#56585e").attr("stroke-width", 1.2);
  const leftAxis = svg.append("g").attr("transform", `translate(${margin.left},0)`)
    .call(d3.axisLeft(y).ticks(7).tickFormat(tickFormat).tickSize(0).tickPadding(18));
  leftAxis.select(".domain").remove();
  leftAxis.selectAll("text").attr("fill", "#e8eaed").attr("font-size", 14);
  svg.append("text").attr("class", "y-axis-title")
    .attr("transform", `translate(24,${(margin.top + H - margin.bottom) / 2}) rotate(-90)`)
    .attr("text-anchor", "middle").attr("fill", "#c3c7d0").attr("font-size", 12)
    .text("CALL IV − PUT IV · VOLATILITY POINTS");
  const shortRange = to - from <= 4 * 86400;
  const longRange = to - from > 100 * 86400;
  const bottomAxis = svg.append("g").attr("transform", `translate(0,${H - margin.bottom + 12})`)
    .call(d3.axisBottom(x).ticks(longRange ? d3.utcMonth.every(1) : to - from > 30 * 86400 ? d3.utcWeek.every(2) : shortRange ? 6 : 8)
      .tickFormat(d3.utcFormat(shortRange ? "%d %b %H:%M" : longRange ? "%b '%y" : "%d %b"))
      .tickSize(0).tickPadding(17));
  bottomAxis.select(".domain").remove();
  bottomAxis.selectAll("text").attr("fill", "#d5d8df").attr("font-size", 13);
  // Distinguish an unfinished recent backfill from an actual source-data hole.
  // Show the cached curves immediately; do not draw a fabricated bridge to live.
  if (props.loading) {
    let last = props.data.timestamps.length - 1;
    if (visible.some(s => s.points[last]?.live)) last--;
    if (last >= 0 && visible.some(s => !s.points[last])) {
      let start = last;
      while (start > 0 && visible.some(s => !s.points[start - 1])) start--;
      const left = xPosition(props.data.timestamps[Math.max(0, start - 1)]);
      svg.append("rect").attr("data-export-omit", "").attr("x", left).attr("y", margin.top)
        .attr("width", Math.max(0, W - margin.right - left)).attr("height", H - margin.top - margin.bottom)
        .attr("fill", "#adb7ca").attr("fill-opacity", 0.045).attr("pointer-events", "none");
      svg.append("text").attr("data-export-omit", "").attr("x", W - margin.right - 12).attr("y", margin.top + 18)
        .attr("text-anchor", "end").attr("fill", "#b3bac7").attr("font-size", 11)
        .text("Updating recent history…");
    }
  }
  // Clip every series to the plotting region, including live endpoints.
  svg.append("defs").append("clipPath").attr("id", "skew-time-clip").append("rect")
    .attr("x", margin.left - 4).attr("y", margin.top).attr("width", W - margin.left - margin.right + 8)
    .attr("height", H - margin.top - margin.bottom);
  const curves = svg.append("g").attr("clip-path", "url(#skew-time-clip)")
    .selectAll("g").data(visible, s => s.tenorDays).join("g").attr("class", "tenor-series");
  curves.append("path").attr("class", "tenor-line").attr("d", s => skewTimeSeriesPath(s.points, xPosition, y))
    .attr("fill", "none").attr("stroke", s => TENOR_COLORS[s.tenorDays]).attr("stroke-width", 1.65);
  curves.each(function(series) {
    const latest = series.points.at(-1);
    if (latest?.live) d3.select(this).append("circle").attr("cx", xPosition(latest.ts)).attr("cy", y(latest.skew))
      .attr("r", 2.6).attr("fill", TENOR_COLORS[series.tenorDays]);
  });

  const crosshair = svg.append("g").attr("data-export-omit", "").attr("display", "none").attr("pointer-events", "none");
  crosshair.append("line").attr("y1", margin.top).attr("y2", H - margin.bottom)
    .attr("stroke", "#858a95").attr("stroke-dasharray", "3 5").attr("stroke-opacity", 0.65);
  const inspect = (event, index) => {
    const ts = props.data.timestamps[index];
    const rows = visible.map(s => ({ tenorDays: s.tenorDays, point: s.points[index] }));
    crosshair.attr("display", null).select("line").attr("x1", xPosition(ts)).attr("x2", xPosition(ts));
    crosshair.selectAll("circle").data(rows.filter(row => row.point)).join("circle")
      .attr("cx", xPosition(ts)).attr("cy", row => y(row.point.skew)).attr("r", 3)
      .attr("fill", row => TENOR_COLORS[row.tenorDays]).attr("stroke", "#0a0b0e").attr("stroke-width", 1);
    showTooltip(event, [stamp(new Date(ts * 1000)),
      ...rows.map(row => `${tenorLegendLabel(row.tenorDays)} · ${row.point ? signed(row.point.skew) : "Unavailable"}`),
      ...(props.showIndex ? [`${props.asset} index · ${indexByTime.has(ts) ? `$${d3.format(",.2f")(indexByTime.get(ts))}` : "Unavailable"}`] : []),
      rows.some(row => row.point?.live) ? "Latest: live marks" : "Closing mark IV · Constant delta / maturity",
      "Observed values · Lines visually smoothed",
    ].join("\n"));
  };
  let inspectedIndex = props.data.timestamps.length - 1;
  svg.append("rect").attr("data-export-omit", "").attr("fill", "transparent")
    .attr("x", margin.left).attr("y", margin.top).attr("width", W - margin.left - margin.right)
    .attr("height", H - margin.top - margin.bottom).attr("tabindex", 0)
    .attr("aria-label", "Inspect skew over time. Use left and right arrows to move between timestamps.")
    .on("pointermove", event => {
      const [px] = d3.pointer(event, svgRef.value);
      inspectedIndex = d3.bisectCenter(props.data.timestamps, x.invert(px).getTime() / 1000);
      inspect(event, inspectedIndex);
    })
    .on("pointerleave blur", () => { crosshair.attr("display", "none"); hideTooltip(); })
    .on("focus", event => inspect(event, inspectedIndex))
    .on("keydown", event => {
      if (event.key === "Escape") { crosshair.attr("display", "none"); hideTooltip(true); }
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        inspectedIndex = Math.max(0, Math.min(props.data.timestamps.length - 1, inspectedIndex + (event.key === "ArrowRight" ? 1 : -1)));
        inspect(event, inspectedIndex);
      }
    });
}
onMounted(draw);
onBeforeUnmount(() => clearTimeout(hideTimer));
watch(() => [props.data, props.visibleTenors, props.asset, props.deltaLabel, props.loading, props.showIndex, props.indexPoints], draw);
defineExpose({ exportPng: () => exportChartToPng({
  element: svgRef.value,
  filename: `${props.asset}-${props.deltaLabel.replace("Δ", "delta")}-skew-history-${props.resolution}.png`,
  background: "#0a0b0e", scale: 3,
  prepareSvgClone: clone => clone.querySelectorAll("[data-export-omit], title").forEach(node => node.remove()),
}) });
</script>
<template>
  <div class="chart-scroll">
    <svg ref="svgRef" role="img" :aria-label="`${asset} ${deltaLabel} call-minus-put skew over time, with red-to-blue lines for each constant tenor${showIndex ? ' and background index-price dots on a separate USD scale' : ''}`"></svg>
  </div>
  <Teleport to="body">
    <div v-if="tooltipVisible" class="source-tooltip" role="tooltip" :style="tooltipStyle"
      @mouseenter="keepTooltip" @mouseleave="hideTooltip()">{{ tooltipText }}</div>
  </Teleport>
</template>
<style scoped>
.source-tooltip {
  position: fixed; z-index: 1000; overflow-y: auto; box-sizing: border-box;
  padding: 16px 18px; border: 1px solid #414751; border-radius: 8px;
  background: #15181d; color: #f0f2f5; box-shadow: 0 10px 32px rgba(0,0,0,.5);
  font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
  font-size: 13px; line-height: 1.7; white-space: pre-line;
}
</style>
