<!-- apps/kimi-web/src/components/Terminal.vue -->
<!-- Single xterm pane. The starting/error overlays cross-fade instead of
     hard-mounting, and the toolbar dot pulses once when the shell connects. -->
<script setup lang="ts">
import '@xterm/xterm/css/xterm.css';

import type { FitAddon as FitAddonType } from '@xterm/addon-fit';
import type { Terminal as XTerm, ITheme } from '@xterm/xterm';
import { computed, nextTick, onMounted, onUnmounted, ref, toRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useIsDark } from '../composables/useIsDark';
import { useTerminal, type TerminalStartMode } from '../composables/useTerminal';
import Button from './ui/Button.vue';
import Spinner from './ui/Spinner.vue';

const props = withDefaults(
  defineProps<{
    sessionId: string;
    /** Server terminal id when mode is `attach`. */
    terminalId?: string | null;
    mode?: TerminalStartMode;
    /** Hide the standalone toolbar — the dock supplies chrome. */
    embedded?: boolean;
  }>(),
  {
    terminalId: null,
    mode: 'reuse',
    embedded: false,
  },
);

const emit = defineEmits<{
  ready: [payload: { terminalId: string; shell: string; cwd: string }];
  exited: [payload: { exitCode: number | null }];
}>();

const { t } = useI18n();

// xterm's `fontFamily` is a literal font string — it does NOT resolve CSS
// variables, so passing `var(--mono)` silently fell back to xterm's default
// (courier), which is why glyph metrics / spacing looked off. Use the real
// JetBrains Mono stack (same family the app loads via @fontsource).
const TERMINAL_FONT =
  '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

const hostRef = ref<HTMLElement | null>(null);
const sessionId = toRef(props, 'sessionId');
const attachId = toRef(props, 'terminalId');
const terminalClient = useTerminal(sessionId, {
  mode: props.mode,
  terminalId: attachId,
});
const isDark = useIsDark();

let term: XTerm | null = null;
let fitAddon: FitAddonType | null = null;
let resizeObserver: ResizeObserver | null = null;
let resizeTimer: ReturnType<typeof setTimeout> | null = null;
let disposeOutput: (() => void) | null = null;
let disposeExit: (() => void) | null = null;
let pendingOutput = '';
let outputFrame: number | undefined;
let outputWriting = false;

const theme = computed<ITheme>(() => {
  if (isDark.value) {
    return {
      background: '#0d1117',
      foreground: '#e6edf3',
      cursor: '#7aa2ff',
      selectionBackground: '#264f78',
      black: '#0d1117',
      red: '#ff7b72',
      green: '#7ee787',
      yellow: '#f2cc60',
      blue: '#7aa2ff',
      magenta: '#d2a8ff',
      cyan: '#76e3ea',
      white: '#e6edf3',
    };
  }
  return {
    background: '#ffffff',
    foreground: '#1f2328',
    cursor: '#1f6feb',
    selectionBackground: '#c8e1ff',
    black: '#24292f',
    red: '#cf222e',
    green: '#116329',
    yellow: '#9a6700',
    blue: '#0969da',
    magenta: '#8250df',
    cyan: '#1b7c83',
    white: '#f6f8fa',
  };
});

function flushOutput(): void {
  outputFrame = undefined;
  if (outputWriting || !term || !pendingOutput) return;
  const data = pendingOutput;
  pendingOutput = '';
  outputWriting = true;
  term.write(data, () => {
    outputWriting = false;
    if (pendingOutput) scheduleOutput();
  });
}

function scheduleOutput(): void {
  if (outputFrame === undefined) outputFrame = window.requestAnimationFrame(flushOutput);
}

function enqueueOutput(data: string): void {
  pendingOutput += data;
  scheduleOutput();
}

function fitAndResize(): void {
  if (!term || !fitAddon || !hostRef.value) return;
  if (hostRef.value.clientWidth <= 0 || hostRef.value.clientHeight <= 0) return;
  try {
    fitAddon.fit();
    terminalClient.resize(term.cols, term.rows);
  } catch {
    // xterm-fit can throw while layout is settling; the next resize retries.
  }
}

function scheduleFit(): void {
  if (resizeTimer !== null) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    resizeTimer = null;
    fitAndResize();
  }, 100);
}

async function initTerminal(): Promise<void> {
  if (!hostRef.value || term) return;
  const [{ Terminal: XTermCtor }, { FitAddon: FitAddonCtor }] = await Promise.all([
    import('@xterm/xterm'),
    import('@xterm/addon-fit'),
  ]);
  // Wait for the variable font to load before xterm measures the cell — a
  // not-yet-loaded webfont makes xterm cache a wrong char width, leaving the
  // text looking loosely/unevenly spaced until a resize.
  if (typeof document !== 'undefined' && document.fonts?.ready) {
    try {
      await document.fonts.ready;
    } catch {
      // fonts API unavailable — proceed with the fallback metric
    }
  }
  const next = new XTermCtor({
    cursorBlink: true,
    convertEol: true,
    fontFamily: TERMINAL_FONT,
    fontSize: 13,
    lineHeight: 1.1,
    letterSpacing: 0,
    scrollback: 4000,
    theme: theme.value,
  });
  const fit = new FitAddonCtor();
  next.loadAddon(fit);
  next.open(hostRef.value);
  next.onData((data) => terminalClient.write(data));
  next.onResize(({ cols, rows }) => terminalClient.resize(cols, rows));
  term = next;
  fitAddon = fit;

  disposeOutput = terminalClient.onOutput((data) => {
    enqueueOutput(data);
  });
  disposeExit = terminalClient.onExit((exitCode) => {
    term?.writeln('');
    term?.writeln(
      `[process exited${exitCode === null ? '' : ` with code ${exitCode}`}]`,
    );
    emit('exited', { exitCode });
  });

  resizeObserver = new ResizeObserver(scheduleFit);
  resizeObserver.observe(hostRef.value);
}

async function start(): Promise<void> {
  await nextTick();
  await initTerminal();
  fitAndResize();
  await terminalClient.start({ cols: term?.cols, rows: term?.rows });
  fitAndResize();
  const current = terminalClient.terminal.value;
  if (current) {
    emit('ready', { terminalId: current.id, shell: current.shell, cwd: current.cwd });
  }
  term?.focus();
}

function restart(): void {
  term?.reset();
  term?.focus();
  terminalClient.restart();
}

function focus(): void {
  term?.focus();
}

onMounted(() => {
  void start();
});

watch(theme, (nextTheme) => {
  if (term) term.options.theme = nextTheme;
});

watch(sessionId, () => {
  term?.reset();
  if (sessionId.value) void start();
});

onUnmounted(() => {
  if (resizeTimer !== null) clearTimeout(resizeTimer);
  if (outputFrame !== undefined) cancelAnimationFrame(outputFrame);
  pendingOutput = '';
  outputWriting = false;
  resizeObserver?.disconnect();
  disposeOutput?.();
  disposeExit?.();
  term?.dispose();
  term = null;
  fitAddon = null;
});

defineExpose({ fitAndResize, focus, restart, close: () => terminalClient.close() });
</script>

<template>
  <section class="terminal-pane" :class="{ embedded }">
    <div v-if="!embedded" class="terminal-toolbar">
      <div class="terminal-meta">
        <span class="terminal-dot" :class="{ on: terminalClient.connected.value }"></span>
        <span v-if="terminalClient.terminal.value">{{ terminalClient.terminal.value.shell }}</span>
        <span v-if="terminalClient.terminal.value" class="terminal-cwd">{{ terminalClient.terminal.value.cwd }}</span>
        <span v-if="terminalClient.readOnly.value" class="terminal-readonly">{{ t('terminal.exited') }}</span>
      </div>
      <div class="terminal-actions">
        <Button size="sm" variant="secondary" @click="fitAndResize">{{ t('terminal.fit') }}</Button>
        <Button size="sm" variant="secondary" @click="terminalClient.close">{{ t('terminal.close') }}</Button>
        <Button size="sm" variant="primary" @click="restart">{{ t('terminal.new') }}</Button>
      </div>
    </div>
    <div class="terminal-surface">
      <div ref="hostRef" class="terminal-host"></div>
      <!-- The overlays cross-fade over the live xterm surface. loading and
           error are mutually exclusive (error is only set once loading
           clears), so each gets its own opacity Transition. -->
      <Transition name="terminal-fade">
        <div v-if="terminalClient.loading.value" class="terminal-overlay">
          <Spinner size="sm" :label="t('terminal.starting')" />
          {{ t('terminal.starting') }}
        </div>
      </Transition>
      <Transition name="terminal-fade">
        <div v-if="terminalClient.error.value" class="terminal-overlay error">{{ terminalClient.error.value }}</div>
      </Transition>
    </div>
  </section>
</template>

<style scoped>
.terminal-pane {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}
.terminal-toolbar {
  flex: none;
  min-height: 32px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 5px 8px 5px 10px;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
}
.terminal-meta {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--dim);
  font-family: var(--mono);
  font-size: var(--text-base);
}
.terminal-dot {
  position: relative;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--muted);
  flex: none;
  transition: background-color var(--duration-base) var(--ease-out);
}
.terminal-dot.on {
  background: var(--color-success);
}
/* One-shot pulse ring: the pseudo-element mounts the moment `.on` lands,
   runs its fade-out-and-grow animation once, then sits invisible until the
   next reconnect re-creates it. */
.terminal-dot.on::after {
  content: '';
  position: absolute;
  inset: -1px;
  border: 1px solid var(--color-success);
  border-radius: 50%;
  pointer-events: none;
  animation: terminal-dot-pulse var(--duration-slow) var(--ease-out) forwards;
}
@keyframes terminal-dot-pulse {
  from {
    opacity: 0.7;
    transform: scale(1);
  }
  to {
    opacity: 0;
    transform: scale(2.4);
  }
}
.terminal-cwd {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--muted);
}
.terminal-readonly {
  color: var(--color-warning);
}
.terminal-actions {
  display: flex;
  align-items: center;
  gap: 5px;
  flex: none;
}
.terminal-surface {
  position: relative;
  flex: 1;
  min-height: 0;
}
.terminal-host {
  position: absolute;
  inset: 0;
  padding: 8px;
}
.terminal-pane.embedded .terminal-host {
  padding: 6px 8px;
}
.terminal-host :deep(.xterm) {
  height: 100%;
}
.terminal-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 20px;
  background: color-mix(in srgb, var(--bg) 80%, transparent);
  color: var(--muted);
  font-family: var(--mono);
  font-size: var(--ui-font-size-xs);
  text-align: center;
}
.terminal-overlay.error {
  color: var(--color-danger);
}
/* Overlay cross-fade (Transition in the template). The overlay is absolute
   over the xterm surface, so a leaving overlay simply dissolves in place. */
.terminal-fade-enter-active,
.terminal-fade-leave-active {
  transition: opacity var(--duration-base) var(--ease-out);
}
.terminal-fade-enter-from,
.terminal-fade-leave-to {
  opacity: 0;
}
</style>
