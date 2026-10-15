import {
  OPTION_PRICING_DAYS_PER_YEAR,
  PRECOMPUTED_DELTA_SCALE,
} from "./optionRisk.js";

export const THALEX_ARTIFACT_VERSION = 4;

const ARTIFACT_SCHEMA = "thalex-option-backtest";
const DEFAULT_DATA_ROOT = "runtime-data/thalex";
const MANIFEST_FILENAME = "prepared_manifest.json";
export const DEFAULT_SHARD_LOAD_CONCURRENCY = 4;
const preparedFilename = (hour, bucketKey) =>
  `prepared_1h_h${String(hour).padStart(2, "0")}utc_dte${bucketKey}.json`;
const manifestCache = new Map();
const preparedShardCache = new Map();
const preparedShardLoads = new Map();

const asNumber = (value) => {
  if (typeof value === "bigint") return Number(value);
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : Number.NaN;
};

const assertArtifactContract = (payload, filename) => {
  if (
    payload?.schema !== ARTIFACT_SCHEMA ||
    payload?.version !== THALEX_ARTIFACT_VERSION
  ) {
    throw new Error(
      `Unsupported Thalex artifact ${filename}; rebuild data with schema version ${THALEX_ARTIFACT_VERSION}`,
    );
  }
};

const assertPricingContract = (manifest) => {
  if (
    Number(manifest.pricing?.daysPerYear) !== OPTION_PRICING_DAYS_PER_YEAR ||
    Number(manifest.pricing?.deltaScale) !== PRECOMPUTED_DELTA_SCALE
  ) {
    throw new Error(
      `Unsupported Thalex pricing metadata; rebuild data with schema version ${THALEX_ARTIFACT_VERSION}`,
    );
  }
};

const decodeDteBuckets = (manifest) => {
  const buckets = (manifest.dteBuckets || []).map((bucket) => ({
    key: String(bucket.key || ""),
    minExclusive: asNumber(bucket.minExclusive),
    maxInclusive:
      bucket.maxInclusive == null ? Number.POSITIVE_INFINITY : asNumber(bucket.maxInclusive),
  }));
  if (
    !buckets.length ||
    buckets.some((bucket, index) =>
      !bucket.key ||
      !Number.isFinite(bucket.minExclusive) ||
      !(bucket.maxInclusive > bucket.minExclusive) ||
      (index > 0 && bucket.minExclusive !== buckets[index - 1].maxInclusive)
    )
  ) {
    throw new Error(
      `Unsupported Thalex DTE buckets; rebuild data with schema version ${THALEX_ARTIFACT_VERSION}`,
    );
  }
  return buckets;
};

export const selectDteBuckets = (buckets, maxDteDays) => {
  if (!buckets.length || !Number.isFinite(Number(maxDteDays))) return buckets;
  const requestedMax = Math.max(0, Number(maxDteDays));
  const finalIndex = buckets.findIndex((bucket) => requestedMax <= bucket.maxInclusive);
  return finalIndex < 0 ? buckets : buckets.slice(0, finalIndex + 1);
};

export const decodeInstrumentDictionary = (manifest) => {
  assertArtifactContract(manifest, MANIFEST_FILENAME);
  assertPricingContract(manifest);
  return (manifest.instruments || []).map(
    ([name, expirationTs, strike, optionTypeCode], instrumentId) => {
      const instrument = {
        instrumentId,
        name: String(name || ""),
        expirationTs: asNumber(expirationTs),
        strike: asNumber(strike),
        optionType: Number(optionTypeCode) === 1 ? "C" : "P",
      };
      if (
        !instrument.name ||
        !Number.isFinite(instrument.expirationTs) ||
        !Number.isFinite(instrument.strike) ||
        ![1, -1].includes(Number(optionTypeCode))
      ) {
        throw new Error(
          `Invalid instrument metadata at dictionary index ${instrumentId}`,
        );
      }
      return instrument;
    },
  );
};

export const decodePreparedShard = ({
  payload,
  startTs = Number.NEGATIVE_INFINITY,
  endTs = Number.POSITIVE_INFINITY,
}) => {
  assertArtifactContract(payload, `hour ${payload?.hourlyOffset ?? "?"}`);
  const indexRows = [];
  const quoteSnapshots = [];
  for (const [ts, price, high, low, close] of payload.index || []) {
    const timestamp = asNumber(ts);
    if (timestamp >= startTs && timestamp <= endTs) {
      indexRows.push({
        ts: timestamp, indexPrice: asNumber(price),
        high: asNumber(high), low: asNumber(low), close: asNumber(close),
      });
    }
  }
  for (const [ts, entries] of payload.quotes || []) {
    const timestamp = asNumber(ts);
    if (timestamp < startTs || timestamp > endTs) continue;
    quoteSnapshots.push([timestamp, entries]);
  }
  return { indexRows, quoteSnapshots };
};

const dataUrl = (dataRoot, filename) => {
  const baseUrl = import.meta.env?.BASE_URL || "/";
  return `${baseUrl}${dataRoot}/${filename}`;
};

const fetchJson = async (url, missingMessage, options) => {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(missingMessage);
  return response.json();
};

const cachedPreparedShard = async (url, missingMessage) => {
  const cached = preparedShardCache.get(url)?.deref?.();
  if (cached) return cached;
  if (!preparedShardLoads.has(url)) {
    preparedShardLoads.set(
      url,
      fetchJson(url, missingMessage)
        .then((payload) => {
          if (typeof WeakRef === "function") {
            preparedShardCache.set(url, new WeakRef(payload));
          }
          return payload;
        })
        .finally(() => preparedShardLoads.delete(url)),
    );
  }
  return preparedShardLoads.get(url);
};

const loadManifest = (dataRoot) => {
  if (!manifestCache.has(dataRoot)) {
    manifestCache.set(
      dataRoot,
      fetchJson(
        dataUrl(dataRoot, MANIFEST_FILENAME),
        "Missing prepared data manifest",
        { cache: "no-cache" },
      ).then((manifest) => ({
        manifest,
        instruments: decodeInstrumentDictionary(manifest),
        dteBuckets: decodeDteBuckets(manifest),
      })),
    );
  }
  return manifestCache.get(dataRoot);
};

const mapWithConcurrency = async (items, requestedConcurrency, mapper) => {
  if (!items.length) return [];
  const concurrency = Math.max(
    1,
    Math.min(items.length, Math.floor(Number(requestedConcurrency)) || 1),
  );
  const results = new Array(items.length);
  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
};

export async function loadThalexHistory({
  start,
  end,
  hourlyOffset = 8,
  hourlyOffsets,
  dataRoot = DEFAULT_DATA_ROOT,
  onProgress,
  maxConcurrentShardLoads = DEFAULT_SHARD_LOAD_CONCURRENCY,
  maxDteDays,
}) {
  const hours = [...new Set((hourlyOffsets || [hourlyOffset]).map(Number))]
    .sort((a, b) => a - b);
  const startTs = Math.floor(start.getTime() / 1000);
  const endTs = Math.floor(end.getTime() / 1000);
  const indexRows = [];
  const quoteSnapshots = [];
  const { manifest, instruments, dteBuckets } = await loadManifest(dataRoot);
  const selectedBuckets = selectDteBuckets(dteBuckets, maxDteDays);
  const shardRequests = hours.flatMap((hour) =>
    selectedBuckets.map((bucket) => ({ hour, bucket })),
  );

  let completedShards = 0;
  const decodedShards = await mapWithConcurrency(
    shardRequests,
    maxConcurrentShardLoads,
    async ({ hour, bucket }) => {
      const filename = preparedFilename(hour, bucket.key);
      const payload = await cachedPreparedShard(
        dataUrl(dataRoot, filename),
        `Missing prepared data for hour ${hour}, DTE ${bucket.key}`,
      );
      const decoded = decodePreparedShard({
        payload,
        startTs,
        endTs,
      });
      completedShards += 1;
      onProgress?.({
        phase: "prepared",
        current: completedShards,
        total: shardRequests.length,
        file: `h${hour} · ${bucket.key}D`,
      });
      return decoded;
    },
  );

  for (const decoded of decodedShards) {
    indexRows.push(...decoded.indexRows);
    quoteSnapshots.push(...decoded.quoteSnapshots);
  }
  return {
    indexRows,
    quoteSnapshots,
    artifact: {
      version: manifest.version,
      pricing: manifest.pricing,
      instruments,
      dteBuckets: selectedBuckets,
    },
  };
}
