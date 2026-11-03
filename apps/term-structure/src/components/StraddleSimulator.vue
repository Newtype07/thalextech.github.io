<script setup>
import { computed, ref, shallowRef, watch } from "vue";
import SimulationChart from "./SimulationChart.vue";
import { simulateStraddle } from "../simulation/straddle-simulation.js";
import { buildForwardCurve } from "../simulation/forward-curve.js";

const props = defineProps({
  asset: { type: String, required: true },
  liveCurve: { type: Array, default: () => [] },
  liveSpot: { type: Number, default: null },
  asOf: { type: Number, default: null },
  marketLoading: { type: Boolean, default: false },
});
const market = shallowRef(null);
const curveSource = "Live ATM marks";
const curveTime = computed(() => market.value?.asOf ?? null);
const entrySpot = computed(() => market.value?.spot ?? null);
const nodes = computed(() =>
  (market.value?.curve || []).map((point) => ({
    days: point.seconds / 86400,
    iv: point.iv * 100,
    strike: point.strike,
  })),
);
const settings = ref({
  side: "sell",
  maturityDays: null,
  rvPercent: 100,
  driftPercent: 0,
  threshold: 0.05,
  tolerance: 0.15,
  periodMinutes: 30,
  timing: "timer",
  stepMinutes: 5,
  hedgeBps: 1,
  optionBps: 1,
  seed: 42,
});
const result = shallowRef(null),
  error = ref(""),
  running = ref(false),
  runFingerprint = ref(""),
  form = ref(null);
const fingerprint = computed(() =>
  JSON.stringify({ settings: settings.value, market: market.value }),
);
const dirty = computed(
  () => result.value && fingerprint.value !== runFingerprint.value,
);
const entryStrike = computed(
  () =>
    nodes.value.find((node) => node.days === settings.value.maturityDays)
      ?.strike ?? null,
);
const nodeInputs = computed(() =>
  nodes.value.map((node) => ({
    seconds: node.days * 86400,
    iv: node.iv / 100,
  })),
);
const canCapture = computed(
  () =>
    !props.marketLoading &&
    props.liveSpot > 0 &&
    props.liveCurve.some((point) => point.strike > 0),
);
const preview = computed(() => {
  if (!market.value || !entryStrike.value)
    return {
      curve: null,
      error: "Waiting for live spot, IVs and a listed call/put pair.",
    };
  try {
    return {
      curve: buildForwardCurve(
        nodeInputs.value,
        settings.value.maturityDays * 86400,
      ),
      error: "",
    };
  } catch (e) {
    return { curve: null, error: e.message };
  }
});
const maturityOptions = computed(() =>
  nodes.value.filter((node) => node.strike > 0).sort((a, b) => a.days - b.days),
);
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
  const previousExpiry =
    curveTime.value == null
      ? null
      : curveTime.value + settings.value.maturityDays * 86400;
  market.value = {
    spot: props.liveSpot,
    asOf: props.asOf,
    curve: props.liveCurve.map((point) => ({ ...point })),
  };
  const retained = nodes.value.find(
    (node) =>
      node.strike > 0 &&
      Math.abs(curveTime.value + node.days * 86400 - previousExpiry) < 1,
  );
  const closest = [...maturityOptions.value].sort(
    (a, b) => Math.abs(a.days - 30) - Math.abs(b.days - 30),
  )[0];
  settings.value.maturityDays = (retained || closest).days;
  error.value = "";
}
watch(
  [
    () => props.liveCurve,
    () => props.liveSpot,
    () => props.asOf,
    () => props.marketLoading,
  ],
  () => {
    if (!market.value && canCapture.value) useLive();
  },
  { immediate: true },
);
async function run(newPath = false) {
  if (running.value) return;
  if (!form.value.reportValidity()) return;
  if (newPath)
    settings.value.seed = crypto.getRandomValues(new Uint32Array(1))[0];
  running.value = true;
  error.value = "";
  // Give the browser a paint before a longer single-path calculation.
  await new Promise((resolve) =>
    requestAnimationFrame(() => setTimeout(resolve, 0)),
  );
  try {
    const s = settings.value;
    const next = simulateStraddle({
      asset: props.asset,
      side: s.side,
      spot: entrySpot.value,
      strike: entryStrike.value,
      quantity: 1,
      maturity: s.maturityDays * 86400,
      horizon: s.maturityDays * 86400,
      rvMultiplier: s.rvPercent / 100,
      drift: s.driftPercent / 100,
      threshold: s.threshold,
      tolerance: s.tolerance,
      period: s.periodMinutes * 60,
      timing: s.timing,
      step: s.stepMinutes * 60,
      hedgeBps: s.hedgeBps,
      optionBps: s.optionBps,
      seed: s.seed,
      nodes: nodeInputs.value,
      curveSource,
      curveTime: curveTime.value,
    });
    result.value = next;
    runFingerprint.value = fingerprint.value;
  } catch (e) {
    error.value = e.message;
  } finally {
    running.value = false;
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
      [
        row.elapsed,
        row.spot,
        row.optionPnl - row.optionFees,
        row.hedgePnl - row.hedgeFees,
        row.pnl,
        row.fees,
      ].join(","),
    ),
  ].join("\n");
  const url = URL.createObjectURL(
    new Blob([csv], { type: "text/csv;charset=utf-8" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `${data.config.asset}-straddle-seed-${data.config.seed}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
</script>

<template>
  <section class="simulator" aria-label="Delta-hedged straddle simulator">
    <form ref="form" class="sim-toolbar" @submit.prevent="run(false)">
      <div
        class="underlyingToggle"
        role="group"
        aria-label="Straddle direction"
      >
        <button
          v-for="side in ['sell', 'buy']"
          :key="side"
          type="button"
          class="underlyingButton"
          :class="{ underlyingButtonActive: settings.side === side }"
          :aria-pressed="settings.side === side"
          @click="settings.side = side"
        >
          {{ side === "sell" ? "Sell straddle" : "Buy straddle" }}
        </button>
      </div>
      <div class="field">
        <label for="sim-maturity">Maturity</label>
        <select
          id="sim-maturity"
          v-model.number="settings.maturityDays"
          aria-label="Option maturity"
          :disabled="!market"
          required
        >
          <option v-if="!maturityOptions.length" :value="null">
            Waiting for market
          </option>
          <option
            v-for="(node, i) in maturityOptions"
            :key="i"
            :value="node.days"
          >
            {{ node.days.toFixed(2) }}d ·
            {{ timestamp(curveTime + node.days * 86400).split(",")[0] }}
          </option>
        </select>
      </div>
      <div class="field sim-rv-control">
        <label for="sim-rv-ratio">RV / forward IV</label>
        <input
          id="sim-rv-ratio"
          v-model.number="settings.rvPercent"
          type="range"
          min="50"
          max="200"
          step="1"
          aria-label="Realized / forward volatility"
        />
        <output for="sim-rv-ratio"
          >{{ (settings.rvPercent / 100).toFixed(2) }}×</output
        >
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
        :disabled="running || !!preview.error"
      >
        {{
          running
            ? "Simulating…"
            : result
              ? "Rerun same seed"
              : "Run simulation"
        }}
      </button>
      <button
        class="saveButton"
        type="button"
        :disabled="running || !!preview.error"
        @click="run(true)"
      >
        New path
      </button>
      <details
        class="sim-settings"
        @keydown.esc="$event.currentTarget.open = false"
      >
        <summary class="saveButton">Hedge settings</summary>
        <div class="sim-settings-panel">
          <label
            >Threshold · {{ asset
            }}<input
              v-model.number="settings.threshold"
              type="number"
              min="0"
              step="any"
              required
          /></label>
          <label
            >Tolerance · {{ asset
            }}<input
              v-model.number="settings.tolerance"
              type="number"
              min="0"
              step="any"
              required
          /></label>
          <label class="sim-wide"
            >Timer behaviour<select v-model="settings.timing">
              <option value="timer">
                Outside threshold for the full period
              </option>
              <option value="scheduled">Check on a fixed schedule</option>
            </select></label
          >
          <label
            >Period · minutes<input
              v-model.number="settings.periodMinutes"
              type="number"
              min="1"
              step="any"
              required
          /></label>
          <label
            >Path step · minutes<select v-model.number="settings.stepMinutes">
              <option :value="1">1 minute</option>
              <option :value="5">5 minutes</option>
              <option :value="15">15 minutes</option>
              <option :value="60">1 hour</option>
            </select></label
          >
          <label
            >Hedge cost · bps<input
              v-model.number="settings.hedgeBps"
              type="number"
              min="0"
              step="any"
              required
          /></label>
          <label
            >Option cost · bps / leg<input
              v-model.number="settings.optionBps"
              type="number"
              min="0"
              step="any"
              required
          /></label>
          <label class="sim-wide"
            >Path seed<input
              v-model.number="settings.seed"
              type="number"
              min="0"
              max="4294967295"
              step="1"
              required
          /></label>
          <p class="sim-wide">
            Target delta is zero. Tolerance overrides the timer at each path
            step; 0 disables it. Scheduled periods must be multiples of the path
            step.
          </p>
          <button
            v-if="canCapture"
            class="saveButton sim-wide"
            type="button"
            @click="useLive"
          >
            Update market snapshot
          </button>
        </div>
      </details>
    </form>
    <div class="sim-trade-facts">
      <span>1 {{ asset }} per leg</span
      ><span>Spot {{ entrySpot ? money(entrySpot) : "—" }}</span
      ><span>Strike {{ entryStrike ? money(entryStrike) : "—" }}</span
      ><span>Hold to expiry</span>
      <span class="sim-source" :title="curveTime ? timestamp(curveTime) : ''">{{
        market ? "Live ATM marks" : "Waiting for market"
      }}</span>
    </div>
    <p v-if="error" class="sim-status sim-error" role="alert">{{ error }}</p>
    <p v-else-if="preview.error && market" class="sim-status" role="status">
      {{ preview.error }}
    </p>
    <p v-if="dirty" class="sim-status sim-pending" role="status">
      Settings changed. Rerun to update performance.
    </p>
    <div class="sim-results" :aria-busy="running">
      <SimulationChart v-if="result" :result="result" />
      <div v-else class="sim-empty">
        {{
          market
            ? "Choose a maturity and run the simulation."
            : "Waiting for live market data. Use Refresh above to retry."
        }}
      </div>
    </div>
    <footer class="sim-footer">
      <details class="sim-method">
        <summary>Model assumptions</summary>
        <p>
          One fixed-strike straddle, priced with the captured ATM term structure
          and zero rates. Annual drift defaults to zero and is an editable
          percentage of expected price growth in the simulation model. Forward
          variance shapes the simulated price path; the RV / forward IV ratio
          scales its volatility. Option IV follows the variance remaining to
          expiry. The model excludes smile, funding, basis, margin and
          liquidation.
        </p>
        <p>
          Hedges fill at the simulated spot and are checked at the selected time
          step. Option and hedge P&L each include their own execution costs,
          including the initial hedge and final unwind. The same seed preserves
          the price path when only side, hedge settings or costs change.
        </p>
      </details>
      <button v-if="result" class="saveButton" type="button" @click="download">
        Export CSV
      </button>
    </footer>
  </section>
</template>

<style scoped>
.simulator {
  margin: 16px 36px 20px 28px;
  font-size: 12px;
}
.sim-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.sim-toolbar .underlyingToggle {
  height: 36px;
}
.sim-toolbar > .saveButton {
  height: 36px;
}
.field select {
  min-width: 115px;
  padding: 0;
  border: 0;
  background: var(--color-bg);
  color: var(--color-text);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.sim-rv-control {
  gap: 10px;
}
.sim-rv-control input {
  width: 120px;
  accent-color: #c3c8d0;
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
  color: var(--color-text);
}
.sim-settings {
  position: relative;
}
.sim-settings > summary {
  display: flex;
  align-items: center;
  height: 36px;
  font-weight: 400;
  list-style: none;
}
.sim-settings > summary::-webkit-details-marker {
  display: none;
}
.sim-settings[open] > summary {
  color: var(--color-text);
  border-color: var(--color-border-strong);
}
.sim-settings-panel {
  position: absolute;
  right: 0;
  top: 44px;
  z-index: 25;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  width: 330px;
  padding: 16px;
  background: var(--color-bg);
  border: 1px solid var(--color-border-strong);
  border-radius: 6px;
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
  font-size: 10px;
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
  color: #a9abb6;
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
  background: #08080a;
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
.sim-footer > button {
  flex-shrink: 0;
}
input:focus-visible,
select:focus-visible {
  outline: 1px solid #9299a4;
  outline-offset: 2px;
}
@media (max-width: 760px) {
  .simulator {
    margin: 16px;
  }
  .sim-source {
    margin-left: 0;
  }
  .sim-settings-panel {
    right: auto;
    left: 0;
    width: min(330px, calc(100vw - 32px));
  }
  .sim-empty {
    min-height: 350px;
  }
}
</style>
