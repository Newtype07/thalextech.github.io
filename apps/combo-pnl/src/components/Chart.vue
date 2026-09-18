<script setup>
import * as d3 from "d3";
import { onMounted, ref, watch } from "vue";
import { exportChartToPng } from "../../../../lib/export-png.js";

const props = defineProps({
  indexData: { type: Array, default: () => [] },
  comboData: { type: Array, default: () => [] },
  deltaHedgeEnabled: { type: Boolean, default: false },
  showHigherOrderGreeks: { type: Boolean, default: false },
  optionInstrumentName: { type: String, default: "" },
  comboTitle: { type: String, default: "" },
  subtitle: { type: String, default: "" },
  loading: { type: Boolean, default: false },
  resolutionKey: { type: String, default: "900" },
  resolutionOptions: { type: Array, default: () => [] },
  greekEvolutionData: { type: Array, default: () => [] },
});
const emit = defineEmits([
  "update:resolutionKey",
  "update:timeAnchorTs",
  "update:timeRangeTs",
  "update:lowerMode",
]);

const svgRef = ref(null);
const SVG_FONT_FAMILY =
  'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"';
const CHART_COLORS = Object.freeze({
  primaryText: "#ffffff",
  secondaryText: "#d7dae4",
  axisText: "#f0f1f6",
  index: "#ffe4e8",
  positive: "#32e68a",
  negative: "#ff5c6c",
  gammaTheta: "#ff3b8d",
  vega: "#ffa45f",
  vanna: "#2dd4bf",
  charm: "#a3e635",
  vomma: "#ff8a3d",
  total: "#f4f6fb",
  residual: "#71ddff",
  delta: "#149dff",
  hedgeRealized: "#3ce8a0",
  hedgeUnrealized: "#ffb52e",
});

let brushedDomain = null;
let hiddenDetailSeriesKeys = new Set();
let bottomMode = "mark";
let resolutionMenuOpen = false;
let lastResolutionKey = null;
let lastEmittedTimeAnchorTs = null;
let lastEmittedTimeRangeKey = null;

const layout = {
  width: 1200,
  headerHeight: 38,
  topPanelHeight: 300,
  bottomPanelHeight: 420,
  greekEvolutionPanelHeight: 860,
  panelGap: 34,
  margin: { top: 14, right: 38, bottom: 54, left: 74 },
};

const BOTTOM_TOP_INSET = 36;
const RESOLUTION_TOGGLE_X = 8;
const RESOLUTION_TOGGLE_Y = 6;
const LOWER_MODE_TOGGLE_X = 12;
const BOTTOM_MODE_OPTIONS = [
  { key: "mark", label: "Mark" },
  { key: "greeks", label: "Greeks P&L" },
  { key: "hedge", label: "Hedge P&L" },
  { key: "greekEvolution", label: "Greek evol" },
];
const GREEK_EVOLUTION_OPTIONS = [
  { key: "delta", label: "Delta", color: CHART_COLORS.delta },
  { key: "gamma", label: "Gamma", color: CHART_COLORS.gammaTheta },
  { key: "theta", label: "Theta", color: CHART_COLORS.charm },
  { key: "vega", label: "Vega", color: CHART_COLORS.vega },
];

const DETAIL_SERIES_ORDER = [
  {
    key: "gammaTheta",
    label: "Gamma + Theta",
    color: CHART_COLORS.gammaTheta,
    strokeWidth: 1.15,
    areaOpacity: 0,
  },
  {
    key: "vega",
    label: "Vega",
    color: CHART_COLORS.vega,
    strokeWidth: 1.15,
    areaOpacity: 0,
  },
  {
    key: "vanna",
    label: "Vanna",
    color: CHART_COLORS.vanna,
    strokeWidth: 1.15,
    areaOpacity: 0,
  },
  {
    key: "charm",
    label: "Charm",
    color: CHART_COLORS.charm,
    strokeWidth: 1.15,
    areaOpacity: 0,
  },
  {
    key: "vomma",
    label: "Volga",
    color: CHART_COLORS.vomma,
    strokeWidth: 1.15,
    areaOpacity: 0,
  },
  {
    key: "total",
    label: "Total",
    color: CHART_COLORS.total,
    strokeWidth: 1.3,
    strokeDasharray: null,
    areaOpacity: 0,
  },
  {
    key: "residual",
    label: "Residual",
    color: CHART_COLORS.residual,
    strokeWidth: 1.15,
    areaOpacity: 0,
  },
  {
    key: "delta",
    label: "Delta (Net)",
    color: CHART_COLORS.delta,
    strokeWidth: 1.35,
    areaOpacity: 0.4,
  },
];
const DETAIL_SERIES_CONFIG = DETAIL_SERIES_ORDER.map((series) => ({ ...series }));
const HIGHER_ORDER_GREEK_KEYS = new Set(["vanna", "charm", "vomma"]);

const normalizeComboPoints = (rows, useHedgedMark = false) =>
  (rows || [])
    .map((row) => {
      const ts = Number(row?.ts);
      const date =
        row?.date instanceof Date ? row.date : new Date(Number(row?.ts) * 1000);
      if (
        !Number.isFinite(ts) ||
        !(date instanceof Date) ||
        Number.isNaN(date.getTime())
      ) {
        return null;
      }
      const optionMarkClose = Number(row?.mark_price_close);
      const hedgedMarkClose = Number(row?.hedged_mark_price_close);
      return {
        ts,
        date,
        mark_price_close:
          useHedgedMark && Number.isFinite(hedgedMarkClose)
            ? hedgedMarkClose
            : optionMarkClose,
        option_mark_price_close: optionMarkClose,
        hedged_mark_price_close: hedgedMarkClose,
        index_price_close: Number(row?.index_price_close),
        iv_close: Number.isFinite(row?.iv_close) ? Number(row.iv_close) : NaN,
        iv_eff_close: Number.isFinite(row?.iv_eff_close)
          ? Number(row.iv_eff_close)
          : Number.isFinite(row?.iv_close)
            ? Number(row.iv_close)
            : NaN,
        combined_gamma: Number.isFinite(row?.combined_gamma)
          ? Number(row.combined_gamma)
          : NaN,
        PL: Number(row?.PL),
        delta_PL: Number(row?.delta_PL),
        gamma_theta_PL: Number(row?.gamma_theta_PL),
        vega_PL: Number(row?.vega_PL),
        vanna_PL: Number(row?.vanna_PL),
        charm_PL: Number(row?.charm_PL),
        vomma_PL: Number(row?.vomma_PL),
        residual_PL: Number(row?.residual_PL),
        hedge_PL: Number(row?.hedge_PL),
        hedge_cumulative_PL: Number(row?.hedge_cumulative_PL),
        hedge_realized_cumulative: Number(row?.hedge_realized_cumulative),
        hedge_unrealized: Number(row?.hedge_unrealized),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.ts - b.ts);

const normalizeSeriesPoints = (rows, valueKey = "value") =>
  (rows || [])
    .map((row) => {
      const ts = Number(row?.ts);
      const date =
        row?.date instanceof Date ? row.date : new Date(Number(row?.ts) * 1000);
      const value = Number(row?.[valueKey]);
      if (
        !Number.isFinite(ts) ||
        !(date instanceof Date) ||
        Number.isNaN(date.getTime()) ||
        !Number.isFinite(value)
      ) {
        return null;
      }
      return { ts, date, value };
    })
    .filter(Boolean)
    .sort((a, b) => a.ts - b.ts);

const buildMarkTrendSegments = (points, baselineMark) => {
  const validPoints = (points || []).filter(
    (point) =>
      point?.date instanceof Date &&
      !Number.isNaN(point.date.getTime()) &&
      Number.isFinite(point.mark_price_close),
  );
  if (validPoints.length < 2) return [];

  const segments = [];
  const appendSegment = (color, segmentPoints) => {
    if (!segmentPoints || segmentPoints.length < 2) return;
    const last = segments[segments.length - 1];
    if (last && last.color === color) {
      const merged = [...last.points];
      const firstNew = segmentPoints[0];
      const lastExisting = merged[merged.length - 1];
      const sameFirst =
        lastExisting?.date?.getTime?.() === firstNew?.date?.getTime?.() &&
        lastExisting?.mark_price_close === firstNew?.mark_price_close;
      merged.push(...(sameFirst ? segmentPoints.slice(1) : segmentPoints));
      last.points = merged;
      return;
    }
    segments.push({ color, points: segmentPoints });
  };

  const colorForPoint = (point) =>
    point.mark_price_close > baselineMark
      ? CHART_COLORS.positive
      : CHART_COLORS.negative;

  for (let i = 0; i < validPoints.length - 1; i += 1) {
    const start = validPoints[i];
    const end = validPoints[i + 1];
    const startColor = colorForPoint(start);
    const endColor = colorForPoint(end);

    if (
      startColor === endColor ||
      end.mark_price_close === start.mark_price_close
    ) {
      appendSegment(startColor, [start, end]);
      continue;
    }

    const ratio =
      (baselineMark - start.mark_price_close) /
      (end.mark_price_close - start.mark_price_close);
    const clampedRatio = Math.max(0, Math.min(1, ratio));
    const startMs = start.date.getTime();
    const endMs = end.date.getTime();
    const crossMs = startMs + (endMs - startMs) * clampedRatio;
    const crossPoint = {
      ...start,
      date: new Date(crossMs),
      mark_price_close: baselineMark,
    };

    appendSegment(startColor, [start, crossPoint]);
    appendSegment(endColor, [crossPoint, end]);
  }

  return segments;
};

const formatDate = d3.utcFormat("%d %b %y %H:%M");
const formatPnl = d3.format("$,.0f");
const formatMarkAxis = d3.format(",.0f");
const formatMarkDelta = d3.format("+,.0f");
const formatRoi = (pnl, initialMark) => {
  const roi = pnl / Math.abs(initialMark);
  return Number.isFinite(pnl) &&
    Number.isFinite(initialMark) &&
    initialMark !== 0 &&
    Number.isFinite(roi)
    ? `ROI: ${d3.format("+.2%")(roi)}`
    : "ROI: n/a";
};
const formatVol = d3.format(".1%");

const axisStyle = (axisG) => {
  axisG.selectAll("line").remove();
  axisG.selectAll("path").remove();
  axisG
    .selectAll("text")
    .attr("fill", CHART_COLORS.axisText)
    .style("font-size", "10px")
    .style("font-family", SVG_FONT_FAMILY);
};

function truncateCanvasText(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let truncated = `${text}...`;
  while (truncated.length > 4 && ctx.measureText(truncated).width > maxWidth) {
    truncated = `${truncated.slice(0, -4)}...`;
  }
  return truncated;
}

function splitPositionTitle(title) {
  const matches = title.match(/[+-][^\s]+\s+[^\s]+/g);
  return matches?.length ? matches : [title];
}

function buildExportTitleLines({ ctx, title, maxWidth, maxLines = 2 }) {
  const lines = [];
  const pieces = splitPositionTitle(title);

  let current = "";
  for (const piece of pieces) {
    const next = current ? `${current} ${piece}` : piece;
    if (ctx.measureText(next).width <= maxWidth || !current) {
      current = next;
      continue;
    }
    lines.push(current);
    current = piece;
    if (lines.length === maxLines) break;
  }
  if (current && lines.length < maxLines) lines.push(current);

  if (lines.length) {
    lines[lines.length - 1] = truncateCanvasText(
      ctx,
      lines[lines.length - 1],
      maxWidth,
    );
  }

  return lines;
}

function drawExportPageTitle({ ctx, width, padding, pageTitle }) {
  const title = String(pageTitle || "").trim();
  if (!title) return;

  const maxWidth = width + padding * 2 - 48;
  const [positionTitle = "", subtitle = ""] = title
    .split(/\n+/)
    .map((line) => line.trim());

  ctx.save();
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `600 16px ${SVG_FONT_FAMILY}`;

  const lines = buildExportTitleLines({
    ctx,
    title: positionTitle,
    maxWidth,
  });
  const lineHeight = 19;
  const hasSubtitle = Boolean(subtitle);
  const startY = lines.length > 1 || hasSubtitle ? 18 : 32;
  lines.forEach((line, index) => {
    ctx.fillText(line, width / 2 + padding, startY + index * lineHeight);
  });
  if (hasSubtitle) {
    ctx.fillStyle = CHART_COLORS.secondaryText;
    ctx.font = `400 13px ${SVG_FONT_FAMILY}`;
    ctx.fillText(
      truncateCanvasText(ctx, subtitle, maxWidth),
      width / 2 + padding,
      startY + lines.length * lineHeight,
    );
  }
  ctx.restore();
}

function exportPng({
  filename = "combo-pnl.png",
  scale = 4,
  padding = 24,
  pageTitle = "",
} = {}) {
  const exportPadding = String(pageTitle || "").trim()
    ? Math.max(padding, 82)
    : padding;

  exportChartToPng({
    element: svgRef.value,
    filename,
    scale,
    padding: exportPadding,
    drawBefore: ({ ctx, width, padding: resolvedPadding }) => {
      drawExportPageTitle({
        ctx,
        width,
        padding: resolvedPadding,
        pageTitle,
      });
    },
  });
}

defineExpose({ exportPng });

const isHiddenSeries = (key) => hiddenDetailSeriesKeys.has(key);

const toggleDetailSeries = (key) => {
  if (!key) return;
  if (hiddenDetailSeriesKeys.has(key)) {
    hiddenDetailSeriesKeys.delete(key);
  } else {
    hiddenDetailSeriesKeys.add(key);
  }
  render();
};

const getResolutionLabel = () => {
  const options = Array.isArray(props.resolutionOptions)
    ? props.resolutionOptions
    : [];
  const match = options.find(
    (option) => String(option?.key) === String(props.resolutionKey),
  );
  return match?.label ?? String(props.resolutionKey ?? "");
};

const drawResolutionControl = (svg) => {
  const options = Array.isArray(props.resolutionOptions)
    ? props.resolutionOptions
    : [];
  if (!options.length) return;

  const label = `Resolution ${getResolutionLabel()}`;
  const buttonHeight = 24;
  const buttonWidth = Math.max(112, Math.round(24 + label.length * 6.3));

  const trigger = svg
    .append("g")
    .attr(
      "transform",
      `translate(${RESOLUTION_TOGGLE_X},${RESOLUTION_TOGGLE_Y})`,
    )
    .style("cursor", "pointer")
    .on("click", (event) => {
      event.stopPropagation();
      resolutionMenuOpen = !resolutionMenuOpen;
      render();
    });

  trigger
    .append("rect")
    .attr("x", 0)
    .attr("y", 0)
    .attr("width", buttonWidth)
    .attr("height", buttonHeight)
    .attr("rx", 12)
    .attr("fill", "#12161e")
    .attr("stroke", "#2a2f3b")
    .attr("stroke-width", 1);

  trigger
    .append("text")
    .attr("x", buttonWidth / 2)
    .attr("y", buttonHeight / 2 + 0.5)
    .attr("text-anchor", "middle")
    .attr("dominant-baseline", "middle")
    .attr("fill", CHART_COLORS.secondaryText)
    .style("font-size", "10px")
    .style("font-weight", 600)
    .text(label);

  if (!resolutionMenuOpen) return;

  const rowHeight = 24;
  const menuWidth = Math.max(buttonWidth, 96);
  const menuY = buttonHeight + 6;
  const menuHeight = options.length * rowHeight;

  const menu = svg
    .append("g")
    .attr(
      "transform",
      `translate(${RESOLUTION_TOGGLE_X},${RESOLUTION_TOGGLE_Y + menuY})`,
    );

  menu
    .append("rect")
    .attr("x", 0)
    .attr("y", 0)
    .attr("width", menuWidth)
    .attr("height", menuHeight)
    .attr("rx", 6)
    .attr("fill", "#0a0d12")
    .attr("stroke", "#2a2f3b")
    .attr("stroke-width", 1);

  for (let i = 0; i < options.length; i += 1) {
    const option = options[i];
    const rowRectFillDefault = "#0f131b";
    const rowRectFillHover = "#1a212d";
    const row = menu
      .append("g")
      .attr("transform", `translate(0,${i * rowHeight})`)
      .style("cursor", "pointer")
      .on("mouseover", function () {
        d3.select(this).select("rect").attr("fill", rowRectFillHover);
        d3.select(this)
          .select("text")
          .attr("fill", "#f2f4ff")
          .style("font-weight", 700);
      })
      .on("mouseout", function () {
        d3.select(this).select("rect").attr("fill", rowRectFillDefault);
        d3.select(this)
          .select("text")
          .attr("fill", CHART_COLORS.secondaryText)
          .style("font-weight", 600);
      })
      .on("click", (event) => {
        event.stopPropagation();
        resolutionMenuOpen = false;
        const nextKey = String(option?.key ?? "");
        if (nextKey && nextKey !== String(props.resolutionKey)) {
          brushedDomain = null;
          if (lastEmittedTimeAnchorTs !== null) {
            emit("update:timeAnchorTs", null);
            lastEmittedTimeAnchorTs = null;
          }
          if (lastEmittedTimeRangeKey !== null) {
            emit("update:timeRangeTs", null);
            lastEmittedTimeRangeKey = null;
          }
          emit("update:resolutionKey", nextKey);
          return;
        }
        render();
      });

    row
      .append("rect")
      .attr("x", 0)
      .attr("y", 0)
      .attr("width", menuWidth)
      .attr("height", rowHeight)
      .attr("fill", rowRectFillDefault);

    row
      .append("text")
      .attr("x", menuWidth / 2)
      .attr("y", rowHeight / 2 + 0.5)
      .attr("text-anchor", "middle")
      .attr("dominant-baseline", "middle")
      .attr("fill", CHART_COLORS.secondaryText)
      .style("font-size", "10px")
      .style("font-weight", 600)
      .text(option?.label ?? "");
  }
};

const drawLowerModeToggle = (group) => {
  const toggleGroup = group
    .append("g")
    .attr("transform", `translate(${LOWER_MODE_TOGGLE_X},6)`);

  let xOffset = 0;
  for (const option of BOTTOM_MODE_OPTIONS) {
    const isActive = bottomMode === option.key;
    const width = Math.max(56, Math.round(18 + String(option.label).length * 6.1));
    const height = 24;
    const item = toggleGroup
      .append("g")
      .attr("transform", `translate(${xOffset},0)`)
      .style("cursor", "pointer")
      .on("click", (event) => {
        event.stopPropagation();
        if (bottomMode === option.key) return;
        bottomMode = option.key;
        emit("update:lowerMode", bottomMode);
        render();
      });

    item
      .append("rect")
      .attr("x", 0)
      .attr("y", 0)
      .attr("width", width)
      .attr("height", height)
      .attr("rx", 12)
      .attr("fill", isActive ? "#2b2f38" : "#12161e")
      .attr("stroke", isActive ? "#3d4452" : "#2a2f3b")
      .attr("stroke-width", 1);

    item
      .append("text")
      .attr("x", width / 2)
      .attr("y", 12.5)
      .attr("text-anchor", "middle")
      .attr("dominant-baseline", "middle")
      .attr(
        "fill",
        isActive ? CHART_COLORS.primaryText : CHART_COLORS.secondaryText,
      )
      .style("font-size", "10px")
      .style("font-weight", 600)
      .text(option.label);

    xOffset += width + 8;
  }
};

const emitTimeAnchorIfChanged = (
  indexPoints,
  domain = null,
  emitRange = false,
) => {
  const points = Array.isArray(indexPoints) ? indexPoints : [];
  if (!points.length) {
    if (lastEmittedTimeAnchorTs !== null) {
      emit("update:timeAnchorTs", null);
      lastEmittedTimeAnchorTs = null;
    }
    if (emitRange && lastEmittedTimeRangeKey !== null) {
      emit("update:timeRangeTs", null);
      lastEmittedTimeRangeKey = null;
    }
    return;
  }

  let startPoint = points[0];
  let endPoint = points[points.length - 1];
  if (Array.isArray(domain) && domain.length === 2 && domain[0] instanceof Date) {
    const domainStartMs = domain[0].getTime();
    const domainEndMs = domain[1].getTime();
    const firstInsideDomain = points.find(
      (point) => point?.date instanceof Date && point.date.getTime() >= domainStartMs,
    );
    const lastInsideDomain = points
      .slice()
      .reverse()
      .find(
        (point) =>
          point?.date instanceof Date && point.date.getTime() <= domainEndMs,
      );
    startPoint = firstInsideDomain ?? endPoint ?? points[0];
    endPoint = lastInsideDomain ?? startPoint;
  }

  const nextAnchorTs = Number.isFinite(Number(startPoint?.ts))
    ? Number(startPoint.ts)
    : null;
  if (nextAnchorTs !== lastEmittedTimeAnchorTs) {
    emit("update:timeAnchorTs", nextAnchorTs);
    lastEmittedTimeAnchorTs = nextAnchorTs;
  }

  if (emitRange) {
    const startTs = Number(startPoint?.ts);
    const endTs = Number(endPoint?.ts);
    const nextRange =
      Number.isFinite(startTs) && Number.isFinite(endTs)
        ? [startTs, endTs]
        : null;
    const nextRangeKey = nextRange ? `${startTs}:${endTs}` : null;
    if (nextRangeKey !== lastEmittedTimeRangeKey) {
      emit("update:timeRangeTs", nextRange);
      lastEmittedTimeRangeKey = nextRangeKey;
    }
  }
};

const normalizeEvolutionGreek = (key, value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return NaN;
  if (key === "gamma") return numeric * 1e4;
  if (key === "vega") return numeric / 100;
  return numeric;
};

const drawGreekEvolutionPanels = ({
  plotGroup,
  innerWidth,
  bottomInnerHeight,
}) => {
  const snapshots = (props.greekEvolutionData || [])
    .slice(0, 2)
    .map((snapshot) => ({
      ...snapshot,
      indexPrice: Number(snapshot?.indexPrice),
      points: (snapshot?.points || [])
        .map((point) => ({
          ...point,
          price: Number(point?.price),
        }))
        .filter((point) => Number.isFinite(point.price))
        .sort((a, b) => a.price - b.price),
    }))
    .filter(
      (snapshot) =>
        Number.isFinite(snapshot.indexPrice) && snapshot.points.length > 1,
    );

  if (snapshots.length !== 2) {
    plotGroup
      .append("text")
      .attr("x", innerWidth / 2)
      .attr("y", bottomInnerHeight / 2)
      .attr("text-anchor", "middle")
      .attr("fill", CHART_COLORS.secondaryText)
      .style("font-size", "10px")
      .text("No Greek evolution data in selected range");
    return;
  }

  const [startSnapshot, endSnapshot] = snapshots;
  const xExtent = d3.extent(
    snapshots.flatMap((snapshot) => snapshot.points),
    (point) => point.price,
  );
  const columnGap = 64;
  const rowGap = 38;
  const gridTop = 40;
  const panelWidth = (innerWidth - columnGap) / 2;
  const panelHeight = (bottomInnerHeight - gridTop - rowGap) / 2;
  const plotTop = 48;
  const plotBottom = panelHeight - 42;
  const xLabel =
    String(props.optionInstrumentName || "Index").replace(/USD$/, "") + " Price";
  const formatGreek = d3.format(".3~g");
  const formatSpot = d3.format(",.0f");
  const startDate = Number.isFinite(Number(startSnapshot.ts))
    ? formatDate(new Date(Number(startSnapshot.ts) * 1000))
    : "Start";
  const endDate = Number.isFinite(Number(endSnapshot.ts))
    ? formatDate(new Date(Number(endSnapshot.ts) * 1000))
    : "End";

  plotGroup
    .append("g")
    .attr("transform", `translate(${innerWidth - 386},5)`)
    .call((legend) => {
      const entries = [
        {
          label: `Start · ${startDate}`,
          color: "#9196a2",
          opacity: 0.7,
        },
        {
          label: `End · ${endDate}`,
          color: CHART_COLORS.primaryText,
          opacity: 1,
        },
      ];
      const items = legend
        .selectAll("g")
        .data(entries)
        .join("g")
        .attr("transform", (_entry, index) => `translate(${index * 195},0)`);
      items
        .append("line")
        .attr("x1", 0)
        .attr("x2", 18)
        .attr("stroke", (entry) => entry.color)
        .attr("stroke-opacity", (entry) => entry.opacity)
        .attr("stroke-width", 1.8)
        .attr("stroke-linecap", "round");
      items
        .append("text")
        .attr("x", 25)
        .attr("y", 3)
        .attr("fill", CHART_COLORS.secondaryText)
        .style("font-size", "10px")
        .style("font-weight", 550)
        .text((entry) => entry.label);
    });

  plotGroup
    .append("line")
    .attr("x1", panelWidth + columnGap / 2)
    .attr("x2", panelWidth + columnGap / 2)
    .attr("y1", gridTop)
    .attr("y2", bottomInnerHeight)
    .attr("stroke", "#242a34");

  plotGroup
    .append("line")
    .attr("x1", 0)
    .attr("x2", innerWidth)
    .attr("y1", gridTop + panelHeight + rowGap / 2)
    .attr("y2", gridTop + panelHeight + rowGap / 2)
    .attr("stroke", "#242a34");

  GREEK_EVOLUTION_OPTIONS.forEach((greekOption, panelIndex) => {
    const column = panelIndex % 2;
    const row = Math.floor(panelIndex / 2);
    const panelX = column * (panelWidth + columnGap);
    const panelY = gridTop + row * (panelHeight + rowGap);
    const group = plotGroup
      .append("g")
      .attr("transform", `translate(${panelX},${panelY})`);
    const series = snapshots.map((snapshot) => ({
      ...snapshot,
      values: snapshot.points
        .map((point) => ({
          price: point.price,
          value: normalizeEvolutionGreek(
            greekOption.key,
            point?.[greekOption.key],
          ),
        }))
        .filter((point) => Number.isFinite(point.value)),
    }));
    const yValues = series.flatMap((snapshot) =>
      snapshot.values.map((point) => point.value),
    );
    const includeZero = greekOption.key !== "delta";
    let yMin = includeZero ? Math.min(0, ...yValues) : Math.min(...yValues);
    let yMax = includeZero ? Math.max(0, ...yValues) : Math.max(...yValues);
    if (yMin === yMax) {
      const pad = yMin === 0 ? 1 : Math.abs(yMin) * 0.1;
      yMin -= pad;
      yMax += pad;
    } else {
      const pad = (yMax - yMin) * 0.08;
      yMin -= pad;
      yMax += pad;
    }
    const x = d3
      .scaleLinear()
      .domain(xExtent)
      .range([0, panelWidth]);
    const y = d3
      .scaleLinear()
      .domain([yMin, yMax])
      .nice()
      .range([plotBottom, plotTop]);
    const title =
      greekOption.key === "gamma"
        ? "Gamma (×10⁴)"
        : greekOption.key === "vega"
          ? "Vega (per 1 vol pt)"
          : greekOption.label;

    group
      .append("text")
      .attr("x", panelWidth / 2)
      .attr("y", 20)
      .attr("text-anchor", "middle")
      .attr("fill", CHART_COLORS.primaryText)
      .style("font-size", "13px")
      .style("font-weight", 650)
      .text(title);

    group
      .append("g")
      .attr("transform", `translate(0,${plotBottom})`)
      .call(
        d3
          .axisBottom(x)
          .ticks(4)
          .tickSize(0)
          .tickPadding(10)
          .tickFormat(formatSpot),
      )
      .call(axisStyle);

    group
      .append("g")
      .call(
        d3
          .axisLeft(y)
          .ticks(5)
          .tickSize(0)
          .tickPadding(10)
          .tickFormat(formatGreek),
      )
      .call(axisStyle);

    group
      .append("text")
      .attr("x", panelWidth / 2)
      .attr("y", plotBottom + 38)
      .attr("text-anchor", "middle")
      .attr("fill", CHART_COLORS.axisText)
      .style("font-size", "10px")
      .style("font-weight", 700)
      .text(xLabel);

    const line = d3
      .line()
      .x((point) => x(point.price))
      .y((point) => y(point.value))
      .curve(d3.curveMonotoneX);

    series.forEach((snapshot, snapshotIndex) => {
      const isStart = snapshotIndex === 0;
      const color = isStart ? "#9196a2" : greekOption.color;
      const opacity = isStart ? 0.62 : 1;

      group
        .append("path")
        .datum(snapshot.values)
        .attr("fill", "none")
        .attr("stroke", color)
        .attr("stroke-opacity", opacity)
        .attr("stroke-width", isStart ? 1.45 : 1.9)
        .attr("stroke-linecap", "round")
        .attr("stroke-linejoin", "round")
        .attr("d", line);

      const prevailingPoint = snapshot.values.reduce((closest, point) =>
        Math.abs(point.price - snapshot.indexPrice) <
        Math.abs(closest.price - snapshot.indexPrice)
          ? point
          : closest,
      );
      const markerX = x(prevailingPoint.price);
      const markerY = y(prevailingPoint.value);

      group
        .append("line")
        .attr("x1", markerX)
        .attr("x2", markerX)
        .attr("y1", markerY + 6)
        .attr("y2", plotBottom)
        .attr("stroke", color)
        .attr("stroke-opacity", isStart ? 0.14 : 0.2)
        .attr("stroke-dasharray", "2 4");

      group
        .append("circle")
        .attr("cx", markerX)
        .attr("cy", markerY)
        .attr("r", isStart ? 6 : 8)
        .attr("fill", color)
        .attr("fill-opacity", isStart ? 0.12 : 0.16);

      group
        .append("circle")
        .attr("cx", markerX)
        .attr("cy", markerY)
        .attr("r", isStart ? 3.3 : 4)
        .attr("fill", color)
        .attr("fill-opacity", opacity)
        .attr("stroke", "#05070a")
        .attr("stroke-width", 2)
        .append("title")
        .text(
          `${isStart ? "Start" : "End"} index ${formatSpot(
            snapshot.indexPrice,
          )} · ${greekOption.label} ${formatGreek(prevailingPoint.value)}`,
        );
    });
  });
};

const render = () => {
  const svgEl = svgRef.value;
  if (!svgEl) return;

  const currentResolutionKey = String(props.resolutionKey ?? "");
  if (lastResolutionKey != null && currentResolutionKey !== lastResolutionKey) {
    brushedDomain = null;
  }
  lastResolutionKey = currentResolutionKey;

  const index = normalizeSeriesPoints(props.indexData, "index_price_close");
  const combo = normalizeComboPoints(props.comboData, props.deltaHedgeEnabled);

  const innerWidth = layout.width - layout.margin.left - layout.margin.right;
  const topInnerHeight =
    layout.topPanelHeight - layout.margin.top - layout.margin.bottom;
  const activeBottomPanelHeight =
    bottomMode === "greekEvolution"
      ? layout.greekEvolutionPanelHeight
      : layout.bottomPanelHeight;
  const bottomInnerHeight =
    activeBottomPanelHeight - layout.margin.top - layout.margin.bottom;
  const totalHeight =
    layout.headerHeight +
    layout.topPanelHeight +
    layout.panelGap +
    activeBottomPanelHeight;

  const topPanelY = layout.headerHeight;
  const bottomPanelY =
    layout.headerHeight + layout.topPanelHeight + layout.panelGap;

  const svg = d3
    .select(svgRef.value)
    .attr("viewBox", `0 0 ${layout.width} ${totalHeight}`)
    .attr("width", "100%")
    .style("display", "block")
    .style("height", "auto")
    .style("font-family", SVG_FONT_FAMILY)
    .attr("role", "img");

  svg.selectAll("*").remove();
  svg.on("click.resolution-menu", () => {
    if (!resolutionMenuOpen) return;
    resolutionMenuOpen = false;
    render();
  });

  svg
    .append("rect")
    .attr("x", 0)
    .attr("y", 0)
    .attr("width", layout.width)
    .attr("height", totalHeight)
    .attr("fill", "#000");

  if (!index.length) {
    emitTimeAnchorIfChanged([], null, true);
    svg
      .append("text")
      .attr("x", layout.width / 2)
      .attr("y", totalHeight / 2)
      .attr("text-anchor", "middle")
      .attr("fill", CHART_COLORS.secondaryText)
      .style("font-size", "14px")
      .text(props.loading ? "Loading..." : "No data for this range.");
    return;
  }

  const titleText = props.optionInstrumentName || "Options";
  svg
    .append("text")
    .attr("x", layout.width / 2)
    .attr("y", 16)
    .attr("text-anchor", "middle")
    .attr("fill", "#fff")
    .style("font-size", "14px")
    .style("font-weight", 650)
    .text(titleText);

  svg
    .append("text")
    .attr("x", layout.width / 2)
    .attr("y", 36)
    .attr("text-anchor", "middle")
    .attr("fill", CHART_COLORS.secondaryText)
    .style("font-size", "12px")
    .text(props.subtitle || "");

  const xDomain = d3.extent(index, (point) => point.date);
  const yDomain = d3.extent(index, (point) => point.value);

  const xTop = d3.scaleUtc().domain(xDomain).range([0, innerWidth]);
  const yTop = d3
    .scaleLinear()
    .domain(yDomain)
    .nice()
    .range([topInnerHeight, 0]);

  const topGroup = svg
    .append("g")
    .attr(
      "transform",
      `translate(${layout.margin.left},${topPanelY + layout.margin.top})`,
    );

  topGroup
    .append("g")
    .attr("transform", `translate(0,${topInnerHeight})`)
    .call(d3.axisBottom(xTop).ticks(10).tickSize(0).tickPadding(10))
    .call(axisStyle);
  topGroup
    .append("g")
    .call(
      d3
        .axisLeft(yTop)
        .ticks(3)
        .tickSize(0)
        .tickPadding(10)
        .tickFormat(d3.format(",.0f")),
    )
    .call(axisStyle);

  topGroup
    .append("text")
    .attr("x", innerWidth / 2)
    .attr("y", topInnerHeight + 42)
    .attr("text-anchor", "middle")
    .attr("fill", CHART_COLORS.axisText)
    .style("font-size", "10px")
    .style("font-weight", 700)
    .text("Date (UTC)");

  topGroup
    .append("text")
    .attr("transform", "rotate(-90)")
    .attr("x", -topInnerHeight / 2)
    .attr("y", -62)
    .attr("text-anchor", "middle")
    .attr("fill", CHART_COLORS.axisText)
    .style("font-size", "10px")
    .style("font-weight", 700)
    .text("Index Price (Close)");

  const topLine = d3
    .line()
    .x((point) => xTop(point.date))
    .y((point) => yTop(point.value))
    .curve(d3.curveMonotoneX);

  topGroup
    .append("path")
    .datum(index)
    .attr("fill", "none")
    .attr("stroke", CHART_COLORS.index)
    .attr("stroke-width", 1.5)
    .attr("d", topLine);

  const bottomPanelGroup = svg
    .append("g")
    .attr("transform", `translate(0,${bottomPanelY})`);

  const drawBottom = (domain = null) => {
    bottomPanelGroup.selectAll("*").remove();
    drawLowerModeToggle(bottomPanelGroup);

    const domainStart = domain?.[0] ?? xDomain?.[0];
    const domainEnd = domain?.[1] ?? xDomain?.[1];

    const comboFiltered = combo
      .filter((point) => point.date >= domainStart && point.date <= domainEnd)
      .sort((a, b) => a.date - b.date);

    const plotGroup = bottomPanelGroup
      .append("g")
      .attr(
        "transform",
        `translate(${layout.margin.left},${layout.margin.top})`,
      );

    if (bottomMode === "greekEvolution") {
      drawGreekEvolutionPanels({
        plotGroup,
        innerWidth,
        bottomInnerHeight,
      });
      return;
    }

    if (!comboFiltered.length) {
      const emptyMessageByMode = {
        mark: "No mark data in selected range",
        greeks: "No Greeks P&L data in selected range",
        hedge: props.deltaHedgeEnabled
          ? "No hedge P&L data in selected range"
          : "Delta hedge is off. Enable it to view hedge P&L.",
      };
      plotGroup
        .append("text")
        .attr("x", innerWidth / 2)
        .attr("y", bottomInnerHeight / 2)
        .attr("text-anchor", "middle")
        .attr("fill", CHART_COLORS.secondaryText)
        .style("font-size", "10px")
        .text(emptyMessageByMode[bottomMode] || "No data in selected range");
      return;
    }

    const titleDateFrom = comboFiltered[0]?.date;
    const titleDateTo = comboFiltered[comboFiltered.length - 1]?.date;
    let subtitle = "";
    if (titleDateFrom instanceof Date && titleDateTo instanceof Date) {
      const msPerDay = 24 * 60 * 60 * 1000;
      const days = (titleDateTo - titleDateFrom) / msPerDay;
      subtitle = `${formatDate(titleDateFrom)} - ${formatDate(titleDateTo)} (${days.toFixed(1)} days)`;
    }

    if (bottomMode === "mark") {
      const firstVisibleHedgeBaseline = props.deltaHedgeEnabled
        ? (() => {
            const baselinePoint = combo
              .filter((point) => point.date < domainStart)
              .sort((a, b) => b.date - a.date)
              .find((point) =>
                Number.isFinite(point.option_mark_price_close) &&
                Number.isFinite(point.hedge_cumulative_PL),
              );
            return Number.isFinite(baselinePoint?.hedge_cumulative_PL)
              ? Number(baselinePoint.hedge_cumulative_PL)
              : 0;
          })()
        : 0;
      const markPoints = comboFiltered
        .map((point) => {
          if (!props.deltaHedgeEnabled) return point;
          const optionMark = Number(point.option_mark_price_close);
          const hedgeCumulative = Number(point.hedge_cumulative_PL);
          if (!Number.isFinite(optionMark)) return point;
          const rebasedHedgePnl = Number.isFinite(hedgeCumulative)
            ? hedgeCumulative - firstVisibleHedgeBaseline
            : 0;
          return {
            ...point,
            mark_price_close: optionMark + rebasedHedgePnl,
          };
        })
        .filter((point) => Number.isFinite(point.mark_price_close));
      const firstMarkPoint = markPoints[0];
      const lastVisibleMarkPoint = markPoints[markPoints.length - 1];
      const markRoi = formatRoi(
        lastVisibleMarkPoint?.mark_price_close - firstMarkPoint?.mark_price_close,
        firstMarkPoint?.option_mark_price_close,
      );

      bottomPanelGroup
        .append("text")
        .attr("x", layout.width / 2)
        .attr("y", 24)
        .attr("text-anchor", "middle")
        .attr("fill", "#fff")
        .style("font-size", "14px")
        .style("font-weight", 600)
        .text(props.comboTitle || "Combination Mark Price");

      bottomPanelGroup
        .append("text")
        .attr("x", layout.width / 2)
        .attr("y", 44)
        .attr("text-anchor", "middle")
        .attr("fill", CHART_COLORS.secondaryText)
        .style("font-size", "12px")
        .text(`${subtitle} | ${markRoi}`);

      if (!markPoints.length) {
        plotGroup
          .append("text")
          .attr("x", innerWidth / 2)
          .attr("y", bottomInnerHeight / 2)
          .attr("text-anchor", "middle")
          .attr("fill", CHART_COLORS.secondaryText)
          .style("font-size", "10px")
          .text("No mark data in selected range");
        return;
      }

      const xBottom = d3
        .scaleUtc()
        .domain(d3.extent(markPoints, (point) => point.date))
        .range([0, innerWidth]);
      const [minMark, maxMark] = d3.extent(
        markPoints,
        (point) => point.mark_price_close,
      );
      let yMin = Number.isFinite(minMark) ? minMark : 0;
      let yMax = Number.isFinite(maxMark) ? maxMark : 0;
      if (yMin === yMax) {
        const pad = yMin === 0 ? 1 : Math.abs(yMin) * 0.05;
        yMin -= pad;
        yMax += pad;
      }
      const yPad = Math.max((yMax - yMin) * 0.08, 1);
      const yBottom = d3
        .scaleLinear()
        .domain([yMin - yPad, yMax + yPad])
        .nice()
        .range([bottomInnerHeight, BOTTOM_TOP_INSET]);

      const xAxis = d3.axisBottom(xBottom).ticks(6).tickSize(0).tickPadding(10);
      const yAxis = d3
        .axisLeft(yBottom)
        .ticks(3)
        .tickSize(0)
        .tickPadding(10)
        .tickFormat(formatMarkAxis);

      plotGroup
        .append("g")
        .attr("transform", `translate(0,${bottomInnerHeight})`)
        .call(xAxis)
        .call(axisStyle);
      plotGroup.append("g").call(yAxis).call(axisStyle);

      plotGroup
        .append("text")
        .attr("x", innerWidth / 2)
        .attr("y", bottomInnerHeight + 42)
        .attr("text-anchor", "middle")
        .attr("fill", CHART_COLORS.axisText)
        .style("font-size", "10px")
        .style("font-weight", 700)
        .text("Date (UTC)");

      plotGroup
        .append("text")
        .attr("transform", "rotate(-90)")
        .attr("x", -bottomInnerHeight / 2)
        .attr("y", -62)
        .attr("text-anchor", "middle")
        .attr("fill", CHART_COLORS.axisText)
        .style("font-size", "10px")
        .style("font-weight", 700)
        .text("Mark Price");

      const firstFinitePoint = markPoints.find((point) =>
        Number.isFinite(point.mark_price_close),
      );
      const initialMark = Number(firstFinitePoint?.mark_price_close);
      const baselineMark = Number.isFinite(initialMark) ? initialMark : 0;

      const gradientIdSuffix = Math.random().toString(36).slice(2, 9);
      const gradientAboveId = `mark-above-${gradientIdSuffix}`;
      const gradientBelowId = `mark-below-${gradientIdSuffix}`;
      const defs = bottomPanelGroup.append("defs");

      const gradientAbove = defs
        .append("linearGradient")
        .attr("id", gradientAboveId)
        .attr("x1", "0%")
        .attr("x2", "0%")
        .attr("y1", "0%")
        .attr("y2", "100%");
      gradientAbove
        .append("stop")
        .attr("offset", "0%")
        .attr("stop-color", CHART_COLORS.positive)
        .attr("stop-opacity", 0.42);
      gradientAbove
        .append("stop")
        .attr("offset", "55%")
        .attr("stop-color", CHART_COLORS.positive)
        .attr("stop-opacity", 0.22);
      gradientAbove
        .append("stop")
        .attr("offset", "100%")
        .attr("stop-color", CHART_COLORS.positive)
        .attr("stop-opacity", 0.06);

      const gradientBelow = defs
        .append("linearGradient")
        .attr("id", gradientBelowId)
        .attr("x1", "0%")
        .attr("x2", "0%")
        .attr("y1", "0%")
        .attr("y2", "100%");
      gradientBelow
        .append("stop")
        .attr("offset", "0%")
        .attr("stop-color", CHART_COLORS.negative)
        .attr("stop-opacity", 0.06);
      gradientBelow
        .append("stop")
        .attr("offset", "45%")
        .attr("stop-color", CHART_COLORS.negative)
        .attr("stop-opacity", 0.22);
      gradientBelow
        .append("stop")
        .attr("offset", "100%")
        .attr("stop-color", CHART_COLORS.negative)
        .attr("stop-opacity", 0.42);

      const areaAbove = d3
        .area()
        .x((point) => xBottom(point.date))
        .y0(yBottom(baselineMark))
        .y1((point) => yBottom(point.mark_price_close))
        .curve(d3.curveMonotoneX)
        .defined(
          (point) =>
            Number.isFinite(point.mark_price_close) &&
            point.mark_price_close >= baselineMark,
        );

      const areaBelow = d3
        .area()
        .x((point) => xBottom(point.date))
        .y0(yBottom(baselineMark))
        .y1((point) => yBottom(point.mark_price_close))
        .curve(d3.curveMonotoneX)
        .defined(
          (point) =>
            Number.isFinite(point.mark_price_close) &&
            point.mark_price_close < baselineMark,
        );

      const line = d3
        .line()
        .x((point) => xBottom(point.date))
        .y((point) => yBottom(point.mark_price_close))
        .curve(d3.curveMonotoneX)
        .defined((point) => Number.isFinite(point.mark_price_close));
      const lineSegments = buildMarkTrendSegments(markPoints, baselineMark);

      plotGroup
        .append("path")
        .datum(markPoints)
        .attr("fill", `url(#${gradientAboveId})`)
        .attr("stroke", "none")
        .attr("d", areaAbove);

      plotGroup
        .append("path")
        .datum(markPoints)
        .attr("fill", `url(#${gradientBelowId})`)
        .attr("stroke", "none")
        .attr("d", areaBelow);

      plotGroup
        .append("g")
        .selectAll("path.mark-trend-line")
        .data(lineSegments)
        .join("path")
        .attr("class", "mark-trend-line")
        .attr("fill", "none")
        .attr("stroke", (segment) => segment.color)
        .attr("stroke-width", 1.5)
        .attr("stroke-linecap", "round")
        .attr("stroke-linejoin", "round")
        .attr("d", (segment) => line(segment.points));

      const lastMarkPoint = markPoints[markPoints.length - 1];
      if (
        lastMarkPoint?.date instanceof Date &&
        Number.isFinite(lastMarkPoint.mark_price_close)
      ) {
        const pointX = xBottom(lastMarkPoint.date);
        const placeLeft = pointX > innerWidth * 0.82;
        const labelX = placeLeft ? pointX - 8 : pointX + 8;
        const markDelta = lastMarkPoint.mark_price_close - baselineMark;
        const deltaLabelY = Math.max(
          BOTTOM_TOP_INSET + 10,
          Math.min(bottomInnerHeight - 6, yBottom(baselineMark) - 6),
        );
        const deltaColor =
          markDelta >= 0 ? CHART_COLORS.positive : CHART_COLORS.negative;

        plotGroup
          .append("text")
          .attr("x", labelX)
          .attr("y", deltaLabelY)
          .attr("text-anchor", placeLeft ? "end" : "start")
          .attr("fill", deltaColor)
          .style("font-size", "11px")
          .style("font-weight", 400)
          .attr("paint-order", "stroke")
          .attr("stroke", "#000")
          .attr("stroke-width", 3)
          .text(`Δ ${formatMarkDelta(markDelta)}`);
      }

      return;
    }

    if (bottomMode === "hedge") {
      const hedgePoints = comboFiltered.map((point) => {
        const realized = Number.isFinite(point.hedge_realized_cumulative)
          ? point.hedge_realized_cumulative
          : 0;
        const unrealized = Number.isFinite(point.hedge_unrealized)
          ? point.hedge_unrealized
          : 0;
        const total = Number.isFinite(point.hedge_cumulative_PL)
          ? point.hedge_cumulative_PL
          : realized + unrealized;
        return {
          date: point.date,
          realized,
          unrealized,
          total,
        };
      });
      const priorHedgePoint = combo
        .filter((point) => point.date < domainStart)
        .sort((a, b) => b.date - a.date)
        .find(
          (point) =>
            Number.isFinite(point.hedge_realized_cumulative) ||
            Number.isFinite(point.hedge_unrealized) ||
            Number.isFinite(point.hedge_cumulative_PL),
        );
      const baselinePoint = priorHedgePoint
        ? {
            realized: Number.isFinite(priorHedgePoint.hedge_realized_cumulative)
              ? priorHedgePoint.hedge_realized_cumulative
              : 0,
            unrealized: Number.isFinite(priorHedgePoint.hedge_unrealized)
              ? priorHedgePoint.hedge_unrealized
              : 0,
            total: Number.isFinite(priorHedgePoint.hedge_cumulative_PL)
              ? priorHedgePoint.hedge_cumulative_PL
              : 0,
          }
        : {
            realized: 0,
            unrealized: 0,
            total: 0,
          };
      const baselineRealized = Number.isFinite(baselinePoint.realized)
        ? baselinePoint.realized
        : 0;
      const baselineUnrealized = Number.isFinite(baselinePoint.unrealized)
        ? baselinePoint.unrealized
        : 0;
      const baselineTotal = Number.isFinite(baselinePoint.total)
        ? baselinePoint.total
        : baselineRealized + baselineUnrealized;
      const rebasedHedgePoints = hedgePoints.map((point) => ({
        date: point.date,
        realized: point.realized - baselineRealized,
        unrealized: point.unrealized - baselineUnrealized,
        total: point.total - baselineTotal,
      }));

      bottomPanelGroup
        .append("text")
        .attr("x", layout.width / 2)
        .attr("y", 24)
        .attr("text-anchor", "middle")
        .attr("fill", "#fff")
        .style("font-size", "14px")
        .style("font-weight", 600)
        .text(props.comboTitle || "Delta Hedge P&L");

      bottomPanelGroup
        .append("text")
        .attr("x", layout.width / 2)
        .attr("y", 44)
        .attr("text-anchor", "middle")
        .attr("fill", CHART_COLORS.secondaryText)
        .style("font-size", "12px")
        .text(subtitle);

      const xBottom = d3
        .scaleUtc()
        .domain(d3.extent(rebasedHedgePoints, (point) => point.date))
        .range([0, innerWidth]);
      const yValues = rebasedHedgePoints.flatMap((point) => [
        point.realized,
        point.unrealized,
        point.total,
      ]);
      let yMin = Math.min(0, ...yValues);
      let yMax = Math.max(0, ...yValues);
      if (yMin === yMax) {
        const pad = yMin === 0 ? 0.0001 : Math.abs(yMin) * 0.1;
        yMin -= pad;
        yMax += pad;
      }
      const yBottom = d3
        .scaleLinear()
        .domain([yMin, yMax])
        .nice()
        .range([bottomInnerHeight, BOTTOM_TOP_INSET]);

      const xAxis = d3.axisBottom(xBottom).ticks(6).tickSize(0).tickPadding(10);
      const yAxis = d3
        .axisLeft(yBottom)
        .ticks(5)
        .tickSize(0)
        .tickPadding(10)
        .tickFormat(formatPnl);

      plotGroup
        .append("g")
        .attr("transform", `translate(0,${bottomInnerHeight})`)
        .call(xAxis)
        .call(axisStyle);
      plotGroup.append("g").call(yAxis).call(axisStyle);

      plotGroup
        .append("text")
        .attr("x", innerWidth / 2)
        .attr("y", bottomInnerHeight + 42)
        .attr("text-anchor", "middle")
        .attr("fill", CHART_COLORS.axisText)
        .style("font-size", "10px")
        .style("font-weight", 700)
        .text("Date (UTC)");

      plotGroup
        .append("text")
        .attr("transform", "rotate(-90)")
        .attr("x", -bottomInnerHeight / 2)
        .attr("y", -62)
        .attr("text-anchor", "middle")
        .attr("fill", CHART_COLORS.axisText)
        .style("font-size", "10px")
        .style("font-weight", 700)
        .text("Cumulative Hedge P&L ($)");

      const line = d3
        .line()
        .x((point) => xBottom(point.date))
        .y((point) => yBottom(point.value))
        .curve(d3.curveMonotoneX);

      const hedgeSeries = [
        {
          key: "realized",
          label: "Realized",
          color: CHART_COLORS.hedgeRealized,
          strokeDasharray: null,
          values: rebasedHedgePoints.map((point) => ({
            date: point.date,
            value: point.realized,
          })),
        },
        {
          key: "unrealized",
          label: "Unrealized",
          color: CHART_COLORS.hedgeUnrealized,
          strokeDasharray: null,
          values: rebasedHedgePoints.map((point) => ({
            date: point.date,
            value: point.unrealized,
          })),
        },
        {
          key: "total",
          label: "Total",
          color: CHART_COLORS.total,
          strokeDasharray: null,
          values: rebasedHedgePoints.map((point) => ({
            date: point.date,
            value: point.total,
          })),
        },
      ];

      plotGroup
        .append("g")
        .selectAll("path.hedge-line")
        .data(hedgeSeries)
        .join("path")
        .attr("class", "hedge-line")
        .attr("fill", "none")
        .attr("stroke", (series) => series.color)
        .attr("stroke-width", 1.35)
        .attr("stroke-linecap", "round")
        .attr("stroke-linejoin", "round")
        .attr("stroke-dasharray", (series) => series.strokeDasharray)
        .attr("d", (series) => line(series.values));

      const legendLineLength = 18;
      const legendLabelOffset = 6;
      const legendColGap = 120;
      const legendTextMaxWidth = 84;
      const legendItemWidth =
        legendLineLength + legendLabelOffset + legendTextMaxWidth;
      const legendTotalWidth = 2 * legendColGap + legendItemWidth;
      const legendX = layout.width - layout.margin.right - legendTotalWidth;
      const legendY = 24;

      const legendGroup = bottomPanelGroup
        .append("g")
        .attr("transform", `translate(${legendX},${legendY})`);

      const legendItems = legendGroup
        .selectAll("g.hedge-legend-item")
        .data(hedgeSeries)
        .join("g")
        .attr("class", "hedge-legend-item")
        .attr("transform", (_d, i) => `translate(${i * legendColGap},0)`);

      legendItems
        .append("line")
        .attr("x1", 0)
        .attr("y1", 0)
        .attr("x2", legendLineLength)
        .attr("y2", 0)
        .attr("stroke", (d) => d.color)
        .attr("stroke-width", 1.35)
        .attr("stroke-dasharray", (d) => d.strokeDasharray)
        .attr("stroke-linecap", "round");

      legendItems
        .append("text")
        .attr("x", legendLineLength + legendLabelOffset)
        .attr("y", 3)
        .attr("fill", CHART_COLORS.secondaryText)
        .style("font-size", "11px")
        .style("font-family", SVG_FONT_FAMILY)
        .style("font-weight", 500)
        .text((d) => d.label);

      return;
    }

    const cumulative = {
      total: 0,
      delta: 0,
      gammaTheta: 0,
      vega: 0,
      vanna: 0,
      charm: 0,
      vomma: 0,
      residual: 0,
    };
    const seriesByKey = {
      total: [],
      delta: [],
      gammaTheta: [],
      vega: [],
      vanna: [],
      charm: [],
      vomma: [],
      residual: [],
    };

    comboFiltered.forEach((point, indexPoint) => {
      const date = point.date;
      if (indexPoint === 0) {
        seriesByKey.total.push({ date, value: 0 });
        seriesByKey.delta.push({ date, value: 0 });
        seriesByKey.gammaTheta.push({ date, value: 0 });
        seriesByKey.vega.push({ date, value: 0 });
        seriesByKey.vanna.push({ date, value: 0 });
        seriesByKey.charm.push({ date, value: 0 });
        seriesByKey.vomma.push({ date, value: 0 });
        seriesByKey.residual.push({ date, value: 0 });
        return;
      }

      const optionDeltaPL = Number.isFinite(point.delta_PL) ? point.delta_PL : 0;
      const optionGammaThetaPL = Number.isFinite(point.gamma_theta_PL)
        ? point.gamma_theta_PL
        : 0;
      const hedgePL = Number.isFinite(point.hedge_PL) ? point.hedge_PL : 0;
      const deltaPL = optionDeltaPL + hedgePL;
      const gammaThetaPL = optionGammaThetaPL;
      const vegaPL = Number.isFinite(point.vega_PL) ? point.vega_PL : 0;
      const vannaPL = Number.isFinite(point.vanna_PL) ? point.vanna_PL : 0;
      const charmPL = Number.isFinite(point.charm_PL) ? point.charm_PL : 0;
      const vommaPL = Number.isFinite(point.vomma_PL) ? point.vomma_PL : 0;
      const residualPL = Number.isFinite(point.residual_PL)
        ? point.residual_PL
        : 0;
      const totalPL = Number.isFinite(point.PL)
        ? point.PL
        : deltaPL +
          gammaThetaPL +
          vegaPL +
          vannaPL +
          charmPL +
          vommaPL +
          residualPL;

      cumulative.delta += deltaPL;
      cumulative.gammaTheta += gammaThetaPL;
      cumulative.vega += vegaPL;
      cumulative.vanna += vannaPL;
      cumulative.charm += charmPL;
      cumulative.vomma += vommaPL;
      cumulative.residual += residualPL;
      cumulative.total += totalPL;

      seriesByKey.total.push({ date, value: cumulative.total });
      seriesByKey.delta.push({ date, value: cumulative.delta });
      seriesByKey.gammaTheta.push({ date, value: cumulative.gammaTheta });
      seriesByKey.vega.push({ date, value: cumulative.vega });
      seriesByKey.vanna.push({ date, value: cumulative.vanna });
      seriesByKey.charm.push({ date, value: cumulative.charm });
      seriesByKey.vomma.push({ date, value: cumulative.vomma });
      seriesByKey.residual.push({ date, value: cumulative.residual });
    });

    const detailSeriesConfig = props.showHigherOrderGreeks
      ? DETAIL_SERIES_CONFIG
      : DETAIL_SERIES_CONFIG.filter(
          (series) => !HIGHER_ORDER_GREEK_KEYS.has(series.key),
        );
    const seriesList = detailSeriesConfig.map((series) => ({
      ...series,
      values: seriesByKey[series.key] || [],
    }));
    const visibleSeries = seriesList.filter((series) => !isHiddenSeries(series.key));
    const seriesPoints = visibleSeries.flatMap((series) =>
      (series.values || []).filter(
        (point) =>
          point?.date instanceof Date &&
          !Number.isNaN(point.date.getTime()) &&
          Number.isFinite(point.value),
      ),
    );

    if (!seriesPoints.length) {
      plotGroup
        .append("text")
        .attr("x", innerWidth / 2)
        .attr("y", bottomInnerHeight / 2)
        .attr("text-anchor", "middle")
        .attr("fill", CHART_COLORS.secondaryText)
        .style("font-size", "10px")
        .text("No Greeks P&L data in selected range");
      return;
    }

    const xBottom = d3
      .scaleUtc()
      .domain(d3.extent(comboFiltered, (point) => point.date))
      .range([0, innerWidth]);
    let yMin = Math.min(0, ...seriesPoints.map((point) => point.value));
    let yMax = Math.max(0, ...seriesPoints.map((point) => point.value));
    if (yMin === yMax) {
      const pad = yMin === 0 ? 0.0001 : Math.abs(yMin) * 0.1;
      yMin -= pad;
      yMax += pad;
    }

    const yBottom = d3
      .scaleLinear()
      .domain([yMin, yMax])
      .nice()
      .range([bottomInnerHeight, BOTTOM_TOP_INSET]);

    const xAxis = d3.axisBottom(xBottom).ticks(6).tickSize(0).tickPadding(10);
    const yAxis = d3
      .axisLeft(yBottom)
      .ticks(5)
      .tickSize(0)
      .tickPadding(10)
      .tickFormat(formatPnl);

    plotGroup
      .append("g")
      .attr("transform", `translate(0,${bottomInnerHeight})`)
      .call(xAxis)
      .call(axisStyle);

    plotGroup.append("g").call(yAxis).call(axisStyle);

    plotGroup
      .append("text")
      .attr("x", innerWidth / 2)
      .attr("y", bottomInnerHeight + 42)
      .attr("text-anchor", "middle")
      .attr("fill", CHART_COLORS.axisText)
      .style("font-size", "10px")
      .style("font-weight", 700)
      .text("Date (UTC)");

    plotGroup
      .append("text")
      .attr("transform", "rotate(-90)")
      .attr("x", -bottomInnerHeight / 2)
      .attr("y", -62)
      .attr("text-anchor", "middle")
      .attr("fill", CHART_COLORS.axisText)
      .style("font-size", "10px")
      .style("font-weight", 700)
      .text("Cumulative P&L ($)");

    const line = d3
      .line()
      .x((point) => xBottom(point.date))
      .y((point) => yBottom(point.value))
      .curve(d3.curveMonotoneX);

    const deltaSeries = seriesList.find((series) => series.key === "delta");
    const deltaPoints = (deltaSeries?.values || []).filter(
      (point) =>
        point?.date instanceof Date &&
        !Number.isNaN(point.date.getTime()) &&
        Number.isFinite(point.value),
    );
    const deltaGradientId = `delta-area-${Math.random().toString(36).slice(2, 9)}`;
    const deltaDefs = bottomPanelGroup.append("defs");
    const deltaGradient = deltaDefs
      .append("linearGradient")
      .attr("id", deltaGradientId)
      .attr("x1", "0%")
      .attr("x2", "0%")
      .attr("y1", "0%")
      .attr("y2", "100%");
    const deltaColor = deltaSeries?.color || CHART_COLORS.delta;
    deltaGradient
      .append("stop")
      .attr("offset", "0%")
      .attr("stop-color", deltaColor)
      .attr("stop-opacity", 0.52);
    deltaGradient
      .append("stop")
      .attr("offset", "55%")
      .attr("stop-color", deltaColor)
      .attr("stop-opacity", 0.3);
    deltaGradient
      .append("stop")
      .attr("offset", "100%")
      .attr("stop-color", deltaColor)
      .attr("stop-opacity", 0.1);

    const deltaArea = d3
      .area()
      .x((point) => xBottom(point.date))
      .y0(yBottom(0))
      .y1((point) => yBottom(point.value))
      .curve(d3.curveMonotoneX);
    if (!isHiddenSeries("delta") && deltaPoints.length > 1) {
      plotGroup
        .append("path")
        .datum(deltaPoints)
        .attr("fill", `url(#${deltaGradientId})`)
        .attr("stroke", "none")
        .attr("d", deltaArea);
    }

    const lineSeries = seriesList.map((series) => ({
      ...series,
      points: (series.values || []).filter(
        (point) =>
          point?.date instanceof Date &&
          !Number.isNaN(point.date.getTime()) &&
          Number.isFinite(point.value),
      ),
    }));

    plotGroup
      .append("g")
      .selectAll("path.greeks-line")
      .data(lineSeries)
      .join("path")
      .attr("class", "greeks-line")
      .attr("fill", "none")
      .attr("stroke", (series) => series.color)
      .attr("stroke-width", (series) => series.strokeWidth || 1)
      .attr("stroke-linecap", "round")
      .attr("stroke-linejoin", "round")
      .attr("stroke-dasharray", (series) => series.strokeDasharray)
      .attr("stroke-opacity", 0.95)
      .attr("display", (series) => (!isHiddenSeries(series.key) ? null : "none"))
      .attr("d", (series) => line(series.points));

    bottomPanelGroup
      .append("text")
      .attr("x", layout.width / 2)
      .attr("y", 24)
      .attr("text-anchor", "middle")
      .attr("fill", "#fff")
      .style("font-size", "14px")
      .style("font-weight", 600)
      .text(props.comboTitle || "Greeks P&L");

    bottomPanelGroup
      .append("text")
      .attr("x", layout.width / 2)
      .attr("y", 44)
      .attr("text-anchor", "middle")
      .attr("fill", CHART_COLORS.secondaryText)
      .style("font-size", "12px")
      .text(
        `${subtitle} | ${formatRoi(cumulative.total, comboFiltered[0]?.option_mark_price_close)}`,
      );

    const legendLineLength = 18;
    const legendLabelOffset = 6;
    const legendRowGap = 20;
    const legendColGap = 130;
    const legendCols = 3;
    const legendTextMaxWidth = 84;
    const legendItemWidth =
      legendLineLength + legendLabelOffset + legendTextMaxWidth;
    const legendTotalWidth = (legendCols - 1) * legendColGap + legendItemWidth;
    const legendX = layout.width - layout.margin.right - legendTotalWidth;
    const legendY = 24;

    const legendGroup = bottomPanelGroup
      .append("g")
      .attr("transform", `translate(${legendX},${legendY})`);

    const legendItems = legendGroup
      .selectAll("g.detail-legend-item")
      .data(seriesList)
      .join((enter) => {
        const item = enter.append("g").attr("class", "detail-legend-item");
        item.append("line").attr("stroke-linecap", "round");
        item.append("text");
        return item;
      });

    legendItems.attr("transform", (_d, i) => {
      const col = i % legendCols;
      const row = Math.floor(i / legendCols);
      return `translate(${col * legendColGap},${row * legendRowGap})`;
    });

    legendItems
      .select("line")
      .attr("x1", 0)
      .attr("y1", 0)
      .attr("x2", legendLineLength)
      .attr("y2", 0)
      .attr("stroke", (d) => d.color)
      .attr("stroke-width", (d) => d.strokeWidth || 1.1)
      .attr("stroke-dasharray", (d) => d.strokeDasharray)
      .attr("stroke-opacity", (d) => (isHiddenSeries(d.key) ? 0.28 : 1));

    legendItems
      .select("text")
      .attr("x", legendLineLength + legendLabelOffset)
      .attr("y", 3)
      .attr("fill", CHART_COLORS.secondaryText)
      .style("font-size", "11px")
      .style("font-family", SVG_FONT_FAMILY)
      .style("font-weight", 500)
      .text((d) => d.label)
      .attr("fill-opacity", (d) => (isHiddenSeries(d.key) ? 0.45 : 1));

    legendItems
      .attr("role", "button")
      .style("cursor", "pointer")
      .attr("opacity", (d) => (isHiddenSeries(d.key) ? 0.6 : 1))
      .on("click", (event, d) => {
        event.stopPropagation();
        toggleDetailSeries(d.key);
      });
  };

  const brush = d3
    .brushX()
    .extent([
      [0, 0],
      [innerWidth, topInnerHeight],
    ])
    .filter((event) => !event.ctrlKey && !event.button && event.detail < 2)
    .on("brush", (event) => {
      if (!event.selection) {
        drawBottom(null);
        emitTimeAnchorIfChanged(index, null, false);
        return;
      }
      const [from, to] = event.selection.map(xTop.invert);
      const domain = from <= to ? [from, to] : [to, from];
      drawBottom(domain);
      emitTimeAnchorIfChanged(index, domain, false);
    })
    .on("end", (event) => {
      if (!event.selection) {
        brushedDomain = null;
        drawBottom(null);
        emitTimeAnchorIfChanged(index, null, true);
        return;
      }
      const [from, to] = event.selection.map(xTop.invert);
      brushedDomain = from <= to ? [from, to] : [to, from];
      drawBottom(brushedDomain);
      emitTimeAnchorIfChanged(index, brushedDomain, true);
    });

  const brushGroup = topGroup.append("g").attr("class", "brush");
  brushGroup.call(brush);
  brushGroup.selectAll(".selection").attr("fill-opacity", 0.2);

  if (Array.isArray(brushedDomain) && brushedDomain.length === 2) {
    brushGroup.call(brush.move, [
      xTop(brushedDomain[0]),
      xTop(brushedDomain[1]),
    ]);
  }

  drawBottom(brushedDomain);
  emitTimeAnchorIfChanged(index, brushedDomain, true);
  drawResolutionControl(svg);
};

watch(
  () => [
    props.indexData,
    props.comboData,
    props.deltaHedgeEnabled,
    props.optionInstrumentName,
    props.comboTitle,
    props.subtitle,
    props.loading,
    props.resolutionKey,
    props.resolutionOptions,
    props.showHigherOrderGreeks,
    props.greekEvolutionData,
  ],
  () => {
    render();
  },
  { deep: true },
);

onMounted(() => {
  render();
});
</script>

<template>
  <div class="chartContainer">
    <svg ref="svgRef" class="chartSvg" />
  </div>
</template>

<style scoped>
.chartContainer {
  width: 100%;
  margin: 0;
  border: 0;
  background: transparent;
  overflow: visible;
  position: relative;
}

.chartSvg {
  width: 100%;
  height: auto;
  display: block;
  background: #000;
}
</style>
