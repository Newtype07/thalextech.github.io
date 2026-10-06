<script setup>
import * as d3 from "d3";
import { computed, onMounted, ref, watch } from "vue";
import { exportChartToPng } from "../../../../lib/export-png.js";
import { buildBreakEvenSnapshot, calcOptionNd2 } from "../lib/breakEvenSnapshot.js";
import IndexBreakEvenChart from "../../../../lib/components/IndexBreakEvenChart.vue";

import { buildTrackProbabilityHistory, nearestTrack } from "../lib/trackSelection.js";

const props = defineProps({
  tracks: { type: Array, default: () => [] },
  indexData: { type: Array, default: () => [] },
  indexProjectedData: { type: Array, default: () => [] },
  spotPrice: { type: Number, default: null },
  spotTs: { type: Number, default: null },
  expiryTs: { type: Number, default: null },
  currentTs: { type: Number, default: null },
  title: { type: String, default: "BTC Option Break-Even Forecast" },
  subtitle: { type: String, default: "" },
  loading: { type: Boolean, default: false },
  selectedInstrument: { type: String, default: null },
  selectedOption: { type: Object, default: null },
  detailView: { type: String, default: "break-even" },
});

const emit = defineEmits(["update:selectedInstrument", "update:detailView"]);
const svgRef = ref(null);
const selectedInstrument = computed({
  get: () => props.selectedInstrument,
  set: value => emit("update:selectedInstrument", value),
});
const detailView = computed({
  get: () => props.detailView,
  set: value => emit("update:detailView", value),
});
const priceChartRef = ref(null);
const selectedTrack = computed(() => props.tracks.find(track => track.instrumentName === selectedInstrument.value));
const selectedLabel = computed(() => {
  const strike = selectedTrack.value?.strike ?? props.selectedOption?.strike;
  const type = selectedTrack.value?.optionType ?? props.selectedOption?.option_type_normalized;
  return Number.isFinite(strike) ? `${type === "put" ? "Put" : "Call"} ${formatPrice(strike)}` : "";
});
const clearSelection = () => { selectedInstrument.value = null; };

const layout = {
  width: 1800,
  height: 920,
  margin: { top: 96, right: 390, bottom: 82, left: 84 },
};

const formatPrice = d3.format(",.0f");
const formatProb = d3.format(".1%");
const selectedWinProbability = computed(() => {
  const track = selectedTrack.value;
  if (!track) return null;
  return calcOptionNd2({
    optionType: track.optionType,
    spot: props.spotPrice,
    strike: track.currentBreakEven,
    iv: track.referenceIv,
    tauSeconds: props.expiryTs - props.spotTs,
  });
});
const selectedSubtitle = computed(() => {
  const track = selectedTrack.value;
  if (!track) return props.subtitle;
  const probabilityAboveStrike = calcOptionNd2({
    optionType: "call",
    spot: props.spotPrice,
    strike: track.strike,
    iv: track.referenceIv,
    tauSeconds: props.expiryTs - props.spotTs,
  });
  const expiry = Number.isFinite(props.expiryTs)
    ? new Date(props.expiryTs * 1000).toISOString().slice(0, 10) : "n/a";
  const probability = Number.isFinite(probabilityAboveStrike) ? formatProb(probabilityAboveStrike) : "n/a";
  return `Expiry ${expiry} · Current probability of expiring above the strike (N(d2)): ${probability}`;
});
const RULER_LABEL_VERTICAL_OFFSET = 8;
const NOW_LABEL_BASELINE_OFFSET = 4;
const NOW_LABEL_MIN_SPACING = 15;
const NOW_LABEL_LEADER_THRESHOLD = 3;
const Y_AXIS_LABEL_PADDING = 72;

const axisStyle = (axisG) => {
  axisG.selectAll("line").remove();
  axisG.selectAll("path").remove();
  axisG
    .selectAll("text")
    .attr("fill", "#c0c0c0")
    .style("font-size", "14px")
    .style("font-family", "ui-sans-serif, system-ui");
};

const getTrackColor = (optionType, index, total) => {
  if (optionType === "call") {
    const scale = d3
      .scaleLinear()
      .domain([0, Math.max(1, total - 1)])
      .range(["#34ffb4", "#00a85d"]);
    return scale(index);
  }

  const scale = d3
    .scaleLinear()
    .domain([0, Math.max(1, total - 1)])
    .range(["#ff5e8c", "#bf0033"]);
  return scale(index);
};

const getSnapshotRowText = (row) => {
  const nd2Text = Number.isFinite(row.nd2) ? formatProb(row.nd2) : "n/a";
  return `${row.optionType === "call" ? "C" : "P"} ${formatPrice(row.strike)} ${row.nd2Label}=${nd2Text} BE=${formatPrice(row.breakEven)}`;
};

const getSnapshotLabels = ({ snapshot, y }) => {
  const labels = [];
  for (const row of snapshot.rows) {
    const labelY = y(row.breakEven);
    if (!Number.isFinite(labelY)) continue;
    labels.push({
      id: row.id,
      text: getSnapshotRowText(row),
      color: "#ffffff",
      rawY: labelY - RULER_LABEL_VERTICAL_OFFSET,
    });
  }
  if (Number.isFinite(snapshot.spot)) {
    labels.push({
      id: "spot",
      text: `Spot ${formatPrice(snapshot.spot)}`,
      color: "#ffffff",
      rawY: y(snapshot.spot) - RULER_LABEL_VERTICAL_OFFSET,
    });
  }
  return labels;
};

// Two-pass push-apart so right-side labels don't overlap when break-evens cluster.
// Mutates each item by setting `.y` to a de-collided baseline.
const deCollideLabels = (items, minY, maxY, spacing) => {
  if (!items.length) return;
  const sorted = [...items].sort((a, b) => a.targetY - b.targetY);
  let prev = minY - spacing;
  for (const item of sorted) {
    item.y = Math.max(item.targetY, prev + spacing);
    prev = item.y;
  }
  let next = maxY + spacing;
  for (let i = sorted.length - 1; i >= 0; i--) {
    sorted[i].y = Math.min(sorted[i].y, next - spacing);
    next = sorted[i].y;
  }
};

function exportPng({ filename = "break-even.png", scale = 4, padding = 24 } = {}) {
  if (selectedTrack.value && detailView.value === "break-even") {
    priceChartRef.value?.exportPng({ filename, scale, padding });
    return;
  }
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

  const svg = d3.select(svgEl);
  svg.selectAll("*").remove();

  const { width, height } = layout;
  const margin = selectedTrack.value ? { ...layout.margin, left: 140, right: 140 } : layout.margin;
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;

  svg.attr("viewBox", `0 0 ${width} ${height}`);
  svg.attr("preserveAspectRatio", "xMidYMid meet");

  svg
    .append("rect")
    .attr("width", width)
    .attr("height", height)
    .attr("fill", "black");

  svg
    .append("text")
    .attr("x", width / 2)
    .attr("y", 36)
    .attr("text-anchor", "middle")
    .attr("fill", "white")
    .style("font-size", "22px")
    .style("font-weight", 650)
    .style("font-family", "ui-sans-serif, system-ui")
    .text(selectedTrack.value ? `${selectedLabel.value} · Probability and Index History` : props.title);

  if (props.subtitle) {
    svg
      .append("text")
      .attr("x", width / 2)
      .attr("y", 62)
      .attr("text-anchor", "middle")
      .attr("fill", "#a0a0a0")
      .style("font-size", "18px")
      .style("font-family", "ui-sans-serif, system-ui")
      .text(selectedTrack.value ? selectedSubtitle.value : props.subtitle);
  }

  const rawTracks = Array.isArray(props.tracks) ? props.tracks : [];
  const indexActual = (props.indexData || []).filter(
    (point) => point?.date instanceof Date && Number.isFinite(point?.value),
  );
  const indexProjected = (props.indexProjectedData || []).filter(
    (point) => point?.date instanceof Date && Number.isFinite(point?.value),
  );
  const indexCurvePoints = [...indexActual, ...indexProjected]
    .filter((point) => point?.date instanceof Date && Number.isFinite(point?.value))
    .sort((a, b) => a.date - b.date)
    .filter((point, index, points) => {
      if (index === 0) return true;
      return point.date.getTime() !== points[index - 1].date.getTime();
    });
  const callTracks = rawTracks.filter((track) => track.optionType === "call");
  const putTracks = rawTracks.filter((track) => track.optionType === "put");

  const tracks = [
    ...callTracks.map((track, index) => ({
      ...track,
      color: getTrackColor("call", index, callTracks.length),
    })),
    ...putTracks.map((track, index) => ({
      ...track,
      color: getTrackColor("put", index, putTracks.length),
    })),
  ].map((track) => ({
    ...track,
    points: (track.points || []).filter(
      (point) => point?.date instanceof Date && Number.isFinite(point?.breakEven),
    ),
  }));

  const selected = tracks.find(track => track.instrumentName === selectedInstrument.value);
  const probabilityLabel = selected?.optionType === "put" ? "N(-d2)" : "N(d2)";
  const probabilityColor = "#f5f5f7";
  const probabilityHistory = buildTrackProbabilityHistory(selected, indexActual, props.expiryTs);
  if (selected && !probabilityHistory.length) {
    svg.append("text").attr("x", width / 2).attr("y", height / 2)
      .attr("text-anchor", "middle").attr("fill", "#aaa")
      .text("No matching historical IV and index marks available for this selection.");
    return;
  }

  const allPoints = tracks.flatMap((track) =>
    track.points.map((point) => ({
      ...point,
      optionType: track.optionType,
      strike: track.strike,
      instrumentName: track.instrumentName,
      color: track.color,
    })),
  );

  if (!allPoints.length && !indexActual.length) {
    svg
      .append("text")
      .attr("x", width / 2)
      .attr("y", height / 2)
      .attr("text-anchor", "middle")
      .attr("fill", "#c9c9cf")
      .style("font-size", "14px")
      .style("font-family", "ui-sans-serif, system-ui")
      .text(props.loading ? "Loading..." : "No break-even projections available.");
    return;
  }

  const spotDate = Number.isFinite(props.spotTs)
    ? new Date(props.spotTs * 1000)
    : null;
  const expiryDate = Number.isFinite(props.expiryTs)
    ? new Date(props.expiryTs * 1000)
    : null;

  const minPointDate = allPoints.length
    ? d3.min(allPoints, (point) => point.date)
    : null;
  const maxPointDate = allPoints.length
    ? d3.max(allPoints, (point) => point.date)
    : null;
  const minIndexDate = indexActual.length
    ? d3.min(indexActual, (point) => point.date)
    : null;
  const maxIndexDate = indexActual.length
    ? d3.max(indexActual, (point) => point.date)
    : null;
  const maxProjectedDate = indexProjected.length
    ? d3.max(indexProjected, (point) => point.date)
    : null;

  const domainStartCandidates = [minPointDate, minIndexDate, spotDate].filter(
    (value) => value instanceof Date,
  );
  const domainEndCandidates = [maxPointDate, maxIndexDate, maxProjectedDate, expiryDate].filter(
    (value) => value instanceof Date,
  );

  let domainStart = d3.min(domainStartCandidates);
  let domainEnd = d3.max(domainEndCandidates);
  if (!(domainStart instanceof Date) || !(domainEnd instanceof Date)) {
    domainStart = minPointDate || minIndexDate;
    domainEnd = maxPointDate || maxIndexDate || maxProjectedDate;
  }

  if (!(domainStart instanceof Date) || !(domainEnd instanceof Date)) return;

  if (selected) {
    [domainStart, domainEnd] = d3.extent(probabilityHistory, point => point.date);
  }

  if (+domainStart === +domainEnd) {
    // Center a lone observation using the loaded history's sampling interval.
    const interval = selected
      ? d3.min(d3.pairs(indexActual, (a, b) => +b.date - +a.date).filter(value => value > 0))
      : null;
    const padding = (interval ?? 60 * 60 * 1000) / 2;
    if (selected) domainStart = new Date(+domainStart - padding);
    domainEnd = new Date(+domainEnd + (selected ? padding : padding * 2));
  }

  const visibleIndex = selected
    ? indexActual.filter(point => point.date >= domainStart && point.date <= domainEnd)
    : indexActual;
  const yValues = selected ? [] : allPoints.map((point) => point.breakEven);
  for (const point of visibleIndex) {
    yValues.push(point.value);
  }
  for (const point of selected ? [] : indexProjected) {
    yValues.push(point.value);
  }
  if (!selected && Number.isFinite(props.spotPrice)) {
    yValues.push(props.spotPrice);
  }

  const minValue = d3.min(yValues) ?? 0;
  const maxValue = d3.max(yValues) ?? 1;
  const range = Math.max(maxValue - minValue, Math.abs(maxValue) * 0.02, 1);
  const domainMin = minValue - range * 0.08;
  const domainMax = maxValue + range * 0.08;

  const x = d3.scaleUtc().domain([domainStart, domainEnd]).range([0, innerWidth]);
  const y = d3
    .scaleLinear()
    .domain([domainMin, domainMax])
    .nice()
    .range([innerHeight, 0]);

  const g = svg
    .append("g")
    .attr("transform", `translate(${margin.left},${margin.top})`);

  const timeAxis = d3.axisBottom(x).ticks(10).tickSize(0).tickPadding(15);
  if (selected) {
    const ticks = x.ticks(10);
    const tickInterval = ticks.length > 1 ? +ticks[1] - +ticks[0] : +domainEnd - +domainStart;
    timeAxis.tickFormat(d3.utcFormat(tickInterval < 60 * 1000
      ? "%b %d %H:%M:%S"
      : tickInterval < 24 * 60 * 60 * 1000 ? "%b %d %H:%M" : "%b %d"));
  }

  g.append("g")
    .attr("transform", `translate(0,${innerHeight})`)
    .call(timeAxis)
    .call(axisStyle);

  g.append("g")
    .attr("transform", selected ? `translate(${innerWidth + 14},0)` : null)
    .call(
      (selected ? d3.axisRight(y) : d3.axisLeft(y)).ticks(6).tickSize(0).tickPadding(15).tickFormat(d3.format(",.0f")),
    )
    .call(axisStyle);

  g.append("text")
    .attr("x", innerWidth / 2)
    .attr("y", innerHeight + 58)
    .attr("text-anchor", "middle")
    .attr("fill", "#a0a0a0")
    .style("font-size", "13px")
    .style("font-family", "ui-sans-serif, system-ui")
    .text("Date (UTC)");

  g.append("text")
    .attr("transform", "rotate(-90)")
    .attr("x", -innerHeight / 2)
    .attr("y", -Y_AXIS_LABEL_PADDING)
    .attr("text-anchor", "middle")
    .attr("fill", "#a0a0a0")
    .style("font-size", "13px")
    .style("font-family", "ui-sans-serif, system-ui")
    .text(selected ? probabilityLabel : "Break-even level");

  const indexLine = d3
    .line()
    .x((point) => x(point.date))
    .y((point) => y(point.value))
    .curve(d3.curveBasis);

  if (selected) {
    const [minProbability, maxProbability] = d3.extent(probabilityHistory, point => point.probability);
    const probabilitySpan = maxProbability - minProbability;
    const probabilityPadding = probabilitySpan > 0
      ? probabilitySpan * 0.1
      : Math.max(Math.abs(maxProbability) * 0.01, 1e-12);
    const probabilityDomain = Number.isFinite(minProbability)
      ? [Math.max(0, minProbability - probabilityPadding), Math.min(1, maxProbability + probabilityPadding)]
      : [0, 1];
    const probabilityY = d3.scaleLinear().domain(probabilityDomain).nice(5).range([innerHeight, 0]);
    probabilityY.domain(probabilityY.domain().map(value => Math.max(0, Math.min(1, value))));
    const latestProbability = probabilityHistory[probabilityHistory.length - 1].probability;
    const latestProbabilityY = probabilityY(latestProbability);
    g.append("line")
      .attr("class", "latestProbabilityLevel")
      .attr("x1", 0).attr("x2", innerWidth)
      .attr("y1", latestProbabilityY).attr("y2", latestProbabilityY)
      .attr("stroke", probabilityColor).attr("stroke-width", 1)
      .attr("opacity", 0.6).attr("pointer-events", "none");
    g.append("g")
      .call(d3.axisLeft(probabilityY).ticks(5).tickSize(0).tickPadding(12).tickFormat(probabilityY.tickFormat(5, "%")))
      .call(axisStyle);
    g.append("text").attr("transform", `translate(${innerWidth + 100},${innerHeight / 2}) rotate(90)`)
      .attr("text-anchor", "middle").attr("fill", "#c0c0c0").style("font-size", "15px")
      .text("Index price (USD)");
    const historicalIndexLine = d3.line()
      .x(point => x(point.date))
      .y(point => y(point.value))
      .curve(d3.curveBasis);
    g.append("path").datum(visibleIndex)
      .attr("class", "historicalIndexLine").attr("fill", "none")
      .attr("stroke", "#858b94").attr("stroke-width", 3.6)
      .attr("stroke-linecap", "round").attr("stroke-linejoin", "round")
      .attr("pointer-events", "none").attr("d", historicalIndexLine);
    if (visibleIndex.length === 1) {
      const point = visibleIndex[0];
      g.append("circle").attr("cx", x(point.date)).attr("cy", y(point.value))
        .attr("r", 3).attr("fill", "#858b94");
    }
    const probabilityLine = d3.line()
      .x(point => x(point.date))
      .y(point => probabilityY(point.probability))
      .curve(d3.curveBasis);
    g.append("path").datum(probabilityHistory)
      .attr("class", "probabilityLine").attr("fill", "none")
      .attr("stroke", probabilityColor).attr("stroke-width", 3.6)
      .attr("stroke-linecap", "round").attr("stroke-linejoin", "round")
      .attr("d", probabilityLine);
    if (probabilityHistory.length === 1) {
      const point = probabilityHistory[0];
      g.append("circle").attr("cx", x(point.date)).attr("cy", probabilityY(point.probability))
        .attr("r", 3).attr("fill", probabilityColor);
    }
    g.append("text")
      .attr("class", "latestProbabilityLabel")
      .attr("x", innerWidth - 8).attr("y", latestProbabilityY - 10)
      .attr("text-anchor", "end").attr("fill", probabilityColor)
      .attr("paint-order", "stroke").attr("stroke", "#000").attr("stroke-width", 4)
      .attr("pointer-events", "none")
      .style("font-size", "16px").style("font-family", "ui-sans-serif, system-ui")
      .text(`Latest ${probabilityLabel} = ${formatProb(latestProbability)}`);
    svg.append("text").attr("x", width / 2).attr("y", 84).attr("text-anchor", "middle")
      .attr("fill", "#a0a0a0").style("font-size", "18px")
      .style("font-family", "ui-sans-serif, system-ui")
      .text(`${selectedLabel.value} · ${probabilityHistory.length ? `${probabilityLabel} white line (auto-scaled left axis) · Index grey line (right axis) · Historical marks only` : "No matching historical IV and index marks"}`);
    return;
  }

  if (!selected && indexActual.length >= 2) {
    g.append("path")
      .datum(indexActual)
      .attr("fill", "none")
      .attr("stroke", "mistyrose")
      .attr("stroke-width", 3)
      .attr("opacity", 0.95)
      .attr("d", indexLine);
  }

  if (indexProjected.length >= 2) {
    g.append("path")
      .datum(indexProjected)
      .attr("fill", "none")
      .attr("stroke", "#ffffff")
      .attr("stroke-width", 2)
      .attr("stroke-dasharray", "6,4")
      .attr("opacity", 0.9)
      .attr("d", indexLine);
  }

  const breakEvenLine = d3
    .line()
    .x((point) => x(point.date))
    .y((point) => y(point.breakEven))
    .curve(d3.curveLinear);
  const trackPaths = [];
  for (const track of tracks) {
    if (!Array.isArray(track.points) || track.points.length < 2) continue;
    const path = g.append("path")
      .attr("class", "selectableTrack")
      .attr("tabindex", 0).attr("role", "button")
      .attr("aria-label", `Select ${track.optionType} ${formatPrice(track.strike)} break-even price history`)
      .attr("aria-pressed", track.instrumentName === selectedInstrument.value)
      .datum(track.points)
      .attr("fill", "none")
      .attr("stroke", track.color)
      .attr("stroke-width", 2.6)
      .attr("opacity", 0.95)
      .attr("d", breakEvenLine);
    path.on("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectedInstrument.value = selectedInstrument.value === track.instrumentName ? null : track.instrumentName;
      } else if (event.key === "Escape") clearSelection();
    });
    trackPaths.push({ track, path });
  }
  const highlight = id => {
    for (const { track, path } of trackPaths) {
      const active = track.instrumentName === id;
      const chosen = track.instrumentName === selectedInstrument.value;
      path.attr("stroke-width", active ? 5 : chosen ? 3.8 : 2.6)
        .attr("opacity", active || chosen ? 1 : id || selected ? 0.18 : 0.95)
        .style("filter", active ? `drop-shadow(0 0 5px ${track.color})` : null);
    }
  };
  highlight(null);
  for (const { track, path } of trackPaths) {
    path.on("focus", () => highlight(track.instrumentName)).on("blur", () => highlight(null));
  }

  if (!selected && Number.isFinite(props.currentTs)) {
    const nowSnapshot = buildBreakEvenSnapshot({
      tracks,
      indexCurvePoints,
      targetDate: new Date(props.currentTs * 1000),
      expiryTs: props.expiryTs,
      spotPrice: props.spotPrice,
    });
    const nowLabels = getSnapshotLabels({ snapshot: nowSnapshot, y }).map((label) => {
      const anchorY = label.rawY + RULER_LABEL_VERTICAL_OFFSET;
      return {
        ...label,
        anchorY,
        targetY: anchorY + NOW_LABEL_BASELINE_OFFSET,
      };
    });
    deCollideLabels(nowLabels, 14, innerHeight - 6, NOW_LABEL_MIN_SPACING);
    const nowLabelX = innerWidth + 14;

    const displacedLabels = nowLabels.filter(
      (label) => Math.abs(label.y - label.targetY) > NOW_LABEL_LEADER_THRESHOLD,
    );

    g.append("g")
      .attr("class", "nowLabelLeaders")
      .selectAll("line.nowLabelLeader")
      .data(displacedLabels, (label) => label.id)
      .join("line")
      .attr("class", "nowLabelLeader")
      .attr("x1", innerWidth + 2)
      .attr("x2", nowLabelX - 3)
      .attr("y1", (label) => label.anchorY)
      .attr("y2", (label) => label.y - NOW_LABEL_BASELINE_OFFSET)
      .attr("stroke", (label) => label.color)
      .attr("stroke-width", 0.75)
      .attr("opacity", 0.55);

    g.append("g")
      .attr("class", "nowLabels")
      .selectAll("text.nowLabel")
      .data(nowLabels, (label) => label.id)
      .join("text")
      .attr("class", "nowLabel")
      .attr("x", nowLabelX)
      .attr("y", (label) => label.y)
      .attr("text-anchor", "start")
      .attr("fill", (label) => label.color)
      .style("font-size", "13px")
      .style("font-weight", 400)
      .style("font-family", "ui-sans-serif, system-ui")
      .attr("paint-order", "stroke")
      .attr("stroke", "#000")
      .attr("stroke-width", 3)
      .text((label) => label.text);
  }

  const legend = g.append("g").attr("transform", "translate(8,8)");
  legend
    .append("line")
    .attr("x1", 0)
    .attr("x2", 26)
    .attr("y1", 0)
    .attr("y2", 0)
    .attr("stroke", "#7dffbe")
    .attr("stroke-width", 2);
  legend
    .append("text")
    .attr("x", 34)
    .attr("y", 4)
    .attr("fill", "#a8f6c9")
    .style("font-size", "13px")
    .style("font-family", "ui-sans-serif, system-ui")
    .text(`Call break-even lines (${callTracks.length})`);

  legend
    .append("line")
    .attr("x1", 0)
    .attr("x2", 26)
    .attr("y1", 24)
    .attr("y2", 24)
    .attr("stroke", "#ff8fa3")
    .attr("stroke-width", 2);
  legend
    .append("text")
    .attr("x", 34)
    .attr("y", 28)
    .attr("fill", "#ffc0cb")
    .style("font-size", "13px")
    .style("font-family", "ui-sans-serif, system-ui")
    .text(`Put break-even lines (${putTracks.length})`);

  legend
    .append("line")
    .attr("x1", 0)
    .attr("x2", 26)
    .attr("y1", 48)
    .attr("y2", 48)
    .attr("stroke", "#ffffff")
    .attr("stroke-width", 2);
  legend
    .append("text")
    .attr("x", 34)
    .attr("y", 52)
    .attr("fill", "#b9b9c1")
    .style("font-size", "12px")
    .style("font-family", "ui-sans-serif, system-ui")
    .text("Break-even paths are line projections");

  const hitTracks = trackPaths.map(({ track }) => ({
    id: track.instrumentName, points: track.points.map(point => [x(point.date), y(point.breakEven)]),
  }));
  const hitPlane = g.append("rect").attr("width", innerWidth).attr("height", innerHeight)
    .attr("fill", "transparent").attr("class", "trackHitPlane");
  const hoverLabel = g.append("text").attr("pointer-events", "none").attr("fill", "white")
    .attr("paint-order", "stroke").attr("stroke", "#000").attr("stroke-width", 4)
    .style("font-size", "14px").style("font-family", "ui-sans-serif, system-ui");
  const hit = event => {
    const [px, py] = d3.pointer(event, g.node());
    const scale = svgEl.getBoundingClientRect().width / width || 1;
    return { px, py, id: nearestTrack(hitTracks, px, py, 10 / scale) };
  };
  hitPlane.on("pointermove", event => {
    const { px, py, id } = hit(event);
    highlight(id);
    hitPlane.style("cursor", id ? "pointer" : "default");
    const track = tracks.find(track => track.instrumentName === id);
    hoverLabel.attr("x", Math.min(px + 14, innerWidth - 240)).attr("y", Math.max(18, py - 14))
      .text(track ? `${track.optionType === "put" ? "Put" : "Call"} ${formatPrice(track.strike)} · Click to ${id === selectedInstrument.value ? "clear" : "select"}` : "");
  }).on("pointerleave", () => { highlight(null); hoverLabel.text(""); })
    .on("click", event => {
      const { id } = hit(event);
      if (id) selectedInstrument.value = id === selectedInstrument.value ? null : id;
    });
}

watch(
  () => [
    props.tracks,
    props.indexData,
    props.indexProjectedData,
    props.spotPrice,
    props.spotTs,
    props.expiryTs,
    props.currentTs,
    props.title,
    props.subtitle,
    props.loading,
    selectedInstrument.value,
    detailView.value,
  ],
  () => render(),
  { deep: true },
);

onMounted(() => render());
</script>

<template>
  <div class="chartWrap" @keydown.esc="clearSelection">
    <div class="selectionToolbar">
      <div v-if="selectedInstrument" class="detailToggle" role="group" aria-label="Instrument chart view">
        <button type="button" :aria-pressed="detailView === 'break-even'" @click="detailView = 'break-even'">Break-even price</button>
        <button type="button" :aria-pressed="detailView === 'probability'" @click="detailView = 'probability'">Probability</button>
      </div>
      <span>{{ selectedInstrument ? `${selectedLabel} selected` : 'Hover near a line and click to explore its break-even price history.' }}</span>
      <button v-if="selectedInstrument" class="backButton" type="button" @click="clearSelection">← Back to break-even prices</button>
    </div>
    <IndexBreakEvenChart
      v-if="selectedTrack && detailView === 'break-even'"
      ref="priceChartRef"
      :actual-data="indexData"
      :projected-data="indexProjectedData"
      :break-even-low="selectedTrack.optionType === 'put' ? selectedTrack.currentBreakEven : null"
      :break-even-high="selectedTrack.optionType === 'call' ? selectedTrack.currentBreakEven : null"
      break-even-low-label="BE"
      break-even-high-label="BE"
      :break-even-label-color="selectedTrack.optionType === 'put' ? '#f87171' : '#4ade80'"
      :break-even-win-probability="selectedWinProbability"
      :break-even-stroke-width="4"
      :index-stroke-width="2"
      :index-curve="d3.curveNatural"
      :current-index="spotPrice"
      :expiry-ts="expiryTs"
      :title="`${selectedLabel} · Break-Even and Index History`"
      :subtitle="selectedSubtitle"
      :loading="loading"
    />
    <div v-if="selectedInstrument && !selectedTrack" class="selectionEmpty" role="status">{{ loading ? 'Loading selected instrument history…' : 'No history available for this strike and maturity.' }}</div>
    <svg v-show="!selectedInstrument || (selectedTrack && detailView === 'probability')" ref="svgRef" class="chartSvg" />
    <div v-if="loading" class="overlay">Loading...</div>
  </div>
</template>

<style scoped>
.selectionToolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 14px; min-height: 36px; padding: 8px 16px; color: #aaa; font-size: 12px; }
.selectionToolbar button { padding: 6px 12px; font: inherit; cursor: pointer; }
.selectionToolbar button:focus-visible { outline: 2px solid #aab8cc; outline-offset: 3px; }
.detailToggle { display: flex; gap: 3px; padding: 3px; border: 1px solid #414751; border-radius: 8px; background: #15181d; }
.detailToggle button { border: 0; border-radius: 5px; background: transparent; color: #a9b0ba; }
.detailToggle button:hover { color: white; }
.detailToggle button[aria-pressed="true"] { background: #edf0f4; color: #15181d; font-weight: 600; }
.selectionToolbar .backButton { margin-left: auto; border: 1px solid #414751; border-radius: 5px; background: transparent; color: #c2c7cf; }
.selectionToolbar .backButton:hover { background: #20252c; color: white; }
.selectionEmpty { min-height: 320px; display: grid; place-items: center; color: #aaa; font-size: 14px; }
.chartWrap {
  position: relative;
  border-radius: 14px;
  overflow: hidden;
  background: #000;
}

.chartSvg {
  display: block;
  width: 100%;
  height: auto;
}

.overlay {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: #fff;
  background: color-mix(in oklab, #000, transparent 40%);
  font-size: 14px;
}
</style>
