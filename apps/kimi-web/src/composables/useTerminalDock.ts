// Bottom terminal dock layout state: open / height / maximized, persisted.

import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { safeGetString, safeSetString, STORAGE_KEYS } from '../lib/storage';
import { clampPanelWidth, panelMaxWidth } from './useViewportWidth';

const TERMINAL_HEIGHT_KEY = STORAGE_KEYS.terminalHeight;
const TERMINAL_OPEN_KEY = STORAGE_KEYS.terminalOpen;
const TERMINAL_DEFAULT = 240;
const TERMINAL_MIN = 140;
/** Keep at least this much room for the conversation when the dock is open. */
const CHAT_RESERVE = 180;

export function useTerminalDock() {
  const viewportHeight = ref(typeof window === 'undefined' ? 800 : window.innerHeight);
  const open = ref(false);
  const maximized = ref(false);
  const height = ref(TERMINAL_DEFAULT);
  const dragging = ref(false);

  const maxHeight = computed(() =>
    panelMaxWidth(viewportHeight.value, TERMINAL_MIN, CHAT_RESERVE),
  );

  const panelHeight = computed(() => {
    if (!open.value) return 0;
    if (maximized.value) return viewportHeight.value;
    return clampPanelWidth(height.value, TERMINAL_MIN, maxHeight.value);
  });

  function load(): void {
    try {
      open.value = safeGetString(TERMINAL_OPEN_KEY) === 'true';
      const raw = safeGetString(TERMINAL_HEIGHT_KEY);
      if (raw !== null) {
        const n = Number(raw);
        if (Number.isFinite(n)) height.value = clampPanelWidth(n, TERMINAL_MIN, maxHeight.value);
      }
    } catch {
      open.value = false;
    }
  }

  function persistOpen(): void {
    try {
      safeSetString(TERMINAL_OPEN_KEY, String(open.value));
    } catch {
      // ignore
    }
  }

  function setHeight(value: number): void {
    height.value = clampPanelWidth(value, TERMINAL_MIN, maxHeight.value);
    try {
      safeSetString(TERMINAL_HEIGHT_KEY, String(height.value));
    } catch {
      // ignore
    }
  }

  function setOpen(value: boolean): void {
    open.value = value;
    if (!value) maximized.value = false;
    persistOpen();
  }

  function toggle(): void {
    setOpen(!open.value);
  }

  function setMaximized(value: boolean): void {
    if (!open.value && value) setOpen(true);
    maximized.value = value;
  }

  function toggleMaximized(): void {
    setMaximized(!maximized.value);
  }

  /** Escape handling: restore maximize first, then close. Returns true if handled. */
  function handleEscape(): boolean {
    if (!open.value) return false;
    if (maximized.value) {
      maximized.value = false;
      return true;
    }
    setOpen(false);
    return true;
  }

  function onResize(): void {
    viewportHeight.value = window.innerHeight;
    if (!maximized.value) {
      height.value = clampPanelWidth(height.value, TERMINAL_MIN, maxHeight.value);
    }
  }

  onMounted(() => {
    load();
    window.addEventListener('resize', onResize);
  });

  onBeforeUnmount(() => {
    window.removeEventListener('resize', onResize);
  });

  return {
    TERMINAL_HEIGHT_KEY,
    TERMINAL_DEFAULT,
    TERMINAL_MIN,
    open,
    maximized,
    height,
    panelHeight,
    maxHeight,
    dragging,
    setHeight,
    setOpen,
    toggle,
    setMaximized,
    toggleMaximized,
    handleEscape,
  };
}
