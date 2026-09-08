<script setup>
import { computed, nextTick, onBeforeUnmount, ref } from "vue";

const props = defineProps({
  modelValue: { type: [String, Number], default: "" },
  label: { type: String, required: true },
  id: { type: String, required: true },
  options: { type: Array, default: () => [] },
});

const emit = defineEmits(["update:modelValue"]);

const open = ref(false);
const rootRef = ref(null);
const triggerRef = ref(null);
const menuRef = ref(null);
const menuStyle = ref({});

const selectedIndex = computed(() =>
  props.options.findIndex(
    (option) => String(option.value) === String(props.modelValue),
  ),
);

const selectedLabel = computed(
  () => props.options[selectedIndex.value]?.label ?? String(props.modelValue),
);

const updateMenuPosition = () => {
  const trigger = triggerRef.value;
  if (!trigger) return;
  const rect = trigger.getBoundingClientRect();
  const viewportPadding = 8;
  const width = Math.min(
    Math.max(rect.width, 140),
    window.innerWidth - viewportPadding * 2,
  );
  const left = Math.min(
    Math.max(viewportPadding, rect.left),
    window.innerWidth - width - viewportPadding,
  );
  menuStyle.value = {
    top: `${rect.bottom + 6}px`,
    left: `${left}px`,
    width: `${width}px`,
    maxHeight: `${Math.min(260, Math.max(100, window.innerHeight - rect.bottom - 16))}px`,
  };
};

const removeOverlayListeners = () => {
  window.removeEventListener("resize", updateMenuPosition);
  window.removeEventListener("scroll", updateMenuPosition, true);
  document.removeEventListener("pointerdown", handleDocumentPointerDown);
};

const close = () => {
  open.value = false;
  removeOverlayListeners();
};

const handleDocumentPointerDown = (event) => {
  const target = event.target;
  if (!(target instanceof Node)) return;
  if (rootRef.value?.contains(target) || menuRef.value?.contains(target)) return;
  close();
};

const addOverlayListeners = () => {
  window.addEventListener("resize", updateMenuPosition);
  window.addEventListener("scroll", updateMenuPosition, true);
  document.addEventListener("pointerdown", handleDocumentPointerDown);
};

const focusOption = async (index) => {
  if (!props.options.length) return;
  if (!open.value) {
    open.value = true;
    addOverlayListeners();
  }
  await nextTick();
  updateMenuPosition();
  const buttons = menuRef.value?.querySelectorAll('[role="option"]');
  const safeIndex = Math.max(0, Math.min(props.options.length - 1, index));
  const button = buttons?.[safeIndex];
  button?.focus({ preventScroll: true });
  button?.scrollIntoView({ block: "nearest" });
};

const openAtSelection = () => {
  void focusOption(Math.max(0, selectedIndex.value));
};

const selectOption = (option) => {
  emit("update:modelValue", option.value);
  close();
  triggerRef.value?.focus();
};

const handleFocusOut = (event) => {
  const nextTarget = event.relatedTarget;
  if (!(nextTarget instanceof Node)) {
    close();
    return;
  }
  if (
    !rootRef.value?.contains(nextTarget) &&
    !menuRef.value?.contains(nextTarget)
  ) {
    close();
  }
};

onBeforeUnmount(removeOverlayListeners);
</script>

<template>
  <div
    ref="rootRef"
    class="styledSelect"
    @focusout="handleFocusOut"
    @keydown.esc.stop.prevent="close(); triggerRef?.focus()"
  >
    <button
      :id="id"
      ref="triggerRef"
      class="styledSelectTrigger"
      type="button"
      aria-haspopup="listbox"
      :aria-label="label"
      :aria-expanded="open"
      :aria-controls="open ? `${id}-menu` : undefined"
      @click="open ? close() : openAtSelection()"
      @keydown.down.prevent="openAtSelection"
      @keydown.up.prevent="openAtSelection"
    >
      <span class="styledSelectValue">{{ selectedLabel }}</span>
      <span class="styledSelectChevron" aria-hidden="true"></span>
    </button>

    <Teleport to="body">
      <div
        v-if="open"
        :id="`${id}-menu`"
        ref="menuRef"
        class="styledSelectMenu"
        :style="menuStyle"
        role="listbox"
        :aria-label="label"
        @focusout="handleFocusOut"
        @keydown.esc.stop.prevent="close(); triggerRef?.focus()"
      >
        <button
          v-for="(option, index) in options"
          :key="String(option.value)"
          type="button"
          role="option"
          :aria-selected="index === selectedIndex"
          :class="{ active: index === selectedIndex }"
          @click="selectOption(option)"
          @keydown.down.prevent="focusOption((index + 1) % options.length)"
          @keydown.up.prevent="
            focusOption((index - 1 + options.length) % options.length)
          "
          @keydown.home.prevent="focusOption(0)"
          @keydown.end.prevent="focusOption(options.length - 1)"
        >
          <span>{{ option.label }}</span>
          <span
            v-if="index === selectedIndex"
            class="styledSelectCheck"
            aria-hidden="true"
          >✓</span>
        </button>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.styledSelect {
  min-width: 0;
}

.styledSelectTrigger {
  min-width: 0;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--color-text);
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
}

.styledSelectTrigger:focus-visible {
  outline: 1px solid rgba(255, 255, 255, 0.6);
  outline-offset: 3px;
  border-radius: 3px;
}

.styledSelectValue {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.styledSelectChevron {
  flex: none;
  width: 6px;
  height: 6px;
  margin-right: 2px;
  border-right: 1px solid currentColor;
  border-bottom: 1px solid currentColor;
  color: var(--color-text-muted);
  transform: translateY(-2px) rotate(45deg);
}

.styledSelectMenu {
  position: fixed;
  z-index: 1000;
  overflow-y: auto;
  padding: 4px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 6px;
  background: #14161a;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.42);
  color: #e8e8ea;
  font-family: "Helvetica Neue", Helvetica, -apple-system, sans-serif;
}

.styledSelectMenu button {
  width: 100%;
  min-height: 30px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 5px 9px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: #c9cbd1;
  font: inherit;
  font-size: 12px;
  text-align: left;
  white-space: nowrap;
  cursor: pointer;
}

.styledSelectMenu button:hover,
.styledSelectMenu button:focus-visible {
  background: rgba(255, 255, 255, 0.07);
  color: #fff;
  outline: none;
}

.styledSelectMenu button.active {
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
}

.styledSelectCheck {
  color: #fff;
}
</style>
