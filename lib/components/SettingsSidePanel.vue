<script setup>
import { computed, ref, watch, nextTick, getCurrentInstance, onBeforeUnmount } from "vue";

const props = defineProps({
  title: { type: String, default: "Hedge settings" },
  target: { type: String, required: true },
});
const open = ref(false), trigger = ref(null), panel = ref(null);
const panelId = `settings-panel-${getCurrentInstance().uid}`;
const minPanelWidth = 280, minContentWidth = 320;
const resizedWidth = ref(null), actualWidth = ref(0), workspaceWidth = ref(0);
const resizeHandle = ref(null), drag = ref(null);
let restoreFocusOnClose = true;
const maxPanelWidth = computed(() => Math.max(minPanelWidth, workspaceWidth.value - minContentWidth));
function setWidth(width) {
  resizedWidth.value = Math.round(Math.max(minPanelWidth, Math.min(maxPanelWidth.value, width)));
  actualWidth.value = resizedWidth.value;
}
function syncSize() {
  workspaceWidth.value = panel.value?.parentElement?.parentElement?.getBoundingClientRect().width || window.innerWidth;
  if (window.innerWidth > 640 && resizedWidth.value !== null) setWidth(resizedWidth.value);
  actualWidth.value = panel.value?.getBoundingClientRect().width || resizedWidth.value || 0;
}
function startResize(event) {
  if (event.button !== 0 || event.isPrimary === false || window.innerWidth <= 640) return;
  event.preventDefault();
  syncSize();
  drag.value = { pointerId: event.pointerId, x: event.clientX, width: actualWidth.value };
  resizeHandle.value.setPointerCapture(event.pointerId);
  resizeHandle.value.focus({ preventScroll: true });
}
function moveResize(event) {
  if (!drag.value || event.pointerId !== drag.value.pointerId) return;
  setWidth(drag.value.width + drag.value.x - event.clientX);
}
function stopResize(event) {
  if (!drag.value || (event?.pointerId !== undefined && event.pointerId !== drag.value.pointerId)) return;
  const pointerId = drag.value.pointerId;
  drag.value = null;
  if (resizeHandle.value?.hasPointerCapture(pointerId)) resizeHandle.value.releasePointerCapture(pointerId);
}
function resizeWithKeyboard(event) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  syncSize();
  const step = event.shiftKey ? 50 : 20;
  setWidth(event.key === "Home" ? minPanelWidth : event.key === "End" ? maxPanelWidth.value
    : actualWidth.value + (event.key === "ArrowLeft" ? step : -step));
}
function close(restoreFocus = true) {
  restoreFocusOnClose = restoreFocus;
  open.value = false;
}
function onOutsideDoubleClick(event) {
  const path = event.composedPath();
  if (drag.value || path.includes(panel.value) || path.includes(trigger.value)) return;
  close(false);
}
function onKeydown(event) {
  if (event.key === "Escape") { event.preventDefault(); close(); return; }
}
watch(open, async value => {
  if (value) {
    restoreFocusOnClose = true;
    window.addEventListener("resize", syncSize);
    document.addEventListener("dblclick", onOutsideDoubleClick, true);
  } else {
    stopResize();
    window.removeEventListener("resize", syncSize);
    document.removeEventListener("dblclick", onOutsideDoubleClick, true);
  }
  await nextTick();
  if (value) {
    syncSize();
    panel.value?.querySelector('button[aria-label="Close settings"]')?.focus();
  } else if (restoreFocusOnClose) {
    trigger.value?.focus();
  }
});
onBeforeUnmount(() => {
  stopResize();
  window.removeEventListener("resize", syncSize);
  document.removeEventListener("dblclick", onOutsideDoubleClick, true);
});
</script>

<template>
  <button ref="trigger" type="button" class="settings-panel-trigger" :aria-label="`Configure ${title.toLowerCase()}`" :title="`${open ? 'Close' : 'Open'} ${title.toLowerCase()} side panel`" :aria-expanded="open" :aria-controls="panelId" @click="open = !open" @keydown="onKeydown">
    <span>Configure</span>
    <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
      <path d="m7.5 5 5 5-5 5" />
    </svg>
  </button>
  <Teleport v-if="open" :to="target">
      <aside :id="panelId" ref="panel" class="settings-side-panel" :class="{ 'is-resizing': !!drag }"
        :style="resizedWidth === null ? undefined : { '--resized-settings-panel-width': `${resizedWidth}px` }"
        :aria-labelledby="`${panelId}-title`" @keydown="onKeydown">
        <div ref="resizeHandle" class="settings-panel-resizer" role="separator" tabindex="0"
          aria-label="Resize hedge settings panel" aria-orientation="vertical" :aria-controls="panelId"
          :aria-valuemin="minPanelWidth" :aria-valuemax="maxPanelWidth" :aria-valuenow="Math.round(actualWidth)"
          @pointerdown="startResize" @pointermove="moveResize" @pointerup="stopResize" @pointercancel="stopResize"
          @lostpointercapture="stopResize" @keydown="resizeWithKeyboard"></div>
        <header>
          <h2 :id="`${panelId}-title`">{{ title }}</h2>
          <button type="button" class="settings-panel-close" aria-label="Close settings" @click="close()">×</button>
        </header>
        <div class="settings-panel-content"><slot /></div>
      </aside>
  </Teleport>
</template>

<style scoped>
.settings-panel-trigger { display: inline-flex; flex-shrink: 0; align-items: center; justify-content: center;
  gap: 7px; height: 30px; padding: 0 6px; border: 0;
  background: transparent; color: #ccc; cursor: pointer; font: inherit; font-size: 11px; }
.settings-panel-trigger:hover,
.settings-panel-trigger[aria-expanded="true"] { color: #fff; }
.settings-panel-trigger:focus-visible { outline: 2px solid #aaa; outline-offset: 2px; }
/* The host supplies a main content element and an empty dock as siblings. */
:global(.settings-workspace) { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; }
:global(.settings-workspace > :first-child) { min-width: 0; width: 100%; box-sizing: border-box; }
:global(.settings-dock) { position: sticky; top: 0; height: 100dvh; width: max-content;
  background: #141417; isolation: isolate; z-index: 2; }
:global(.settings-dock:not(:has(.settings-side-panel))) { display: none; }
.settings-side-panel { --color-bg: #141417; --color-text: #eee; --color-text-muted: #aaa; --color-border: #353539;
  position: relative; height: 100%; width: var(--resized-settings-panel-width, var(--settings-panel-width, clamp(320px, 30vw, 420px)));
  max-width: max(280px, calc(100vw - 320px)); box-sizing: border-box; color-scheme: dark;
  display: flex; flex-direction: column; border-left: 1px solid #353539; background: var(--color-bg); color: #eee;
  font-family: inherit; font-size: 12px; }
:global(.settings-workspace:has(.is-resizing)) { user-select: none; cursor: col-resize; }
.settings-panel-resizer { position: absolute; top: 0; bottom: 0; left: -5px; width: 10px; z-index: 3;
  cursor: col-resize; touch-action: none; user-select: none; outline: none; }
.settings-panel-resizer::before { content: ""; position: absolute; top: 0; bottom: 0; left: 4px; width: 2px; }
.settings-panel-resizer::after { content: ""; position: absolute; top: calc(50% - 18px); left: 4px;
  height: 36px; width: 3px; border-radius: 2px; background: #66666e; }
.settings-panel-resizer:hover::before, .settings-panel-resizer:focus-visible::before,
.is-resizing .settings-panel-resizer::before { background: #aaa; }
header { display: flex; flex-shrink: 0; align-items: center; justify-content: space-between; gap: 12px;
  padding: 19px 22px; border-bottom: 1px solid #303034; background: var(--color-bg); }
h2 { font-size: 14px; font-weight: 600; margin: 0; }
.settings-panel-close { background: transparent; border: 0; padding: 2px 7px; color: #aaa; font-size: 25px; line-height: 1; cursor: pointer; }
.settings-panel-close:hover { color: #fff; }
.settings-panel-content { flex: 1; overflow-y: auto; overscroll-behavior: contain; padding: 22px; min-height: 0; background: var(--color-bg); }
@media (max-width: 640px) {
  :global(.settings-workspace) { grid-template-columns: minmax(0, 1fr); }
  :global(.settings-dock) { grid-row: 1; position: static; width: 100%; height: min(70dvh, 720px); }
  .settings-side-panel { width: 100%; max-width: none; border-left: 0; border-bottom: 1px solid #353539; }
  .settings-panel-resizer { display: none; }
}
</style>
