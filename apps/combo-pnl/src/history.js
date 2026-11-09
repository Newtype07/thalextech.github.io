import { createCandleHistoryLoader } from "../../../lib/minute-history.js";

export const HISTORY_PAGE_SIZE = 1000;
export const HISTORY_WINDOW_UNIT_SECONDS = 900;

// Chart candles suffice until the user requests a minute-by-minute hedge replay.
export function comboHistoryPlan({ historyTo, points, resolution, intervalSeconds, hedgeEnabled }) {
  const seconds = hedgeEnabled ? 60 : intervalSeconds;
  return {
    resolution: hedgeEnabled ? "1m" : resolution,
    intervalSeconds: seconds,
    from: Math.ceil((historyTo - HISTORY_WINDOW_UNIT_SECONDS * (points - 1)) / seconds) * seconds,
    to: Math.floor(historyTo / seconds) * seconds,
  };
}

export function createComboHistoryLoader(fetchRows) {
  const loaders = new Map();
  return ({ intervalSeconds, ...query }, isCurrent) => {
    if (!loaders.has(intervalSeconds)) loaders.set(intervalSeconds, createCandleHistoryLoader(fetchRows, {
      intervalSeconds, pageSize: HISTORY_PAGE_SIZE, concurrency: 3,
    }));
    return loaders.get(intervalSeconds)(query, isCurrent);
  };
}
