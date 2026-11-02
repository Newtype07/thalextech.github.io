import { exportChartToPng } from "../../../lib/export-png.js";

// Compose the workspace's SVG charts at their native sizes, independently of
// whether the responsive page currently shows the panes side by side or stacked.
export function exportStraddlePnlToPng(workspace, filename) {
  if (!workspace) return;
  const charts = [...workspace.querySelectorAll("svg")];
  if (!charts.length) return;
  const combined = workspace.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "svg");
  let width = 0;
  let height = 0;
  for (const chart of charts) {
    const [, , chartWidth, chartHeight] = chart.getAttribute("viewBox").trim().split(/[\s,]+/).map(Number);
    const clone = chart.cloneNode(true);
    clone.querySelectorAll("[data-export-omit]").forEach(node => node.remove());
    clone.setAttribute("x", String(width));
    clone.setAttribute("y", "0");
    clone.setAttribute("width", String(chartWidth));
    clone.setAttribute("height", String(chartHeight));
    combined.append(clone);
    width += chartWidth;
    height = Math.max(height, chartHeight);
  }
  combined.setAttribute("viewBox", `0 0 ${width} ${height}`);
  exportChartToPng({ element: combined, filename, padding: 24, background: "#0a0b0e" });
}
