import { calcOptionNd2 } from './breakEvenSnapshot.js';

// Only pair observed index prices with IV marks at the same timestamp.
// Projected track points and current-IV fallbacks are not historical data.
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

// Tracks contain screen-space points sorted by x. Search only segments within
// the hit radius so long histories remain responsive during pointer movement.
export function nearestTrack(tracks, px, py, radius = 10) {
  let nearest = null;
  let best = radius * radius;
  for (const track of tracks) {
    const points = track.points;
    let low = 0, high = points.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (points[middle][0] < px - radius) low = middle + 1;
      else high = middle;
    }
    for (let i = Math.max(1, low); i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      if (a[0] > px + radius) break;
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const length = dx * dx + dy * dy;
      const t = length ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / length)) : 0;
      const distance = (px - a[0] - t * dx) ** 2 + (py - a[1] - t * dy) ** 2;
      if (distance <= best) { best = distance; nearest = track.id; }
    }
  }
  return nearest;
}
