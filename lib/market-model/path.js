import { buildForwardCurve, YEAR } from "./forward-curve.js";
import { createBatesProcess, createBatesState, advanceBatesState } from "../batesSimulation.js";

/** Variance level/shape is independent of hedge policy and option marking. */
export function createMarketProcess({ horizon, shape = "flat", rv = .5, rvMultiplier = 1,
  nodes = [], dynamics = "constant", profile = null, manual = {} }) {
  if (!(horizon > 0) || !Number.isFinite(horizon) || !["flat", "forward"].includes(shape) ||
    !["constant", "stochastic", "jumps"].includes(dynamics) || !Number.isFinite(rv) || rv < 0 ||
    !Number.isFinite(rvMultiplier) || rvMultiplier < 0)
    throw new Error("Check the market path's shape, volatility and horizon.");
  const curve = shape === "forward" ? buildForwardCurve(nodes, horizon) : null;
  const varianceAt = t => curve ? curve.varianceAt(t) * rvMultiplier ** 2 : rv ** 2 * Math.max(0, Math.min(t, horizon)) / YEAR;
  const totalVariance = varianceAt(horizon);
  let process = null;
  if (dynamics !== "constant") {
    if (profile && profile.status !== "ready") throw new Error("This lookback does not support stochastic calibration.");
    const baselineVariance = totalVariance * YEAR / horizon;
    const variance = profile?.variance ?? { kappa: 0, theta: baselineVariance, initialVariance: Math.max(1e-12, baselineVariance), sigma: manual.volOfVol ?? .5, rho: manual.correlation ?? 0 };
    const jumps = profile?.jumps ?? { intensity: manual.jumpIntensity ?? 0, logMean: manual.jumpMean ?? 0,
      logStdDev: manual.jumpVol ?? 0, logSecondMoment: (manual.jumpVol ?? 0) ** 2 + (manual.jumpMean ?? 0) ** 2,
      compensatorMean: Math.exp((manual.jumpMean ?? 0) + .5 * (manual.jumpVol ?? 0) ** 2) - 1 };
    if (![variance.kappa, variance.theta, variance.initialVariance, variance.sigma, variance.rho,
      jumps.intensity, jumps.logMean, jumps.logStdDev, jumps.logSecondMoment, jumps.compensatorMean].every(Number.isFinite) ||
      variance.kappa < 0 || variance.theta < 0 || variance.initialVariance < 0 || variance.sigma < 0 || Math.abs(variance.rho) > 1 || jumps.intensity < 0 || jumps.logStdDev < 0)
      throw new Error("Invalid stochastic variance or jump parameters.");
    process = createBatesProcess({ calibration: { variance, jumps },
      budget: { initialVariance: variance.initialVariance, diffusiveVarianceScale: 1, effectiveJumpIntensity: 0 } });
    process.requestedIntensity = dynamics === "jumps" ? jumps.intensity : 0;
    // Normalize each interval against the variance process's expected level.
    // Jump and diffusion contributions share the same variance budget.
  }
  const maxSeconds = process
    ? Math.min(3600, process.varianceParameters.kappa > 0 ? .2 * YEAR / process.varianceParameters.kappa : 3600)
    : 0;
  function createState(spot) {
    return { spot, bates: process ? createBatesState(spot, process) : null,
      expectedVariance: process?.initialVariance ?? 0, cappedJumpSteps: 0,
      // Each path owns its execution parameters; observations update this object
      // rather than allocating a new process at every stochastic step.
      stepProcess: process ? { ...process } : null };
  }
  function advance(state, start, seconds, normal, uniform, drift = 0) {
    if (!process) {
      const variance = varianceAt(start + seconds) - varianceAt(start);
      state.spot *= Math.exp(drift * seconds / YEAR - .5 * variance + Math.sqrt(Math.max(0, variance)) * normal());
    } else {
      // Bound Euler steps for mean reversion and include curve interval boundaries.
      const stepProcess = state.stepProcess;
      stepProcess.annualDrift = drift;
      let at = start;
      while (at < start + seconds - 1e-9) {
        const boundary = curve?.intervals.find(interval => interval.end > at + 1e-9)?.end ?? Infinity;
        const dt = Math.min(maxSeconds, start + seconds - at, boundary - at);
        const years = dt / YEAR;
        const rate = Math.max(0, (varianceAt(at + dt) - varianceAt(at)) / years);
        const jumpMoment = process.jumpParameters.logSecondMoment;
        const intensity = jumpMoment > 0 ? Math.min(process.requestedIntensity, rate * .35 / jumpMoment) : process.requestedIntensity;
        if (intensity < process.requestedIntensity) state.cappedJumpSteps++;
        stepProcess.effectiveJumpIntensity = intensity;
        stepProcess.diffusiveVarianceScale = Math.max(0, rate - intensity * jumpMoment) / Math.max(1e-12, state.expectedVariance);
        const result = advanceBatesState(state.bates, stepProcess, years, normal, uniform);
        state.spot = result.spot;
        const v = process.varianceParameters;
        state.expectedVariance = Math.max(1e-12, state.expectedVariance + v.kappa * (v.theta - state.expectedVariance) * years);
        at += dt;
      }
    }
    if (!Number.isFinite(state.spot) || state.spot <= 0) throw new Error("Market path overflow. Reduce the volatility or drift.");
    return state.spot;
  }
  return { createState, advance, varianceAt, totalVariance, targetRv: Math.sqrt(totalVariance * YEAR / horizon),
    intervals: curve?.intervals ?? [], modelVersion: "variance-schedule-v1", daysPerYear: 365.25 };
}
