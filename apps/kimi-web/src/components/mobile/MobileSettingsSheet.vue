<!-- apps/kimi-web/src/components/mobile/MobileSettingsSheet.vue -->
<!-- Mobile settings: a bottom sheet that surfaces the desktop Composer-toolbar -->
<!-- controls as big tappable rows — model (opens ModelPicker), thinking level -->
<!-- (inline cycle picker), plan mode (toggle), permission (cycle), and a -->
<!-- read-only context-usage meter — plus the desktop settings-popover prefs -->
<!-- (theme / color scheme / language) and the sign-in/out entry, which previously -->
<!-- had no mobile counterpart. -->
<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ConversationStatus, PermissionMode } from '../../types';
import type { AppModel, AppSession, ThinkingLevel } from '../../api/types';
import type { ColorScheme } from '../../composables/useKimiWebClient';
import { useKimiWebClient } from '../../composables/useKimiWebClient';
import {
  commitLevel,
  effectiveThinkingLevel,
  effortLabel,
  modelThinkingAvailability,
  segmentsFor,
} from '../../lib/modelThinking';
import BottomSheet from '../dialogs/BottomSheet.vue';
import LanguageSwitcher from '../settings/LanguageSwitcher.vue';
import { formatTokens } from '../../lib/formatTokens';
import Button from '../ui/Button.vue';
import EmptyState from '../ui/EmptyState.vue';
import Icon from '../ui/Icon.vue';
import Input from '../ui/Input.vue';
import SegmentedControl from '../ui/SegmentedControl.vue';
import Skeleton from '../ui/Skeleton.vue';
import Toast from '../ui/Toast.vue';

const { t } = useI18n();

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    status: ConversationStatus;
    thinking?: ThinkingLevel;
    planMode?: boolean;
    swarmMode?: boolean;
    colorScheme?: ColorScheme;
    uiFontSize?: number;
    authReady?: boolean;
    conversationToc?: boolean;
    /** Server version from GET /api/v1/meta, shown as a read-only row. */
    serverVersion?: string;
    /** Available models — used to derive the current model's thinking segments. */
    models?: AppModel[];
  }>(),
  {
    colorScheme: 'system',
    uiFontSize: 14,
    authReady: false,
    serverVersion: '',
    models: () => [],
  },
);

const emit = defineEmits<{
  'update:modelValue': [open: boolean];
  pickModel: [];
  setThinking: [level: ThinkingLevel];
  togglePlan: [];
  toggleSwarm: [];
  setPermission: [mode: PermissionMode];
  setColorScheme: [colorScheme: ColorScheme];
  setUiFontSize: [size: number];
  setConversationToc: [on: boolean];
  login: [];
  logout: [];
}>();

function onColorScheme(v: string): void {
  emit('setColorScheme', v as ColorScheme);
}

const PERM_MODES: PermissionMode[] = ['manual', 'auto', 'yolo'];

// Identity is the model id — display/model names can collide across providers.
const currentModel = computed<AppModel | undefined>(() =>
  props.models?.find((m) => m.id === props.status?.modelId),
);
const thinkingAvailability = computed(() => modelThinkingAvailability(currentModel.value));
const thinkingSegments = computed(() => segmentsFor(currentModel.value));
// The client resolves the level per model (the model's stored pick when still
// declared, else the catalog default), so what arrives here is valid for the
// active model. An undeclared level can only appear transiently, before the
// catalog loads, and simply highlights no segment.
const thinkingLevel = computed(() => effectiveThinkingLevel(currentModel.value, props.thinking));
const activeThinkingSegment = computed<string>(() => {
  const segs = thinkingSegments.value;
  return segs.includes(thinkingLevel.value) ? thinkingLevel.value : '';
});
const thinkingOptions = computed(() =>
  thinkingSegments.value.map((seg) => ({ value: seg, label: effortLabel(seg) })),
);
const planOn = computed<boolean>(() => props.planMode === true);
const swarmOn = computed<boolean>(() => props.swarmMode === true);

const permColor = computed<string>(() => {
  const p = props.status.permission;
  if (p === 'yolo') return 'var(--color-danger)';
  if (p === 'auto') return 'var(--color-warning)';
  return 'var(--color-text-muted)';
});
/** Permission sub-line, e.g. "manual · confirm every tool". */
const permSub = computed<string>(() => {
  const p = props.status.permission;
  const desc = p === 'yolo' ? t('mobile.permYoloSub') : p === 'auto' ? t('mobile.permAutoSub') : t('mobile.permManualSub');
  return `${p} · ${desc}`;
});

const ctxPct = computed<number>(() =>
  // ceil (not round) so sub-0.5% usage still renders a visible bar sliver.
  props.status.ctxMax > 0
    ? Math.min(100, Math.max(0, Math.ceil((props.status.ctxUsed / props.status.ctxMax) * 100)))
    : 0,
);
// Shared 1024-based formatter, same as the desktop tooltip / status panel.
const ctxValue = computed<string>(() =>
  props.status.ctxMax > 0 ? `${formatTokens(props.status.ctxUsed)}/${formatTokens(props.status.ctxMax)}` : t('status.statusNone'),
);

function setThinkingSegment(value: string): void {
  emit('setThinking', commitLevel(currentModel.value, value));
}

function cyclePermission(): void {
  const idx = PERM_MODES.indexOf(props.status.permission);
  const next = PERM_MODES[(idx + 1) % PERM_MODES.length]!;
  emit('setPermission', next);
}

function onPickModel(): void {
  emit('pickModel');
  emit('update:modelValue', false);
}

function onLogin(): void {
  emit('login');
  emit('update:modelValue', false);
}

function onLogout(): void {
  emit('logout');
  emit('update:modelValue', false);
}

// ---------------------------------------------------------------------------
// Archived-sessions sub-view — mirrors the desktop Settings "Archived" tab so
// the mobile archive confirmation (which points users to Settings to restore)
// is true here too. Loads all archived sessions once when the view opens;
// search + sort run client-side over the full set.
// ---------------------------------------------------------------------------
const client = useKimiWebClient();
type SheetView = 'main' | 'archived';
const view = ref<SheetView>('main');
/** Direction of the next main↔archived swap: forward drifts the incoming
    archived view in from the right, back drifts the main view in from the
    left, so the lateral navigation reads directionally. */
const viewSwapName = ref<'view-fwd' | 'view-back'>('view-fwd');

const archivedItems = ref<AppSession[]>([]);
const archivedLoading = ref(false);
const archivedLoaded = ref(false);
const archiveQuery = ref('');
const archiveSort = ref<'archived-desc' | 'created-desc' | 'name-asc'>('archived-desc');

const ARCHIVED_PAGE_SIZE = 100;

async function loadAllArchived(): Promise<void> {
  if (archivedLoading.value) return;
  archivedLoading.value = true;
  archivedLoaded.value = false;
  try {
    const all: AppSession[] = [];
    let beforeId: string | undefined;
    for (;;) {
      const page = await client.loadArchivedSessions({ beforeId, pageSize: ARCHIVED_PAGE_SIZE });
      all.push(...page.items);
      if (!page.hasMore || page.items.length === 0) break;
      const next = page.items.at(-1)?.id;
      if (next === undefined) break;
      beforeId = next;
    }
    archivedItems.value = all;
    archivedLoaded.value = true;
  } catch (err) {
    console.warn('loadAllArchived failed', err);
  } finally {
    archivedLoading.value = false;
  }
}

function openArchived(): void {
  viewSwapName.value = 'view-fwd';
  view.value = 'archived';
  archiveQuery.value = '';
  void loadAllArchived();
}

function backToMain(): void {
  viewSwapName.value = 'view-back';
  view.value = 'main';
}

const filteredArchived = computed<AppSession[]>(() => {
  const q = archiveQuery.value.trim().toLowerCase();
  let rows = archivedItems.value.filter((s) => s.archived === true);
  if (q) rows = rows.filter((s) => s.title.toLowerCase().includes(q));
  rows = rows.slice();
  if (archiveSort.value === 'archived-desc') {
    rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } else if (archiveSort.value === 'created-desc') {
    rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } else {
    rows.sort((a, b) => a.title.localeCompare(b.title, 'zh'));
  }
  return rows;
});

// Restore confirmation — the restored row simply leaves the list, so without
// a toast the tap would read as a silent deletion. The toast auto-dismisses;
// its timer is cleared on manual dismiss and on unmount.
const restoreToast = ref<{ title: string } | null>(null);
let restoreToastTimer: ReturnType<typeof setTimeout> | undefined;

function showRestoreToast(title: string): void {
  if (restoreToastTimer !== undefined) clearTimeout(restoreToastTimer);
  restoreToast.value = { title };
  restoreToastTimer = setTimeout(() => {
    restoreToastTimer = undefined;
    restoreToast.value = null;
  }, 4000);
}

function dismissRestoreToast(): void {
  if (restoreToastTimer !== undefined) clearTimeout(restoreToastTimer);
  restoreToastTimer = undefined;
  restoreToast.value = null;
}

onUnmounted(() => {
  if (restoreToastTimer !== undefined) clearTimeout(restoreToastTimer);
});

async function onRestore(id: string): Promise<void> {
  const ok = await client.restoreSession(id);
  if (!ok) return;
  const title = archivedItems.value.find((s) => s.id === id)?.title ?? '';
  archivedItems.value = archivedItems.value.filter((s) => s.id !== id);
  showRestoreToast(title);
}

function archiveTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Reset to the main view whenever the sheet is closed, so reopening starts at
// the top rather than mid-list.
watch(
  () => props.modelValue,
  (open) => {
    if (!open) {
      viewSwapName.value = 'view-back';
      view.value = 'main';
    }
  },
);
</script>

<template>
  <BottomSheet
    :model-value="modelValue"
    :title="t('mobile.settingsTitle')"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <Transition :name="viewSwapName" mode="out-in">
    <div v-if="view === 'main'" key="main" class="sheet-view">
    <div class="group-title">{{ t('mobile.groupSession') }}</div>

    <!-- Model → opens ModelPicker -->
    <button type="button" class="srow" @click="onPickModel">
      <span class="srow-main">
        <span class="srow-label">{{ t('status.statusModel') }}</span>
        <span class="srow-sub">{{ status.model }}</span>
      </span>
      <span class="chev">›</span>
    </button>

    <!-- Thinking level → segmented control (or read-only value when single/unsupported) -->
    <div class="srow read-only">
      <span class="srow-main">
        <span class="srow-label">{{ t('status.statusThinking') }}</span>
        <span
          v-if="thinkingAvailability === 'unsupported'"
          class="srow-sub"
        >{{ t('status.modeNotSupported') }}</span>
      </span>
      <SegmentedControl
        v-if="thinkingSegments.length > 1"
        :model-value="activeThinkingSegment"
        :options="thinkingOptions"
        size="sm"
        @update:model-value="setThinkingSegment"
      />
      <span
        v-else
        class="srow-val"
        :class="{ dim: thinkingLevel === 'off' }"
      >{{ thinkingLevel === 'off' ? t('status.planOff') : effortLabel(thinkingLevel) }}</span>
    </div>

    <!-- Prompt-cache invalidation note — same text as the desktop model dropdown,
         covering both the model row above and this thinking control. -->
    <div class="cache-note">{{ t('status.cacheNote') }}</div>

    <!-- Plan mode → real toggle switch -->
    <button type="button" class="srow" @click="emit('togglePlan')">
      <span class="srow-main">
        <span class="srow-label">{{ t('status.statusPlanMode') }}</span>
        <span class="srow-sub">{{ t('mobile.planModeSub') }}</span>
      </span>
      <span class="toggle" :class="{ on: planOn }" role="switch" :aria-checked="planOn" />
    </button>

    <!-- Swarm mode → real toggle switch -->
    <button type="button" class="srow" @click="emit('toggleSwarm')">
      <span class="srow-main">
        <span class="srow-label">{{ t('status.statusSwarmMode') }}</span>
        <span class="srow-sub">{{ t('mobile.swarmModeSub') }}</span>
      </span>
      <span class="toggle" :class="{ on: swarmOn }" role="switch" :aria-checked="swarmOn" />
    </button>

    <!-- Permission → cycle (sub-line + chevron) -->
    <button type="button" class="srow" @click="cyclePermission">
      <span class="srow-main">
        <span class="srow-label">{{ t('status.statusPermission') }}</span>
        <span class="srow-sub" :style="{ color: permColor }">{{ permSub }}</span>
      </span>
      <span class="chev">›</span>
    </button>

    <!-- Context usage → read-only mini meter + value -->
    <div class="srow read-only">
      <span class="srow-main">
        <span class="srow-label">{{ t('status.statusContext') }}</span>
        <span class="srow-sub">{{ ctxValue }}</span>
      </span>
      <span class="ctx-meter" :aria-label="ctxValue">
        <i :style="{ width: ctxPct + '%' }" />
      </span>
    </div>

    <div class="group-title">{{ t('mobile.groupApp') }}</div>

    <!-- Archived sessions → opens the archived restore sub-view -->
    <button type="button" class="srow" @click="openArchived">
      <span class="srow-main">
        <span class="srow-label">{{ t('mobile.archivedSessions') }}</span>
        <span class="srow-sub">{{ t('mobile.archivedSessionsSub') }}</span>
      </span>
      <span class="chev">›</span>
    </button>

    <!-- App preferences (the desktop settings-popover controls) -->
    <div class="srow read-only pref">
      <span class="srow-main">
        <span class="srow-label">{{ t('theme.colorSchemeLabel') }}</span>
      </span>
      <SegmentedControl
        :model-value="colorScheme ?? 'system'"
        :options="[
          { value: 'light', label: t('theme.light') },
          { value: 'dark', label: t('theme.dark') },
          { value: 'system', label: t('theme.system') },
        ]"
        @update:model-value="onColorScheme"
      />
    </div>

    <div class="srow read-only pref">
      <span class="srow-main">
        <span class="srow-label">{{ t('sidebar.language') }}</span>
      </span>
      <LanguageSwitcher />
    </div>

    <div class="srow read-only pref">
      <span class="srow-main">
        <span class="srow-label">{{ t('settings.uiFontSize') }}</span>
      </span>
      <label class="num-field">
        <input
          class="num-input"
          type="number"
          min="12"
          max="20"
          step="1"
          :value="uiFontSize"
          :aria-label="t('settings.uiFontSize')"
          @input="emit('setUiFontSize', Number(($event.target as HTMLInputElement).value))"
        />
        <span class="num-unit">px</span>
      </label>
    </div>

    <button type="button" class="srow" @click="emit('setConversationToc', !conversationToc)">
      <span class="srow-main">
        <span class="srow-label">{{ t('settings.conversationToc') }}</span>
        <span class="srow-sub">{{ t('settings.conversationTocHint') }}</span>
      </span>
      <span class="toggle" :class="{ on: conversationToc }" role="switch" :aria-checked="conversationToc" />
    </button>

    <!-- Account: sign in / out -->
    <button v-if="authReady" type="button" class="srow acct out" @click="onLogout">
      <span class="srow-main">
        <span class="srow-label">{{ t('sidebar.signOut') }}</span>
      </span>
    </button>
    <button v-else type="button" class="srow acct in" @click="onLogin">
      <span class="srow-main">
        <span class="srow-label">{{ t('sidebar.signIn') }}</span>
      </span>
    </button>

    <!-- Server version -->
    <div v-if="serverVersion" class="srow read-only">
      <span class="srow-main">
        <span class="srow-label">{{ t('settings.serverVersion') }}</span>
      </span>
      <span class="srow-val dim">{{ serverVersion }}</span>
    </div>
    </div>

    <div v-else key="archived" class="sheet-view">
      <!-- Archived sessions sub-view -->
      <div class="arch-subhead">
        <button type="button" class="arch-back" @click="backToMain">
          <span class="chev back">‹</span> {{ t('mobile.archivedBack') }}
        </button>
        <span class="arch-count">{{ t('mobile.sessionCount', { n: filteredArchived.length }) }}</span>
      </div>

      <div class="arch-tools">
        <Input
          class="arch-search-input"
          :model-value="archiveQuery"
          size="sm"
          :placeholder="t('settings.archivedSearch')"
          @update:model-value="archiveQuery = $event"
        />
        <SegmentedControl
          size="sm"
          :model-value="archiveSort"
          :options="[
            { value: 'archived-desc', label: t('settings.archivedSortArchived') },
            { value: 'created-desc', label: t('settings.archivedSortCreated') },
            { value: 'name-asc', label: t('settings.archivedSortName') },
          ]"
          @update:model-value="archiveSort = $event as 'archived-desc' | 'created-desc' | 'name-asc'"
        />
      </div>

      <!-- Skeleton rows in the exact .arch-row geometry while the full set
           pages in (the loading text lives on as the status aria-label). -->
      <div
        v-if="archivedLoading"
        class="arch-skeletons"
        role="status"
        :aria-label="t('settings.archivedLoadingAll')"
      >
        <div v-for="n in 4" :key="n" class="arch-row arch-skel">
          <div class="arch-meta">
            <Skeleton :width="`${46 + n * 8}%`" height="14px" />
            <Skeleton width="40%" height="10px" />
          </div>
          <Skeleton width="64px" height="26px" />
        </div>
      </div>

      <template v-else-if="filteredArchived.length > 0">
        <div v-for="s in filteredArchived" :key="s.id" class="arch-row">
          <div class="arch-meta">
            <div class="arch-name">{{ s.title }}</div>
            <div class="arch-time">{{ t('settings.archivedAt', { time: archiveTime(s.updatedAt) }) }}</div>
          </div>
          <Button variant="secondary" size="sm" @click="onRestore(s.id)">{{ t('settings.archivedRestore') }}</Button>
        </div>
      </template>

      <EmptyState
        v-else
        :title="archivedItems.length === 0 ? t('settings.archivedEmpty') : t('settings.archivedNoMatch')"
      >
        <template #icon><Icon name="archive" size="lg" /></template>
      </EmptyState>
    </div>
    </Transition>

    <!-- Restore confirmation — floats above the sheet (z-toast sits above
         z-overlay), centered at the bottom; the wrapper ignores taps so the
         sheet underneath stays interactive. -->
    <Transition name="restore-toast">
      <div v-if="restoreToast" class="restore-toast" role="status" aria-live="polite">
        <Toast
          variant="success"
          :title="t('settings.archivedRestore')"
          :message="restoreToast.title"
          :dismiss-label="t('warnings.dismiss')"
          @dismiss="dismissRestoreToast"
        />
      </div>
    </Transition>
  </BottomSheet>
</template>

<style scoped>
.group-title {
  padding: var(--space-3) var(--space-3) var(--space-1);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--color-text-faint);
}

.srow {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  min-height: 52px;
  padding: var(--space-3);
  background: none;
  border: none;
  border-radius: var(--radius-md);
  cursor: pointer;
  text-align: left;
  color: var(--color-text);
}
.srow:hover:not(.read-only) { background: var(--color-surface-sunken); }
.srow:active:not(.read-only) { background: var(--color-surface-sunken); }
.srow.read-only { cursor: default; }

.srow-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.srow-label { font-size: var(--text-base); color: var(--color-text); }
.srow-sub {
  font-size: var(--text-base);
  color: var(--color-text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.srow-val {
  flex: none;
  font-family: var(--font-mono);
  font-size: var(--ui-font-size);
  font-weight: 500;
  color: var(--color-accent-hover);
}
.srow-val.dim {
  font-weight: 400;
  color: var(--color-text-muted);
}

/* Prompt-cache note under the thinking row — mirrors .md-cache-note in Composer. */
.cache-note {
  padding: 0 var(--space-3) var(--space-2);
  font-size: var(--text-xs);
  color: var(--color-text-faint);
  line-height: 1.4;
}

/* Chevron (prototype ›) — fixed icon glyph size, not part of UI font scale. */
.chev {
  flex: none;
  color: var(--color-text-faint);
  font-size: 17px;
  line-height: 1;
}

/* Plan toggle (44×26 prototype) */
.toggle {
  flex: none;
  width: 44px;
  height: 26px;
  border-radius: var(--radius-full);
  background: var(--color-line);
  position: relative;
  transition: background 0.18s;
}
.toggle.on { background: var(--color-accent); }
.toggle::after {
  content: "";
  position: absolute;
  top: 3px;
  left: 3px;
  width: 20px;
  height: 20px;
  border-radius: var(--radius-full);
  box-sizing: border-box;
  background: var(--color-bg);
  border: 1px solid var(--color-line);
  box-shadow: var(--shadow-xs);
  transition: left 0.18s;
}
.toggle.on::after { left: 21px; }

/* App preference rows: segmented theme/color-scheme toggles + language switcher. */
.srow.pref { cursor: default; }

.num-field {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  height: 34px;
  padding: 0 9px;
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-bg);
}
.num-input {
  width: 50px;
  border: none;
  outline: none;
  background: transparent;
  color: var(--color-text);
  font-family: var(--font-mono);
  font-size: var(--ui-font-size);
  text-align: right;
}
.num-unit {
  color: var(--color-text-muted);
  font-family: var(--font-mono);
  font-size: var(--ui-font-size-xs);
}

/* Account rows */
.srow.acct.in .srow-label { color: var(--color-accent-hover); font-weight: 500; }
.srow.acct.out .srow-label { color: var(--color-danger); }

/* Context meter (96px prototype) */
.ctx-meter {
  flex: none;
  width: 96px;
  height: 7px;
  border-radius: var(--radius-full);
  background: var(--color-surface-sunken);
  overflow: hidden;
}
.ctx-meter i {
  display: block;
  height: 100%;
  background: var(--color-accent);
  /* Ease the fill as context grows instead of jumping between widths. */
  transition: width var(--duration-base) var(--ease-out);
}

@media (max-width: 640px) {
  .srow {
    align-items: flex-start;
    gap: 10px;
    min-width: 0;
    padding: 14px max(14px, var(--safe-right)) 14px max(14px, var(--safe-left));
  }
  .group-title {
    padding-left: max(14px, var(--safe-left));
    padding-right: max(14px, var(--safe-right));
  }
  .cache-note {
    padding-left: max(14px, var(--safe-left));
    padding-right: max(14px, var(--safe-right));
  }
  .srow-main {
    flex: 1 1 auto;
  }
  .srow-sub {
    white-space: normal;
    overflow-wrap: anywhere;
  }
  .srow.pref {
    flex-wrap: wrap;
  }
  .srow.pref .srow-main {
    flex: 1 0 100%;
  }
  .num-field {
    margin-left: auto;
  }
  .srow-val,
  .chev,
  .toggle,
  .ctx-meter {
    margin-top: 2px;
  }
}

.srow,
.srow-sub,
.srow-val,
.cache-note { font-family: var(--sans); }

/* Archived sessions sub-view */
.arch-subhead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3) var(--space-1);
}
.arch-back {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  border: none;
  background: none;
  padding: var(--space-1) var(--space-2) var(--space-1) 0;
  font-family: var(--font-ui);
  font-size: var(--text-base);
  color: var(--color-accent-hover);
  cursor: pointer;
}
.chev.back { font-size: 20px; }
.arch-count {
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  color: var(--color-text-faint);
}
.arch-tools {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  flex-wrap: wrap;
}
.arch-search-input { flex: 1; min-width: 160px; }
.arch-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: 56px;
  padding: var(--space-2) var(--space-3);
  border-top: 1px solid var(--color-line);
}
.arch-row:first-of-type { border-top: none; }
.arch-meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.arch-name {
  font-family: var(--font-ui);
  font-size: var(--text-base);
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.arch-time {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--color-text-faint);
}
/* Main ↔ archived swap: ±16px horizontal drift so the navigation reads
   directionally — forward slides the archived view in from the right, back
   slides the main view in from the left, at the shared base tempo. */
.view-fwd-enter-active,
.view-fwd-leave-active,
.view-back-enter-active,
.view-back-leave-active {
  transition: opacity var(--duration-base) var(--ease-out),
    transform var(--duration-base) var(--ease-out);
}
.view-fwd-enter-from { opacity: 0; transform: translateX(16px); }
.view-fwd-leave-to { opacity: 0; transform: translateX(-16px); }
.view-back-enter-from { opacity: 0; transform: translateX(-16px); }
.view-back-leave-to { opacity: 0; transform: translateX(16px); }

/* Restore confirmation toast — fixed above the sheet (z-toast > z-overlay),
   centered at the bottom. Motion is owned here (the Toast stays in its
   static branch): enter reuses the shared kimi-card-in rise, leave fades
   and settles 4px down, same tempo as Toast's own animated branch. */
.restore-toast {
  position: fixed;
  left: 12px;
  right: 12px;
  bottom: calc(max(16px, var(--safe-bottom)) + 12px);
  z-index: var(--z-toast);
  display: flex;
  justify-content: center;
  pointer-events: none;
}
.restore-toast .ui-toast { pointer-events: auto; }
.restore-toast-enter-active { animation: kimi-card-in var(--duration-base) var(--ease-out); }
.restore-toast-leave-active {
  transition: opacity var(--duration-base) var(--ease-out),
    transform var(--duration-base) var(--ease-out);
}
.restore-toast-leave-to {
  opacity: 0;
  transform: translateY(4px);
}
</style>
