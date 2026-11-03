<script setup>
import * as d3 from "d3";
import { onMounted, onUnmounted, ref, watch, useId } from "vue";
import { exportChartToPng } from "../../../../lib/export-png.js";

const props = defineProps({
  payoff: { type: Object, default: null },
  asset: { type: String, default: "BTC" },
  loading: Boolean,
});
const svgRef = ref(null);
let resizeObserver;
const DATA_LABEL_PX = 10; // Match the instrument selector's Greek values.
const AXIS_TITLE_PX = 12;

const SVG_FONT_FAMILY = 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"';
const layout = { width: 1800, height: 900, margin: { top: 90, right: 220, bottom: 80, left: 90 } };
const money = d3.format(",.2f");
const priceLabel = (value) => `$${d3.format(",.0f")(value)}`;
const gradientId = `payoff-fill-${useId()}`;

defineExpose({ exportPng: (options = {}) => exportChartToPng({
  element: svgRef.value, filename: "payoff.png", scale: 4, padding: 24, ...options,
}) });

function render() {
  if (!svgRef.value) return;
  const { width, height, margin } = layout;
  const renderedWidth = svgRef.value.getBoundingClientRect().width || svgRef.value.parentElement.clientWidth || 1160;
  // Preserve the same screen-pixel type scale when the SVG viewBox resizes.
  const dataLabelSize = DATA_LABEL_PX * width / renderedWidth;
  const axisTitleSize = AXIS_TITLE_PX * width / renderedWidth;
  const right = width - margin.right, bottom = height - margin.bottom;
  const svg = d3.select(svgRef.value).attr("viewBox", `0 0 ${width} ${height}`);
  svg.selectAll("*").remove();
  svg.attr("font-family", SVG_FONT_FAMILY);
  svg.append("title").text(`${props.asset} combination payoff with forward and break-even prices`);
  const points = props.payoff?.points || [];
  if (!points.length) {
    svg.append("text").attr("x", width / 2).attr("y", height / 2)
      .attr("fill", "#999999").attr("text-anchor", "middle")
      .text(props.loading ? "Loading current marks and forward…" : "Add option legs to see their payoff.");
    return;
  }
  const x = d3.scaleLinear().domain(d3.extent(points, (p) => p.price)).range([margin.left, right]);
  const decayCurves = props.payoff.decayCurves || [];
  const extent = d3.extent([0, ...points.map((p) => p.pnl), ...decayCurves.flatMap(curve => curve.points.map(point => point.pnl))]);
  const pad = Math.max((extent[1] - extent[0]) * 0.14, 1);
  const y = d3.scaleLinear().domain([extent[0] - pad, extent[1] + pad]).nice().range([bottom, margin.top]);
  const axisStyle = (g) => {
    g.select(".domain").remove();
    g.selectAll("text").attr("fill", "#d4d7e2").attr("font-size", dataLabelSize);
    g.selectAll("line").remove();
  };
  svg.append("g").attr("transform", `translate(${margin.left},0)`)
    .call(d3.axisLeft(y).ticks(4).tickSize(0).tickPadding(16).tickFormat(d3.format(",.0f")))
    .call(axisStyle);
  svg.append("g").attr("transform", `translate(0,${bottom})`)
    .call(d3.axisBottom(x).ticks(renderedWidth < 650 ? 4 : 8).tickSize(0).tickPadding(16).tickFormat(d3.format(",.0f")))
    .call(axisStyle);
  svg.append("text").attr("x", (margin.left + right) / 2).attr("y", height - 15)
    .attr("text-anchor", "middle").attr("fill", "#f7f8fb").attr("font-size", axisTitleSize).attr("font-weight", 500)
    .text(`${props.asset} Price`);
  svg.append("text").attr("transform", "rotate(-90)")
    .attr("x", -height / 2).attr("y", 28).attr("text-anchor", "middle")
    .attr("fill", "#f7f8fb").attr("font-size", axisTitleSize).attr("font-weight", 500).text("P&L (USD)");
  const defs = svg.append("defs");
  for (const [name, top, h] of [["profit", margin.top, y(0) - margin.top], ["loss", y(0), bottom - y(0)]]) {
    defs.append("clipPath").attr("id", `payoff-${name}`).append("rect")
      .attr("x", margin.left).attr("y", top).attr("width", right - margin.left).attr("height", Math.max(0, h));
  }
  const area = d3.area().x((p) => x(p.price)).y0(y(0)).y1((p) => y(p.pnl));
  const line = d3.line().x((p) => x(p.price)).y((p) => y(p.pnl));
  for (const [name, color] of [["profit", "#00bf8c"], ["loss", "#ff1654"]]) {
    const gradient = defs.append("linearGradient").attr("id", `${gradientId}-${name}`)
      .attr("gradientUnits", "userSpaceOnUse")
      .attr("x1", 0).attr("x2", 0).attr("y1", y(0))
      .attr("y2", y(name === "profit" ? extent[1] : extent[0]));
    gradient.append("stop").attr("offset", "0%").attr("stop-color", color).attr("stop-opacity", 0.015);
    gradient.append("stop").attr("offset", "100%").attr("stop-color", color).attr("stop-opacity", 0.3);
    svg.append("path").datum(points).attr("d", area).attr("fill", `url(#${gradientId}-${name})`)
      .attr("clip-path", `url(#payoff-${name})`);
  }
  const decayOpacity = [0.65, 0.48, 0.34, 0.22];
  decayCurves.forEach((curve, i) => {
    svg.append("path").datum(curve.points).attr("class", "decay-curve")
      .attr("d", line).attr("fill", "none").attr("stroke", "#fff")
      .attr("stroke-width", 1.5).attr("stroke-opacity", decayOpacity[i] ?? 0.3)
      .attr("stroke-linejoin", "round");
  });
  for (const [name, color] of [["profit", "#00bf8c"], ["loss", "#ff1654"]]) {
    svg.append("path").datum(points).attr("d", line).attr("fill", "none").attr("stroke", color)
      .attr("stroke-width", 3).attr("stroke-linejoin", "round").attr("clip-path", `url(#payoff-${name})`);
  }
  const forwardX = x(props.payoff.forward);
  svg.append("line").attr("x1", forwardX).attr("x2", forwardX).attr("y1", margin.top).attr("y2", bottom)
    .attr("stroke", "#ffffff").attr("stroke-width", 1);
  svg.append("text").attr("x", Math.max(margin.left + 90, Math.min(right - 90, forwardX)))
    .attr("y", margin.top - 15).attr("fill", "#ffffff").attr("text-anchor", "middle")
    .attr("font-size", dataLabelSize).text(`Forward ${priceLabel(props.payoff.forward)}`);
  if (decayCurves.length) {
    const legend = svg.append("g").attr("class", "decay-legend").attr("transform", `translate(${right + 28},${margin.top + 8})`);
    legend.append("text").attr("fill", "#d4d7e2").attr("font-size", dataLabelSize).attr("font-weight", 500).text("Elapsed");
    decayCurves.forEach((curve, i) => {
      const ly = dataLabelSize * 1.8 * (i + 1);
      legend.append("line").attr("x1", 0).attr("x2", dataLabelSize * 1.4).attr("y1", ly).attr("y2", ly)
        .attr("stroke", "#fff").attr("stroke-width", 1.5).attr("stroke-opacity", decayOpacity[i] ?? 0.3);
      legend.append("text").attr("x", dataLabelSize * 2).attr("y", ly + dataLabelSize * 0.32).attr("fill", "#d4d7e2").attr("font-size", dataLabelSize)
        .text(curve.elapsedFraction === 0 ? "Now" : `${curve.elapsedFraction * 100}%`);
    });
  }
  const focus = svg.append("g").attr("visibility", "hidden").attr("pointer-events", "none");
  const dot = focus.append("circle").attr("r", 4).attr("fill", "#fff");
  const box = focus.append("rect").attr("width", 240).attr("height", 64).attr("rx", 6)
    .attr("fill", "#111111").attr("stroke", "#333333");
  const text = focus.append("text").attr("fill", "#eeeeee").attr("font-size", 12);
  svg.append("rect").attr("x", margin.left).attr("y", margin.top)
    .attr("width", right - margin.left).attr("height", bottom - margin.top)
    .attr("fill", "transparent").attr("cursor", "crosshair")
    .on("mousemove", (event) => {
      const [mx, my] = d3.pointer(event, svgRef.value);
      const index = d3.bisector((p) => p.price).center(points, x.invert(mx));
      const candidates = [
        { label: props.payoff.mixedMaturities ? "First expiry" : "Expiry", point: points[index] },
        ...decayCurves.map(curve => ({ label: curve.label, point: curve.points[index] })),
      ];
      const nearest = candidates.reduce((best, candidate) => Math.abs(y(candidate.point.pnl) - my) < Math.abs(y(best.point.pnl) - my) ? candidate : best);
      const p = nearest.point, px = x(p.price), py = y(p.pnl);
      const tx = Math.max(margin.left, Math.min(right - 240, px + 14));
      const ty = Math.max(margin.top, Math.min(bottom - 64, py - 76));
      focus.attr("visibility", "visible");
      dot.attr("cx", px).attr("cy", py);
      box.attr("x", tx).attr("y", ty);
      text.selectAll("tspan").remove();
      [nearest.label, `${props.asset} ${priceLabel(p.price)}`, `P/L ${p.pnl < 0 ? "−" : "+"}$${money(Math.abs(p.pnl))}`]
        .forEach((label, i) => text.append("tspan").attr("x", tx + 12).attr("y", ty + 19 + i * 17).text(label));
    }).on("mouseleave", () => focus.attr("visibility", "hidden"));
}
watch(() => [props.payoff, props.asset, props.loading], render);
onMounted(() => {
  render();
  if (typeof ResizeObserver === "function") {
    resizeObserver = new ResizeObserver(render);
    resizeObserver.observe(svgRef.value.parentElement);
  }
});
onUnmounted(() => resizeObserver?.disconnect());
</script>

<template>
  <div class="payoffChart" :aria-busy="loading">
    <svg ref="svgRef" role="img" aria-label="Combination payoff chart" />
  </div>
</template>

<style scoped>
.payoffChart { border-radius: 14px; overflow: hidden; background: #000; }
svg { display: block; width: 100%; height: auto; min-height: 240px; }
</style>
