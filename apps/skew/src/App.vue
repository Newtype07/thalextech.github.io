<script setup>
import {
  computed,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
} from "vue";
import SkewChart from "./components/SkewChart.vue";
import StyledSelectMenu from "../../../lib/components/StyledSelectMenu.vue";
import { fetchOptionChain, fetchLiveQuotes, fetchSkewHistory } from "./market-data.js";
import { DELTAS, buildCurrentSkew, buildHistoricalSkew, rankCurrentSkew } from "./skew.js";
import { getThalexQueueStatus } from "./thalex-rest.js";
import { TENORS, tenorLabel, constantMaturityCurve, constantMaturityHistory } from "./constant-maturity.js";
import { buildSkewTimeSeries, HISTORY_VIEWS, historyWindow, mergeSkewHistory } from "./skew-timeseries.js";

const asset = ref("BTC");
const delta = ref("25");
const selectedDelta = computed(() => DELTAS.find(d => d.value === delta.value).delta);
const resolution = ref("3m");
const historySpec = computed(() => HISTORY_VIEWS.find(v => v.value === resolution.value));
const preparedHistory = shallowRef({});
const visibleTenors = ref([7, 30, 90, 180]);
const showIndex = ref(false);
const indexBars = shallowRef([]);
const referenceTime = ref(null);
const live = shallowRef([]),
  history = shallowRef([]);
const loading = ref(false),
  historyLoading = ref(false),
  historyWarnings = ref([]),
  error = ref(""),
  warnings = ref([]);
const liveProgress = ref({ checked: 0, total: 0 });
const liveReceived = ref(0);
const historyActivity = shallowRef(null);
const queueStatus = shallowRef(getThalexQueueStatus());
const statusTime = ref(Date.now());
const cooldownSeconds = computed(() => Math.max(
  0,
  Math.ceil((queueStatus.value.blockedUntil - statusTime.value) / 1000),
));
const fetching = computed(() => loading.value || historyLoading.value);
const activeHistory = computed(() => historyActivity.value?.active || []);
const chart = ref(null);
let controller, historyController, statusTimer;
let currentChain = [];
const historicalSlices = computed(() => buildHistoricalSkew({
  quotes: history.value, delta: selectedDelta.value, limit: Infinity,
}));
const historicalSeries = computed(() => mergeSkewHistory(
  preparedHistory.value[delta.value] || [], constantMaturityHistory(historicalSlices.value),
));
const currentSeries = computed(() => constantMaturityCurve(
  buildCurrentSkew(live.value.map(q => ({ ...q, ts: referenceTime.value })), selectedDelta.value),
  referenceTime.value,
));
const sampledHistory = computed(() => buildSkewTimeSeries({ history: historicalSeries.value, tenors: TENORS,
  asOf: referenceTime.value, view: resolution.value }).series.flatMap(s => s.points.filter(Boolean)));
const series = computed(() => ({
  current: rankCurrentSkew(currentSeries.value, sampledHistory.value, "tenorDays"),
  history: historicalSeries.value,
}));
const timeSeries = computed(() => buildSkewTimeSeries({
  history: historicalSeries.value, current: series.value.current, tenors: TENORS,
  asOf: referenceTime.value, view: resolution.value,
}));
const indexPoints = computed(() => {
  const scheduled = new Set(historyWindow(resolution.value, referenceTime.value).timestamps);
  return indexBars.value.filter(bar => scheduled.has(bar.ts + 3600))
    .map(bar => ({ ts: bar.ts + 3600, price: bar.close }));
});
const visibleObservations = computed(() => timeSeries.value.series
  .filter(s => visibleTenors.value.includes(s.tenorDays)).reduce((n, s) => n + s.points.filter(Boolean).length, 0));
const expectedHistoryCount = computed(() => historyWindow(resolution.value, referenceTime.value).timestamps.length * visibleTenors.value.length);
const loadedHistoryCount = computed(() => sampledHistory.value.filter(p => visibleTenors.value.includes(p.tenorDays)).length);
function toggleTenor(tenor) {
  visibleTenors.value = visibleTenors.value.includes(tenor)
    ? visibleTenors.value.filter(t => t !== tenor)
    : TENORS.filter(t => t === tenor || visibleTenors.value.includes(t));
}
const deltaLabel = computed(() => `${delta.value}Δ`);
const snapshotTime = computed(() =>
  live.value.length ? Math.min(...live.value.map((q) => q.ts)) : null,
);
const snapshotEnd = computed(() =>
  live.value.length ? Math.max(...live.value.map((q) => q.ts)) : null,
);
const fmt = (ts) =>
  new Date(ts * 1000).toLocaleString("en-GB", {
    timeZone: "UTC",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
const fetchDetails = computed(() => [
  fetching.value ? "Updating data" : "Fetch finished",
  `Live quotes: ${liveReceived.value} usable; ${liveProgress.value.checked}/${liveProgress.value.total} checked.`,
  historyActivity.value
    ? `History: ${historyActivity.value.completedExpiries}/${historyActivity.value.totalExpiries} expiries checked; ${historyActivity.value.completedChecks} ranges checked.`
    : "History pending.",
  ...activeHistory.value.map(item => `Checking ${item.name}: ${fmt(item.from)} — ${fmt(item.to)} UTC`),
  ...(fetching.value && cooldownSeconds.value ? [`API cooldown: ${cooldownSeconds.value}s remaining.`] : []),
].join("\n"));
const sourceNotes = computed(() => [
  ...warnings.value,
  ...historyWarnings.value,
  ...(error.value ? [error.value] : []),
]);
const expiryLabel = (ts) =>
  new Date(ts * 1000).toLocaleDateString("en-GB", {
    timeZone: "UTC",
    day: "2-digit",
    month: "short",
    year: "2-digit",
  });

const signed = value => `${value > 0 ? "+" : ""}${(value * 100).toFixed(2)}`;
const detailRows = computed(() => {
  const current = new Map(series.value.current.map(p => [p.tenorDays, p]));
  const counts = new Map();
  for (const point of sampledHistory.value)
    counts.set(point.tenorDays, (counts.get(point.tenorDays) || 0) + 1);
  return TENORS.map(tenorDays => current.get(tenorDays) || { tenorDays, count: counts.get(tenorDays) || 0 });
});

async function loadHistory(chain, nextAsset, asOf) {
  historyController?.abort();
  const current = new AbortController();
  historyController = current;
  const parentSignal = controller?.signal;
  const cancel = () => current.abort();
  parentSignal?.addEventListener("abort", cancel, { once: true });
  if (parentSignal?.aborted) current.abort();
  const { signal } = current;
  const active = () => !signal.aborted;
  historyLoading.value = true;
  historyWarnings.value = [];
  historyActivity.value = null;
  try {
    const past = await fetchSkewHistory(chain, nextAsset, {
      delta: selectedDelta.value,
      liveIvs: () => new Map(live.value.map(q => [q.name, q.iv])),
      signal,
      asOf,
      window: historyWindow(resolution.value, asOf),
      onActivity: (activity) => {
        if (!active()) return;
        historyActivity.value = activity;
      },
      onUpdate: (data) => {
        if (!active()) return;
        history.value = data.quotes;
        preparedHistory.value = data.preparedHistory || {};
        indexBars.value = data.indexBars || [];
      },
    });
    if (!active()) return;
    history.value = past.quotes;
    preparedHistory.value = past.preparedHistory || {};
    indexBars.value = past.indexBars || [];
    if (past.rateLimitWarning)
      historyWarnings.value.push(past.rateLimitWarning);
    if (past.warning) historyWarnings.value.push(past.warning);
    if (past.failures.length)
      historyWarnings.value.push(
        `${past.failures.length} option histories failed. Available cached history is still shown; refresh to retry.`,
      );
    if (!past.quotes.length && !Object.values(past.preparedHistory || {}).some(points => points.length))
      historyWarnings.value.push("No historical IV observations returned.");
  } catch (error) {
    if (active())
      historyWarnings.value.push(
        `History update failed: ${error.message || error}. Any history already loaded remains visible.`,
      );
  } finally {
    parentSignal?.removeEventListener("abort", cancel);
    if (historyController === current) historyLoading.value = false;
  }
}

async function load(nextAsset = asset.value) {
  const switchingAsset = nextAsset !== asset.value;
  controller?.abort();
  currentChain = [];
  const currentController = new AbortController();
  controller = currentController;
  const { signal } = currentController;
  asset.value = nextAsset;
  loading.value = true;
  liveProgress.value = { checked: 0, total: 0 };
  liveReceived.value = 0;
  error.value = "";
  warnings.value = [];
  historyWarnings.value = [];
  historyActivity.value = null;
  if (switchingAsset) {
    live.value = [];
    history.value = [];
    preparedHistory.value = {};
    indexBars.value = [];
    referenceTime.value = null;
  }
  const active = () => !signal.aborted;
  try {
    const chain = await fetchOptionChain(nextAsset, signal);
    signal.throwIfAborted();
    if (!chain.length)
      throw new Error(`No live ${nextAsset} option expiries returned`);
    currentChain = chain;
    liveProgress.value = { checked: 0, total: chain.length };
    referenceTime.value = Date.now() / 1000;
    let liveTimer = null,
      pendingLive = [];
    const publishLive = (quotes) => {
      if (!active()) return;
      liveReceived.value = quotes.length;
      pendingLive = quotes;
      if (quotes.length === chain.length) {
        clearTimeout(liveTimer);
        liveTimer = null;
        if (active()) live.value = quotes;
      } else if (liveTimer == null)
        liveTimer = setTimeout(() => {
          liveTimer = null;
          if (active()) live.value = pendingLive;
        }, 50);
    };
    signal.addEventListener("abort", () => clearTimeout(liveTimer), {
      once: true,
    });
    const loadLive = async () => {
      try {
        const snapshot = await fetchLiveQuotes(chain, {
          signal,
          onProgress: (checked, total) => {
            if (active()) liveProgress.value = { checked, total };
          },
          onQuotes: publishLive,
        });
        if (!active()) return;
        clearTimeout(liveTimer);
        liveTimer = null;
        live.value = snapshot.quotes;
        liveReceived.value = snapshot.quotes.length;
        if (snapshot.rateLimitWarning) warnings.value.push(snapshot.rateLimitWarning);
        if (snapshot.failures.length)
          warnings.value.push(
            `${snapshot.failures.length} live option quotes unavailable. The curve uses the remaining quotes.`,
          );
        if (!snapshot.quotes.length)
          warnings.value.push(
            "No fresh live IVs returned. Historical observations remain visible; refresh to retry.",
          );
      } catch (e) {
        if (active()) error.value = e.message || String(e);
      }
    };
    await Promise.allSettled([
      loadLive(),
      loadHistory(chain, nextAsset, referenceTime.value),
    ]);
    signal.throwIfAborted();
  } catch (e) {
    if (active()) error.value = e.message || String(e);
  } finally {
    if (active()) {
      loading.value = false;
    }
  }
}
onMounted(() => {
  load();
  statusTimer = setInterval(() => {
    if (!fetching.value) return;
    statusTime.value = Date.now();
    queueStatus.value = getThalexQueueStatus();
  }, 1000);
});
watch([resolution, delta], () => {
  if (currentChain.length) void loadHistory(currentChain, asset.value, referenceTime.value);
});
onBeforeUnmount(() => {
  controller?.abort();
  historyController?.abort();
  clearInterval(statusTimer);
});
</script>

<template>
  <main class="app">
    <header class="topBar">
      <div class="wordmark">Skew</div>
      <div class="divider"></div>
      <div class="controls">
        <div class="underlyingToggle" role="group" aria-label="Underlying">
          <button v-for="coin in ['BTC', 'ETH']" :key="coin" type="button"
            class="underlyingButton" :class="{ underlyingButtonActive: asset === coin }"
            :aria-pressed="asset === coin" @click="asset !== coin && load(coin)">{{ coin }}</button>
        </div>
        <div class="field">
          <label for="delta">Delta</label>
          <StyledSelectMenu id="delta" v-model="delta" label="Absolute delta" :options="DELTAS" />
        </div>
        <div class="field">
          <label for="resolution">History</label>
          <StyledSelectMenu id="resolution" v-model="resolution" label="History window" :options="HISTORY_VIEWS" />
        </div>
        <button class="saveButton indexButton" :class="{ indexButtonActive: showIndex }" type="button"
          :aria-pressed="showIndex" @click="showIndex = !showIndex">Index price</button>
        <button class="saveButton" type="button" @click="load()">{{ fetching ? 'Restart fetch' : 'Refresh' }}</button>
        <button class="saveButton" type="button" :disabled="!visibleObservations"
          @click="chart?.exportPng()">Save PNG</button>
      </div>
    </header>

    <section class="chartPanel" aria-label="Constant-maturity constant-delta skew" :aria-busy="fetching">
      <SkewChart ref="chart" :data="timeSeries" :tenors="TENORS" :visible-tenors="visibleTenors"
        :resolution="resolution" :asset="asset" :delta-label="deltaLabel"
        :show-index="showIndex" :index-points="indexPoints"
        :history="series.history" :snapshot-time="snapshotTime" :snapshot-end="snapshotEnd" :loading="fetching"
        @toggle-tenor="toggleTenor" />
    </section>

    <div class="dataFootnotes">
      <p :title="fetchDetails" role="status">{{ fetching ? (cooldownSeconds ? `API cooldown · ${cooldownSeconds}s` : 'Updating data…') : error ? 'Update incomplete' : 'Snapshot loaded' }}
        · {{ visibleTenors.length }} constant-tenor series · {{ historySpec.sampling }} · {{ loadedHistoryCount }}/{{ expectedHistoryCount }} historical observations</p>
      <p>Call IV − put IV at the same absolute delta · Volatility points · Positive: calls richer · Negative: puts richer</p>
      <p>Constant maturity · Constant {{ deltaLabel }} · Call/put total variance interpolated separately before subtraction.</p>
      <details v-if="sourceNotes.length"><summary>Data notices · {{ sourceNotes.length }}</summary>
        <p v-for="note in sourceNotes" :key="note">{{ note }}</p>
      </details>
    </div>

    <details v-if="referenceTime" class="expiryDetails">
      <summary>Constant-tenor detail · {{ TENORS.length }} tenors · {{ deltaLabel }} call − put</summary>
      <div class="table-scroll">
        <table>
          <thead><tr><th>TENOR</th><th>BRACKETING EXPIRIES (UTC)</th><th>CALL IV</th><th>PUT IV</th>
            <th>SKEW (VOL PTS)</th><th>HISTORICAL PERCENTILE</th><th>WINDOW OBSERVATIONS</th></tr></thead>
          <tbody><tr v-for="p in detailRows" :key="p.tenorDays">
            <td>{{ tenorLabel(p.tenorDays) }}</td>
            <td>{{ p.nearExpiry == null ? 'Unavailable' : expiryLabel(p.nearExpiry) + (p.nearExpiry === p.farExpiry ? '' : ' → ' + expiryLabel(p.farExpiry)) }}</td>
            <td>{{ p.callIv == null ? '—' : (p.callIv * 100).toFixed(2) + '%' }}</td>
            <td>{{ p.putIv == null ? '—' : (p.putIv * 100).toFixed(2) + '%' }}</td>
            <td class="iv-cell">{{ p.skew == null ? 'Unavailable' : signed(p.skew) }}</td>
            <td><div v-if="p.rank != null" class="rank-cell"><div class="rank-track"><i :style="{ width: p.rank + '%' }"></i></div>
              <span>{{ p.rank.toFixed(0) }}th</span></div><span v-else>—</span></td>
            <td>{{ p.count == null ? '—' : p.count.toLocaleString() }}</td>
          </tr></tbody>
        </table>
      </div>
    </details>
    <details class="methodDetails">
      <summary>Method</summary>
      <p>Each point is {{ deltaLabel }} call IV minus {{ deltaLabel }} put IV at a fixed remaining maturity:
        7, 14, 30, 60, 90 or 180 calendar days. Each listed expiry first interpolates same-side variance to the target
        Black–Scholes spot delta, using zero rates/carry and a 365.25-day year. This approximates exchange forward delta.</p>
      <p>For each fixed tenor, interpolate call and put total variance (IV² × time to expiry) separately between bracketing expiries,
        recover each wing’s IV, then subtract. Every historical timestamp uses its own time to expiry and the contracts available then,
        including contracts expired today. There is no extrapolation in delta or maturity, no linear interpolation of skew,
        and no borrowing from other timestamps.</p>
      <p>The chart shows skew through time, one line per fixed tenor. Red identifies shorter tenors; blue identifies longer tenors.
        History buckets use calendar months/years: 1Y and 6M sample daily, 3M every six hours, 1M every two hours, and 1W hourly.
        Source closes are aligned to UTC; the default is 3 months. Parquet-derived constant-tenor series load before API updates; only the uncovered tail is fetched.
        Hover to compare tenors at the same UTC timestamp; click a legend entry to show or hide it. The latest live point uses the same tenor color.
        Percentiles use equally spaced observations in the selected history window.</p>
      <p>Live marks are collected as a snapshot and update on refresh. Historical points also use closing mark IV.</p>
      <p>Skew lines use cubic B-spline smoothing for display; hover values and percentiles use the original observations.
        The Index price button adds faint closing-price dots in the background, using the USD scale on the right.</p>
    </details>
  </main>
</template>
