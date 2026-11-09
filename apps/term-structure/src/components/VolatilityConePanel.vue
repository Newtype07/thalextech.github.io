<script setup>
import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import StyledSelectMenu from "../../../../lib/components/StyledSelectMenu.vue";
import { buildVolatilityCone, CONE_LOOKBACKS } from "../volatility-cone.js";
import { loadVolatilityConeData } from "../volatility-cone-data.js";

const props = defineProps({ asset: String, current: { type: Array, default: () => [] }, asOf: Number });
const lookback = ref("1y"), data = shallowRef(null), loading = ref(false), error = ref("");
const historyAsOf = ref(Date.now() / 1000);
let controller;
async function load() {
  controller?.abort();
  const request = new AbortController();
  controller = request;
  historyAsOf.value = Date.now() / 1000;
  data.value = null;
  loading.value = true;
  error.value = "";
  try {
    const result = await loadVolatilityConeData(props.asset, { signal: request.signal });
    if (!request.signal.aborted) data.value = result;
  } catch (e) {
    if (!request.signal.aborted) error.value = e.message || String(e);
  } finally {
    if (!request.signal.aborted) loading.value = false;
  }
}
watch(() => props.asset, load, { immediate: true });
onBeforeUnmount(() => controller?.abort());
const cone = computed(() => buildVolatilityCone({ data: data.value, current: props.current, asOf: props.asOf ?? historyAsOf.value, lookback: lookback.value }));
const vol = value => value == null ? "Unavailable" : `${(value * 100).toFixed(2)}%`;
const range = sample => sample.count ? `${vol(sample.min)} – ${vol(sample.max)}` : "Unavailable";
const date = ts => ts == null ? "Unavailable" : new Date(ts * 1000).toISOString().replace("T", " ").replace(":00.000Z", " UTC");
</script>

<template>
  <section class="expiryDetails" aria-label="Volatility cone" :aria-busy="loading">
    <div class="controls">
      <div class="field">
        <label for="cone-lookback">Lookback</label>
        <StyledSelectMenu id="cone-lookback" v-model="lookback" label="Cone lookback" :options="CONE_LOOKBACKS" />
      </div>
      <button v-if="error" class="saveButton" type="button" @click="load">Retry history</button>
    </div>
    <p v-if="loading" role="status">Loading Parquet volatility history…</p>
    <p v-else-if="error" role="alert">{{ error }}</p>
    <template v-else-if="data">
      <p>ATM live marks · {{ cone.window.stepSeconds === 3600 ? 'hourly' : 'daily' }} historical closes · Parquet IV through {{ date(data.sourceThrough.marks) }} · RV through {{ date(data.sourceThrough.index) }}</p>
      <p>Historical samples: {{ date(cone.window.from) }} (exclusive) – {{ date(cone.window.to) }}.</p>
      <div class="table-scroll">
        <table>
          <thead><tr><th>TENOR</th><th>CURRENT IV</th><th>LATEST RV</th><th>HISTORICAL IV RANGE</th><th>IV MEDIAN</th><th>IV SAMPLES</th><th>HISTORICAL RV RANGE</th><th>RV MEDIAN</th><th>RV SAMPLES</th></tr></thead>
          <tbody>
            <tr v-for="p in cone.points" :key="p.tenorDays">
              <td>{{ p.tenorDays }}D</td><td>{{ vol(p.currentIv?.iv) }}</td><td>{{ vol(p.currentRealized?.iv) }}</td>
              <td>{{ range(p.implied) }}</td><td>{{ vol(p.implied.median) }}</td><td>{{ p.implied.count }}/{{ p.implied.expectedCount }}</td>
              <td>{{ range(p.realized) }}</td><td>{{ vol(p.realized.median) }}</td><td>{{ p.realized.count }}/{{ p.realized.expectedCount }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </section>
</template>
