<!-- apps/kimi-web/src/components/settings/ModelPicker.vue -->
<!-- Modal overlay for switching the active session's model. -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AppModel } from '../../api/types';
import { useDialogFocus } from '../../composables/useDialogFocus';
import { formatTokens } from '../../lib/formatTokens';
import Dialog from '../ui/Dialog.vue';
import Button from '../ui/Button.vue';
import IconButton from '../ui/IconButton.vue';
import Icon from '../ui/Icon.vue';
import Input from '../ui/Input.vue';
import Badge from '../ui/Badge.vue';
import Skeleton from '../ui/Skeleton.vue';
import EmptyState from '../ui/EmptyState.vue';

const { t } = useI18n();

const props = defineProps<{
  models: AppModel[];
  current: string;
  starredIds?: string[];
  loading?: boolean;
  /** If true, models could not be fetched (daemon 404 / unsupported) */
  unavailable?: boolean;
}>();

const emit = defineEmits<{
  select: [modelId: string];
  'toggle-star': [modelId: string];
  manage: [];
  close: [];
}>();

const starredSet = computed(() => new Set(props.starredIds ?? []));
function isStarred(modelId: string): boolean {
  return starredSet.value.has(modelId);
}

// Content-shaped loading ghost: per-row name-line widths so the skeleton
// reads as an organic list rather than a stamped pattern.
const SKEL_NAME_WIDTHS = ['46%', '34%', '52%', '40%', '28%'];

// -------------------------------------------------------------------------
// Search + filtered list
// -------------------------------------------------------------------------

const query = ref('');
const searchRef = ref<HTMLInputElement | null>(null);
const dialogRef = ref<HTMLElement | null>(null);
const activeTab = ref('all');

// Focus the search box on open; restore focus to the opener on close.
useDialogFocus(dialogRef, searchRef);

const providerTabs = computed(() => {
  const seen = new Set<string>();
  const tabs: { id: string; label: string }[] = [{ id: 'all', label: t('model.allTab') }];
  for (const model of props.models) {
    if (seen.has(model.provider)) continue;
    seen.add(model.provider);
    tabs.push({ id: model.provider, label: model.provider });
  }
  return tabs;
});

const filtered = computed<AppModel[]>(() => {
  const q = query.value.toLowerCase().trim();
  const list = props.models.filter((m) => {
    if (activeTab.value !== 'all' && m.provider !== activeTab.value) return false;
    const matchName = (m.displayName ?? m.model).toLowerCase().includes(q);
    const matchProvider = m.provider.toLowerCase().includes(q);
    const matchId = m.id.toLowerCase().includes(q);
    return !q || matchName || matchProvider || matchId;
  });
  if (activeTab.value !== 'all') return list;
  // In the "All" tab, starred models are pinned to the top while preserving
  // the original order within each group.
  return list.sort((a, b) => {
    const aStarred = isStarred(a.id) ? 1 : 0;
    const bStarred = isStarred(b.id) ? 1 : 0;
    return bStarred - aStarred;
  });
});

const flat = computed<AppModel[]>(() => filtered.value);
const selectedIdx = ref(0);

// Reset selection when filter changes
watch([query, activeTab], () => { selectedIdx.value = 0; });
watch(providerTabs, (tabs) => {
  if (!tabs.some((tab) => tab.id === activeTab.value)) activeTab.value = 'all';
});
watch(flat, (items) => {
  selectedIdx.value = Math.min(selectedIdx.value, Math.max(items.length - 1, 0));
});

// -------------------------------------------------------------------------
// Keyboard navigation
// -------------------------------------------------------------------------

function handleKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    emit('close');
    return;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    selectedIdx.value = Math.min(selectedIdx.value + 1, flat.value.length - 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    selectedIdx.value = Math.max(selectedIdx.value - 1, 0);
  } else if (e.key === 'Enter') {
    const m = flat.value[selectedIdx.value];
    if (m) {
      emit('select', m.id);
    }
  }
}

onMounted(() => {
  document.addEventListener('keydown', handleKeydown);
});
onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown);
});

function choose(modelId: string): void {
  emit('select', modelId);
}

function flatIdx(m: AppModel): number {
  return flat.value.indexOf(m);
}

function selectTab(tabId: string): void {
  activeTab.value = tabId;
}
</script>

<template>
  <Dialog :open="true" :close-on-esc="false" :title="t('model.title')" size="xl" height="fixed" @close="emit('close')">
    <div ref="dialogRef" class="mp">
      <!-- Search -->
      <div class="search-wrap">
        <Input
          ref="searchRef"
          v-model="query"
          :placeholder="t('model.searchPlaceholder')"
          autocomplete="off"
          spellcheck="false"
          autofocus
        />
      </div>

      <div v-if="providerTabs.length > 1" class="tab-strip">
        <Button
          v-for="tab in providerTabs"
          :key="tab.id"
          :variant="tab.id === activeTab ? 'secondary' : 'ghost'"
          size="sm"
          @click="selectTab(tab.id)"
        >
          {{ tab.label }}
        </Button>
      </div>

      <!-- Loading state — content-shaped skeleton rows mirroring the model
           list (breathing Skeleton bars) instead of a bare spinner, so the
           dialog already reads as list-shaped while models load. -->
      <div v-if="loading" class="mp-loading">
        <div class="mp-loading-skel" aria-hidden="true">
          <div v-for="(nameWidth, i) in SKEL_NAME_WIDTHS" :key="i" class="skel-row">
            <Skeleton circle width="14px" height="14px" />
            <span class="skel-main">
              <Skeleton :width="nameWidth" height="12px" />
              <Skeleton width="62%" height="10px" />
            </span>
            <Skeleton class="skel-provider" width="72px" height="10px" />
            <Skeleton width="52px" height="10px" />
          </div>
        </div>
        <span class="mp-loading-text">{{ t('model.loading') }}</span>
      </div>

      <!-- Unavailable state (daemon 404 / endpoint not supported) -->
      <div v-else-if="unavailable" class="state-row unavail">
        <Icon name="alert-triangle" size="lg" />
        <span>{{ t('model.unavailable') }}</span>
      </div>

      <!-- Model list -->
      <div v-else class="model-list">
        <div
          v-for="m in flat"
          :key="m.id"
          class="model-row"
          :class="{
            'is-current': m.id === current,
            'is-selected': flatIdx(m) === selectedIdx,
          }"
          role="option"
          :aria-selected="m.id === current"
          @click="choose(m.id)"
          @mouseenter="selectedIdx = flatIdx(m)"
        >
          <span class="check">
            <Icon v-if="m.id === current" name="check" size="sm" />
          </span>
          <span class="model-main">
            <span class="model-name">{{ m.displayName ?? m.model }}</span>
            <span class="model-id">{{ m.id }}</span>
            <span v-if="m.capabilities && m.capabilities.length > 0" class="caps">
              <Badge v-for="cap in m.capabilities" :key="cap" variant="info" size="sm">{{ cap }}</Badge>
            </span>
          </span>
          <span class="model-provider">{{ m.provider }}</span>
          <span class="model-ctx">{{ t('model.contextSuffix', { size: formatTokens(m.maxContextSize) }) }}</span>
          <IconButton
            size="sm"
            :label="isStarred(m.id) ? t('model.unstarTitle') : t('model.starTitle')"
            @click.stop="emit('toggle-star', m.id)"
          >
            <Icon v-if="isStarred(m.id)" name="star" size="md" />
            <Icon v-else name="star-outline" size="md" />
          </IconButton>
        </div>
        <EmptyState
          v-if="flat.length === 0 && !loading && !unavailable"
          :title="props.models.length === 0 ? t('model.emptyNoModels') : t('model.emptyNoMatch')"
          :hint="props.models.length === 0 ? t('model.manageProviders') : 'Try a different search term or provider tab'"
        >
          <template #icon>
            <Icon :name="props.models.length === 0 ? 'sparkles' : 'search'" size="lg" />
          </template>
        </EmptyState>
      </div>

      <!-- Footer hint -->
      <div class="footer">
        <span class="footer-hint">{{ t('model.footerHint') }}</span>
        <Button variant="secondary" size="sm" @click="emit('manage')">
          <Icon name="settings" size="sm" />
          {{ t('model.manageProviders') }}
        </Button>
      </div>
    </div>
  </Dialog>
</template>

<style scoped>
.mp { display: flex; flex-direction: column; gap: var(--space-2); }

/* Search */
.search-wrap { padding-bottom: var(--space-1); }

.tab-strip {
  display: flex;
  gap: var(--space-1);
  overflow-x: auto;
}

/* Model list */
.model-list {
  display: flex;
  flex-direction: column;
  padding: var(--space-1) 0;
  /* One-shot entrance when the list mounts after loading (shared
     kimi-card-in keyframe; reduced-motion covered by the global kill-switch). */
  animation: kimi-card-in var(--duration-slow) var(--ease-out) both;
}

.model-row {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-2);
  border-radius: var(--radius-md);
  cursor: pointer;
  color: var(--color-text);
  min-width: 0;
  transition: background var(--duration-fast) var(--ease-out), box-shadow var(--duration-fast) var(--ease-out);
}
.model-row:hover, .model-row.is-selected {
  background: var(--color-surface-sunken);
}
.model-row.is-current {
  background: var(--color-accent-soft);
  box-shadow: inset 0 0 0 1px var(--color-accent-bd);
}

.check {
  width: 14px;
  height: 14px;
  color: var(--color-accent);
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
}
.model-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.model-name {
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  color: var(--color-text);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.model-id {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.model-provider {
  flex: none;
  max-width: 110px;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.model-ctx {
  flex: none;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}
.caps {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 2px;
}

.state-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-5) 0;
  color: var(--color-text-muted);
  font-family: var(--font-ui);
  font-size: var(--text-base);
}
.state-row.unavail { color: var(--color-warning); }

/* Content-shaped loading ghost: rows mirror .model-row's column layout
   (check dot · name/id stack · provider · context) built from Skeleton bars.
   The breathing loop lives in Skeleton.vue's own scoped styles. */
.mp-loading {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-1) 0;
  /* Same one-shot entrance as the loaded list (element mounts once per
     loading=true window and is static until it unmounts). */
  animation: kimi-card-in var(--duration-slow) var(--ease-out) both;
}
.mp-loading-skel {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.skel-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-2);
}
.skel-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.mp-loading-text {
  color: var(--color-text-muted);
  font-family: var(--font-ui);
  font-size: var(--text-sm);
}

/* Footer */
.footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding-top: var(--space-2);
  border-top: 1px solid var(--color-line);
}
.footer-hint {
  color: var(--color-text-faint);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
}

@media (max-width: 640px) {
  .model-provider,
  .caps {
    display: none;
  }
  /* Compound selector so it beats Skeleton.vue's scoped root `display: block`
     regardless of style injection order (mirrors the real row, which hides
     .model-provider here). */
  .skel-row .skel-provider {
    display: none;
  }
}
</style>
