<!-- Workspace file explorer for the right-side detail layer. Lazy-loads
     directories via listDir; clicking a file opens the existing FilePreview. -->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { FsEntry } from '../api/types';
import type { FilePreviewRequest } from '../types';
import PanelHeader from './ui/PanelHeader.vue';
import IconButton from './ui/IconButton.vue';
import Icon from './ui/Icon.vue';
import Button from './ui/Button.vue';
import EmptyState from './ui/EmptyState.vue';
import Spinner from './ui/Spinner.vue';
import FileTreeNode, {
  type FileTreeBadgeKind,
  type FileTreeNodeModel,
} from './FileTreeNode.vue';

const props = defineProps<{
  sessionId: string;
  /** Workspace-relative path currently open in FilePreview (highlight). */
  selectedPath?: string | null;
  listDir: (path?: string) => Promise<FsEntry[]>;
}>();

const emit = defineEmits<{
  openFile: [target: FilePreviewRequest];
  close: [];
}>();

const { t } = useI18n();

const roots = ref<FileTreeNodeModel[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const search = ref('');
const bodyEl = ref<HTMLDivElement | null>(null);
let loadVersion = 0;

function badgeKind(status: string | undefined): FileTreeBadgeKind | null {
  if (!status) return null;
  const lower = status.toLowerCase();
  if (lower === 'modified') return 'modified';
  if (lower === 'added') return 'added';
  if (lower === 'deleted') return 'deleted';
  if (lower === 'renamed') return 'renamed';
  if (lower === 'untracked') return 'untracked';
  if (lower === 'conflicted') return 'conflicted';
  if (lower === 'ignored') return 'ignored';
  if (lower === 'clean') return null;
  return 'unknown';
}

const BADGE_GLYPH: Record<FileTreeBadgeKind, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
  conflicted: 'C',
  ignored: 'I',
  unknown: '?',
};

function sortEntries(entries: FsEntry[]): FsEntry[] {
  return [...entries].sort((a, b) => {
    const aDir = a.kind === 'directory' ? 0 : 1;
    const bDir = b.kind === 'directory' ? 0 : 1;
    if (aDir !== bDir) return aDir - bDir;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

function toNodes(entries: FsEntry[]): FileTreeNodeModel[] {
  return sortEntries(entries).map((entry) => ({
    entry,
    expanded: false,
    loading: false,
    children: null,
    error: null,
  }));
}

async function loadRoot(): Promise<void> {
  const version = ++loadVersion;
  loading.value = true;
  error.value = null;
  try {
    const items = await props.listDir('');
    if (version !== loadVersion) return;
    roots.value = toNodes(items);
  } catch (err) {
    if (version !== loadVersion) return;
    error.value = err instanceof Error ? err.message : String(err);
    roots.value = [];
  } finally {
    if (version === loadVersion) loading.value = false;
  }
}

async function toggleNode(node: FileTreeNodeModel): Promise<void> {
  if (node.entry.kind !== 'directory') {
    emit('openFile', { path: node.entry.path });
    return;
  }
  if (node.expanded) {
    node.expanded = false;
    return;
  }
  node.expanded = true;
  if (node.children !== null) return;
  node.loading = true;
  node.error = null;
  try {
    const items = await props.listDir(node.entry.path);
    node.children = toNodes(items);
  } catch (err) {
    node.error = err instanceof Error ? err.message : String(err);
    node.children = null;
    node.expanded = false;
  } finally {
    node.loading = false;
  }
}

function matchesSearch(node: FileTreeNodeModel, q: string): boolean {
  if (!q) return true;
  if (node.entry.name.toLowerCase().includes(q)) return true;
  if (node.children) return node.children.some((child) => matchesSearch(child, q));
  return false;
}

const query = computed(() => search.value.trim().toLowerCase());

const visibleRoots = computed(() => {
  const q = query.value;
  if (!q) return roots.value;
  return roots.value.filter((node) => matchesSearch(node, q));
});

watch(
  () => props.sessionId,
  () => {
    search.value = '';
    void loadRoot();
  },
);

// Reveal the selected row when a file is opened from chat: without this the
// highlight can land silently off-screen inside the scrollable body.
// `flush: 'post'` runs after the DOM update so the row already exists.
watch(
  () => props.selectedPath,
  (path) => {
    if (!path) return;
    bodyEl.value
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  },
  { flush: 'post' },
);

onMounted(() => {
  void loadRoot();
});
</script>

<template>
  <section class="file-tree-panel">
    <PanelHeader
      :title="t('fileTree.title')"
      closable
      :close-label="t('fileTree.close')"
      @close="emit('close')"
    >
      <IconButton
        size="sm"
        :label="t('fileTree.refresh')"
        :disabled="loading"
        @click="loadRoot"
      >
        <Icon
          name="refresh"
          size="sm"
          class="file-tree-panel__refresh"
          :class="{ 'is-spinning': loading }"
        />
      </IconButton>
    </PanelHeader>

    <div class="file-tree-panel__toolbar">
      <label class="file-tree-panel__search">
        <Icon name="search" size="sm" class="file-tree-panel__search-icon" />
        <input
          v-model="search"
          type="search"
          :placeholder="t('fileTree.searchPlaceholder')"
          :aria-label="t('fileTree.searchPlaceholder')"
        />
      </label>
    </div>

    <div ref="bodyEl" class="file-tree-panel__body">
      <div
        v-if="loading && roots.length === 0"
        class="file-tree-panel__state"
        role="status"
      >
        <span aria-hidden="true"><Spinner size="sm" /></span>
        <span>{{ t('fileTree.loading') }}</span>
      </div>
      <EmptyState
        v-else-if="error"
        :title="t('fileTree.loadFailed')"
        :hint="error"
      >
        <Button size="sm" variant="secondary" @click="loadRoot">
          {{ t('fileTree.retry') }}
        </Button>
      </EmptyState>
      <EmptyState
        v-else-if="visibleRoots.length === 0"
        :title="query ? t('fileTree.noMatches') : t('fileTree.empty')"
      />
      <ul v-else class="file-tree" role="tree">
        <FileTreeNode
          v-for="node in visibleRoots"
          :key="node.entry.path"
          :node="node"
          :depth="0"
          :selected-path="selectedPath"
          :query="query"
          :badge-kind="badgeKind"
          :badge-glyph="BADGE_GLYPH"
          @toggle="toggleNode"
        />
      </ul>
    </div>
  </section>
</template>

<style scoped>
.file-tree-panel {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--color-bg);
}
.file-tree-panel__toolbar {
  flex: none;
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--color-line);
}
.file-tree-panel__search {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 8px;
  border: 1px solid var(--color-line);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-text-muted);
}
.file-tree-panel__search:focus-within {
  border-color: var(--color-accent);
}
.file-tree-panel__search-icon {
  flex: none;
  opacity: 0.7;
}
.file-tree-panel__search input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--color-text);
  font: var(--text-sm) / 1.3 var(--font-ui);
}
.file-tree-panel__body {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.file-tree-panel__state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: var(--space-4);
  color: var(--color-text-muted);
  font: var(--text-sm) var(--font-ui);
  text-align: center;
}
/* Refresh glyph spins while the root listing is in flight — the button stays
   disabled, the spin is the progress cue. Same period as the ui Spinner. */
.file-tree-panel__refresh.is-spinning {
  animation: file-tree-refresh-spin 0.85s linear infinite;
}
@keyframes file-tree-refresh-spin {
  to { transform: rotate(360deg); }
}
.file-tree {
  margin: 0;
  padding: var(--space-1) 0;
  list-style: none;
}
.file-tree :deep(.file-tree) {
  margin: 0;
  padding: 0;
  list-style: none;
}
.file-tree :deep(.file-tree__row) {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  height: 28px;
  padding-right: 8px;
  border: 0;
  background: transparent;
  color: var(--color-text);
  font: var(--text-sm) / 1.2 var(--font-ui);
  text-align: left;
  cursor: pointer;
}
.file-tree :deep(.file-tree__row:hover) {
  background: var(--color-hover);
}
.file-tree :deep(.file-tree__item.is-selected > .file-tree__row) {
  background: var(--color-accent-soft);
}
.file-tree :deep(.file-tree__twist) {
  display: inline-flex;
  width: 14px;
  height: 14px;
  flex: none;
  align-items: center;
  justify-content: center;
  color: var(--color-text-muted);
}
.file-tree :deep(.file-tree__icon) {
  display: inline-flex;
  flex: none;
  color: var(--color-text-muted);
}
.file-tree :deep(.file-tree__item.is-dir > .file-tree__row .file-tree__icon) {
  color: var(--color-accent);
}
.file-tree :deep(.file-tree__name) {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-tree :deep(.file-tree__badge) {
  flex: none;
  min-width: 14px;
  text-align: center;
  font: var(--weight-semibold) 10px / 1 var(--font-mono);
  color: var(--color-text-muted);
}
.file-tree :deep(.file-tree__badge.is-modified),
.file-tree :deep(.file-tree__badge.is-renamed) {
  color: var(--color-warning);
}
.file-tree :deep(.file-tree__badge.is-added),
.file-tree :deep(.file-tree__badge.is-untracked) {
  color: var(--color-success);
}
.file-tree :deep(.file-tree__badge.is-deleted),
.file-tree :deep(.file-tree__badge.is-conflicted) {
  color: var(--color-danger);
}
.file-tree :deep(.file-tree__hint) {
  padding: 2px 8px 6px;
  color: var(--color-text-muted);
  font: var(--text-xs) var(--font-ui);
}
.file-tree :deep(.file-tree__hint.is-error) {
  color: var(--color-danger);
}
</style>
