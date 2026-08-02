<!-- apps/kimi-web/src/components/chat/ExpertTeamPicker.vue -->
<!-- Expert-team picker dialog — compact card grid (title + description) for
     browsing available teams and activating / deactivating one for the session. -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AppExpertTeam, AppExpertTeamStatus } from '../../api/types';
import { builtinExpertTranslationKey } from '../../lib/expertTeamI18n';
import Dialog from '../ui/Dialog.vue';
import Icon from '../ui/Icon.vue';

const { t } = useI18n();

const props = defineProps<{
  expertTeams: AppExpertTeam[];
  expertTeamStatus: AppExpertTeamStatus | null;
}>();

const emit = defineEmits<{
  select: [pluginId: string];
  clear: [];
  close: [];
}>();

// The parent mounts this with v-if, so the dialog is open while mounted.
const open = ref(true);

const activeId = computed(() => props.expertTeamStatus?.pluginId ?? null);

function isActive(team: AppExpertTeam): boolean {
  return activeId.value === team.pluginId;
}

function onCardClick(team: AppExpertTeam): void {
  if (isActive(team)) {
    emit('clear');
  } else {
    emit('select', team.pluginId);
  }
}

function teamName(team: AppExpertTeam): string {
  const key = builtinExpertTranslationKey(team.pluginId, 'name');
  return key === undefined ? team.displayName : t(key);
}

function teamDescription(team: AppExpertTeam): string {
  const key = builtinExpertTranslationKey(team.pluginId, 'description');
  if (key !== undefined) return t(key);
  return team.description || t('status.expertPickerNoDesc');
}
</script>

<template>
  <Dialog
    v-model:open="open"
    :title="t('status.expertPickerTitle')"
    :description="t('status.expertPickerDesc')"
    size="lg"
    @close="emit('close')"
  >
    <div class="picker-grid">
      <button
        v-for="team in expertTeams"
        :key="team.pluginId"
        type="button"
        class="team-card"
        :class="{ active: isActive(team) }"
        @click="onCardClick(team)"
      >
        <div class="card-head">
          <span class="card-icon"><Icon name="team" size="sm" /></span>
          <span class="card-name">{{ teamName(team) }}</span>
          <span v-if="isActive(team)" class="card-badge">{{ t('status.expertActive') }}</span>
        </div>

        <p class="card-desc">{{ teamDescription(team) }}</p>
      </button>
    </div>

    <p v-if="expertTeams.length === 0" class="picker-empty">
      {{ t('status.expertPickerEmpty') }}
    </p>
  </Dialog>
</template>

<style scoped>
.picker-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 12px;
}

.team-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px;
  text-align: left;
  background: var(--color-surface);
  border: 1.5px solid var(--color-line);
  border-radius: var(--radius-lg);
  cursor: pointer;
  transition:
    border-color var(--duration-base) var(--ease-out),
    box-shadow var(--duration-base) var(--ease-out),
    transform var(--duration-base) var(--ease-out);
}
.team-card:hover {
  border-color: var(--color-line-strong);
  box-shadow: var(--shadow-md);
  transform: translateY(-1px);
}
.team-card.active {
  border-color: var(--color-accent);
  background: var(--color-accent-soft);
}

.card-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.card-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  flex: none;
  border-radius: var(--radius-md);
  background: var(--color-accent-soft);
  color: var(--color-accent);
}
.card-name {
  flex: 1;
  min-width: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.card-badge {
  flex: none;
  padding: 2px 8px;
  font-size: var(--text-xs);
  font-weight: 600;
  color: var(--color-text-on-accent);
  background: var(--color-accent);
  border-radius: var(--radius-full);
}

.card-desc {
  margin: 0;
  font-size: var(--text-sm);
  line-height: 1.5;
  color: var(--color-text-muted);
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.picker-empty {
  margin: 8px 0 4px;
  text-align: center;
  font-size: var(--text-sm);
  color: var(--color-text-faint);
}
</style>
