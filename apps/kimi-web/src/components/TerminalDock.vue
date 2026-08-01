<!-- Bottom multi-tab terminal dock. Each tab keeps a stable local :key so the
     Terminal view is not remounted when the server assigns a pty id. Tab chips
     run through a TransitionGroup (new shells rise in, closed ones collapse
     out); the zero-tabs body is the design-system EmptyState. -->
<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { getKimiWebApi } from '../api';
import Terminal from './Terminal.vue';
import IconButton from './ui/IconButton.vue';
import Icon from './ui/Icon.vue';
import Button from './ui/Button.vue';
import EmptyState from './ui/EmptyState.vue';

type TabStatus = 'creating' | 'ready' | 'closed' | 'error';

interface Tab {
  /** Stable local id used as Vue :key — never changes after creation. */
  id: string;
  /** Server terminal id; null until create/attach resolves. */
  terminalId: string | null;
  title: string;
  status: TabStatus;
  errorMessage: string;
  /** attach = bind an existing server terminal; create = spawn a new one. */
  mode: 'create' | 'attach';
}

type TerminalExpose = {
  fitAndResize: () => void;
  focus: () => void;
};

const props = defineProps<{
  sessionId: string;
  open: boolean;
  height: number;
  maximized: boolean;
}>();

const emit = defineEmits<{
  close: [];
  'toggle-maximize': [];
}>();

const { t } = useI18n();

const tabs = ref<Tab[]>([]);
const activeId = ref<string | null>(null);
/** Per-session tab cache so switching sessions restores shells. */
const tabsBySession = new Map<string, { tabs: Tab[]; activeId: string | null }>();
const terminalRefs = ref<Record<string, TerminalExpose | null>>({});

function setTerminalRef(tabId: string, instance: unknown): void {
  if (instance && typeof instance === 'object') {
    terminalRefs.value[tabId] = instance as TerminalExpose;
  } else {
    delete terminalRefs.value[tabId];
  }
}

function fitActive(): void {
  const id = activeId.value;
  if (!id) return;
  terminalRefs.value[id]?.fitAndResize();
}

function focusActive(): void {
  const id = activeId.value;
  if (!id) return;
  terminalRefs.value[id]?.focus();
}

const dockEl = ref<HTMLElement | null>(null);
/** True while the open/close height slide runs. Gates the height transition
    so resize drags (which churn the height prop) apply instantly. */
const animating = ref(false);
let animatingFallback: ReturnType<typeof setTimeout> | null = null;

function beginHeightAnimation(): void {
  animating.value = true;
  if (animatingFallback !== null) clearTimeout(animatingFallback);
  // Safety net in case transitionend never fires (background tab, etc.):
  // drop the gate shortly after the 0.28s slide so drags stay instant.
  animatingFallback = setTimeout(() => {
    animatingFallback = null;
    animating.value = false;
  }, 340);
}

function onDockTransitionEnd(e: TransitionEvent): void {
  if (e.target !== dockEl.value || e.propertyName !== 'height') return;
  if (animatingFallback !== null) {
    clearTimeout(animatingFallback);
    animatingFallback = null;
  }
  animating.value = false;
  // xterm measured the mid-slide box; refit now that the height settled.
  fitActive();
}

onBeforeUnmount(() => {
  if (animatingFallback !== null) clearTimeout(animatingFallback);
});

async function revealActive(): Promise<void> {
  await nextTick();
  // Layout may still be settling after open/maximize — fit twice around a frame.
  fitActive();
  requestAnimationFrame(() => {
    fitActive();
    focusActive();
  });
}

defineExpose({ fitActive, focusActive, revealActive });

function shortTitle(cwd: string, shell: string): string {
  if (!cwd) return shell || t('terminal.tab');
  const parts = cwd.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || cwd;
}

function focusTab(id: string): void {
  activeId.value = id;
}

function snapshotCurrent(): void {
  if (!props.sessionId) return;
  tabsBySession.set(props.sessionId, {
    tabs: tabs.value.map((tab) => ({ ...tab })),
    activeId: activeId.value,
  });
}

function restoreOrSeed(sessionId: string): void {
  const cached = tabsBySession.get(sessionId);
  if (cached && cached.tabs.length > 0) {
    tabs.value = cached.tabs.map((tab) => ({ ...tab }));
    activeId.value = cached.activeId;
    return;
  }
  tabs.value = [];
  activeId.value = null;
  void hydrateFromServer(sessionId);
}

async function hydrateFromServer(sessionId: string): Promise<void> {
  try {
    const running = (await getKimiWebApi().listTerminals(sessionId)).filter(
      (item) => item.status === 'running',
    );
    if (sessionId !== props.sessionId) return;
    if (running.length === 0) {
      await createTab();
      return;
    }
    tabs.value = running.map((item) => ({
      id: `local-${item.id}`,
      terminalId: item.id,
      title: shortTitle(item.cwd, item.shell),
      status: 'ready' as const,
      errorMessage: '',
      mode: 'attach' as const,
    }));
    activeId.value = tabs.value[0]?.id ?? null;
    snapshotCurrent();
  } catch (error) {
    if (sessionId !== props.sessionId) return;
    const message = error instanceof Error ? error.message : String(error);
    const localId = `local-${crypto.randomUUID()}`;
    tabs.value = [
      {
        id: localId,
        terminalId: null,
        title: t('terminal.tab'),
        status: 'error',
        errorMessage: message,
        mode: 'create',
      },
    ];
    activeId.value = localId;
  }
}

async function createTab(): Promise<void> {
  const localId = `local-${crypto.randomUUID()}`;
  const tab: Tab = {
    id: localId,
    terminalId: null,
    title: t('terminal.tab'),
    status: 'creating',
    errorMessage: '',
    mode: 'create',
  };
  tabs.value.push(tab);
  activeId.value = localId;
  snapshotCurrent();
}

function closeTab(id: string): void {
  const idx = tabs.value.findIndex((tab) => tab.id === id);
  if (idx === -1) return;
  const tab = tabs.value[idx]!;
  if (tab.terminalId) {
    void getKimiWebApi()
      .closeTerminal(props.sessionId, tab.terminalId)
      .catch(() => {
        // Best-effort; the PTY may already be gone.
      });
  }
  const wasActive = activeId.value === id;
  tabs.value.splice(idx, 1);
  if (wasActive) {
    const next = tabs.value[idx - 1] ?? tabs.value[idx] ?? null;
    activeId.value = next?.id ?? null;
  }
  snapshotCurrent();
  if (tabs.value.length === 0) emit('close');
}

function onReady(tabId: string, payload: { terminalId: string; shell: string; cwd: string }): void {
  const tab = tabs.value.find((item) => item.id === tabId);
  if (!tab) {
    // Tab closed while create was in flight — release the orphan PTY.
    void getKimiWebApi()
      .closeTerminal(props.sessionId, payload.terminalId)
      .catch(() => {});
    return;
  }
  Object.assign(tab, {
    terminalId: payload.terminalId,
    title: shortTitle(payload.cwd, payload.shell),
    status: 'ready' as const,
    errorMessage: '',
  });
  snapshotCurrent();
}

function onExited(tabId: string): void {
  const tab = tabs.value.find((item) => item.id === tabId);
  if (!tab) return;
  tab.status = 'closed';
  snapshotCurrent();
}

function reopenTab(id: string): void {
  const idx = tabs.value.findIndex((tab) => tab.id === id);
  if (idx !== -1) tabs.value.splice(idx, 1);
  void createTab();
}

watch(
  () => props.sessionId,
  (sessionId, previous) => {
    if (previous) snapshotCurrent();
    if (!sessionId) {
      tabs.value = [];
      activeId.value = null;
      return;
    }
    restoreOrSeed(sessionId);
  },
);

watch(
  () => props.open,
  (open) => {
    if (!open || !props.sessionId) return;
    if (tabs.value.length === 0) restoreOrSeed(props.sessionId);
    void revealActive();
  },
  { immediate: true },
);

// Open/close slides the height 0 ↔ var(--terminal-h). The transition is gated
// to that window (non-immediate watch: no slide on first render) so height
// changes from the resize handle never fight it.
watch(
  () => props.open,
  () => beginHeightAnimation(),
);

watch(
  () => [props.height, props.maximized, activeId.value] as const,
  () => {
    if (!props.open) return;
    void revealActive();
  },
);
</script>

<template>
  <section
    ref="dockEl"
    class="terminal-dock"
    :class="{ open, maximized, 'is-animating': animating }"
    :style="{ '--terminal-h': `${height}px` }"
    role="complementary"
    :aria-label="t('layout.terminalPanelAria')"
    :aria-hidden="!open"
    @transitionend="onDockTransitionEnd"
  >
    <header class="terminal-dock__header">
      <TransitionGroup tag="div" name="dock-tab" class="terminal-dock__tabs" role="tablist">
        <div
          v-for="tab in tabs"
          :key="tab.id"
          role="tab"
          tabindex="0"
          :aria-selected="tab.id === activeId"
          class="terminal-dock__tab"
          :class="{
            'is-active': tab.id === activeId,
            'is-error': tab.status === 'error' || tab.status === 'closed',
          }"
          @click="focusTab(tab.id)"
          @keydown.enter.prevent="focusTab(tab.id)"
          @keydown.space.prevent="focusTab(tab.id)"
          @dblclick.prevent="closeTab(tab.id)"
          @auxclick="(e) => e.button === 1 && closeTab(tab.id)"
        >
          <Icon name="terminal" size="sm" class="terminal-dock__tab-icon" />
          <span class="terminal-dock__tab-title">{{ tab.title }}</span>
          <button
            type="button"
            class="terminal-dock__tab-close"
            :aria-label="t('terminal.closeTab')"
            @click.stop="closeTab(tab.id)"
          >
            <Icon name="close" size="sm" />
          </button>
        </div>
        <IconButton
          key="new-tab"
          size="sm"
          :label="t('terminal.newTab')"
          @click="createTab"
        >
          <Icon name="plus" size="sm" />
        </IconButton>
      </TransitionGroup>
      <div class="terminal-dock__actions">
        <IconButton
          size="sm"
          :label="maximized ? t('terminal.restore') : t('terminal.maximize')"
          @click="emit('toggle-maximize')"
        >
          <Icon :name="maximized ? 'collapse' : 'expand'" size="sm" />
        </IconButton>
        <IconButton size="sm" :label="t('terminal.closePanel')" @click="emit('close')">
          <Icon name="close" size="sm" />
        </IconButton>
      </div>
    </header>

    <div class="terminal-dock__body">
      <div
        v-for="tab in tabs"
        v-show="tab.id === activeId"
        :key="tab.id"
        class="terminal-dock__pane"
      >
        <div v-if="tab.status === 'error'" class="terminal-dock__state">
          <Icon name="alert-triangle" size="lg" class="terminal-dock__state-icon is-error" />
          <p>{{ tab.errorMessage || t('terminal.startFailed') }}</p>
          <Button size="sm" variant="secondary" @click="reopenTab(tab.id)">
            {{ t('terminal.restart') }}
          </Button>
        </div>
        <div v-else-if="tab.status === 'closed'" class="terminal-dock__state">
          <Icon name="stop" size="lg" class="terminal-dock__state-icon" />
          <p>{{ t('terminal.exited') }}</p>
          <Button size="sm" variant="secondary" @click="reopenTab(tab.id)">
            {{ t('terminal.restart') }}
          </Button>
        </div>
        <Terminal
          v-else-if="tab.mode === 'create' || tab.terminalId"
          :ref="(el) => setTerminalRef(tab.id, el)"
          :session-id="sessionId"
          :terminal-id="tab.terminalId"
          :mode="tab.mode"
          embedded
          @ready="onReady(tab.id, $event)"
          @exited="onExited(tab.id)"
        />
      </div>
      <!-- Zero tabs — design-system EmptyState (owns its kimi-card-in
           entrance). The hint is the keyboard shortcut that re-opens the
           panel with a fresh shell. -->
      <EmptyState
        v-if="tabs.length === 0"
        class="terminal-dock__empty"
        :title="t('terminal.tab')"
        :hint="t('header.toggleTerminalHint')"
      >
        <template #icon><Icon name="terminal" size="lg" /></template>
        <Button size="sm" variant="secondary" @click="createTab">
          {{ t('terminal.newTab') }}
        </Button>
      </EmptyState>
    </div>
  </section>
</template>

<style scoped>
/* Always a flex column: show/hide slides the height 0 ↔ var(--terminal-h)
   instead of snapping display. Closed = zero height, no hairline, hidden
   (keeps the collapsed box out of the tab order, matching aria-hidden). */
.terminal-dock {
  display: flex;
  flex-direction: column;
  flex: none;
  height: 0;
  min-height: 0;
  min-width: 0;
  background: var(--bg);
  border-top: 1px solid transparent;
  overflow: hidden;
  visibility: hidden;
}
/* The slide is gated by .is-animating (set on open toggles, cleared on
   transitionend) so resize drags apply their height instantly. visibility
   flips at the end of the hide slide and at the start of the show slide. */
.terminal-dock.is-animating {
  transition:
    height 0.28s cubic-bezier(0.4, 0, 0.2, 1),
    border-top-color 0.28s cubic-bezier(0.4, 0, 0.2, 1),
    visibility 0.28s;
}
.terminal-dock.open {
  height: var(--terminal-h);
  border-top-color: var(--line);
  visibility: visible;
}
.terminal-dock.maximized {
  flex: 1 1 auto;
  height: auto;
}
.terminal-dock__header {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 36px;
  padding: 0 var(--space-2) 0 var(--space-1);
  border-bottom: 1px solid var(--line);
  background: var(--panel);
}
.terminal-dock__tabs {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 2px;
  overflow-x: auto;
  scrollbar-width: thin;
  /* Containing block for the absolute leaving chip below, so a closing tab
     fades out over its own slot while the siblings glide left. */
  position: relative;
}
/* Tab chip motion (TransitionGroup in the template): a new shell rises in,
   a closed one fades out in place — kept subtle so it never fights the
   header layout. Reduced motion is covered by the global kill switch. */
.dock-tab-enter-from {
  opacity: 0;
  transform: translateY(4px);
}
.dock-tab-leave-to {
  opacity: 0;
}
.dock-tab-enter-active,
.dock-tab-leave-active {
  transition: opacity var(--duration-base) var(--ease-out),
    transform var(--duration-base) var(--ease-out);
}
.dock-tab-leave-active {
  /* Out of flow while fading so the remaining chips claim the vacated slot
     immediately; the group's FLIP keeps it visually anchored. */
  position: absolute;
}
.dock-tab-move {
  transition: transform var(--duration-base) var(--ease-out);
}
.terminal-dock__tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 180px;
  height: 28px;
  padding: 0 6px 0 8px;
  border-radius: var(--radius-sm);
  color: var(--dim);
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  cursor: pointer;
  user-select: none;
}
.terminal-dock__tab:hover {
  background: var(--hover);
  color: var(--color-text);
}
.terminal-dock__tab.is-active {
  background: var(--hover);
  color: var(--color-text);
  box-shadow: inset 0 -2px 0 var(--color-accent);
}
.terminal-dock__tab.is-error {
  color: var(--color-warning);
}
.terminal-dock__tab-icon {
  flex: none;
  opacity: 0.75;
}
.terminal-dock__tab-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.terminal-dock__tab-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: 0;
  border-radius: var(--radius-xs);
  background: transparent;
  color: inherit;
  opacity: 0;
  cursor: pointer;
}
.terminal-dock__tab:hover .terminal-dock__tab-close,
.terminal-dock__tab.is-active .terminal-dock__tab-close {
  opacity: 0.7;
}
.terminal-dock__tab-close:hover {
  opacity: 1;
  background: var(--hover);
}
.terminal-dock__actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: none;
}
.terminal-dock__body {
  position: relative;
  flex: 1;
  min-height: 0;
}
.terminal-dock__pane {
  position: absolute;
  inset: 0;
}
.terminal-dock__state {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  padding: var(--space-4);
  color: var(--muted);
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  text-align: center;
}
.terminal-dock__state p {
  margin: 0;
}
.terminal-dock__state-icon {
  flex: none;
  color: var(--color-text-faint);
}
.terminal-dock__state-icon.is-error {
  color: var(--color-warning);
}
/* The dock body can be short — trim EmptyState's generous default padding
   and let it fill the pane so the content centers vertically. */
.terminal-dock__empty {
  height: 100%;
  padding: var(--space-3) var(--space-4);
}
</style>
