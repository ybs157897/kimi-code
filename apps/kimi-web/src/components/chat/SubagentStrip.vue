<!-- apps/kimi-web/src/components/chat/SubagentStrip.vue -->
<!-- Persistent "background subagents are running" card above the composer.
     The dock pill alone is easy to miss; this keeps the live roster in the
     dialog while TeamSpawn / Agent background work is in flight. -->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { TaskItem } from '../../types';
import Card from '../ui/Card.vue';
import Icon from '../ui/Icon.vue';
import Spinner from '../ui/Spinner.vue';
import StatusGlyph, { type StatusGlyphStatus } from './StatusGlyph.vue';

const props = defineProps<{
  tasks: TaskItem[];
}>();

const emit = defineEmits<{
  open: [taskId: string];
  cancel: [taskId: string];
}>();

const { t } = useI18n();

const running = computed(() => props.tasks.filter((task) => task.state === 'run'));

function glyphStatus(state: TaskItem['state']): StatusGlyphStatus {
  if (state === 'run' || state === 'done' || state === 'fail') return state;
  return 'pending';
}
</script>

<template>
  <Card v-if="running.length > 0" class="subagent-strip" role="status">
    <template #head>
      <div class="ss-head">
        <span class="ss-spin" aria-hidden="true"><Spinner size="sm" /></span>
        <Icon class="ss-icon" name="sparkles" size="md" />
        <span class="ss-title">
          {{ t('tasks.stripTitle', { count: running.length }) }}
        </span>
        <span class="ss-hint">{{ t('tasks.stripHint') }}</span>
      </div>
    </template>

    <TransitionGroup tag="ul" class="ss-list" name="ss-list">
      <li v-for="task in running" :key="task.id" class="ss-row">
        <button type="button" class="ss-main" @click="emit('open', task.id)">
          <StatusGlyph :status="glyphStatus(task.state)" />
          <span class="ss-name">{{ task.name }}</span>
          <span class="ss-time">{{ task.timing }}</span>
          <Icon class="ss-chevron" name="chevron-right" size="sm" />
        </button>
        <button
          type="button"
          class="ss-stop"
          @click.stop="emit('cancel', task.id)"
        >{{ t('tasks.stop') }}</button>
      </li>
    </TransitionGroup>
  </Card>
</template>

<style scoped>
.subagent-strip {
  --composer-send-size: 32px;
  --composer-send-inset: var(--space-2);
  margin: var(--space-2) var(--space-4) 0;
  box-shadow: var(--shadow-md);
  border-color: var(--color-accent-bd);
  background: var(--color-accent-soft);
  /* Self-contained mount entrance: the card pops into existence the moment a
     background task spawns (bare v-if upstream), so the shared keyframe
     settles it in; exit stays instant. */
  animation: kimi-card-in var(--duration-base) var(--ease-out);
}
.subagent-strip.ui-card {
  border-radius: var(--radius-lg);
}
.subagent-strip :deep(.ui-card__head) {
  padding: 10px 14px;
  border-bottom-color: var(--color-accent-bd);
  background: transparent;
}
.subagent-strip :deep(.ui-card__body) {
  padding: 4px 8px 8px;
  background: var(--color-surface-raised);
}

.ss-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  width: 100%;
}
.ss-spin { display: inline-flex; flex: none; color: var(--color-accent); }
.ss-icon { flex: none; color: var(--color-accent); }
.ss-title {
  flex: none;
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  color: var(--color-text);
}
.ss-hint {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}

.ss-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
  /* Containing block for the absolute leaving row below, so it fades out
     over its own slot while the siblings glide up into the vacated space. */
  position: relative;
}
/* Roster motion (TransitionGroup in the template): a new subagent rises in,
   a finished one fades out in place — kept subtle so it never fights the
   list layout. Reduced motion is covered by the global kill switch. */
.ss-list-enter-from {
  opacity: 0;
  transform: translateY(4px);
}
.ss-list-leave-to {
  opacity: 0;
}
.ss-list-enter-active,
.ss-list-leave-active {
  transition: opacity var(--duration-base) var(--ease-out),
    transform var(--duration-base) var(--ease-out);
}
.ss-list-leave-active {
  /* Out of flow while fading so siblings claim the vacated slot immediately;
     left/right keep the row at full list width. */
  position: absolute;
  left: 0;
  right: 0;
}
.ss-list-move {
  transition: transform var(--duration-base) var(--ease-out);
}
.ss-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.ss-main {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 8px;
  border: none;
  border-radius: var(--radius-md);
  background: none;
  color: var(--color-text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.ss-main:hover { background: var(--color-surface-sunken); }
.ss-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  line-height: 1.35;
}
.ss-time {
  flex: none;
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
}
.ss-chevron { flex: none; color: var(--color-text-faint); }
.ss-stop {
  flex: none;
  margin-right: 4px;
  padding: 2px 8px;
  border: 1px solid var(--color-line);
  border-radius: var(--radius-full);
  background: var(--color-surface);
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  cursor: pointer;
  transition: background-color var(--duration-fast) var(--ease-out),
    border-color var(--duration-fast) var(--ease-out),
    color var(--duration-fast) var(--ease-out);
}
.ss-stop:hover {
  border-color: var(--color-danger-bd);
  color: var(--color-danger);
  background: var(--color-danger-soft);
}
</style>
