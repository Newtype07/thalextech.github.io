<script setup>
import { computed, ref, watch, onBeforeUnmount } from "vue";
import { loadCalibrationProfile } from "../market-model/profiles.js";
const props = defineProps({ modelValue: { type: Object, required: true }, asset: { type: String, required: true },
  forwardAvailable: { type: Boolean, default: false }, showManual: { type: Boolean, default: true },
  manualDefaults: { type: Object, default: () => ({ volOfVol: .5, correlation: 0, jumpIntensity: 0, jumpMean: 0, jumpVol: 0 }) } });
const emit = defineEmits(["update:modelValue"]);
const loading = ref(false), message = ref(""), estimate = ref(null);
const settings = computed(() => props.modelValue);
const manual = computed(() => ({ ...props.manualDefaults, ...settings.value.manual }));
let controller;
function update(key, value) { emit("update:modelValue", { ...settings.value, [key]: value }); }
async function load() {
  controller?.abort(); controller = new AbortController(); const current = controller;
  loading.value = true; message.value = ""; estimate.value = null;
  try {
    const profile = await loadCalibrationProfile({ asset: props.asset, lookbackDays: settings.value.lookbackDays ?? 90, signal: current.signal });
    if (current.signal.aborted) return;
    estimate.value = profile;
    if (profile.status !== "ready") message.value = profile.message;
    // Estimates are applied explicitly, so a background response cannot overwrite an override.
  } catch (error) { if (!current.signal.aborted) message.value = error.message; }
  finally { if (current === controller) loading.value = false; }
}
function applyEstimate() {
  if (!estimate.value || estimate.value.status === "unavailable") return;
  emit("update:modelValue", { ...settings.value, profile: estimate.value,
    rv: estimate.value.rv, dynamics: estimate.value.status === "ready" ? settings.value.dynamics : "constant" });
}
watch([() => props.asset, () => settings.value.lookbackDays ?? 90], () => {
  if (settings.value.profile) update("profile", null);
  load();
}, { immediate: true });
onBeforeUnmount(() => controller?.abort());
const date = ts => new Date(ts * 1000).toISOString().slice(0, 10);
</script>

<template>
  <section class="market-assumptions" aria-label="Market assumptions">
    <h3>Market assumptions</h3>
    <div class="market-fields">
      <label>Volatility shape<select :value="settings.shape" @change="update('shape', $event.target.value)">
        <option value="flat">Flat RV</option><option value="forward" :disabled="!forwardAvailable">Live forward curve</option>
      </select></label>
      <label>Path dynamics<select :value="settings.dynamics" @change="update('dynamics', $event.target.value)">
        <option value="constant">Deterministic variance</option><option value="stochastic">Stochastic variance</option><option value="jumps">Stochastic variance + jumps</option>
      </select></label>
      <label v-if="settings.shape === 'flat'">Flat RV · %<input :value="settings.rv * 100" type="number" min="0" step="any" required
        @input="update('rv', $event.target.value === '' ? NaN : Number($event.target.value) / 100)" /></label>
      <label v-else>RV / forward IV<input :value="settings.rvMultiplier" type="number" min="0" step="any" required
        @input="update('rvMultiplier', $event.target.value === '' ? NaN : Number($event.target.value))" /></label>
      <label>Historical lookback<select :value="settings.lookbackDays ?? 90" @change="update('lookbackDays', Number($event.target.value))">
        <option v-for="days in [30, 90, 180, 365]" :key="days" :value="days">{{ days }} days</option>
      </select></label>
    </div>
    <p v-if="loading">Loading historical estimates…</p>
    <template v-if="estimate && estimate.status !== 'unavailable'">
      <p>{{ asset }} · {{ estimate.lookbackDays }} days through {{ date(estimate.asOf) }} · {{ (estimate.training.coverage * 100).toFixed(2) }}% coverage.</p>
      <p>RV {{ (estimate.rv * 100).toFixed(1) }}%<template v-if="estimate.variance"> · Realized correlation {{ estimate.variance.rho.toFixed(2) }} ·
        Vol of vol {{ estimate.variance.sigma.toFixed(2) }} · Jumps {{ estimate.jumps.intensity.toFixed(1) }}/year</template>.</p>
      <button type="button" @click="applyEstimate">Use historical estimates</button>
    </template>
    <p v-if="settings.profile">Using {{ settings.profile.lookbackDays }}-day realized calibration through {{ date(settings.profile.asOf) }}.
      <button type="button" @click="update('profile', null)">Use manual dynamics</button></p>
    <p v-else>Manual dynamics. Historical estimates are applied only when selected.</p>
    <div v-if="showManual && !settings.profile && settings.dynamics !== 'constant'" class="market-fields">
      <label>Vol of vol<input :value="manual.volOfVol" type="number" min="0" step="any"
        @input="update('manual', { ...manual, volOfVol: Number($event.target.value) })" /></label>
      <label>Realized correlation<input :value="manual.correlation" type="number" min="-1" max="1" step=".01"
        @input="update('manual', { ...manual, correlation: Number($event.target.value) })" /></label>
      <template v-if="settings.dynamics === 'jumps'">
        <label>Jumps / year<input :value="manual.jumpIntensity" type="number" min="0" step="any"
          @input="update('manual', { ...manual, jumpIntensity: Number($event.target.value) })" /></label>
        <label>Jump log mean<input :value="manual.jumpMean" type="number" step="any"
          @input="update('manual', { ...manual, jumpMean: Number($event.target.value) })" /></label>
        <label>Jump log std dev<input :value="manual.jumpVol" type="number" min="0" step="any"
          @input="update('manual', { ...manual, jumpVol: Number($event.target.value) })" /></label>
      </template>
    </div>
    <p v-if="message" class="market-message">{{ message }}</p>
    <p v-if="settings.dynamics === 'jumps'">Jump variance shares the RV budget with diffusion. Jump intensity is capped when it would use more than 35% of an interval's variance.</p>
    <p>Correlation uses realized return and variance shocks. The volatility shape sets when variance occurs; option IV follows the app's marking assumptions.</p>
    <slot />
  </section>
</template>

<style scoped>
.market-assumptions { color: #ddd; font-size: 12px; border-top: 1px solid #292929; padding-top: 14px; margin-top: 18px; }
h3 { font-size: 12px; font-weight: 600; margin: 0 0 12px; }
.market-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
label { display: flex; flex-direction: column; gap: 6px; color: #aaa; }
input, select, button { box-sizing: border-box; min-width: 0; color: #ddd; background: #111; border: 1px solid #333; border-radius: 4px; padding: 7px; font: inherit; }
button { cursor: pointer; } p { color: #999; line-height: 1.6; font-size: 11px; }
.market-message { color: #e6be7c; }
</style>
