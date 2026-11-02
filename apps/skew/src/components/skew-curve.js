import { curveBasis, line } from "d3";

// Colors are stable by tenor, independent of visible series or history window.
export const TENOR_COLORS = {
  7: "#f05b61", 14: "#eb7e99", 30: "#d18abd",
  60: "#ae94dc", 90: "#828fee", 180: "#4f8fff",
};
export const tenorLegendLabel = days => ({ 7: "1w", 14: "2w", 30: "1m", 60: "2m", 90: "3m", 180: "6m" })[days] || `${days}d`;

export function skewTimeSeriesPath(points, x, y) {
  // A cubic B-spline rounds short-lived corners within each uninterrupted run.
  // This is display smoothing only: source values, tooltips and ranks stay raw.
  const path = line().x(p => x(p.ts)).y(p => y(p.skew)).curve(curveBasis);
  const paths = [];
  let run = [];
  for (const point of [...points, null]) {
    if (point) run.push(point);
    else if (run.length) {
      paths.push(run.length === 1 ? `M${x(run[0].ts) - 3},${y(run[0].skew)}h6` : path(run));
      run = [];
    }
  }
  return paths.join("") || null;
}
