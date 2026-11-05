<script setup>
import { computed, getCurrentInstance } from "vue";
import DeltaHedgeToggle from "./DeltaHedgeToggle.vue";
import { DEFAULT_HEDGE_POLICY, normalizeHedgePolicy } from "../delta-hedging/index.js";
const props = defineProps({
  modelValue: { type: Object, required: true },
  asset: { type: String, default: "BTC" },
  observationSeconds: { type: Number, default: 60 },
  showToggle: { type: Boolean, default: true },
});
const emit = defineEmits(["update:modelValue"]);
const controlId = `hedge-${getCurrentInstance().uid}`;
// Interactive apps use one policy. Legacy scenario timing fields are hidden.
const policy = computed(() => ({ ...DEFAULT_HEDGE_POLICY, ...props.modelValue, timing: "timer", entry: "neutralize" }));
const bandMax = computed(() => Math.max(props.asset === "ETH" ? 10 : 1, policy.value.threshold, policy.value.tolerance));
// Equal slider stops give short waiting periods as much room as long ones.
const periodPresets = [5, 10, 15, 30, 60, 120, 180, 240, 360, 480, 720, 1440].map(minutes => minutes * 60);
const periodStep = computed(() => periodPresets.reduce((closest, seconds, index) =>
  Math.abs(seconds - policy.value.period) < Math.abs(periodPresets[closest] - policy.value.period) ? index : closest, 0));
const periodUnit = computed(() => policy.value.period < 3600 ? "minutes" : "hours");
const periodValue = computed(() => policy.value.period / (periodUnit.value === "minutes" ? 60 : 3600));
const periodText = computed(() => `${periodValue.value} ${periodValue.value === 1 ? periodUnit.value.slice(0, -1) : periodUnit.value}`);
const error = computed(() => {
  try { normalizeHedgePolicy(policy.value); return ""; } catch (e) { return e.message; }
});
const interval = computed(() => props.observationSeconds < 60
  ? `${props.observationSeconds.toFixed(1)} seconds` : `${(props.observationSeconds / 60).toFixed(1).replace(/\.0$/, "")} ${props.observationSeconds === 60 ? "minute" : "minutes"}`);
function update(key, value) { emit("update:modelValue", { ...policy.value, [key]: value }); }
</script>

<template>
  <section class="delta-hedge-controls" aria-label="Delta hedge controls">
    <DeltaHedgeToggle v-if="showToggle" class="hedge-toggle" :model-value="policy.enabled"
      @update:model-value="update('enabled', $event)" />
    <fieldset :disabled="!policy.enabled">
      <div class="hedge-fields">
        <label class="hedge-wide hedge-slider"><span>Threshold · {{ asset }}<output>{{ policy.threshold.toFixed(2) }}</output></span><input :aria-label="`Threshold · ${asset}`" :value="Math.round(policy.threshold * 100)" data-value-scale="100" type="range" min="0" :max="Math.ceil(bandMax * 100)" step="1" :aria-valuetext="`${policy.threshold.toFixed(2)} ${asset}`" required
          @input="update('threshold', Number($event.target.value) / 100)" /></label>
        <label class="hedge-wide hedge-slider"><span>Tolerance · {{ asset }}<output>{{ policy.tolerance === 0 ? 'Off' : policy.tolerance.toFixed(2) }}</output></span><input :aria-label="`Tolerance · ${asset}`" :value="Math.round(policy.tolerance * 100)" data-value-scale="100" type="range" min="0" :max="Math.ceil(bandMax * 100)" step="1" :aria-valuetext="policy.tolerance === 0 ? 'Disabled' : `${policy.tolerance.toFixed(2)} ${asset}`" required
          @input="update('tolerance', Number($event.target.value) / 100)" /></label>
        <label class="hedge-wide hedge-slider"><span>Period · {{ periodUnit }}<output>{{ periodValue }}</output></span><input :aria-label="`Period · ${periodUnit}`" :value="periodStep" type="range" min="0" :max="periodPresets.length - 1" step="1" :aria-valuetext="periodText" required
          @input="update('period', periodPresets[Number($event.target.value)])" /></label>
        <label>Hedge execution cost · bps<input :value="policy.hedgeBps" type="number" min="0" step="any" required
          @input="update('hedgeBps', $event.target.value === '' ? NaN : Number($event.target.value))" /></label>
        <fieldset class="hedge-wide hedge-choices">
          <legend>At exit</legend>
          <label><input type="radio" :name="`${controlId}-exit`" value="unwind" :checked="policy.exit === 'unwind'" @change="update('exit', 'unwind')" />Unwind the hedge</label>
          <label><input type="radio" :name="`${controlId}-exit`" value="hold" :checked="policy.exit === 'hold'" @change="update('exit', 'hold')" />Leave marked to market</label>
        </fieldset>
      </div>
      <p class="hedge-explanation"><strong>Threshold</strong> is the allowed band around target delta (zero here).
        Net delta includes both the options and the existing hedge, measured in {{ asset }}.
        A period-triggered hedge fires only after net delta stays outside ±{{ policy.threshold.toFixed(2) }} {{ asset }} for
        {{ periodText }}. Returning inside resets the timer.</p>
      <p><strong>Tolerance</strong> is the maximum deviation from target delta, independent of the period.
        <template v-if="policy.tolerance > 0">Exceeding ±{{ policy.tolerance.toFixed(2) }} {{ asset }} triggers a hedge at the next observation, without waiting for the timer.</template>
        <template v-else>The tolerance override is off.</template>
        Each hedge brings net delta back to zero.</p>
      <p class="hedge-cost-explanation"><strong>Execution cost</strong> is your assumed charge per hedge fill, as bps of traded notional.
        Use it for fees plus spread/slippage. It is deducted from hedge trading P&amp;L; it is not a quoted exchange fee.
        Costs apply to entry, rebalances and any exit unwind.</p>
    </fieldset>
    <p class="hedge-observation">Entry is neutralized immediately. Hedge rules are checked every {{ interval }}.</p>
    <p class="hedge-source">Definitions follow the <a href="https://thalex.com/docs/#tag/bot_strategies/Delta-Hedger" target="_blank" rel="noopener">Thalex Delta Hedger API</a>.</p>
    <p v-if="policy.enabled && policy.period > 0 && observationSeconds > policy.period" class="hedge-warning" role="status">
      Observations are coarser than the period; this data cannot resolve the requested waiting time.
    </p>
    <p v-if="error" class="hedge-error" role="alert">{{ error }}</p>
    <slot />
  </section>
</template>

<style scoped>
.delta-hedge-controls { color: var(--color-text, #eee); font-size: 12px; min-width: 0; }
.hedge-toggle { margin-bottom: 16px; }
fieldset { border: 0; margin: 0; padding: 0; min-width: 0; }
fieldset:disabled { opacity: .45; }
.hedge-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.hedge-fields label { display: flex; flex-direction: column; gap: 7px; color: var(--color-text-muted, #aaa); }
.hedge-fields input, .hedge-fields select { box-sizing: border-box; width: 100%; min-width: 0; height: 34px; padding: 6px 8px;
  border: 1px solid var(--color-border, #333); border-radius: 4px; color: var(--color-text, #eee); background: var(--color-bg, #111); font: inherit; }
.hedge-fields input:focus, .hedge-fields select:focus { outline: 1px solid #999; outline-offset: 2px; }
.hedge-slider > span { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.hedge-slider output { color: var(--color-text, #eee); font-variant-numeric: tabular-nums; }
.hedge-fields input[type="range"] { appearance: none; height: 24px; padding: 0; border: 0; background: transparent; cursor: pointer; }
.hedge-fields input[type="range"]::-webkit-slider-runnable-track { height: 4px; border-radius: 4px; background: #4b4b50; }
.hedge-fields input[type="range"]::-webkit-slider-thumb { appearance: none; width: 14px; height: 14px; margin-top: -5px; border: 0; border-radius: 50%; background: #ddd; }
.hedge-fields input[type="range"]::-moz-range-track { height: 4px; border-radius: 4px; background: #4b4b50; }
.hedge-fields input[type="range"]::-moz-range-thumb { width: 14px; height: 14px; border: 0; border-radius: 50%; background: #ddd; }
.hedge-wide { grid-column: 1 / -1; }
.hedge-choices { display: flex; flex-direction: column; gap: 9px; }
.hedge-choices legend { color: var(--color-text-muted, #aaa); margin-bottom: 9px; }
.hedge-choices label { flex-direction: row; align-items: center; gap: 8px; color: var(--color-text, #ddd); cursor: pointer; }
.hedge-choices input { width: 14px; height: 14px; padding: 0; margin: 0; accent-color: #ddd; }
p { color: var(--color-text-muted, #999); font-size: 11px; line-height: 1.6; margin: 12px 0 0; }
strong { color: var(--color-text, #ddd); font-weight: 500; }
.hedge-source a { color: inherit; text-underline-offset: 2px; }
.hedge-warning { color: #e6be7c; }
.hedge-error { color: #ff8585; }
</style>
