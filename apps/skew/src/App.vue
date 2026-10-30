<script setup>
import {
  computed,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
} from "vue";
import SkewChart from "./components/SkewChart.vue";
import StyledSelectMenu from "../../../lib/components/StyledSelectMenu.vue";
import { fetchOptionChain, fetchLiveQuotes, fetchHistoricalQuotes, HISTORY_LIMIT } from "./market-data.js";
import { selectLiveQuotes } from "./volatility.js";
import { DELTAS, buildCurrentSkew, buildHistoricalSkew, rankCurrentSkew } from "./skew.js";
import { getThalexQueueStatus } from "./thalex-rest.js";
import { buildSkewSnapshots, SNAPSHOT_RESOLUTIONS } from "./skew-snapshots.js";

const asset = ref("BTC");
const delta = ref("25");
const selectedDelta = computed(() => DELTAS.find(d => d.value === delta.value).delta);
const source = ref("mark");
const resolution = ref("daily");
const resolutionSpec = computed(() => SNAPSHOT_RESOLUTIONS.find(item => item.value === resolution.value));
const expiries = ref([]),
  referenceTime = ref(null);
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
const selectedLive = computed(() => selectLiveQuotes(live.value, source.value));
const bookFallbackCount = computed(
  () =>
    live.value.filter((q) => !(q.bookIv > 0 && Number.isFinite(q.bookIv)))
      .length,
);
const sourceLabel = computed(() =>
  source.value === "book" ? "Book mid / mark fallback" : "Live marks",
);
const historicalSeries = computed(() => buildHistoricalSkew({
  quotes: history.value,
  delta: selectedDelta.value,
  limit: HISTORY_LIMIT,
  expiries: expiries.value,
}));
const snapshots = computed(() => buildSkewSnapshots(historicalSeries.value, expiries.value, referenceTime.value, resolution.value));
const series = computed(() => ({
  current: rankCurrentSkew(buildCurrentSkew(selectedLive.value, selectedDelta.value), historicalSeries.value),
  history: historicalSeries.value,
}));
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
  ...(source.value === "book" && bookFallbackCount.value
    ? [`${bookFallbackCount.value} options have no usable book midpoint and use mark IV.`] : []),
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
  const current = new Map(series.value.current.map(p => [p.expiry, p]));
  const counts = new Map();
  for (const point of series.value.history)
    counts.set(point.expiry, (counts.get(point.expiry) || 0) + 1);
  return expiries.value.map(expiry => current.get(expiry) || { expiry, count: counts.get(expiry) || 0 });
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
    const past = await fetchHistoricalQuotes(chain, nextAsset, {
      signal,
      asOf,
      onActivity: (activity) => {
        if (!active()) return;
        historyActivity.value = activity;
      },
      onUpdate: (data) => {
        if (!active()) return;
        history.value = data.quotes;
      },
    });
    if (!active()) return;
    history.value = past.quotes;
    if (past.rateLimitWarning)
      historyWarnings.value.push(past.rateLimitWarning);
    if (past.warning) historyWarnings.value.push(past.warning);
    if (past.failures.length)
      historyWarnings.value.push(
        `${past.failures.length} option histories failed. Available cached history is still shown; refresh to retry.`,
      );
    if (!past.quotes.length)
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
    expiries.value = [];
    referenceTime.value = null;
  }
  const active = () => !signal.aborted;
  try {
    const chain = await fetchOptionChain(nextAsset, signal);
    signal.throwIfAborted();
    if (!chain.length)
      throw new Error(`No live ${nextAsset} option expiries returned`);
    liveProgress.value = { checked: 0, total: chain.length };
    expiries.value = [...new Set(chain.map((i) => i.expiry))].sort(
      (a, b) => a - b,
    );
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
          <label for="resolution">Resolution</label>
          <StyledSelectMenu id="resolution" v-model="resolution" label="Historical resolution" :options="SNAPSHOT_RESOLUTIONS" />
        </div>
        <div class="field">
          <label for="source">Current</label>
          <StyledSelectMenu id="source" v-model="source" label="Current curve" :options="[
            { value: 'mark', label: 'Live marks' },
            { value: 'book', label: 'Book mid / mark fallback' },
          ]" />
        </div>
        <button class="saveButton" type="button" @click="load()">{{ fetching ? 'Restart fetch' : 'Refresh' }}</button>
        <button class="saveButton" type="button" :disabled="!series.current.length && !snapshots.length"
          @click="chart?.exportPng()">Save PNG</button>
      </div>
    </header>

    <section class="chartPanel" aria-label="Call-put skew by maturity" :aria-busy="fetching">
      <SkewChart ref="chart" :current="series.current" :history="series.history" :expiries="expiries"
        :snapshots="snapshots" :resolution="resolution" :reference-time="referenceTime"
        :asset="asset" :delta-label="deltaLabel" :source-label="sourceLabel" :snapshot-time="snapshotTime"
        :snapshot-end="snapshotEnd" :loading="fetching" />
    </section>

    <div class="dataFootnotes">
      <p :title="fetchDetails" role="status">{{ fetching ? (cooldownSeconds ? `API cooldown · ${cooldownSeconds}s` : 'Updating data…') : error ? 'Update incomplete' : 'Snapshot loaded' }}
        · {{ series.current.length }}/{{ expiries.length }} live maturities · {{ snapshots.length }}/{{ resolutionSpec.count }} historical snapshots</p>
      <p>Call IV − put IV at the same absolute delta · Volatility points · Positive: calls richer · Negative: puts richer</p>
      <p>Solid: observed · Dashed: interpolation between observed maturities at the same timestamp. Unbracketed ends stay unavailable.</p>
      <details v-if="sourceNotes.length"><summary>Data notices · {{ sourceNotes.length }}</summary>
        <p v-for="note in sourceNotes" :key="note">{{ note }}</p>
      </details>
    </div>

    <details v-if="expiries.length" class="expiryDetails">
      <summary>Expiry detail · {{ expiries.length }} maturities · {{ deltaLabel }} call − put</summary>
      <div class="table-scroll">
        <table>
          <thead><tr><th>EXPIRY (UTC)</th><th>DAYS TO EXPIRY</th><th>CALL IV</th><th>PUT IV</th>
            <th>SKEW (VOL PTS)</th><th>HISTORICAL PERCENTILE</th><th>HOURLY OBSERVATIONS</th></tr></thead>
          <tbody><tr v-for="p in detailRows" :key="p.expiry">
            <td>{{ expiryLabel(p.expiry) }}</td>
            <td>{{ ((p.expiry - referenceTime) / 86400).toFixed(1) }}</td>
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
      <p>Each point is {{ deltaLabel }} call IV minus {{ deltaLabel }} put IV for the same listed expiry.
        Wings interpolate variance in Black–Scholes spot delta, using zero rates/carry and a 365.25-day year.
        This approximates exchange forward delta. Neither wing is extrapolated; an unavailable wing omits that expiry’s value.</p>
      <p>Historical curves pair both wings at the exact same completed UTC close and use that hour’s index close and remaining maturity.
        Daily shows 72 hourly snapshots over three days; Weekly shows 14 daily snapshots; Monthly shows 12 weekly snapshots.
        All schedules end at the latest completed UTC hour at refresh time. Partial snapshots are retained. Missing internal maturities use linear skew interpolation
        in actual expiry time, between observations at that same timestamp. Sections touching an estimate are dashed; observed sections are solid.
        There is no extrapolation before the first or after the last observed maturity. Hover details label estimates; estimates do not enter percentiles or IV values.
        Older curves are faded violet; newer curves are brighter cyan. The white curve shows the current snapshot.
        Maturities are equally spaced listed contracts, not constant-tenor series.</p>
      <p>Percentiles in the expiry details use the full available 2,000-hour history, independently of the resolution.
        Higher percentiles mean more call-rich skew.</p>
      <p>Live quotes are collected as a snapshot and update on refresh. Book mid uses mark IV for any option with no usable midpoint.
        Historical comparisons always use mark IV, including when the current curve uses book mid.</p>
    </details>
  </main>
</template>
