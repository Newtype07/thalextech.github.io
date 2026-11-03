// This adapter alone knows the generated Parquet-cache contract. Completed API
// additions share its in-memory maps, so refresh only fills newly missing hours.
const archives = new Map();
export const emptyArchive = () => ({
  index: new Map(),
  marks: new Map(),
  checked: new Map(),
  checkedIndex: [],
  warning: "",
  sourceThrough: { index: null, marks: null },
  // Immutable per-expiry Parquet ends; API additions never advance these.
  markSourceThrough: new Map(),
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

export function historySnapshot(cache, { from, end, indexFrom, expiries }) {
  const index = [...cache.index.values()]
    .filter((r) => r[0] >= indexFrom && r[0] < end)
    .sort((a, b) => a[0] - b[0]);
  const spots = new Map(index.map((r) => [r[0], r[4]]));
  const quotes = [],
    liveExpiries = new Set(expiries);
  for (const instrument of cache.marks.values()) {
    if (!liveExpiries.has(instrument.expiry)) continue;
    for (const [ts, iv] of instrument.rows) {
      const spot = spots.get(ts);
      if (ts < from || ts >= end || !(spot > 0)) continue;
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
  expiries,
  signal,
  onArchive = () => {},
) {
  const entry = archives.get(asset) || {
    archive: emptyArchive(),
    manifest: null,
  };
  const { archive } = entry;
  onArchive(archive);
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
        `Cache URL ${base + filename} returned HTML instead of JSON. Run npm run build:data from apps/term-structure and serve this app with npm run dev.`,
      );
    }
    try {
      const payload = await response.json();
      signal?.throwIfAborted();
      return payload;
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
    let manifest = entry.manifest;
    if (!manifest) {
      manifest = await read("manifest.json", true);
      if (
        manifest.schema !== "thalex-term-history" ||
        manifest.version !== 1 ||
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
      const index = await read(manifest.index);
      if (!Array.isArray(index.rows)) throw new Error("Invalid index cache");
      const indexRows = index.rows.filter(
        (row) =>
          Array.isArray(row) &&
          row.length === 5 &&
          row.every(Number.isFinite) &&
          row.slice(1).every((v) => v > 0),
      );
      for (const row of indexRows)
        if (!archive.index.has(row[0])) archive.index.set(row[0], row);
      archive.sourceThrough.index =
        manifest.sourceThrough?.index ??
        indexRows.reduce(
          (latest, row) => Math.max(latest ?? 0, row[0] + 3600),
          null,
        );
      archive.sourceThrough.marks = manifest.sourceThrough?.marks ?? null;
      entry.manifest = manifest;
      onArchive(archive);
    }
    for (const expiry of expiries) {
      if (archive.markSourceThrough.has(expiry)) continue;
      const filename = manifest.expiries[String(expiry)];
      if (!filename) continue;
      const payload = await read(filename);
      if (payload.expiry !== expiry || !Array.isArray(payload.instruments))
        throw new Error("Invalid expiry cache");
      let marksThrough = null;
      const instruments = payload.instruments.map((i) => {
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
        return {
          name: i.name,
          expiry,
          strike: i.strike,
          side: i.side,
          rows: new Map(rows),
        };
      });
      // Commit a shard only after it is decoded completely. Preserve any API
      // observations already fetched while this expiry was absent/unavailable.
      for (const instrument of instruments) {
        const previous = archive.marks.get(instrument.name);
        archive.marks.set(instrument.name, {
          ...previous,
          ...instrument,
          rows: new Map([...instrument.rows, ...(previous?.rows || [])]),
        });
      }
      archive.markSourceThrough.set(expiry, marksThrough);
      onArchive(archive);
    }
    archive.sourceThrough.marks =
      manifest.sourceThrough?.marks ??
      [...archive.markSourceThrough.values()].reduce(
        (latest, ts) => (ts == null ? latest : Math.max(latest ?? 0, ts)),
        null,
      );
    archive.warning = "";
  } catch (error) {
    signal?.throwIfAborted();
    archive.warning = `Parquet cache unavailable or incomplete (${error.message}); missing history will be fetched from Thalex within the requested lookback.`;
  }
  // Reuse decoded shards, but still discover requested expiries on refresh.
  // Failed manifest/shard reads remain retryable without losing API additions.
  archives.set(asset, entry);
  return archive;
}
