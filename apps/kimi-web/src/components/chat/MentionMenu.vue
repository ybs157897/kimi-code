<!-- apps/kimi-web/src/components/chat/MentionMenu.vue -->
<!-- Unified popup for expert teams and file paths shown when the user types @. -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { iconSvg } from '../../lib/icons';
import Skeleton from '../ui/Skeleton.vue';
import type { FileItem, MentionItem } from '../../types';

// Re-exported for the .vue consumers (Composer / ChatDock / ConversationPane)
// that import FileItem from this component.
export type { FileItem };

const props = defineProps<{
  items: MentionItem[];
  activeIndex: number;
  loading: boolean;
}>();

const emit = defineEmits<{
  select: [item: MentionItem];
  hover: [index: number];
}>();

const { t } = useI18n();

// ---------------------------------------------------------------------------
// File-type glyphs: small line-SVG icons (viewBox 0 0 16 16) keyed off the
// extension. Categories: folder, code, doc/markdown, image, generic.
// Subtle + muted; never an emoji.
// ---------------------------------------------------------------------------

const ICON_FOLDER = iconSvg('folder', 'sm');
const ICON_CODE = iconSvg('code', 'sm');
const ICON_DOC = iconSvg('file-text', 'sm');
const ICON_IMAGE = iconSvg('image', 'sm');
const ICON_GENERIC = iconSvg('file', 'sm');
const ICON_TEAM = iconSvg('team', 'sm');

const CODE_EXT = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'json', 'py', 'go', 'rs',
  'java', 'kt', 'c', 'h', 'cpp', 'cc', 'hpp', 'cs', 'rb', 'php', 'swift',
  'sh', 'bash', 'zsh', 'css', 'scss', 'less', 'html', 'htm', 'xml', 'sql',
  'yaml', 'yml', 'toml', 'lua', 'dart', 'scala', 'clj', 'ex', 'exs',
]);
const DOC_EXT = new Set(['md', 'markdown', 'mdx', 'txt', 'rst', 'adoc', 'pdf', 'doc', 'docx']);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico', 'avif']);

function fileIcon(item: FileItem): string {
  const path = item.path;
  // Trailing slash → folder.
  if (path.endsWith('/')) return ICON_FOLDER;
  const base = item.name || path.split('/').pop() || path;
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  if (!ext) return ICON_GENERIC;
  if (CODE_EXT.has(ext)) return ICON_CODE;
  if (DOC_EXT.has(ext)) return ICON_DOC;
  if (IMAGE_EXT.has(ext)) return ICON_IMAGE;
  return ICON_GENERIC;
}

function itemIcon(item: MentionItem): string {
  return item.kind === 'expert-team' ? ICON_TEAM : fileIcon(item);
}

function itemDetail(item: MentionItem): string {
  return item.kind === 'expert-team' ? item.description : item.path;
}
</script>

<template>
  <div class="mention-menu" role="listbox">
    <!-- Loading state — item-shaped breathing Skeleton rows (the pulse loop
         lives in Skeleton.vue's own scoped styles); the searching label stays
         visually hidden for assistive tech. -->
    <div v-if="props.loading && props.items.length === 0" class="mention-loading">
      <span class="mention-loading-label">{{ t('mention.searching') }}</span>
      <div class="mention-loading-row" aria-hidden="true">
        <Skeleton circle width="13px" height="13px" />
        <Skeleton width="34%" height="10px" />
        <Skeleton width="52%" height="9px" />
      </div>
      <div class="mention-loading-row" aria-hidden="true">
        <Skeleton circle width="13px" height="13px" />
        <Skeleton width="26%" height="10px" />
        <Skeleton width="60%" height="9px" />
      </div>
      <div class="mention-loading-row" aria-hidden="true">
        <Skeleton circle width="13px" height="13px" />
        <Skeleton width="40%" height="10px" />
        <Skeleton width="44%" height="9px" />
      </div>
    </div>

    <!-- Empty state (not loading, no items) -->
    <div v-else-if="props.items.length === 0" class="mention-state dim">{{ t('mention.noMatch') }}</div>

    <template v-else>
      <template v-for="(item, i) in props.items" :key="item.kind === 'expert-team' ? item.pluginId : item.path">
        <div
          v-if="i === 0 || props.items[i - 1]?.kind !== item.kind"
          class="mention-group-label"
          role="presentation"
        >
          {{ item.kind === 'expert-team' ? t('mention.expertTeams') : t('mention.files') }}
        </div>
        <div
          class="mention-item"
          :class="[{ active: i === props.activeIndex }, `mention-item--${item.kind}`]"
          role="option"
          :aria-selected="i === props.activeIndex"
          @mouseenter="emit('hover', i)"
          @mousedown.prevent="emit('select', item)"
        >
          <!-- eslint-disable-next-line vue/no-v-html -->
          <span class="mention-icon" v-html="itemIcon(item)" aria-hidden="true" />
          <span class="mention-copy">
            <span class="mention-name">{{ item.name }}</span>
            <span class="mention-path">{{ itemDetail(item) }}</span>
          </span>
          <span v-if="item.kind === 'expert-team'" class="mention-action">{{ t('mention.activate') }}</span>
        </div>
      </template>
      <div v-if="props.loading" class="mention-searching">{{ t('mention.searchingFiles') }}</div>
    </template>
  </div>
</template>

<style scoped>
/* `[role="listbox"]` raises specificity (0,3,0) so the redesign's surface +
   shadow-md win over any global menu styles. */
.mention-menu[role="listbox"] {
  position: absolute;
  bottom: calc(100% + 4px);
  left: 0;
  right: 0;
  padding: var(--space-1);
  background: var(--color-surface-raised);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
  z-index: var(--z-dropdown);
  max-height: 220px;
  overflow-y: auto;
  /* Self-contained mount entrance (the Composer v-ifs us in without a
     Transition wrapper): quiet fade + small rise up from the composer.
     Reduced motion is covered by the global kill-switch in style.css. */
  animation: mention-menu-in var(--duration-base) var(--ease-out);
}

@keyframes mention-menu-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}

.mention-state {
  padding: 8px 12px;
  font-family: var(--font-ui);
  font-size: var(--text-sm);
}

.dim {
  color: var(--color-text-muted);
}

/* Loading ghost: three item-shaped rows built from Skeleton bars, so the
   popup already reads as a file list while the search runs. */
.mention-loading {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 2px 0;
}

.mention-loading-row {
  display: flex;
  align-items: center;
  gap: 8px;
  /* Match .mention-item metrics so results swap in without a layout jump. */
  padding: 6px 10px;
}

/* Visually hidden but readable by AT — replaces the old visible searching
   line (Skeleton bars are aria-hidden). */
.mention-loading-label {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}

.mention-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  cursor: pointer;
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  border-radius: var(--radius-sm);
  /* Arrow-key navigation glides between rows instead of snapping. */
  transition: background-color var(--duration-fast) var(--ease-out);
}

.mention-group-label {
  padding: var(--space-2) var(--space-3) var(--space-1);
  color: var(--color-text-faint);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
}

.mention-copy {
  display: flex;
  flex: 1;
  min-width: 0;
  align-items: baseline;
  gap: var(--space-2);
}

.mention-action {
  flex: none;
  color: var(--color-accent);
  font-size: var(--text-xs);
}

.mention-searching {
  padding: var(--space-2) var(--space-3);
  color: var(--color-text-faint);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
}

.mention-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  color: var(--color-text-faint);
  flex-shrink: 0;
}

/* Pin every glyph to the same 14px box so rows line up regardless of icon kind. */
.mention-icon :deep(svg) {
  width: 13px;
  height: 13px;
  display: block;
}

.mention-item:hover .mention-icon,
.mention-item.active .mention-icon {
  color: var(--color-text-muted);
}

.mention-item:hover {
  background: var(--color-surface-sunken);
}
.mention-item.active {
  background: var(--color-accent-soft);
}

.mention-name {
  color: var(--color-text);
  font-weight: 500;
  min-width: 80px;
  flex-shrink: 0;
}

.mention-item--expert-team .mention-name { min-width: 130px; }

.mention-path {
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---- Menu surface defaults ---- */
.mention-menu { border-radius: var(--radius-lg); box-shadow: var(--sh); }
.mention-state { font-family: var(--sans); }
</style>
