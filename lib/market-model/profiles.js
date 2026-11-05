export function validateCalibrationProfile(profile, { asset, lookbackDays, asOf = Infinity }) {
  if (profile?.version !== 1 || profile.asset !== asset || profile.lookbackDays !== lookbackDays ||
    profile.daysPerYear !== 365.25 || profile.correlationSource !== "realized-return-variance-shocks" ||
    !Number.isFinite(profile.asOf) || profile.asOf > asOf ||
    !["ready", "rv-only", "unavailable"].includes(profile.status))
    throw new Error("Calibration profile does not match the asset, lookback or as-of time.");
  if (profile.status !== "unavailable" && (!Number.isFinite(profile.rv) || profile.rv < 0))
    throw new Error("Calibration profile contains invalid realized volatility.");
  if (profile.status === "ready") {
    const v = profile.variance, j = profile.jumps;
    if (!v || !j || ![v.kappa, v.theta, v.sigma, v.rho, v.initialVariance, j.intensity, j.logMean, j.logStdDev, j.logSecondMoment, j.compensatorMean].every(Number.isFinite) ||
      v.kappa < 0 || v.theta < 0 || v.sigma < 0 || Math.abs(v.rho) > 1 || v.initialVariance <= 0 || j.intensity < 0 || j.logStdDev < 0 || j.logSecondMoment < 0)
      throw new Error("Calibration profile contains invalid stochastic parameters.");
  }
  return profile;
}

export async function loadCalibrationProfile({ asset, lookbackDays, asOf = Infinity, signal, baseUrl = import.meta.env?.BASE_URL ?? "/" }) {
  const response = await fetch(`${baseUrl}calibration/manifest.json`, { signal });
  if (!response.ok) throw new Error("Historical estimates are unavailable. Rebuild calibration data.");
  const manifest = await response.json();
  if (manifest.version !== 1) throw new Error("Unsupported calibration manifest.");
  const entries = manifest.profiles.filter(row => row.asset === asset && row.lookbackDays === lookbackDays && row.asOf <= asOf)
    .sort((a, b) => b.asOf - a.asOf);
  const entry = entries[0];
  if (!entry || !/^[a-z0-9-]+\.json$/.test(entry.file)) throw new Error("No historical estimate is available before this date.");
  const loaded = await fetch(`${baseUrl}calibration/${entry.file}`, { signal, cache: "force-cache" });
  if (!loaded.ok) throw new Error("Could not load the historical estimate.");
  return validateCalibrationProfile(await loaded.json(), { asset, lookbackDays, asOf });
}
