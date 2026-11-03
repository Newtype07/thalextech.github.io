<script setup>
import * as d3 from "d3";
import { onMounted, onUnmounted, ref, watch } from "vue";
import { exportChartToPng } from "../../../../lib/export-png.js";

const props = defineProps({
  payoff: { type: Object, default: null },
  asset: { type: String, default: "BTC" },
  loading: Boolean,
});
const svgRef = ref(null);
let resizeObserver;
const money = d3.format(",.2f");
const priceLabel = (value) => `$${money(value)}`;

defineExpose({ exportPng: (options = {}) => exportChartToPng({
  element: svgRef.value, filename: "payoff.png", scale: 4, padding: 24, ...options,
}) });

function render() {
  if (!svgRef.value) return;
  const width = Math.max(320, svgRef.value.parentElement.clientWidth || 1200);
  const compact = width < 650;
  const height = compact ? 360 : 500;
  const margin = { top: 65, right: compact ? 20 : 38, bottom: 65, left: compact ? 58 : 90 };
  const right = width - margin.right, bottom = height - margin.bottom;
  const svg = d3.select(svgRef.value).attr("viewBox", `0 0 ${width} ${height}`);
  svg.selectAll("*").remove();
  svg.attr("font-family", "system-ui, sans-serif");
  svg.append("title").text(`${props.asset} combination payoff with forward and break-even prices`);
  const points = props.payoff?.points || [];
  if (!points.length) {
    svg.append("text").attr("x", width / 2).attr("y", height / 2)
      .attr("fill", "#94a3b8").attr("text-anchor", "middle")
      .text(props.loading ? "Loading current marks and forward…" : "Add option legs to see their payoff.");
    return;
  }
  const x = d3.scaleLinear().domain(d3.extent(points, (p) => p.price)).range([margin.left, right]);
  const extent = d3.extent([0, ...points.map((p) => p.pnl)]);
  const pad = Math.max((extent[1] - extent[0]) * 0.14, 1);
  const y = d3.scaleLinear().domain([extent[0] - pad, extent[1] + pad]).nice().range([bottom, margin.top]);
  const axisStyle = (g) => {
    g.select(".domain").remove();
    g.selectAll("text").attr("fill", "#94a3b8").attr("font-size", 12);
    g.selectAll("line").attr("stroke", "#1e293b");
  };
  svg.append("g").attr("transform", `translate(${margin.left},0)`)
    .call(d3.axisLeft(y).ticks(6).tickSize(-(right - margin.left)).tickPadding(12).tickFormat(d3.format(",.0f")))
    .call(axisStyle);
  svg.append("g").attr("transform", `translate(0,${bottom})`)
    .call(d3.axisBottom(x).ticks(compact ? 4 : 8).tickSize(0).tickPadding(14).tickFormat(d3.format(",.0f")))
    .call(axisStyle);
  svg.append("text").attr("x", (margin.left + right) / 2).attr("y", height - 15)
    .attr("text-anchor", "middle").attr("fill", "#cbd5e1").attr("font-size", 13)
    .text(`${props.asset} price at first expiry (USD)`);
  svg.append("text").attr("x", margin.left).attr("y", 24).attr("fill", "#cbd5e1")
    .attr("font-size", 13).text("Profit / loss (USD)");
  const defs = svg.append("defs");
  for (const [name, top, h] of [["profit", margin.top, y(0) - margin.top], ["loss", y(0), bottom - y(0)]]) {
    defs.append("clipPath").attr("id", `payoff-${name}`).append("rect")
      .attr("x", margin.left).attr("y", top).attr("width", right - margin.left).attr("height", Math.max(0, h));
  }
  const area = d3.area().x((p) => x(p.price)).y0(y(0)).y1((p) => y(p.pnl));
  const line = d3.line().x((p) => x(p.price)).y((p) => y(p.pnl));
  for (const [name, color] of [["profit", "#34d399"], ["loss", "#fb7185"]]) {
    svg.append("path").datum(points).attr("d", area).attr("fill", color).attr("opacity", 0.1)
      .attr("clip-path", `url(#payoff-${name})`);
    svg.append("path").datum(points).attr("d", line).attr("fill", "none").attr("stroke", color)
      .attr("stroke-width", 2.8).attr("stroke-linejoin", "round").attr("clip-path", `url(#payoff-${name})`);
  }
  svg.append("line").attr("x1", margin.left).attr("x2", right).attr("y1", y(0)).attr("y2", y(0))
    .attr("stroke", "#64748b").attr("stroke-dasharray", "4 5");
  const forwardX = x(props.payoff.forward);
  svg.append("line").attr("x1", forwardX).attr("x2", forwardX).attr("y1", margin.top).attr("y2", bottom)
    .attr("stroke", "#60a5fa").attr("stroke-dasharray", "6 5").attr("stroke-width", 1.3);
  svg.append("text").attr("x", Math.max(margin.left + 90, Math.min(right - 90, forwardX)))
    .attr("y", margin.top - 15).attr("fill", "#93c5fd").attr("text-anchor", "middle")
    .attr("font-size", 13).text(`Forward ${priceLabel(props.payoff.forward)}`);
  props.payoff.breakEvens.points.forEach((price, i) => {
    svg.append("circle").attr("cx", x(price)).attr("cy", y(0)).attr("r", 5)
      .attr("fill", "#000").attr("stroke", "#f8fafc").attr("stroke-width", 2);
    svg.append("text").attr("x", Math.max(margin.left + 65, Math.min(right - 65, x(price))))
      .attr("y", y(0) + (i % 2 ? 30 : -18)).attr("text-anchor", "middle")
      .attr("fill", "#e2e8f0").attr("font-size", 12).text(`BE ${priceLabel(price)}`);
  });
  const focus = svg.append("g").attr("visibility", "hidden").attr("pointer-events", "none");
  const dot = focus.append("circle").attr("r", 4).attr("fill", "#fff");
  const box = focus.append("rect").attr("width", 220).attr("height", 48).attr("rx", 6)
    .attr("fill", "#0f172a").attr("stroke", "#334155");
  const text = focus.append("text").attr("fill", "#e2e8f0").attr("font-size", 12);
  svg.append("rect").attr("x", margin.left).attr("y", margin.top)
    .attr("width", right - margin.left).attr("height", bottom - margin.top)
    .attr("fill", "transparent").attr("cursor", "crosshair")
    .on("mousemove", (event) => {
      const [mx] = d3.pointer(event, svgRef.value);
      const index = d3.bisector((p) => p.price).center(points, x.invert(mx));
      const p = points[index], px = x(p.price), py = y(p.pnl);
      const tx = Math.max(margin.left, Math.min(right - 220, px + 14));
      const ty = Math.max(margin.top, Math.min(bottom - 48, py - 60));
      focus.attr("visibility", "visible");
      dot.attr("cx", px).attr("cy", py);
      box.attr("x", tx).attr("y", ty);
      text.selectAll("tspan").remove();
      [`${props.asset} ${priceLabel(p.price)}`, `P/L ${p.pnl < 0 ? "−" : "+"}${priceLabel(Math.abs(p.pnl))}`]
        .forEach((label, i) => text.append("tspan").attr("x", tx + 12).attr("y", ty + 19 + i * 17).text(label));
    }).on("mouseleave", () => focus.attr("visibility", "hidden"));
}
watch(() => [props.payoff, props.asset, props.loading], render);
onMounted(() => {
  render();
  resizeObserver = new ResizeObserver(render);
  resizeObserver.observe(svgRef.value.parentElement);
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
