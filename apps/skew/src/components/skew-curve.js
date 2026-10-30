import { curveMonotoneX, line } from "d3";

// Split paths at provenance changes. Any interval touching an estimated point
// is dashed; contiguous observed intervals stay solid. Unbracketed ends stay empty.
export function skewCurvePaths(points, x, y) {
  const observed = [], interpolated = [];
  const solidLine = line()
    .x(point => x(point.expiry))
    .y(point => y(point.skew))
    .curve(curveMonotoneX);
  const dashedLine = line().x(point => x(point.expiry)).y(point => y(point.skew));
  let run = [], estimated = false;
  const flush = () => {
    if (run.length > 1)
      (estimated ? interpolated : observed).push((estimated ? dashedLine : solidLine)(run));
    run = [];
  };
  for (let i = 1; i < points.length; i++) {
    const left = points[i - 1], right = points[i];
    if (!left || !right) { flush(); continue; }
    const nextEstimated = Boolean(left.interpolated || right.interpolated);
    if (run.length && estimated !== nextEstimated) flush();
    if (!run.length) { run.push(left); estimated = nextEstimated; }
    run.push(right);
  }
  flush();
  // A lone observed value still deserves a small solid stroke.
  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    if (point && !point.interpolated &&
      (!points[i - 1] || points[i - 1].interpolated) &&
      (!points[i + 1] || points[i + 1].interpolated))
      observed.push(`M${x(point.expiry) - 3},${y(point.skew)}h6`);
  }
  return { observed: observed.join("") || null, interpolated: interpolated.join("") || null };
}
