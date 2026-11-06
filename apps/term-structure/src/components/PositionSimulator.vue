<script setup>
import { computed, ref, shallowRef, watch, onBeforeUnmount } from "vue";
import SimulationChart from "./SimulationChart.vue";
import MarketAssumptions from "../../../../lib/components/MarketAssumptions.vue";
import DeltaHedgeControls from "../../../../lib/components/DeltaHedgeControls.vue";
import DeltaHedgeToggle from "../../../../lib/components/DeltaHedgeToggle.vue";
import SettingsSidePanel from "../../../../lib/components/SettingsSidePanel.vue";
import { DEFAULT_HEDGE_POLICY } from "../../../../lib/delta-hedging/index.js";
import PositionBuilder from "../../../../lib/components/PositionBuilder.vue";
import { simulatePosition } from "../simulation/position-simulation.js";
import { builderInstruments, defaultShortStraddle, resolvePosition, entryValuations } from "../simulation/position-selection.js";

const props = defineProps({
  asset: { type: String, required: true },
  liveCurve: { type: Array, default: () => [] },
  liveSpot: { type: Number, default: null },
  asOf: { type: Number, default: null },
  marketLoading: { type: Boolean, default: false },
  marketProgress: { type: Object, default: () => ({ checked: 0, total: 0 }) },
  marketCooldown: { type: Number, default: 0 },
  marketError: { type: String, default: "" },
  instruments: { type: Array, default: () => [] },
});
const market = shallowRef(null);
const curveSource = "Live ATM marks";
const curveTime = computed(() => market.value?.asOf ?? null);
const entrySpot = computed(() => market.value?.spot ?? null);
const positionLegs = ref([]);
let initialized = false;
const instruments = computed(() => builderInstruments(market.value?.instruments || [], props.asset));
const tradeWindow = ref(null);
const settings = ref({
  holdingDays: 7,
  driftPercent: 0,
  hedge: { ...DEFAULT_HEDGE_POLICY },
  optionBps: 1,
});
const holdingPresets = [1, 2, 3, 4, 5, 6, 7, 14, 30, 60, 90];
const holdingStep = computed({
  get: () => holdingPresets.indexOf(settings.value.holdingDays),
  set: index => { settings.value.holdingDays = holdingPresets[index]; },
});
const marketSettings = ref({ shape: "forward", dynamics: "constant", rv: .5, rvMultiplier: 1, lookbackDays: 90, profile: null });
const rvPercent = computed({ get: () => marketSettings.value.rvMultiplier * 100,
  set: value => { marketSettings.value = { ...marketSettings.value, rvMultiplier: value / 100 }; } });
const result = shallowRef(null),
  error = ref(""),
  running = ref(false),
  runFingerprint = ref(""),
  form = ref(null);
const pathSeed = ref(crypto.getRandomValues(new Uint32Array(1))[0]);
function newPaths() { pathSeed.value = crypto.getRandomValues(new Uint32Array(1))[0]; run(); }
let runController;
const fingerprint = computed(() =>
  JSON.stringify({ settings: settings.value, marketSettings: marketSettings.value, legs: positionLegs.value, market: market.value, tradeWindow: tradeWindow.value }),
);
const dirty = computed(
  () => result.value && fingerprint.value !== runFingerprint.value,
);
const nodeInputs = computed(() =>
  (market.value?.curve || []).map(({ seconds, iv }) => ({ seconds, iv })),
);
const curveCoverage = computed(() => {
  const expiries = new Set(props.instruments.map(instrument => instrument.expiry));
  const covered = new Set(props.liveCurve.filter(point => point.ready !== false)
    .map(point => point.expiry ?? props.asOf + point.seconds));
  return { ready: [...expiries].filter(expiry => covered.has(expiry)).length, total: expiries.size };
});
const canCapture = computed(() =>
  props.liveSpot > 0 && Number.isFinite(props.asOf) &&
  props.liveCurve.length > 0 && props.instruments.length > 0,
);
// Wait for the curve's maturities, not every strike's ticker or chart history.
// Once quote collection finishes, preserve the existing partial-curve fallback.
const curveReady = computed(() => canCapture.value && (
  !props.marketLoading || curveCoverage.value.ready === curveCoverage.value.total
));
const loadingLabel = computed(() => market.value
  ? running.value ? "Running simulation…" : "Preparing simulation…"
  : props.marketCooldown > 0
    ? `Market data rate limit · retrying in ${props.marketCooldown}s…`
    : props.instruments.length ? "Loading live ATM curve…" : "Loading listed options…");
const preview = computed(() => {
  if (!market.value) return { error: "Waiting for live spot, ATM IVs and listed options." };
  try {
    const legs = resolvePosition(positionLegs.value, market.value.instruments, curveTime.value);
    const maturities = legs.map(leg => leg.maturity);
    const lastMaturity = Math.max(...maturities);
    const horizon = Math.min(settings.value.holdingDays * 86400, lastMaturity);
    const valuations = entryValuations(legs, nodeInputs.value, entrySpot.value);
    return { legs, horizon, lastMaturity, valuations, error: "" };
  } catch (e) {
    return { error: e.message };
  }
});
const holdingCapped = computed(() => preview.value.horizon < settings.value.holdingDays * 86400 - 1e-6);
const holdingLabel = computed(() => `${settings.value.holdingDays} ${settings.value.holdingDays === 1 ? 'day' : 'days'}` +
  (holdingCapped.value ? ` (ends at ${(preview.value.horizon / 86400).toFixed(2)} days, last option expiry)` : ''));
watch([() => preview.value.horizon, () => preview.value.lastMaturity], () => { tradeWindow.value = null; });
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
    // Freeze one usable snapshot per refresh; background quotes must not keep
    // replacing the path or restarting the simulation.
    if (curveReady.value && (!market.value || market.value.asOf !== props.asOf)) useLive();
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
      tradeWindow: tradeWindow.value ? [...tradeWindow.value] : null,
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
    const next = simulatePosition(config);
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
  const columns = [
    "elapsedSeconds",
    "spot",
    "optionPnl",
    "hedgePnl",
    "totalPnl",
    "executionCosts",
  ];
  const csv = [
    columns.join(","),
    ...data.rows.map((row) =>
      [row.elapsed, row.spot, row.optionPnl - row.optionFees,
        row.hedgePnl - row.hedgeFees, row.pnl, row.fees].join(","),
    ),
  ].join("\n");
  const url = URL.createObjectURL(
    new Blob([csv], { type: "text/csv;charset=utf-8" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `${data.config.asset}-position.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
</script>

<template>
  <section class="simulator" aria-label="Delta-hedged option position simulator">
    <form
      ref="form"
      class="settings-workspace sim-workspace"
      @submit.prevent="newPaths()"
    >
      <div class="sim-layout">
        <div v-if="market" class="sim-position-builder">
          <PositionBuilder
            v-model:legs="positionLegs"
            title=""
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
          <div class="field sim-rv-control sim-horizon-control">
            <label for="sim-horizon">Holding horizon</label>
            <input id="sim-horizon" v-model.number="holdingStep" type="range" min="0" :max="holdingPresets.length - 1" step="1"
              aria-label="Holding horizon" :aria-valuetext="holdingLabel" :title="holdingLabel" />
            <output for="sim-horizon" :title="holdingLabel">{{ settings.holdingDays }}d<span v-if="holdingCapped"> · expiry</span></output>
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
            :title="running ? 'Simulating…' : 'Generate a new simulation'"
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
            <SettingsSidePanel target="#term-sim-settings-dock" title="Hedge settings">
              <template #header-actions>
                <DeltaHedgeToggle :model-value="settings.hedge.enabled" @update:model-value="settings.hedge = { ...settings.hedge, enabled: $event }" />
              </template>
              <p class="sim-settings-intro">
                Changes update the simulation automatically.
              </p>
              <DeltaHedgeControls v-model="settings.hedge" :asset="asset" :observation-seconds="60" :show-toggle="false">
                <MarketAssumptions v-model="marketSettings" :asset="asset" :forward-available="!!market" :show-forward-ratio="false" />
                <div class="sim-settings-panel">
                  <label
                    >Option cost · bps / leg<input
                      v-model.number="settings.optionBps"
                      type="number"
                      min="0"
                      step="any"
                      required
                  /></label>
                  <p class="sim-wide">
                    The holding horizon limits the path, ending at the last expiry if sooner.
                    Drag on the index chart to select entry and exit. Unexpired legs close
                    at model marks; earlier expiries cash-settle. Double-click to reset.
                  </p>
                </div>
              </DeltaHedgeControls>
            </SettingsSidePanel>
          </div>
        </div>
        <div class="sim-main">
          <p v-if="error" class="sim-status sim-error" role="alert">{{ error }}</p>
          <p v-else-if="preview.error && market" class="sim-status" role="status">
            {{ preview.error }}
          </p>
          <p v-if="dirty && !error && !preview.error" class="sim-status sim-pending" role="status">
            Updating simulation…
          </p>
          <div class="sim-results" :aria-busy="running || (!market && marketLoading)">
            <SimulationChart v-if="result" :result="result" @update:trade-window="tradeWindow = $event" @export="download" />
            <div v-else-if="!error && !(preview.error && market)" class="sim-empty" role="status" aria-live="polite">
              <template v-if="market || marketLoading">
                <span>{{ loadingLabel }}</span>
                <progress
                  class="sim-load-progress"
                  :aria-label="market ? 'Simulation preparation' : 'Live quote collection'"
                  :value="!market && marketProgress.total ? marketProgress.checked : undefined"
                  :max="marketProgress.total || 1"
                ></progress>
                <small v-if="!market && curveCoverage.total">
                  {{ curveCoverage.ready }} / {{ curveCoverage.total }} ATM expiries ready
                  <template v-if="marketProgress.total"> · {{ marketProgress.checked }} / {{ marketProgress.total }} quotes checked</template>
                </small>
                <small v-if="!market">Simulation starts as soon as the ATM curve is ready.</small>
              </template>
              <template v-else>
                <span>{{ marketError || 'Live market data unavailable.' }} Use Refresh above to retry.</span>
              </template>
            </div>
          </div>

          <footer class="sim-footer">
            <details class="sim-method">
              <summary>Model assumptions</summary>
              <p v-if="market" class="sim-snapshot">Live ATM marks · {{ timestamp(curveTime) }}</p>
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
                Hedges fill at the simulated spot and are checked every minute. Option and hedge P&L each include their own execution costs,
                as selected in hedge settings. Settings changes reuse the same random
                price path; Refresh simulation generates a new path.
                The holding horizon limits the path to the selected number of days or the last
                option expiry, whichever comes first. Dragging the index chart selects the trade window on that same path,
                with a fresh option valuation and hedge ledger at entry.
                Bars sample cumulative total P&L since entry; they do not sum observations.
                Inspection and CSV retain every trade observation.
              </p>
            </details>
          </footer>
        </div>
      </div>
      <div id="term-sim-settings-dock" class="settings-dock"></div>
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
  padding: 0;
  font-size: 12px;
  background: #000;
}
.sim-workspace {
  --settings-panel-width: 34vw;
}
.sim-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-template-areas: "builder" "divider" "toolbar" "main";
  grid-template-rows: auto auto auto 1fr;
  padding: 18px 28px 24px;
  align-items: start;
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
  padding-top: 20px;
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
.sim-hedge-actions { display: inline-flex; align-items: center; gap: 4px; }

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
.sim-horizon-control { min-width: 0; max-width: 100%; }
.sim-horizon-control label { white-space: nowrap; }
.sim-horizon-control input { min-width: 40px; }
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
  flex-direction: column;
  gap: 12px;
  align-items: center;
  justify-content: center;
  padding: 24px 0;
  color: var(--color-text-muted);
  font-size: 12px;
  background: #000;
}
.sim-empty small {
  font-size: 11px;
  text-align: center;
}
.sim-load-progress {
  width: min(320px, 100%);
  height: 5px;
  border: 0;
  border-radius: 3px;
  overflow: hidden;
  accent-color: #00bf8c;
  background: var(--color-border);
}
.sim-load-progress::-webkit-progress-bar { background: var(--color-border); }
.sim-load-progress::-webkit-progress-value { background: #00bf8c; }
.sim-load-progress::-moz-progress-bar { background: #00bf8c; }
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
@media (max-width: 760px) {
  .sim-layout {
    padding: 16px;
  }
}
</style>
