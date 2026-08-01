<!-- apps/kimi-web/src/components/mobile/MobileTopBar.vue -->
<!-- Mobile title bar (50px): a 28px dark workspace square, a tappable middle -->
<!-- zone showing the mono `workspace / session ⌄` path with a status sub-line -->
<!-- (● running · branch · N sessions), and a trailing sliders button. Tapping -->
<!-- the middle opens the switcher sheet; the sliders open the settings sheet. -->
<!-- Terminal Pro styling, no emoji. -->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { WorkspaceView } from '../../types';
import IconButton from '../ui/IconButton.vue';
import Icon from '../ui/Icon.vue';

const { t } = useI18n();

const props = withDefaults(
  defineProps<{
    /** Active workspace (for the chip glyph + name). */
    workspace: WorkspaceView | null;
    /** Active session title (the right, bold side of the mono path). */
    sessionTitle?: string;
    /** True when the active session is doing work (drives the status dot/text). */
    running?: boolean;
    /** Current git branch (sub-line). */
    branch?: string;
    /** Number of sessions in the active workspace (sub-line). */
    sessionCount?: number;
  }>(),
  { workspace: null, sessionTitle: '', running: false, branch: '', sessionCount: 0 },
);

const emit = defineEmits<{
  openSwitcher: [];
  openSettings: [];
}>();

/** First letter of the workspace name for the square glyph. */
const chip = computed<string>(() => {
  const w = props.workspace;
  const src = (w?.name || w?.root || '').trim();
  const ch = src.charAt(0);
  return ch ? ch.toUpperCase() : 'K';
});

const wsName = computed<string>(() => props.workspace?.name ?? t('workspace.noWorkspace'));

const statusText = computed<string>(() =>
  props.running ? t('mobile.running') : t('mobile.idle'),
);
</script>

<template>
  <div class="topbar">
    <span class="wsq">{{ chip }}</span>

    <button
      type="button"
      class="tb-mid"
      :aria-label="t('mobile.openSwitcher')"
      @click="emit('openSwitcher')"
    >
      <span class="tb-path">
        <span class="ws">{{ wsName }}</span>
        <template v-if="sessionTitle">
          <span class="sl">/</span>
          <span class="se">{{ sessionTitle }}</span>
        </template>
        <span class="cv">⌄</span>
      </span>
      <span class="tb-sub">
        <span class="rd" :class="{ on: running }" />
        <span>{{ statusText }}</span>
        <template v-if="branch"> · {{ branch }}</template>
        <template v-if="sessionCount > 0"> · {{ t('mobile.sessionCount', { n: sessionCount }) }}</template>
      </span>
    </button>

    <IconButton
      size="lg"
      :label="t('mobile.openSettings')"
      @click="emit('openSettings')"
    >
      <Icon name="sliders" size="lg" />
    </IconButton>
  </div>
</template>

<style scoped>
.topbar {
  display: flex;
  align-items: center;
  gap: 10px;
  /* Grow the bar by the top inset so the 50px content row stays below the
     status bar / notch in standalone PWA mode and landscape. */
  height: calc(50px + var(--safe-top));
  flex: none;
  padding: var(--safe-top) max(12px, var(--safe-right)) 0 max(12px, var(--safe-left));
  border-bottom: 1px solid var(--color-line);
  background: var(--color-bg);
  font-family: var(--font-ui);
}

/* Workspace square */
.wsq {
  flex: none;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-md);
  background: var(--color-text);
  color: var(--color-bg);
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--font-mono);
  font-weight: var(--weight-medium);
  font-size: var(--ui-font-size-sm);
}

/* Middle tappable zone. The negative margin / matching padding give the
   press fill a little breathing room left and right without moving the
   path / status text off its resting position. */
.tb-mid {
  flex: 1;
  min-width: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 1px;
  background: none;
  border: none;
  margin: 0 -6px;
  padding: 0 6px;
  border-radius: var(--radius-md);
  cursor: pointer;
  text-align: left;
  transition: background-color var(--duration-fast) var(--ease-out);
}
.tb-mid:active { background: var(--color-surface-sunken); }

.tb-path {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: var(--ui-font-size-sm);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tb-path .ws { color: var(--color-text); }
.tb-path .sl { color: var(--color-text-faint); }
.tb-path .se {
  color: var(--color-text);
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tb-path .cv { color: var(--color-text-faint); flex: none; }

.tb-sub {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: max(9px, calc(var(--ui-font-size) - 3.5px));
  color: var(--color-text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tb-sub .rd {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: var(--radius-full);
  background: var(--color-text-faint);
}
/* Running: the dot pulses with the same rhythm as the switcher sheet's
   running indicator (mRunPulse there), so "running" reads at a glance. */
.tb-sub .rd.on {
  background: var(--color-success);
  animation: mRunPulse 1.4s ease-in-out infinite;
}
@keyframes mRunPulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}

.topbar .tb-path { font-family: var(--sans); }
</style>
