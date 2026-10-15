<script setup>
import * as d3 from "d3";
import { onMounted, onUnmounted, ref, watch } from "vue";
import { exportTitledChart } from "../lib/exportTitledChart.js";
import { buildContourPolylines } from "../lib/zeroMtmContours.js";

const props = defineProps({
  rows: { type: Array, default: () => [] },
  breakEvens: { type: Object, default: null },
  zeroMtmContours: { type: Object, default: null },
  underlying: { type: String, default: "BTC" },
});

const chartRef = ref(null);
const breakEvenMode = ref("cones");
const hiddenSeries = ref(new Set());
let resizeObserver;

const FONT = '"Helvetica Neue", Helvetica, -apple-system, sans-serif';
const formatUsd = d3.format("$,.0f");
const formatTime = d3.utcFormat("%d %b %H:%M");
const BUY = d3.interpolateRdBu(0.75);
const SELL = d3.interpolateRdBu(0.22);
const INDEX = "rgba(255,255,255,0.42)";
const BREAK_EVEN = "rgba(255, 255, 255, 0.65)";
const SERIES_STROKE_WIDTH = 1.25;
const PNL_SERIES_OPACITY = 0.8;
const CONTOUR_COLORS = {
  base: "rgba(255,255,255,0.78)",
};
const LEGEND_TOOLTIPS = {
  index: "Observed BTC index price at each hourly bar. This is the underlying spot path used for option repricing, hedge P&L, Greek attribution, and break-even comparisons.",
  hedge_buy: "Blue markers show delta-hedge purchases. A buy increases the signed BTC hedge position. Executing the hedge changes exposure but creates no immediate P&L before fees; subsequent spot movement creates hedge MTM.",
  hedge_sell: "Red markers show delta-hedge sales. A sell reduces or reverses the signed BTC hedge position. The marker is execution direction, not whether that hedge ultimately made money.",
  break_even_lines: "Terminal break-even levels. At expiry, intrinsic value of all option legs equals the position's signed entry premium. These horizontal lines ignore remaining time value and IV, so they are payoff break-evens—not today's mark-to-market break-evens.",
  contour_base: "Base zero-MTM contour. At every timestamp it solves for every spot S where the option structure, repriced on the frozen entry IV surface, has exactly its entry value: V(S,t)=V₀. Hedges do not reset this contour because they change account P&L, not the option structure's entry variance budget.",
  gamma_theta: "Cumulative gamma–theta attribution: Σ[θ·dt + ½Γ(dS)²] across all signed option legs. For a short-vol position, theta is usually earned and gamma is usually paid. Their net indicates whether realized spot variation compensated the entry time decay under this discrete approximation.",
  net_delta: "Cumulative net-delta mark-to-market: Σ[(option delta + signed hedge position)·dS]. When hedged, it measures first-order directional P&L left after imperfect or discrete hedging; when unhedged, it is option delta P&L. During the cycle it mixes realized and unrealized MTM; at final closure it is realized.",
  vega: "Cumulative first-order vega attribution: Σ[vega·dσ] across the signed option legs. It isolates P&L from implied-volatility repricing. It is an approximation; large vol moves, skew changes, and vol/spot cross-effects can spill into residual.",
  residual: "Cumulative unexplained remainder after subtracting net delta, gamma–theta, and vega attribution from total hedged P&L. It contains higher-order Greeks, vanna/volga, discrete-sampling error, surface-model mismatch, expiry effects, and any missing quote effects.",
  total: "Cumulative total strategy P&L: option mark-to-market plus hedge P&L. This is the accounting result the Greek tracks reconcile to; unlike the attribution tracks, it is not a local Taylor approximation.",
};
const legendTooltip = (key) =>
  LEGEND_TOOLTIPS[key].replaceAll("BTC", props.underlying);

const styleAxis = (group) => {
  group.selectAll("line").remove();
  group.selectAll("path").remove();
  group.selectAll("text")
    .attr("fill", "rgba(255,255,255,0.42)")
    .attr("font-family", FONT)
    .attr("font-size", 10);
};

const paddedDomain = (values, ratio = 0.08) => {
  let [lo, hi] = d3.extent(values.filter(Number.isFinite));
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
  if (lo === hi) return [lo - 1, hi + 1];
  const padding = (hi - lo) * ratio;
  return [lo - padding, hi + padding];
};

const isHidden = (key) => hiddenSeries.value.has(key);
const toggleSeries = (key) => {
  const next = new Set(hiddenSeries.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  hiddenSeries.value = next;
  draw();
};

const addLegendItem = (legend, x, label, color, shape = "line", key = null, tooltip = "") => {
  const item = legend.append("g")
    .attr("transform", `translate(${x},0)`)
    .attr("opacity", key && isHidden(key) ? 0.3 : 1);
  if (key) {
    item.attr("role", "button")
      .attr("tabindex", 0)
      .attr("aria-label", `${isHidden(key) ? "Show" : "Hide"} ${label}`)
      .style("cursor", "pointer")
      .on("click", () => toggleSeries(key))
      .on("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          toggleSeries(key);
        }
      });
  }
  if (shape === "square") {
    item.append("rect")
      .attr("x", 0).attr("y", -5).attr("width", 9).attr("height", 9)
      .attr("fill", color);
  } else {
    item.append("line")
      .attr("x1", 0).attr("x2", 18).attr("y1", 0).attr("y2", 0)
      .attr("stroke", color).attr("stroke-width", 2);
  }
  item.append("text")
    .attr("x", shape === "square" ? 15 : 24).attr("y", 4)
    .attr("fill", "rgba(255,255,255,0.72)")
    .attr("font-size", 10).text(label);
  if (tooltip) item.append("title").text(`${tooltip}\n\nClick to ${key && isHidden(key) ? "show" : "hide"} this series.`);
};

const draw = () => {
  const element = chartRef.value;
  if (!element) return;
  element.innerHTML = "";
  const rows = [...(props.rows || [])]
    .filter((row) => row.dateTime && Number.isFinite(row.indexPrice))
    .sort((a, b) => a.ts - b.ts);
  const bounds = element.getBoundingClientRect();
  const width = Math.max(900, bounds.width || 1360);
  const height = Math.max(520, bounds.height || 620);
  const margin = { top: 34, right: 110, bottom: 42, left: 64 };
  const gap = 54;
  const priceHeight = Math.round((height - margin.top - margin.bottom - gap) * 0.52);
  const pnlHeight = height - margin.top - margin.bottom - gap - priceHeight;
  const innerWidth = width - margin.left - margin.right;

  const svg = d3.select(element).append("svg")
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("width", "100%").attr("height", "100%")
    .attr("font-family", FONT)
    .attr("role", "img")
    .attr("aria-label", "Index price (scatter), break-even lines for the structure, hedge executions, and PnL detail");

  if (!rows.length) {
    svg.append("text").attr("x", width / 2).attr("y", height / 2)
      .attr("text-anchor", "middle").attr("fill", "rgba(255,255,255,0.35)")
      .text("No hourly detail data");
    return;
  }

  const x = d3.scaleUtc()
    .domain(d3.extent(rows, (row) => new Date(row.dateTime)))
    .range([0, innerWidth]);

  const contourRows = props.zeroMtmContours?.contours || [];
  const baseContourRows = contourRows.filter((row) => row.scenario === "base");
  const showContourOverlay = breakEvenMode.value === "cones" && baseContourRows.length > 0;
  // Include zero-MTM topology in the domain even when spot never reaches it.
  const be = props.breakEvens || null;
  const indexValues = rows.flatMap(row => [row.indexPrice,
    ...(row.hedgeTrades || (row.hedgeTrade ? [row.hedgeTrade] : [])).map(trade => trade.price),
  ]).filter(Number.isFinite);
  if (showContourOverlay) {
    contourRows.forEach((row) => {
      indexValues.push(...row.roots);
      row.bands.forEach((band) => indexValues.push(...band));
    });
  } else if (be) {
    if (Number.isFinite(be.lower)) indexValues.push(be.lower);
    if (Number.isFinite(be.upper)) indexValues.push(be.upper);
  }
  const indexY = d3.scaleLinear()
    .domain(paddedDomain(indexValues)).nice()
    .range([priceHeight, 0]);

  const pnlY = d3.scaleLinear()
    .domain(paddedDomain(rows.flatMap((row) => [
      row.cumulativeThetaPnlUsd + row.cumulativeGammaPnlUsd,
      row.cumulativeNetDeltaMtmUsd,
      row.cumulativeVegaPnlUsd,
      row.cumulativeResidualPnlUsd,
      row.totalPnlUsd,
    ]))).nice()
    .range([pnlHeight, 0]);

  const price = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

  const clipId = `price-clip-${Math.random().toString(36).slice(2)}`;
  price.append("clipPath").attr("id", clipId).append("rect")
    .attr("width", innerWidth).attr("height", priceHeight);
  const overlay = price.append("g").attr("clip-path", `url(#${clipId})`);

  if (showContourOverlay) {
    if (!isHidden("contour_base")) {
      buildContourPolylines(contourRows, "base").forEach((segment) => {
        const contourLine = d3.line()
          .x((point) => x(new Date(point.t * 1000)))
          .y((point) => indexY(point.spot));
        overlay.append("path")
          .datum(segment)
          .attr("d", contourLine)
          .attr("fill", "none")
          .attr("stroke", CONTOUR_COLORS.base)
          .attr("stroke-width", SERIES_STROKE_WIDTH)
          .attr("stroke-dasharray", null);
      });
    }
  }

  // Index price axis on the left (primary now that we focus on spot vs break-evens)
  price.append("g").call(d3.axisLeft(indexY).ticks(6).tickFormat(d3.format("$,.0f")).tickPadding(10)).call(styleAxis);

  // Break-even levels as white lines across the index scatter.
  const formatBe = d3.format(",.0f");  // no $ to keep labels short next to lines; axis provides scale
  if (!showContourOverlay && be && !isHidden("break_even_lines")) {
    const drawBE = (level, suffix) => {
      if (!Number.isFinite(level)) return;
      const y = indexY(level);
      // Clean white lines for break-evens (full width, no dash)
      price.append("line")
        .attr("x1", 0)
        .attr("x2", innerWidth)
        .attr("y1", y)
        .attr("y2", y)
        .attr("stroke", BREAK_EVEN)
        .attr("stroke-width", SERIES_STROKE_WIDTH)
        .attr("opacity", 0.9);
      // Label on the right
      const labelText = suffix
        ? `${formatBe(level)} ${suffix}`
        : formatBe(level);
      price.append("text")
        .attr("x", innerWidth + 4)
        .attr("y", y + 3)
        .attr("fill", BREAK_EVEN)
        .attr("font-size", 9)
        .attr("font-weight", 500)
        .text(labelText);
    };

    // When both exist, label one "low" and one "high" to the right of the price
    if (Number.isFinite(be.lower) && Number.isFinite(be.upper)) {
      drawBE(be.lower, "low");
      drawBE(be.upper, "high");
    } else if (Number.isFinite(be.lower)) {
      drawBE(be.lower);
    } else if (Number.isFinite(be.upper)) {
      drawBE(be.upper);
    }
  }

  // Stepline for the index price (to match the stepped PnL lines)
  const indexLine = d3.line()
    .defined((row) => Number.isFinite(row.indexPrice))
    .x((row) => x(new Date(row.dateTime)))
    .y((row) => indexY(row.indexPrice))
    .curve(d3.curveStepBefore);

  if (!isHidden("index")) {
    price.append("path")
      .datum(rows)
      .attr("d", indexLine)
      .attr("fill", "none")
      .attr("stroke", "rgba(255,255,255,0.75)")
      .attr("stroke-width", SERIES_STROKE_WIDTH)
      .attr("stroke-linejoin", "round")
      .attr("stroke-linecap", "round");
  }

  // Small markers for regular index points
  price.selectAll("rect.index-point")
    .data(isHidden("index") ? [] : rows.filter(d => !d.hedgeTrade))
    .join("rect")
    .attr("class", "index-point")
    .attr("x", (row) => x(new Date(row.dateTime)) - 1.25)
    .attr("y", (row) => indexY(row.indexPrice) - 1.25)
    .attr("width", 2.5)
    .attr("height", 2.5)
    .attr("fill", "rgba(255,255,255,0.35)")
    .attr("stroke", "none")
    .append("title")
    .text((row) => `${formatTime(new Date(row.dateTime))}\nIndex ${formatUsd(row.indexPrice)}`);

  // Scale marker area with the absolute BTC delta traded. A square-root radius
  // makes visual area proportional to quantity while the floor keeps small
  // executions legible.
  const hedgeTrades = rows.flatMap(row =>
    (row.hedgeTrades || (row.hedgeTrade ? [row.hedgeTrade] : []))
      .map(trade => ({ ...row, hedgeTrade: trade })),
  ).filter(
    (row) => row.hedgeTrade && !isHidden(`hedge_${row.hedgeTrade.side}`),
  );
  const largestHedgeTrade = d3.max(
    hedgeTrades,
    (row) => Number(row.hedgeTrade?.quantity) || 0,
  ) || 0;
  const hedgeTradeRadius = d3.scaleSqrt()
    .domain([0, largestHedgeTrade || 1])
    .range([0, 9])
    .clamp(true);

  // Hedge trade markers as quantity-scaled circles.
  price.selectAll("circle.hedge-trade")
    .data(hedgeTrades)
    .join("circle")
    .attr("class", "hedge-trade")
    .attr("cx", (row) => x(new Date(row.dateTime)))
    .attr("cy", (row) => indexY(row.hedgeTrade.price))
    .attr("r", (row) => Math.max(3, hedgeTradeRadius(row.hedgeTrade.quantity)))
    .attr("fill", (row) => row.hedgeTrade.side === "buy" ? BUY : SELL)
    .attr("stroke", (row) => row.hedgeTrade.side === "buy" ? BUY : SELL)
    .attr("stroke-width", 1)
    .append("title")
    .text((row) => {
      const trade = row.hedgeTrade
        ? `\n${row.hedgeTrade.side.toUpperCase()} ${row.hedgeTrade.quantity.toFixed(4)} ${props.underlying} @ ${formatUsd(row.hedgeTrade.price)}${row.hedgeTrade.intrabar ? " (estimated intrabar fill; time within hour unknown)" : ""}`
        : "";
      return `${formatTime(new Date(row.dateTime))}\nIndex ${formatUsd(row.indexPrice)}${trade}`;
    });

  const legend = price.append("g").attr("transform", "translate(0,-18)");
  // No more "Combined option mark" — replaced by break-even lines per request
  addLegendItem(legend, 0, "Index", "rgba(255,255,255,0.75)", "line", "index", legendTooltip("index"));
  addLegendItem(legend, 80, "Hedge buy", BUY, "square", "hedge_buy", legendTooltip("hedge_buy"));
  addLegendItem(legend, 170, "Hedge sell", SELL, "square", "hedge_sell", legendTooltip("hedge_sell"));
  if (showContourOverlay) {
    addLegendItem(legend, 255, "Zero MTM", CONTOUR_COLORS.base, "line", "contour_base", legendTooltip("contour_base"));
    legend.append("text")
      .attr("x", 345).attr("y", 4)
      .attr("fill", "rgba(255,255,255,0.42)")
      .attr("font-size", 9)
      .text(props.zeroMtmContours.metadata.surface_mode.replace("_", " "));
  } else if (be && (Number.isFinite(be.lower) || Number.isFinite(be.upper))) {
    addLegendItem(legend, 255, "Break-evens", BREAK_EVEN, "line", "break_even_lines", legendTooltip("break_even_lines"));
  }

  const pnlTop = margin.top + priceHeight + gap;
  const pnl = svg.append("g").attr("transform", `translate(${margin.left},${pnlTop})`);
  pnl.append("g").call(d3.axisLeft(pnlY).ticks(6).tickFormat(d3.format("$,.0f")).tickPadding(10)).call(styleAxis);
  const gammaThetaRows = rows.map((row) => ({
    ...row,
    cumulativeGammaThetaPnlUsd: row.cumulativeThetaPnlUsd + row.cumulativeGammaPnlUsd,
  }));
  const pnlSeries = [
    { key: "cumulativeGammaThetaPnlUsd", id: "gamma_theta", label: "Gamma–theta", color: "#7dd3fc", legendX: 0 },
    { key: "cumulativeNetDeltaMtmUsd", id: "net_delta", label: "Net delta MTM", color: "#6ee7b7", legendX: 120 },
    { key: "cumulativeVegaPnlUsd", id: "vega", label: "Vega MTM", color: "#a78bfa", legendX: 245 },
    { key: "cumulativeResidualPnlUsd", id: "residual", label: "Residual", color: "#fbbf24", legendX: 340 },
    { key: "totalPnlUsd", id: "total", label: "Total PnL", color: "#f4f4f5", legendX: 425 },
  ];
  pnlSeries.forEach((series) => {
    if (isHidden(series.id)) return;
    const line = d3.line()
      .defined((row) => Number.isFinite(row[series.key]))
      .x((row) => x(new Date(row.dateTime)))
      .y((row) => pnlY(row[series.key]))
      .curve(d3.curveStepBefore);
    pnl.append("path").datum(gammaThetaRows).attr("d", line)
      .attr("fill", "none").attr("stroke", series.color)
      .attr("stroke-width", SERIES_STROKE_WIDTH)
      .attr("opacity", PNL_SERIES_OPACITY);
  });
  const pnlLegend = pnl.append("g").attr("transform", "translate(0,-17)");
  pnlSeries.forEach((series) => addLegendItem(
    pnlLegend,
    series.legendX,
    series.label,
    series.color,
    "line",
    series.id,
    legendTooltip(series.id),
  ));

  const xAxis = d3.axisBottom(x).ticks(8).tickFormat(d3.utcFormat("%d %b %H:%M")).tickPadding(10);
  pnl.append("g").attr("transform", `translate(0,${pnlHeight})`).call(xAxis).call(styleAxis);
};

onMounted(() => {
  draw();
  resizeObserver = new ResizeObserver(draw);
  if (chartRef.value) resizeObserver.observe(chartRef.value);
});
onUnmounted(() => resizeObserver?.disconnect());
watch(() => props.rows, draw);
watch(() => props.breakEvens, draw, { deep: true });
watch(() => props.zeroMtmContours, draw, { deep: true });
watch(breakEvenMode, draw);

function exportPng({ filename = "cycle-detail.png", scale = 4, padding = 24, title = "", subtitle = "", source = "", metrics = [] } = {}) {
  const svgEl = chartRef.value?.querySelector("svg");
  if (!svgEl) return;
  exportTitledChart({ svgEl, title, subtitle, source, metrics, filename, scale, padding, background: "#0a0b0e" });
}
defineExpose({ exportPng });
</script>

<template>
  <div class="chart">
    <div ref="chartRef" class="chartCanvas"></div>
    <div class="breakEvenToggle" role="group" aria-label="Break-even display">
      <button
        type="button"
        title="Show terminal payoff break-even levels. These are fixed horizontal lines based on intrinsic value at expiry and the signed entry premium; they do not include remaining time value or IV."
        :class="{ active: breakEvenMode === 'lines' }"
        :aria-pressed="breakEvenMode === 'lines'"
        @click="breakEvenMode = 'lines'"
      >BE Lines</button>
      <button
        type="button"
        title="Show time-dependent zero-MTM contours. Each cone point solves V(S,t)=V₀ using the frozen entry IV surface."
        :class="{ active: breakEvenMode === 'cones' }"
        :aria-pressed="breakEvenMode === 'cones'"
        @click="breakEvenMode = 'cones'"
      >BE Cones</button>
    </div>
  </div>
</template>

<style scoped>
.chart {
  flex: 1;
  min-height: 0;
  position: relative;
  background: #0a0b0e;
  display: flex;
}
.chartCanvas {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
}
.chartCanvas :deep(svg) {
  display: block;
  width: 100%;
  height: 100%;
}
.breakEvenToggle {
  position: absolute;
  top: 8px;
  right: 14px;
  z-index: 2;
  display: flex;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 5px;
  background: #0a0b0e;
}
.breakEvenToggle button {
  border: 0;
  border-right: 1px solid rgba(255, 255, 255, 0.14);
  padding: 5px 9px;
  background: transparent;
  color: rgba(255, 255, 255, 0.45);
  font: 500 10px/1 "Helvetica Neue", Helvetica, -apple-system, sans-serif;
  cursor: pointer;
}
.breakEvenToggle button:last-child {
  border-right: 0;
}
.breakEvenToggle button.active {
  background: rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.88);
}
</style>
