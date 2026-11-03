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
const DATA_LABEL_PX = 7;
const AXIS_TITLE_PX = 9;
const MARKER_LABEL_PX = 10;

const SVG_FONT_FAMILY = 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"';
const EXPORT_FONT_FAMILY = 'Helvetica, Arial, sans-serif';
const SVG_NS = "http://www.w3.org/2000/svg";
const layout = { width: 1800, height: 900, margin: { top: 90, right: 220, bottom: 80, left: 130 } };
const money = d3.format(",.2f");
const priceLabel = (value) => `$${d3.format(",.0f")(value)}`;
const gradientId = `payoff-fill-${useId()}`;

function decorateExportClone(clone, meta) {
  clone.setAttribute("font-family", EXPORT_FONT_FAMILY);
  if (!meta) return;
  const vb = clone.getAttribute("viewBox");
  if (!vb) return;
  const [x0, y0, w, h] = vb.split(" ").map(Number);
  const title = meta.title || "";
  const subtitle = meta.subtitle || "";
  const stats = Array.isArray(meta.stats) ? meta.stats : [];

  const availableTitleWidth = (x0 + w - layout.margin.right) - (x0 + layout.margin.left);
  const titleMaxSize = 32;
  const titleMinSize = 18;
  const titleEst = title ? Math.max(titleMinSize, Math.min(titleMaxSize, availableTitleWidth / Math.max(1, title.length * 0.56))) : titleMaxSize;
  const S = {
    padTop: 40, padBottom: 24,
    titleSize: titleEst, subtitleSize: 14,
    titleToSubtitle: 14, subtitleToRule: 36,
    titleToRule: 32,
    ruleToLabel: 22, labelSize: 11, labelToValue: 12, valueSize: 28,
    statsToRule: 22,
  };

  const headerTextH = title
    ? S.titleSize + (subtitle ? S.titleToSubtitle + S.subtitleSize : 0)
    : 0;
  const headerToStatsGap = title || subtitle ? (subtitle ? S.subtitleToRule : S.titleToRule) : 0;
  const statsBlockH = stats.length
    ? S.ruleToLabel + S.labelSize + S.labelToValue + S.valueSize + S.statsToRule
    : 0;
  const headerH = S.padTop + headerTextH + headerToStatsGap + statsBlockH + S.padBottom;

  clone.setAttribute("viewBox", `${x0} ${y0 - headerH} ${w} ${h + headerH}`);
  const chartLeft = x0 + layout.margin.left;
  const chartRight = x0 + w - layout.margin.right;
  const chartMid = (chartLeft + chartRight) / 2;

  const g = document.createElementNS(SVG_NS, "g");
  g.setAttribute("font-family", EXPORT_FONT_FAMILY);

  const addText = (text, x, y, fill, size, attrs = {}) => {
    const el = document.createElementNS(SVG_NS, "text");
    el.setAttribute("x", String(x));
    el.setAttribute("y", String(y));
    el.setAttribute("fill", fill);
    el.setAttribute("font-size", String(size));
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    el.textContent = text;
    g.appendChild(el);
  };

  const addRule = (y) => {
    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", String(chartLeft));
    line.setAttribute("x2", String(chartRight));
    line.setAttribute("y1", String(y));
    line.setAttribute("y2", String(y));
    line.setAttribute("stroke", "#262626");
    line.setAttribute("stroke-width", "1");
    g.appendChild(line);
  };

  let cursorY = y0 - headerH + S.padTop;
  if (title) {
    cursorY += S.titleSize;
    addText(title, chartMid, cursorY, "#f1f3f8", S.titleSize,
      { "text-anchor": "middle", "font-weight": "500", "letter-spacing": "-0.02em" });
  }
  if (subtitle) {
    cursorY += S.titleToSubtitle + S.subtitleSize;
    addText(subtitle, chartMid, cursorY, "#8A8A8A", S.subtitleSize,
      { "text-anchor": "middle", "letter-spacing": "0.01em" });
  }

  if (stats.length) {
    cursorY += (subtitle ? S.subtitleToRule : (title ? S.titleToRule : 0));
    addRule(cursorY);
    const colWidth = (chartRight - chartLeft) / stats.length;
    const labelY = cursorY + S.ruleToLabel + S.labelSize;
    const valueY = labelY + S.labelToValue + S.valueSize;
    const labelAttrs = { "letter-spacing": "0.16em", "font-weight": "500" };
    stats.forEach((stat, i) => {
      const x = chartLeft + colWidth * i;
      addText(String(stat.label).toUpperCase(), x, labelY, "#8A8A8A", S.labelSize, labelAttrs);
      addText(String(stat.value), x, valueY, stat.fill || "#f1f3f8", S.valueSize,
        { "font-weight": "300", "letter-spacing": "-0.01em" });
    });
    addRule(valueY + S.statsToRule);
  }

  clone.insertBefore(g, clone.firstChild);
}

defineExpose({ exportPng: (options = {}) => {
  const { meta, ...rest } = options;
  exportChartToPng({
    element: svgRef.value,
    filename: "payoff.png",
    scale: 4,
    padding: 24,
    prepareSvgClone: (clone) => decorateExportClone(clone, meta || null),
    ...rest,
  });
}});

function render() {
  if (!svgRef.value) return;
  const { width, height, margin } = layout;
  const renderedWidth = svgRef.value.getBoundingClientRect().width || svgRef.value.parentElement.clientWidth || 1160;
  // Preserve the same screen-pixel type scale when the SVG viewBox resizes.
  const dataLabelSize = DATA_LABEL_PX * width / renderedWidth;
  const axisTitleSize = AXIS_TITLE_PX * width / renderedWidth;
  const markerLabelSize = MARKER_LABEL_PX * width / renderedWidth;
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
    .call(d3.axisLeft(y).ticks(4).tickSize(0).tickPadding(22).tickFormat(d3.format(",.0f")))
    .call(axisStyle);
  svg.append("g").attr("transform", `translate(0,${bottom})`)
    .call(d3.axisBottom(x).ticks(renderedWidth < 650 ? 4 : 8).tickSize(0).tickPadding(16).tickFormat(d3.format(",.0f")))
    .call(axisStyle);
  svg.append("text").attr("x", (margin.left + right) / 2).attr("y", height - 15)
    .attr("text-anchor", "middle").attr("fill", "#d4d7e2").attr("font-size", axisTitleSize).attr("font-weight", 500)
    .text(`${props.asset} Price`);
  svg.append("text").attr("transform", "rotate(-90)")
    .attr("x", -height / 2).attr("y", 22).attr("text-anchor", "middle")
    .attr("fill", "#d4d7e2").attr("font-size", axisTitleSize).attr("font-weight", 500).text("P&L (USD)");
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
  const decayOpacity = [0.6, 0.45, 0.3, 0.2];
  const decayColor = "#b8c0d0";
  decayCurves.forEach((curve, i) => {
    svg.append("path").datum(curve.points).attr("class", "decay-curve")
      .attr("d", line).attr("fill", "none").attr("stroke", decayColor)
      .attr("stroke-width", 1.5).attr("stroke-opacity", decayOpacity[i] ?? 0.2)
      .attr("stroke-linejoin", "round");
  });
  for (const [name, color] of [["profit", "#00bf8c"], ["loss", "#ff1654"]]) {
    svg.append("path").datum(points).attr("d", line).attr("fill", "none").attr("stroke", color)
      .attr("stroke-width", 3).attr("stroke-linejoin", "round").attr("clip-path", `url(#payoff-${name})`);
  }
  const labelClampX = (px) => Math.max(margin.left + 90, Math.min(right - 90, px));
  const beMarkers = (props.payoff.breakEvens?.points || []).map((price) => ({
    price, label: priceLabel(price), fill: "#f1f3f8",
  }));
  for (const m of beMarkers) {
    const px = x(m.price);
    svg.append("line").attr("x1", px).attr("x2", px).attr("y1", margin.top).attr("y2", bottom)
      .attr("stroke", "#9ba1ad").attr("stroke-width", 1).attr("stroke-opacity", 0.35);
  }
  const labelRows = [
    { y: margin.top - 14, lastRight: -Infinity },
    { y: margin.top - 44, lastRight: -Infinity },
  ];
  const labelGap = markerLabelSize * 0.6;
  const sortedBe = beMarkers.slice().sort((a, b) => a.price - b.price);
  for (const m of sortedBe) {
    const centerX = labelClampX(x(m.price));
    const halfW = (m.label.length * markerLabelSize * 0.55) / 2;
    let row = [0, 1].find((r) => centerX - halfW >= labelRows[r].lastRight + labelGap);
    if (row === undefined) row = 0;
    svg.append("text").attr("x", centerX).attr("y", labelRows[row].y)
      .attr("fill", m.fill).attr("text-anchor", "middle")
      .attr("font-size", markerLabelSize).text(m.label);
    labelRows[row].lastRight = centerX + halfW;
  }
  const forwardX = x(props.payoff.forward);
  const forwardPoint = points.reduce((best, p) =>
    Math.abs(p.price - props.payoff.forward) < Math.abs(best.price - props.payoff.forward) ? p : best);
  const curveGap = 22;
  const forwardY1 = Math.min(bottom - 14, y(forwardPoint.pnl) + curveGap);
  const forwardY2 = bottom;
  svg.append("line")
    .attr("x1", forwardX).attr("x2", forwardX)
    .attr("y1", forwardY1).attr("y2", forwardY2)
    .attr("stroke", "#5a5a5a").attr("stroke-width", 1).attr("stroke-opacity", 1);
  svg.append("text")
    .attr("x", forwardX + 8).attr("y", (forwardY1 + forwardY2) / 2)
    .attr("fill", "#8A8A8A").attr("text-anchor", "start")
    .attr("dominant-baseline", "middle")
    .attr("font-size", markerLabelSize * 0.85)
    .text(`Fwd ${priceLabel(props.payoff.forward)}`);
  if (decayCurves.length) {
    const legend = svg.append("g").attr("class", "decay-legend").attr("transform", `translate(${right + 28},${margin.top + 8})`);
    legend.append("text").attr("fill", "#d4d7e2").attr("font-size", dataLabelSize).attr("font-weight", 500).text("Elapsed");
    decayCurves.forEach((curve, i) => {
      const ly = dataLabelSize * 1.8 * (i + 1);
      legend.append("line").attr("x1", 0).attr("x2", dataLabelSize * 1.4).attr("y1", ly).attr("y2", ly)
        .attr("stroke", decayColor).attr("stroke-width", 1.5).attr("stroke-opacity", decayOpacity[i] ?? 0.2);
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
