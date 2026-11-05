import { calibrateBatesModel } from "../batesCalibration.js";
export const CALIBRATION_VERSION = 1;
const YEAR_HOURS = 365.25 * 24;

/** Rows use the time their close was available, not the bar's opening time. */
export function buildCalibrationProfile(rows, { asset, lookbackDays, asOf, sourceHash }) {
  const start = asOf - lookbackDays * 86400;
  const selected = [...new Map(rows.filter(row => Number.isFinite(row.ts) && row.ts > start && row.ts <= asOf &&
    Number.isFinite(row.close) && row.close > 0).map(row => [row.ts, row])).values()].sort((a, b) => a.ts - b.ts);
  const returns = [];
  for (let i = 1; i < selected.length; i++)
    if (selected[i].ts - selected[i - 1].ts === 3600) returns.push(Math.log(selected[i].close / selected[i - 1].close));
  const expected = lookbackDays * 24;
  const profile = { version: CALIBRATION_VERSION, asset, lookbackDays, asOf, sourceHash,
    daysPerYear: 365.25, correlationSource: "realized-return-variance-shocks",
    training: { start: selected[0]?.ts ?? null, end: selected.at(-1)?.ts ?? null,
      observations: selected.length, expected, coverage: selected.length / expected, hourlyReturns: returns.length },
    rv: returns.length ? Math.sqrt(returns.reduce((sum, value) => sum + value ** 2, 0) / returns.length * YEAR_HOURS) : null,
    status: "unavailable", message: "", variance: null, jumps: null, sensitivity: [] };
  if (profile.training.coverage < .99) {
    profile.message = "Less than 99% of the requested hourly history is available.";
    return profile;
  }
  try {
    const fit = calibrateBatesModel({ rows: selected });
    profile.variance = fit.variance;
    profile.jumps = fit.jumps;
    profile.sensitivity = fit.sensitivity.map(({ _model, ...summary }) => summary);
    profile.status = "ready";
  } catch (error) { profile.status = "rv-only"; profile.message = error.message; }
  return profile;
}
