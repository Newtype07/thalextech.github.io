<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import CloudChart from "./components/CloudChart.vue";
import PositionBuilder from "./components/PositionBuilder.vue";
import StopLossSimulator from "./components/StopLossSimulator.vue";
import type { AtmOptionExpiryQuote } from "./lib/atmOptionChain";
import type { GBMParams } from "./lib/gbm";
import {
  DEFAULT_PATH_MODEL,
  horizonVolMovePointsFromVolOfVol,
  type PathModelParams,
  volOfVolFromHorizonMovePoints,
} from "./lib/pathModel";
import type { PositionLeg, OptionLeg } from "./lib/position";
import type { SimulationStats } from "./lib/simulation";
import {
  fetchInstruments,
  fetchLatestIndexPrice,
  fetchLatestMarkPrice,
  type ThalexInstrument,
} from "./lib/thalex";

const defaultParams: GBMParams = {
  s0: 95_000,
  mu: 0.1,
  vol: 0.4,
  T: 14 / 365.25,
  dt: 1 / (365.25 * 24),
  rows: 10_000,
};
const driftBounds = { min: -5, max: 5 };
const volBounds = { min: 0.1, max: 1.2 };

const pendingParams = reactive<GBMParams>({ ...defaultParams });
const appliedParams = reactive<GBMParams>({ ...defaultParams });
const ROWS_MIN = 1_000;
const ROWS_MAX = 50_000;
const ROWS_STEP = 1_000;
const ROWS_DEBOUNCE_MS = 160;
const DRAWN_PATHS_MIN = 100;
const DRAWN_PATHS_MAX = 5_000;
const DRAWN_PATHS_STEP = 100;
const TIME_STEPS_MIN = 24;
const TIME_STEPS_MAX = 4000;
const TIME_STEPS_STEP = 24;
const SETTINGS_TOOLTIPS = {
  constantVol:
    "Keeps volatility fixed at the RV value for every simulated path and time step.",
  stochasticVol:
    "Lets variance evolve randomly from RV². This enables the vol-of-vol and spot/vol correlation inputs.",
  volOfVol:
    "Approximate one-standard-deviation move in annualized volatility over the selected horizon. The simulator converts this to the model's vol-of-vol coefficient.",
  correlation:
    "Correlation between spot-price and volatility shocks. Negative values make volatility tend to rise when spot falls.",
  timeSteps:
    "Number of simulation intervals in each path. More steps improve time resolution but take longer to calculate.",
  pathLimit:
    "Maximum sampled paths rendered in the cloud. This changes visual density, not the number of outcomes used for statistics.",
  binsMultiplier:
    "Multiplier for histogram resolution. Higher values create more, narrower bins without changing the simulation.",
} as const;
const MODEL_METRIC_TOOLTIPS = {
  volOfVol:
    "Approximate 1σ move in annualized volatility over this horizon. Change it in Simulation settings; it only applies to Stochastic vol.",
  correlation:
    "Correlation between spot-price and volatility shocks. Change it in Simulation settings; it only applies to Stochastic vol.",
} as const;
const EXPORT_WIDTH = 3200;
const EXPORT_HEIGHT = 1800;
const EXPORT_PADDING_X = 96;
const EXPORT_PADDING_Y = 84;
const EXPORT_HTML_FONT_SCALE = 1.05;

const generateSeed = (): number => Math.floor(Math.random() * 1_000_000_000);
const seed = ref(generateSeed());
const activeSimulatorTab = ref<"strategy" | "stop-loss">("strategy");
const appMainRef = ref<HTMLElement | null>(null);
const workspaceRef = ref<HTMLElement | null>(null);
const chartSectionRef = ref<HTMLElement | null>(null);
const guideMu = ref<number | null>(null);
const guideVol = ref<number | null>(null);
const histogramMode = ref<"payoff" | "prob">("payoff");
const strategyStats = ref<SimulationStats | null>(null);

const formatSignedPayoff = (value: number | null | undefined): string => {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000)
    return `${sign}$${(absolute / 1_000_000).toFixed(1)}M`;
  if (absolute >= 1_000)
    return `${sign}$${(absolute / 1_000).toFixed(1)}k`;
  return `${sign}$${absolute.toFixed(absolute < 10 ? 1 : 0)}`;
};

const formatPriceWithDecimal = (value: number | null | undefined): string => {
  if (value == null || !Number.isFinite(value)) return "—";
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000)
    return `$${(value / 1_000_000).toFixed(1)}M`;
  if (absolute >= 1_000) return `$${(value / 1_000).toFixed(1)}k`;
  return `$${value.toFixed(1)}`;
};

const payoffSign = (value: number | null | undefined): "pos" | "neg" | "zero" => {
  if (value == null || !Number.isFinite(value) || value === 0) return "zero";
  return value > 0 ? "pos" : "neg";
};

const formatSignedPercent = (value: number | null | undefined): string => {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${Math.abs(value * 100).toFixed(1)}%`;
};

const formatProbability = (value: number | null | undefined): string => {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(1)}%`;
};
const settingsOpen = ref(false);
const pathModel = reactive<PathModelParams>({ ...DEFAULT_PATH_MODEL });
const pathModelDraft = reactive<PathModelParams>({ ...DEFAULT_PATH_MODEL });
const exportInProgress = ref(false);
const cloudPathLimit = ref(2000);
const colorMinPercent = ref(15);
const colorMaxPercent = ref(85);
const histBinsMultiplier = ref(1);
const defaultTradeInitialized = ref(false);
const positionLegs = ref<PositionLeg[]>([
  {
    id: "leg-1",
    kind: "option",
    side: "buy",
    qty: 1,
    optionType: "call",
    strike: 70000,
    premium: 0,
    expiry: "27 Feb 26",
  },
  {
    id: "leg-2",
    kind: "option",
    side: "buy",
    qty: 1,
    optionType: "put",
    strike: 70000,
    premium: 0,
    expiry: "27 Feb 26",
  },
]);
const instruments = ref<ThalexInstrument[]>([]);
const tickerByInstrument = ref<
  Record<string, { data: unknown; fetchedAt: number }>
>({});
const indexByName = ref<Record<string, { data: unknown; fetchedAt: number }>>(
  {},
);

type OptionPricingInput = {
  iv: number | null;
  mark: number | null;
  expirationTs: number | null;
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));
const roundTo = (value: number, decimals: number): number => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

const regenerate = (): void => {
  seed.value = generateSeed();
};
const applyParams = (): void => {
  Object.assign(appliedParams, pendingParams);
  regenerate();
};

const SVG_EXPORT_STYLE = `
  svg { font-family: "Helvetica Neue", Helvetica, -apple-system, sans-serif; }
  .mu-guide line { stroke: #fff; }
  .mu-cone-fill { opacity: 1; }
  .mu-cone-edge { fill: none; stroke: rgba(255, 255, 255, 0.55); stroke-width: 1.5; }
  .axis text { fill: rgba(255, 255, 255, 0.44); font-size: 11px; }
  .axis path, .axis line, .hist-baseline { stroke: rgba(255, 255, 255, 0.18); }
  .break-even-band { fill: rgba(100, 116, 139, 0.12); }
  .break-even-region text { fill: #8b9198; stroke: #0a0b0e; stroke-width: 4; paint-order: stroke; font-size: 11px; }
  .axis .average-payoff-guide { stroke: rgba(226, 232, 240, 0.55); stroke-width: 1; stroke-dasharray: 3 5; }
  .axis .median-payoff-guide { stroke: rgba(148, 163, 184, 0.55); stroke-width: 1; stroke-dasharray: 7 4; }
  .axis .payoff-summary-label { fill: #8b9198; stroke: #0a0b0e; stroke-width: 4; paint-order: stroke; font-variant-numeric: tabular-nums; }
  .annotation-label-leader { stroke: rgba(148, 163, 184, 0.45); stroke-width: 1; }
  .forward-value-label { fill: #8b9198; font-size: 11px; font-variant-numeric: tabular-nums; }
  .ev-grid line { stroke: rgba(255, 255, 255, 0.07); stroke-width: 1; }
  .ev-zero-line { stroke: rgba(226, 232, 240, 0.38); stroke-width: 1.25; }
  .ev-area { stroke: none; fill-opacity: 1; }
  .ev-cumulative-chart .ev-area--option { fill-opacity: 0.18; }
  .ev-cumulative-chart .ev-area--perp { fill-opacity: 0.13; }
  .ev-line { fill: none; stroke-width: 2.8; stroke-linecap: round; stroke-linejoin: round; }
  .ev-contour { fill: none; stroke-width: 1; stroke-opacity: 0.16; }
  .ev-contour--perp { stroke-opacity: 0.12; }
  .ev-axis text { fill: #7f8993; font-size: 12px; font-variant-numeric: tabular-nums; }
  .ev-axis-title { fill: #969fa8; font-size: 13px; font-weight: 600; }
  .ev-region-label { fill: #8b949d; font-size: 12px; font-weight: 600; letter-spacing: 0.02em; }
  .ev-title { fill: #e2e7ec; font-size: 17px; font-weight: 700; }
  .ev-subtitle { fill: #7d8791; font-size: 12px; font-weight: 500; }
  .ev-context { fill: #939ca5; font-size: 11px; font-variant-numeric: tabular-nums; }
  .ev-panel-title { fill: #aeb6be; font-size: 12px; font-weight: 600; }
  .ev-panel-caption { fill: #7f8993; font-size: 11px; font-weight: 500; }
  .ev-stop-price-line { stroke: rgba(226, 232, 240, 0.58); stroke-width: 1.25; stroke-dasharray: 5 5; }
  .ev-stop-price-label { fill: #e4a766; font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .ev-chart-heading g line { stroke-width: 3; stroke-linecap: round; }
  .ev-chart-heading g text { fill: #a0a8b0; font-size: 12px; font-weight: 600; }
  .ev-endpoint { stroke: #0a0b0e; stroke-width: 1.25; }
  .ev-endpoint-leader { stroke-width: 1.25; stroke-opacity: 0.8; }
  .ev-endpoint-label { font-size: 14px; font-weight: 700; font-variant-numeric: tabular-nums; paint-order: stroke; stroke: #0a0b0e; stroke-width: 4px; }
  .ev-annotation-dot { fill: #b3bdc6; stroke: #0b0c0f; stroke-width: 1.25; }
  .ev-annotation-line { stroke: rgba(226, 232, 240, 0.7); stroke-width: 1.25; }
  .ev-annotation-label { fill: #e1e6eb; font-size: 12px; font-weight: 500; paint-order: stroke; stroke: #0a0b0e; stroke-width: 4px; }
`;

const isVisibleForExport = (element: Element): boolean => {
  if (!(element instanceof HTMLElement || element instanceof SVGElement))
    return false;
  if (element.classList.contains("save-png-button")) return false;
  const style = window.getComputedStyle(element);
  return (
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    Number(style.opacity) !== 0
  );
};

const parseCssPixels = (value: string): number => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const canvasFontFromStyle = (
  style: CSSStyleDeclaration,
  scale: number,
): string => {
  const size = (parseCssPixels(style.fontSize) || 12) * scale;
  const fontStyle = style.fontStyle || "normal";
  const fontWeight = style.fontWeight || "400";
  const fontFamily =
    style.fontFamily || '"Helvetica Neue", Helvetica, sans-serif';
  return `${fontStyle} ${fontWeight} ${size}px ${fontFamily}`;
};

const isRenderableColor = (value: string): boolean =>
  !!value &&
  value !== "transparent" &&
  value !== "rgba(0, 0, 0, 0)" &&
  value !== "hsla(0, 0%, 0%, 0)";

const drawRoundedRect = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void => {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
};

const loadImage = (url: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () =>
      reject(new Error("Failed to render simulator export."));
    image.src = url;
  });

const svgElementToImage = (
  svgElement: SVGSVGElement,
): Promise<HTMLImageElement> => {
  const clone = svgElement.cloneNode(true) as SVGSVGElement;
  if (!clone.getAttribute("xmlns")) {
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  }
  const rect = svgElement.getBoundingClientRect();
  clone.setAttribute("width", String(Math.max(1, Math.ceil(rect.width))));
  clone.setAttribute("height", String(Math.max(1, Math.ceil(rect.height))));
  const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
  style.textContent = SVG_EXPORT_STYLE;
  const defs = clone.querySelector("defs");
  if (defs) defs.insertBefore(style, defs.firstChild);
  else clone.insertBefore(style, clone.firstChild);
  const source = new XMLSerializer().serializeToString(clone);
  const blob = new Blob([source], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  return loadImage(url).finally(() => URL.revokeObjectURL(url));
};

const drawElementBox = (
  ctx: CanvasRenderingContext2D,
  element: Element,
  rootRect: DOMRect,
): void => {
  if (!(element instanceof HTMLElement || element instanceof SVGElement))
    return;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  const style = window.getComputedStyle(element);
  const x = rect.left - rootRect.left;
  const y = rect.top - rootRect.top;
  const radius = parseCssPixels(style.borderTopLeftRadius);
  if (isRenderableColor(style.backgroundColor)) {
    ctx.fillStyle = style.backgroundColor;
    drawRoundedRect(ctx, x, y, rect.width, rect.height, radius);
    ctx.fill();
  }
  const borderWidth = parseCssPixels(style.borderTopWidth);
  if (borderWidth > 0 && isRenderableColor(style.borderTopColor)) {
    ctx.strokeStyle = style.borderTopColor;
    ctx.lineWidth = borderWidth;
    drawRoundedRect(
      ctx,
      x + borderWidth / 2,
      y + borderWidth / 2,
      Math.max(0, rect.width - borderWidth),
      Math.max(0, rect.height - borderWidth),
      Math.max(0, radius - borderWidth / 2),
    );
    ctx.stroke();
  }
};

const drawText = (
  ctx: CanvasRenderingContext2D,
  text: string,
  rect: DOMRect,
  style: CSSStyleDeclaration,
  rootRect: DOMRect,
  fontScale: number,
): void => {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed || rect.width <= 0 || rect.height <= 0) return;
  ctx.fillStyle = style.color || "#fff";
  ctx.font = canvasFontFromStyle(style, fontScale);
  ctx.textAlign =
    style.textAlign === "right"
      ? "right"
      : style.textAlign === "center"
        ? "center"
        : "left";
  ctx.textBaseline = "alphabetic";
  const fontSize = (parseCssPixels(style.fontSize) || 12) * fontScale;
  const x =
    rect.left -
    rootRect.left +
    (ctx.textAlign === "right"
      ? rect.width
      : ctx.textAlign === "center"
        ? rect.width / 2
        : 0);
  const y = rect.top - rootRect.top + rect.height / 2 + fontSize * 0.34;
  ctx.fillText(trimmed, x, y);
  ctx.textAlign = "left";
};

const drawFormValue = (
  ctx: CanvasRenderingContext2D,
  element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  rootRect: DOMRect,
  fontScale: number,
): void => {
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  const value =
    element instanceof HTMLSelectElement
      ? (element.selectedOptions[0]?.textContent ?? element.value)
      : element.value;
  const fontSize = (parseCssPixels(style.fontSize) || 12) * fontScale;
  const textAlign =
    style.textAlign === "right"
      ? "right"
      : style.textAlign === "center"
        ? "center"
        : "left";
  const x =
    rect.left -
    rootRect.left +
    (textAlign === "right"
      ? rect.width - 8
      : textAlign === "center"
        ? rect.width / 2
        : 8);
  const y = rect.top - rootRect.top + rect.height / 2 + fontSize * 0.35;
  ctx.fillStyle = style.color || "#fff";
  ctx.font = canvasFontFromStyle(style, fontScale);
  ctx.textAlign = textAlign;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(value, x, y);
  ctx.textAlign = "left";
};

const renderElementToCanvas = async (
  ctx: CanvasRenderingContext2D,
  element: Element,
  rootRect: DOMRect,
  fontScale: number,
): Promise<void> => {
  if (!isVisibleForExport(element)) return;

  drawElementBox(ctx, element, rootRect);

  if (element instanceof HTMLCanvasElement) {
    const rect = element.getBoundingClientRect();
    const sourceWidth = Math.max(1, element.width);
    const sourceHeight = Math.max(1, element.height);
    const containScale = Math.min(
      rect.width / sourceWidth,
      rect.height / sourceHeight,
    );
    const drawWidth = sourceWidth * containScale;
    const drawHeight = sourceHeight * containScale;
    ctx.drawImage(
      element,
      rect.left - rootRect.left + (rect.width - drawWidth) / 2,
      rect.top - rootRect.top,
      drawWidth,
      drawHeight,
    );
    return;
  }

  if (element instanceof SVGSVGElement) {
    const rect = element.getBoundingClientRect();
    const image = await svgElementToImage(element);
    ctx.drawImage(
      image,
      rect.left - rootRect.left,
      rect.top - rootRect.top,
      rect.width,
      rect.height,
    );
    return;
  }

  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLSelectElement ||
    element instanceof HTMLTextAreaElement
  ) {
    drawFormValue(ctx, element, rootRect, fontScale);
  }

  for (const node of Array.from(element.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? "";
      if (!text.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rect = range.getBoundingClientRect();
      range.detach();
      drawText(
        ctx,
        text,
        rect,
        window.getComputedStyle(element),
        rootRect,
        fontScale,
      );
    } else if (node instanceof Element) {
      await renderElementToCanvas(ctx, node, rootRect, fontScale);
    }
  }
};

const downloadCanvas = (canvas: HTMLCanvasElement, filename: string): void => {
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }, "image/png");
};

const exportElementScreenshot = async (
  element: HTMLElement,
  filename: string,
): Promise<void> => {
  await document.fonts?.ready;

  const rect = element.getBoundingClientRect();
  const width = Math.ceil(rect.width);
  const height = Math.ceil(rect.height);
  if (width <= 0 || height <= 0) return;

  const availableWidth = EXPORT_WIDTH - EXPORT_PADDING_X * 2;
  const availableHeight = EXPORT_HEIGHT - EXPORT_PADDING_Y * 2;
  const fitScale = Math.min(
    availableWidth / width,
    availableHeight / height,
  );
  const renderedWidth = width * fitScale;
  const renderedHeight = height * fitScale;
  const offsetX = (EXPORT_WIDTH - renderedWidth) / 2;
  const offsetY = (EXPORT_HEIGHT - renderedHeight) / 2;
  // HTML text is painted separately from the DOM snapshot, so let it scale
  // with the composition at the export resolution.
  const fontScale = EXPORT_HTML_FONT_SCALE;
  const output = document.createElement("canvas");
  output.width = EXPORT_WIDTH;
  output.height = EXPORT_HEIGHT;
  const ctx = output.getContext("2d");
  if (!ctx) return;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, EXPORT_WIDTH, EXPORT_HEIGHT);
  ctx.save();
  ctx.translate(offsetX, offsetY);
  ctx.scale(fitScale, fitScale);
  await renderElementToCanvas(ctx, element, rect, fontScale);
  ctx.restore();
  downloadCanvas(output, filename);
};

const waitForLayoutPaint = (): Promise<void> =>
  new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });

const handleSavePng = async (): Promise<void> => {
  const exportRoot = workspaceRef.value ?? appMainRef.value;
  if (!exportRoot || exportInProgress.value) return;
  const appRoot = appMainRef.value;
  const exportClass =
    activeSimulatorTab.value === "stop-loss"
      ? "is-exporting-stop-loss"
      : "is-exporting-strategy";
  appRoot?.classList.add(exportClass);
  exportInProgress.value = true;
  try {
    await waitForLayoutPaint();
    await exportElementScreenshot(
      exportRoot,
      activeSimulatorTab.value === "stop-loss"
        ? "simulator-stop-loss-comparison.png"
        : `simulator-${histogramMode.value}.png`,
    );
  } catch (error) {
    console.error("Failed to export simulator PNG", error);
  } finally {
    appRoot?.classList.remove(exportClass);
    exportInProgress.value = false;
  }
};

const setMuFromChart = (mu: number): void => {
  if (!Number.isFinite(mu)) return;
  const clamped = clamp(mu, driftBounds.min, driftBounds.max);
  pendingParams.mu = roundTo(clamped, 2);
  applyParams();
};

const setVolFromChart = (vol: number): void => {
  if (!Number.isFinite(vol)) return;
  const clamped = clamp(vol, volBounds.min, volBounds.max);
  const next = roundTo(clamped, 4);
  if (
    Math.abs(pendingParams.vol - next) < 1e-9 &&
    Math.abs(appliedParams.vol - next) < 1e-9
  ) {
    return;
  }
  pendingParams.vol = next;
  applyParams();
};

const setMuPercentFromInput = (percent: number): void => {
  if (!Number.isFinite(percent)) return;
  setMuFromChart(percent / 100);
};

const setVolPercentFromInput = (percent: number): void => {
  if (!Number.isFinite(percent)) return;
  setVolFromChart(percent / 100);
};

const selectNumericInput = (event: FocusEvent): void => {
  (event.currentTarget as HTMLInputElement | null)?.select();
};

const guideMuPercent = computed(() =>
  ((guideMu.value ?? pendingParams.mu) * 100).toFixed(2),
);
const guideVolPercent = computed(() =>
  ((guideVol.value ?? pendingParams.vol) * 100).toFixed(2),
);
const guideRows = computed(() =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(
    appliedParams.rows,
  ),
);
const horizonDaysLabel = computed(() => {
  const days = Math.round(appliedParams.T * 365.25);
  return `T+${days}d`;
});
const nLabelRef = ref<HTMLElement | null>(null);
const settingsMenuRef = ref<HTMLElement | null>(null);
const rowsSlider = ref(appliedParams.rows);
const nPopoverOpen = ref(false);
const nPopoverAnchor = ref<{
  left: number;
  top: number;
  width: number;
  height: number;
} | null>(null);
let nPopoverHideTimer: ReturnType<typeof setTimeout> | null = null;
let rowsApplyTimer: ReturnType<typeof setTimeout> | null = null;

const clampInt = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.round(value)));
const simTimeSteps = ref(
  clampInt(
    Math.round(appliedParams.T / appliedParams.dt),
    TIME_STEPS_MIN,
    TIME_STEPS_MAX,
  ),
);
const graphSettingsDraft = reactive({
  timeSteps: simTimeSteps.value,
  pathLimit: cloudPathLimit.value,
  binsMultiplier: histBinsMultiplier.value,
});

const setSimTimeSteps = (value: number): void => {
  const next = clampInt(
    Math.round(value / TIME_STEPS_STEP) * TIME_STEPS_STEP,
    TIME_STEPS_MIN,
    TIME_STEPS_MAX,
  );
  simTimeSteps.value = next;
  const nextDt = appliedParams.T / next;
  if (!Number.isFinite(nextDt) || nextDt <= 0) return;
  pendingParams.dt = nextDt;
  appliedParams.dt = nextDt;
  regenerate();
};

const setCloudPathLimit = (value: number): void => {
  if (!Number.isFinite(value)) return;
  const snapped = Math.round(value / DRAWN_PATHS_STEP) * DRAWN_PATHS_STEP;
  const hardClamped = clampInt(snapped, DRAWN_PATHS_MIN, DRAWN_PATHS_MAX);
  cloudPathLimit.value = clampInt(
    hardClamped,
    DRAWN_PATHS_MIN,
    Math.max(DRAWN_PATHS_MIN, appliedParams.rows),
  );
};

const setHistBinsMultiplier = (value: number): void => {
  if (!Number.isFinite(value)) return;
  const next = clamp(roundTo(value, 2), 1, 2);
  histBinsMultiplier.value = next;
};

// Draft text while a settings field is focused so typing is not clamped /
// reformatted on every keystroke (which made values "append" weirdly).
const settingsFieldDraft = ref<{ key: string; text: string } | null>(null);

const settingsFieldValue = (
  key: string,
  committed: number | string,
): string => {
  if (settingsFieldDraft.value?.key === key) {
    return settingsFieldDraft.value.text;
  }
  return String(committed);
};

const beginSettingsFieldEdit = (key: string, event: FocusEvent): void => {
  const input = event.target as HTMLInputElement;
  settingsFieldDraft.value = { key, text: input.value };
  // Replace existing value on the next keystroke instead of appending.
  requestAnimationFrame(() => {
    if (document.activeElement === input) input.select();
  });
};

const updateSettingsFieldDraft = (key: string, text: string): void => {
  settingsFieldDraft.value = { key, text };
};

const commitSettingsField = (
  key: string,
  commit: (value: number) => void,
): void => {
  if (settingsFieldDraft.value?.key !== key) return;
  const text = settingsFieldDraft.value.text.trim().replace(/,/g, "");
  settingsFieldDraft.value = null;
  if (
    text === "" ||
    text === "-" ||
    text === "+" ||
    text === "." ||
    text === "-." ||
    text === "+."
  ) {
    return;
  }
  const value = Number(text);
  if (!Number.isFinite(value)) return;
  commit(value);
};

const onSettingsFieldEnter = (event: KeyboardEvent): void => {
  (event.target as HTMLInputElement).blur();
};

const syncSettingsDraft = (): void => {
  settingsFieldDraft.value = null;
  Object.assign(pathModelDraft, pathModel);
  graphSettingsDraft.timeSteps = simTimeSteps.value;
  graphSettingsDraft.pathLimit = cloudPathLimit.value;
  graphSettingsDraft.binsMultiplier = histBinsMultiplier.value;
};

const toggleSimSettings = (): void => {
  if (settingsOpen.value) {
    settingsOpen.value = false;
    return;
  }
  syncSettingsDraft();
  settingsOpen.value = true;
};

const closeSimSettings = (): void => {
  settingsFieldDraft.value = null;
  settingsOpen.value = false;
};

const handleSettingsPointerDown = (event: PointerEvent): void => {
  if (!settingsOpen.value || !(event.target instanceof Node)) return;
  if (settingsMenuRef.value?.contains(event.target)) return;
  closeSimSettings();
};

const handleSettingsKeydown = (event: KeyboardEvent): void => {
  if (event.key === "Escape") closeSimSettings();
};

type NumericPathModelKey =
  | "volOfVol"
  | "correlation";

const setPathModelNumber = (
  key: NumericPathModelKey,
  value: number,
  min: number,
  max: number,
  decimals: number,
): void => {
  if (!Number.isFinite(value)) return;
  pathModelDraft[key] = roundTo(clamp(value, min, max), decimals);
};

const horizonVolMovePoints = (): number =>
  roundTo(
    horizonVolMovePointsFromVolOfVol(
      pathModelDraft.volOfVol,
      appliedParams.T,
    ),
    1,
  );

const modelVolMovePoints = computed(() =>
  horizonVolMovePointsFromVolOfVol(
    pathModel.volOfVol,
    appliedParams.T,
  ).toFixed(1),
);

const modelSpotVolCorrelation = computed(() =>
  pathModel.correlation.toFixed(2),
);

const setHorizonVolMovePoints = (movePoints: number): void => {
  setPathModelNumber(
    "volOfVol",
    volOfVolFromHorizonMovePoints(movePoints, appliedParams.T),
    0,
    3,
    3,
  );
};

const resetPathModel = (): void => {
  settingsFieldDraft.value = null;
  Object.assign(pathModelDraft, DEFAULT_PATH_MODEL);
};

const setDraftTimeSteps = (value: number): void => {
  if (!Number.isFinite(value)) return;
  graphSettingsDraft.timeSteps = clampInt(
    Math.round(value / TIME_STEPS_STEP) * TIME_STEPS_STEP,
    TIME_STEPS_MIN,
    TIME_STEPS_MAX,
  );
};

const setDraftPathLimit = (value: number): void => {
  if (!Number.isFinite(value)) return;
  const snapped = Math.round(value / DRAWN_PATHS_STEP) * DRAWN_PATHS_STEP;
  graphSettingsDraft.pathLimit = clampInt(
    snapped,
    DRAWN_PATHS_MIN,
    Math.min(DRAWN_PATHS_MAX, appliedParams.rows),
  );
};

const setDraftBinsMultiplier = (value: number): void => {
  if (!Number.isFinite(value)) return;
  graphSettingsDraft.binsMultiplier = clamp(roundTo(value, 2), 1, 2);
};

const confirmSimSettings = (): void => {
  Object.assign(pathModel, pathModelDraft);
  if (graphSettingsDraft.timeSteps !== simTimeSteps.value) {
    setSimTimeSteps(graphSettingsDraft.timeSteps);
  }
  if (graphSettingsDraft.pathLimit !== cloudPathLimit.value) {
    setCloudPathLimit(graphSettingsDraft.pathLimit);
  }
  if (graphSettingsDraft.binsMultiplier !== histBinsMultiplier.value) {
    setHistBinsMultiplier(graphSettingsDraft.binsMultiplier);
  }
  closeSimSettings();
};

const clearNPopoverHideTimer = (): void => {
  if (!nPopoverHideTimer) return;
  clearTimeout(nPopoverHideTimer);
  nPopoverHideTimer = null;
};

const scheduleNPopoverHide = (): void => {
  clearNPopoverHideTimer();
  nPopoverHideTimer = setTimeout(() => {
    nPopoverOpen.value = false;
  }, 140);
};

const clearRowsApplyTimer = (): void => {
  if (!rowsApplyTimer) return;
  clearTimeout(rowsApplyTimer);
  rowsApplyTimer = null;
};

const clampRows = (value: number): number => {
  const snapped = Math.round(value / ROWS_STEP) * ROWS_STEP;
  return clamp(snapped, ROWS_MIN, ROWS_MAX);
};

const applyRowsValue = (value: number): void => {
  const next = clampRows(value);
  if (pendingParams.rows === next && appliedParams.rows === next) return;
  pendingParams.rows = next;
  appliedParams.rows = next;
  regenerate();
};

const scheduleRowsApply = (value: number): void => {
  clearRowsApplyTimer();
  rowsApplyTimer = setTimeout(() => {
    applyRowsValue(value);
  }, ROWS_DEBOUNCE_MS);
};

const setRowsFromSlider = (value: number): void => {
  if (!Number.isFinite(value)) return;
  const next = clampRows(value);
  rowsSlider.value = next;
  scheduleRowsApply(next);
};

const flushRowsFromSlider = (): void => {
  clearRowsApplyTimer();
  applyRowsValue(rowsSlider.value);
};

const handleNLabelEnter = (): void => {
  if (!nLabelRef.value || !chartSectionRef.value) return;
  const labelRect = nLabelRef.value.getBoundingClientRect();
  const sectionRect = chartSectionRef.value.getBoundingClientRect();
  nPopoverAnchor.value = {
    left: labelRect.left - sectionRect.left,
    top: labelRect.top - sectionRect.top,
    width: labelRect.width,
    height: labelRect.height,
  };
  clearNPopoverHideTimer();
  nPopoverOpen.value = true;
};

const handleNLabelLeave = (): void => {
  scheduleNPopoverHide();
};

const handleNPopoverMouseEnter = (): void => {
  clearNPopoverHideTimer();
  nPopoverOpen.value = true;
};

const handleNPopoverMouseLeave = (): void => {
  scheduleNPopoverHide();
};

const updateGuide = (payload: { mu: number; vol: number }): void => {
  guideMu.value = payload.mu;
  guideVol.value = payload.vol;
};
const parseExpiryToSeconds = (expiry?: string): number | null => {
  if (!expiry) return null;
  const parts = expiry.split(" ");
  if (parts.length < 3) return null;
  const [dayStr, monthStr, yearStr] = parts;
  const day = Number(dayStr);
  const year = Number(yearStr);
  if (!Number.isFinite(day) || !Number.isFinite(year)) return null;
  const monthIdx = new Date(`${monthStr} 1, 2000`).getMonth();
  if (!Number.isFinite(monthIdx)) return null;
  const fullYear = year < 100 ? 2000 + year : year;
  const date = new Date(Date.UTC(fullYear, monthIdx, day));
  return Math.floor(date.getTime() / 1000);
};

const asNumber = (value: unknown): number | null => {
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return null;
};

const extractTickerIV = (data: unknown): number | null => {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  const candidates = [
    record.iv_close,
    record.iv,
    record.mark_iv,
    record.implied_volatility,
  ];
  for (const candidate of candidates) {
    const value = asNumber(candidate);
    if (!Number.isFinite(value) || value <= 0) continue;
    return value > 3 ? value / 100 : value;
  }
  return null;
};

const extractTickerMark = (data: unknown): number | null => {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  const candidates = [
    record.mark_price_close,
    record.close,
    record.mark_price,
    record.mark,
    record.last,
  ];
  for (const candidate of candidates) {
    const value = asNumber(candidate);
    if (Number.isFinite(value)) return value;
  }
  return null;
};

type ResolvedInstrument = {
  instrument_name: string;
  index_name?: string;
  option_type?: "call" | "put";
  strike_price?: number;
  expiration_timestamp?: number;
  create_time?: number;
};

const monthMap: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

const parseInstrumentFromName = (name: string): ResolvedInstrument | null => {
  const match = name.match(/^[A-Z]+-(\d{2})([A-Z]{3})(\d{2})-(\d+)-([CP])$/);
  if (!match) return null;
  const [, dd, mmm, yy, strikeStr, cp] = match;
  const day = Number(dd);
  const month = monthMap[mmm.toLowerCase()];
  const year = 2000 + Number(yy);
  if (
    !Number.isFinite(day) ||
    !Number.isFinite(month) ||
    !Number.isFinite(year)
  )
    return null;
  const strike = Number(strikeStr);
  if (!Number.isFinite(strike)) return null;
  const expiration = Math.floor(Date.UTC(year, month, day, 8, 0, 0) / 1000);
  return {
    instrument_name: name,
    option_type: cp === "P" ? "put" : "call",
    strike_price: strike,
    expiration_timestamp: expiration,
  };
};

const parseTimestampToSeconds = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    const num = Number(value);
    return num > 1e12 ? Math.floor(num / 1000) : Math.floor(num);
  }
  if (typeof value === "string") {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) {
      return asNumber > 1e12
        ? Math.floor(asNumber / 1000)
        : Math.floor(asNumber);
    }
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  return null;
};

const formatExpiryFromTs = (tsSeconds: number): string => {
  const date = new Date(tsSeconds * 1000);
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = date.toLocaleString("en-US", {
    month: "short",
    timeZone: "UTC",
  });
  const year = String(date.getUTCFullYear()).slice(-2);
  return `${day} ${month} ${year}`;
};

const normalizeInstrument = (
  instrument: ThalexInstrument,
): ResolvedInstrument | null => {
  if (!instrument?.instrument_name) return null;
  const indexName = instrument.index_name ?? instrument.underlying;
  const optionTypeRaw = instrument.option_type?.toLowerCase?.();
  const optionType =
    optionTypeRaw === "p" || optionTypeRaw === "put"
      ? "put"
      : optionTypeRaw === "c" || optionTypeRaw === "call"
        ? "call"
        : undefined;
  const strike = Number(instrument.strike_price);
  let expiration = Number(instrument.expiration_timestamp);
  const createTime = parseTimestampToSeconds(instrument.create_time);
  if (Number.isFinite(expiration) && expiration > 1e12) {
    expiration = Math.floor(expiration / 1000);
  }
  if (optionType && Number.isFinite(strike) && Number.isFinite(expiration)) {
    return {
      instrument_name: instrument.instrument_name,
      index_name: indexName,
      option_type: optionType,
      strike_price: strike,
      expiration_timestamp: expiration,
      create_time: createTime ?? undefined,
    };
  }
  const parsed = parseInstrumentFromName(instrument.instrument_name);
  if (!parsed) return null;
  return {
    ...parsed,
    index_name: indexName,
    create_time: createTime ?? undefined,
  };
};

const normalizedOptionInstruments = computed<ResolvedInstrument[]>(() =>
  instruments.value
    .map((instrument) => normalizeInstrument(instrument))
    .filter((instrument): instrument is ResolvedInstrument => !!instrument),
);

const optionLegs = computed(() =>
  positionLegs.value.filter((leg): leg is OptionLeg => leg.kind === "option"),
);

const isTickerRequested = (name: string): boolean =>
  requestedInstrumentNames.value.includes(name);

const MARK_RETRY_DELAY_MS = 1500;
const MARK_RETRY_MAX = 2;
const markFetchInFlight = new Set<string>();
const markRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const markRetryAttempts = new Map<string, number>();

const clearMarkRetry = (name: string): void => {
  const timer = markRetryTimers.get(name);
  if (timer) {
    clearTimeout(timer);
    markRetryTimers.delete(name);
  }
  markRetryAttempts.delete(name);
};

const setTickerSnapshot = (name: string, ticker: unknown): void => {
  tickerByInstrument.value = {
    ...tickerByInstrument.value,
    [name]: { data: ticker, fetchedAt: Date.now() },
  };
};

const fetchMarkSnapshot = async (name: string): Promise<boolean> => {
  if (markFetchInFlight.has(name)) return false;
  markFetchInFlight.add(name);
  try {
    const ticker = await fetchLatestMarkPrice(name);
    if (!ticker) return false;
    if (!isTickerRequested(name)) return false;
    setTickerSnapshot(name, ticker);
    clearMarkRetry(name);
    return true;
  } catch (error) {
    console.warn("Failed to fetch ticker", name, error);
    return false;
  } finally {
    markFetchInFlight.delete(name);
  }
};

const scheduleMarkRetry = (name: string): void => {
  if (markRetryTimers.has(name)) return;
  const attempts = markRetryAttempts.get(name) ?? 0;
  if (attempts >= MARK_RETRY_MAX) return;
  markRetryAttempts.set(name, attempts + 1);
  const timer = setTimeout(async () => {
    markRetryTimers.delete(name);
    if (!isTickerRequested(name)) {
      markRetryAttempts.delete(name);
      return;
    }
    if (tickerByInstrument.value[name]) {
      clearMarkRetry(name);
      return;
    }
    const ok = await fetchMarkSnapshot(name);
    if (!ok) scheduleMarkRetry(name);
  }, MARK_RETRY_DELAY_MS);
  markRetryTimers.set(name, timer);
};

const resolveInstrumentForLeg = (leg: OptionLeg): ResolvedInstrument | null => {
  const expirySeconds = parseExpiryToSeconds(leg.expiry);
  if (!expirySeconds) return null;
  const strike = Number(leg.strike);
  if (!Number.isFinite(strike)) return null;
  const type = leg.optionType?.toLowerCase();

  const candidates = normalizedOptionInstruments.value.filter((instrument) => {
    if (type && instrument.option_type?.toLowerCase() !== type) return false;
    if (Number(instrument.strike_price) !== strike) return false;
    if (!Number.isFinite(Number(instrument.expiration_timestamp))) return false;
    const diff = Math.abs(
      Number(instrument.expiration_timestamp) - expirySeconds,
    );
    return diff <= 12 * 60 * 60;
  });

  return candidates[0] ?? null;
};

const selectedInstruments = computed(
  () =>
    optionLegs.value
      .map(resolveInstrumentForLeg)
      .filter(Boolean) as ResolvedInstrument[],
);

const selectedInstrumentNames = computed(() =>
  Array.from(
    new Set(
      selectedInstruments.value.map((instrument) => instrument.instrument_name),
    ),
  ),
);

const selectedTradeLegs = computed(() =>
  optionLegs.value
    .map((leg) => {
      const instrument = resolveInstrumentForLeg(leg);
      if (!instrument?.instrument_name) return null;
      const qty = Math.max(0, Number(leg.qty) || 0);
      if (!qty) return null;
      return {
        instrument,
        signedQty: leg.side === "sell" ? -qty : qty,
      };
    })
    .filter(
      (
        entry,
      ): entry is {
        instrument: ResolvedInstrument;
        signedQty: number;
      } => Boolean(entry),
    ),
);

const tradeExpirationForInstrument = (
  instrument: ResolvedInstrument,
): string | null => {
  const fromName = instrument.instrument_name.match(/^[A-Z]+-(\d{2}[A-Z]{3}\d{2})-/);
  if (fromName?.[1]) return fromName[1];
  const ts = Number(instrument.expiration_timestamp);
  if (!Number.isFinite(ts)) return null;
  return formatExpiryFromTs(ts).replace(/\s+/g, "").toUpperCase();
};

const thalexUrl = computed(() => {
  if (!selectedTradeLegs.value.length) return undefined;
  const firstInstrument = selectedTradeLegs.value[0].instrument;
  const underlyingName = firstInstrument.index_name ?? underlying.value;
  const expiration = tradeExpirationForInstrument(firstInstrument);
  if (!expiration) return undefined;

  let url = `https://thalex.com/exchange/options?underlying=${underlyingName}&expiration=${expiration}`;

  selectedTradeLegs.value.forEach(({ instrument, signedQty }, index) => {
    url += `&instruments[${index}][0]=${instrument.instrument_name}&instruments[${index}][1]=${signedQty}`;
  });

  return url;
});

const UNDERLYING_OPTIONS = [
  { value: "BTCUSD", label: "BTC" },
  { value: "ETHUSD", label: "ETH" },
] as const;
type UnderlyingValue = (typeof UNDERLYING_OPTIONS)[number]["value"];

const underlying = ref<UnderlyingValue>("BTCUSD");

const resolvedIndexNames = computed<string[]>(() => [underlying.value]);

const switchUnderlying = (next: UnderlyingValue): void => {
  if (next === underlying.value) return;
  if (!UNDERLYING_OPTIONS.some((opt) => opt.value === next)) return;
  underlying.value = next;
  positionLegs.value = [];
  defaultTradeInitialized.value = false;
};

const extractIndexPrice = (data: unknown): number | null => {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  const candidates = [
    record.index_price_close,
    record.close,
    record.index_price,
    record.price,
  ];
  for (const candidate of candidates) {
    const value = asNumber(candidate);
    if (Number.isFinite(value)) return value;
  }
  return null;
};

const indexDisplay = computed(() => {
  const name = resolvedIndexNames.value[0];
  if (!name) return null;
  const snapshot = indexByName.value[name];
  if (!snapshot) return null;
  const price = extractIndexPrice(snapshot.data);
  if (!Number.isFinite(price)) return null;
  return {
    name,
    price: Number(price),
    fetchedAt: snapshot.fetchedAt,
  };
});

type AtmExpiryInstruments = {
  expirationTs: number;
  strike: number;
  callInstrumentName: string;
  putInstrumentName: string | null;
};

const stopLossAtmExpiryInstruments = computed<AtmExpiryInstruments[]>(() => {
  const spot = Number(indexDisplay.value?.price ?? appliedParams.s0);
  if (!Number.isFinite(spot) || spot <= 0) return [];
  const nowTs = Math.floor(Date.now() / 1000);
  const activeUnderlyingPrefix = activeIndexName.value?.replace(/USD$/, "");
  const chain = normalizedOptionInstruments.value.filter((instrument) => {
    const expiryTs = Number(instrument.expiration_timestamp);
    if (!Number.isFinite(expiryTs) || expiryTs <= nowTs) return false;
    if (activeIndexName.value) {
      if (
        instrument.index_name &&
        instrument.index_name !== activeIndexName.value
      ) {
        return false;
      }
      if (
        !instrument.index_name &&
        activeUnderlyingPrefix &&
        !instrument.instrument_name.startsWith(`${activeUnderlyingPrefix}-`)
      ) {
        return false;
      }
    }
    return Number.isFinite(Number(instrument.strike_price));
  });

  const byExpiry = new Map<number, ResolvedInstrument[]>();
  for (const instrument of chain) {
    const expiryTs = Number(instrument.expiration_timestamp);
    const group = byExpiry.get(expiryTs) ?? [];
    group.push(instrument);
    byExpiry.set(expiryTs, group);
  }

  const rows: AtmExpiryInstruments[] = [];
  for (const [expirationTs, instrumentsForExpiry] of byExpiry) {
    const calls = instrumentsForExpiry.filter(
      (instrument) => instrument.option_type === "call",
    );
    if (!calls.length) continue;
    let atmCall = calls[0];
    let bestDistance = Math.abs(Number(atmCall.strike_price) - spot);
    for (let index = 1; index < calls.length; index += 1) {
      const candidate = calls[index];
      const distance = Math.abs(Number(candidate.strike_price) - spot);
      if (
        distance < bestDistance ||
        (distance === bestDistance &&
          Number(candidate.strike_price) < Number(atmCall.strike_price))
      ) {
        atmCall = candidate;
        bestDistance = distance;
      }
    }
    const strike = Number(atmCall.strike_price);
    const matchingPut = instrumentsForExpiry.find(
      (instrument) =>
        instrument.option_type === "put" &&
        Number(instrument.strike_price) === strike,
    );
    rows.push({
      expirationTs,
      strike,
      callInstrumentName: atmCall.instrument_name,
      putInstrumentName: matchingPut?.instrument_name ?? null,
    });
  }

  return rows.sort((left, right) => left.expirationTs - right.expirationTs);
});

const stopLossInstrumentNames = computed(() =>
  stopLossAtmExpiryInstruments.value.flatMap((expiry) =>
    expiry.putInstrumentName
      ? [expiry.callInstrumentName, expiry.putInstrumentName]
      : [expiry.callInstrumentName],
  ),
);

const stopLossExpiryQuotes = computed<AtmOptionExpiryQuote[]>(() =>
  stopLossAtmExpiryInstruments.value.map((expiry) => {
    const callSnapshot = tickerByInstrument.value[expiry.callInstrumentName];
    const putSnapshot = expiry.putInstrumentName
      ? tickerByInstrument.value[expiry.putInstrumentName]
      : null;
    const fetchedAtCandidates = [
      callSnapshot?.fetchedAt,
      putSnapshot?.fetchedAt,
    ].filter((value): value is number => Number.isFinite(value));
    return {
      ...expiry,
      callIv: extractTickerIV(callSnapshot?.data),
      putIv: extractTickerIV(putSnapshot?.data),
      callMark: extractTickerMark(callSnapshot?.data),
      putMark: extractTickerMark(putSnapshot?.data),
      fetchedAt: fetchedAtCandidates.length
        ? Math.min(...fetchedAtCandidates)
        : null,
    };
  }),
);

const requestedInstrumentNames = computed(() =>
  Array.from(
    new Set([
      ...selectedInstrumentNames.value,
      ...stopLossInstrumentNames.value,
    ]),
  ),
);

const activeIndexName = computed<string | null>(
  () => resolvedIndexNames.value[0] ?? null,
);
const activeIndexSnapshot = computed<{
  data: unknown;
  fetchedAt: number;
} | null>(() => {
  const name = activeIndexName.value;
  if (!name) return null;
  return indexByName.value[name] ?? null;
});

const defaultStraddleSpec = computed<{ strike: number; expiry: string } | null>(
  () => {
    const spot = Number(indexDisplay.value?.price);
    // Wait for a live index spot so ATM is selected from real market level.
    if (!Number.isFinite(spot) || spot <= 0) return null;

    const instrumentsForIndex = normalizedOptionInstruments.value.filter(
      (instrument) => {
        if (!activeIndexName.value) return true;
        return instrument.index_name === activeIndexName.value;
      },
    );
    const source = instrumentsForIndex.length
      ? instrumentsForIndex
      : normalizedOptionInstruments.value;
    if (!source.length) return null;

    let targetExpiryTs: number | null = null;
    let oldestCreate = Number.POSITIVE_INFINITY;
    for (const instrument of source) {
      const create = Number(instrument.create_time);
      const expiryTs = Number(instrument.expiration_timestamp);
      if (!Number.isFinite(create) || !Number.isFinite(expiryTs)) continue;
      if (create < oldestCreate) {
        oldestCreate = create;
        targetExpiryTs = expiryTs;
      }
    }
    if (!Number.isFinite(targetExpiryTs)) {
      const fallbackExpiries = source
        .map((instrument) => Number(instrument.expiration_timestamp))
        .filter((ts) => Number.isFinite(ts));
      if (!fallbackExpiries.length) return null;
      targetExpiryTs = Math.min(...fallbackExpiries);
    }
    if (!Number.isFinite(targetExpiryTs)) return null;

    const expiryInstruments = source.filter(
      (instrument) =>
        Number(instrument.expiration_timestamp) === targetExpiryTs,
    );
    const callStrikes = new Set<number>();
    const putStrikes = new Set<number>();
    for (const instrument of expiryInstruments) {
      const strike = Number(instrument.strike_price);
      if (!Number.isFinite(strike)) continue;
      if (instrument.option_type === "call") callStrikes.add(strike);
      if (instrument.option_type === "put") putStrikes.add(strike);
    }

    const strikes = Array.from(callStrikes).filter((strike) =>
      putStrikes.has(strike),
    );
    if (!strikes.length) {
      strikes.push(
        ...expiryInstruments
          .map((instrument) => Number(instrument.strike_price))
          .filter((strike) => Number.isFinite(strike)),
      );
    }
    if (!strikes.length) return null;

    let nearestStrike = strikes[0];
    let bestDistance = Math.abs(nearestStrike - spot);
    for (let i = 1; i < strikes.length; i += 1) {
      const strike = strikes[i];
      const distance = Math.abs(strike - spot);
      if (
        distance < bestDistance ||
        (distance === bestDistance && strike < nearestStrike)
      ) {
        nearestStrike = strike;
        bestDistance = distance;
      }
    }

    return {
      strike: nearestStrike,
      expiry: formatExpiryFromTs(Number(targetExpiryTs)),
    };
  },
);

const optionPricingByLegId = computed<Record<string, OptionPricingInput>>(
  () => {
    const map: Record<string, OptionPricingInput> = {};
    for (const leg of optionLegs.value) {
      const instrument = resolveInstrumentForLeg(leg);
      const tickerSnapshot =
        instrument?.instrument_name != null
          ? tickerByInstrument.value[instrument.instrument_name]
          : null;
      const expirationFromInstrument = Number(instrument?.expiration_timestamp);
      const expirationTs = Number.isFinite(expirationFromInstrument)
        ? expirationFromInstrument
        : parseExpiryToSeconds(leg.expiry);

      map[leg.id] = {
        iv: extractTickerIV(tickerSnapshot?.data),
        mark: extractTickerMark(tickerSnapshot?.data),
        expirationTs,
      };
    }
    return map;
  },
);

/**
 * ROP is meaningful for a premium-funded option position. Futures and net-credit
 * positions need a margin or max-risk denominator instead, so they intentionally
 * do not report ROP here.
 */
const strategyNetDebit = computed<number | null>(() => {
  if (
    optionLegs.value.length === 0 ||
    positionLegs.value.some((leg) => leg.kind === "future")
  ) {
    return null;
  }

  let netDebit = 0;
  for (const leg of optionLegs.value) {
    const quotedMark = optionPricingByLegId.value[leg.id]?.mark;
    const entryPrice =
      quotedMark != null && Number.isFinite(quotedMark)
        ? Number(quotedMark)
        : Number(leg.premium);
    const qty = Number(leg.qty);
    if (!Number.isFinite(entryPrice) || !Number.isFinite(qty) || qty <= 0) {
      return null;
    }
    netDebit += (leg.side === "buy" ? 1 : -1) * qty * entryPrice;
  }

  return netDebit > 0 ? netDebit : null;
});

const strategyStatsRow = computed(() => {
  const stats = strategyStats.value;
  if (!stats) return null;
  const breakEvens = (stats.breakEvenPrices ?? [])
    .slice(0, 3)
    .map((price) => formatPriceWithDecimal(price));
  const netDebit = strategyNetDebit.value;
  const expectedRop =
    netDebit != null && netDebit > 0 ? stats.meanPayoff / netDebit : null;
  return {
    expectedPnl: formatSignedPayoff(stats.meanPayoff),
    expectedPnlSign: payoffSign(stats.meanPayoff),
    expectedRop: formatSignedPercent(expectedRop),
    expectedRopSign: payoffSign(expectedRop),
    netDebit: netDebit == null ? null : formatPriceWithDecimal(netDebit),
    profitChance: formatProbability(stats.winRate),
    median: formatSignedPayoff(stats.medianPayoff),
    medianSign: payoffSign(stats.medianPayoff),
    p10: formatSignedPayoff(stats.p10Payoff),
    p90: formatSignedPayoff(stats.p90Payoff),
    breakEvenText:
      breakEvens.length === 0
        ? null
        : breakEvens.length === 1
          ? breakEvens[0]
          : `${breakEvens[0]} – ${breakEvens[breakEvens.length - 1]}`,
  };
});

const strategySimulationReady = computed(() => {
  if (!defaultTradeInitialized.value) return false;
  if (optionLegs.value.length > 0 && instruments.value.length === 0) {
    return false;
  }
  return optionLegs.value.every((leg) => {
    const instrument = resolveInstrumentForLeg(leg);
    if (!instrument) return true;
    const snapshot = tickerByInstrument.value[instrument.instrument_name];
    const pricing = optionPricingByLegId.value[leg.id];
    return (
      snapshot != null &&
      Number.isFinite(pricing?.iv) &&
      Number(pricing?.iv) > 0 &&
      Number.isFinite(pricing?.mark)
    );
  });
});

const quoteValuationTs = computed<number>(() => {
  const fetchedAtMs: number[] = [];
  const indexFetchedAt = activeIndexSnapshot.value?.fetchedAt;
  if (Number.isFinite(indexFetchedAt)) {
    fetchedAtMs.push(Number(indexFetchedAt));
  }

  for (const name of requestedInstrumentNames.value) {
    const fetchedAt = tickerByInstrument.value[name]?.fetchedAt;
    if (Number.isFinite(fetchedAt)) {
      fetchedAtMs.push(Number(fetchedAt));
    }
  }

  if (!fetchedAtMs.length) {
    return Math.floor(Date.now() / 1000);
  }

  // Use the oldest available quote timestamp so all inputs are valued on the same as-of clock.
  return Math.floor(Math.min(...fetchedAtMs) / 1000);
});

const shortestExpiryDays = computed<number | null>(() => {
  const nowTs = Math.floor(Date.now() / 1000);
  const expiries = optionLegs.value
    .map((leg) => {
      const instrumentExpiry = Number(
        resolveInstrumentForLeg(leg)?.expiration_timestamp,
      );
      if (Number.isFinite(instrumentExpiry)) return instrumentExpiry;
      return parseExpiryToSeconds(leg.expiry);
    })
    .filter((ts): ts is number => Number.isFinite(ts) && ts > nowTs);
  if (!expiries.length) return null;
  const minTs = Math.min(...expiries);
  const days = Math.ceil((minTs - nowTs) / (24 * 60 * 60));
  return Math.max(1, days);
});

watch(
  () => indexDisplay.value?.price,
  (price) => {
    if (!Number.isFinite(price)) return;
    const next = Number(price);
    if (Math.abs(appliedParams.s0 - next) < 1e-9) return;
    pendingParams.s0 = next;
    appliedParams.s0 = next;
    regenerate();
  },
  { immediate: true },
);

watch(
  defaultStraddleSpec,
  (spec) => {
    if (defaultTradeInitialized.value || !spec) return;
    positionLegs.value = [
      {
        id: "leg-1",
        kind: "option",
        side: "buy",
        qty: 1,
        optionType: "call",
        strike: spec.strike,
        premium: 0,
        expiry: spec.expiry,
      },
      {
        id: "leg-2",
        kind: "option",
        side: "buy",
        qty: 1,
        optionType: "put",
        strike: spec.strike,
        premium: 0,
        expiry: spec.expiry,
      },
    ];
    defaultTradeInitialized.value = true;
  },
  { immediate: true },
);

watch(
  shortestExpiryDays,
  (minDays) => {
    if (!Number.isFinite(minDays) || minDays == null) return;
    const nextT = Number(minDays) / 365.25;
    const nextDt = nextT / simTimeSteps.value;
    if (
      Math.abs(appliedParams.T - nextT) < 1e-9 &&
      Math.abs(appliedParams.dt - nextDt) < 1e-12
    )
      return;
    pendingParams.T = nextT;
    appliedParams.T = nextT;
    if (Number.isFinite(nextDt) && nextDt > 0) {
      pendingParams.dt = nextDt;
      appliedParams.dt = nextDt;
    }
    regenerate();
  },
  { immediate: true },
);

watch(
  () => appliedParams.rows,
  (rows) => {
    rowsSlider.value = rows;
    if (cloudPathLimit.value > rows) {
      cloudPathLimit.value = clampInt(rows, DRAWN_PATHS_MIN, DRAWN_PATHS_MAX);
    }
  },
  { immediate: true },
);

onUnmounted(() => {
  clearNPopoverHideTimer();
  clearRowsApplyTimer();
  document.removeEventListener("pointerdown", handleSettingsPointerDown);
  document.removeEventListener("keydown", handleSettingsKeydown);
  for (const timer of markRetryTimers.values()) {
    clearTimeout(timer);
  }
  markRetryTimers.clear();
  markRetryAttempts.clear();
  markFetchInFlight.clear();
});

onMounted(async () => {
  document.addEventListener("pointerdown", handleSettingsPointerDown);
  document.addEventListener("keydown", handleSettingsKeydown);
  try {
    instruments.value = await fetchInstruments();
  } catch (error) {
    console.error("Failed to load Thalex instruments", error);
  }
});

watch(
  requestedInstrumentNames,
  async (names) => {
    if (!names.length) {
      for (const name of Array.from(markRetryTimers.keys())) {
        clearMarkRetry(name);
      }
      return;
    }
    const active = new Set(names);
    for (const name of Array.from(markRetryTimers.keys())) {
      if (!active.has(name)) clearMarkRetry(name);
    }
    await Promise.all(
      names.map(async (name) => {
        if (tickerByInstrument.value[name]) return;
        const ok = await fetchMarkSnapshot(name);
        if (!ok) scheduleMarkRetry(name);
      }),
    );
  },
  { immediate: true },
);

watch(
  resolvedIndexNames,
  async (names) => {
    if (!names.length) return;
    const updates: Record<string, { data: unknown; fetchedAt: number }> = {
      ...indexByName.value,
    };
    await Promise.all(
      names.map(async (name) => {
        if (updates[name]) return;
        try {
          const indexPrice = await fetchLatestIndexPrice(name);
          if (indexPrice)
            updates[name] = { data: indexPrice, fetchedAt: Date.now() };
        } catch (error) {
          console.warn("Failed to fetch index price", name, error);
        }
      }),
    );
    indexByName.value = updates;
  },
  { immediate: true },
);
</script>

<template>
  <main ref="appMainRef" class="app-main">
    <header class="top-bar">
      <div class="top-bar-content">
        <div class="wordmark">Simulator</div>
        <div class="top-divider" aria-hidden="true"></div>
        <nav class="simulator-tabs" aria-label="Simulator views">
          <button
            type="button"
            :class="{ 'is-active': activeSimulatorTab === 'strategy' }"
            :aria-current="activeSimulatorTab === 'strategy' ? 'page' : undefined"
            @click="activeSimulatorTab = 'strategy'"
          >
            Strategy
          </button>
          <button
            type="button"
            :class="{ 'is-active': activeSimulatorTab === 'stop-loss' }"
            :aria-current="activeSimulatorTab === 'stop-loss' ? 'page' : undefined"
            @click="activeSimulatorTab = 'stop-loss'"
          >
            Stop-loss
          </button>
        </nav>
        <div class="top-divider" aria-hidden="true"></div>
        <div class="underlying-toggle" role="group" aria-label="Underlying">
          <button
            v-for="opt in UNDERLYING_OPTIONS"
            :key="opt.value"
            type="button"
            class="underlying-button"
            :class="{ 'underlying-button--active': underlying === opt.value }"
            @click="switchUnderlying(opt.value)"
          >
            {{ opt.label }}
          </button>
        </div>
        <div class="top-spacer"></div>
        <button
          type="button"
          class="save-png-button"
          :disabled="exportInProgress"
          @click="handleSavePng"
        >
          {{ exportInProgress ? "Saving..." : "Save PNG" }}
        </button>
        <a
          v-if="thalexUrl && activeSimulatorTab === 'strategy'"
          :href="thalexUrl"
          class="trade-thalex-button"
          target="_blank"
          rel="noopener"
        >
          Trade on Thalex
        </a>
        <div ref="settingsMenuRef" class="top-settings-wrap">
          <button
            type="button"
            class="top-settings-button"
            title="Simulation settings"
            aria-label="Simulation settings"
            aria-haspopup="dialog"
            :aria-expanded="settingsOpen"
            @click="toggleSimSettings"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="3"></circle>
              <path
                d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.09a2 2 0 0 1 1 1.73v.51a2 2 0 0 1-1 1.73l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.73v-.51a2 2 0 0 1 1-1.73l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
              ></path>
            </svg>
          </button>
          <section
            v-if="settingsOpen"
            class="sim-settings-popover"
            role="dialog"
            aria-label="Simulation settings"
          >
            <header class="settings-popover-header">
              <div>
                <strong>Simulation settings</strong>
                <small>Path dynamics and graph rendering</small>
              </div>
              <button
                type="button"
                class="settings-reset"
                @click="resetPathModel"
              >
                Reset model
              </button>
            </header>

            <div class="settings-section">
              <div class="settings-section-heading">
                <span>Path model</span>
                <small>RV is the only volatility level</small>
              </div>
              <div class="path-model-toggle" role="group" aria-label="Path model">
                <button
                  type="button"
                  class="has-settings-tooltip"
                  :data-tooltip="SETTINGS_TOOLTIPS.constantVol"
                  :aria-description="SETTINGS_TOOLTIPS.constantVol"
                  :class="{ 'is-active': pathModelDraft.kind === 'gbm' }"
                  :aria-pressed="pathModelDraft.kind === 'gbm'"
                  @click="pathModelDraft.kind = 'gbm'"
                >
                  Constant vol
                </button>
                <button
                  type="button"
                  class="has-settings-tooltip"
                  :data-tooltip="SETTINGS_TOOLTIPS.stochasticVol"
                  :aria-description="SETTINGS_TOOLTIPS.stochasticVol"
                  :class="{ 'is-active': pathModelDraft.kind === 'bates' }"
                  :aria-pressed="pathModelDraft.kind === 'bates'"
                  @click="pathModelDraft.kind = 'bates'"
                >
                  Stochastic vol
                </button>
              </div>
              <p class="settings-model-note">
                Variance starts at RV². The 1σ move is converted to vol-of-vol
                for the selected horizon. Spot/vol correlation controls the skew;
                there is no mean-reversion or separate long-run volatility target.
              </p>

              <div
                class="settings-fields"
                :class="{ 'is-disabled': pathModelDraft.kind !== 'bates' }"
              >
                <label
                  class="sim-settings-row has-settings-tooltip"
                  :data-tooltip="SETTINGS_TOOLTIPS.volOfVol"
                >
                  <span>1σ vol move</span>
                  <span class="settings-input-unit">
                    <input
                      class="sim-settings-input"
                      type="text"
                      inputmode="decimal"
                      autocomplete="off"
                      spellcheck="false"
                      :disabled="pathModelDraft.kind !== 'bates'"
                      :aria-description="SETTINGS_TOOLTIPS.volOfVol"
                      :value="
                        settingsFieldValue('volOfVol', horizonVolMovePoints())
                      "
                      @focus="beginSettingsFieldEdit('volOfVol', $event)"
                      @input="
                        updateSettingsFieldDraft(
                          'volOfVol',
                          ($event.target as HTMLInputElement).value,
                        )
                      "
                      @blur="
                        commitSettingsField(
                          'volOfVol',
                          setHorizonVolMovePoints,
                        )
                      "
                      @keydown.enter="onSettingsFieldEnter"
                    />
                    <i>pts</i>
                  </span>
                </label>
                <label
                  class="sim-settings-row has-settings-tooltip"
                  :data-tooltip="SETTINGS_TOOLTIPS.correlation"
                >
                  <span>
                    Spot / vol corr. <i>ρ</i>
                  </span>
                  <input
                    class="sim-settings-input"
                    type="text"
                    inputmode="decimal"
                    autocomplete="off"
                    spellcheck="false"
                    :disabled="pathModelDraft.kind !== 'bates'"
                    :aria-description="SETTINGS_TOOLTIPS.correlation"
                    :value="
                      settingsFieldValue(
                        'correlation',
                        pathModelDraft.correlation,
                      )
                    "
                    @focus="beginSettingsFieldEdit('correlation', $event)"
                    @input="
                      updateSettingsFieldDraft(
                        'correlation',
                        ($event.target as HTMLInputElement).value,
                      )
                    "
                    @blur="
                      commitSettingsField('correlation', (n) =>
                        setPathModelNumber('correlation', n, -0.99, 0.99, 3),
                      )
                    "
                    @keydown.enter="onSettingsFieldEnter"
                  />
                </label>
              </div>
            </div>

            <div class="settings-section settings-section--graph">
              <div class="settings-section-heading">
                <span>Graph</span>
              </div>
              <div class="settings-fields">
                <label
                  class="sim-settings-row has-settings-tooltip"
                  :data-tooltip="SETTINGS_TOOLTIPS.timeSteps"
                >
                  <span>Time steps</span>
                  <input
                    class="sim-settings-input"
                    type="text"
                    inputmode="numeric"
                    autocomplete="off"
                    spellcheck="false"
                    :aria-description="SETTINGS_TOOLTIPS.timeSteps"
                    :value="
                      settingsFieldValue(
                        'timeSteps',
                        graphSettingsDraft.timeSteps,
                      )
                    "
                    @focus="beginSettingsFieldEdit('timeSteps', $event)"
                    @input="
                      updateSettingsFieldDraft(
                        'timeSteps',
                        ($event.target as HTMLInputElement).value,
                      )
                    "
                    @blur="
                      commitSettingsField('timeSteps', setDraftTimeSteps)
                    "
                    @keydown.enter="onSettingsFieldEnter"
                  />
                </label>
                <label
                  class="sim-settings-row has-settings-tooltip"
                  :data-tooltip="SETTINGS_TOOLTIPS.pathLimit"
                >
                  <span>Paths drawn</span>
                  <input
                    class="sim-settings-input"
                    type="text"
                    inputmode="numeric"
                    autocomplete="off"
                    spellcheck="false"
                    :aria-description="SETTINGS_TOOLTIPS.pathLimit"
                    :value="
                      settingsFieldValue(
                        'pathLimit',
                        graphSettingsDraft.pathLimit,
                      )
                    "
                    @focus="beginSettingsFieldEdit('pathLimit', $event)"
                    @input="
                      updateSettingsFieldDraft(
                        'pathLimit',
                        ($event.target as HTMLInputElement).value,
                      )
                    "
                    @blur="
                      commitSettingsField('pathLimit', setDraftPathLimit)
                    "
                    @keydown.enter="onSettingsFieldEnter"
                  />
                </label>
                <label
                  class="sim-settings-row has-settings-tooltip"
                  :data-tooltip="SETTINGS_TOOLTIPS.binsMultiplier"
                >
                  <span>Histogram bins</span>
                  <span class="settings-input-unit">
                    <i>×</i>
                    <input
                      class="sim-settings-input"
                      type="text"
                      inputmode="decimal"
                      autocomplete="off"
                      spellcheck="false"
                      :aria-description="SETTINGS_TOOLTIPS.binsMultiplier"
                      :value="
                        settingsFieldValue(
                          'binsMultiplier',
                          graphSettingsDraft.binsMultiplier,
                        )
                      "
                      @focus="beginSettingsFieldEdit('binsMultiplier', $event)"
                      @input="
                        updateSettingsFieldDraft(
                          'binsMultiplier',
                          ($event.target as HTMLInputElement).value,
                        )
                      "
                      @blur="
                        commitSettingsField(
                          'binsMultiplier',
                          setDraftBinsMultiplier,
                        )
                      "
                      @keydown.enter="onSettingsFieldEnter"
                    />
                  </span>
                </label>
              </div>
            </div>
            <footer class="settings-actions">
              <button
                type="button"
                class="settings-action settings-action--cancel"
                @click="closeSimSettings"
              >
                Cancel
              </button>
              <button
                type="button"
                class="settings-action settings-action--confirm"
                @click="confirmSimSettings"
              >
                Confirm changes
              </button>
            </footer>
          </section>
        </div>
      </div>
    </header>

    <div
      ref="workspaceRef"
      class="workspace-container"
      :class="{
        'workspace-container--stop-loss': activeSimulatorTab === 'stop-loss',
      }"
    >
      <div v-if="activeSimulatorTab === 'strategy'" class="simulation-main">
        <aside class="metrics-column" aria-label="Strategy outcome summary">
            <div v-if="strategyStatsRow" class="outcome-summary">
              <div class="outcome-metric outcome-metric--primary">
                <span class="outcome-label">Expected P&amp;L</span>
                <span
                  class="outcome-value"
                  :class="`is-${strategyStatsRow.expectedPnlSign}`"
                >{{ strategyStatsRow.expectedPnl }}</span>
              </div>
              <div
                v-if="strategyStatsRow.netDebit"
                class="outcome-metric"
                title="Expected P&amp;L divided by the net option premium paid"
              >
                <span class="outcome-label">Expected ROP</span>
                <span
                  class="outcome-value"
                  :class="`is-${strategyStatsRow.expectedRopSign}`"
                >{{ strategyStatsRow.expectedRop }}</span>
              </div>
              <div class="outcome-metric">
                <span class="outcome-label">Chance of profit</span>
                <span class="outcome-value">{{
                  strategyStatsRow.profitChance
                }}</span>
              </div>
              <div class="outcome-metric outcome-metric--range">
                <span class="outcome-label">P10–P90 outcome</span>
                <span class="outcome-range">
                  {{ strategyStatsRow.p10 }} | {{ strategyStatsRow.p90 }}
                </span>
              </div>
            </div>
            <div v-if="strategyStatsRow" class="chart-stats-row">
              <span class="chart-stats-item">
                <span class="chart-stats-label">Median</span>
                <span
                  class="chart-stats-value"
                  :class="`is-${strategyStatsRow.medianSign}`"
                >{{ strategyStatsRow.median }}</span>
              </span>
              <span
                v-if="strategyStatsRow.breakEvenText"
                class="chart-stats-item"
              >
                <span class="chart-stats-label">Break-even</span>
                <span class="chart-stats-value">{{
                  strategyStatsRow.breakEvenText
                }}</span>
              </span>
            </div>
        </aside>

        <div class="simulator-column">
          <section class="builder-section">
            <PositionBuilder
              v-model:legs="positionLegs"
              :spot="appliedParams.s0"
              :vol="appliedParams.vol"
              :T="appliedParams.T"
              :instruments="instruments"
              :tickerByInstrument="tickerByInstrument"
              :indexName="activeIndexName"
              :indexPrice="indexDisplay?.price ?? null"
              :indexFetchedAt="activeIndexSnapshot?.fetchedAt ?? null"
            />
          </section>

          <section ref="chartSectionRef" class="chart-section">

          <div class="chart-header">
            <div class="chart-detail-row">
              <div class="chart-meta">
                <span class="chart-meta-heading">Model</span>
                <label class="chart-meta-assumption">
                  <span class="chart-meta-key">Drift</span>
                  <input
                    class="chart-meta-input"
                    type="number"
                    :min="driftBounds.min * 100"
                    :max="driftBounds.max * 100"
                    step="0.1"
                    :value="guideMuPercent"
                    aria-label="Annual drift percentage"
                    @focus="selectNumericInput"
                    @change="
                      setMuPercentFromInput(
                        Number(($event.target as HTMLInputElement).value),
                      )
                    "
                    @keydown.enter="
                      ($event.currentTarget as HTMLInputElement).blur()
                    "
                  />
                  <span class="chart-meta-unit">%</span>
                </label>
                <label class="chart-meta-assumption">
                  <span class="chart-meta-key">Volatility</span>
                  <input
                    class="chart-meta-input"
                    type="number"
                    :min="volBounds.min * 100"
                    :max="volBounds.max * 100"
                    step="0.1"
                    :value="guideVolPercent"
                    aria-label="Annual volatility percentage"
                    @focus="selectNumericInput"
                    @change="
                      setVolPercentFromInput(
                        Number(($event.target as HTMLInputElement).value),
                      )
                    "
                    @keydown.enter="
                      ($event.currentTarget as HTMLInputElement).blur()
                    "
                  />
                  <span class="chart-meta-unit">%</span>
                </label>
                <span
                  ref="nLabelRef"
                  class="chart-meta-n"
                  @pointerenter="handleNLabelEnter"
                  @pointerleave="handleNLabelLeave"
                >
                  <span class="chart-meta-key">Paths <i>n</i></span>
                  <span class="chart-meta-value">{{ guideRows }}</span>
                </span>
                <span
                  class="chart-meta-setting has-settings-tooltip"
                  :class="{ 'is-inactive': pathModel.kind !== 'bates' }"
                  :data-tooltip="MODEL_METRIC_TOOLTIPS.volOfVol"
                  :aria-description="MODEL_METRIC_TOOLTIPS.volOfVol"
                  tabindex="0"
                >
                  <span class="chart-meta-key">Vol-of-vol</span>
                  <span class="chart-meta-value">
                    1σ {{ modelVolMovePoints }} pts
                  </span>
                </span>
                <span
                  class="chart-meta-setting has-settings-tooltip"
                  :class="{ 'is-inactive': pathModel.kind !== 'bates' }"
                  :data-tooltip="MODEL_METRIC_TOOLTIPS.correlation"
                  :aria-description="MODEL_METRIC_TOOLTIPS.correlation"
                  tabindex="0"
                >
                  <span class="chart-meta-key">Spot/vol <i>ρ</i></span>
                  <span class="chart-meta-value">
                    {{ modelSpotVolCorrelation }}
                  </span>
                </span>
                <span class="chart-horizon-label">
                  Horizon <i>{{ horizonDaysLabel }}</i>
                </span>
              </div>
            </div>
          </div>
          <div class="histogram-toggle" role="group" aria-label="Histogram view">
            <button
              type="button"
              :class="{ 'is-active': histogramMode === 'payoff' }"
              :aria-pressed="histogramMode === 'payoff'"
              @click="histogramMode = 'payoff'"
            >
              PnL
            </button>
            <button
              type="button"
              :class="{ 'is-active': histogramMode === 'prob' }"
              :aria-pressed="histogramMode === 'prob'"
              title="P&amp;L weighted by the frequency of each terminal-price bin"
              @click="histogramMode = 'prob'"
            >
              EV
            </button>
          </div>
      <div
        v-if="nPopoverOpen && nPopoverAnchor"
        class="rows-popover"
        :style="{
          left: `${nPopoverAnchor.left + nPopoverAnchor.width / 2}px`,
          top: `${nPopoverAnchor.top + nPopoverAnchor.height}px`,
        }"
        @mouseenter="handleNPopoverMouseEnter"
        @mouseleave="handleNPopoverMouseLeave"
      >
        <div class="rows-popover-head">
          <span class="rows-popover-label">Number of paths:</span>
          <span class="rows-popover-value">{{ guideRows }}</span>
        </div>
        <input
          class="rows-popover-slider"
          type="range"
          :min="ROWS_MIN"
          :max="ROWS_MAX"
          :step="ROWS_STEP"
          :value="rowsSlider"
          @input="
            setRowsFromSlider(Number(($event.target as HTMLInputElement).value))
          "
          @change="flushRowsFromSlider"
        />
        <div class="rows-popover-scale">
          <span>{{ ROWS_MIN }}</span>
          <span>{{ ROWS_MAX }}</span>
        </div>
      </div>
          <CloudChart
        v-if="strategySimulationReady"
        :seed="seed"
        :params="appliedParams"
        :pathModel="pathModel"
        :valuationTs="quoteValuationTs"
        :samplePathLimit="cloudPathLimit"
        :muMin="driftBounds.min"
        :muMax="driftBounds.max"
        :volMin="volBounds.min"
        :volMax="volBounds.max"
        :histMode="histogramMode"
        :histogramOpacity="0.9"
        :colorMin="colorMinPercent / 100"
        :colorMax="colorMaxPercent / 100"
        :histBinsMultiplier="histBinsMultiplier"
        :legs="positionLegs"
        :optionPricingByLegId="optionPricingByLegId"
        @set-mu="setMuFromChart"
        @set-vol="setVolFromChart"
        @guide-update="updateGuide"
        @stats-update="strategyStats = $event"
          />
          <div v-else class="strategy-chart-loading">
            Loading selected option quotes…
          </div>
          <div class="histogram-legend" aria-label="Histogram label legend">
            <span class="histogram-legend-title">Histogram labels</span>
            <span class="histogram-legend-item">
              <span class="histogram-legend-mark histogram-legend-mark--axis"></span>
              Left: terminal-price frequency
            </span>
            <span class="histogram-legend-item">
              <span class="histogram-legend-mark histogram-legend-mark--average"></span>
              Right:
              {{
                histogramMode === 'prob'
                  ? 'expected-value contribution'
                  : 'median PnL'
              }}
              per price bin
            </span>
            <span v-if="histogramMode === 'prob'" class="histogram-legend-item"
              title="Signed EV accumulated from low to high terminal prices; the number above the endpoint is total EV.">
              <span class="histogram-legend-mark histogram-legend-mark--cumulative"></span>
              Cumulative EV
            </span>
            <span class="histogram-legend-item">
              <span class="histogram-legend-mark histogram-legend-mark--break-even"></span>
              Shaded: break-even prices
            </span>
          </div>
          </section>
        </div>
      </div>
      <StopLossSimulator
        v-else
        :key="underlying"
        :seed="seed"
        :params="appliedParams"
        :pathModel="pathModel"
        :valuationTs="quoteValuationTs"
        :samplePathLimit="cloudPathLimit"
        :colorMin="colorMinPercent / 100"
        :colorMax="colorMaxPercent / 100"
        :histBinsMultiplier="histBinsMultiplier"
        :expiryQuotes="stopLossExpiryQuotes"
        @set-mu="setMuFromChart"
        @set-vol="setVolFromChart"
        @resimulate="regenerate"
      />
    </div>
  </main>
</template>

<style scoped>
:global(:root) {
  --color-bg: #0a0b0e;
  --color-surface: #131316;
  --color-surface-raised: #1a1a1f;
  --color-text: #e8eaed;
  --color-text-muted: #70767d;
  --color-accent: #7dd3fc;
  --color-border-subtle: rgba(255, 255, 255, 0.06);
  --color-border: rgba(255, 255, 255, 0.09);
  --color-border-strong: rgba(255, 255, 255, 0.2);
}

:global(body) {
  min-width: 320px;
  background: var(--color-bg);
  color: var(--color-text);
  font-family:
    "Helvetica Neue",
    Helvetica,
    -apple-system,
    sans-serif;
  color-scheme: dark;
}

.app-main {
  /*
   * Scale continuously from 1080px to 1920px of usable content. Avoid a
   * breakpoint jump when browser zoom changes the CSS viewport width.
   */
  --workspace-max-width: clamp(1136px, calc(100vw - 584px), 1976px);
  --text-primary: var(--color-text);
  --text-muted: var(--color-text-muted);
  display: flex;
  flex-direction: column;
  gap: 0;
  width: 100%;
  min-height: 100vh;
  background: var(--color-bg);
  font-family:
    "Helvetica Neue",
    Helvetica,
    -apple-system,
    sans-serif;
}

.app-main :deep(:focus-visible) {
  outline: none;
}

.app-main.is-exporting-stop-loss :deep(.comparison-bar),
.app-main.is-exporting-stop-loss :deep(.comparison-row > header),
.app-main.is-exporting-stop-loss :deep(.histogram-tooltip) {
  display: none !important;
}

.app-main.is-exporting-strategy .workspace-container {
  box-sizing: border-box;
  width: 1504px;
  max-width: 1504px;
  padding-right: 24px;
  padding-left: 24px;
}

.app-main.is-exporting-strategy .simulation-main {
  grid-template-columns: 190px minmax(0, 1fr);
}

.app-main.is-exporting-strategy .metrics-column,
.app-main.is-exporting-strategy .outcome-summary,
.app-main.is-exporting-strategy .chart-stats-row {
  gap: 22px;
}

.app-main.is-exporting-strategy .outcome-value,
.app-main.is-exporting-strategy .outcome-range,
.app-main.is-exporting-strategy .chart-stats-value {
  font-size: 24px;
}

.app-main.is-exporting-strategy .chart-meta {
  gap: 16px;
  font-size: 13px;
}

.app-main.is-exporting-strategy .chart-meta-heading,
.app-main.is-exporting-strategy .chart-meta-key,
.app-main.is-exporting-strategy .chart-horizon-label {
  font-size: 12px;
}

.app-main.is-exporting-strategy .chart-meta-input {
  width: 52px;
}

.app-main.is-exporting-strategy .builder-section :deep(.index-summary) {
  font-size: 14px;
}

.app-main.is-exporting-strategy .builder-section :deep(.index-label),
.app-main.is-exporting-strategy .builder-section :deep(.field-header) {
  font-size: 12px;
}

.app-main.is-exporting-strategy .builder-section :deep(.index-time),
.app-main.is-exporting-strategy .builder-section :deep(.tte-cell) {
  font-size: 12px;
}

.app-main.is-exporting-strategy .builder-section :deep(.side-pill),
.app-main.is-exporting-strategy .builder-section :deep(.qty-input),
.app-main.is-exporting-strategy .builder-section :deep(.type-pill),
.app-main.is-exporting-strategy
  .builder-section
  :deep(.styled-select-trigger) {
  font-size: 14px;
}

.app-main.is-exporting-strategy .histogram-toggle {
  gap: 4px;
  padding: 3px;
}

.app-main.is-exporting-strategy .histogram-toggle button {
  min-width: 52px;
}

.app-main.is-exporting-strategy .histogram-legend {
  gap: 18px;
  font-size: 10px;
}

.app-main.is-exporting-strategy .histogram-legend-title {
  font-size: 9px;
}

:deep(input),
:deep(textarea),
:deep(button) {
  font-family: inherit;
}

:deep(button) {
  appearance: none;
  border: none;
  border-radius: 0;
  padding: 0;
  font-weight: inherit;
  font-size: inherit;
  color: inherit;
  background: none;
  cursor: pointer;
  box-shadow: none;
}

.builder-section {
  grid-area: selector;
  width: 100%;
  min-width: 0;
  /* Place the first fixed-width combo control on the shared workspace grid. */
  padding: 20px 0 8px max(0px, calc(3.035714% - 8px));
  overflow-x: auto;
}

.top-bar {
  --top-control-height: 32px;
  position: relative;
  z-index: 40;
  width: 100%;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  flex-shrink: 0;
}

.top-bar-content {
  display: flex;
  align-items: center;
  width: 100%;
  height: 58px;
  margin: 0 auto;
  padding: 0 28px;
  gap: 20px;
}

.workspace-container {
  width: 100%;
  max-width: none;
  margin: 0 auto;
  padding: 0 36px 28px 28px;
}

.workspace-container--stop-loss {
  box-sizing: border-box;
  max-width: 2200px;
  padding-right: clamp(20px, 2vw, 40px);
  padding-left: clamp(20px, 2vw, 40px);
}

.wordmark {
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text);
}

.top-divider {
  display: none;
}

.top-spacer {
  flex: 1;
}

.simulator-tabs {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}

.simulator-tabs button {
  height: var(--top-control-height);
  padding: 0 11px;
  border-radius: 7px;
  color: var(--color-text-muted);
  font-size: 11px;
  font-weight: 500;
}

.simulator-tabs button:hover:not(.is-active) {
  color: var(--color-text);
  background: rgba(255, 255, 255, 0.035);
}

.simulator-tabs button.is-active {
  color: var(--color-text);
  background: var(--color-surface);
}

.underlying-toggle {
  box-sizing: border-box;
  height: var(--top-control-height);
  display: inline-flex;
  align-items: center;
  overflow: hidden;
  padding: 0;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: transparent;
}

.underlying-button {
  box-sizing: border-box;
  height: 100%;
  background: transparent;
  color: var(--color-text-muted);
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  padding: 0 14px;
  border-radius: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.underlying-button + .underlying-button {
  border-left: 1px solid var(--color-border);
}

.underlying-button:hover:not(.underlying-button--active) {
  color: var(--color-text);
  background: var(--color-surface);
}

.underlying-button--active {
  background: var(--color-surface);
  color: var(--color-text);
  font-weight: 600;
}

.trade-thalex-button {
  box-sizing: border-box;
  height: var(--top-control-height);
  padding: 0 13px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: transparent;
  color: var(--color-text);
  font-size: 12px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
  text-decoration: none;
  white-space: nowrap;
}

.trade-thalex-button:hover {
  border-color: var(--color-border-strong);
}

.simulation-main {
  display: grid;
  grid-template-columns: 170px minmax(0, 1fr);
  grid-template-areas:
    ". selector"
    "metrics chart";
  align-items: start;
  gap: 8px;
  min-width: 0;
}

.simulator-column {
  display: contents;
}

.chart-header {
  position: absolute;
  inset: 0;
  z-index: 8;
  pointer-events: none;
}

.metrics-column {
  grid-area: metrics;
  display: flex;
  flex-direction: column;
  gap: 26px;
  width: 100%;
  padding-top: 44px;
}

.outcome-summary {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 27px;
  width: 100%;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.outcome-metric {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  min-width: 0;
}

.outcome-label {
  order: 2;
  color: #70767d;
  font-size: 12px;
  font-weight: 400;
  letter-spacing: 1.2px;
  line-height: 1;
  text-transform: uppercase;
}

.outcome-value {
  order: 1;
  color: #e8eaed;
  font-size: 20px;
  font-weight: 300;
  letter-spacing: -0.3px;
  line-height: 1.1;
}

.outcome-range {
  order: 1;
  color: #e8eaed;
  font-size: 20px;
  font-weight: 300;
  letter-spacing: -0.3px;
  line-height: 1.1;
}

.outcome-summary .is-pos,
.outcome-summary .is-neg,
.outcome-summary .is-zero,
.chart-stats-row .is-pos,
.chart-stats-row .is-neg,
.chart-stats-row .is-zero {
  color: #e8eaed;
}

.chart-stats-row {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 27px;
  width: 100%;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.chart-stats-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
}

.chart-stats-label {
  order: 2;
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 400;
  letter-spacing: 1.2px;
  text-transform: uppercase;
}

.chart-stats-value {
  order: 1;
  color: #e8eaed;
  font-size: 20px;
  font-weight: 300;
}

.chart-detail-row {
  position: static;
}

.chart-meta {
  position: absolute;
  top: 5px;
  right: 18%;
  left: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: calc(var(--chart-header-height) - 5px);
  font-size: 11px;
  white-space: nowrap;
  pointer-events: auto;
}

.chart-meta-heading {
  color: #70767d;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.5px;
  text-transform: uppercase;
}

.chart-meta-key {
  color: #70767d;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.5px;
}

.chart-meta-key i,
.chart-horizon-label i {
  color: #e8eaed;
  font-style: normal;
  font-weight: 600;
}

.chart-meta-value {
  color: #e8eaed;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}

.chart-meta-assumption {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: text;
}

.chart-meta-input {
  box-sizing: content-box;
  width: 46px;
  padding: 3px 4px;
  border: 1px solid transparent;
  border-radius: 4px;
  outline: 0;
  background: transparent;
  color: #e8eaed;
  font: inherit;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  text-align: right;
  appearance: textfield;
}

.chart-meta-assumption:hover .chart-meta-input,
.chart-meta-input:focus {
  border-color: rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.05);
  color: #e8eaed;
}

.chart-meta-input::-webkit-inner-spin-button,
.chart-meta-input::-webkit-outer-spin-button {
  margin: 0;
  -webkit-appearance: none;
}

.chart-meta-unit {
  margin-left: -4px;
  color: #e8eaed;
  font-weight: 500;
}

.chart-meta-n {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  padding: 4px 6px;
  margin: -4px -6px;
  border-radius: 4px;
}

.chart-meta-n:hover {
  background: rgba(255, 255, 255, 0.06);
}

.chart-meta-setting {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: help;
  outline: none;
}

.chart-meta-setting.is-inactive > .chart-meta-key,
.chart-meta-setting.is-inactive > .chart-meta-value {
  opacity: 0.42;
}

.chart-horizon-label {
  color: #70767d;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.5px;
  text-transform: uppercase;
}

.save-png-button {
  box-sizing: border-box;
  flex-shrink: 0;
  height: var(--top-control-height);
  padding: 0 13px;
  border-radius: 8px;
  border: 1px solid var(--color-border);
  background: transparent;
  color: var(--color-text);
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
}

.save-png-button:hover:not(:disabled) {
  border-color: var(--color-border-strong);
  background: var(--color-surface);
}

.save-png-button:disabled {
  cursor: default;
  opacity: 0.45;
}

.top-settings-wrap {
  position: relative;
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

.top-settings-button {
  width: 30px;
  height: 30px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.08);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.top-settings-button svg {
  width: 16px;
  height: 16px;
  color: #d8dce4;
}

.top-settings-button:hover,
.top-settings-button[aria-expanded="true"] {
  background: rgba(255, 255, 255, 0.15);
}

.top-settings-button:focus-visible {
  outline: 1px solid rgba(255, 255, 255, 0.7);
  outline-offset: 2px;
}

.sim-settings-popover {
  position: absolute;
  top: calc(100% + 10px);
  right: 0;
  z-index: 50;
  width: min(344px, calc(100vw - 32px));
  max-height: calc(100vh - 82px);
  padding: 14px;
  overflow-y: auto;
  overscroll-behavior: contain;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.15);
  background: rgba(8, 10, 15, 0.98);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(12px);
}

.settings-popover-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 0 1px 12px;
}

.settings-popover-header > div {
  display: grid;
  gap: 3px;
}

.settings-popover-header strong {
  color: #e8eaed;
  font-size: 12px;
  font-weight: 600;
}

.settings-popover-header small {
  color: var(--text-muted);
  font-size: 9px;
  font-weight: 500;
}

.settings-reset {
  padding: 2px 0;
  border: none;
  background: transparent;
  color: #8e959e;
  font-size: 9px;
  font-weight: 600;
  white-space: nowrap;
}

.settings-reset:hover {
  color: #e8eaed;
}

.settings-section {
  padding: 12px 1px 2px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}

.settings-section--graph {
  margin-top: 10px;
}

.settings-section-heading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 9px;
}

.settings-section-heading > span {
  color: #d8dde5;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}

.settings-section-heading small {
  color: #666d76;
  font-size: 8px;
  font-weight: 500;
}

.path-model-toggle {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 3px;
  padding: 3px;
  border-radius: 7px;
  background: rgba(255, 255, 255, 0.055);
}

.path-model-toggle button {
  height: 26px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: #777f89;
  font-size: 10px;
  font-weight: 600;
}

.path-model-toggle button:hover {
  color: #d8dde5;
}

.path-model-toggle button.is-active {
  background: rgba(255, 255, 255, 0.105);
  color: #e8eaed;
}

.has-settings-tooltip {
  position: relative;
}

.has-settings-tooltip::after {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 0;
  z-index: 90;
  width: 224px;
  padding: 8px 9px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 6px;
  background: #15181e;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.42);
  color: #c9cfd8;
  content: attr(data-tooltip);
  font-size: 9px;
  font-style: normal;
  font-weight: 500;
  line-height: 1.45;
  letter-spacing: 0;
  text-align: left;
  text-transform: none;
  white-space: normal;
  pointer-events: none;
  opacity: 0;
  visibility: hidden;
  transform: translateY(3px);
  transition:
    opacity 100ms ease,
    transform 100ms ease,
    visibility 100ms ease;
}

.path-model-toggle .has-settings-tooltip::after {
  top: calc(100% + 6px);
  bottom: auto;
  transform: translateY(-3px);
}

.path-model-toggle .has-settings-tooltip:last-child::after {
  right: 0;
  left: auto;
}

.has-settings-tooltip:hover::after,
.has-settings-tooltip:focus-visible::after,
.has-settings-tooltip:focus-within::after {
  opacity: 1;
  visibility: visible;
  transform: translateY(0);
  transition-delay: 160ms;
}

.settings-model-note {
  margin: 8px 2px 11px;
  color: #676e77;
  font-size: 8.5px;
  font-weight: 500;
  line-height: 1.45;
}

.settings-fields {
  display: grid;
  gap: 7px;
  transition: opacity 120ms ease;
}

.settings-fields.is-disabled {
  opacity: 0.42;
}

.sim-settings-row {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  column-gap: 10px;
  min-height: 28px;
  color: #969da7;
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0;
}

.sim-settings-row > span:first-child {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
}

.sim-settings-row i {
  color: #666d76;
  font-size: 8px;
  font-style: normal;
  font-weight: 500;
}

.sim-settings-input {
  width: 84px;
  height: 28px;
  padding: 0 8px;
  border-radius: 5px;
  border: 1px solid rgba(255, 255, 255, 0.11);
  background: rgba(255, 255, 255, 0.045);
  color: #e5e9ef;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  text-align: right;
  appearance: textfield;
  -moz-appearance: textfield;
}

.sim-settings-input:focus {
  border-color: rgba(255, 255, 255, 0.32);
  outline: none;
}

.sim-settings-input:disabled {
  cursor: default;
  color: #777e87;
}

.sim-settings-input::-webkit-inner-spin-button,
.sim-settings-input::-webkit-outer-spin-button {
  -webkit-appearance: none;
  margin: 0;
}

.settings-input-unit {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 5px;
}

.settings-switch {
  position: relative;
  width: 28px;
  height: 16px;
  padding: 0;
  border: none;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.13);
}

.settings-switch > i {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #8b929b;
  transition:
    left 120ms ease,
    background 120ms ease;
}

.settings-switch.is-active {
  background: rgba(255, 255, 255, 0.24);
}

.settings-switch.is-active > i {
  left: 15px;
  background: #f1f5f9;
}

.settings-switch:disabled {
  cursor: default;
}

.settings-actions {
  display: flex;
  justify-content: flex-end;
  gap: 7px;
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}

.settings-action {
  height: 29px;
  padding: 0 11px;
  border-radius: 6px;
  font-size: 9px;
  font-weight: 600;
}

.settings-action--cancel {
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: transparent;
  color: #8d949d;
}

.settings-action--cancel:hover {
  border-color: rgba(255, 255, 255, 0.2);
  color: #d8dde5;
}

.settings-action--confirm {
  border: 1px solid rgba(255, 255, 255, 0.82);
  background: #eef1f5;
  color: #111318;
}

.settings-action--confirm:hover {
  background: #ffffff;
}

.chart-section {
  grid-area: chart;
  position: relative;
  container-type: inline-size;
  width: 100%;
  max-width: none;
  min-width: 0;
  margin: 0;
  --chart-header-height: 40px;
  /* The legend sits inside the SVG's existing lower plot margin. */
  --chart-legend-height: 0px;
  height: auto;
  min-height: 0;
  aspect-ratio: 2 / 1;
}

.chart-section svg {
  position: absolute;
  top: var(--chart-header-height);
  left: 0;
  width: 100%;
  height: calc(
    100% - var(--chart-header-height) - var(--chart-legend-height)
  );
  display: block;
  cursor: crosshair;
  z-index: 2;
}

.chart-section canvas {
  position: absolute;
  top: var(--chart-header-height);
  left: 0;
  width: 100%;
  height: calc(
    100% - var(--chart-header-height) - var(--chart-legend-height)
  );
  display: block;
  pointer-events: none;
  z-index: 1;
}

.strategy-chart-loading {
  position: absolute;
  top: var(--chart-header-height);
  right: 0;
  bottom: 0;
  left: 0;
  display: grid;
  place-items: center;
  color: var(--text-muted);
  font-size: 10px;
}

.histogram-legend {
  position: absolute;
  right: 3.5%;
  top: calc(
    var(--chart-header-height) +
      min(
        46.4286cqw,
        calc(100% - var(--chart-header-height))
      ) -
      50px
  );
  bottom: auto;
  left: 3.5%;
  z-index: 4;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 14px;
  min-height: 20px;
  color: #70767d;
  font-size: 9px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
}

.histogram-legend-title {
  color: #858d95;
  font-size: 8px;
  font-weight: 600;
  letter-spacing: 0.5px;
  text-transform: uppercase;
}

.histogram-legend-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.histogram-legend-mark {
  display: inline-block;
  flex: 0 0 auto;
  width: 14px;
  height: 6px;
}

.histogram-legend-mark--axis {
  height: 1px;
  background: rgba(148, 163, 184, 0.7);
}

.histogram-legend-mark--cumulative {
  height: 1.25px;
  background: #fff;
}

.histogram-legend-mark--average {
  height: 1px;
  background: repeating-linear-gradient(
    to right,
    rgba(226, 232, 240, 0.65) 0 3px,
    transparent 3px 6px
  );
}

.histogram-legend-mark--median {
  height: 1px;
  background: repeating-linear-gradient(
    to right,
    rgba(148, 163, 184, 0.65) 0 7px,
    transparent 7px 11px
  );
}

.histogram-legend-mark--break-even {
  border: 1px solid rgba(148, 163, 184, 0.16);
  background: rgba(100, 116, 139, 0.18);
}

.rows-popover {
  position: absolute;
  z-index: 12;
  width: 220px;
  padding: 10px 12px 8px;
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: rgba(9, 13, 20, 0.96);
  box-shadow: 0 10px 26px rgba(0, 0, 0, 0.42);
  transform: translate(-50%, 8px);
  backdrop-filter: blur(4px);
}

.rows-popover-head {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: end;
  column-gap: 8px;
  row-gap: 4px;
  margin-bottom: 8px;
}

.rows-popover-label {
  font-size: 9px;
  color: var(--text-muted);
  letter-spacing: 0.03em;
}

.rows-popover-value {
  font-size: 10px;
  color: #e8eaed;
  font-variant-numeric: tabular-nums;
}

.rows-popover-slider {
  width: 100%;
  appearance: none;
  -webkit-appearance: none;
  background: transparent;
  height: 16px;
  cursor: pointer;
}

.rows-popover-slider::-webkit-slider-runnable-track {
  height: 4px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.24);
}

.rows-popover-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 1px solid rgba(2, 6, 23, 0.9);
  background: #f8fafc;
  margin-top: -4px;
}

.rows-popover-slider::-moz-range-track {
  height: 4px;
  border: none;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.24);
}

.rows-popover-slider::-moz-range-thumb {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 1px solid rgba(2, 6, 23, 0.9);
  background: #f8fafc;
}

.rows-popover-slider:focus-visible {
  outline: none;
}

.rows-popover-slider:focus-visible::-webkit-slider-thumb {
  box-shadow: 0 0 0 2px rgba(248, 250, 252, 0.28);
}

.rows-popover-slider:focus-visible::-moz-range-thumb {
  box-shadow: 0 0 0 2px rgba(248, 250, 252, 0.28);
}

.rows-popover-scale {
  margin-top: 2px;
  display: flex;
  justify-content: space-between;
  font-size: 9px;
  color: #8b9198;
  font-variant-numeric: tabular-nums;
}

.histogram-toggle {
  position: absolute;
  top: 8px;
  /* Center on both histogram columns: (112px right margin + 210px / 2) / 1200px. */
  right: 18.083333%;
  left: auto;
  transform: translateX(50%);
  z-index: 9;
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.05);
}

.histogram-toggle button {
  border: none;
  background: transparent;
  color: #70767d;
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0;
  text-transform: none;
  height: 26px;
  padding: 0 12px;
  border-radius: 6px;
  cursor: pointer;
}

.histogram-toggle button.is-active {
  color: #e8eaed;
  background: rgba(255, 255, 255, 0.1);
}

@media (max-width: 1280px) {
  .outcome-summary {
    gap: 23px;
  }

  .outcome-value {
    font-size: 20px;
  }

  .outcome-range {
    font-size: 20px;
  }

  .chart-stats-value {
    font-size: 20px;
  }

  .chart-meta {
    right: 21%;
  }
}

@media (max-width: 900px) {
  .top-bar-content {
    padding: 0 16px;
    gap: 12px;
  }

  .builder-section {
    padding-left: max(0px, calc(3.035714% - 8px));
  }

  .workspace-container {
    padding-right: 16px;
    padding-left: 16px;
  }
}

@media (max-width: 640px) {
  .top-bar-content {
    flex-wrap: wrap;
    height: auto;
    min-height: 58px;
    padding-top: 10px;
    padding-bottom: 10px;
  }

  .top-divider {
    display: none;
  }

  .top-spacer {
    display: none;
  }

  .top-settings-wrap {
    position: static;
  }

  .sim-settings-popover {
    top: calc(100% + 8px);
    right: 16px;
    left: 16px;
    width: auto;
    max-height: calc(100vh - 128px);
  }

  .trade-thalex-button {
    margin-left: 0;
  }

  .workspace-container {
    display: block;
    padding: 0 16px 28px;
  }

  .builder-section {
    padding-right: 0;
    padding-left: max(0px, calc(3.035714% - 8px));
  }

  .simulation-main {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas:
      "selector"
      "metrics"
      "chart";
  }

  .chart-section {
    height: auto;
    min-height: 0;
    aspect-ratio: 1.9 / 1;
    flex: none;
    width: 100%;
    --chart-header-height: 48px;
  }

  .metrics-column {
    display: flex;
    width: 100%;
    padding-top: 22px;
    gap: 18px;
  }

  .outcome-summary {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 17px 24px;
  }

  .outcome-value {
    font-size: 17px;
  }

  .outcome-range {
    font-size: 17px;
  }

  .outcome-label {
    font-size: 10px;
    letter-spacing: 0.8px;
  }

  .chart-stats-value {
    font-size: 17px;
  }

  .chart-stats-label {
    font-size: 10px;
    letter-spacing: 0.8px;
  }

  .chart-stats-row {
    flex-direction: row;
    gap: 24px;
  }

  .chart-meta {
    right: 0;
    justify-content: flex-start;
    gap: 4px;
    overflow: hidden;
  }

  .chart-meta-heading,
  .chart-horizon-label {
    display: none;
  }

  .histogram-toggle {
    display: none;
  }

  .histogram-legend {
    display: none;
  }
}
</style>

<style>
body {
  font-family: "Helvetica Neue", Helvetica, -apple-system, sans-serif;
}
</style>
