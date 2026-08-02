<!-- apps/kimi-web/src/components/chat/AgentDetailPanel.vue -->
<!-- A subagent's full detail in the right-side panel (App's shared slot — opening
     this replaces a thinking/compaction/file view and vice versa). Mirrors the
     thinking panel: the content is reactive, so a still-running subagent keeps
     streaming its progress here, and the progress list follows the bottom as long
     as the user hasn't scrolled up. -->
<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { getKimiWebApi } from '../../api';
import type { AppAgentTranscript } from '../../api/types';
import type { AgentMember } from '../../types';
import Badge from '../ui/Badge.vue';
import PanelHeader from '../ui/PanelHeader.vue';
import Markdown from './Markdown.vue';
import ThinkingBlock from './ThinkingBlock.vue';

const props = defineProps<{ member: AgentMember }>();

const emit = defineEmits<{
  close: [];
}>();

const { t } = useI18n();

const recoveredTranscript = ref<AppAgentTranscript | null>(null);
let transcriptTimer: ReturnType<typeof setInterval> | null = null;
let transcriptRequest = 0;

function stopTranscriptPolling(): void {
  if (transcriptTimer !== null) {
    clearInterval(transcriptTimer);
    transcriptTimer = null;
  }
}

async function refreshTranscript(): Promise<void> {
  const api = getKimiWebApi();
  const sessionId = props.member.sessionId;
  if (!sessionId || !api.getAgentTranscript) return;
  const request = ++transcriptRequest;
  try {
    const transcript = await api.getAgentTranscript(sessionId, props.member.id);
    if (request === transcriptRequest) recoveredTranscript.value = transcript;
  } catch {
    // Live task progress remains the fallback on old servers/transports.
  }
}

watch(
  () => [props.member.sessionId, props.member.id, props.member.phase] as const,
  ([sessionId, agentId, phase], previous) => {
    stopTranscriptPolling();
    transcriptRequest += 1;
    if (!previous || previous[0] !== sessionId || previous[1] !== agentId) {
      recoveredTranscript.value = null;
    }
    void refreshTranscript();
    if (phase === 'queued' || phase === 'working') {
      transcriptTimer = setInterval(() => void refreshTranscript(), 1000);
    }
  },
  { immediate: true },
);

onUnmounted(() => {
  transcriptRequest += 1;
  stopTranscriptPolling();
});

function preferRecovered(recovered: string | undefined, live: string | undefined): string {
  const recoveredText = recovered?.trimEnd() ?? '';
  const liveText = live?.trimEnd() ?? '';
  if (!recoveredText) return liveText;
  if (!liveText || recoveredText.length >= liveText.length) return recoveredText;
  return liveText;
}

const progressLines = computed(() =>
  [...(recoveredTranscript.value?.progressLines ?? []), ...(props.member.outputLines ?? [])]
    .map((line) => line.trimEnd())
    .filter((line, index, lines) => line.length > 0 && lines.indexOf(line) === index),
);

// The subagent's concatenated live output (assistant deltas). Trim trailing
// whitespace for display; grows in real time as deltas stream in.
const liveText = computed(() => preferRecovered(recoveredTranscript.value?.text, props.member.text));
const liveThinking = computed(() => preferRecovered(recoveredTranscript.value?.thinking, props.member.thinking));

const hasBody = computed(
  () =>
    Boolean(props.member.prompt) ||
    Boolean(props.member.subagentType) ||
    Boolean(props.member.suspendedReason) ||
    liveThinking.value.length > 0 ||
    liveText.value.length > 0 ||
    progressLines.value.length > 0 ||
    Boolean(props.member.summary),
);

const showWaiting = computed(
  () =>
    !hasBody.value &&
    (props.member.phase === 'queued' || props.member.phase === 'working'),
);

/** True while the subagent is still producing output — drives Markdown /
 *  ThinkingBlock `streaming` so live text animates and thinking stays expanded
 *  until the run settles, matching the main conversation. */
const live = computed(
  () => props.member.phase === 'queued' || props.member.phase === 'working',
);

interface ProgressGroup {
  key: string;
  /** The "Calling …" tool-call line, or '' for output with no preceding call. */
  call: string;
  output: string[];
}

/** Group flat progress lines into tool-call groups: a "Calling …" line starts a
 *  group and subsequent non-call lines are its output. */
function groupProgress(lines: string[]): ProgressGroup[] {
  const groups: ProgressGroup[] = [];
  let current: ProgressGroup | null = null;
  let idx = 0;
  for (const line of lines) {
    if (line.startsWith('Calling ')) {
      current = { key: `g${idx++}`, call: line, output: [] };
      groups.push(current);
    } else if (current) {
      current.output.push(line);
    } else {
      current = { key: `g${idx++}`, call: '', output: [line] };
      groups.push(current);
    }
  }
  return groups;
}

const progressGroups = computed(() => groupProgress(progressLines.value));

/** Group keys whose folded output is expanded. */
const expandedGroups = ref<Set<string>>(new Set());

const OUTPUT_FOLD_THRESHOLD = 8;
const OUTPUT_HEAD = 5;
const OUTPUT_TAIL = 2;

function isExpanded(key: string): boolean {
  return expandedGroups.value.has(key);
}
function toggleGroup(key: string): void {
  const next = new Set(expandedGroups.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  expandedGroups.value = next;
}
function foldCount(group: ProgressGroup): number {
  return group.output.length - OUTPUT_HEAD - OUTPUT_TAIL;
}

function phaseLabel(phase: AgentMember['phase']): string {
  switch (phase) {
    case 'queued': return t('tasks.phaseQueued');
    case 'working': return t('tasks.phaseWorking');
    case 'suspended': return t('tasks.phaseSuspended');
    case 'completed': return t('tasks.phaseCompleted');
    case 'failed': return t('tasks.phaseFailed');
  }
}

const bodyEl = ref<HTMLElement | null>(null);
watch(
  // Follow the bottom as thinking, tool progress, or live text grows, as long
  // as the user hasn't scrolled up.
  () => progressLines.value.length + liveText.value.length + liveThinking.value.length,
  () => {
    const el = bodyEl.value;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (!atBottom) return;
    void nextTick(() => {
      if (bodyEl.value) bodyEl.value.scrollTop = bodyEl.value.scrollHeight;
    });
  },
  { immediate: true },
);
</script>

<template>
  <div class="ap">
    <PanelHeader
      :title="t('common.preview')"
      :subtitle="member.name"
      :close-label="t('thinking.close')"
      @close="emit('close')"
    >
      <Badge variant="neutral" size="sm" class="ap-phase">{{ phaseLabel(member.phase) }}</Badge>
    </PanelHeader>
    <div ref="bodyEl" class="ap-body">
      <div v-if="member.subagentType" class="ap-type">{{ member.subagentType }}</div>
      <div v-if="member.suspendedReason" class="ap-reason">{{ member.suspendedReason }}</div>
      <div v-if="member.prompt" class="ap-field">
        <span class="ap-field-label">{{ t('tasks.detailTask') }}</span>
        <div class="ap-field-body">{{ member.prompt }}</div>
      </div>
      <div v-if="liveThinking" class="ap-field">
        <span class="ap-field-label">{{ t('tasks.detailThinking') }}</span>
        <div class="ap-field-body ap-live">
          <ThinkingBlock :text="liveThinking" :streaming="live" foldable />
        </div>
      </div>
      <div v-if="liveText" class="ap-field">
        <span class="ap-field-label">{{ t('tasks.detailOutput') }}</span>
        <div class="ap-field-body ap-markdown">
          <Markdown :text="liveText" :streaming="live" />
        </div>
      </div>
      <div v-if="progressGroups.length > 0" class="ap-field">
        <span class="ap-field-label">{{ t('tasks.detailProgress') }}</span>
        <div class="ap-field-body ap-progress">
          <div v-for="group in progressGroups" :key="group.key" class="ap-group">
            <div v-if="group.call" class="ap-call">
              <span class="ap-glyph" aria-hidden="true">▶</span>
              {{ group.call }}
            </div>
            <div v-if="group.output.length > 0" class="ap-output">
              <template v-if="group.output.length <= OUTPUT_FOLD_THRESHOLD || isExpanded(group.key)">
                <div v-for="(line, li) in group.output" :key="li" class="ap-out-line">{{ line }}</div>
              </template>
              <template v-else>
                <div v-for="(line, li) in group.output.slice(0, OUTPUT_HEAD)" :key="li" class="ap-out-line">{{ line }}</div>
                <button type="button" class="ap-fold" @click="toggleGroup(group.key)">
                  … ({{ foldCount(group) }} more)
                </button>
                <div v-for="(line, li) in group.output.slice(-OUTPUT_TAIL)" :key="'t' + li" class="ap-out-line">{{ line }}</div>
              </template>
            </div>
          </div>
        </div>
      </div>
      <div v-if="member.summary" class="ap-field">
        <span class="ap-field-label">{{ t('tasks.detailResult') }}</span>
        <div class="ap-field-body ap-markdown">
          <Markdown :text="member.summary" />
        </div>
      </div>
      <div v-if="showWaiting" class="ap-waiting">{{ t('tasks.detailWaiting') }}</div>
    </div>
  </div>
</template>

<style scoped>
.ap {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--color-bg);
}
.ap-phase { flex: none; }

.ap-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 14px;
  font: var(--text-base)/var(--leading-normal) var(--font-ui);
  color: var(--color-text-muted);
}
.ap-type {
  font: var(--text-xs) var(--font-mono);
  color: var(--color-text-muted);
  margin-bottom: 8px;
}
.ap-reason {
  color: var(--color-warning);
  margin-bottom: 8px;
}
.ap-field + .ap-field {
  margin-top: 12px;
}
.ap-field-label {
  display: block;
  color: var(--color-text-muted);
  font: var(--text-xs) var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: 4px;
}
.ap-field-body {
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--color-text);
  font-size: var(--text-sm);
  line-height: 1.5;
}
.ap-live {
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  line-height: 1.5;
}
/* Markdown-rendered sections use the main conversation's typography; the
   container must not force pre-wrap on top of it. */
.ap-markdown {
  white-space: normal;
}
.ap-markdown :deep(.md) {
  font-size: var(--text-sm);
  line-height: 1.6;
}
.ap-progress {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ap-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ap-call {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  color: var(--color-text);
  font-size: var(--text-sm);
}
.ap-glyph {
  flex: none;
  margin-top: 0.2em;
  font-size: 0.65em;
  color: var(--color-accent);
}
.ap-output {
  padding-left: 14px;
  border-left: 2px solid var(--color-line);
}
.ap-out-line {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  white-space: pre-wrap;
  word-break: break-word;
}
.ap-fold {
  border: none;
  background: none;
  padding: 2px 0;
  color: var(--color-accent);
  font: inherit;
  font-size: var(--text-xs);
  cursor: pointer;
}
.ap-waiting {
  margin-top: 8px;
  color: var(--color-text-faint);
  font-size: var(--text-sm);
}
</style>
