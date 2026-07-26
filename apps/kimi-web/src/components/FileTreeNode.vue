<!-- Recursive node for FileTreePanel. Emits toggle so the parent owns loading. -->
<script setup lang="ts">
import { computed } from 'vue';
import type { FsEntry } from '../api/types';
import Icon from './ui/Icon.vue';

defineOptions({ name: 'FileTreeNode' });

export interface FileTreeNodeModel {
  entry: FsEntry;
  expanded: boolean;
  loading: boolean;
  children: FileTreeNodeModel[] | null;
  error: string | null;
}

export type FileTreeBadgeKind =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'untracked'
  | 'conflicted'
  | 'ignored'
  | 'unknown';

const props = defineProps<{
  node: FileTreeNodeModel;
  depth: number;
  selectedPath?: string | null;
  query: string;
  badgeKind: (status: string | undefined) => FileTreeBadgeKind | null;
  badgeGlyph: Record<FileTreeBadgeKind, string>;
}>();

const emit = defineEmits<{
  toggle: [node: FileTreeNodeModel];
}>();

const isDir = computed(() => props.node.entry.kind === 'directory');
const selected = computed(() => props.selectedPath === props.node.entry.path);
const badge = computed(() => props.badgeKind(props.node.entry.gitStatus));

function nodeMatches(node: FileTreeNodeModel, q: string): boolean {
  if (!q) return true;
  if (node.entry.name.toLowerCase().includes(q)) return true;
  if (!node.children) return false;
  return node.children.some((child) => nodeMatches(child, q));
}

const visibleChildren = computed(() => {
  const children = props.node.children;
  if (!children) return [];
  if (!props.query) return children;
  return children.filter((child) => nodeMatches(child, props.query));
});
</script>

<template>
  <li
    class="file-tree__item"
    :class="{
      'is-dir': isDir,
      'is-selected': selected,
      'is-expanded': node.expanded,
    }"
    role="treeitem"
    :aria-expanded="isDir ? node.expanded : undefined"
    :aria-selected="selected"
  >
    <button
      type="button"
      class="file-tree__row"
      :style="{ paddingLeft: `${8 + depth * 14}px` }"
      @click="emit('toggle', node)"
    >
      <span class="file-tree__twist">
        <Icon
          v-if="isDir"
          :name="node.expanded ? 'chevron-down' : 'chevron-right'"
          size="sm"
        />
      </span>
      <span class="file-tree__icon">
        <Icon
          :name="isDir ? (node.expanded ? 'folder' : 'folder-closed') : 'file'"
          size="sm"
        />
      </span>
      <span class="file-tree__name">{{ node.entry.name }}</span>
      <span
        v-if="badge"
        class="file-tree__badge"
        :class="`is-${badge}`"
      >{{ badgeGlyph[badge] }}</span>
    </button>

    <div
      v-if="node.loading"
      class="file-tree__hint"
      :style="{ paddingLeft: `${22 + depth * 14}px` }"
    >
      …
    </div>
    <div
      v-else-if="node.error"
      class="file-tree__hint is-error"
      :style="{ paddingLeft: `${22 + depth * 14}px` }"
    >
      {{ node.error }}
    </div>

    <ul
      v-if="node.expanded && visibleChildren.length > 0"
      class="file-tree"
      role="group"
    >
      <FileTreeNode
        v-for="child in visibleChildren"
        :key="child.entry.path"
        :node="child"
        :depth="depth + 1"
        :selected-path="selectedPath"
        :query="query"
        :badge-kind="badgeKind"
        :badge-glyph="badgeGlyph"
        @toggle="emit('toggle', $event)"
      />
    </ul>
  </li>
</template>
