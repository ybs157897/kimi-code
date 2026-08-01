<!-- apps/kimi-web/src/components/desktop/DesktopBridgeDemo.vue
     Phase 0 desktop bridge demo (docs/plan/desktop-product.md §8). Exercises
     the contract C surface through `getDesktopBridge()`: the Wails wrapper in
     the desktop shell, the browser dev mock under plain `pnpm dev` — both
     stream through the same `{sessionId,agentId,event}` contract, so this view
     renders identically with and without the Go side.
     Also subscribes the bridge's `onConnectionState` and exposes
     `EnsureConnected()` (the headline reconnect path) behind a live status
     dot + button, mirroring the desktop client's boot/recovery flow.
     Dev tooling: labels are intentionally not localized (DebugPanel precedent).
     Opt in with `?desktop_demo=1` (see isDesktopDemoEnabled). -->
<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import Button from '../ui/Button.vue';
import IconButton from '../ui/IconButton.vue';
import Icon from '../ui/Icon.vue';
import Badge from '../ui/Badge.vue';
import Card from '../ui/Card.vue';
import EmptyState from '../ui/EmptyState.vue';
import Textarea from '../ui/Textarea.vue';
import {
  getDesktopBridge,
  type DesktopAgentEvent,
  type DesktopEventPayload,
  type DesktopHelloInfo,
  type DesktopSessionSummary,
} from '../../api/desktop';

const emit = defineEmits<{ close: [] }>();

const bridge = getDesktopBridge();
const transport = bridge.kind;

interface ToolView {
  toolCallId: string;
  name: string;
  args: unknown;
  progressText: string;
  output: unknown;
  isError: boolean;
  done: boolean;
}

type TurnStatus = 'running' | 'completed' | 'cancelled' | 'failed' | 'blocked';

interface TurnView {
  turnId: number;
  prompt: string;
  text: string;
  tools: ToolView[];
  status: TurnStatus;
  durationMs: number | undefined;
}

const helloInfo = ref<DesktopHelloInfo | null>(null);
const sessions = ref<DesktopSessionSummary[]>([]);
const sessionId = ref('');
const agentId = ref('');
const promptText = ref('Hello from the desktop bridge demo!');
const turns = ref<TurnView[]>([]);
const eventLog = ref<DesktopEventPayload[]>([]);
const running = ref(false);
const busy = ref<'hello' | 'list' | 'create' | 'ensure' | 'submit' | 'cancel' | null>(null);
const errorMsg = ref('');

// Live IPC connection state (`kimi:connection`): unknown until the first
// EnsureConnected() round trip or push frame settles it.
const connectionState = ref<'connected' | 'disconnected' | 'unknown'>('unknown');
const connectionVariant = computed<'success' | 'danger' | 'neutral'>(() => {
  if (connectionState.value === 'connected') return 'success';
  if (connectionState.value === 'disconnected') return 'danger';
  return 'neutral';
});
const connectionLabel = computed(() =>
  connectionState.value === 'unknown' ? 'connection unknown' : connectionState.value,
);

const logRef = ref<HTMLElement | null>(null);
const promptRef = ref<InstanceType<typeof Textarea> | null>(null);

const EVENT_LOG_HINT =
  'Frames from runtime.EventsOn("kimi:event") (or the mock\'s equivalent) land here.';

function fail(error: unknown): void {
  errorMsg.value = error instanceof Error ? error.message : String(error);
}

async function doHello(): Promise<void> {
  busy.value = 'hello';
  errorMsg.value = '';
  try {
    helloInfo.value = await bridge.Hello();
  } catch (error) {
    fail(error);
  } finally {
    busy.value = null;
  }
}

async function doListSessions(): Promise<void> {
  busy.value = 'list';
  errorMsg.value = '';
  try {
    sessions.value = (await bridge.ListSessions()).items;
  } catch (error) {
    fail(error);
  } finally {
    busy.value = null;
  }
}

async function doCreateSession(): Promise<void> {
  busy.value = 'create';
  errorMsg.value = '';
  try {
    const handle = await bridge.CreateSession();
    sessionId.value = handle.sessionId;
    // Contract C fixes `{sessionId,…}`; fall back to the conventional main
    // agent id when the shell does not report one.
    agentId.value = handle.agentId ?? 'main';
  } catch (error) {
    fail(error);
  } finally {
    busy.value = null;
  }
}

async function doEnsureConnected(): Promise<void> {
  busy.value = 'ensure';
  errorMsg.value = '';
  try {
    connectionState.value = await bridge.EnsureConnected();
  } catch (error) {
    // The shell could not be reached at all — treat it as a dead connection.
    connectionState.value = 'disconnected';
    fail(error);
  } finally {
    busy.value = null;
  }
}

async function doSubmit(): Promise<void> {
  busy.value = 'submit';
  errorMsg.value = '';
  try {
    if (!sessionId.value) await doCreateSession();
    if (!sessionId.value) return; // create failed — error already surfaced
    await bridge.Submit(sessionId.value, agentId.value || 'main', promptText.value);
  } catch (error) {
    fail(error);
  } finally {
    busy.value = null;
  }
}

async function doCancel(): Promise<void> {
  busy.value = 'cancel';
  errorMsg.value = '';
  try {
    await bridge.Cancel(sessionId.value, agentId.value || 'main');
  } catch (error) {
    fail(error);
  } finally {
    busy.value = null;
  }
}

/** Narrow a wire agent event to one known member (contract C discriminant). */
function isEventType<T extends DesktopAgentEvent['type']>(
  event: DesktopAgentEvent,
  type: T,
): event is Extract<DesktopAgentEvent, { type: T }> {
  return event.type === type;
}

function currentTurn(turnId: number): TurnView | undefined {
  return turns.value.find((turn) => turn.turnId === turnId);
}

function handleEvent(payload: DesktopEventPayload): void {
  eventLog.value.push(payload);
  if (eventLog.value.length > 300) eventLog.value.splice(0, eventLog.value.length - 300);

  const event = payload.event;
  if (isEventType(event, 'turn.started')) {
    turns.value.push({
      turnId: event.turnId,
      prompt: event.prompt ?? '',
      text: '',
      tools: [],
      status: 'running',
      durationMs: undefined,
    });
    running.value = true;
  } else if (isEventType(event, 'assistant.delta')) {
    const turn = currentTurn(event.turnId);
    if (turn) turn.text += event.delta;
  } else if (isEventType(event, 'tool.call.started')) {
    const turn = currentTurn(event.turnId);
    turn?.tools.push({
      toolCallId: event.toolCallId,
      name: event.name,
      args: event.args,
      progressText: '',
      output: undefined,
      isError: false,
      done: false,
    });
  } else if (isEventType(event, 'tool.progress')) {
    const tool = currentTurn(event.turnId)?.tools.find((t) => t.toolCallId === event.toolCallId);
    if (tool && event.update.text) tool.progressText += event.update.text;
  } else if (isEventType(event, 'tool.result')) {
    const tool = currentTurn(event.turnId)?.tools.find((t) => t.toolCallId === event.toolCallId);
    if (tool) {
      tool.output = event.output;
      tool.isError = event.isError ?? false;
      tool.done = true;
    }
  } else if (isEventType(event, 'turn.ended')) {
    const turn = currentTurn(event.turnId);
    if (turn) {
      turn.status = event.reason;
      turn.durationMs = event.durationMs;
    }
    running.value = false;
  } else if (isEventType(event, 'error')) {
    errorMsg.value = event.message;
  }
}

function preview(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function turnStatusVariant(status: TurnStatus): 'info' | 'success' | 'warning' | 'danger' {
  if (status === 'completed') return 'success';
  if (status === 'cancelled') return 'warning';
  if (status === 'failed' || status === 'blocked') return 'danger';
  return 'info';
}

let offEvent: (() => void) | null = null;
let offConnection: (() => void) | null = null;

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close');
}

// Keep the raw log scrolled to the newest frame while streaming.
watch(
  () => eventLog.value.length,
  () => {
    void nextTick(() => {
      const el = logRef.value;
      if (el) el.scrollTop = el.scrollHeight;
    });
  },
);

onMounted(() => {
  try {
    offEvent = bridge.onEvent(handleEvent);
    offConnection = bridge.onConnectionState((state) => {
      connectionState.value = state;
    });
  } catch (error) {
    fail(error);
  }
  document.addEventListener('keydown', onKeydown);
  // Seed the connection dot with the same EnsureConnected() round trip the
  // reconnect button (and the desktop client's boot) runs.
  void doEnsureConnected();
  void nextTick(() => {
    const el = promptRef.value?.$el;
    if (el instanceof HTMLTextAreaElement) el.focus();
  });
});

onUnmounted(() => {
  offEvent?.();
  offEvent = null;
  offConnection?.();
  offConnection = null;
  document.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <Teleport to="body">
    <div class="ddb-root" role="dialog" aria-label="Desktop bridge demo">
      <header class="ddb-topbar">
        <div class="ddb-topbar-left">
          <span class="ddb-title">Desktop bridge — Phase 0 demo</span>
          <Badge :variant="transport === 'wails' ? 'info' : 'warning'" size="sm">
            {{ transport === 'wails' ? 'Wails shell' : 'browser dev mock' }}
          </Badge>
          <Badge :variant="connectionVariant" size="sm" dot>{{ connectionLabel }}</Badge>
          <Badge v-if="running" variant="info" size="sm" dot>turn running</Badge>
        </div>
        <IconButton size="sm" label="Close demo" @click="emit('close')">
          <Icon name="close" />
        </IconButton>
      </header>

      <div class="ddb-body">
        <!-- ============================ Controls ============================ -->
        <section class="ddb-controls">
          <Card>
            <template #head>Bind surface (contract C)</template>
            <div class="ddb-actions">
              <Button variant="secondary" size="sm" :loading="busy === 'hello'" @click="doHello">
                <Icon name="bolt" size="sm" />
                <span>Hello()</span>
              </Button>
              <Button variant="secondary" size="sm" :loading="busy === 'list'" @click="doListSessions">
                <Icon name="list" size="sm" />
                <span>ListSessions()</span>
              </Button>
              <Button variant="secondary" size="sm" :loading="busy === 'create'" @click="doCreateSession">
                <Icon name="plus" size="sm" />
                <span>CreateSession()</span>
              </Button>
              <Button variant="secondary" size="sm" :loading="busy === 'ensure'" @click="doEnsureConnected">
                <Icon name="refresh" size="sm" />
                <span>EnsureConnected()</span>
              </Button>
            </div>

            <div v-if="helloInfo" class="ddb-kv">
              <span class="ddb-kv-label">Hello</span>
              <code class="ddb-code">{{ preview(helloInfo) }}</code>
            </div>
            <div v-if="sessionId" class="ddb-kv">
              <span class="ddb-kv-label">Session</span>
              <code class="ddb-code">{{ sessionId }} / {{ agentId }}</code>
            </div>
            <div v-if="sessions.length" class="ddb-kv">
              <span class="ddb-kv-label">Sessions</span>
              <code class="ddb-code">{{ sessions.length }} known</code>
            </div>

            <div class="ddb-prompt">
              <!-- ⌘/Ctrl+Enter submits (the listeners fall through to the
                   native <textarea> root of ui/Textarea). -->
              <Textarea
                ref="promptRef"
                v-model="promptText"
                :rows="3"
                placeholder="Prompt text for Submit() — ⌘/Ctrl+Enter to send"
                @keydown.meta.enter.prevent="doSubmit"
                @keydown.ctrl.enter.prevent="doSubmit"
              />
              <div class="ddb-actions">
                <Button size="sm" :loading="busy === 'submit'" @click="doSubmit">
                  <Icon name="send" size="sm" />
                  <span>Submit()</span>
                </Button>
                <Button
                  variant="danger-soft"
                  size="sm"
                  :disabled="!running"
                  :loading="busy === 'cancel'"
                  @click="doCancel"
                >
                  <Icon name="stop" size="sm" />
                  <span>Cancel()</span>
                </Button>
              </div>
            </div>

            <p v-if="errorMsg" class="ddb-error">{{ errorMsg }}</p>
          </Card>

          <Card>
            <template #head>Streamed turns</template>
            <EmptyState
              v-if="!turns.length"
              title="No streamed turns yet"
              hint="Submit a prompt — streamed events render here (identical under the Wails shell and the browser dev mock)."
            >
              <template #icon><Icon name="message" size="lg" /></template>
            </EmptyState>
            <div v-for="turn in turns" :key="turn.turnId" class="ddb-turn">
              <div class="ddb-turn-head">
                <span class="ddb-turn-id">turn #{{ turn.turnId }}</span>
                <Badge :variant="turnStatusVariant(turn.status)" size="sm">
                  {{ turn.status }}{{ turn.durationMs !== undefined ? ` · ${turn.durationMs}ms` : '' }}
                </Badge>
              </div>
              <pre v-if="turn.text" class="ddb-text">{{ turn.text }}</pre>
              <div v-for="tool in turn.tools" :key="tool.toolCallId" class="ddb-tool">
                <div class="ddb-tool-head">
                  <Icon name="terminal" size="sm" />
                  <span class="ddb-tool-name">{{ tool.name }}</span>
                  <Badge :variant="tool.done ? (tool.isError ? 'danger' : 'success') : 'info'" size="sm">
                    {{ tool.done ? (tool.isError ? 'error' : 'done') : 'running' }}
                  </Badge>
                </div>
                <code class="ddb-code ddb-code--block">{{ preview(tool.args) }}</code>
                <pre v-if="tool.progressText || tool.output !== undefined" class="ddb-tool-output">{{
                  tool.output !== undefined ? preview(tool.output) : tool.progressText
                }}</pre>
              </div>
            </div>
          </Card>
        </section>

        <!-- =========================== Event log =========================== -->
        <section class="ddb-log-col">
          <Card class="ddb-log-card">
            <template #head>
              kimi:event log
              <Badge variant="neutral" size="sm">{{ eventLog.length }}</Badge>
            </template>
            <div ref="logRef" class="ddb-log">
              <EmptyState
                v-if="!eventLog.length"
                class="ddb-log-empty"
                title="No events yet"
                :hint="EVENT_LOG_HINT"
              >
                <template #icon><Icon name="bolt" size="lg" /></template>
              </EmptyState>
              <div v-for="(entry, index) in eventLog" :key="index" class="ddb-log-row">
                <Badge variant="neutral" size="sm">{{ entry.event.type }}</Badge>
                <code class="ddb-code ddb-log-json">{{ preview(entry) }}</code>
              </div>
            </div>
          </Card>
        </section>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.ddb-root {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  display: flex;
  flex-direction: column;
  background: var(--bg);
  color: var(--color-text);
  font-family: var(--font-ui);
}
.ddb-topbar {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  height: 48px;
  padding: 0 var(--space-4);
  border-bottom: 1px solid var(--color-line);
}
.ddb-topbar-left {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}
.ddb-title {
  font-size: var(--text-lg);
  font-weight: var(--weight-medium);
}
.ddb-body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: var(--space-4);
  padding: var(--space-4);
  overflow: hidden;
}
.ddb-controls {
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  overflow-y: auto;
}
.ddb-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.ddb-kv {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  margin-top: var(--space-3);
}
.ddb-kv-label {
  flex: none;
  width: 64px;
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}
.ddb-code {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  padding: 1px var(--space-1);
  border-radius: var(--radius-xs);
  background: var(--color-surface-sunken);
  word-break: break-all;
}
.ddb-code--block {
  display: block;
  padding: var(--space-2);
  white-space: pre-wrap;
}
.ddb-prompt {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-top: var(--space-3);
}
.ddb-error {
  margin: var(--space-3) 0 0;
  font-size: var(--text-sm);
  color: var(--color-danger);
}
.ddb-turn {
  border-top: 1px solid var(--color-line);
  padding: var(--space-3) 0;
}
.ddb-turn:first-of-type {
  border-top: none;
}
.ddb-turn-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.ddb-turn-id {
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
}
.ddb-text {
  margin: var(--space-2) 0 0;
  font-family: var(--font-ui);
  font-size: var(--text-base);
  line-height: var(--leading-normal);
  white-space: pre-wrap;
}
.ddb-tool {
  margin-top: var(--space-2);
  padding: var(--space-2);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-surface);
}
.ddb-tool-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.ddb-tool-name {
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
}
.ddb-tool-output {
  margin: var(--space-2) 0 0;
  padding: var(--space-2);
  border-radius: var(--radius-xs);
  background: var(--color-surface-sunken);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  white-space: pre-wrap;
  word-break: break-all;
}
.ddb-log-col {
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.ddb-log-card {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.ddb-log-card :deep(.ui-card__body) {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.ddb-log {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
/* Stretch the empty state across the scroll area so it centers vertically. */
.ddb-log-empty {
  flex: 1;
}
.ddb-log-row {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
}
.ddb-log-json {
  flex: 1;
  min-width: 0;
}

@media (max-width: 900px) {
  .ddb-body {
    grid-template-columns: 1fr;
    overflow-y: auto;
  }
  .ddb-controls {
    overflow-y: visible;
  }
  .ddb-log {
    max-height: 320px;
  }
}
</style>
