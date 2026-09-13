<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from "vue";
import * as d3 from "d3";
import type { GBMParams } from "../lib/gbm";
import {
  sanitizePathModel,
  type PathModelParams,
} from "../lib/pathModel";
import type { PositionLeg } from "../lib/position";
import {
  buildBinnedCumulativeEV,
  buildPayoffDifferenceSummary,
  buildSharedTerminalCumulativeSeries,
  computePayoffBinValue,
  smoothSharedTerminalCumulativeSeries,
} from "../lib/payoffComparison";
import type {
  HistogramBinHover,
  HistogramBinStats,
  SimulationStats,
} from "../lib/simulation";
import SimWorker from "../workers/sim.worker?worker";

type OptionPricingInput = {
  iv: number | null;
  mark: number | null;
  expirationTs: number | null;
};

type StopPathSummary = {
  stoppedPathCount: number;
  sampledPathCount: number;
  highlightedLoss: number;
  stopDay: number;
  finalPrice: number;
  opportunityCost: number;
};

const props = defineProps<{
  seed: number;
  params: GBMParams;
  pathModel: PathModelParams;
  valuationTs?: number;
  muMin?: number;
  muMax?: number;
  volMin?: number;
  volMax?: number;
  histMode?: "payoff" | "prob";
  histogramOpacity?: number;
  colorMin?: number;
  colorMax?: number;
  histBinsMultiplier?: number;
  legs?: PositionLeg[];
  optionPricingByLegId?: Record<string, OptionPricingInput>;
  histBins?: number;
  samplePathLimit?: number;
  comparisonLegs?: PositionLeg[];
  comparisonOptionPricingByLegId?: Record<string, OptionPricingInput>;
  primarySeriesLabel?: string;
  comparisonSeriesLabel?: string;
  comparisonReferencePrice?: number;
  pathFilter?: "all" | "stopped";
  /** Replace the path cloud with an average or full terminal payoff view. */
  payoffDisplayMode?: "payoff" | "frequency";
  /** Choose terminal-price bins or sorted cumulative payoff contribution. */
  payoffChartMode?: "terminal" | "cumulative";
  /** Compact simulation context rendered below the payoff chart subtitle. */
  payoffChartContext?: string;
}>();

const emit = defineEmits<{
  (event: "set-mu", value: number): void;
  (event: "set-vol", value: number): void;
  (event: "guide-update", value: { mu: number; vol: number }): void;
  (event: "stats-update", value: SimulationStats): void;
  (event: "comparison-stats-update", value: SimulationStats): void;
  (
    event: "payoff-difference-update",
    value: { optionWinRate: number; medianAdvantage: number },
  ): void;
  (event: "stop-path-update", value: StopPathSummary | null): void;
  (event: "histogram-bin-hover", value: HistogramBinHover | null): void;
}>();

const svgRef = ref<SVGSVGElement | null>(null);
const canvasRef = ref<HTMLCanvasElement | null>(null);
const chartLayerRef = ref<HTMLDivElement | null>(null);
type HistogramTooltipState = {
  x: number;
  y: number;
  priceRange: string;
  probability: string;
  cumulativeProbability: string;
  cumulativeEV?: string;
  paths: string;
  medianPayoff: string;
  averagePayoff: string;
  primaryContribution?: string;
  comparisonContribution?: string;
  accent: string;
};
const histogramTooltip = ref<HistogramTooltipState | null>(null);
type PayoffBinTooltipState = {
  x: number;
  y: number;
  priceRange: string;
  valueLabel: string;
  optionValue: string;
  perpValue: string;
  difference: string;
};
const payoffBinTooltip = ref<PayoffBinTooltipState | null>(null);
const SECONDS_PER_YEAR = 365.25 * 24 * 60 * 60;
const RISK_FREE_RATE = 0.0;
const MAX_CLOUD_RENDER_PATHS = 500;
const REVEAL_DURATION_MS = 900;
const HISTOGRAM_BIN_COUNT = 100;
const COLOR_T_MIN = 0.15;
const COLOR_T_MAX = 0.85;
const COLOR_T_MID = 0.5;
const CHART_WIDTH = 1200;
const CHART_HEIGHT = 520;
const CUMUL_CHART_HEIGHT = 520;
const TERMINAL_CHART_HEIGHT = 720;
const CHART_MARGIN = { top: 18, right: 112, bottom: 38, left: 46 };
const HISTOGRAM_WIDTH = 210;
const HISTOGRAM_INNER_GAP = 28;
// Two-column histogram gutter: left = price frequency (heatmap), right = payoff.
const PRICE_HIST_WIDTH = 72;
const PAYOFF_HIST_WIDTH =
  HISTOGRAM_WIDTH - PRICE_HIST_WIDTH - HISTOGRAM_INNER_GAP;
const PAYOFF_HIST_OFFSET = PRICE_HIST_WIDTH + HISTOGRAM_INNER_GAP;
const HISTOGRAM_GAP = 54;
const MAIN_WIDTH =
  CHART_WIDTH -
  CHART_MARGIN.left -
  CHART_MARGIN.right -
  HISTOGRAM_WIDTH -
  HISTOGRAM_GAP;
const MAIN_HEIGHT = CHART_HEIGHT - CHART_MARGIN.top - CHART_MARGIN.bottom;
const HISTOGRAM_TOOLTIP_WIDTH = 172;
const HISTOGRAM_TOOLTIP_HEIGHT = 148;
const HISTOGRAM_TOOLTIP_GAP = 24;
const PAYOFF_BIN_TOOLTIP_WIDTH = 216;
const PAYOFF_BIN_TOOLTIP_HEIGHT = 126;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const formatTooltipPrice = (value: number): string =>
  `$${Math.round(value).toLocaleString("en-US")}`;

const formatTooltipPayoff = (value: number): string => {
  if (!Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  const absolute = Math.abs(value);
  const maximumFractionDigits = absolute >= 1000 ? 0 : absolute >= 100 ? 1 : 2;
  return `${sign}$${absolute.toLocaleString("en-US", {
    maximumFractionDigits,
  })}`;
};

const formatTooltipContribution = (value: number): string => {
  if (!Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  const absolute = Math.abs(value);
  const fractionDigits = absolute > 0 && absolute < 0.01
    ? 4
    : absolute < 1
      ? 2
      : 0;
  return `${sign}$${absolute.toLocaleString("en-US", {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })}`;
};

const formatTooltipProbability = (value: number): string => {
  if (!Number.isFinite(value) || value <= 0) return "0.00%";
  const percentage = value * 100;
  return `${percentage.toFixed(percentage < 0.1 ? 3 : 2)}%`;
};

type PayoffComparisonPoint = {
  index: number;
  priceMin: number;
  priceMax: number;
  optionValue: number;
  perpValue: number;
  difference: number;
};

const showPayoffBinTooltip = (
  event: PointerEvent,
  point: PayoffComparisonPoint,
  displayMode: "payoff" | "frequency",
): void => {
  const layer = chartLayerRef.value;
  if (!layer) return;
  const layerRect = layer.getBoundingClientRect();
  const pointerX = event.clientX - layerRect.left;
  const pointerY = event.clientY - layerRect.top;
  const preferRight =
    pointerX + 18 + PAYOFF_BIN_TOOLTIP_WIDTH <= layerRect.width;
  const rawX = preferRight
    ? pointerX + 18
    : pointerX - PAYOFF_BIN_TOOLTIP_WIDTH - 18;

  payoffBinTooltip.value = {
    x: clamp(
      rawX,
      8,
      Math.max(8, layerRect.width - PAYOFF_BIN_TOOLTIP_WIDTH - 8),
    ),
    y: clamp(
      pointerY - PAYOFF_BIN_TOOLTIP_HEIGHT * 0.5,
      8,
      Math.max(8, layerRect.height - PAYOFF_BIN_TOOLTIP_HEIGHT - 8),
    ),
    priceRange: `${formatTooltipPrice(point.priceMin)} – ${formatTooltipPrice(point.priceMax)}`,
    valueLabel: displayMode === "frequency" ? "EV contribution" : "Mean P&L",
    optionValue: formatTooltipContribution(point.optionValue),
    perpValue: formatTooltipContribution(point.perpValue),
    difference: formatTooltipContribution(point.difference),
  };
};

type SceneHandles = {
  svg: d3.Selection<SVGSVGElement, unknown, null, undefined>;
  defs: d3.Selection<SVGDefsElement, unknown, null, undefined>;
  mainGroup: d3.Selection<SVGGElement, unknown, null, undefined>;
  plotGroup: d3.Selection<SVGGElement, unknown, null, undefined>;
  interactionLayer: d3.Selection<SVGRectElement, unknown, null, undefined>;
  histogramGroup: d3.Selection<SVGGElement, unknown, null, undefined>;
};

type SimWorkerRequest = {
  id: number;
  seed: number;
  params: GBMParams;
  pathModel: PathModelParams;
  legs: PositionLeg[];
  optionPricingByLegId: Record<string, OptionPricingInput>;
  valuationTs: number;
  horizonSeconds: number;
  histBins: number;
  histBinsMultiplier: number;
  samplePathLimit: number;
  returnSamplePaths?: boolean;
  samplingStopLoss?: {
    side: "buy" | "sell";
    price: number;
  };
};

type SimBin = {
  x0: number;
  x1: number;
  count: number;
  sumPayoff: number;
  medianPayoff: number;
  p10Payoff: number;
  p25Payoff: number;
  p50Payoff: number;
  p75Payoff: number;
  p90Payoff: number;
  winCount: number;
  maxLossCount: number;
  opportunityCostSum: number;
};

const statsFromBin = (
  bin: SimBin | undefined,
  totalCount: number,
): HistogramBinStats | null => {
  if (!bin || bin.count <= 0) return null;
  const winCount = Number(bin.winCount) || 0;
  const maxLossCount = Number(bin.maxLossCount) || 0;
  const opportunityCostSum = Number(bin.opportunityCostSum) || 0;
  return {
    priceMin: bin.x0,
    priceMax: bin.x1,
    count: bin.count,
    totalCount,
    meanPayoff: bin.sumPayoff / bin.count,
    medianPayoff: bin.medianPayoff,
    p10Payoff: bin.p10Payoff,
    p25Payoff: bin.p25Payoff,
    p50Payoff: bin.p50Payoff,
    p75Payoff: bin.p75Payoff,
    p90Payoff: bin.p90Payoff,
    winRate: winCount / bin.count,
    maxLossRate: maxLossCount / bin.count,
    opportunityCost: opportunityCostSum / bin.count,
  };
};

const computeBreakEvenPrices = (bins: SimBin[]): number[] => {
  const points: Array<{ price: number; payoff: number }> = [];
  for (const bin of bins) {
    if (bin.count <= 0) continue;
    const x0 = Number(bin.x0);
    const x1 = Number(bin.x1);
    if (!Number.isFinite(x0) || !Number.isFinite(x1)) continue;
    const price = (x0 + x1) * 0.5;
    const payoff = bin.sumPayoff / bin.count;
    if (!Number.isFinite(price) || !Number.isFinite(payoff)) continue;
    points.push({ price, payoff });
  }
  if (!points.length) return [];

  const raw: number[] = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const left = points[i];
    const right = points[i + 1];
    if (Math.abs(left.payoff) < 1e-9) raw.push(left.price);
    if (
      (left.payoff < 0 && right.payoff > 0) ||
      (left.payoff > 0 && right.payoff < 0)
    ) {
      const denom = right.payoff - left.payoff;
      if (Math.abs(denom) > 1e-12) {
        const t = -left.payoff / denom;
        raw.push(left.price + t * (right.price - left.price));
      }
    }
  }
  const last = points[points.length - 1];
  if (Math.abs(last.payoff) < 1e-9) raw.push(last.price);
  if (!raw.length) return [];

  raw.sort((a, b) => a - b);
  const span = points[points.length - 1].price - points[0].price;
  const tol = Math.max(span / Math.max(points.length * 4, 1), 1e-6);
  const deduped: number[] = [];
  for (const value of raw) {
    const prev = deduped[deduped.length - 1];
    if (prev == null || Math.abs(value - prev) > tol) deduped.push(value);
  }
  return deduped.slice(0, 6);
};

type SimWorkerSuccess = {
  id: number;
  steps: number;
  rows: number;
  sampleRows: number;
  sampledPathRows: number;
  sampledPathsBuffer: ArrayBuffer;
  sampledFinalPricesBuffer: ArrayBuffer;
  sampledPayoffsBuffer: ArrayBuffer;
  terminalPricesBuffer: ArrayBuffer;
  terminalPayoffsBuffer: ArrayBuffer;
  bins: SimBin[];
  pathMin: number;
  pathMax: number;
  finalPriceMin: number;
  finalPriceMax: number;
  payoffMin: number;
  payoffMax: number;
  meanPayoff: number;
  medianPayoff: number;
  maxPayoff: number;
  maxDrawdown: number;
  winRate: number;
  p05Payoff: number;
  p10Payoff: number;
  p25Payoff: number;
  p50Payoff: number;
  p75Payoff: number;
  p90Payoff: number;
  p95Payoff: number;
  maxLossRate: number;
  opportunityCost: number;
};

type SimWorkerError = {
  id: number;
  error: string;
};

type SimComputation = {
  steps: number;
  rows: number;
  samplePaths: Float64Array[];
  sampledFinalPrices: Float64Array;
  sampledPayoffs: Float64Array;
  terminalPrices: Float64Array;
  terminalPayoffs: Float64Array;
  bins: SimBin[];
  pathMin: number;
  pathMax: number;
  finalPriceMin: number;
  finalPriceMax: number;
  payoffMin: number;
  payoffMax: number;
  meanPayoff: number;
  medianPayoff: number;
  maxPayoff: number;
  maxDrawdown: number;
  winRate: number;
  p05Payoff: number;
  p10Payoff: number;
  p25Payoff: number;
  p50Payoff: number;
  p75Payoff: number;
  p90Payoff: number;
  p95Payoff: number;
  maxLossRate: number;
  opportunityCost: number;
};

const sanitizeParamsForWorker = (params: GBMParams): GBMParams => ({
  s0: Number(params.s0),
  mu: Number(params.mu),
  vol: Number(params.vol),
  T: Number(params.T),
  dt: Number(params.dt),
  rows: Number(params.rows),
});

const sanitizeLegsForWorker = (
  legs: PositionLeg[] | undefined,
): PositionLeg[] =>
  (legs ?? []).map((leg) =>
    leg.kind === "option"
      ? {
          id: String(leg.id),
          kind: "option" as const,
          side: leg.side === "sell" ? "sell" : "buy",
          qty: Number(leg.qty),
          optionType: leg.optionType === "put" ? "put" : "call",
          strike: Number(leg.strike),
          premium: Number(leg.premium),
          expiry: leg.expiry,
        }
      : {
          id: String(leg.id),
          kind: "future" as const,
          side: leg.side === "sell" ? "sell" : "buy",
          qty: Number(leg.qty),
          entry: Number(leg.entry),
          stopLoss:
            leg.stopLoss == null || !Number.isFinite(Number(leg.stopLoss))
              ? null
              : Number(leg.stopLoss),
          annualFundingRate: Number.isFinite(Number(leg.annualFundingRate))
            ? Number(leg.annualFundingRate)
            : 0,
        },
  );

const sanitizeOptionPricingForWorker = (
  pricing: Record<string, OptionPricingInput> | undefined,
): Record<string, OptionPricingInput> => {
  const out: Record<string, OptionPricingInput> = {};
  if (!pricing) return out;
  for (const [legId, value] of Object.entries(pricing)) {
    out[legId] = {
      iv:
        value?.iv == null || !Number.isFinite(Number(value.iv))
          ? null
          : Number(value.iv),
      mark:
        value?.mark == null || !Number.isFinite(Number(value.mark))
          ? null
          : Number(value.mark),
      expirationTs:
        value?.expirationTs == null ||
        !Number.isFinite(Number(value.expirationTs))
          ? null
          : Number(value.expirationTs),
    };
  }
  return out;
};

type InteractionHandlers = {
  pointermove: (event: PointerEvent) => void;
  pointerenter: (event: PointerEvent) => void;
  pointerdown: (event: PointerEvent) => void;
  pointerup: (event: PointerEvent) => void;
  click: (event: PointerEvent) => void;
};

let cloudRevealRaf: number | null = null;
let drawScheduleTimer: ReturnType<typeof setTimeout> | null = null;
let drawInFlight = false;
let drawQueued = false;
let componentMounted = false;
let scene: SceneHandles | null = null;
let interactionHandlers: InteractionHandlers | null = null;
let canvasTransformCache: {
  canvas: HTMLCanvasElement | null;
  backingWidth: number;
  backingHeight: number;
  scaleX: number;
  scaleY: number;
} = {
  canvas: null,
  backingWidth: 0,
  backingHeight: 0,
  scaleX: 1,
  scaleY: 1,
};
let simWorker: Worker | null = null;
let simRequestSeq = 0;
let latestDrawSeq = 0;
let cachedSim: SimComputation | null = null;
let cachedComparisonSim: SimComputation | null = null;
const pendingSimRequests = new Map<
  number,
  {
    resolve: (value: SimComputation) => void;
    reject: (reason?: unknown) => void;
  }
>();

const cancelPendingSimRequests = (reason: string): void => {
  if (!pendingSimRequests.size) return;
  const error = new Error(reason);
  for (const { reject } of pendingSimRequests.values()) {
    reject(error);
  }
  pendingSimRequests.clear();
};

const handleWorkerMessage = (
  event: MessageEvent<SimWorkerSuccess | SimWorkerError>,
): void => {
  const payload = event.data;
  const pending = pendingSimRequests.get(payload.id);
  if (!pending) return;
  pendingSimRequests.delete(payload.id);

  if ("error" in payload) {
    pending.reject(new Error(payload.error));
    return;
  }

  const sampledFinalPrices = new Float64Array(payload.sampledFinalPricesBuffer);
  const sampledPayoffs = new Float64Array(payload.sampledPayoffsBuffer);
  const terminalPrices = new Float64Array(payload.terminalPricesBuffer);
  const terminalPayoffs = new Float64Array(payload.terminalPayoffsBuffer);
  const flatPaths = new Float64Array(payload.sampledPathsBuffer);
  const samplePaths: Float64Array[] = new Array(payload.sampledPathRows);
  for (let r = 0; r < payload.sampledPathRows; r += 1) {
    const offset = r * payload.steps;
    samplePaths[r] = flatPaths.subarray(offset, offset + payload.steps);
  }

  pending.resolve({
    steps: payload.steps,
    rows: payload.rows,
    samplePaths,
    sampledFinalPrices,
    sampledPayoffs,
    terminalPrices,
    terminalPayoffs,
    bins: payload.bins,
    pathMin: payload.pathMin,
    pathMax: payload.pathMax,
    finalPriceMin: payload.finalPriceMin,
    finalPriceMax: payload.finalPriceMax,
    payoffMin: payload.payoffMin,
    payoffMax: payload.payoffMax,
    meanPayoff: payload.meanPayoff,
    medianPayoff: payload.medianPayoff,
    maxPayoff: payload.maxPayoff,
    maxDrawdown: payload.maxDrawdown,
    winRate: payload.winRate,
    p05Payoff: payload.p05Payoff,
    p10Payoff: payload.p10Payoff,
    p25Payoff: payload.p25Payoff,
    p50Payoff: payload.p50Payoff,
    p75Payoff: payload.p75Payoff,
    p90Payoff: payload.p90Payoff,
    p95Payoff: payload.p95Payoff,
    maxLossRate: payload.maxLossRate,
    opportunityCost: payload.opportunityCost,
  });
};

const ensureSimWorker = (): Worker => {
  if (simWorker) return simWorker;
  simWorker = new SimWorker();
  simWorker.onmessage = handleWorkerMessage;
  simWorker.onerror = (event) => {
    const err = new Error(event.message || "Simulation worker failed");
    cancelPendingSimRequests(err.message);
    console.error("Simulation worker error", event);
  };
  return simWorker;
};

const requestSimulation = (
  request: Omit<SimWorkerRequest, "id">,
): Promise<SimComputation> => {
  const worker = ensureSimWorker();
  // Worker keeps only latest queued request; supersede any older unresolved calls.
  cancelPendingSimRequests("Simulation request superseded");
  const id = ++simRequestSeq;
  return new Promise<SimComputation>((resolve, reject) => {
    pendingSimRequests.set(id, { resolve, reject });
    worker.postMessage({
      id,
      ...request,
    } satisfies SimWorkerRequest);
  });
};

const ensureScene = (): SceneHandles | null => {
  if (!svgRef.value) return null;
  if (scene != null && scene.svg.node() === svgRef.value) return scene;

  const svg = d3.select(svgRef.value);
  svg.selectAll("*").remove();
  svg.attr("viewBox", `0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`);
  svg.attr("preserveAspectRatio", "xMidYMin meet");

  const defs = svg.append("defs");
  const mainGroup = svg
    .append("g")
    .attr("transform", `translate(${CHART_MARGIN.left}, ${CHART_MARGIN.top})`);
  const plotGroup = mainGroup.append("g").attr("class", "plot-group");
  const interactionLayer = mainGroup
    .append("rect")
    .attr("class", "interaction-layer")
    .attr("x", 0)
    .attr("y", 0)
    .attr("width", MAIN_WIDTH)
    .attr("height", MAIN_HEIGHT)
    .attr("fill", "transparent")
    .style("pointer-events", "all");
  interactionLayer
    .on("pointermove", (event) =>
      interactionHandlers?.pointermove(event as PointerEvent),
    )
    .on("pointerenter", (event) =>
      interactionHandlers?.pointerenter(event as PointerEvent),
    )
    .on("pointerdown", (event) =>
      interactionHandlers?.pointerdown(event as PointerEvent),
    )
    .on("pointerup", (event) =>
      interactionHandlers?.pointerup(event as PointerEvent),
    )
    .on("click", (event) => interactionHandlers?.click(event as PointerEvent));
  const histogramGroup = svg
    .append("g")
    .attr(
      "transform",
      `translate(${CHART_MARGIN.left + MAIN_WIDTH + HISTOGRAM_GAP}, ${CHART_MARGIN.top})`,
    );

  scene = {
    svg,
    defs,
    mainGroup,
    plotGroup,
    interactionLayer,
    histogramGroup,
  };
  return scene;
};

const clearDynamicScene = (sceneHandles: SceneHandles): void => {
  histogramTooltip.value = null;
  payoffBinTooltip.value = null;
  emit("histogram-bin-hover", null);
  sceneHandles.defs.selectAll("*").remove();
  sceneHandles.plotGroup.selectAll("*").remove();
  sceneHandles.histogramGroup.selectAll("*").remove();
  // Forward/cone value labels are attached at root SVG level.
  sceneHandles.svg.selectAll(".forward-value-label").remove();
  sceneHandles.svg.selectAll(".break-even-region").remove();
  sceneHandles.svg.selectAll(".ev-contribution-chart").remove();
};

type PayoffChartPoint = {
  priceMin: number;
  priceMax: number;
  terminalPrice: number;
  value: number;
};

const payoffPointsFromBins = (
  bins: SimBin[],
  totalCount: number,
  displayMode: "payoff" | "frequency",
): PayoffChartPoint[] =>
  bins.flatMap((bin) =>
    bin.count > 0
      ? [
          {
            priceMin: bin.x0,
            priceMax: bin.x1,
            terminalPrice: (bin.x0 + bin.x1) * 0.5,
            value: computePayoffBinValue(
              bin.sumPayoff,
              bin.count,
              totalCount,
              displayMode,
            ),
          },
        ]
      : [],
  );

const renderCumulativePayoffChart = (
  svg: d3.Selection<SVGSVGElement, unknown, null, undefined>,
  sim: SimComputation,
  comparisonSim: SimComputation,
): void => {
  const sharedPoints = smoothSharedTerminalCumulativeSeries(
    buildSharedTerminalCumulativeSeries(
      sim.terminalPrices,
      sim.terminalPayoffs,
      comparisonSim.terminalPayoffs,
    ),
  );
  const optionPoints = sharedPoints.map((point) => ({
    terminalPrice: point.terminalPrice,
    contribution: point.primaryContribution,
  }));
  const perpPoints = sharedPoints.map((point) => ({
    terminalPrice: point.terminalPrice,
    contribution: point.comparisonContribution,
  }));
  if (!optionPoints.length || !perpPoints.length) return;

  const optionColor = "#9bcdf3";
  const perpColor = "#f2ad67";
  const chartMargin = { top: 76, right: 128, bottom: 60, left: 82 };
  const plotWidth = CHART_WIDTH - chartMargin.left - chartMargin.right;
  const plotHeight =
    CUMUL_CHART_HEIGHT - chartMargin.top - chartMargin.bottom;
  const allPoints = [...optionPoints, ...perpPoints];
  const rawXMin = Math.min(...allPoints.map((point) => point.terminalPrice));
  const rawXMax = Math.max(...allPoints.map((point) => point.terminalPrice));
  const rawYMin = Math.min(
    0,
    ...allPoints.map((point) => point.contribution),
  );
  const rawYMax = Math.max(
    0,
    ...allPoints.map((point) => point.contribution),
  );
  const xPadding = Math.max(1, (rawXMax - rawXMin) * 0.045);
  const yPadding = Math.max(1, (rawYMax - rawYMin) * 0.08);
  const xScale = d3
    .scaleLinear()
    .domain([rawXMin - xPadding, rawXMax + xPadding])
    .range([0, plotWidth]);
  const yScale = d3
    .scaleLinear()
    .domain([rawYMin - yPadding, rawYMax + yPadding])
    .range([plotHeight, 0]);
  const xTicks = xScale.ticks(6);
  const yTicks = yScale.ticks(5);

  const chart = svg
    .append("g")
    .attr("class", "ev-contribution-chart ev-cumulative-chart")
    .attr("transform", `translate(${chartMargin.left}, ${chartMargin.top})`);
  const chartKey = Math.abs(
    Math.round((sim.meanPayoff + comparisonSim.meanPayoff) * 100),
  );
  const clipId = `ev-cumulative-clip-${chartKey}`;
  chart
    .append("defs")
    .append("clipPath")
    .attr("id", clipId)
    .append("rect")
    .attr("width", plotWidth)
    .attr("height", plotHeight);

  const grid = chart.append("g").attr("class", "ev-grid");
  for (const tick of xTicks) {
    grid
      .append("line")
      .attr("x1", xScale(tick))
      .attr("x2", xScale(tick))
      .attr("y1", 0)
      .attr("y2", plotHeight);
  }
  for (const tick of yTicks) {
    grid
      .append("line")
      .attr("x1", 0)
      .attr("x2", plotWidth)
      .attr("y1", yScale(tick))
      .attr("y2", yScale(tick));
  }
  chart
    .append("line")
    .attr("class", "ev-zero-line")
    .attr("x1", 0)
    .attr("x2", plotWidth)
    .attr("y1", yScale(0))
    .attr("y2", yScale(0));
  chart
    .append("line")
    .attr("class", "ev-zero-line")
    .attr("x1", xScale(0))
    .attr("x2", xScale(0))
    .attr("y1", 0)
    .attr("y2", plotHeight);

  const area = d3
    .area<(typeof optionPoints)[number]>()
    .x((point) => xScale(point.terminalPrice))
    .y0(yScale(0))
    .y1((point) => yScale(point.contribution))
    .curve(d3.curveBasis);
  const line = d3
    .line<(typeof optionPoints)[number]>()
    .x((point) => xScale(point.terminalPrice))
    .y((point) => yScale(point.contribution))
    .curve(d3.curveBasis);
  const seriesGroup = chart
    .append("g")
    .attr("clip-path", `url(#${clipId})`);
  [
    { className: "perp", points: perpPoints, color: perpColor },
    { className: "option", points: optionPoints, color: optionColor },
  ].forEach(({ className, points, color }) => {
    seriesGroup
      .append("path")
      .attr("class", `ev-area ev-area--${className}`)
      .attr("d", area(points))
      .attr("fill", color)
      .attr("fill-opacity", className === "option" ? 0.18 : 0.13);
    seriesGroup
      .append("path")
      .attr("class", `ev-line ev-line--${className}`)
      .attr("d", line(points))
      .attr("stroke", color);
  });

  const axis = chart.append("g").attr("class", "ev-axis");
  for (const tick of xTicks) {
    axis
      .append("text")
      .attr("x", xScale(tick))
      .attr("y", plotHeight + 22)
      .attr("text-anchor", "middle")
      .text(formatTooltipPrice(tick));
  }
  for (const tick of yTicks) {
    axis
      .append("text")
      .attr("x", -12)
      .attr("y", yScale(tick))
      .attr("text-anchor", "end")
      .attr("dominant-baseline", "middle")
      .text(formatTooltipPayoff(tick));
  }
  chart
    .append("text")
    .attr("class", "ev-axis-title")
    .attr("x", plotWidth * 0.5)
    .attr("y", plotHeight + 49)
    .attr("text-anchor", "middle")
    .text("Terminal BTC price");
  chart
    .append("text")
    .attr("class", "ev-axis-title")
    .attr("transform", `translate(${-64}, ${plotHeight * 0.5}) rotate(-90)`)
    .attr("text-anchor", "middle")
    .text("Cumulative EV contribution");

  const titleGroup = svg
    .append("g")
    .attr("class", "ev-contribution-chart ev-chart-heading");
  titleGroup
    .append("text")
    .attr("class", "ev-title")
    .attr("x", chartMargin.left)
    .attr("y", 23)
    .text("Cumulative EV contribution");
  titleGroup
    .append("text")
    .attr("class", "ev-subtitle")
    .attr("x", chartMargin.left)
    .attr("y", 41)
    .text("Shared paths sorted by terminal BTC price · smoothed display · exact EV endpoints");
  if (props.payoffChartContext) {
    titleGroup
      .append("text")
      .attr("class", "ev-subtitle ev-context")
      .attr("x", chartMargin.left)
      .attr("y", 57)
      .text(props.payoffChartContext);
  }

  const endpointLabels = [
    {
      point: optionPoints[optionPoints.length - 1],
      color: optionColor,
      label: `Option MC mean ${formatTooltipPayoff(sim.meanPayoff)}`,
    },
    {
      point: perpPoints[perpPoints.length - 1],
      color: perpColor,
      label: `Perp MC mean ${formatTooltipPayoff(comparisonSim.meanPayoff)}`,
    },
  ].map(({ point, color, label }) => {
    const pointY = yScale(point.contribution);
    return { point, color, label, pointY, labelY: pointY };
  });
  const labelsByHeight = [...endpointLabels].sort(
    (first, second) => first.pointY - second.pointY,
  );
  const minimumLabelGap = 22;
  if (
    labelsByHeight.length === 2 &&
    labelsByHeight[1].labelY - labelsByHeight[0].labelY < minimumLabelGap
  ) {
    const center =
      (labelsByHeight[0].pointY + labelsByHeight[1].pointY) * 0.5;
    let upperY = Math.max(10, center - minimumLabelGap * 0.5);
    let lowerY = upperY + minimumLabelGap;
    if (lowerY > plotHeight - 10) {
      lowerY = plotHeight - 10;
      upperY = lowerY - minimumLabelGap;
    }
    labelsByHeight[0].labelY = upperY;
    labelsByHeight[1].labelY = lowerY;
  }

  endpointLabels.forEach(({ point, color, label, pointY, labelY }) => {
    const endpointX = xScale(point.terminalPrice);
    chart
      .append("circle")
      .attr("class", "ev-endpoint")
      .attr("cx", endpointX)
      .attr("cy", pointY)
      .attr("r", 3.5)
      .attr("fill", color);
    if (Math.abs(labelY - pointY) > 2) {
      chart
        .append("line")
        .attr("class", "ev-endpoint-leader")
        .attr("x1", endpointX + 4)
        .attr("x2", endpointX + 8)
        .attr("y1", pointY)
        .attr("y2", labelY)
        .attr("stroke", color);
    }
    chart
      .append("text")
      .attr("class", "ev-endpoint-label")
      .attr("x", endpointX + 9)
      .attr("y", labelY)
      .attr("dominant-baseline", "middle")
      .attr("fill", color)
      .text(label);
  });
};

const renderPayoffComparisonChart = (
  svg: d3.Selection<SVGSVGElement, unknown, null, undefined>,
  sim: SimComputation,
  comparisonSim: SimComputation,
  displayMode: "payoff" | "frequency",
): void => {
  const optionPoints = payoffPointsFromBins(sim.bins, sim.rows, displayMode);
  const perpPoints = payoffPointsFromBins(
    comparisonSim.bins,
    comparisonSim.rows,
    displayMode,
  );
  if (!optionPoints.length || !perpPoints.length) return;

  const optionColor = "#9bcdf3";
  const perpColor = "#f2ad67";
  const chartMargin = { top: 76, right: 48, bottom: 60, left: 82 };
  const plotWidth = CHART_WIDTH - chartMargin.left - chartMargin.right;
  const plotHeight = 300;
  const allPoints = [...optionPoints, ...perpPoints];
  const rawXMin = Math.min(...allPoints.map((point) => point.terminalPrice));
  const rawXMax = Math.max(...allPoints.map((point) => point.terminalPrice));
  const xPadding = Math.max(1, (rawXMax - rawXMin) * 0.035);
  const rawYMin = Math.min(0, ...allPoints.map((point) => point.value));
  const rawYMax = Math.max(0, ...allPoints.map((point) => point.value));
  const yPadding = Math.max(1, (rawYMax - rawYMin) * 0.1);
  const xScale = d3
    .scaleLinear()
    .domain([rawXMin - xPadding, rawXMax + xPadding])
    .range([0, plotWidth]);
  const yScale = d3
    .scaleLinear()
    .domain([rawYMin - yPadding, rawYMax + yPadding])
    .range([plotHeight, 0]);
  const xTicks = xScale.ticks(6);
  const yTicks = yScale.ticks(5);
  const comparisonPoints: PayoffComparisonPoint[] = optionPoints.flatMap(
    (optionPoint, index) => {
      const perpPoint = perpPoints[index];
      if (
        !perpPoint ||
        Math.abs(optionPoint.priceMin - perpPoint.priceMin) > 1e-6 ||
        Math.abs(optionPoint.priceMax - perpPoint.priceMax) > 1e-6
      ) {
        return [];
      }
      return [
        {
          index,
          priceMin: optionPoint.priceMin,
          priceMax: optionPoint.priceMax,
          optionValue: optionPoint.value,
          perpValue: perpPoint.value,
          difference: optionPoint.value - perpPoint.value,
        },
      ];
    },
  );

  const chart = svg
    .append("g")
    .attr("class", "ev-contribution-chart ev-bin-bar-chart")
    .attr("transform", `translate(${chartMargin.left}, ${chartMargin.top})`);

  const chartKey = Math.abs(
    Math.round((sim.meanPayoff + comparisonSim.meanPayoff) * 100),
  );
  const clipId = `ev-contribution-clip-${chartKey}`;
  chart
    .append("defs")
    .append("clipPath")
    .attr("id", clipId)
    .append("rect")
    .attr("width", plotWidth)
    .attr("height", plotHeight);
  chart
    .append("line")
    .attr("class", "ev-zero-line")
    .attr("x1", 0)
    .attr("x2", plotWidth)
    .attr("y1", yScale(0))
    .attr("y2", yScale(0));
  const seriesGroup = chart
    .append("g")
    .attr("clip-path", `url(#${clipId})`);

  const barSeries = [
    {
      className: "option",
      value: (point: PayoffComparisonPoint) => point.optionValue,
      color: optionColor,
      opacity: 0.8,
    },
    {
      className: "perp",
      value: (point: PayoffComparisonPoint) => point.perpValue,
      color: perpColor,
      opacity: 0.68,
    },
  ];
  barSeries.forEach(({ className, value, color, opacity }) => {
    seriesGroup
      .append("g")
      .attr("class", `ev-bin-bars ev-bin-bars--${className}`)
      .selectAll("rect")
      .data(comparisonPoints)
      .join("rect")
      .attr("x", (point) => xScale(point.priceMin) + 0.35)
      .attr("width", (point) =>
        Math.max(1, xScale(point.priceMax) - xScale(point.priceMin) - 0.7),
      )
      .attr("y", (point) => yScale(Math.max(0, value(point))))
      .attr("height", (point) =>
        Math.max(0.75, Math.abs(yScale(value(point)) - yScale(0))),
      )
      .attr("fill", color)
      .attr("fill-opacity", opacity)
      .attr("stroke", color)
      .attr("stroke-opacity", 0.45)
      .attr("stroke-width", 0.45);
  });

  const setActivePayoffBin = (index: number | null): void => {
    svg
      .selectAll<SVGRectElement, PayoffComparisonPoint>(".ev-bin-bars rect")
      .classed("is-hovered", (point) => index != null && point.index === index)
      .classed("is-dimmed", (point) => index != null && point.index !== index);
  };

  chart
    .append("g")
    .attr("class", "ev-bin-hover-layer")
    .selectAll("rect")
    .data(comparisonPoints)
    .join("rect")
    .attr("x", (point) => xScale(point.priceMin))
    .attr("width", (point) =>
      Math.max(1, xScale(point.priceMax) - xScale(point.priceMin)),
    )
    .attr("y", 0)
    .attr("height", plotHeight)
    .attr("fill", "transparent")
    .style("pointer-events", "all")
    .style("cursor", "crosshair")
    .on("pointerenter", (event, point) => {
      setActivePayoffBin(point.index);
      showPayoffBinTooltip(event as PointerEvent, point, displayMode);
    })
    .on("pointermove", (event, point) =>
      showPayoffBinTooltip(event as PointerEvent, point, displayMode),
    )
    .on("pointerleave", () => {
      setActivePayoffBin(null);
      payoffBinTooltip.value = null;
    });

  const axis = chart.append("g").attr("class", "ev-axis");
  for (const tick of xTicks) {
    axis
      .append("text")
      .attr("x", xScale(tick))
      .attr("y", plotHeight + 22)
      .attr("text-anchor", "middle")
      .text(formatTooltipPrice(tick));
  }
  for (const tick of yTicks) {
    axis
      .append("text")
      .attr("x", -12)
      .attr("y", yScale(tick))
      .attr("text-anchor", "end")
      .attr("dominant-baseline", "middle")
      .text(formatTooltipPayoff(tick));
  }
  axis
    .append("text")
    .attr("class", "ev-axis-title")
    .attr("x", plotWidth * 0.5)
    .attr("y", plotHeight + 47)
    .attr("text-anchor", "middle")
    .text("Terminal BTC price");
  chart
    .append("text")
    .attr("class", "ev-axis-title")
    .attr("transform", `translate(${-64}, ${plotHeight * 0.5}) rotate(-90)`)
    .attr("text-anchor", "middle")
    .text(displayMode === "frequency" ? "EV contribution" : "Mean P&L");

  const titleGroup = svg
    .append("g")
    .attr("class", "ev-contribution-chart ev-chart-heading");
  titleGroup
    .append("text")
    .attr("class", "ev-title")
    .attr("x", chartMargin.left + 4)
    .attr("y", 23)
    .text(
      displayMode === "frequency"
        ? "Frequency × payoff by terminal BTC price bin"
        : "Mean P&L by terminal BTC price bin",
    );
  titleGroup
    .append("text")
    .attr("class", "ev-subtitle")
    .attr("x", chartMargin.left + 4)
    .attr("y", 41)
    .text(
      displayMode === "frequency"
        ? "Sum of path P&L in each terminal-price bin ÷ all simulated paths"
        : "Option and perpetual-with-stop outcomes overlaid · each bar is the bin mean",
    );
  if (props.payoffChartContext) {
    titleGroup
      .append("text")
      .attr("class", "ev-subtitle ev-context")
      .attr("x", chartMargin.left + 4)
      .attr("y", 57)
      .text(props.payoffChartContext);
  }

  const stopPrice = Number(props.comparisonReferencePrice);
  const legend = titleGroup
    .append("g")
    .attr("transform", `translate(${CHART_WIDTH - 355}, 20)`);
  [
    { label: "Option P&L", color: optionColor, x: 0 },
    {
      label: Number.isFinite(stopPrice)
        ? `Perp + stop @ ${formatTooltipPrice(stopPrice)}`
        : "Perp + stop",
      color: perpColor,
      x: 112,
    },
  ].forEach(({ label, color, x }) => {
    legend
      .append("rect")
      .attr("x", x)
      .attr("y", -5)
      .attr("width", 15)
      .attr("height", 10)
      .attr("fill", color)
      .attr("fill-opacity", 0.8);
    legend
      .append("text")
      .attr("x", x + 20)
      .attr("y", 0)
      .attr("dominant-baseline", "middle")
      .text(label);
  });

  const differencePoints = comparisonPoints;
  const panelHeight = 178;
  const differenceValues = differencePoints.map((point) => point.difference);
  const differenceMin = Math.min(0, ...differenceValues);
  const differenceMax = Math.max(0, ...differenceValues);
  const differenceSpan = Math.max(1, differenceMax - differenceMin);
  const differenceY = d3
    .scaleLinear()
    .domain([
      differenceMin - differenceSpan * 0.08,
      differenceMax + differenceSpan * 0.08,
    ])
    .range([panelHeight, 0]);
  const differencePanel = svg
    .append("g")
    .attr("class", "ev-contribution-chart ev-difference-panel")
    .attr("transform", `translate(${chartMargin.left}, 475)`);
  differencePanel
    .append("text")
    .attr("class", "ev-panel-title")
    .attr("x", 0)
    .attr("y", -12)
    .text(
      displayMode === "frequency"
        ? "Option − perp · EV contribution difference by terminal bin"
        : "Option − perp · mean P&L difference by terminal bin",
    );
  differencePanel
    .append("text")
    .attr("class", "ev-panel-caption")
    .attr("x", plotWidth)
    .attr("y", -12)
    .attr("text-anchor", "end")
    .text("Blue: option advantage · orange: perp advantage");
  differencePanel
    .append("line")
    .attr("class", "ev-zero-line")
    .attr("x1", 0)
    .attr("x2", plotWidth)
    .attr("y1", differenceY(0))
    .attr("y2", differenceY(0));
  differencePanel
    .append("g")
    .attr("class", "ev-bin-bars ev-bin-bars--difference")
    .selectAll("rect")
    .data(differencePoints)
    .join("rect")
    .attr("x", (point) => xScale(point.priceMin) + 0.35)
    .attr("width", (point) =>
      Math.max(1, xScale(point.priceMax) - xScale(point.priceMin) - 0.7),
    )
    .attr("y", (point) => differenceY(Math.max(0, point.difference)))
    .attr("height", (point) =>
      Math.max(
        0.75,
        Math.abs(differenceY(point.difference) - differenceY(0)),
      ),
    )
    .attr("fill", (point) =>
      point.difference >= 0 ? optionColor : perpColor,
    )
    .attr("fill-opacity", 0.78)
    .attr("stroke", (point) =>
      point.difference >= 0 ? optionColor : perpColor,
    )
    .attr("stroke-opacity", 0.5)
    .attr("stroke-width", 0.45);

  differencePanel
    .append("g")
    .attr("class", "ev-bin-hover-layer")
    .selectAll("rect")
    .data(differencePoints)
    .join("rect")
    .attr("x", (point) => xScale(point.priceMin))
    .attr("width", (point) =>
      Math.max(1, xScale(point.priceMax) - xScale(point.priceMin)),
    )
    .attr("y", 0)
    .attr("height", panelHeight)
    .attr("fill", "transparent")
    .style("pointer-events", "all")
    .style("cursor", "crosshair")
    .on("pointerenter", (event, point) => {
      setActivePayoffBin(point.index);
      showPayoffBinTooltip(event as PointerEvent, point, displayMode);
    })
    .on("pointermove", (event, point) =>
      showPayoffBinTooltip(event as PointerEvent, point, displayMode),
    )
    .on("pointerleave", () => {
      setActivePayoffBin(null);
      payoffBinTooltip.value = null;
    });

  const differenceAxis = differencePanel.append("g").attr("class", "ev-axis");
  for (const tick of differenceY.ticks(4)) {
    differenceAxis
      .append("text")
      .attr("x", -12)
      .attr("y", differenceY(tick))
      .attr("text-anchor", "end")
      .attr("dominant-baseline", "middle")
      .text(formatTooltipPayoff(tick));
  }
  for (const tick of xTicks) {
    differenceAxis
      .append("text")
      .attr("x", xScale(tick))
      .attr("y", panelHeight + 19)
      .attr("text-anchor", "middle")
      .text(formatTooltipPrice(tick));
  }
  differencePanel
    .append("text")
    .attr("class", "ev-axis-title")
    .attr("x", plotWidth * 0.5)
    .attr("y", panelHeight + 42)
    .attr("text-anchor", "middle")
    .text("Terminal BTC price");

};

const updateDynamicScene = (
  sceneHandles: SceneHandles,
  canvas: HTMLCanvasElement,
  canvasCtx: CanvasRenderingContext2D,
  sim: SimComputation,
  comparisonSim: SimComputation | null = null,
): void => {
  const { svg, defs, plotGroup, interactionLayer, histogramGroup } =
    sceneHandles;
  let trackingMode = false;
  let isDraggingVol = false;
  let suppressClick = false;
  let isPointerDown = false;
  let dragMu = 0;
  let driftHover = false;
  if (cloudRevealRaf != null) {
    cancelAnimationFrame(cloudRevealRaf);
    cloudRevealRaf = null;
  }
  clearDynamicScene(sceneHandles);
  interactionLayer.style("pointer-events", "all");

  const payoffDisplayMode = comparisonSim ? props.payoffDisplayMode : undefined;
  const payoffChartMode = props.payoffChartMode ?? "terminal";
  const payoffModeActive = payoffDisplayMode != null;
  const width = CHART_WIDTH;
  const height = payoffModeActive
    ? payoffChartMode === "terminal"
      ? TERMINAL_CHART_HEIGHT
      : CUMUL_CHART_HEIGHT
    : CHART_HEIGHT;
  const margin = CHART_MARGIN;
  const histogramWidth = HISTOGRAM_WIDTH;
  const mainWidth = MAIN_WIDTH;
  const mainHeight = MAIN_HEIGHT;
  const deviceScale = Math.max(1, window.devicePixelRatio || 1);
  const backingWidth = Math.max(1, Math.round(width * deviceScale));
  const backingHeight = Math.max(1, Math.round(height * deviceScale));
  const scaleX = deviceScale;
  const scaleY = deviceScale;
  const transformDirty =
    canvasTransformCache.canvas !== canvas ||
    canvasTransformCache.backingWidth !== backingWidth ||
    canvasTransformCache.backingHeight !== backingHeight ||
    canvasTransformCache.scaleX !== scaleX ||
    canvasTransformCache.scaleY !== scaleY;
  if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
    canvas.width = backingWidth;
    canvas.height = backingHeight;
  }
  if (transformDirty) {
    canvasCtx.setTransform(scaleX, 0, 0, scaleY, 0, 0);
    canvasTransformCache = {
      canvas,
      backingWidth,
      backingHeight,
      scaleX,
      scaleY,
    };
  }
  canvasCtx.clearRect(0, 0, width, height);
  canvas.style.transform = "none";
  canvas.style.opacity = "1";
  canvas.style.transformOrigin = "0 0";

  const baseline = props.params.s0;
  const histogramMode = props.histMode ?? "payoff";
  const {
    steps,
    rows: totalPathCount,
    samplePaths: paths,
    sampledFinalPrices,
    sampledPayoffs,
    bins,
    pathMin,
    pathMax,
    finalPriceMin,
    finalPriceMax,
    payoffMin,
    payoffMax,
    meanPayoff,
    medianPayoff,
  } = sim;
  svg.attr(
    "viewBox",
    `0 0 ${CHART_WIDTH} ${height}`,
  );
  if (payoffDisplayMode && comparisonSim) {
    interactionHandlers = null;
    interactionLayer.style("pointer-events", "none");
    if (payoffChartMode === "cumulative") {
      renderCumulativePayoffChart(svg, sim, comparisonSim);
    } else {
      renderPayoffComparisonChart(
        svg,
        sim,
        comparisonSim,
        payoffDisplayMode,
      );
    }
    return;
  }
  const optionBreakEvenPrices = computeBreakEvenPrices(bins);
  const comparisonReferencePrice = Number(props.comparisonReferencePrice);
  const breakEvenPrices =
    comparisonSim &&
    optionBreakEvenPrices.length &&
    Number.isFinite(comparisonReferencePrice)
      ? [optionBreakEvenPrices[0], comparisonReferencePrice]
      : comparisonSim
        ? []
        : optionBreakEvenPrices;

  const maxDelta = Math.max(
    Math.abs(pathMin - baseline),
    Math.abs(pathMax - baseline),
  );
  const paddedDelta = maxDelta * 1.02;
  const safeDelta =
    Number.isFinite(paddedDelta) && paddedDelta > 0 ? paddedDelta : 1;
  const targetDomain: [number, number] = [
    baseline - safeDelta,
    baseline + safeDelta,
  ];
  const y = d3.scaleLinear().domain(targetDomain).range([mainHeight, 0]);

  const x = d3.scaleLinear().domain([0, steps]).range([0, mainWidth]);
  const binMin = targetDomain[0];
  const binMax = targetDomain[1];

  const negSpan = Math.abs(Math.min(payoffMin, 0));
  const posSpan = Math.max(payoffMax, 0);
  // Piecewise side scaling:
  // negatives map across the lower half, positives across the upper half,
  // so each side keeps contrast even when payoff tails are asymmetric.
  const colorMin = clamp(props.colorMin ?? COLOR_T_MIN, 0, 1);
  const colorMax = clamp(props.colorMax ?? COLOR_T_MAX, 0, 1);
  const resolvedMin = Math.min(colorMin, colorMax);
  const resolvedMax = Math.max(colorMin, colorMax);
  const colorMid = clamp((resolvedMin + resolvedMax) / 2, 0, 1);
  const negPayoffColorT = d3
    .scaleLinear()
    .domain([-Math.max(negSpan, 1e-9), 0])
    .range([resolvedMin, colorMid])
    .clamp(true);
  const posPayoffColorT = d3
    .scaleLinear()
    .domain([0, Math.max(posSpan, 1e-9)])
    .range([colorMid, resolvedMax])
    .clamp(true);
  const payoffColorRamp = (value: number): string => {
    const t =
      value < 0
        ? negPayoffColorT(value)
        : value > 0
          ? posPayoffColorT(value)
          : colorMid;
    return d3.interpolateRdBu(t);
  };
  const priceFormat = d3.format(".2s");
  const payoffFormat = d3.format(".2s");

  const drawCloudPath = (
    path: Float64Array,
    fill: string,
    opacity: number,
  ): void => {
    if (!path.length) return;
    canvasCtx.save();
    canvasCtx.translate(margin.left, margin.top);
    canvasCtx.beginPath();
    canvasCtx.moveTo(x(0), y(baseline));
    for (let i = 0; i < path.length; i += 1) {
      canvasCtx.lineTo(x(i + 1), y(path[i]));
    }
    canvasCtx.lineTo(x(steps), y(baseline));
    canvasCtx.closePath();
    canvasCtx.fillStyle = fill;
    canvasCtx.globalAlpha = opacity;
    canvasCtx.fill();
    canvasCtx.restore();
  };

  const stopLeg = props.comparisonLegs?.find(
    (leg): leg is Extract<PositionLeg, { kind: "future" }> =>
      leg.kind === "future" &&
      leg.stopLoss != null &&
      Number.isFinite(leg.stopLoss),
  );
  const stoppedPaths = stopLeg
    ? paths.flatMap((path, pathIndex) => {
        let stopStep = -1;
        for (let step = 0; step < path.length; step += 1) {
          const price = path[step];
          const hit =
            stopLeg.side === "buy"
              ? price <= Number(stopLeg.stopLoss)
              : price >= Number(stopLeg.stopLoss);
          if (hit) {
            stopStep = step;
            break;
          }
        }
        if (stopStep < 0) return [];
        const sign = stopLeg.side === "buy" ? 1 : -1;
        const entry = Number.isFinite(stopLeg.entry)
          ? stopLeg.entry
          : baseline;
        const stopPrice = Number(stopLeg.stopLoss);
        const fundedYears = (stopStep + 1) * props.params.dt;
        const funding =
          sign *
          stopLeg.qty *
          entry *
          Number(stopLeg.annualFundingRate ?? 0) *
          fundedYears;
        const payoff =
          sign * stopLeg.qty * (stopPrice - entry) - funding;
        const finalPrice = sampledFinalPrices[pathIndex] ?? baseline;
        return [
          {
            pathIndex,
            stopStep,
            payoff,
            finalPrice,
            opportunityCost:
              sign * stopLeg.qty * (finalPrice - stopPrice),
          },
        ];
      })
    : [];
  const stoppedPathIndices = stoppedPaths.map(({ pathIndex }) => pathIndex);
  const highestFinishingStoppedPath = stoppedPaths.length
    ? stoppedPaths.reduce((highest, candidate) =>
        candidate.finalPrice > highest.finalPrice ? candidate : highest,
      )
    : null;
  emit(
    "stop-path-update",
    highestFinishingStoppedPath
      ? {
          stoppedPathCount: stoppedPaths.length,
          sampledPathCount: paths.length,
          highlightedLoss: highestFinishingStoppedPath.payoff,
          stopDay:
            (highestFinishingStoppedPath.stopStep + 1) *
            props.params.dt *
            365.25,
          finalPrice: highestFinishingStoppedPath.finalPrice,
          opportunityCost: highestFinishingStoppedPath.opportunityCost,
        }
      : null,
  );
  const activeCloudIndices =
    props.pathFilter === "stopped" ? stoppedPathIndices : d3.range(paths.length);
  if (
    props.pathFilter === "stopped" &&
    highestFinishingStoppedPath != null
  ) {
    const highlightedPath =
      paths[highestFinishingStoppedPath.pathIndex];
    const highlightValues = [baseline, ...highlightedPath];
    const highlightLine = d3
      .line<number>()
      .x((_value, index) => x(index))
      .y((value) => y(value));
    plotGroup
      .append("path")
      .attr("class", "stopped-path-highlight")
      .attr("d", highlightLine(highlightValues));

    const stopStep = highestFinishingStoppedPath.stopStep;
    const beforeStop = stopStep === 0
      ? baseline
      : highlightedPath[stopStep - 1];
    const afterStop = highlightedPath[stopStep];
    const stopPrice = Number(stopLeg?.stopLoss);
    const crossingProgress =
      Number.isFinite(beforeStop) &&
      Number.isFinite(afterStop) &&
      Number.isFinite(stopPrice) &&
      afterStop !== beforeStop
        ? clamp((stopPrice - beforeStop) / (afterStop - beforeStop), 0, 1)
        : 1;
    plotGroup
      .append("circle")
      .attr("class", "stopped-path-marker")
      .attr("cx", x(stopStep + crossingProgress))
      .attr("cy", y(stopPrice))
      .attr("r", 2.4);
  }

  const baselineY = y(baseline);

  const maxElapsed = steps * props.params.dt;
  const coneGradientId = `mu-cone-gradient-${props.seed}`;
  const coneGradient = defs
    .append("linearGradient")
    .attr("id", coneGradientId)
    .attr("gradientUnits", "userSpaceOnUse")
    .attr("x1", 0)
    .attr("y1", 0)
    .attr("x2", 0)
    .attr("y2", mainHeight);
  const coneCenter = Math.min(0.9, Math.max(0.1, baselineY / mainHeight));
  coneGradient
    .append("stop")
    .attr("offset", Math.max(0, coneCenter - 0.35))
    .attr("stop-color", "#6e8796")
    .attr("stop-opacity", 0.45);
  coneGradient
    .append("stop")
    .attr("offset", coneCenter)
    .attr("stop-color", "#8aa2b1")
    .attr("stop-opacity", 0.85);
  coneGradient
    .append("stop")
    .attr("offset", Math.min(1, coneCenter + 0.35))
    .attr("stop-color", "#6e8796")
    .attr("stop-opacity", 0.45);
  const muClipId = `mu-clip-${props.seed}`;
  defs
    .append("clipPath")
    .attr("id", muClipId)
    .attr("clipPathUnits", "userSpaceOnUse")
    .append("rect")
    .attr("x", 0)
    .attr("y", 0)
    .attr("width", mainWidth)
    .attr("height", mainHeight);

  const muGuide = plotGroup
    .append("g")
    .attr("class", "mu-guide")
    .attr("clip-path", `url(#${muClipId})`)
    .style("display", "none")
    .style("pointer-events", "none");
  const muConeFill = muGuide
    .append("path")
    .attr("class", "mu-cone-fill")
    .attr("fill", `url(#${coneGradientId})`)
    .attr("fill-opacity", 0.4);
  const muConeUpper = muGuide.append("path").attr("class", "mu-cone-edge");
  const muConeLower = muGuide.append("path").attr("class", "mu-cone-edge");
  const muLine = muGuide
    .append("line")
    .attr("x1", 0)
    .attr("y1", baselineY)
    .attr("x2", mainWidth)
    .attr("y2", baselineY);
  interactionLayer.raise();

  // Meta labels (μ, σ, n) and horizon label are now rendered in HTML header

  const forwardValueLabel = svg
    .append("text")
    .attr("class", "forward-value-label")
    .attr("text-anchor", "start")
    .attr("dominant-baseline", "middle");

  const coneUpperLabel = svg
    .append("text")
    .attr("class", "forward-value-label")
    .attr("text-anchor", "start")
    .attr("dominant-baseline", "middle")
    .style("display", "none");

  const coneLowerLabel = svg
    .append("text")
    .attr("class", "forward-value-label")
    .attr("text-anchor", "start")
    .attr("dominant-baseline", "middle")
    .style("display", "none");

  const updateForwardLabels = (mu: number, vol: number): void => {
    const forward = baseline * Math.exp(mu * maxElapsed);
    const band = vol * Math.sqrt(maxElapsed);
    const upper = forward * Math.exp(band);
    const lower = forward * Math.exp(-band);

    if (!Number.isFinite(forward) || forward <= 0) {
      forwardValueLabel.style("display", "none");
    } else {
      const rawY = y(forward);
      if (!Number.isFinite(rawY) || rawY < -50 || rawY > mainHeight + 50) {
        forwardValueLabel.style("display", "none");
      } else {
        const forwardY = Math.max(6, Math.min(mainHeight - 6, rawY));
        forwardValueLabel
          .style("display", null)
          .attr("x", margin.left + mainWidth + 6)
          .attr("y", margin.top + forwardY)
          .text(priceFormat(forward));
      }
    }

    // Upper cone label (+1 std dev)
    if (!Number.isFinite(upper) || upper <= 0) {
      coneUpperLabel.style("display", "none");
    } else {
      const rawUpperY = y(upper);
      if (
        !Number.isFinite(rawUpperY) ||
        rawUpperY < -50 ||
        rawUpperY > mainHeight + 50
      ) {
        coneUpperLabel.style("display", "none");
      } else {
        const upperY = Math.max(6, Math.min(mainHeight - 6, rawUpperY));
        coneUpperLabel
          .style("display", null)
          .attr("x", margin.left + mainWidth + 6)
          .attr("y", margin.top + upperY)
          .text(priceFormat(upper));
      }
    }

    // Lower cone label (-1 std dev)
    if (!Number.isFinite(lower) || lower <= 0) {
      coneLowerLabel.style("display", "none");
    } else {
      const rawLowerY = y(lower);
      if (
        !Number.isFinite(rawLowerY) ||
        rawLowerY < -50 ||
        rawLowerY > mainHeight + 50
      ) {
        coneLowerLabel.style("display", "none");
      } else {
        const lowerY = Math.max(6, Math.min(mainHeight - 6, rawLowerY));
        coneLowerLabel
          .style("display", null)
          .attr("x", margin.left + mainWidth + 6)
          .attr("y", margin.top + lowerY)
          .text(priceFormat(lower));
      }
    }
  };

  // Bars and hover labels must share the same underlying bins. Interpolating
  // empty bins creates visible bars whose truthful tooltip value is zero.
  const displayBins = bins;
  const comparisonDisplayBins = comparisonSim?.bins ?? [];
  const countMax = d3.max(displayBins, (bin) => bin.count) || 1;
  const cloudFillOpacity = 0.5;
  const binCountMax = d3.max(bins, (bin) => bin.count) || 1;
  const opacityScale = d3
    .scaleSqrt()
    .domain([0, binCountMax])
    .range([0.2, cloudFillOpacity])
    .clamp(true);
  const activePayoffMin = Math.min(
    payoffMin,
    comparisonSim?.payoffMin ?? payoffMin,
  );
  const activePayoffMax = Math.max(
    payoffMax,
    comparisonSim?.payoffMax ?? payoffMax,
  );
  const activeMeanPayoff = meanPayoff;
  const activeMedianPayoff = medianPayoff;
  const maxAbsAvgPayoff = Math.max(
    Math.abs(activePayoffMin),
    Math.abs(activePayoffMax),
  );
  const payoffSpan =
    Number.isFinite(maxAbsAvgPayoff) && maxAbsAvgPayoff > 0
      ? maxAbsAvgPayoff * 1.1
      : 1;
  const weightedPayoffs = [
    ...displayBins.map((value) =>
      totalPathCount > 0 ? value.sumPayoff / totalPathCount : 0,
    ),
    ...comparisonDisplayBins.map((value) =>
      comparisonSim && comparisonSim.rows > 0
        ? value.sumPayoff / comparisonSim.rows
        : 0,
    ),
  ];
  const maxAbsWeightedPayoff =
    d3.max(weightedPayoffs, (value) => Math.abs(value)) || 1;
  const weightedPayoffSpan =
    Number.isFinite(maxAbsWeightedPayoff) && maxAbsWeightedPayoff > 0
      ? maxAbsWeightedPayoff * 1.1
      : 1;
  const xPriceHist = d3
    .scaleLinear()
    .domain([0, countMax])
    .range([0, PRICE_HIST_WIDTH]);
  const payoffDomainSpan =
    histogramMode === "prob" ? weightedPayoffSpan : payoffSpan;
  const xPayoffHist = d3
    .scaleLinear()
    .domain([-payoffDomainSpan, payoffDomainSpan])
    .range([0, PAYOFF_HIST_WIDTH]);
  const payoffXZero = xPayoffHist(0);
  const getMedianPayoff = (bin: SimBin): number => bin.medianPayoff;
  const getWeightedPayoff = (bin: SimBin, pathCount = totalPathCount): number =>
    pathCount > 0 ? bin.sumPayoff / pathCount : 0;
  const getPayoffColumnValue = (
    bin: SimBin,
    pathCount = totalPathCount,
  ): number =>
    histogramMode === "prob"
      ? getWeightedPayoff(bin, pathCount)
      : getMedianPayoff(bin);
  const histogramPriceFill = (bin: SimBin): string => {
    const midpoint = (bin.x0 + bin.x1) * 0.5;
    const priceT =
      binMax > binMin ? clamp((midpoint - binMin) / (binMax - binMin), 0, 1) : 0.5;
    return d3.interpolateRdBu(priceT);
  };
  // Each bin's weighted payoff is its change in cumulative EV. Give these
  // contributions their own color domain; individual P&L is much larger and
  // would wash the EV bars out toward the neutral midpoint.
  const evContributionColorT = d3
    .scaleLinear()
    .domain([-maxAbsWeightedPayoff, 0, maxAbsWeightedPayoff])
    .range([resolvedMin, colorMid, resolvedMax])
    .clamp(true);
  const histogramPayoffFill = (bin: SimBin, pathCount = totalPathCount): string => {
    const value = getPayoffColumnValue(bin, pathCount);
    return histogramMode === "prob"
      ? d3.interpolateRdBu(evContributionColorT(value))
      : payoffColorRamp(value);
  };
  const histogramOpacity = clamp(props.histogramOpacity ?? 0.9, 0, 1);
  const binCount = bins.length;
  const invBinSize =
    binCount > 0 && binMax > binMin ? binCount / (binMax - binMin) : 0;
  const findBinIndex = (value: number): number => {
    if (!Number.isFinite(value) || binCount === 0 || invBinSize <= 0) return -1;
    if (value <= binMin) return 0;
    if (value >= binMax) return binCount - 1;
    const idx = Math.floor((value - binMin) * invBinSize);
    return Math.max(0, Math.min(binCount - 1, idx));
  };
  const cloudFillForPath = (pathIndex: number): string => {
    if (histogramMode !== "prob") {
      return payoffColorRamp(sampledPayoffs[pathIndex] ?? 0);
    }
    // Match the EV bar at this path's terminal price, including its sign and
    // contribution magnitude, rather than coloring by individual path P&L.
    const bin = bins[findBinIndex(sampledFinalPrices[pathIndex])];
    return bin
      ? histogramPayoffFill(bin)
      : d3.interpolateRdBu(colorMid);
  };
  let cumulativePathCount = 0;
  const cumulativePathCounts = bins.map((bin) => {
    cumulativePathCount += bin.count;
    return cumulativePathCount;
  });
  const opacityForPath = (pathIndex: number): number => {
    const finalPrice = sampledFinalPrices[pathIndex];
    if (!Number.isFinite(finalPrice)) return cloudFillOpacity;
    const binIndex = findBinIndex(finalPrice);
    if (binIndex < 0) return cloudFillOpacity;
    return opacityScale(bins[binIndex]?.count ?? 0);
  };
  const totalCloud = paths.length;
  // Price column: bars grow rightward from x=0, scaled by bin count.
  const priceBarX = (): number => 0;
  const priceBarWidth = (bin: SimBin, progress: number): number =>
    xPriceHist(bin.count * progress);
  // Payoff column: bars extend from the payoff-zero baseline in either
  // direction depending on sign.
  const payoffBarX = (
    bin: SimBin,
    progress: number,
    pathCount = totalPathCount,
  ): number => {
    const value = getPayoffColumnValue(bin, pathCount) * progress;
    const clamped = Math.min(
      payoffDomainSpan,
      Math.max(-payoffDomainSpan, value),
    );
    return PAYOFF_HIST_OFFSET + Math.min(payoffXZero, xPayoffHist(clamped));
  };
  const payoffBarWidth = (
    bin: SimBin,
    progress: number,
    pathCount = totalPathCount,
  ): number => {
    const value = getPayoffColumnValue(bin, pathCount) * progress;
    const clamped = Math.min(
      payoffDomainSpan,
      Math.max(-payoffDomainSpan, value),
    );
    return Math.abs(xPayoffHist(clamped) - payoffXZero);
  };
  // Snap histogram bars to the pixel grid to avoid anti-aliased seams.
  const histBarTopY = (bin: SimBin): number =>
    Math.floor(y(bin.x1 ?? bin.x0 ?? baseline));
  const histBarBottomY = (bin: SimBin): number =>
    Math.ceil(y(bin.x0 ?? bin.x1 ?? baseline));
  const histBarY = (bin: SimBin): number =>
    Math.min(histBarTopY(bin), histBarBottomY(bin));
  const histBarHeight = (bin: SimBin): number =>
    Math.max(1, Math.abs(histBarBottomY(bin) - histBarTopY(bin)));

  const safeFinalMin = Number.isFinite(finalPriceMin)
    ? finalPriceMin
    : baseline;
  const safeFinalMax = Number.isFinite(finalPriceMax)
    ? finalPriceMax
    : baseline;
  const dataTopY = y(safeFinalMax); // max price -> top of histogram data
  const dataBottomY = y(safeFinalMin); // min price -> bottom of histogram data

  const comparisonPathCount = comparisonSim?.rows ?? totalPathCount;
  const cumulativeEV = histogramMode === "prob" && !comparisonSim
    ? buildBinnedCumulativeEV(bins, totalPathCount)
    : [];

  const primaryPriceBars = histogramGroup
    .selectAll(".hist-bar--price-primary")
    .data(displayBins)
    .join("rect")
    .attr("class", "hist-bar hist-bar--price-primary")
    .attr("x", priceBarX())
    .attr("y", (d) => histBarY(d))
    .attr("height", (d) => histBarHeight(d))
    .attr("width", 0)
    .attr("fill", (d) => histogramPriceFill(d))
    .attr("fill-opacity", histogramOpacity)
    .attr("shape-rendering", "crispEdges");

  const comparisonPriceBars = histogramGroup
    .selectAll(".hist-bar--price-comparison")
    .data(comparisonDisplayBins)
    .join("rect")
    .attr("class", "hist-bar hist-bar--price-comparison")
    .attr("x", priceBarX())
    .attr("y", (d) => histBarY(d))
    .attr("height", (d) => histBarHeight(d))
    .attr("width", 0)
    .attr("fill", (d) => histogramPriceFill(d))
    .attr("fill-opacity", histogramOpacity * 0.55)
    .attr("shape-rendering", "crispEdges");

  const primaryPayoffBars = histogramGroup
    .selectAll(".hist-bar--payoff-primary")
    .data(displayBins)
    .join("rect")
    .attr("class", "hist-bar hist-bar--payoff-primary")
    .attr("x", (d) => payoffBarX(d, 0))
    .attr("y", (d) => histBarY(d))
    .attr("height", (d) => histBarHeight(d))
    .attr("width", 0)
    .attr("fill", (d) => histogramPayoffFill(d))
    .attr("fill-opacity", histogramOpacity)
    .attr("shape-rendering", "crispEdges");

  const comparisonPayoffBars = histogramGroup
    .selectAll(".hist-bar--payoff-comparison")
    .data(comparisonDisplayBins)
    .join("rect")
    .attr("class", "hist-bar hist-bar--payoff-comparison")
    .attr("x", (d) => payoffBarX(d, 0, comparisonPathCount))
    .attr("y", (d) => histBarY(d))
    .attr("height", (d) => histBarHeight(d))
    .attr("width", 0)
    .attr("fill", (d) => histogramPayoffFill(d, comparisonPathCount))
    .attr("fill-opacity", histogramOpacity * 0.55)
    .attr("shape-rendering", "crispEdges");

  // Payoff-zero baseline in the payoff column.
  histogramGroup
    .append("line")
    .attr("class", "hist-payoff-baseline")
    .attr("x1", PAYOFF_HIST_OFFSET + payoffXZero)
    .attr("x2", PAYOFF_HIST_OFFSET + payoffXZero)
    .attr("y1", Math.min(dataTopY, dataBottomY))
    .attr("y2", Math.max(dataTopY, dataBottomY));

  if (cumulativeEV.length) {
    // Scale cumulative totals separately so they do not shrink the bars.
    const cumulativeSpan =
      (d3.max(cumulativeEV, (point) => Math.abs(point.contribution)) || 1) * 1.1;
    const xCumulative = d3.scaleLinear()
      .domain([-cumulativeSpan, cumulativeSpan])
      .range([PAYOFF_HIST_OFFSET, HISTOGRAM_WIDTH]);
    const cumulativeLayer = histogramGroup.append("g")
      .attr("class", "hist-cumulative-ev")
      .style("pointer-events", "none");
    cumulativeLayer.append("path")
      .datum(cumulativeEV)
      .attr("d", d3.line<(typeof cumulativeEV)[number]>()
        .x((point) => xCumulative(point.contribution))
        .y((point) => y(point.terminalPrice)))
      .attr("fill", "none")
      .attr("stroke", "#fff")
      .attr("stroke-width", 1.25)
      .attr("stroke-linejoin", "round");
    const endpoint = cumulativeEV[cumulativeEV.length - 1];
    cumulativeLayer.append("circle")
      .attr("cx", xCumulative(endpoint.contribution))
      .attr("cy", y(endpoint.terminalPrice))
      .attr("r", 2)
      .attr("fill", "#fff");
    cumulativeLayer.append("text")
      .attr("x", xCumulative(endpoint.contribution))
      .attr("y", y(endpoint.terminalPrice) - 7)
      .attr("text-anchor", "middle")
      .attr("fill", "#fff")
      .attr("font-size", 10)
      .text(formatTooltipPayoff(endpoint.contribution));
  }

  // Axis: keep axis height aligned to histogram data range in every mode.
  const axisGroup = histogramGroup
    .append("g")
    .attr("class", "axis")
    .attr("transform", `translate(${histogramWidth + 4}, 0)`);
  const guideStartX = margin.left + mainWidth;
  const guideEndX =
    margin.left + mainWidth + HISTOGRAM_GAP + histogramWidth + 4;
  const guideLabelX = guideEndX + 8;
  const visibleBreakEvens = breakEvenPrices
    .slice(0, 2)
    .map((price) => ({ price, y: margin.top + y(price) }))
    .filter(
      ({ y: guideY }) =>
        Number.isFinite(guideY) &&
        guideY >= margin.top &&
        guideY <= margin.top + mainHeight,
    );

  /*
   * Right-gutter annotations (break-even labels) share one collision layout so
   * they don't overlap when close together.
   */
  const rightLabelPositions = new Map<string, number>();
  {
    const labelTop = margin.top + 7;
    const labelBottom = margin.top + mainHeight - 7;
    const labelCandidates = visibleBreakEvens
      .map((breakEven, index) => ({
        id: `break-even-${index}`,
        rawY: breakEven.y,
      }))
      .sort((a, b) => a.rawY - b.rawY);
    const preferredGap = 18;
    const availableGap =
      labelCandidates.length > 1
        ? (labelBottom - labelTop) / (labelCandidates.length - 1)
        : preferredGap;
    const minimumGap = Math.min(preferredGap, availableGap);
    const resolved = labelCandidates.map((candidate) =>
      Math.max(labelTop, Math.min(labelBottom, candidate.rawY)),
    );

    for (let index = 1; index < resolved.length; index += 1) {
      resolved[index] = Math.max(
        resolved[index],
        resolved[index - 1] + minimumGap,
      );
    }
    if (resolved.length && resolved[resolved.length - 1] > labelBottom) {
      resolved[resolved.length - 1] = labelBottom;
      for (let index = resolved.length - 2; index >= 0; index -= 1) {
        resolved[index] = Math.min(
          resolved[index],
          resolved[index + 1] - minimumGap,
        );
      }
    }
    labelCandidates.forEach((candidate, index) => {
      rightLabelPositions.set(candidate.id, resolved[index]);
    });
  }

  const breakEvenRegion = svg
    .append("g")
    .attr("class", "break-even-region")
    .style("pointer-events", "none");

  if (visibleBreakEvens.length === 2) {
    const [firstBreakEven, secondBreakEven] = visibleBreakEvens;
    const bandTop = Math.min(firstBreakEven.y, secondBreakEven.y);
    const bandBottom = Math.max(firstBreakEven.y, secondBreakEven.y);
    breakEvenRegion
      .append("rect")
      .attr("class", "break-even-band")
      .attr("x", guideStartX)
      .attr("y", bandTop)
      .attr("width", guideEndX - guideStartX)
      .attr("height", bandBottom - bandTop);
  }

  // In stop-loss comparison mode we still label the SVG guides so the second
  // (stop-loss) line reads clearly. In strategy mode the App renders break-even
  // prices in the header stats row, so the SVG stays uncluttered.
  if (comparisonSim) {
    visibleBreakEvens.forEach((breakEven, index) => {
      const labelY =
        rightLabelPositions.get(`break-even-${index}`) ?? breakEven.y;
      if (Math.abs(labelY - breakEven.y) > 0.5) {
        breakEvenRegion
          .append("line")
          .attr("class", "annotation-label-leader")
          .attr("x1", guideEndX)
          .attr("x2", guideLabelX - 2)
          .attr("y1", breakEven.y)
          .attr("y2", labelY);
      }
      const label = index === 1 ? "Stop-loss" : "Break-even";
      breakEvenRegion
        .append("text")
        .attr("x", guideLabelX)
        .attr("y", labelY)
        .attr("text-anchor", "start")
        .attr("dominant-baseline", "middle")
        .text(`${label} · ${priceFormat(breakEven.price)}`);
    });
  }

  // Right-hand price axis: labels the vertical extent of both histogram columns.
  const priceTicks = d3.ticks(safeFinalMin, safeFinalMax, 4);
  for (const tick of priceTicks) {
    const tickY = y(tick);
    if (tickY < dataTopY - 4 || tickY > dataBottomY + 4) continue;
    axisGroup
      .append("text")
      .attr("x", 8)
      .attr("y", tickY)
      .attr("dominant-baseline", "middle")
      .text(priceFormat(tick));
  }


  const histogramHoverHighlight = histogramGroup
    .append("rect")
    .attr("class", "histogram-hover-highlight")
    .attr("x", 0)
    .attr("width", histogramWidth)
    .style("display", "none")
    .style("pointer-events", "none");

  let activeHistogramBin: number | null = null;
  const hideHistogramTooltip = (): void => {
    histogramHoverHighlight.style("display", "none");
    histogramTooltip.value = null;
    emit("histogram-bin-hover", null);
    if (activeHistogramBin != null) {
      activeHistogramBin = null;
    }
  };

  const updateHistogramTooltip = (event: PointerEvent): void => {
    const histogramNode = histogramGroup.node();
    const layerNode = chartLayerRef.value;
    if (!histogramNode || !layerNode) return;
    const [, pointerY] = d3.pointer(event, histogramNode);
    const binIndex = findBinIndex(y.invert(pointerY));
    const bin = bins[binIndex];
    const comparisonBin = comparisonSim?.bins[binIndex];
    if (
      !bin ||
      (bin.count <= 0 && (comparisonBin?.count ?? 0) <= 0)
    ) {
      hideHistogramTooltip();
      return;
    }
    if (activeHistogramBin !== binIndex) {
      activeHistogramBin = binIndex;
      emit("histogram-bin-hover", {
        primary: statsFromBin(bin, totalPathCount),
        comparison: statsFromBin(comparisonBin, comparisonPathCount),
      });
    }

    histogramHoverHighlight
      .style("display", null)
      .attr("y", histBarY(bin))
      .attr("height", histBarHeight(bin));

    const layerRect = layerNode.getBoundingClientRect();
    const localY = event.clientY - layerRect.top;
    // Place the tooltip beyond the chart when the viewport has room. On
    // narrower screens, keep it as far right as possible without clipping.
    const preferredX = layerRect.width + HISTOGRAM_TOOLTIP_GAP;
    const viewportMaxX =
      window.innerWidth -
      layerRect.left -
      HISTOGRAM_TOOLTIP_WIDTH -
      8;
    const yPosition = clamp(
      localY - HISTOGRAM_TOOLTIP_HEIGHT * 0.5,
      48,
      Math.max(48, layerRect.height - HISTOGRAM_TOOLTIP_HEIGHT - 8),
    );
    const probability =
      totalPathCount > 0 ? bin.count / totalPathCount : 0;
    const cumulativeProbability =
      totalPathCount > 0
        ? (cumulativePathCounts[binIndex] ?? 0) / totalPathCount
        : 0;
    const averagePayoff =
      bin.count > 0 ? bin.sumPayoff / bin.count : Number.NaN;
    histogramTooltip.value = {
      x: clamp(preferredX, 8, Math.max(8, viewportMaxX)),
      y: yPosition,
      priceRange: `${formatTooltipPrice(bin.x0)} – ${formatTooltipPrice(bin.x1)}`,
      probability: formatTooltipProbability(probability),
      cumulativeProbability: formatTooltipProbability(cumulativeProbability),
      cumulativeEV: cumulativeEV[binIndex + 1]
        ? formatTooltipPayoff(cumulativeEV[binIndex + 1].contribution)
        : undefined,
      paths: `${bin.count.toLocaleString("en-US")} / ${totalPathCount.toLocaleString("en-US")}`,
      medianPayoff:
        bin.count > 0 ? formatTooltipPayoff(bin.medianPayoff) : "—",
      averagePayoff: formatTooltipPayoff(averagePayoff),
      primaryContribution: comparisonSim
        ? formatTooltipContribution(
            histogramMode === "prob"
              ? getWeightedPayoff(bin)
              : bin.medianPayoff,
          )
        : undefined,
      comparisonContribution:
        comparisonSim && comparisonBin
          ? formatTooltipContribution(
              histogramMode === "prob"
                ? getWeightedPayoff(comparisonBin, comparisonPathCount)
                : comparisonBin.medianPayoff,
            )
          : undefined,
      accent: histogramPriceFill(bin),
    };
  };

  histogramGroup
    .append("rect")
    .attr("class", "histogram-hover-layer")
    .attr("x", 0)
    .attr("y", dataTopY)
    .attr("width", histogramWidth)
    .attr("height", Math.max(1, dataBottomY - dataTopY))
    .attr("fill", "transparent")
    .style("pointer-events", "all")
    .style("cursor", "default")
    .on("pointerenter", (event) =>
      updateHistogramTooltip(event as PointerEvent),
    )
    .on("pointermove", (event) =>
      updateHistogramTooltip(event as PointerEvent),
    )
    .on("click", (event) =>
      updateHistogramTooltip(event as PointerEvent),
    )
    .on("pointerleave", hideHistogramTooltip);

  const minMu = props.muMin ?? -0.1;
  const maxMu = props.muMax ?? 0.3;
  const minVol = props.volMin ?? 0.1;
  const maxVol = props.volMax ?? 1;
  const coneHitSlop = 12;
  const driftHitSlop = 10;

  let activeMu = clamp(props.params.mu, minMu, maxMu);
  let activeVol = clamp(props.params.vol, minVol, maxVol);

  const muConeArea = d3
    .area<{ t: number; lower: number; upper: number }>()
    .x((d) => x(d.t / props.params.dt))
    .y0((d) => y(d.lower))
    .y1((d) => y(d.upper));
  const muConeLine = d3
    .line<{ t: number; value: number }>()
    .x((d) => x(d.t / props.params.dt))
    .y((d) => y(d.value));

  const drawMuGuide = (mu: number, vol: number): void => {
    const endPrice = baseline * Math.exp(mu * maxElapsed);
    const endY = y(endPrice);
    muGuide.style("display", "block");
    updateForwardLabels(mu, vol);
    muLine
      .attr("x1", 0)
      .attr("y1", baselineY)
      .attr("x2", mainWidth)
      .attr("y2", endY)
      .style("stroke-width", driftHover ? 4.5 : 2.2)
      .style("stroke-opacity", driftHover ? 1 : 0.85);
    emit("guide-update", { mu, vol });
    const samples = 48;
    const points: { t: number; lower: number; upper: number }[] = [];
    const sigma = vol;
    for (let i = 0; i < samples; i += 1) {
      const t = (i / (samples - 1)) * maxElapsed;
      const center = Math.max(1e-6, baseline * Math.exp(mu * t));
      const band = sigma * Math.sqrt(t);
      const upper = center * Math.exp(band);
      const lower = center * Math.exp(-band);
      points.push({ t, lower, upper });
    }
    muConeFill.attr("d", muConeArea(points));
    muConeUpper.attr(
      "d",
      muConeLine(points.map((point) => ({ t: point.t, value: point.upper }))),
    );
    muConeLower.attr(
      "d",
      muConeLine(points.map((point) => ({ t: point.t, value: point.lower }))),
    );
  };

  const getPointerSample = (
    event: PointerEvent,
  ): { elapsed: number; price: number } | null => {
    const [rawX, rawY] = d3.pointer(
      event,
      interactionLayer.node() as SVGRectElement,
    );
    const clampedX = clamp(rawX, 0, mainWidth);
    const clampedY = clamp(rawY, 0, mainHeight);
    const timeIndex = x.invert(clampedX);
    const elapsed = timeIndex * props.params.dt;
    if (elapsed <= 0) return null;
    const price = y.invert(clampedY);
    if (price <= 0) return null;
    return { elapsed, price };
  };

  const getPointerElapsed = (
    event: PointerEvent,
  ): { elapsed: number; y: number } | null => {
    const [rawX, rawY] = d3.pointer(
      event,
      interactionLayer.node() as SVGRectElement,
    );
    const clampedX = clamp(rawX, 0, mainWidth);
    const timeIndex = x.invert(clampedX);
    const elapsed = timeIndex * props.params.dt;
    if (elapsed <= 0) return null;
    return { elapsed, y: rawY };
  };

  const getConeBounds = (
    elapsed: number,
    mu: number,
    vol: number,
  ): { upperY: number; lowerY: number } => {
    const center = baseline * Math.exp(mu * elapsed);
    const band = vol * Math.sqrt(elapsed);
    const upper = center * Math.exp(band);
    const lower = center * Math.exp(-band);
    return { upperY: y(upper), lowerY: y(lower) };
  };

  const getLineY = (elapsed: number, mu: number): number =>
    y(baseline * Math.exp(mu * elapsed));

  const getConeMetrics = (
    event: PointerEvent,
  ): {
    elapsed: number;
    y: number;
    upperY: number;
    lowerY: number;
    edgeDist: number;
  } | null => {
    const data = getPointerElapsed(event);
    if (!data) return null;
    const bounds = getConeBounds(data.elapsed, activeMu, activeVol);
    const edgeDist = Math.min(
      Math.abs(data.y - bounds.upperY),
      Math.abs(data.y - bounds.lowerY),
    );
    return { ...data, ...bounds, edgeDist };
  };

  const isVolDragZone = (event: PointerEvent): boolean => {
    const metrics = getConeMetrics(event);
    if (!metrics) return false;
    return metrics.edgeDist <= coneHitSlop;
  };

  const isDriftHit = (event: PointerEvent): boolean => {
    const data = getPointerElapsed(event);
    if (!data) return false;
    const lineY = getLineY(data.elapsed, activeMu);
    return Math.abs(data.y - lineY) <= driftHitSlop;
  };

  const updateMuGuide = (event: PointerEvent): void => {
    if (!trackingMode || isPointerDown) return;
    const sample = getPointerSample(event);
    if (!sample) return;
    const mu = Math.log(sample.price / baseline) / sample.elapsed;
    if (!Number.isFinite(mu)) return;
    activeMu = clamp(mu, minMu, maxMu);
    drawMuGuide(activeMu, activeVol);
  };

  const updateVolGuide = (event: PointerEvent, mu: number): void => {
    const sample = getPointerSample(event);
    if (!sample) return;
    const center = baseline * Math.exp(mu * sample.elapsed);
    const deviation = Math.abs(Math.log(sample.price / center));
    const sigma = deviation / Math.sqrt(sample.elapsed);
    if (!Number.isFinite(sigma)) return;
    activeVol = clamp(sigma, minVol, maxVol);
    drawMuGuide(mu, activeVol);
  };

  const updateCursor = (event: PointerEvent): void => {
    const shouldDragVol = isVolDragZone(event);
    const shouldDragDrift = !shouldDragVol && isDriftHit(event);
    driftHover = shouldDragDrift;
    muLine
      .style("stroke-width", driftHover ? 4.5 : 2.2)
      .style("stroke-opacity", driftHover ? 1 : 0.85);
    muConeUpper
      .style("stroke-width", shouldDragVol ? 4 : 1.5)
      .style("stroke-opacity", shouldDragVol ? 1 : 0.55);
    muConeLower
      .style("stroke-width", shouldDragVol ? 4 : 1.5)
      .style("stroke-opacity", shouldDragVol ? 1 : 0.55);
    if (svgRef.value) {
      d3.select(svgRef.value).style(
        "cursor",
        shouldDragVol ? "ns-resize" : shouldDragDrift ? "pointer" : "crosshair",
      );
    }
  };

  const setMuFromPointer = (event: PointerEvent): void => {
    if (!trackingMode) return;
    const sample = getPointerSample(event);
    if (!sample) return;
    const mu = Math.log(sample.price / baseline) / sample.elapsed;
    if (!Number.isFinite(mu)) return;
    const clampedMu = clamp(mu, minMu, maxMu);
    activeMu = clampedMu;
    drawMuGuide(activeMu, activeVol);
    emit("set-mu", clampedMu);
  };

  if (Number.isFinite(props.params.mu)) {
    activeMu = clamp(props.params.mu, minMu, maxMu);
    activeVol = clamp(props.params.vol, minVol, maxVol);
    drawMuGuide(activeMu, activeVol);
  }

  interactionHandlers = {
    pointermove: (event: PointerEvent) => {
      updateCursor(event as PointerEvent);
      if (isDraggingVol) {
        updateVolGuide(event as PointerEvent, dragMu);
        return;
      }
      if (!trackingMode) return;
      updateMuGuide(event as PointerEvent);
    },
    pointerenter: (event: PointerEvent) => {
      updateMuGuide(event as PointerEvent);
      updateCursor(event as PointerEvent);
    },
    pointerdown: (event: PointerEvent) => {
      if (!isVolDragZone(event as PointerEvent)) return;
      isPointerDown = true;
      trackingMode = true;
      dragMu = activeMu;
      isDraggingVol = true;
      suppressClick = true;
      updateVolGuide(event as PointerEvent, dragMu);
    },
    pointerup: () => {
      isPointerDown = false;
      if (!isDraggingVol) return;
      isDraggingVol = false;
      suppressClick = true;
      trackingMode = false;
      emit("set-vol", activeVol);
    },
    click: (event: PointerEvent) => {
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      if (!trackingMode) {
        if (!isDriftHit(event as PointerEvent)) return;
        trackingMode = true;
        updateMuGuide(event as PointerEvent);
        return;
      }
      setMuFromPointer(event as PointerEvent);
      trackingMode = false;
    },
  };

  const updateHistogram = (progress: number): void => {
    const clampedProgress = Math.max(0, Math.min(1, progress));
    primaryPriceBars
      .attr("x", priceBarX())
      .attr("width", (d) => priceBarWidth(d, clampedProgress));
    comparisonPriceBars
      .attr("x", priceBarX())
      .attr("width", (d) => priceBarWidth(d, clampedProgress));
    primaryPayoffBars
      .attr("x", (d) => payoffBarX(d, clampedProgress))
      .attr("width", (d) => payoffBarWidth(d, clampedProgress));
    comparisonPayoffBars
      .attr("x", (d) =>
        payoffBarX(d, clampedProgress, comparisonPathCount),
      )
      .attr("width", (d) =>
        payoffBarWidth(d, clampedProgress, comparisonPathCount),
      );
  };

  if (!totalCloud && bins.length === 0) return;
  const cloudRenderIndices = activeCloudIndices;
  const renderedCloudCount = cloudRenderIndices.length;
  let cloudCursor = 0;

  const drawBatch = (now: number): void => {
    const start = drawBatchStartTs ?? now;
    drawBatchStartTs = start;
    const progress = Math.min(1, (now - start) / REVEAL_DURATION_MS);
    const targetCloud = Math.floor(progress * renderedCloudCount);

    updateHistogram(progress);

    for (let i = cloudCursor; i < targetCloud; i += 1) {
      const pathIndex = cloudRenderIndices[i];
      drawCloudPath(
        paths[pathIndex],
        cloudFillForPath(pathIndex),
        opacityForPath(pathIndex),
      );
    }
    cloudCursor = targetCloud;

    if (progress < 1) {
      cloudRevealRaf = requestAnimationFrame(drawBatch);
      return;
    }
    updateHistogram(1);

    for (let i = cloudCursor; i < renderedCloudCount; i += 1) {
      const pathIndex = cloudRenderIndices[i];
      drawCloudPath(
        paths[pathIndex],
        cloudFillForPath(pathIndex),
        opacityForPath(pathIndex),
      );
    }
    cloudCursor = renderedCloudCount;
    drawBatchStartTs = null;
    cloudRevealRaf = null;
  };

  let drawBatchStartTs: number | null = null;
  cloudRevealRaf = requestAnimationFrame(drawBatch);
};

const draw = async (): Promise<void> => {
  if (!canvasRef.value) return;
  const sceneHandles = ensureScene();
  if (!sceneHandles) return;
  const canvas = canvasRef.value;
  const canvasCtx = canvas.getContext("2d");
  if (!canvasCtx) return;
  const drawSeq = ++latestDrawSeq;

  let sim: SimComputation;
  let comparisonSim: SimComputation | null = null;
  try {
    const workerParams = sanitizeParamsForWorker(props.params);
    const valuationTs =
      props.valuationTs != null && Number.isFinite(props.valuationTs)
        ? Math.floor(props.valuationTs)
        : Math.floor(Date.now() / 1000);
    const horizonSeconds = Math.max(0, props.params.T * SECONDS_PER_YEAR);
    const histBins = Math.max(
      10,
      Math.min(400, Math.round(props.histBins ?? HISTOGRAM_BIN_COUNT)),
    );
    const histBinsMultiplier = clamp(
      Number(props.histBinsMultiplier ?? 1),
      1,
      2,
    );
    const samplePathLimit = Math.max(
      1,
      Math.min(
        Math.max(1, Math.round(props.params.rows)),
        Math.round(props.samplePathLimit ?? MAX_CLOUD_RENDER_PATHS),
      ),
    );
    const samplingStopLeg = props.comparisonLegs?.find(
      (leg) =>
        leg.kind === "future" &&
        leg.stopLoss != null &&
        Number.isFinite(leg.stopLoss),
    );
    const samplingStopLoss =
      samplingStopLeg?.kind === "future" &&
      samplingStopLeg.stopLoss != null
        ? {
            side: samplingStopLeg.side,
            price: Number(samplingStopLeg.stopLoss),
          }
        : undefined;
    sim = await requestSimulation({
      seed: props.seed,
      params: workerParams,
      pathModel: sanitizePathModel(props.pathModel),
      legs: sanitizeLegsForWorker(props.legs),
      optionPricingByLegId: sanitizeOptionPricingForWorker(
        props.optionPricingByLegId,
      ),
      valuationTs,
      horizonSeconds,
      histBins,
      histBinsMultiplier,
      samplePathLimit,
      returnSamplePaths: props.payoffDisplayMode == null,
      samplingStopLoss,
    });
    if (props.comparisonLegs?.length) {
      comparisonSim = await requestSimulation({
        seed: props.seed,
        params: workerParams,
        pathModel: sanitizePathModel(props.pathModel),
        legs: sanitizeLegsForWorker(props.comparisonLegs),
        optionPricingByLegId: sanitizeOptionPricingForWorker(
          props.comparisonOptionPricingByLegId,
        ),
        valuationTs,
        horizonSeconds,
        histBins,
        histBinsMultiplier,
        samplePathLimit,
        returnSamplePaths: false,
        samplingStopLoss,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      drawSeq === latestDrawSeq &&
      message !== "Simulation worker disposed"
    ) {
      console.error("Failed to compute simulation in worker", error);
    }
    return;
  }

  if (drawSeq !== latestDrawSeq) return;
  emit("stats-update", {
    meanPayoff: sim.meanPayoff,
    medianPayoff: sim.medianPayoff,
    payoffMin: sim.payoffMin,
    payoffMax: sim.payoffMax,
    p05Payoff: sim.p05Payoff,
    p10Payoff: sim.p10Payoff,
    p25Payoff: sim.p25Payoff,
    p50Payoff: sim.p50Payoff,
    p75Payoff: sim.p75Payoff,
    p90Payoff: sim.p90Payoff,
    p95Payoff: sim.p95Payoff,
    winRate: sim.winRate,
    maxLossRate: sim.maxLossRate,
    opportunityCost: sim.opportunityCost,
    breakEvenPrices: computeBreakEvenPrices(sim.bins),
  });
  if (comparisonSim) {
    emit("comparison-stats-update", {
      meanPayoff: comparisonSim.meanPayoff,
      medianPayoff: comparisonSim.medianPayoff,
      payoffMin: comparisonSim.payoffMin,
      payoffMax: comparisonSim.payoffMax,
      p05Payoff: comparisonSim.p05Payoff,
      p10Payoff: comparisonSim.p10Payoff,
      p25Payoff: comparisonSim.p25Payoff,
      p50Payoff: comparisonSim.p50Payoff,
      p75Payoff: comparisonSim.p75Payoff,
      p90Payoff: comparisonSim.p90Payoff,
      p95Payoff: comparisonSim.p95Payoff,
      winRate: comparisonSim.winRate,
      maxLossRate: comparisonSim.maxLossRate,
      opportunityCost: comparisonSim.opportunityCost,
    });
    const differenceSummary = buildPayoffDifferenceSummary(
      sim.terminalPayoffs,
      comparisonSim.terminalPayoffs,
    );
    emit("payoff-difference-update", {
      optionWinRate: differenceSummary.optionWinRate,
      medianAdvantage: differenceSummary.medianAdvantage,
    });
  }
  cachedSim = sim;
  cachedComparisonSim = comparisonSim;
  updateDynamicScene(sceneHandles, canvas, canvasCtx, sim, comparisonSim);
};

const scheduleDraw = (): void => {
  drawQueued = true;
  if (drawScheduleTimer != null) {
    clearTimeout(drawScheduleTimer);
  }
  drawScheduleTimer = setTimeout(() => {
    drawScheduleTimer = null;
    void runDrawQueue();
  }, 16);
};

const runDrawQueue = async (): Promise<void> => {
  if (!componentMounted || drawInFlight) return;
  drawInFlight = true;
  drawQueued = false;
  try {
    await draw();
  } finally {
    drawInFlight = false;
    if (componentMounted && drawQueued) scheduleDraw();
  }
};

onMounted(() => {
  componentMounted = true;
  scheduleDraw();
});
watch(
  () => [
    props.seed,
    props.params.s0,
    props.params.mu,
    props.params.vol,
    props.params.T,
    props.params.dt,
    props.params.rows,
    JSON.stringify(sanitizePathModel(props.pathModel)),
    props.histBins,
    props.histBinsMultiplier,
    props.samplePathLimit,
    props.histMode,
    props.histogramOpacity,
    props.colorMin,
    props.colorMax,
    props.pathFilter,
  ],
  scheduleDraw,
);
watch(
  () => [
    props.payoffDisplayMode,
    props.payoffChartMode,
    props.payoffChartContext,
  ],
  () => {
    if (!componentMounted || !cachedSim || !canvasRef.value) return;
    const sceneHandles = ensureScene();
    const canvasCtx = canvasRef.value.getContext("2d");
    if (!sceneHandles || !canvasCtx) return;
    updateDynamicScene(
      sceneHandles,
      canvasRef.value,
      canvasCtx,
      cachedSim,
      cachedComparisonSim,
    );
  },
);
watch(
  () => JSON.stringify(sanitizeLegsForWorker(props.legs)),
  scheduleDraw,
);
watch(
  () =>
    JSON.stringify(
      sanitizeOptionPricingForWorker(props.optionPricingByLegId),
    ),
  scheduleDraw,
);
watch(
  () => JSON.stringify(sanitizeLegsForWorker(props.comparisonLegs)),
  scheduleDraw,
);
watch(
  () =>
    JSON.stringify(
      sanitizeOptionPricingForWorker(props.comparisonOptionPricingByLegId),
    ),
  scheduleDraw,
);
onUnmounted(() => {
  componentMounted = false;
  drawQueued = false;
  if (cloudRevealRaf != null) {
    cancelAnimationFrame(cloudRevealRaf);
    cloudRevealRaf = null;
  }
  if (drawScheduleTimer != null) {
    clearTimeout(drawScheduleTimer);
    drawScheduleTimer = null;
  }
  if (simWorker != null) {
    simWorker.terminate();
    simWorker = null;
  }
  canvasTransformCache = {
    canvas: null,
    backingWidth: 0,
    backingHeight: 0,
    scaleX: 1,
    scaleY: 1,
  };
  cancelPendingSimRequests("Simulation worker disposed");
  interactionHandlers = null;
  cachedSim = null;
  cachedComparisonSim = null;
  scene = null;
});
</script>

<template>
  <div ref="chartLayerRef" class="cloud-chart-layer">
    <canvas ref="canvasRef" aria-hidden="true"></canvas>
    <svg
      ref="svgRef"
      :aria-label="
        payoffDisplayMode
          ? `${payoffChartMode === 'cumulative' ? 'Cumulative expected value' : payoffDisplayMode === 'frequency' ? 'Frequency weighted' : 'Payoff'} option and perpetual comparison`
          : 'Brownian motion cloud chart'
      "
    ></svg>
    <Transition name="histogram-tooltip">
      <div
        v-if="histogramTooltip"
        class="histogram-tooltip"
        role="tooltip"
        :style="{
          left: `${histogramTooltip.x}px`,
          top: `${histogramTooltip.y}px`,
        }"
      >
        <div class="histogram-tooltip-kicker">
          <span
            class="histogram-tooltip-swatch"
            :style="{ backgroundColor: histogramTooltip.accent }"
          ></span>
          Terminal distribution
        </div>
        <div class="histogram-tooltip-range">
          {{ histogramTooltip.priceRange }}
        </div>
        <div class="histogram-tooltip-divider"></div>
        <dl class="histogram-tooltip-stats">
          <div>
            <dt>% of paths</dt>
            <dd>{{ histogramTooltip.probability }}</dd>
          </div>
          <div>
            <dt>Cumulative</dt>
            <dd>{{ histogramTooltip.cumulativeProbability }}</dd>
          </div>
          <div v-if="histogramTooltip.cumulativeEV">
            <dt>EV up to this price</dt>
            <dd>{{ histogramTooltip.cumulativeEV }}</dd>
          </div>
          <div v-if="histogramTooltip.primaryContribution">
            <dt>{{ primarySeriesLabel ? `${primarySeriesLabel} PnL` : "Primary PnL" }}</dt>
            <dd>{{ histogramTooltip.primaryContribution }}</dd>
          </div>
          <div v-if="histogramTooltip.comparisonContribution">
            <dt>
              {{
                comparisonSeriesLabel
                  ? `${comparisonSeriesLabel} PnL`
                  : "Comparison PnL"
              }}
            </dt>
            <dd>{{ histogramTooltip.comparisonContribution }}</dd>
          </div>
          <div v-if="!histogramTooltip.primaryContribution">
            <dt>PnL (median)</dt>
            <dd>{{ histogramTooltip.medianPayoff }}</dd>
          </div>
          <div v-if="!histogramTooltip.primaryContribution">
            <dt>PnL (average)</dt>
            <dd>{{ histogramTooltip.averagePayoff }}</dd>
          </div>
          <div>
            <dt>Paths</dt>
            <dd>{{ histogramTooltip.paths }}</dd>
          </div>
        </dl>
      </div>
    </Transition>
    <Transition name="histogram-tooltip">
      <div
        v-if="payoffBinTooltip"
        class="histogram-tooltip payoff-bin-tooltip"
        role="tooltip"
        :style="{
          left: `${payoffBinTooltip.x}px`,
          top: `${payoffBinTooltip.y}px`,
        }"
      >
        <div class="histogram-tooltip-kicker">Terminal price bin</div>
        <div class="histogram-tooltip-range">
          {{ payoffBinTooltip.priceRange }}
        </div>
        <div class="histogram-tooltip-divider"></div>
        <div class="payoff-bin-tooltip-label">
          {{ payoffBinTooltip.valueLabel }}
        </div>
        <dl class="histogram-tooltip-stats">
          <div>
            <dt>{{ primarySeriesLabel || "Option" }}</dt>
            <dd class="is-option">{{ payoffBinTooltip.optionValue }}</dd>
          </div>
          <div>
            <dt>{{ comparisonSeriesLabel || "Perp" }}</dt>
            <dd class="is-perp">{{ payoffBinTooltip.perpValue }}</dd>
          </div>
          <div class="payoff-bin-tooltip-difference">
            <dt>Option − perp</dt>
            <dd>{{ payoffBinTooltip.difference }}</dd>
          </div>
        </dl>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.cloud-chart-layer {
  position: absolute;
  inset: 0;
  font-family: inherit;
}

.cloud-chart-layer svg,
.cloud-chart-layer canvas {
  position: absolute;
  top: var(--chart-header-height);
  left: 0;
  width: 100%;
  height: calc(
    100% - var(--chart-header-height) - var(--chart-legend-height, 0px)
  );
  display: block;
  object-fit: contain;
  object-position: center top;
}

.cloud-chart-layer svg {
  cursor: crosshair;
  z-index: 2;
}

.cloud-chart-layer canvas {
  pointer-events: none;
  z-index: 1;
}

.histogram-tooltip {
  position: absolute;
  z-index: 12;
  box-sizing: border-box;
  width: 172px;
  padding: 9px 10px 10px;
  border: 1px solid rgba(255, 255, 255, 0.13);
  border-radius: 5px;
  background: #111318;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.44);
  color: #dfe3e7;
  font-variant-numeric: tabular-nums;
  pointer-events: none;
}

.payoff-bin-tooltip {
  width: 216px;
}

.payoff-bin-tooltip-label {
  margin-bottom: 5px;
  color: #858d95;
  font-size: 8px;
  font-weight: 600;
  letter-spacing: 0.4px;
  text-transform: uppercase;
}

.payoff-bin-tooltip .is-option {
  color: #9bcdf3;
}

.payoff-bin-tooltip .is-perp {
  color: #f2ad67;
}

.payoff-bin-tooltip-difference {
  margin-top: 3px;
  padding-top: 5px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}

.histogram-tooltip-kicker {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #858d95;
  font-size: 8px;
  font-weight: 600;
  letter-spacing: 0.5px;
  line-height: 1;
  text-transform: uppercase;
  font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
}

.histogram-tooltip-swatch {
  width: 6px;
  height: 6px;
  border-radius: 1px;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.12);
}

.histogram-tooltip-range {
  margin-top: 7px;
  color: #dfe3e7;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.2;
}

.histogram-tooltip-divider {
  height: 1px;
  margin: 8px 0 7px;
  background: rgba(255, 255, 255, 0.08);
}

.histogram-tooltip-stats {
  display: grid;
  gap: 4px;
  margin: 0;
}

.histogram-tooltip-stats > div {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
}

.histogram-tooltip-stats dt,
.histogram-tooltip-stats dd {
  margin: 0;
}

.histogram-tooltip-stats dt {
  color: #858d95;
  font-size: 9px;
  font-weight: 500;
}

.histogram-tooltip-stats dd {
  color: #dfe3e7;
  font-size: 9px;
  font-weight: 500;
  text-align: right;
}

.histogram-tooltip-enter-active,
.histogram-tooltip-leave-active {
  transition:
    opacity 110ms ease,
    transform 110ms ease;
}

.histogram-tooltip-enter-from,
.histogram-tooltip-leave-to {
  opacity: 0;
  transform: translateY(3px);
}

:deep(svg) {
  font-family: inherit;
}

:deep(.chart-meta-overlay text) {
  dominant-baseline: alphabetic;
}

:deep(.chart-meta-key) {
  fill: var(--text-muted);
  font-size: 10px;
  font-family: inherit;
}

:deep(.chart-meta-value) {
  fill: #e8eaed;
  font-size: 10px;
  font-family: inherit;
  font-variant-numeric: tabular-nums;
}

:deep(.grid line) {
  stroke: rgba(255, 255, 255, 0.08);
}

:deep(.grid path) {
  stroke: none;
}

:deep(.baseline) {
  stroke: rgba(126, 211, 255, 0.35);
  stroke-width: 1;
  stroke-dasharray: 4 6;
}

:deep(.paths path) {
  mix-blend-mode: normal;
}

:deep(.ev-grid line) {
  stroke: rgba(255, 255, 255, 0.055);
  stroke-width: 1;
  shape-rendering: crispEdges;
}

:deep(.ev-zero-line) {
  stroke: rgba(226, 232, 240, 0.3);
  stroke-width: 1;
  shape-rendering: crispEdges;
}

:deep(.ev-area) {
  fill-opacity: 1;
  stroke: none;
}

:deep(.ev-area--option) {
  mix-blend-mode: normal;
}

:deep(.ev-area--perp) {
  mix-blend-mode: normal;
}

:deep(.ev-cumulative-chart .ev-area--option) {
  fill-opacity: 0.18;
}

:deep(.ev-cumulative-chart .ev-area--perp) {
  fill-opacity: 0.13;
}

:deep(.ev-contour) {
  fill: none;
  stroke-width: 0.8;
  stroke-opacity: 0.12;
  vector-effect: non-scaling-stroke;
}

:deep(.ev-contour--perp) {
  stroke-opacity: 0.09;
}

:deep(.ev-line) {
  fill: none;
  stroke-width: 2.2;
  stroke-linecap: round;
  stroke-linejoin: round;
  vector-effect: non-scaling-stroke;
}

:deep(.ev-axis text) {
  fill: rgba(255, 255, 255, 0.44);
  font-size: 8.5px;
  font-variant-numeric: tabular-nums;
}

:deep(.ev-region-label) {
  fill: #70767d;
  font-size: 9px;
  font-weight: 500;
  letter-spacing: 0.02em;
}

:deep(.ev-axis-title) {
  fill: #70767d;
  font-size: 9px;
  font-weight: 500;
}

:deep(.ev-title) {
  fill: #e8eaed;
  font-size: 12px;
  font-weight: 600;
}

:deep(.ev-subtitle) {
  fill: #626b74;
  font-size: 8.5px;
  font-weight: 500;
}

:deep(.ev-context) {
  fill: #7b848d;
  font-size: 8px;
  font-variant-numeric: tabular-nums;
}

:deep(.ev-panel-title) {
  fill: #9aa2aa;
  font-size: 9px;
  font-weight: 600;
}

:deep(.ev-panel-caption) {
  fill: #68717a;
  font-size: 8px;
  font-weight: 500;
}

:deep(.ev-bin-bars rect) {
  transition:
    fill-opacity 90ms ease,
    stroke-opacity 90ms ease;
}

:deep(.ev-bin-bars rect.is-dimmed) {
  fill-opacity: 0.18;
  stroke-opacity: 0.12;
}

:deep(.ev-bin-bars rect.is-hovered) {
  fill-opacity: 1;
  stroke-opacity: 0.95;
  stroke-width: 1.15;
}

:deep(.ev-stop-price-line) {
  stroke: rgba(226, 232, 240, 0.48);
  stroke-width: 1;
  stroke-dasharray: 5 5;
  vector-effect: non-scaling-stroke;
}

:deep(.ev-stop-price-label) {
  font-size: 9px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

:deep(.ev-stop-price-label) {
  fill: #d89b5d;
}

:deep(.ev-chart-heading line) {
  stroke-width: 2.5;
  stroke-linecap: round;
}

:deep(.ev-chart-heading g text) {
  fill: #8b9198;
  font-size: 8.5px;
  font-weight: 500;
}

:deep(.ev-endpoint) {
  stroke: #0a0b0e;
  stroke-width: 1.1;
}

:deep(.ev-endpoint-leader) {
  stroke-width: 1;
  stroke-opacity: 0.7;
  shape-rendering: geometricPrecision;
}

:deep(.ev-endpoint-label) {
  font-size: 10.5px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  paint-order: stroke;
  stroke: rgba(10, 11, 14, 0.82);
  stroke-width: 3px;
}

:deep(.ev-annotation-dot) {
  fill: #9da7b0;
  stroke: #0b0c0f;
  stroke-width: 1.2;
}

:deep(.ev-annotation-line) {
  stroke: rgba(218, 224, 230, 0.62);
  stroke-width: 1;
}

:deep(.ev-annotation-label) {
  fill: #d6dce2;
  font-size: 9px;
  font-weight: 500;
  paint-order: stroke;
  stroke: rgba(10, 11, 14, 0.9);
  stroke-width: 3px;
}

:deep(.stopped-path-highlight) {
  fill: none;
  stroke: #f2f5f7;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
  filter: drop-shadow(0 0 4px rgba(242, 245, 247, 0.72));
  pointer-events: none;
  vector-effect: non-scaling-stroke;
}

:deep(.stopped-path-marker) {
  fill: #f2f5f7;
  stroke: #0a0b0e;
  stroke-width: 1;
  pointer-events: none;
  vector-effect: non-scaling-stroke;
}

:deep(.mu-guide line) {
  stroke: #fff;
}

:deep(.mu-guide),
:deep(.mu-guide *) {
  pointer-events: none;
}

:deep(.mu-cone-fill) {
  opacity: 1;
}

:deep(.mu-cone-edge) {
  fill: none;
  stroke: rgba(255, 255, 255, 0.55);
  stroke-width: 1.5;
}

:deep(.axis-label) {
  fill: var(--text-muted);
  font-size: 10px;
  letter-spacing: 0.24em;
  text-transform: uppercase;
  font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
}

:deep(.axis text) {
  fill: rgba(255, 255, 255, 0.44);
  font-size: 11px;
  font-family: inherit;
}

:deep(.break-even-band) {
  fill: rgba(100, 116, 139, 0.12);
  pointer-events: none;
}

:deep(.break-even-region) {
  pointer-events: none;
}

:deep(.break-even-region text) {
  fill: #8b9198;
  stroke: #0a0b0e;
  stroke-width: 4;
  paint-order: stroke;
  font-size: 11px;
  font-family: inherit;
  font-variant-numeric: tabular-nums;
}

:deep(.histogram-hover-highlight) {
  fill: rgba(255, 255, 255, 0.07);
  stroke: rgba(255, 255, 255, 0.16);
  stroke-width: 1;
  shape-rendering: crispEdges;
}

:deep(.axis .average-payoff-guide) {
  stroke: rgba(226, 232, 240, 0.55);
  stroke-width: 1;
  stroke-dasharray: 3 5;
  shape-rendering: crispEdges;
}

:deep(.axis .median-payoff-guide) {
  stroke: rgba(148, 163, 184, 0.55);
  stroke-width: 1;
  stroke-dasharray: 7 4;
  shape-rendering: crispEdges;
}

:deep(.axis .payoff-summary-label) {
  fill: #8b9198;
  stroke: #0a0b0e;
  stroke-width: 4;
  paint-order: stroke;
  font-variant-numeric: tabular-nums;
}

:deep(.hist-payoff-baseline) {
  stroke: rgba(148, 163, 184, 0.35);
  stroke-width: 1;
  stroke-dasharray: 2 3;
  shape-rendering: crispEdges;
  pointer-events: none;
}


:deep(.annotation-label-leader) {
  stroke: rgba(148, 163, 184, 0.45);
  stroke-width: 1;
  shape-rendering: geometricPrecision;
}

:deep(.forward-value-label) {
  fill: #8b9198;
  font-size: 11px;
  font-family: inherit;
  font-variant-numeric: tabular-nums;
  pointer-events: none;
}

:deep(.axis path),
:deep(.axis line),
:deep(.hist-baseline) {
  stroke: rgba(255, 255, 255, 0.18);
}

:deep(.hist-s0) {
  stroke: rgba(0, 0, 0, 0.35);
  stroke-width: 1;
}
</style>
