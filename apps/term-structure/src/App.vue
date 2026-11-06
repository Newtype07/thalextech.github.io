<script setup>
import {
  computed,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
} from "vue";
import TermStructureChart from "./components/TermStructureChart.vue";
import StyledSelectMenu from "../../../lib/components/StyledSelectMenu.vue";
import ChartSettings from "./components/ChartSettings.vue";
import {
  realizedByExpiry,
  realizedForwardByExpiry,
  hourlyVariance,
} from "./realized-volatility.js";
import {
  fetchOptionChain,
  fetchLiveQuotes,
  fetchHistoricalQuotes,
  HISTORY_LIMIT,
} from "./market-data.js";
import { buildCurrentSeries, buildHistoricalSeries, rankCurrentCurve, selectLiveQuotes, SLICES } from "./volatility.js";
import {
  toForwardHistory,
  toForwardCurrent,
  VOLATILITY_VIEWS,
} from "./forward-volatility.js";
import { getThalexQueueStatus } from "./thalex-rest.js";
import { buildTermSnapshots, SNAPSHOT_RESOLUTIONS } from "./term-snapshots.js";
const asset = ref("BTC"),
  slice = ref("atm");
const source = ref("mark");
const volatilityView = ref("iv");
const detailLabel = computed(() =>
  volatilityView.value === "forward"
    ? "Forward interval detail"
    : "Expiry detail",
);
const expiries = ref([]),
  referenceTime = ref(null);
const showRealized = ref(true);
const chartStyle = ref("scatter");
const snapshotResolution = ref("daily");
const indexBars = shallowRef([]),
  coverage = ref(null);
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
const chart = ref(null),
  historyReady = ref(false);
let controller, historyController, statusTimer;
const currentChain = shallowRef([]);
const selectedLive = computed(() => selectLiveQuotes(live.value, source.value));
const bookFallbackCount = computed(
  () =>
    live.value.filter((q) => !(q.bookIv > 0 && Number.isFinite(q.bookIv)))
      .length,
);
const sourceLabel = computed(() =>
  source.value === "book" ? "Book mid / mark fallback" : "Live marks",
);
const historicalSeries = computed(() =>
  buildHistoricalSeries({
    history: history.value,
    slice: slice.value,
    limit: HISTORY_LIMIT,
    expiries: expiries.value,
  }),
);
const expirySeries = computed(() => ({
  current: rankCurrentCurve(buildCurrentSeries(selectedLive.value, slice.value), historicalSeries.value),
  history: historicalSeries.value,
}));
const forwardHistory = computed(() => toForwardHistory(historicalSeries.value, expiries.value));
const series = computed(() =>
  volatilityView.value === "forward"
    ? { ...toForwardCurrent(
        expirySeries.value.current,
        forwardHistory.value.history,
        expiries.value,
        referenceTime.value,
      ), negativeHistoryCount: forwardHistory.value.negativeHistoryCount }
    : expirySeries.value,
);
const snapshots = computed(() => chartStyle.value === "lines"
  ? buildTermSnapshots(
      volatilityView.value === "forward" ? forwardHistory.value.history : historicalSeries.value,
      expiries.value,
      referenceTime.value,
      snapshotResolution.value,
    )
  : []);
const sliceLabel = computed(
  () => SLICES.find((s) => s.value === slice.value).label,
);
const snapshotTime = computed(() =>
  live.value.length ? Math.min(...live.value.map((q) => q.ts)) : null,
);
const snapshotEnd = computed(() =>
  live.value.length ? Math.max(...live.value.map((q) => q.ts)) : null,
);
const total = computed(() => series.value.history.length);
const realized = computed(() =>
  (volatilityView.value === "forward"
    ? realizedForwardByExpiry
    : realizedByExpiry)(expiries.value, indexBars.value, referenceTime.value),
);
const realizedByMaturity = computed(
  () => new Map(realized.value.map((p) => [p.expiry, p])),
);
const rvDataRange = computed(() => {
  let start = null, end = null;
  for (const bar of indexBars.value) {
    if (!Number.isFinite(bar.ts) || bar.ts + 3600 > referenceTime.value || hourlyVariance(bar) == null) continue;
    start = Math.min(start ?? bar.ts, bar.ts);
    end = Math.max(end ?? bar.ts + 3600, bar.ts + 3600);
  }
  return { start, end };
});
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
  ...(chartStyle.value === "scatter" && source.value === "book" && bookFallbackCount.value
    ? [`${bookFallbackCount.value} options have no usable book midpoint and use mark IV.`] : []),
  ...(volatilityView.value === "forward" && series.value.unavailable.length
    ? [`${series.value.unavailable.length} forward intervals unavailable; gaps are left unfilled.`] : []),
]);
const expiryLabel = (ts) =>
  new Date(ts * 1000).toLocaleDateString("en-GB", {
    timeZone: "UTC",
    day: "2-digit",
    month: "short",
    year: "2-digit",
  });

const rowLabel = (point) =>
  volatilityView.value === "forward"
    ? `${point.startExpiry == null ? "Now" : expiryLabel(point.startExpiry)} → ${expiryLabel(point.expiry)}`
    : expiryLabel(point.expiry);

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
  coverage.value = null;
  try {
    const past = await fetchHistoricalQuotes(chain, nextAsset, {
      signal,
      asOf,
      slice: slice.value,
      onActivity: (activity) => {
        if (!active()) return;
        historyActivity.value = activity;
        coverage.value = activity.coverage;
      },
      onUpdate: (data) => {
        if (!active()) return;
        history.value = data.quotes;
        indexBars.value = data.indexBars;
        if (data.quotes.length) historyReady.value = true;
      },
    });
    if (!active()) return;
    history.value = past.quotes;
    indexBars.value = past.indexBars;
    coverage.value = past.coverage;
    historyReady.value = true;
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
  currentChain.value = [];
  if (switchingAsset) {
    live.value = [];
    history.value = [];
    indexBars.value = [];
    expiries.value = [];
    referenceTime.value = null;
    historyReady.value = false;
    coverage.value = null;
  }
  const active = () => !signal.aborted;
  try {
    const chain = await fetchOptionChain(nextAsset, signal);
    signal.throwIfAborted();
    if (!chain.length)
      throw new Error(`No live ${nextAsset} option expiries returned`);
    currentChain.value = chain;
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
        if (active()) {
          live.value = quotes;
        }
      } else if (liveTimer == null)
        liveTimer = setTimeout(() => {
          liveTimer = null;
          if (active()) {
            live.value = pendingLive;
          }
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
watch(slice, () => {
  if (currentChain.value.length)
    void loadHistory(currentChain.value, asset.value, referenceTime.value);
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
      <div class="wordmark">Term Structure</div>
      <div class="divider"></div>
      <div class="controls">
        <div class="underlyingToggle" role="group" aria-label="Underlying">
          <button
            v-for="coin in ['BTC', 'ETH']"
            :key="coin"
            type="button"
            class="underlyingButton"
            :class="{ underlyingButtonActive: asset === coin }"
            :aria-pressed="asset === coin"
            @click="asset !== coin && load(coin)"
          >
            {{ coin }}
          </button>
        </div>
        <div class="field">
          <label for="volatility-view">Volatility</label>
          <StyledSelectMenu
            id="volatility-view"
            v-model="volatilityView"
            label="Volatility"
            :options="VOLATILITY_VIEWS"
          />
        </div>
        <div class="field">
          <label for="slice">Slice</label>
          <StyledSelectMenu
            id="slice"
            v-model="slice"
            label="Slice"
            :options="SLICES"
          />
        </div>
        <div class="underlyingToggle" role="group" aria-label="Chart style">
          <button
            v-for="style in ['scatter', 'lines']"
            :key="style"
            type="button"
            class="underlyingButton"
            :class="{ underlyingButtonActive: chartStyle === style }"
            :aria-pressed="chartStyle === style"
            @click="chartStyle = style"
          >{{ style === 'scatter' ? 'Scatter' : 'Lines' }}</button>
        </div>
        <div v-if="chartStyle === 'lines'" class="field">
          <label for="snapshot-resolution">Resolution</label>
          <StyledSelectMenu
            id="snapshot-resolution"
            v-model="snapshotResolution"
            label="Snapshot resolution"
            :options="SNAPSHOT_RESOLUTIONS"
          />
        </div>
        <div v-if="chartStyle === 'scatter'" class="field">
          <label for="source">Current</label>
          <StyledSelectMenu
            id="source"
            v-model="source"
            label="Current curve"
            :options="[
              { value: 'mark', label: 'Live marks' },
              { value: 'book', label: 'Book mid / mark fallback' },
            ]"
          />
        </div>
        <button class="saveButton" type="button" @click="load()">
          {{ loading || historyLoading ? "Restart fetch" : "Refresh" }}
        </button>
        <button
          class="saveButton"
          type="button"
          :disabled="!series.current.length && !series.history.length"
          @click="chart?.exportPng()"
        >
          Save PNG
        </button>
      </div>
    </header>

    <div id="panel-curve">
      <section class="chartPanel" aria-label="Volatility term structure" :aria-busy="fetching">
        <ChartSettings
          v-model:show-realized="showRealized"
          :forward="volatilityView === 'forward'"
        />
        <TermStructureChart
          ref="chart"
          :current="series.current"
          :expiries="expiries"
          :history="series.history"
          :snapshots="snapshots"
          :chart-style="chartStyle"
          :snapshot-resolution="chartStyle === 'lines' ? snapshotResolution : ''"
          :asset="asset"
          :slice-label="sliceLabel"
          :source-label="sourceLabel"
          :view="volatilityView"
          :snapshot-time="snapshotTime"
          :rv-data-range="rvDataRange"
          :loading="loading || historyLoading"
          :realized="showRealized ? realized : []"
        />
      </section>

      <details v-if="series.current.length" class="expiryDetails">
        <summary>
          {{ detailLabel }} · {{ series.current.length }}
          {{ volatilityView === "forward" ? "intervals" : "expiries" }} ·
          {{ total.toLocaleString() }} historical observations
        </summary>
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>
                  {{
                    volatilityView === "forward"
                      ? "INTERVAL (UTC)"
                      : "EXPIRY (UTC)"
                  }}
                </th>
                <th>
                  {{
                    volatilityView === "forward"
                      ? "INTERVAL DAYS"
                      : "DAYS TO EXPIRY"
                  }}
                </th>
                <th>
                  {{
                    volatilityView === "forward" ? "LIVE FORWARD VOL" : "LIVE IV"
                  }}
                </th>
                <th v-if="showRealized">REALIZED VOL</th>
                <th v-if="showRealized">RV COVERAGE</th>
                <th v-if="showRealized">
                  {{ volatilityView === "forward" ? "FORWARD − RV" : "IV − RV" }}
                </th>
                <th>HISTORICAL PERCENTILE</th>
                <th>HOURLY OBSERVATIONS</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in series.current" :key="p.expiry">
                <td>{{ rowLabel(p) }}</td>
                <td>
                  {{
                    (
                      (p.expiry -
                        (volatilityView === "forward"
                          ? (p.startExpiry ?? p.ts)
                          : p.ts)) /
                      86400
                    ).toFixed(1)
                  }}
                </td>
                <td
                  class="iv-cell"
                  :title="
                    p.clamped
                      ? 'Spot outside available strikes; nearest strike used in at least one IV input'
                      : undefined
                  "
                >
                  {{ (p.iv * 100).toFixed(2) }}%
                </td>
                <td
                  v-if="showRealized"
                  :title="
                    realizedByMaturity.get(p.expiry)?.count +
                    ' of ' +
                    realizedByMaturity.get(p.expiry)?.hours +
                    ' hourly bars'
                  "
                >
                  {{
                    realizedByMaturity.get(p.expiry)?.iv == null
                      ? "Unavailable"
                      : (realizedByMaturity.get(p.expiry).iv * 100).toFixed(2) +
                        "%"
                  }}
                </td>
                <td v-if="showRealized">
                  {{
                    realizedByMaturity.has(p.expiry)
                      ? (realizedByMaturity.get(p.expiry).coverage * 100).toFixed(
                          2,
                        ) + "%"
                      : "—"
                  }}
                </td>
                <td v-if="showRealized">
                  {{
                    realizedByMaturity.get(p.expiry)?.iv == null
                      ? "—"
                      : (
                          (p.iv - realizedByMaturity.get(p.expiry).iv) *
                          100
                        ).toFixed(2) + " pp"
                  }}
                </td>
                <td>
                  <div class="rank-cell">
                    <div class="rank-track">
                      <i :style="{ width: (p.rank ?? 0) + '%' }"></i>
                    </div>
                    <span>{{
                      p.rank == null ? "—" : p.rank.toFixed(0) + "th"
                    }}</span>
                  </div>
                </td>
                <td>
                  {{
                    historyReady
                      ? p.count.toLocaleString()
                      : loading
                        ? "Loading…"
                        : "Unavailable"
                  }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </details>

    </div>
  </main>
</template>
