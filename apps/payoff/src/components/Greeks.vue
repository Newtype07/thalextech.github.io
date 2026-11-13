<script setup>
import * as d3 from "d3";
import { onMounted, ref, watch } from "vue";
import { copyChartToClipboard, exportChartToPng } from "../../../../lib/export-png.js";

const props = defineProps({
  data: { type: Array, default: () => [] },
  title: { type: String, default: "" },
  subtitle: { type: String, default: "" },
  loading: { type: Boolean, default: false },
  greek: { type: String, default: "delta" },
  asset: { type: String, default: "BTC" },
});

const svgRef = ref(null);
const canvasRef = ref(null);

const SVG_FONT_FAMILY =
  'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"';

const layout = {
  width: 1800,
  height: 900,
  margin: { top: 90, right: 220, bottom: 80, left: 90 },
};

const EXPORT_LINE_WIDTH = {
  leg: 3.2,
  total: 5,
};

const TEXT_STYLES = {
  axisText: { fill: "#d4d7e2", size: "12px" },
  axisLabel: { fill: "#f7f8fb", size: "16px", weight: 600 },
  title: { fill: "#f7f8fb", size: "22px", weight: 600 },
  subtitle: { fill: "#d4d7e2", size: "16px" },
  legendTitle: { fill: "#f7f8fb", size: "12px", weight: 600 },
  legendLabel: { fill: "#d4d7e2", size: "11px" },
  noData: { fill: "#c9c9cf", size: "14px" },
};

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

const normalizeGreekValue = (key, value) => {
  if (!Number.isFinite(value)) return NaN;
  if (key === "vega") return Number(value) / 100;
  if (key === "gamma") return Number(value) * 1e4;
  return Number(value);
};

function pngOptions({ filename = "payoff-greeks.png", scale = 4, padding = 24 } = {}) {
  const exportSvg = svgRef.value?.cloneNode(true);
  if (!exportSvg) return;

  d3.select(exportSvg)
    .selectAll("[data-export-stroke-width]")
    .attr("stroke-width", function applyExportStrokeWidth() {
      return this.getAttribute("data-export-stroke-width");
    });

  return {
    element: exportSvg,
    filename,
    scale,
    padding,
    drawBefore: ({ ctx, width, height, padding: p }) => {
      const canvas = canvasRef.value;
      if (!canvas) return;
      ctx.drawImage(canvas, p, p, width, height);
    },
  };
}

defineExpose({
  exportPng: (options) => {
    const png = pngOptions(options);
    if (png) exportChartToPng(png);
  },
  copyImage: (options) => copyChartToClipboard(pngOptions(options)),
});

const render = () => {
  const svgEl = svgRef.value;
  if (!svgEl) return;

  const svg = d3.select(svgEl);
  svg.selectAll("*").remove();

  const { width, height, margin } = layout;
  const chartRight = width - margin.right;
  const chartBottom = height - margin.bottom;

  svg.attr("viewBox", `0 0 ${width} ${height}`);
  svg.attr("preserveAspectRatio", "xMidYMid meet");

  svg
    .append("rect")
    .attr("width", width)
    .attr("height", height)
    .attr("fill", "none")
    .attr("pointer-events", "all");

  const canvas = canvasRef.value;
  let ctx = null;
  if (canvas) {
    const dpr = window.devicePixelRatio || 1;
    ctx = canvas.getContext("2d", { alpha: true });
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
  }

  if (props.title) {
    applyTextStyle(
      svg
        .append("text")
        .attr("x", width / 2)
        .attr("y", 32)
        .attr("text-anchor", "middle")
        .text(props.title),
      "title",
    );
  }

  if (props.subtitle) {
    applyTextStyle(
      svg
        .append("text")
        .attr("x", width / 2)
        .attr("y", 58)
        .attr("text-anchor", "middle")
        .text(props.subtitle),
      "subtitle",
    );
  }

  const greekKey = ["delta", "gamma", "theta", "vega", "vanna", "charm", "volga"].includes(
    props.greek,
  )
    ? props.greek
    : "delta";

  const points = (props.data || []).filter((row) => {
    const spot = Number(row?.index_price_close);
    const y = normalizeGreekValue(greekKey, row?.[greekKey]);
    return Number.isFinite(spot) && Number.isFinite(y);
  });

  if (!points.length) {
    applyTextStyle(
      svg
        .append("text")
        .attr("x", width / 2)
        .attr("y", height / 2)
        .attr("text-anchor", "middle")
        .text(props.loading ? "Loading data..." : "No data available."),
      "noData",
    );
    return;
  }

  const xAccessor = (d) => Number(d.index_price_close);
  const yAccessor = (d) => normalizeGreekValue(greekKey, d[greekKey]);
  const xExtent = d3.extent(points, xAccessor);
  const yExtent = d3.extent(points, yAccessor);
  if (
    !Number.isFinite(xExtent[0]) ||
    !Number.isFinite(xExtent[1]) ||
    !Number.isFinite(yExtent[0]) ||
    !Number.isFinite(yExtent[1])
  ) {
    return;
  }

  const xSpan = xExtent[1] - xExtent[0];
  const xDomain =
    xSpan > 0
      ? xExtent
      : [
          xExtent[0] - Math.max(1, Math.abs(xExtent[0]) * 0.05),
          xExtent[1] + Math.max(1, Math.abs(xExtent[1]) * 0.05),
        ];
  const ySpan = yExtent[1] - yExtent[0];
  const yPad = ySpan > 0 ? ySpan * 0.12 : Math.max(0.2, Math.abs(yExtent[0]) * 0.2);

  const formatSpot = d3.format(",.0f");

  const x = d3
    .scaleLinear()
    .domain(xDomain)
    .range([margin.left, chartRight]);

  const y = d3
    .scaleLinear()
    .domain([yExtent[0] - yPad, yExtent[1] + yPad])
    .nice()
    .range([chartBottom, margin.top]);

  const mainGroup = svg.append("g");
  const clipId = "payoff-greeks-plot-clip";

  svg
    .append("defs")
    .append("clipPath")
    .attr("id", clipId)
    .append("rect")
    .attr("x", margin.left)
    .attr("y", margin.top)
    .attr("width", chartRight - margin.left)
    .attr("height", chartBottom - margin.top);

  mainGroup
    .append("g")
    .attr("transform", `translate(0,${chartBottom})`)
    .call(d3.axisBottom(x).ticks(8).tickSize(0).tickPadding(16).tickFormat(formatSpot))
    .call(axisStyle);

  mainGroup
    .append("g")
    .attr("transform", `translate(${margin.left},0)`)
    .call(d3.axisLeft(y).ticks(4).tickSize(0).tickPadding(16))
    .call(axisStyle);

  const xLabel = `${props.asset} Price`;
  const yLabel = greekKey === "delta"
    ? `Delta (${props.asset})`
    : greekKey === "gamma" ? `${greekKey} [x10^4]` : greekKey;

  applyTextStyle(
    svg
      .append("text")
      .attr("x", (margin.left + chartRight) / 2)
      .attr("y", height - 24)
      .attr("text-anchor", "middle")
      .text(xLabel),
    "axisLabel",
  );

  applyTextStyle(
    svg
      .append("text")
      .attr("transform", "rotate(-90)")
      .attr("x", -height / 2)
      .attr("y", 28)
      .attr("text-anchor", "middle")
      .text(yLabel),
    "axisLabel",
  );

  const seriesList = d3
    .groups(points, (point) => point?.leg_id || point?.instrument_name || "series")
    .map(([key, rows]) => {
      const sample = rows[0] || {};
      return {
        key,
        label: sample.leg_label || sample.instrument_name || key,
        color: sample.leg_color || "#9ca3af",
        dash: sample.line_dash || null,
        opacity: Number.isFinite(Number(sample.line_opacity))
          ? Number(sample.line_opacity)
          : null,
        lineWidth: Number.isFinite(Number(sample.line_width))
          ? Number(sample.line_width)
          : null,
        legendHidden: Boolean(sample.legend_hidden),
        isTotal: Boolean(sample.is_total),
        rows: rows.slice().sort((a, b) => xAccessor(a) - xAccessor(b)),
      };
    })
    .sort((a, b) => Number(b.isTotal) - Number(a.isTotal) || a.label.localeCompare(b.label));

  const line = d3
    .line()
    .defined((point) => Number.isFinite(xAccessor(point)) && Number.isFinite(yAccessor(point)))
    .x((point) => x(xAccessor(point)))
    .y((point) => y(yAccessor(point)))
    .curve(d3.curveCatmullRom.alpha(0.35));

  const seriesGroup = mainGroup
    .append("g")
    .attr("clip-path", `url(#${clipId})`);

  for (const series of seriesList) {
    seriesGroup
      .append("path")
      .datum(series.rows)
      .attr("fill", "none")
      .attr("stroke", series.color)
      .attr("stroke-width", series.lineWidth ?? (series.isTotal ? 3 : 1.6))
      .attr(
        "data-export-stroke-width",
        series.legendHidden
          ? null
          : series.isTotal
            ? EXPORT_LINE_WIDTH.total
            : EXPORT_LINE_WIDTH.leg,
      )
      .attr("stroke-linecap", "round")
      .attr("stroke-linejoin", "round")
      .attr("opacity", series.opacity ?? (series.isTotal ? 1 : 0.9))
      .attr("stroke-dasharray", series.dash || null)
      .attr("d", line);
  }

  const interactivePoints = [];

  if (canvas && ctx) {
    for (const series of seriesList) {
      for (const point of series.rows) {
        const px = x(xAccessor(point));
        const py = y(yAccessor(point));
        if (!Number.isFinite(px) || !Number.isFinite(py)) continue;

        interactivePoints.push({
          point,
          px,
          py,
          series,
        });
      }
    }
  }

  const legendX = chartRight - 150;
  const legendY = margin.top + 8;
  const legend = svg
    .append("g")
    .attr("transform", `translate(${legendX},${legendY})`);

  applyTextStyle(
    legend
      .append("text")
      .attr("x", 0)
      .attr("y", 0)
      .text("Series"),
    "legendTitle",
  );

  const truncate = (text, max) =>
    typeof text === "string" && text.length > max
      ? `${text.slice(0, Math.max(0, max - 1))}\u2026`
      : text;

  seriesList.filter((series) => !series.legendHidden).forEach((series, index) => {
    const yOffset = 18 + index * 18;

    legend
      .append("line")
      .attr("x1", -16)
      .attr("x2", 0)
      .attr("y1", yOffset)
      .attr("y2", yOffset)
      .attr("stroke", series.color)
      .attr("stroke-width", series.isTotal ? 3 : 2)
      .attr("stroke-dasharray", series.dash || null)
      .attr("stroke-linecap", "round");

    applyTextStyle(
      legend
        .append("text")
        .attr("x", 4)
        .attr("y", yOffset + 4)
        .attr("text-anchor", "start")
        .text(truncate(series.label, 32)),
      "legendLabel",
    );
  });

  const tooltip = svg
    .append("g")
    .attr("class", "tooltip")
    .attr("visibility", "hidden")
    .attr("pointer-events", "none");

  const tooltipBg = tooltip
    .append("rect")
    .attr("fill", "rgba(0, 0, 0, 0.9)")
    .attr("stroke", "#364154")
    .attr("rx", 6)
    .attr("ry", 6);

  const tooltipText = tooltip
    .append("text")
    .attr("fill", "#ffffff")
    .attr("font-size", "12px")
    .attr("font-family", SVG_FONT_FAMILY);

  const formatPct = d3.format("+.1f");
  const formatGreek = d3.format("+.6f");

  const showTooltip = (entry) => {
    const { point, px, py, series } = entry;
    const displayGreek = yAccessor(point);
    const lines = [
      series.label,
      String(point?.instrument_name || ""),
      `Spot: ${formatSpot(Number(point?.index_price_close))}`,
      `Shift: ${formatPct(Number(point?.scenario_shift_pct))}%`,
      `${greekKey}: ${formatGreek(displayGreek)}`,
    ];

    tooltipText.selectAll("tspan").remove();
    lines.forEach((lineText, index) => {
      tooltipText
        .append("tspan")
        .attr("x", 10)
        .attr("dy", index === 0 ? 18 : 15)
        .attr("font-weight", index === 0 ? 600 : 400)
        .text(lineText);
    });

    const bbox = tooltipText.node().getBBox();
    const padding = 10;
    tooltipBg
      .attr("width", bbox.width + padding * 2)
      .attr("height", bbox.height + padding);

    let tx = px + 14;
    let ty = py - bbox.height / 2;

    if (tx + bbox.width + padding * 2 > chartRight) {
      tx = px - bbox.width - padding * 2 - 14;
    }

    if (ty < margin.top) ty = margin.top;
    if (ty + bbox.height + padding > chartBottom) {
      ty = chartBottom - bbox.height - padding;
    }

    tooltip.attr("transform", `translate(${tx}, ${ty})`);
    tooltip.attr("visibility", "visible");
  };

  const hideTooltip = () => {
    tooltip.attr("visibility", "hidden");
  };

  svg
    .append("rect")
    .attr("x", margin.left)
    .attr("y", margin.top)
    .attr("width", chartRight - margin.left)
    .attr("height", chartBottom - margin.top)
    .attr("fill", "transparent")
    .attr("cursor", "crosshair")
    .on("mousemove", (event) => {
      if (!interactivePoints.length) {
        hideTooltip();
        return;
      }

      const [mouseX, mouseY] = d3.pointer(event, svg.node());
      let closest = null;
      let minDist = Infinity;
      for (const entry of interactivePoints) {
        const dist = Math.hypot(mouseX - entry.px, mouseY - entry.py);
        if (dist < minDist) {
          minDist = dist;
          closest = entry;
        }
      }

      if (closest && minDist <= 28) {
        showTooltip(closest);
      } else {
        hideTooltip();
      }
    })
    .on("mouseleave", hideTooltip);
};

watch(
  () => [props.data, props.title, props.subtitle, props.loading, props.greek, props.asset],
  () => render(),
  { deep: false },
);

onMounted(() => render());
</script>

<template>
  <div class="chartWrap">
    <canvas ref="canvasRef" class="chartCanvas" />
    <svg ref="svgRef" class="chartSvg" />
    <div v-if="loading" class="overlay">Loading...</div>
  </div>
</template>

<style scoped>
.chartWrap {
  position: relative;
  border-radius: 14px;
  overflow: hidden;
  background: #000;
}

.chartCanvas {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 1;
}

.chartSvg {
  display: block;
  width: 100%;
  height: auto;
  position: relative;
  z-index: 2;
}

.overlay {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: #fff;
  background: color-mix(in oklab, #000, transparent 40%);
  font-size: 14px;
  z-index: 3;
}
</style>
