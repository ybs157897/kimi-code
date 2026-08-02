<script setup lang="ts">
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { QueuedPromptView } from '../../types';
import AuthMedia from './AuthMedia.vue';
import Icon from '../ui/Icon.vue';

const props = defineProps<{
  queued: QueuedPromptView[];
}>();

const emit = defineEmits<{
  unqueue: [index: number];
  editQueued: [index: number];
  reorderQueue: [payload: { from: number; to: number }];
}>();

const { t } = useI18n();
const expanded = ref(true);
const dragFrom = ref<number | null>(null);
const dragOver = ref<{ index: number; position: 'before' | 'after' } | null>(null);

watch(
  () => props.queued.length,
  (length, previousLength) => {
    if (length > previousLength) expanded.value = true;
  },
);

function hasAttachments(item: QueuedPromptView): boolean {
  return (item.attachments?.length ?? 0) > 0;
}

function onDragStart(index: number, event: DragEvent): void {
  dragFrom.value = index;
  if (!event.dataTransfer) return;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', String(index));
  const row = (event.currentTarget as HTMLElement | null)?.closest<HTMLElement>('.queue-item');
  if (row) event.dataTransfer.setDragImage(row, 24, 24);
}

function onDragOver(index: number, event: DragEvent): void {
  if (dragFrom.value === null) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  dragOver.value = {
    index,
    position: event.clientY < rect.top + rect.height / 2 ? 'before' : 'after',
  };
}

function onDrop(index: number, event: DragEvent): void {
  event.preventDefault();
  const from = dragFrom.value;
  const position = dragOver.value?.position ?? 'before';
  dragFrom.value = null;
  dragOver.value = null;
  if (from === null) return;
  let to = position === 'before' ? index : index + 1;
  if (from < to) to -= 1;
  if (from !== to) emit('reorderQueue', { from, to });
}

function clearDrag(): void {
  dragFrom.value = null;
  dragOver.value = null;
}
</script>

<template>
  <section class="queue-panel" :class="{ expanded }">
    <button
      type="button"
      class="queue-head"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      <Icon class="queue-chevron" name="chevron-right" size="sm" />
      <span class="queue-label">{{ t('composer.queueLabel') }}</span>
      <b class="queue-count">{{ queued.length }}</b>
      <span class="queue-hint">{{ t('composer.queueAutoDrain') }}</span>
    </button>

    <div v-if="expanded" class="queue-list">
      <div
        v-for="(item, index) in queued"
        :key="index"
        class="queue-item"
        :class="{
          dragging: dragFrom === index,
          'drop-before': dragOver?.index === index && dragOver.position === 'before',
          'drop-after': dragOver?.index === index && dragOver.position === 'after',
        }"
        @dragover="onDragOver(index, $event)"
        @drop="onDrop(index, $event)"
      >
        <span
          class="queue-grip"
          :title="t('composer.queueDragTitle')"
          draggable="true"
          @dragstart="onDragStart(index, $event)"
          @dragend="clearDrag"
        >
          <Icon name="grip" size="sm" />
        </span>
        <button
          type="button"
          class="queue-body"
          :title="t('composer.editQueued')"
          @click="emit('editQueued', index)"
        >
          <span v-if="item.text" class="queue-text">{{ item.text }}</span>
          <span v-else class="queue-text queue-placeholder">
            <Icon name="file" size="sm" />
            {{ t('composer.queuedAttachments', { n: item.attachments?.length ?? 0 }) }}
          </span>
        </button>
        <div v-if="hasAttachments(item)" class="queue-attachments">
          <template v-for="(attachment, attachmentIndex) in item.attachments" :key="attachmentIndex">
            <span v-if="attachment.kind === 'file'" class="queue-file">
              <Icon name="file" size="sm" />
              {{ attachment.name ?? attachment.fileId }}
            </span>
            <AuthMedia
              v-else
              :url="attachment.url"
              :kind="attachment.kind"
              :file-id="attachment.fileId"
              media-class="queue-image"
              :controls="false"
              muted
            />
          </template>
        </div>
        <span
          v-if="index === 0"
          class="queue-order is-next"
          role="img"
          :aria-label="t('composer.queueNext')"
          :title="t('composer.queueNext')"
        >
          <Icon name="arrow-up" size="sm" />
        </span>
        <span v-else class="queue-order">#{{ index + 1 }}</span>
        <button
          type="button"
          class="queue-remove"
          :aria-label="t('composer.remove')"
          @click.stop="emit('unqueue', index)"
        >
          <Icon name="trash" size="sm" />
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.queue-panel {
  margin: 0 var(--dock-inline-right) 6px var(--dock-inline-left);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-lg);
  background: var(--color-surface-raised);
  box-shadow: var(--shadow-xs);
  overflow: hidden;
}

.queue-head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-height: 34px;
  padding: 6px 10px;
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.queue-head:hover { background: var(--color-surface-sunken); }
.queue-head:focus-visible { outline: 2px solid var(--color-accent); outline-offset: -2px; }
.queue-chevron { flex: none; transition: transform 0.16s var(--ease-out); }
.queue-panel.expanded .queue-chevron { transform: rotate(90deg); }
.queue-label { color: var(--color-text); font-weight: var(--weight-medium); }
.queue-count { color: var(--color-accent); font-weight: var(--weight-medium); }
.queue-hint {
  margin-left: auto;
  color: var(--color-text-faint);
  font-size: var(--ui-font-size-xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.queue-list {
  max-height: min(220px, 30vh);
  overflow-y: auto;
  border-top: 1px solid var(--color-line);
}
.queue-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 7px;
  min-height: 38px;
  padding: 6px 8px;
}
.queue-item + .queue-item { border-top: 1px solid var(--color-line); }
.queue-item:hover { background: var(--color-surface-sunken); }
.queue-grip {
  display: inline-flex;
  flex: none;
  padding: 2px;
  color: var(--color-text-faint);
  cursor: grab;
}
.queue-grip:active { cursor: grabbing; }
.queue-body {
  flex: 1;
  min-width: 0;
  padding: 0;
  border: none;
  background: none;
  color: var(--color-text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.queue-text {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.queue-placeholder { display: flex; align-items: center; gap: 4px; color: var(--color-text-muted); }
.queue-attachments { display: flex; flex: none; gap: 4px; }
:deep(.queue-image) { width: 28px; height: 28px; object-fit: cover; border-radius: var(--radius-sm); }
.queue-file {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 150px;
  overflow: hidden;
  color: var(--color-text-muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.queue-order {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  min-width: 26px;
  height: 26px;
  color: var(--color-text-faint);
  font-size: var(--ui-font-size-xs);
  white-space: nowrap;
}
.queue-order.is-next {
  border-radius: var(--radius-sm);
  background: var(--color-accent-soft);
  color: var(--color-accent);
}
.queue-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 26px;
  height: 26px;
  padding: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--color-text-faint);
  cursor: pointer;
}
.queue-remove:hover { background: var(--color-danger-soft); color: var(--color-danger); }
.queue-remove:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 1px; }
.queue-item.dragging { opacity: 0.45; }
.queue-item.drop-before::before,
.queue-item.drop-after::after {
  content: '';
  position: absolute;
  left: 8px;
  right: 8px;
  height: 2px;
  border-radius: var(--radius-full);
  background: var(--color-accent);
}
.queue-item.drop-before::before { top: -1px; }
.queue-item.drop-after::after { bottom: -1px; }

@media (max-width: 640px) {
  .queue-hint { display: none; }
  .queue-list { max-height: min(180px, 26vh); }
}
</style>
