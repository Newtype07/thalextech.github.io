<script setup>
import * as d3 from "d3";
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { exportTitledChart } from "../lib/exportTitledChart.js";
import {
  cancelFairValueRun,
  runFairValueInWorker,
} from "../lib/fairValueWorkerClient.js";

const props = defineProps({
  rows: { type: Array, default: () => [] },
  hedgeEnabled: { type: Boolean, default: true },
  underlying: { type: String, default: "BTC" },
});

const SCENARIO_OPTIONS = [250, 500, 1_000, 2_000, 5_000];
const JUMP_THRESHOLD_OPTIONS = [3, 3.5, 4, 4.5, 5];
const chartRef = ref(null);
const weeklyForecastChartRef = ref(null);
const result = ref(null);
const running = ref(false);
const progress = ref(0);
const error = ref("");
const viewMode = defineModel("viewMode", { type: String, default: "time" });
const scenarioCount = ref(1_000);
const jumpThreshold = ref(4);
let resizeObserver;
let runSequence = 0;

const modeResult = computed(() => result.value);
const completedWeekCount = computed(() =>
  (modeResult.value?.cohorts || []).reduce((total, cohort) => total + cohort.weekCount, 0),
);
const displayedGroups = computed(() => {
  const groups = (
    modeResult.value?.views?.[viewMode.value] ||
    modeResult.value?.cohorts ||
    []
  ).map((group) => ({
    ...group,
    label: String(group.label || "").replaceAll("BTC", props.underlying),
  }));
  return [
    ...groups,
    {
      kind: "weekly-outcomes",
      label: viewMode.value === "time"
        ? "Actual weekly PnL over time"
        : viewMode.value === "iv"
          ? "Actual weekly PnL by entry IV z-score"
          : `Actual weekly PnL by observed ${props.underlying} move`,
      weeklyOutcomes: modeResult.value?.weeklyOutcomes || [],
    },
  ];
});
const hedgeModeLabel = computed(() => {
  if (props.rows.some(row => row.structure === "covered_call")) return "Covered call during call periods only; excludes uncovered holding gaps";
  const mode = modeResult.value?.hedgeMode
    || modeResult.value?.defaultHedgeMode
    || (props.hedgeEnabled ? "dynamic" : "unhedged");
  return mode === "dynamic" ? "Dynamic hedge" : "Unhedged option PnL";
});
const scenarioStatus = computed(() => {
  const completed = Number(modeResult.value?.simulations) || 0;
  const model = modeResult.value?.calibration ? "Calibrated Bates" : "Conditional GBM";
  return `${completed.toLocaleString()} scenarios · ${model} · equal drift mix −100% / 0% / +100% · ${hedgeModeLabel.value}`;
});
const realizedVolSensitivity = computed(() =>
  modeResult.value?.realizedVolSensitivity || []);
const selectedForecastSensitivity = computed(() =>
  realizedVolSensitivity.value.find((row) =>
    Number(row.threshold) === Number(jumpThreshold.value)));
const weeklyForecastRows = computed(() =>
  (selectedForecastSensitivity.value?.weekly || []).map((row) => ({
    cycle: row.cycle,
    entryDate: new Date(Number(row.entryTs) * 1000),
    regime: row.regime,
    totalVol: row.medianVol,
    p10Vol: row.p10Vol,
    p90Vol: row.p90Vol,
    expectedVol: row.expectedVol,
    diffusiveVol: row.diffusiveForecastVol,
    jumpVol: row.jumpForecastVol,
  })));

const drawWeeklyForecastChart = () => {
  const element = weeklyForecastChartRef.value;
  const rows = weeklyForecastRows.value;
  if (!element || !rows.length) return;
  element.innerHTML = "";
  const width = Math.max(620, element.getBoundingClientRect().width || 620);
  const height = 210;
  const margin = { top: 24, right: 18, bottom: 30, left: 44 };
  const dates = rows.map((row) => row.entryDate);
  const typicalStep = d3.median(d3.pairs(dates), ([first, second]) => second - first)
    || 7 * 86_400_000;
  const x = d3.scaleUtc()
    .domain([
      new Date(dates[0].getTime() - typicalStep / 2),
      new Date(dates.at(-1).getTime() + typicalStep / 2),
    ])
    .range([margin.left, width - margin.right]);
  const y = d3.scaleLinear()
    .domain([0, d3.max(rows, (row) => Math.max(
      row.totalVol,
      row.p90Vol,
      row.expectedVol,
      row.diffusiveVol,
      row.jumpVol,
    )) * 1.08])
    .nice()
    .range([height - margin.bottom, margin.top]);
  const svg = d3.select(element).append("svg")
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("width", "100%")
    .attr("height", height)
    .attr("role", "img")
    .attr("aria-label", "Weekly forecast volatility split between diffusion and jumps, with volatility-regime bands");
  const regimeColor = {
    low: "rgba(96,165,250,.10)",
    medium: "rgba(167,139,250,.10)",
    high: "rgba(251,113,133,.10)",
  };
  rows.forEach((row, index) => {
    const left = index
      ? (rows[index - 1].entryDate.getTime() + row.entryDate.getTime()) / 2
      : row.entryDate.getTime() - typicalStep / 2;
    const right = index < rows.length - 1
      ? (row.entryDate.getTime() + rows[index + 1].entryDate.getTime()) / 2
      : row.entryDate.getTime() + typicalStep / 2;
    svg.append("rect")
      .attr("x", x(new Date(left)))
      .attr("y", margin.top)
      .attr("width", Math.max(0, x(new Date(right)) - x(new Date(left))))
      .attr("height", height - margin.top - margin.bottom)
      .attr("fill", regimeColor[row.regime] || regimeColor.medium);
  });
  const line = (selector) => d3.line()
    .x((row) => x(row.entryDate))
    .y((row) => y(selector(row)));
  svg.append("path")
    .datum(rows)
    .attr("fill", "rgba(226,232,240,.09)")
    .attr("d", d3.area()
      .x((row) => x(row.entryDate))
      .y0((row) => y(row.p10Vol))
      .y1((row) => y(row.p90Vol)));
  [
    { key: "totalVol", label: "Median RV", color: "#e2e8f0", width: 1.6 },
    { key: "diffusiveVol", label: "Diffusion", color: "#38bdf8", width: 1.3 },
    { key: "jumpVol", label: "Jumps", color: "#fb7185", width: 1.3 },
  ].forEach((series, index) => {
    svg.append("path")
      .datum(rows)
      .attr("fill", "none")
      .attr("stroke", series.color)
      .attr("stroke-width", series.width)
      .attr("d", line((row) => row[series.key]));
    const legendX = margin.left + index * 112;
    svg.append("line")
      .attr("x1", legendX).attr("x2", legendX + 16)
      .attr("y1", 9).attr("y2", 9)
      .attr("stroke", series.color).attr("stroke-width", series.width);
    svg.append("text")
      .attr("x", legendX + 21).attr("y", 12)
      .attr("fill", "rgba(255,255,255,.48)").attr("font-size", 10)
      .text(series.label);
  });
  svg.append("path")
    .datum(rows)
    .attr("fill", "none")
    .attr("stroke", "rgba(255,255,255,.36)")
    .attr("stroke-width", 1)
    .attr("stroke-dasharray", "3 3")
    .attr("d", line((row) => row.expectedVol));
  const xAxis = svg.append("g")
    .attr("transform", `translate(0,${height - margin.bottom})`)
    .call(d3.axisBottom(x).ticks(5).tickSize(0).tickPadding(8));
  const yAxis = svg.append("g")
    .attr("transform", `translate(${margin.left},0)`)
    .call(d3.axisLeft(y).ticks(4).tickFormat(d3.format(".0%")).tickSize(0).tickPadding(7));
  [xAxis, yAxis].forEach((axis) => {
    axis.select(".domain").remove();
    axis.selectAll("text").attr("fill", "rgba(255,255,255,.34)").attr("font-size", 10);
  });
};

const redrawSettingsCharts = async () => {
  await nextTick();
  drawWeeklyForecastChart();
};
const redraw = async () => {
  await nextTick();
  draw();
  drawWeeklyForecastChart();
};

const run = async () => {
  if (!props.rows.length) return;
  const requestedScenarios = scenarioCount.value;
  const sequence = ++runSequence;
  running.value = true;
  progress.value = 0;
  error.value = "";
  try {
    const nextResult = await runFairValueInWorker({
      cycles: JSON.parse(JSON.stringify(props.rows)),
      options: {
        simulations: requestedScenarios,
        jumpThreshold: jumpThreshold.value,
        // Every rerun draws a fresh scenario set. Reproducibility stays internal.
        seed: Math.floor(Math.random() * 4_294_967_296),
      },
      onProgress: (update) => {
        if (sequence !== runSequence) return;
        progress.value = update.completed / update.total;
        if (update.result) {
          result.value = update.result;
          void redraw();
        }
      },
    });
    if (sequence !== runSequence) return;
    result.value = nextResult;
    await redraw();
  } catch (runError) {
    if (sequence === runSequence && !/superseded/i.test(runError?.message || "")) {
      error.value = runError?.message || "Simulation failed";
    }
  } finally {
    if (sequence === runSequence) running.value = false;
  }
};

const styleAxis = (group) => {
  group.select(".domain").remove();
  group.selectAll("line").attr("stroke", "rgba(255,255,255,0.08)");
  group.selectAll("text")
    .attr("fill", "rgba(255,255,255,0.44)")
    .attr("font-size", 11)
    .attr("font-family", '"Helvetica Neue", Helvetica, sans-serif');
};

const draw = () => {
  const element = chartRef.value;
  const cohorts = displayedGroups.value;
  if (!element || !cohorts.length) return;
  element.innerHTML = "";
  const bounds = element.getBoundingClientRect();
  const width = Math.max(980, bounds.width || 1180);
  const availableHeight = window.innerHeight - bounds.top - 54;
  const height = Math.max(660, Math.min(720, availableHeight));
  const outer = { left: 118, right: 54, top: 8, bottom: 20 };
  const columnGap = 88;
  const rowGap = 38;
  const panelWidth = (width - outer.left - outer.right - columnGap) / 2;
  const panelHeight = (height - outer.top - outer.bottom - rowGap) / 2;
  const scatterTooltip = d3.select(element).append("div")
    .attr("class", "scatterTooltip")
    .attr("role", "tooltip")
    .attr("aria-hidden", "true");
  const svg = d3.select(element).append("svg")
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("width", "100%").attr("height", height)
    .attr("font-family", '"Helvetica Neue", Helvetica, sans-serif')
    .attr("role", "img")
    .attr("aria-label", `Three ${viewMode.value === "iv"
      ? "entry IV regime"
      : viewMode.value === "priceMove"
        ? `observed ${props.underlying} move`
        : "consecutive cohort"} PnL distributions and actual weekly PnL plotted by ${viewMode.value === "time"
      ? "date"
      : viewMode.value === "iv"
        ? "entry IV z-score"
        : `${props.underlying} return`}`);

  const pnlCohorts = cohorts.filter((cohort) => cohort.kind !== "weekly-outcomes");
  const globalMaxAbsPnl = d3.max(pnlCohorts.flatMap((cohort) => [
    ...(cohort.terminalReturnOnPremium || []).map(Math.abs),
    Math.abs(cohort.returnSummary?.actualPnl || 0),
  ])) || 1;
  const pnlColor = d3.scaleDiverging(d3.interpolateRdBu)
    .domain([-globalMaxAbsPnl, 0, globalMaxAbsPnl]);
  const actualMarkerColorLimit = globalMaxAbsPnl * 0.65;

  const pooledPnlReturns = pnlCohorts
    .filter((cohort) => cohort.weekCount)
    .flatMap((cohort) => cohort.terminalReturnOnPremium || [])
    .sort((first, second) => first - second);
  let sharedPnlLow = d3.quantileSorted(pooledPnlReturns, 0.005);
  let sharedPnlHigh = d3.quantileSorted(pooledPnlReturns, 0.995);
  const historicalPnlReturns = pnlCohorts
    .filter((cohort) => cohort.weekCount)
    .map((cohort) => cohort.returnSummary.actualPnl);
  sharedPnlLow = Math.min(sharedPnlLow, ...historicalPnlReturns);
  sharedPnlHigh = Math.max(sharedPnlHigh, ...historicalPnlReturns);
  const sharedPnlSpan = Math.max(1e-6, sharedPnlHigh - sharedPnlLow);
  sharedPnlLow -= sharedPnlSpan * 0.04;
  sharedPnlHigh += sharedPnlSpan * 0.04;

  const legendX = 4;
  [
    { y: 13, fill: "rgba(255,255,255,.14)", label: "5–95%" },
    { y: 33, fill: "rgba(255,255,255,.07)", label: "1–99%" },
  ].forEach((item) => {
    svg.append("rect").attr("x", legendX).attr("y", item.y).attr("width", 18).attr("height", 9)
      .attr("fill", item.fill);
    svg.append("text").attr("x", legendX + 25).attr("y", item.y + 8)
      .attr("fill", "rgba(255,255,255,.42)").attr("font-size", 11).text(item.label);
  });
  svg.append("line").attr("x1", legendX + 9).attr("x2", legendX + 9)
    .attr("y1", 51).attr("y2", 64).attr("stroke", "rgba(255,255,255,.7)").attr("stroke-width", 1.5);
  svg.append("text").attr("x", legendX + 25).attr("y", 62)
    .attr("fill", "rgba(255,255,255,.42)").attr("font-size", 11).text("Historical");

  const formatDate = d3.utcFormat("%b %Y");
  const formatTooltipDate = d3.utcFormat("%d %b %Y");
  const formatPercent = d3.format(".1%");
  const formatSignedPercent = d3.format("+.2%");
  const formatSignedUsd = d3.format("+$,.0f");
  const formatIv = d3.format(".1%");
  const formatNullTailProbability = (stats, simulationCount) => {
    if (!Number.isFinite(stats?.probabilityAtOrAboveActual) || !simulationCount) return "—";
    if (stats.scenariosAtOrAboveActual === 0) {
      return `<${formatPercent(1 / (simulationCount + 1))}`;
    }
    return formatPercent(stats.probabilityAtOrAboveActual);
  };
  const formatZScore = (value) => {
    const rounded = Math.abs(value) < 0.05 ? 0 : value;
    return `${rounded > 0 ? "+" : ""}${rounded.toFixed(1)}`;
  };
  cohorts.forEach((cohort, cohortIndex) => {
    const column = cohortIndex % 2;
    const row = Math.floor(cohortIndex / 2);
    const panelX = outer.left + column * (panelWidth + columnGap);
    const panelY = outer.top + row * (panelHeight + rowGap);
    const plotTop = panelY + 78;
    const plotBottom = panelY + panelHeight - 27;
    if (cohort.kind === "weekly-outcomes") {
      const points = cohort.weeklyOutcomes || [];
      svg.append("text").attr("x", panelX).attr("y", panelY + 13)
        .attr("fill", "#dfe3e7").attr("font-size", 14).attr("font-weight", 600)
        .text(cohort.label);
      svg.append("text").attr("x", panelX).attr("y", panelY + 34)
        .attr("fill", "rgba(255,255,255,.36)").attr("font-size", 12)
        .text(`${points.length} historical weeks · each dot shows actual return on notional`);
      if (!points.length) return;
      const scatterLeft = panelX;
      const scatterRight = panelX + panelWidth - 8;
      const maxAbsReturn = d3.max(points, (point) => Math.abs(point.returnOnNotional)) || 0.01;
      let scatterX;
      let xValue;
      let xTickFormat;
      let xReference = null;
      if (viewMode.value === "time") {
        const [firstDate, lastDate] = d3.extent(points, (point) => point.entryDate);
        const paddingMs = Math.max(3.5 * 86_400_000, (lastDate - firstDate) * 0.025);
        scatterX = d3.scaleUtc()
          .domain([new Date(firstDate.getTime() - paddingMs), new Date(lastDate.getTime() + paddingMs)])
          .range([scatterLeft, scatterRight]);
        xValue = (point) => point.entryDate;
        xTickFormat = d3.utcFormat("%b %y");
      } else if (viewMode.value === "iv") {
        const [lowestZ, highestZ] = d3.extent(points, (point) => point.ivZScore);
        const zSpan = Math.max(0.5, highestZ - lowestZ);
        scatterX = d3.scaleLinear()
          .domain([lowestZ - zSpan * 0.06, highestZ + zSpan * 0.06])
          .nice(5)
          .range([scatterLeft, scatterRight]);
        xValue = (point) => point.ivZScore;
        xTickFormat = formatZScore;
        xReference = 0;
      } else {
        const maxAbsMove = d3.max(points, (point) => Math.abs(point.priceMove)) || 0.01;
        scatterX = d3.scaleLinear().domain([-maxAbsMove * 1.08, maxAbsMove * 1.08]).nice(5)
          .range([scatterLeft, scatterRight]);
        xValue = (point) => point.priceMove;
        xTickFormat = d3.format("+.0%");
        xReference = 0;
      }
      const scatterY = d3.scaleLinear().domain([-maxAbsReturn * 1.12, maxAbsReturn * 1.12]).nice(5)
        .range([plotBottom, plotTop]);
      const scatterColor = d3.scaleDiverging(d3.interpolateRdBu)
        .domain([-maxAbsReturn, 0, maxAbsReturn]);
      if (xReference != null) {
        svg.append("line")
          .attr("x1", scatterX(xReference)).attr("x2", scatterX(xReference))
          .attr("y1", plotTop).attr("y2", plotBottom)
          .attr("stroke", "rgba(255,255,255,.13)");
      }
      svg.append("line")
        .attr("x1", scatterLeft).attr("x2", scatterRight)
        .attr("y1", scatterY(0)).attr("y2", scatterY(0))
        .attr("stroke", "rgba(255,255,255,.13)");
      const xAxis = svg.append("g").attr("transform", `translate(0,${plotBottom})`)
        .call(d3.axisBottom(scatterX).ticks(5).tickFormat(xTickFormat).tickSize(0).tickPadding(9));
      styleAxis(xAxis);
      const pointDescription = (point) => {
        return [
          formatTooltipDate(point.entryDate),
          `${props.underlying} move ${formatSignedPercent(point.priceMove)}`,
          `Entry IV ${formatIv(point.entryIv)} · z-score ${formatZScore(point.ivZScore)}`,
          `Strategy PnL ${formatSignedUsd(point.pnlUsd)}`,
          `${formatSignedPercent(point.returnOnNotional)} of notional`,
        ];
      };
      const showPointTooltip = (event, point) => {
        scatterTooltip
          .html(`
            <strong>${formatTooltipDate(point.entryDate)}</strong>
            <span><b>{{ underlying }} move</b><em>${formatSignedPercent(point.priceMove)}</em></span>
            <span><b>Entry IV</b><em>${formatIv(point.entryIv)} · z ${formatZScore(point.ivZScore)}</em></span>
            <span><b>Strategy PnL</b><em>${formatSignedUsd(point.pnlUsd)}</em></span>
            <span><b>Return on notional</b><em>${formatSignedPercent(point.returnOnNotional)}</em></span>
          `)
          .attr("aria-hidden", "false")
          .classed("isVisible", true);
        const markBounds = event.currentTarget.getBoundingClientRect();
        const containerBounds = element.getBoundingClientRect();
        const tooltipNode = scatterTooltip.node();
        const tooltipWidth = tooltipNode.offsetWidth;
        const tooltipHeight = tooltipNode.offsetHeight;
        const markCenterX = markBounds.left - containerBounds.left + markBounds.width / 2;
        const left = Math.max(8, Math.min(
          containerBounds.width - tooltipWidth - 8,
          markCenterX - tooltipWidth / 2,
        ));
        const above = markBounds.top - containerBounds.top - tooltipHeight - 10;
        const top = above >= 8
          ? above
          : markBounds.bottom - containerBounds.top + 10;
        scatterTooltip.style("left", `${left}px`).style("top", `${top}px`);
        d3.select(event.currentTarget).attr("r", 4.8).attr("stroke-width", 1.1);
      };
      const clearPointTooltip = () => {
        scatterTooltip.attr("aria-hidden", "true").classed("isVisible", false);
        svg.selectAll("circle.weekly-outcome").attr("r", 3.6).attr("stroke-width", .7);
      };
      const hidePointTooltip = (event) => {
        clearPointTooltip();
        d3.select(event.currentTarget).attr("r", 3.6).attr("stroke-width", .7);
      };
      svg.on("click.scatter-tooltip", clearPointTooltip);
      svg.selectAll("circle.weekly-outcome").data(points).join("circle")
        .attr("class", "weekly-outcome")
        .attr("cx", (point) => scatterX(xValue(point)))
        .attr("cy", (point) => scatterY(point.returnOnNotional))
        .attr("r", 3.6)
        .attr("fill", (point) => scatterColor(point.returnOnNotional))
        .attr("stroke", "rgba(255,255,255,.36)")
        .attr("stroke-width", .7)
        .attr("opacity", .94)
        .attr("tabindex", 0)
        .attr("aria-label", (point) => pointDescription(point).join(", "))
        .on("pointerenter focus", showPointTooltip)
        .on("pointerleave blur", hidePointTooltip)
        .on("click", (event, point) => {
          event.stopPropagation();
          showPointTooltip(event, point);
        });
      return;
    }
    const values = cohort.terminalReturnOnPremium;
    const stats = cohort.returnSummary;
    const notionalStats = cohort.notionalReturnSummary;
    let domainLow = sharedPnlLow;
    let domainHigh = sharedPnlHigh;
    if (domainLow === domainHigh) {
      domainLow -= 1;
      domainHigh += 1;
    }
    const x = d3.scaleLinear().domain([domainLow, domainHigh]).nice(6)
      .range([panelX, panelX + panelWidth]);
    const [xLow, xHigh] = x.domain();
    const actualValue = stats.actualPnl;
    const actualRight = actualValue > xHigh;
    const actualLeft = actualValue < xLow;
    const actualX = actualRight ? panelX + panelWidth : actualLeft ? panelX : x(actualValue);
    const thresholds = Array.from({ length: 59 }, (_, index) =>
      xLow + (xHigh - xLow) * (index + 1) / 60);
    const bins = d3.bin().domain(x.domain()).thresholds(thresholds)(values);
    const y = d3.scaleLinear().domain([0, d3.max(bins, (bin) => bin.length) || 1]).nice()
      .range([plotBottom, plotTop]);

    const panelTitle = viewMode.value === "iv" || viewMode.value === "priceMove"
      ? `${cohort.label} · ${cohort.rangeLabel}`
      : `${cohort.label} · ${formatDate(cohort.startDate)} – ${formatDate(cohort.endDate)}`;
    const panelSubtitle = cohort.weekCount
      ? `${cohort.weekCount} weeks · actual avg ${formatSignedPercent(notionalStats.actualPnl)} of notional/week · null avg ${formatSignedPercent(notionalStats.mean)}`
      : "0 weeks";
    svg.append("text").attr("x", panelX).attr("y", panelY + 13)
      .attr("fill", "#dfe3e7").attr("font-size", 14).attr("font-weight", 600)
      .text(panelTitle);
    svg.append("text").attr("x", panelX).attr("y", panelY + 34)
      .attr("fill", "rgba(255,255,255,.36)").attr("font-size", 12)
      .text(panelSubtitle);
    if (!cohort.weekCount) {
      svg.append("text").attr("x", panelX + panelWidth / 2).attr("y", (plotTop + plotBottom) / 2)
        .attr("text-anchor", "middle").attr("fill", "rgba(255,255,255,.3)").attr("font-size", 13)
        .text("No completed weeks in this IV regime");
      return;
    }

    svg.selectAll(`rect.bin-${cohortIndex}`).data(bins).join("rect")
      .attr("class", `bin bin-${cohortIndex}`)
      .attr("x", (bin) => x(bin.x0) + .6)
      .attr("y", (bin) => y(bin.length))
      .attr("width", (bin) => Math.max(.7, x(bin.x1) - x(bin.x0) - 1.2))
      .attr("height", (bin) => plotBottom - y(bin.length))
      .attr("fill", (bin) => pnlColor((bin.x0 + bin.x1) / 2)).attr("opacity", .82)
      .append("title")
      .text((bin) => `${formatPercent(bin.x0)} to ${formatPercent(bin.x1)} of entry option value · ${bin.length} scenarios`);

    const clampX = (value) => x(Math.max(xLow, Math.min(xHigh, value)));
    svg.append("rect")
      .attr("x", clampX(stats.p01)).attr("y", plotTop)
      .attr("width", Math.max(0, clampX(stats.p99) - clampX(stats.p01)))
      .attr("height", plotBottom - plotTop)
      .attr("fill", "rgba(255,255,255,.055)").attr("pointer-events", "none");
    svg.append("rect")
      .attr("x", clampX(stats.p05)).attr("y", plotTop)
      .attr("width", Math.max(0, clampX(stats.p95) - clampX(stats.p05)))
      .attr("height", plotBottom - plotTop)
      .attr("fill", "rgba(255,255,255,.10)").attr("pointer-events", "none");

    const meanX = clampX(stats.mean);
    svg.append("line").attr("x1", meanX).attr("x2", meanX)
      .attr("y1", plotTop).attr("y2", plotBottom)
      .attr("stroke", "rgba(226,232,240,.8)").attr("stroke-width", 1)
      .attr("stroke-dasharray", "3 3");

    const readableActualValue = Math.max(
      -actualMarkerColorLimit,
      Math.min(actualMarkerColorLimit, actualValue),
    );
    const actualColor = d3.color(pnlColor(readableActualValue)).brighter(.45).formatHex();
    svg.append("line").attr("x1", actualX).attr("x2", actualX)
      .attr("y1", plotTop).attr("y2", plotBottom)
      .attr("stroke", actualColor).attr("stroke-width", 1.5);
    const anchorActualLabelRight = actualRight || actualX > panelX + panelWidth - 100;
    svg.append("text")
      .attr("x", actualX)
      .attr("y", plotTop - 6)
      .attr("text-anchor", anchorActualLabelRight ? "end" : actualLeft ? "start" : "middle")
      .attr("fill", actualColor).attr("font-size", 13).attr("font-weight", 600)
      .text(`P(null ≥ actual) ${formatNullTailProbability(stats, values.length)}`);

    const axis = svg.append("g").attr("transform", `translate(0,${plotBottom})`)
      .call(d3.axisBottom(x).ticks(6).tickFormat(d3.format(".0%")).tickSize(0).tickPadding(9));
    styleAxis(axis);
  });
};

watch(() => props.rows, () => {
  if (props.rows.length) void run();
});
watch(viewMode, () => void redraw());
watch(jumpThreshold, () => void redrawSettingsCharts());

onMounted(() => {
  resizeObserver = new ResizeObserver(() => {
    draw();
  });
  if (chartRef.value) resizeObserver.observe(chartRef.value);
  void run();
});
onUnmounted(() => {
  runSequence += 1;
  resizeObserver?.disconnect();
  cancelFairValueRun();
});

function exportPng({
  filename = "fair-value-distribution.png",
  scale = 4,
  padding = 24,
  title = "Weekly fair-value scenarios",
  subtitle = "Historical result versus 1,000 simulated histories",
  source = "",
} = {}) {
  const svgEl = chartRef.value?.querySelector("svg");
  if (!svgEl) return;
  exportTitledChart({ svgEl, filename, scale, padding, title, subtitle, source, background: "#0a0b0e" });
}

defineExpose({ exportPng });
</script>

<template>
  <div class="distributionPanel">
    <div v-if="running" class="progressTrack"><span :style="{ width: `${progress * 100}%` }"></span></div>
    <div v-if="error" class="state error">{{ error }}</div>
    <div v-else-if="!result" class="state">Building the first scenarios…</div>
    <template v-else>
      <div class="distributionContent">
        <div class="distributionIntro">
          <div class="titleWithMethodology">
            <button
              class="methodologyTrigger"
              type="button"
              aria-describedby="distribution-methodology-tooltip"
            >{{ scenarioStatus }}</button>
            <div id="distribution-methodology-tooltip" class="methodologyTooltip" role="tooltip">
                  <p>
                    <strong>This tab asks whether the strategy's realized returns look unusually good in a no-edge market.</strong>
                    We compare the actual result in each cohort with outcomes generated by a fair-value null. A small
                    P(null ≥ actual) means few null scenarios performed at least as well as the strategy; a large probability
                    means the result is readily explained by the null.
                  </p>
                  <p>
                    <strong>The null uses a Bates stochastic-volatility jump process calibrated to the hourly {{ underlying }} history.</strong>
                    A rolling robust local-volatility filter detects jumps, jump rates are estimated separately for low,
                    medium, and high volatility regimes, and κ, θ, σᵥ, and ρ are fitted from the jump-filtered 7-day realized
                    variance series. Paths are generated hourly and hedges occur only on the strategy's configured schedule.
                  </p>
                  <p>
                    <strong>Entry ATM IV is the total variance budget, not an extra diffusion input.</strong>
                    For each week, expected jump quadratic variation is deducted from IV²T. The remaining budget rescales
                    expected integrated Heston variance, so expected diffusion QV plus expected jump QV equals IV²T. We split
                    scenarios equally between −100%, 0%, and +100% annual drift and pool them.
                  </p>
                  <p>
                    <strong>Read the actual marker against the simulated distribution and its empirical ranges.</strong>
                    <template v-if="viewMode === 'time'">
                      The {{ completedWeekCount }} completed weeks are split into three consecutive periods.
                    </template><template v-else-if="viewMode === 'iv'">
                      Entry IV is standardized into Low, Medium, and High regimes across the
                      {{ completedWeekCount }} completed weeks.
                    </template><template v-else>
                      Weeks are ranked by their observed {{ underlying }} price change from entry to exit, then split into equal-count
                      lowest, middle, and highest move cohorts across the {{ completedWeekCount }} completed weeks.
                    </template>
                    The fourth panel follows the selected view: actual weekly PnL over calendar time for T, against entry-IV
                    z-score for σ, or against the week's observed {{ underlying }} return for Δ.
                    Bars show simulated PnL divided by the total option value paid or received when the trades in that
                    panel were opened, which makes differently sized cohorts comparable; it is not return on the strategy's
                    $100k notional. The brighter band contains the middle 90% of null outcomes and the fainter band contains
                    the middle 98%. P(null ≥ actual) is the one-sided Monte Carlo probability of obtaining the actual result
                    or a better one under that panel's null. We apply the standard add-one correction, and show the simulation
                    resolution as an upper bound when no scenario reaches the actual result.
                  </p>
                </div>
          </div>
          <div class="distributionControls">
            <div class="controlRow">
              <span>Panels</span>
              <div class="groupingToggle" role="group" aria-label="Group distributions by">
                <button type="button" :aria-pressed="viewMode === 'time'" title="Time cohorts" @click="viewMode = 'time'">T</button>
                <button type="button" :aria-pressed="viewMode === 'iv'" title="Entry IV" @click="viewMode = 'iv'">σ</button>
                <button type="button" :aria-pressed="viewMode === 'priceMove'" :title="`Observed ${underlying} price change cohorts`" @click="viewMode = 'priceMove'">Δ</button>
              </div>
            </div>
            <div class="controlRow">
              <details class="modelSettings" @click.stop @toggle="redrawSettingsCharts">
                <summary>Model settings</summary>
                <div class="modelSettingsMenu">
                  <div class="settingsHeader">
                    <div>
                      <strong>Jump threshold</strong>
                      <span>Local-volatility standard deviations</span>
                    </div>
                    <div class="groupingToggle" role="group" aria-label="Jump detection threshold">
                      <button
                        v-for="threshold in JUMP_THRESHOLD_OPTIONS"
                        :key="threshold"
                        type="button"
                        :disabled="running"
                        :aria-pressed="jumpThreshold === threshold"
                        @click="jumpThreshold = threshold"
                      >{{ threshold.toFixed(1) }}σ</button>
                    </div>
                  </div>
                  <p>
                    {{ underlying }} volatility changes materially through time, so one fixed return cutoff would label ordinary
                    high-volatility moves as jumps and miss unusual moves during quiet periods. Each hourly log return is
                    therefore centered on the preceding 168-hour median and divided by a local robust volatility estimate
                    based on median absolute deviation. Median statistics keep a candidate jump from materially inflating
                    its own detection threshold.
                  </p>
                  <p>
                    A return is a jump when its absolute local z-score reaches the selected threshold. Lower settings assign
                    more variance to jumps; higher settings assign more to stochastic diffusion. Threshold changes are
                    retained and applied to the strategy distribution the next time you select Run again.
                  </p>
                  <div class="forecastHeader">
                    <strong>Weekly forecast RV</strong>
                    <span>Background: low / medium / high volatility regime</span>
                  </div>
                  <div ref="weeklyForecastChartRef" class="settingsChart"></div>
                  <p>
                    The white line is median simulated RV for the selected jump setting and the pale band is its 10–90%
                    range, so both update when the threshold changes. The dashed line is the fixed ATM-IV expected-QV
                    target. Blue and pink show the QV-equivalent diffusion and jump forecasts.
                  </p>
                </div>
              </details>
            </div>
            <div class="controlRow">
              <div class="scenarioRunner">
                <details :class="['scenarioSelect', { disabled: running }]" @click.capture="running && $event.preventDefault()">
                  <summary aria-label="Number of Monte Carlo scenarios" :aria-disabled="running">
                    {{ scenarioCount.toLocaleString() }} sims
                  </summary>
                  <div class="scenarioMenu" role="listbox" aria-label="Number of Monte Carlo scenarios">
                    <button
                      v-for="count in SCENARIO_OPTIONS"
                      :key="count"
                      type="button"
                      role="option"
                      :aria-selected="scenarioCount === count"
                      @click="scenarioCount = count; $event.currentTarget.closest('details').removeAttribute('open')"
                    >{{ count.toLocaleString() }} sims</button>
                  </div>
                </details>
                <button type="button" :disabled="running || !rows.length" @click="run">
                  {{ running ? `Running · ${Math.round(progress * 100)}%` : 'Run again' }}
                </button>
              </div>
            </div>
          </div>
        </div>
        <div ref="chartRef" class="distributionChart"></div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.distributionPanel {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 2px 14px 18px;
  scrollbar-color: rgba(255,255,255,.14) transparent;
}
.progressTrack { height: 3px; margin: 2px 11px 0; background: rgba(255,255,255,.05); }
.progressTrack span { display: block; height: 100%; background: #38bdf8; transition: width .12s linear; }
.state { display: grid; min-height: 420px; place-items: center; color: #69717a; font-size: 14px; }
.state.error { color: #fb7185; }
.distributionContent {
  width: 100%;
  max-width: 1740px;
  min-width: 1100px;
  margin-inline: auto;
}
.distributionChart { position: relative; margin-top: 6px; }
.distributionChart :deep(svg) { display: block; }
.distributionChart :deep(.scatterTooltip) {
  position: absolute;
  z-index: 8;
  display: grid;
  gap: 6px;
  min-width: 205px;
  box-sizing: border-box;
  padding: 11px 12px;
  border: 1px solid rgba(255,255,255,.13);
  border-radius: 5px;
  background: #111318;
  box-shadow: 0 10px 28px rgba(0,0,0,.44);
  color: #dfe3e7;
  font-size: 12px;
  pointer-events: none;
  opacity: 0;
  visibility: hidden;
  transition: opacity .08s ease;
}
.distributionChart :deep(.scatterTooltip.isVisible) { opacity: 1; visibility: visible; }
.distributionChart :deep(.scatterTooltip strong) { font-size: 13px; font-weight: 600; }
.distributionChart :deep(.scatterTooltip span) {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 18px;
}
.distributionChart :deep(.scatterTooltip b) { color: #858d95; font-weight: 500; }
.distributionChart :deep(.scatterTooltip em) {
  color: #dfe3e7;
  font-style: normal;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.distributionIntro {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  margin: 14px 28px 0 54px;
}
.distributionIntro > :first-child {
  flex: 1 1 auto;
  min-width: 0;
}
.titleWithMethodology {
  position: relative;
  display: inline-block;
  flex: 0 0 auto;
}
.methodologyTrigger {
  height: 32px;
  padding: 0;
  border: 0;
  background: transparent;
  color: rgba(255,255,255,.42);
  font: 500 13px/1 "Helvetica Neue", Helvetica, sans-serif;
  white-space: nowrap;
}
.methodologyTooltip {
  position: absolute;
  z-index: 30;
  top: calc(100% + 9px);
  left: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 16px;
  width: min(720px, calc(100vw - 120px));
  box-sizing: border-box;
  padding: 18px 20px;
  border: 1px solid rgba(255,255,255,.11);
  border-radius: 5px;
  background: #111318;
  box-shadow: 0 14px 34px rgba(0,0,0,.42);
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transition: opacity .1s ease;
}
.titleWithMethodology:hover .methodologyTooltip,
.titleWithMethodology:focus-within .methodologyTooltip {
  opacity: 1;
  visibility: visible;
}
.distributionIntro .methodologyTooltip p {
  margin: 0;
  color: #7c838b;
  font-size: 13px;
  line-height: 1.5;
  text-align: left;
}
.methodologyTooltip strong {
  display: inline;
  margin-right: 3px;
  color: #aeb4bb;
  font-weight: 600;
}
.distributionControls {
  display: flex;
  flex-wrap: wrap;
  flex: 0 0 auto;
  align-items: center;
  justify-content: flex-end;
  gap: 26px;
  margin-top: 0;
}
.controlRow {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
}
.controlRow > span {
  color: #6a727a;
  font-size: 13px;
}
.modelSettings {
  position: relative;
}
.modelSettings summary {
  display: flex;
  align-items: center;
  height: 28px;
  box-sizing: border-box;
  padding: 0 9px;
  border: 1px solid rgba(255,255,255,.10);
  border-radius: 4px;
  background: transparent;
  color: #777e86;
  font: inherit;
  font-size: 13px;
  list-style: none;
  white-space: nowrap;
  cursor: pointer;
}
.modelSettings summary::-webkit-details-marker { display: none; }
.modelSettings summary::marker { content: ""; }
.modelSettings[open] summary {
  color: #c5c9ce;
  border-color: rgba(255,255,255,.20);
  background: rgba(255,255,255,.04);
}
.modelSettingsMenu {
  position: absolute;
  z-index: 32;
  top: calc(100% + 6px);
  right: 0;
  display: grid;
  gap: 12px;
  width: 680px;
  max-height: calc(100vh - 150px);
  box-sizing: border-box;
  padding: 16px 18px 18px;
  border: 1px solid rgba(255,255,255,.11);
  border-radius: 5px;
  background: #111318;
  box-shadow: 0 14px 34px rgba(0,0,0,.42);
  overflow-y: auto;
  scrollbar-color: rgba(255,255,255,.14) transparent;
}
.settingsHeader,
.forecastHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
}
.settingsHeader > div:first-child {
  display: grid;
  gap: 3px;
}
.modelSettingsMenu strong {
  color: #c8ced4;
  font-size: 13px;
  font-weight: 600;
}
.modelSettingsMenu span {
  color: #616a73;
  font-size: 11px;
}
.modelSettingsMenu p {
  margin: 0;
  color: #7c838b;
  font-size: 12px;
  line-height: 1.5;
  text-align: left;
}
.forecastHeader {
  padding-top: 3px;
}
.settingsChart {
  min-height: 210px;
  border: 1px solid rgba(255,255,255,.07);
  border-radius: 4px;
  background: rgba(0,0,0,.08);
}
.settingsChart :deep(svg) { display: block; }
.groupingToggle {
  display: inline-flex;
  flex: none;
  padding: 2px;
  border-radius: 5px;
  background: rgba(255,255,255,.045);
}
.groupingToggle button {
  height: 28px;
  padding: 0 11px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: #69717a;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
.groupingToggle button[aria-pressed="true"] {
  background: rgba(255,255,255,.10);
  color: #d6dade;
}
.scenarioRunner {
  display: inline-flex;
  flex: none;
  gap: 10px;
}
.scenarioSelect summary,
.scenarioRunner button {
  height: 28px;
  border: 1px solid rgba(255,255,255,.10);
  border-radius: 4px;
  background: transparent;
  color: #777e86;
  font: inherit;
  font-size: 13px;
}
.scenarioSelect {
  position: relative;
  width: 112px;
}
.scenarioSelect summary {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  box-sizing: border-box;
  padding: 0 8px;
  cursor: pointer;
  list-style: none;
  white-space: nowrap;
}
.scenarioSelect summary::-webkit-details-marker { display: none; }
.scenarioSelect summary::marker { content: ""; }
.scenarioSelect[open] summary {
  color: #c5c9ce;
  border-color: rgba(255,255,255,.20);
  background: rgba(255,255,255,.04);
}
.scenarioSelect.disabled { opacity: .6; }
.scenarioSelect.disabled summary { cursor: default; }
.scenarioMenu {
  position: absolute;
  z-index: 20;
  top: calc(100% + 5px);
  left: 0;
  width: 100%;
  padding: 3px;
  box-sizing: border-box;
  border: 1px solid rgba(255,255,255,.11);
  border-radius: 5px;
  background: #111318;
  box-shadow: 0 10px 28px rgba(0,0,0,.38);
}
.scenarioMenu button {
  display: block;
  width: 100%;
  height: 30px;
  box-sizing: border-box;
  padding: 0 9px;
  border: 0;
  text-align: left;
  white-space: nowrap;
}
.scenarioMenu button:hover,
.scenarioMenu button[aria-selected="true"] {
  background: rgba(255,255,255,.08);
  color: #d6dade;
}
.scenarioRunner button {
  padding: 0 9px;
  cursor: pointer;
  white-space: nowrap;
}
.scenarioRunner > button { min-width: 82px; }
.scenarioRunner button:hover:not(:disabled) {
  color: #c5c9ce;
  border-color: rgba(255,255,255,.20);
}
.scenarioRunner button:disabled {
  opacity: .6;
  cursor: default;
}
</style>
