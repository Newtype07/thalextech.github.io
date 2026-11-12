<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import CandleChart from './CandleChart.vue';
import StyledSelectMenu from '../../../lib/components/StyledSelectMenu.vue';
import { mergePriceHistory } from './price-history.js';
import { loadMarket, loadPremiums } from './market-data.js';
import { rankOptions, optionSide, historicalFrequency, verdict } from './target-trade.js';
const target=ref(''),expiry=ref(''),market=ref(null),candles=ref([]),quotes=ref([]),excluded=ref(0);
const activeCandle = ref(null);
const chartCandles = computed(() => activeCandle.value ? [...candles.value, activeCandle.value] : candles.value);
const busy=ref(false),error=ref(''),historyError=ref(''),progress=ref(''),snapshot=ref(0),clock=ref(Date.now()/1000);
let controller, timer;
let initialized = false;
let requestedExpiry = 0, lastRefreshAttempt = 0;
const expiries=computed(()=>[...new Set(market.value?.options.map(c=>c.expiry)||[])].filter(t=>t>clock.value).sort((a,b)=>a-b));
const validTarget=computed(()=>Number.isFinite(Number(target.value))&&Number(target.value)>0);
const validExpiry=computed(()=>Number(expiry.value)>clock.value);
const stale=computed(()=>clock.value-snapshot.value>120);
const side = computed(() => optionSide(Number(target.value), market.value?.spot) || 'call');
const ranked=computed(()=>rankOptions(quotes.value.filter(option => option.expiry === Number(expiry.value) && clock.value - option.ts <= 120),Number(target.value),market.value?.spot));
const trade=computed(()=>!stale.value&&validExpiry.value?ranked.value[0]:null);
const move=computed(()=>market.value&&validTarget.value?Number(target.value)/market.value.spot-1:null);
const history=computed(()=>move.value!=null&&validExpiry.value?historicalFrequency(candles.value,move.value,Number(expiry.value)-snapshot.value):null);
const signal=computed(()=>verdict(trade.value,history.value));
const money=v=>Number.isFinite(v)?new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0}).format(v):'—';
const pct=v=>Number.isFinite(v)?`${(v*100).toFixed(1)}%`:'—';
const date=ts=>new Date(ts*1000).toLocaleString('en-GB',{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',timeZone:'UTC'});
const unavailableReason = computed(() => {
  if (busy.value) return progress.value || 'Loading market…';
  if (stale.value && snapshot.value) return 'Quotes expired · reconnecting';
  if (!validExpiry.value) return 'Choose a future expiry';
  const currentOptions = quotes.value.filter(option => option.expiry === Number(expiry.value) && option.side === side.value);
  if (!currentOptions.length) return `No executable ${side.value} asks`;
  const strikes = currentOptions.map(option => option.strike);
  if (side.value === 'call' && Number(target.value) <= Math.min(...strikes))
    return `Target must be above ${money(Math.min(...strikes))} for a call payout`;
  if (side.value === 'put' && Number(target.value) >= Math.max(...strikes))
    return `Target must be below ${money(Math.max(...strikes))} for a put payout`;
  return `No fresh executable ${side.value} asks`;
});
async function refresh() {
  controller?.abort();
  const current = controller = new AbortController();
  requestedExpiry = Number(expiry.value);
  lastRefreshAttempt = Date.now() / 1000;
  busy.value = true;
  error.value = '';
  progress.value = 'Loading market…';
  try {
    const result = await loadMarket(current.signal, { from: candles.value.at(-1)?.[0] });
    const fetchedAt = result.asOf ?? Date.now() / 1000;
    const available = [...new Set(result.options.map(call => call.expiry))].sort((a,b) => a-b);
    const selected = requestedExpiry = available.includes(Number(expiry.value))
      ? Number(expiry.value)
      : available.find(time => time - fetchedAt >= 7 * 86400) || available[0] || 0;
    const premiums = await loadPremiums(result.options.filter(call => call.expiry === selected),
      current.signal, (done, total) => {
        if (!current.signal.aborted) progress.value = `Pricing options · ${done}/${total}`;
      });
    if (current.signal.aborted) return;
    if (!premiums.quotes.length && selected === Number(expiry.value) && quotes.value.length)
      throw new Error('Could not refresh executable asks. Retrying automatically.');
    // Commit spot and the entire expiry chain together. Existing fresh quotes
    // remain usable while their replacement is in flight.
    const prices = mergePriceHistory(candles.value, result.hourly ?? [], result.minutes ?? [], result.spot, fetchedAt);
    candles.value = prices.completed;
    activeCandle.value = prices.active;
    market.value = result;
    historyError.value = '';
    snapshot.value = fetchedAt;
    clock.value = Date.now() / 1000;
    quotes.value = premiums.quotes;
    excluded.value = premiums.excluded;
    expiry.value = selected ? String(selected) : '';
    if (!target.value) target.value = String(Math.round(result.spot * 1.1 / 1000) * 1000);
    if (!premiums.quotes.length) error.value = 'No fresh, executable option asks for this expiry. Try another expiry.';
  } catch (error_) {
    if (!current.signal.aborted) error.value = error_.message;
  } finally {
    if (!current.signal.aborted) busy.value = false;
  }
}
watch(expiry, value => {
  if (value && Number(value) !== requestedExpiry) refresh();
});
function tick() {
  clock.value = Date.now() / 1000;
  if (initialized && !busy.value && clock.value - snapshot.value >= 60 && clock.value - lastRefreshAttempt >= 30)
    refresh();
}
function resume() {
  if (document.visibilityState === 'visible') tick();
}
onMounted(() => {
  fetch(`${import.meta.env.BASE_URL}history/btc.json`)
    .then(response => {
      if (!response.ok) throw new Error('BTC history could not be loaded.');
      return response.json();
    })
    .then(data => {
      if (!Array.isArray(data.candles) || !data.candles.length) throw new Error('No observed BTC history.');
      candles.value = data.candles;
    }).catch(error_ => historyError.value = error_.message).finally(() => { initialized = true; refresh(); });
  timer = setInterval(tick, 1000);
  document.addEventListener('visibilitychange', resume);
});
onUnmounted(() => {
  controller?.abort();
  clearInterval(timer);
  document.removeEventListener('visibilitychange', resume);
});
</script>
<template>
<main class="app">
  <header class="header"><div class="title-row"><div class="identity"><a href="/" aria-label="Thalex apps">THALEX</a><span class="divider">/</span><h1>Target</h1></div><div class="status muted">{{busy?'Connecting to Thalex…':snapshot?`Snapshot ${date(snapshot)} UTC`:'BTCUSD'}} <button class="refresh" :disabled="busy" @click="refresh">Refresh ↻</button></div></div>

  </header>
  <p v-if="error||historyError" class="error" role="alert">{{error||historyError}}</p>
  <p v-if="stale&&snapshot&&!busy" class="notice" role="status">Quotes expired. Reconnecting automatically; you can also retry with Refresh.</p>
  <p v-if="!validTarget&&!busy" class="notice">Drag the target line to set your level.</p>
  <p v-if="snapshot&&!validExpiry&&!busy" class="notice">Select a future listed expiry.</p>
  <section class="results" aria-label="Target trade result" aria-live="polite">
    <div class="metric"><span class="metric-label">Best {{side}} strike</span><strong>{{money(trade?.strike)}}</strong><span class="muted detail">{{trade?`Buy ${trade.side} · ask ${money(trade.premium)}`:unavailableReason}}</span></div>
    <div class="metric"><span class="metric-label">Payout multiple</span><strong>{{trade?`${trade.multiple.toFixed(2)}×`:'—'}}</strong><span class="muted detail">{{trade?`${money(trade.payout)} payout / ${money(trade.premium)} premium`:side==='put'?'(Strike − target) / premium':'(Target − strike) / premium'}}</span></div>
    <div class="metric"><span class="metric-label">Required hit rate</span><strong>{{pct(trade?.required)}}</strong><span class="muted detail">1 / payout multiple</span></div>
    <div class="metric"><span class="metric-label">Historical frequency</span><strong>{{pct(history?.frequency)}}</strong><span class="muted detail">{{history?.total?`${history.hits.toLocaleString()} / ${history.total.toLocaleString()} windows`:'Insufficient history'}}</span></div>
    <div class="metric verdict"><span class="metric-label">Rule verdict</span><strong :class="{buy:signal==='BUY',pass:signal==='PASS'}">{{signal==='UNAVAILABLE'?'—':signal}}</strong><span class="muted detail">{{signal==='BUY'?'Frequency > required hit rate':signal==='PASS'?'Frequency ≤ required hit rate':'Waiting for valid inputs & data'}}</span></div>
  </section>
  <CandleChart @update:target="target = $event" :candles="chartCandles" :spot="market?.spot" :target="validTarget?Number(target):undefined" :expiry="validExpiry?Number(expiry):undefined" :strike="trade?.strike" :now="snapshot||clock">
    <template #controls><div class="chart-controls"><div class="toolbar-select"><StyledSelectMenu v-if="expiries.length" id="expiry" v-model="expiry" label="Expiry" :options="expiries.map(t => ({value: String(t), label: `${date(t)} UTC`}))"/><span v-else class="muted">{{busy ? 'Loading…' : 'No available expiries'}}</span></div><span v-if="move!=null" class="view-summary">{{move>=0?'+':''}}{{pct(move)}} <span class="muted">from {{money(market.spot)}}</span></span></div></template>
  </CandleChart>
  <section class="explanation"><div><h2>The comparison</h2><p v-if="history?.total&&trade">BTC {{move>=0?'rose':'fell'}} {{pct(Math.abs(move))}} or more in <b>{{pct(history.frequency)}}</b> of observed {{history.hours}}-hour windows. This {{side}} needs <b>{{pct(trade.required)}}</b> under your target-payout rule.</p><p v-else>Drag the target line and choose an expiry. Every available {{side}} at that expiry is ranked by its payout at your target, divided by its ask premium.</p><p class="muted">Gross payout multiple, before fees. Net return at the target is multiple − 1.</p></div><div><h2>History & method</h2><p class="muted">{{history?`Horizon rounded to the nearest hour (${history.hours}h). `:''}}Rolling hourly close-to-close returns; overlapping windows, excluding gaps. The check measures ending beyond the target move, not touching it during the window.</p><p class="muted" v-if="candles.length">{{date(candles[0][0])}} – {{date(candles.at(-1)[0]+3600)}} UTC · tracked Thalex BTCUSD history.</p><p class="muted">{{quotes.length}} executable asks<span v-if="excluded"> · {{excluded}} unavailable or stale quotes excluded</span>. This is your rule’s signal, not a full expected-value model: other expiry outcomes and costs are not priced into the verdict.</p></div></section>
  <details v-if="ranked.length&&!stale&&validExpiry"><summary>Compare {{ranked.length}} eligible strikes</summary><div class="table-scroll"><table><thead><tr><th>{{side==='put'?'Put':'Call'}} strike</th><th>Ask premium</th><th>Payout at target</th><th>Multiple</th><th>Required hit rate</th></tr></thead><tbody><tr v-for="(c,i) in ranked" :key="c.name" :class="{selected:i===0}"><td>{{money(c.strike)}} <span class="muted">{{i===0?'· best':''}}</span></td><td>{{money(c.premium)}}</td><td>{{money(c.payout)}}</td><td>{{c.multiple.toFixed(2)}}×</td><td>{{pct(c.required)}}</td></tr></tbody></table></div></details>
</main>
</template>
