<script setup>
defineProps({ modelValue: { type: Boolean, required: true } });
const emit = defineEmits(["update:modelValue"]);
</script>

<template>
  <label class="delta-hedge-toggle">
    <input type="checkbox" role="switch" aria-label="Delta hedge" :checked="modelValue"
      :aria-checked="modelValue" @change="emit('update:modelValue', $event.target.checked)" />
    Delta hedge
  </label>
</template>

<style scoped>
.delta-hedge-toggle { display: inline-flex; align-items: center; gap: 8px; flex-shrink: 0;
  min-height: 34px; padding: 8px 0; color: #ddd; font: inherit; font-size: 12px; font-weight: 600;
  white-space: nowrap; cursor: pointer; }
.delta-hedge-toggle input { width: 14px; height: 14px; margin: 0; padding: 0; accent-color: #ddd; cursor: pointer; }
.delta-hedge-toggle input:focus-visible { outline: 2px solid #aaa; outline-offset: 2px; }
</style>
