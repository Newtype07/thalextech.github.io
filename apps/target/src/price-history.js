const HOUR = 3600;
export function validCandle(row) {
  return Array.isArray(row) && row.length >= 5 && row.slice(0, 5).every(Number.isFinite)
    && row.slice(1, 5).every(value => value > 0)
    && row[2] >= Math.max(row[1], row[4]) && row[3] <= Math.min(row[1], row[4]);
}
// Completed hourly observations feed the frequency calculation. The active
// candle is kept separately so a partial return never enters that sample.
export function mergePriceHistory(archive, hourly, minutes, spot, asOf) {
  const hour = Math.floor(asOf / HOUR) * HOUR;
  const completed = new Map();
  for (const row of [...archive, ...hourly]) {
    if (validCandle(row) && row[0] + HOUR <= asOf) completed.set(row[0], row.slice(0, 5));
  }
  const observations = minutes.filter(row => validCandle(row) && row[0] >= hour && row[0] + 60 <= asOf)
    .sort((a, b) => a[0] - b[0]);
  let active = null;
  if (Number.isFinite(spot) && spot > 0 && Number.isFinite(asOf)) {
    // Minute OHLC establishes the observed current-hour range; the final
    // observed index price supplies its close. At an hour boundary the first
    // available observation is the index snapshot itself.
    active = observations.length
      ? [hour, observations[0][1], Math.max(spot, ...observations.map(row => row[2])),
          Math.min(spot, ...observations.map(row => row[3])), spot]
      : [hour, spot, spot, spot, spot];
  }
  return { completed: [...completed.values()].sort((a,b) => a[0]-b[0]), active };
}
