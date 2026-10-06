import { calcOptionNd2 } from './breakEvenSnapshot.js';

export function findSameStrikeInstrument(selected, candidates) {
  if (!selected) return null;
  return candidates.find(instrument =>
    instrument.strike === selected.strike &&
    instrument.option_type_normalized === selected.option_type_normalized,
  ) ?? null;
}

// Only pair observed index prices with IV marks at the same timestamp.
// Only historical marks with their own IV belong in this series.
export function buildTrackProbabilityHistory(track, indexPoints, expiryTs) {
  if (!track || !Number.isFinite(expiryTs)) return [];
  const marks = new Map(track.points.map(point => [+point.date, point]));
  return indexPoints.flatMap(point => {
    const mark = marks.get(+point.date);
    const ts = +point.date / 1000;
    if (!mark || !Number.isFinite(ts) || ts > expiryTs) return [];
    const probability = calcOptionNd2({
      optionType: track.optionType, spot: point.value, strike: track.strike,
      iv: mark.iv, tauSeconds: expiryTs - ts,
    });
    return Number.isFinite(probability) ? [{ date: point.date, indexPrice: point.value, probability }] : [];
  });
}
