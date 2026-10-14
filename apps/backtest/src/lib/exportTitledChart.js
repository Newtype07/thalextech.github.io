import { exportChartToPng } from "../../../../lib/export-png.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const SCREENSHOT_IMAGE_FILTER = "brightness(1.12) saturate(1.35)";

const addText = (svg, { text, x, y, size, color, weight = 400 }) => {
  if (!text) return;
  const node = document.createElementNS(SVG_NS, "text");
  node.setAttribute("x", String(x));
  node.setAttribute("y", String(y));
  node.setAttribute("text-anchor", "middle");
  node.setAttribute("fill", color);
  node.setAttribute("font-family", '"Helvetica Neue", Helvetica, -apple-system, sans-serif');
  node.setAttribute("font-size", String(size));
  node.setAttribute("font-weight", String(weight));
  node.textContent = text;
  svg.appendChild(node);
};

export function exportTitledChart({
  svgEl,
  title,
  subtitle,
  source,
  metrics = [],
  filename,
  scale = 4,
  padding = 24,
  background = "#0a0b0e",
} = {}) {
  if (!svgEl) return;

  const viewBox = (svgEl.getAttribute("viewBox") || "")
    .split(/\s+/)
    .map(Number);
  if (viewBox.length !== 4 || !viewBox.every(Number.isFinite)) return;

  const [minX, minY, width, height] = viewBox;
  const headerHeight = 76;
  const metricsWidth = metrics.length ? 170 : 0;
  const contentHeight = Math.max(height, metrics.length ? 47 + (metrics.length - 1) * 67 + 16 : 0);
  const exportSvg = svgEl.cloneNode(true);
  const chartGroup = document.createElementNS(SVG_NS, "g");
  while (exportSvg.firstChild) chartGroup.appendChild(exportSvg.firstChild);
  chartGroup.setAttribute("transform", `translate(${metricsWidth},${headerHeight})`);
  exportSvg.appendChild(chartGroup);
  exportSvg.setAttribute("viewBox", `${minX} ${minY} ${width + metricsWidth} ${contentHeight + headerHeight}`);
  exportSvg.setAttribute("width", String(width + metricsWidth));
  exportSvg.setAttribute("height", String(contentHeight + headerHeight));

  const centerX = minX + metricsWidth + width / 2;
  addText(exportSvg, {
    text: title,
    x: centerX,
    y: minY + 21,
    size: 18,
    color: "#e8eaed",
    weight: 500,
  });
  addText(exportSvg, {
    text: subtitle,
    x: centerX,
    y: minY + 42,
    size: 13,
    color: "#9aa0a6",
  });
  addText(exportSvg, {
    text: source,
    x: centerX,
    y: minY + 60,
    size: 12,
    color: "#70767d",
  });

  metrics.forEach((metric, index) => {
    const x = minX + 8;
    const y = minY + headerHeight + 29 + index * 67;
    const valueNode = document.createElementNS(SVG_NS, "text");
    valueNode.setAttribute("x", String(x));
    valueNode.setAttribute("y", String(y));
    valueNode.setAttribute("text-anchor", "start");
    valueNode.setAttribute("fill", metric.muted ? "#9aa0a6" : "#e8eaed");
    valueNode.setAttribute("font-family", '"Helvetica Neue", Helvetica, -apple-system, sans-serif');
    valueNode.setAttribute("font-size", "22");
    valueNode.setAttribute("font-weight", "300");
    valueNode.setAttribute("letter-spacing", "-0.3");
    valueNode.textContent = metric.value;
    exportSvg.appendChild(valueNode);

    const labelNode = document.createElementNS(SVG_NS, "text");
    labelNode.setAttribute("x", String(x));
    labelNode.setAttribute("y", String(y + 18));
    labelNode.setAttribute("text-anchor", "start");
    labelNode.setAttribute("fill", "#70767d");
    labelNode.setAttribute("font-family", '"Helvetica Neue", Helvetica, -apple-system, sans-serif');
    labelNode.setAttribute("font-size", "10");
    labelNode.setAttribute("letter-spacing", "1.2");
    labelNode.textContent = metric.label;
    exportSvg.appendChild(labelNode);
  });

  exportChartToPng({
    element: exportSvg,
    filename,
    scale,
    padding,
    background,
    imageFilter: SCREENSHOT_IMAGE_FILTER,
  });
}

export function exportChartRegionToPng({
  svgEl,
  region,
  filename,
  scale = 4,
  padding = 18,
  background = "#0a0b0e",
} = {}) {
  if (!svgEl || !region) return;
  const { x = 0, y = 0, width, height } = region;
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    return;
  }

  const exportSvg = svgEl.cloneNode(true);
  exportSvg.setAttribute("viewBox", `${x} ${y} ${width} ${height}`);
  exportSvg.setAttribute("width", String(width));
  exportSvg.setAttribute("height", String(height));
  exportChartToPng({
    element: exportSvg,
    filename,
    scale,
    padding,
    background,
    imageFilter: SCREENSHOT_IMAGE_FILTER,
  });
}
