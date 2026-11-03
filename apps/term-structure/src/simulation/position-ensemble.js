import { simulatePosition } from "./position-simulation.js";

export const ENSEMBLE_RUNS = 100;
const MAX_CHART_POINTS = 1200;

/** Retain compact chart samples; every path still uses the full simulation clock. */
export function* positionEnsemble(config) {
  const paths = [];
  let elapsed;
  for (let index = 0; index < ENSEMBLE_RUNS; index++) {
    // Distinct uint32 seeds, reproducible from the batch's initial seed.
    const seed = index === 0 ? config.seed : (config.seed + Math.imul(index, 0x9e3779b9)) >>> 0;
    const run = simulatePosition({ ...config, seed });
    if (!elapsed) {
      const count = Math.min(MAX_CHART_POINTS, run.rows.length);
      elapsed = Array.from({ length: count }, (_, i) =>
        run.rows[Math.round(i * (run.rows.length - 1) / (count - 1))].elapsed);
    }
    const stride = (run.rows.length - 1) / (elapsed.length - 1);
    const pnl = elapsed.map((_, i) => run.rows[Math.round(i * stride)].pnl);
    paths.push({ seed, pnl });
    yield { completed: index + 1, total: ENSEMBLE_RUNS };
  }
  const median = elapsed.map((_, i) => {
    const values = paths.map(path => path.pnl[i]).sort((a, b) => a - b);
    return (values[ENSEMBLE_RUNS / 2 - 1] + values[ENSEMBLE_RUNS / 2]) / 2;
  });
  return { config: structuredClone(config), elapsed, paths, median };
}
