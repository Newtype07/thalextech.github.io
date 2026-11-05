<script setup>
import { computed, ref, shallowRef, watch, onBeforeUnmount } from "vue";
import SimulationChart from "./SimulationChart.vue";
import SimulationPathsChart from "./SimulationPathsChart.vue";
import MarketAssumptions from "../../../../lib/components/MarketAssumptions.vue";
import DeltaHedgeControls from "../../../../lib/components/DeltaHedgeControls.vue";
import DeltaHedgeToggle from "../../../../lib/components/DeltaHedgeToggle.vue";
import { DEFAULT_HEDGE_POLICY } from "../../../../lib/delta-hedging/index.js";
import PositionBuilder from "../../../../lib/components/PositionBuilder.vue";
import { simulatePosition } from "../simulation/position-simulation.js";
import { runPositionEnsemble } from "../simulation/ensemble-worker-client.js";
import { builderInstruments, defaultShortStraddle, resolvePosition, entryValuations } from "../simulation/position-selection.js";

const props = defineProps({
  asset: { type: String, required: true },
  liveCurve: { type: Array, default: () => [] },
  liveSpot: { type: Number, default: null },
  asOf: { type: Number, default: null },
  marketLoading: { type: Boolean, default: false },
  instruments: { type: Array, default: () => [] },
});
const market = shallowRef(null);
const curveSource = "Live ATM marks";
const curveTime = computed(() => market.value?.asOf ?? null);
const entrySpot = computed(() => market.value?.spot ?? null);
const positionLegs = ref([]);
let initialized = false;
const instruments = computed(() => builderInstruments(market.value?.instruments || [], props.asset));
const settings = ref({
  runs: 1,
  exitAt: "first",
  driftPercent: 0,
  hedge: { ...DEFAULT_HEDGE_POLICY },
  optionBps: 1,
});
const marketSettings = ref({ shape: "forward", dynamics: "constant", rv: .5, rvMultiplier: 1, lookbackDays: 90, profile: null });
const rvPercent = computed({ get: () => marketSettings.value.rvMultiplier * 100,
  set: value => { marketSettings.value = { ...marketSettings.value, rvMultiplier: value / 100 }; } });
const result = shallowRef(null),
  error = ref(""),
  running = ref(false),
  settingsOpen = ref(true),
  runFingerprint = ref(""),
  form = ref(null);
const completed = ref(0);
const pathSeed = ref(crypto.getRandomValues(new Uint32Array(1))[0]);
function newPaths() { pathSeed.value = crypto.getRandomValues(new Uint32Array(1))[0]; run(); }
let runController;
const fingerprint = computed(() =>
  JSON.stringify({ settings: settings.value, marketSettings: marketSettings.value, legs: positionLegs.value, market: market.value }),
);
const dirty = computed(
  () => result.value && fingerprint.value !== runFingerprint.value,
);
const nodeInputs = computed(() =>
  (market.value?.curve || []).map(({ seconds, iv }) => ({ seconds, iv })),
);
const canCapture = computed(() =>
  !props.marketLoading && props.liveSpot > 0 && Number.isFinite(props.asOf) &&
  props.liveCurve.length > 0 && props.instruments.length > 0,
);
const preview = computed(() => {
  if (!market.value) return { error: "Waiting for live spot, ATM IVs and listed options." };
  try {
    const legs = resolvePosition(positionLegs.value, market.value.instruments, curveTime.value);
    const maturities = legs.map(leg => leg.maturity);
    const horizon = settings.value.exitAt === "last" ? Math.max(...maturities) : Math.min(...maturities);
    const valuations = entryValuations(legs, nodeInputs.value, entrySpot.value);
    return { legs, horizon, valuations, error: "" };
  } catch (e) {
    return { error: e.message };
  }
});
const mixedMaturities = computed(() => preview.value.legs?.some(leg => leg.maturity !== preview.value.horizon));
const money = (value) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
const timestamp = (seconds) =>
  new Date(seconds * 1000).toLocaleString("en-GB", {
    timeZone: "UTC",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }) + " UTC";
function useLive() {
  if (!canCapture.value) return;
  if (market.value) pathSeed.value = crypto.getRandomValues(new Uint32Array(1))[0];
  market.value = {
    spot: props.liveSpot,
    asOf: props.asOf,
    curve: props.liveCurve.map(point => ({ ...point })),
    instruments: props.instruments.map(instrument => ({ ...instrument })),
  };
  if (!initialized && !positionLegs.value.length) {
    const defaults = defaultShortStraddle(market.value.instruments, nodeInputs.value, entrySpot.value, curveTime.value);
    if (defaults.length) {
      positionLegs.value = defaults;
      initialized = true;
    }
  }
  error.value = "";
}
watch(
  [
    () => props.liveCurve,
    () => props.liveSpot,
    () => props.asOf,
    () => props.marketLoading,
    () => props.instruments,
  ],
  () => {
    if (canCapture.value) useLive();
  },
  { immediate: true },
);
let autoRunTimer;
// Coalesce typing and slider changes, after the form and maturity options render.
watch(
  [market, fingerprint, form],
  (_, __, onCleanup) => {
    runController?.abort();
    error.value = "";
    if (!market.value || !form.value || preview.value.error) return;
    const timer = setTimeout(run, 120);
    autoRunTimer = timer;
    onCleanup(() => clearTimeout(timer));
  },
  { flush: "post" },
);
onBeforeUnmount(() => {
  clearTimeout(autoRunTimer);
  runController?.abort();
});
async function run() {
  clearTimeout(autoRunTimer);
  if (preview.value.error) return;
  runController?.abort();
  const controller = new AbortController();
  runController = controller;
  running.value = true;
  completed.value = 0;
  error.value = "";
  // Give the browser a paint before starting the simulation.
  await new Promise((resolve) =>
    requestAnimationFrame(() => setTimeout(resolve, 0)),
  );
  try {
    if (controller.signal.aborted) return;
    // A change during the paint delay is included in this run.
    clearTimeout(autoRunTimer);
    if (!form.value || preview.value.error) return;
    if (!form.value.checkValidity()) {
      error.value = "Complete all settings with values in the allowed ranges.";
      return;
    }
    const s = settings.value;
    const startedFingerprint = fingerprint.value;
    const config = {
      asset: props.asset,
      spot: entrySpot.value,
      legs: preview.value.legs,
      horizon: preview.value.horizon,
      rvMultiplier: marketSettings.value.rvMultiplier,
      drift: s.driftPercent / 100,
      threshold: s.hedge.threshold,
      tolerance: s.hedge.tolerance,
      period: s.hedge.period,
      timing: s.hedge.timing,
      hedgeEnabled: s.hedge.enabled,
      hedgeEntry: s.hedge.entry,
      hedgeExit: s.hedge.exit,
      marketModel: JSON.parse(JSON.stringify(marketSettings.value)),
      step: 60,
      hedgeBps: s.hedge.hedgeBps,
      optionBps: s.optionBps,
      seed: pathSeed.value,
      nodes: nodeInputs.value,
      curveSource,
      curveTime: curveTime.value,
    };
    const next = s.runs === 100
      ? await runPositionEnsemble(config, {
          signal: controller.signal,
          onProgress: (count) => { completed.value = count; },
        })
      : simulatePosition(config);
    if (controller.signal.aborted) return;
    result.value = next;
    runFingerprint.value = startedFingerprint;
  } catch (e) {
    if (!controller.signal.aborted) error.value = e.message;
  } finally {
    if (runController === controller) running.value = false;
  }
}
function download() {
  if (!result.value) return;
  const data = result.value;
  const columns = data.paths ? ["run", "elapsedSeconds", "totalPnl"] : [
    "elapsedSeconds",
    "spot",
    "optionPnl",
    "hedgePnl",
    "totalPnl",
    "executionCosts",
  ];
  const csv = [
    columns.join(","),
    ...(data.paths ? [
      ...data.paths.flatMap((path, run) => path.pnl.map((pnl, i) =>
        [run + 1, data.elapsed[i], pnl].join(","))),
      ...data.median.map((pnl, i) => ["median", data.elapsed[i], pnl].join(",")),
    ] : data.rows.map((row) =>
      [
        row.elapsed,
        row.spot,
        row.optionPnl - row.optionFees,
        row.hedgePnl - row.hedgeFees,
        row.pnl,
        row.fees,
      ].join(","),
    )),
  ].join("\n");
  const url = URL.createObjectURL(
    new Blob([csv], { type: "text/csv;charset=utf-8" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `${data.config.asset}-position${data.paths ? '-100-runs' : ''}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
</script>

<template>
  <section class="simulator" aria-label="Delta-hedged option position simulator">
    <form
      ref="form"
      class="sim-layout"
      :class="{ 'sim-layout-collapsed': !settingsOpen }"
      @submit.prevent="newPaths()"
    >
      <div v-if="market" class="sim-position-builder">
        <PositionBuilder
          v-model:legs="positionLegs"
          :spot="entrySpot"
          :vol="nodeInputs[0]?.iv || 0.4"
          :T="30 / 365.25"
          :show-tte="true"
          :instruments="instruments"
          :index-name="`${asset}USD`"
          :index-price="entrySpot"
          :index-fetched-at="curveTime * 1000"
          :valuation-by-leg="preview.valuations || {}"
        />
      </div>
      <div class="sim-divider" role="separator"></div>
      <div class="sim-toolbar">
        <div class="sim-exit-control" role="group" aria-label="Simulation runs">
          <div class="underlyingToggle">
            <button v-for="count in [1, 100]" :key="count" type="button" class="underlyingButton"
              :class="{ underlyingButtonActive: settings.runs === count }"
              :aria-pressed="settings.runs === count" @click="settings.runs = count">
              {{ count === 1 ? 'Single run' : '100 runs' }}
            </button>
          </div>
        </div>
        <div class="sim-exit-control" role="group" aria-label="Simulate until">
          <span>Simulate until</span>
          <div class="underlyingToggle">
            <button
              v-for="exit in ['first', 'last']"
              :key="exit"
              type="button"
              class="underlyingButton"
              :class="{ underlyingButtonActive: settings.exitAt === exit }"
              :aria-pressed="settings.exitAt === exit"
              @click="settings.exitAt = exit"
            >
              {{ exit === 'first' ? 'First expiry' : 'Last expiry' }}
            </button>
          </div>
        </div>
        <div v-if="marketSettings.shape === 'forward'" class="field sim-rv-control">
          <label for="sim-rv-ratio">RV / forward IV</label>
          <input id="sim-rv-ratio" v-model.number="rvPercent" type="range" min="50" max="200" step="1" aria-label="Realized / forward volatility" />
          <output for="sim-rv-ratio">{{ marketSettings.rvMultiplier.toFixed(2) }}×</output>
        </div>
        <div class="field sim-drift-control">
          <label for="sim-drift">Annual drift</label>
          <input
            id="sim-drift"
            v-model.number="settings.driftPercent"
            type="number"
            min="-500"
            max="500"
            step="any"
            required
            aria-label="Annual drift"
          />
          <span>%</span>
        </div>
        <button
          class="saveButton sim-run"
          type="submit"
          aria-label="Refresh simulation"
          :aria-busy="running"
          :title="running ? 'Simulating…' : settings.runs === 100 ? 'Generate 100 new simulations' : 'Generate a new simulation'"
          :disabled="running || !!preview.error"
        >
          <svg
            class="sim-refresh-icon"
            :class="{ 'is-running': running }"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M21 3v5h-5M3 21v-5h5M3 12a9 9 0 0 1 15.36-6.36L21 8M21 12a9 9 0 0 1-15.36 6.36L3 16" />
          </svg>
        </button>

        <div class="sim-hedge-actions">
        <DeltaHedgeToggle :model-value="settings.hedge.enabled" @update:model-value="settings.hedge = { ...settings.hedge, enabled: $event }" />
        <button
          class="saveButton sim-settings-toggle"
          type="button"
          :aria-expanded="settingsOpen"
          :aria-label="settingsOpen ? 'Hide hedge settings' : 'Show hedge settings'"
          :title="settingsOpen ? 'Hide hedge settings' : 'Show hedge settings'"
          aria-controls="sim-hedge-settings"
          @click="settingsOpen = !settingsOpen"
        >
          <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path d="m5 7.5 5 5 5-5" />
          </svg>
        </button>
        </div>
      </div>
      <div class="sim-main">
        <div class="sim-trade-facts">
          <span>{{ positionLegs.length }} option {{ positionLegs.length === 1 ? "leg" : "legs" }}</span>
          <span>Spot {{ entrySpot ? money(entrySpot) : "—" }}</span>
          <span>{{ mixedMaturities
            ? settings.exitAt === 'last'
              ? "Exit at last expiry · earlier legs cash-settle"
              : "Exit at first expiry · later legs closed at model marks"
            : "Hold to expiry" }}</span>
          <span class="sim-source" :title="curveTime ? timestamp(curveTime) : ''">{{
            market ? "Live ATM marks" : "Waiting for market"
          }}</span>
        </div>
        <p v-if="error" class="sim-status sim-error" role="alert">{{ error }}</p>
        <p v-else-if="preview.error && market" class="sim-status" role="status">
          {{ preview.error }}
        </p>
        <p
          v-if="running && settings.runs === 100"
          class="sim-status sim-progress"
          role="status"
          aria-live="polite"
        >
          Simulating {{ completed }} / 100 runs…
        </p>
        <p
          v-else-if="dirty && !error && !preview.error"
          class="sim-status sim-pending"
          role="status"
        >
          Updating simulation…
        </p>
        <div class="sim-results" :aria-busy="running">
          <SimulationPathsChart v-if="result?.paths" :result="result" @export="download" />
          <SimulationChart v-else-if="result" :result="result" @export="download" />
          <div v-else class="sim-empty">
            {{
              market
                ? "Preparing simulation…"
                : "Waiting for live market data. Use Refresh above to retry."
            }}
          </div>
        </div>

        <footer class="sim-footer">
          <details class="sim-method">
            <summary>Model assumptions</summary>
            <p>
              Up to four option legs, each priced with its own expiry's remaining
              variance from the captured ATM term structure and zero rates.
              Annual drift defaults to zero and is an editable
              percentage of expected price growth in the simulation model. Forward
              variance shapes the simulated price path; the RV / forward IV ratio
              scales its volatility. Option IV follows the variance remaining to
              expiry. The model excludes smile, funding, basis, margin and
              liquidation. Each leg cash-settles at its own expiry. At the selected
              exit, any unexpired legs close at model marks and the hedge is unwound.
            </p>
            <p>
              Hedges fill at the simulated spot and are checked at the selected time
              step. Option and hedge P&L each include their own execution costs,
              as selected in hedge settings. Settings changes reuse the same random
              price path; Refresh simulation generates new paths. In 100 runs mode, the same assumptions are used
              for 100 independent paths. The highlighted line is their median
              total P&L at each time, after all option and hedge costs.
            </p>
          </details>
        </footer>
      </div>
      <aside
        v-show="settingsOpen"
        id="sim-hedge-settings"
        class="sim-settings"
        aria-label="Hedge settings"
      >
        <h2>Hedge settings</h2>
        <p class="sim-settings-intro">
          Changes update the simulation automatically.
        </p>
        <DeltaHedgeControls v-model="settings.hedge" :asset="asset" :observation-seconds="60" />
        <MarketAssumptions v-model="marketSettings" :asset="asset" :forward-available="!!market" />
        <div class="sim-settings-panel">
          <label
            >Option cost · bps / leg<input
              v-model.number="settings.optionBps"
              type="number"
              min="0"
              step="any"
              required
          /></label>
          <p v-if="settings.exitAt === 'first'" class="sim-wide">
            Exit at the first option expiry. Later legs close at model marks;
            only those later legs incur option closing costs.
          </p>
          <p v-else class="sim-wide">
            Run to the last option expiry. Earlier legs cash-settle at their own
            expiries; the hedge policy continues on the remaining option delta.
          </p>
        </div>
      </aside>
    </form>
  </section>
</template>

<style scoped>
.simulator {
  --color-bg: #000;
  --color-text: #fff;
  --color-text-muted: #999999;
  --color-border: #292929;
  --color-border-strong: #484848;
  margin: 0;
  padding: 18px 28px 24px;
  font-size: 12px;
  background: #000;
}
.sim-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 280px;
  grid-template-areas: "builder ." "divider ." "toolbar settings" "main settings";
  grid-template-rows: auto auto auto 1fr;
  gap: 0 28px;
  align-items: start;
}
.sim-layout-collapsed {
  grid-template-columns: minmax(0, 1fr);
  grid-template-areas: "builder" "divider" "toolbar" "main";
}
.sim-position-builder {
  grid-area: builder;
  min-width: 0;
  margin: 18px 0;
  padding-bottom: 8px;
}
.sim-position-builder :deep(.total-greeks .leg-greek-value) {
  font-weight: 700;
}
.sim-divider {
  grid-area: divider;
  border-top: 1px solid var(--color-border);
  margin-bottom: 20px;
}
.sim-main {
  grid-area: main;
  min-width: 0;
}
.sim-toolbar {
  grid-area: toolbar;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.sim-toolbar > .saveButton {
  height: 36px;
}
.sim-settings-toggle { display: inline-flex; align-items: center; justify-content: center; width: 28px; padding: 6px; border: 0; }
.sim-settings-toggle[aria-expanded="true"] svg { transform: rotate(180deg); }
.sim-hedge-actions { display: inline-flex; align-items: center; gap: 4px; }
.sim-exit-control {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 10px;
  color: var(--color-text-muted);
  white-space: nowrap;
}
.sim-exit-control .underlyingToggle {
  height: 36px;
}
.sim-rv-control {
  gap: 10px;
}
.sim-rv-control input {
  width: 120px;
  accent-color: #00bf8c;
  cursor: pointer;
}
.sim-rv-control output {
  min-width: 38px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--color-text);
}
.sim-drift-control input {
  width: 56px;
  padding: 0;
  color: var(--color-text);
  background: transparent;
  border: 0;
  font: inherit;
  font-variant-numeric: tabular-nums;
}
.sim-drift-control span {
  color: var(--color-text-muted);
}
.sim-run {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 88px;
  padding: 0 24px;
  color: #000;
  background: #00bf8c;
  border-color: #00bf8c;
}
.sim-run:hover:not(:disabled) {
  color: #000;
  background: #00d69d;
  border-color: #00d69d;
}
.sim-refresh-icon {
  width: 19px;
  height: 19px;
}
.sim-refresh-icon.is-running {
  animation: sim-refresh 1s linear infinite;
}
@keyframes sim-refresh {
  to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  .sim-refresh-icon.is-running {
    animation: none;
  }
}
.sim-settings {
  --color-bg: #141417;
  grid-area: settings;
  position: sticky;
  top: 16px;
  min-width: 0;
  padding: 4px 0 16px 20px;
  border-left: 1px solid var(--color-border);
  background: var(--color-bg);
  isolation: isolate;
  z-index: 2;
}
.sim-settings h2 {
  margin: 0 0 8px;
  color: var(--color-text);
  font-size: 13px;
  font-weight: 500;
}
.sim-settings-intro {
  margin: 0 0 18px;
  color: var(--color-text-muted);
  font-size: 11px;
  line-height: 1.6;
}
.sim-settings-panel {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px 12px;
}
.sim-settings-panel label {
  font-size: 11px;
  color: var(--color-text-muted);
}
.sim-settings-panel input,
.sim-settings-panel select {
  display: block;
  width: 100%;
  height: 32px;
  margin-top: 6px;
  padding: 0 8px;
  font: inherit;
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: transparent;
}
.sim-wide {
  grid-column: 1 / -1;
}
.sim-settings-panel p {
  margin: 0;
  color: var(--color-text-muted);
  font-size: 11px;
  line-height: 1.6;
}
.sim-trade-facts {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 18px;
  margin: 12px 0 20px;
  font-size: 11px;
  color: var(--color-text-muted);
}
.sim-source {
  margin-left: auto;
  font-size: 10px;
}
.sim-status {
  margin: 12px 0;
  color: #aaaaaa;
  font-size: 11px;
  line-height: 1.6;
}
.sim-error {
  color: #d4a0a0;
}
.sim-results {
  min-width: 0;
}
.sim-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 500px;
  color: var(--color-text-muted);
  font-size: 12px;
  background: #000;
}
.sim-footer {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
  margin-top: 16px;
}
.sim-method {
  color: var(--color-text-muted);
  font-size: 11px;
  line-height: 1.7;
  max-width: 1000px;
}
.sim-method p {
  max-width: 1000px;
}
input:focus-visible,
select:focus-visible {
  outline: 1px solid #999999;
  outline-offset: 2px;
}
@media (max-width: 1100px) {
  .sim-layout {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas: "builder" "divider" "toolbar" "settings" "main";
    gap: 20px 0;
  }
  .sim-layout-collapsed {
    grid-template-areas: "builder" "divider" "toolbar" "main";
    gap: 0;
  }
  .sim-settings {
    position: static;
    padding: 16px;
    border: 1px solid var(--color-border);
    border-radius: 6px;
  }
  .sim-divider {
    margin-bottom: 0;
  }
}
@media (max-width: 760px) {
  .simulator {
    padding: 16px;
  }
  .sim-source {
    margin-left: 0;
  }
  .sim-empty {
    min-height: 350px;
  }
}
</style>
