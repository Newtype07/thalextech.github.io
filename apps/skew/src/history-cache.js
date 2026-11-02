// This adapter alone knows the generated Parquet-cache contract. Completed API
// additions share its in-memory maps, so refresh only fills newly missing hours.
const archives = new Map();
export const emptyArchive = () => ({
  index: new Map(),
  preparedHistory: {},
  marks: new Map(),
  checked: new Map(),
  checkedIndex: [],
  warning: "",
  sourceThrough: { index: null, marks: null },
});

export function missingHourRanges(from, to, known, checked = []) {
  const ranges = [];
  let start = null;
  for (let ts = from; ts <= to; ts += 3600) {
    const present =
      known.has(ts) ||
      checked.some(
        (r) =>
          ts >= r.from &&
          ts <= r.to &&
          (r.expires == null || r.expires > Date.now()),
      );
    if (!present && start == null) start = ts;
    if (present && start != null) {
      ranges.push({ from: start, to: ts - 1 });
      start = null;
    }
  }
  if (start != null) ranges.push({ from: start, to });
  return ranges;
}

export function historySnapshot(cache, { from, end, indexFrom }) {
  const index = [...cache.index.values()]
    .filter((r) => r[0] >= indexFrom && r[0] < end)
    .sort((a, b) => a[0] - b[0]);
  const spots = new Map(index.map((r) => [r[0], r[4]]));
  const quotes = [];
  for (const instrument of cache.marks.values()) {
    for (const [ts, iv] of instrument.rows) {
      const spot = spots.get(ts);
      if (ts < from || ts >= end || ts + 3600 >= instrument.expiry || !(spot > 0)) continue;
      quotes.push({
        expiry: instrument.expiry,
        strike: instrument.strike,
        side: instrument.side,
        ts: ts + 3600,
        iv,
        spot,
      });
    }
  }
  return {
    quotes,
    preparedHistory: cache.preparedHistory,
    indexBars: index.map(([ts, open, high, low, close]) => ({
      ts,
      open,
      high,
      low,
      close,
    })),
    warning: cache.warning,
  };
}

export async function loadHistoryCache(
  asset,
  signal,
  onArchive = () => {},
) {
  if (archives.has(asset)) {
    onArchive(archives.get(asset));
    return archives.get(asset);
  }
  const archive = emptyArchive();
  const base = `${import.meta.env?.BASE_URL || "/"}history-cache/${asset.toLowerCase()}/`;
  const read = async (filename, fresh = false) => {
    if (!/^[a-z0-9.-]+\.json$/.test(filename))
      throw new Error("Invalid cache filename");
    const response = await fetch(base + filename, {
      signal,
      cache: fresh ? "no-cache" : "default",
    });
    if (!response.ok) throw new Error(`Cache HTTP ${response.status}`);
    const contentType = response.headers?.get("content-type") || "";
    if (/text\/html|application\/xhtml\+xml/i.test(contentType)) {
      await response.body?.cancel();
      throw new Error(
        `Cache URL ${base + filename} returned HTML instead of JSON. Run npm run build:data from apps/skew and serve this app with npm run dev.`,
      );
    }
    try {
      return await response.json();
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new Error(
          `Invalid JSON at cache URL ${base + filename}. Rebuild with npm run build:data.`,
          { cause: error },
        );
      throw error;
    }
  };
  try {
    const manifest = await read("manifest.json", true);
    if (
      manifest.schema !== "thalex-skew-history" ||
      manifest.version !== 3 ||
      manifest.asset !== asset ||
      manifest.resolution !== 3600 ||
      manifest.ivBasis !== "close" ||
      manifest.timestampBasis !== "bar-start"
    )
      throw new Error("Unsupported historical cache");
    for (const boundary of Object.values(manifest.sourceThrough || {}))
      if (
        boundary != null &&
        (!Number.isFinite(boundary) || boundary % 3600 !== 0)
      )
        throw new Error("Invalid Parquet coverage boundary");
    archive.sourceThrough = { ...archive.sourceThrough, ...manifest.sourceThrough };
    for (const [delta, filename] of Object.entries(manifest.prepared || {})) {
      try {
        const payload = await read(filename);
        if (payload.version !== 1 || !Array.isArray(payload.rows)) throw new Error("Invalid prepared series");
        const points = payload.rows.map(row => {
          if (row.length !== 7 || !row.every(Number.isFinite) || row[2] <= 0 || row[3] <= 0)
            throw new Error("Invalid prepared observation");
          const [ts, tenorDays, callIv, putIv, nearExpiry, farExpiry, weight] = row;
          return { ts, tenorDays, callIv, putIv, skew: callIv - putIv, nearExpiry, farExpiry, weight };
        });
        archive.preparedHistory = { ...archive.preparedHistory, [delta]: points };
        onArchive(archive);
      } catch (error) {
        signal?.throwIfAborted();
        archive.warning = `Prepared ${delta}Δ Parquet series unavailable (${error.message}); only available recent data can be shown.`;
      }
    }
    const index = await read(manifest.index);
    for (const row of index.rows) {
      if (
        row.length === 5 &&
        row.every(Number.isFinite) &&
        row.slice(1).every((v) => v > 0)
      )
        archive.index.set(row[0], row);
    }
    archive.sourceThrough.index =
      manifest.sourceThrough?.index ??
      [...archive.index.keys()].reduce(
        (latest, ts) => Math.max(latest ?? 0, ts + 3600),
        null,
      );
    onArchive(archive);
    let marksThrough = null;
    for (const [expiryKey, filename] of Object.entries(manifest.expiries)) {
      const expiry = Number(expiryKey);
      if (!filename) continue;
      const payload = await read(filename);
      if (payload.expiry !== expiry || !Array.isArray(payload.instruments))
        throw new Error("Invalid expiry cache");
      for (const i of payload.instruments) {
        if (
          typeof i.name !== "string" ||
          !Number.isFinite(i.strike) ||
          !["C", "P"].includes(i.side) ||
          !Array.isArray(i.rows)
        )
          throw new Error("Invalid cached instrument");
        const rows = i.rows.filter(
          (r) => r.length === 2 && r.every(Number.isFinite) && r[1] > 0,
        );
        for (const [ts] of rows)
          marksThrough = Math.max(marksThrough ?? 0, ts + 3600);
        archive.marks.set(i.name, {
          name: i.name,
          expiry,
          strike: i.strike,
          side: i.side,
          rows: new Map(rows),
        });
      }
      onArchive(archive);
    }
    archive.sourceThrough.marks = manifest.sourceThrough?.marks ?? marksThrough;
  } catch (error) {
    signal?.throwIfAborted();
    archive.warning = `Parquet cache unavailable or incomplete (${error.message}); missing history will be fetched from Thalex within the requested lookback.`;
  }
  // Cache only successfully decoded archive state; API supplements remain session-local.
  archives.set(asset, archive);
  return archive;
}
