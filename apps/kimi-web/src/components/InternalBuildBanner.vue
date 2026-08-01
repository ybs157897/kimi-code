<!-- apps/kimi-web/src/components/InternalBuildBanner.vue -->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { serverEndpointLabel } from '../api/config';
import { isDesktopShellAvailable } from '../api/desktop';
import { useKimiWebClient } from '../composables/useKimiWebClient';
import { isDesktop } from '../lib/desktopFlag';
import Tooltip from './ui/Tooltip.vue';

// The Tooltip wrapper makes this component multi-root (trigger span +
// teleported bubble), so App.vue's positioning class (.internal-build-fab)
// is forwarded to the tag explicitly instead of relying on fallthrough.
defineOptions({ inheritAttrs: false });

const { t } = useI18n();
const { backend } = useKimiWebClient();

// True only inside the Kimi Desktop app (see desktopFlag.ts). Renders a small
// tag pinned to the app's bottom-right corner (positioned by App.vue).
const show = isDesktop;

// Diagnostics revealed on hover / focus: which desktop transport the bridge
// resolved to (Wails shell vs browser mock), the engine generation reported
// by /meta, and the real server origin the client talks to.
const diag = computed(() =>
  t('app.internalBuildDiag', {
    transport: isDesktopShellAvailable() ? 'wails' : 'mock',
    backend: backend.value,
    endpoint: serverEndpointLabel(),
  }),
);
</script>

<template>
  <Tooltip v-if="show" :text="diag">
    <!-- tabindex makes a click focus the tag, which the Tooltip's focusin
         listener picks up — diagnostics on hover AND click, keyboard too. -->
    <span
      v-bind="$attrs"
      class="internal-build-tag"
      role="note"
      tabindex="0"
      :aria-label="t('app.internalBuildBanner')"
    >
      <svg
        viewBox="0 0 16 16"
        width="11"
        height="11"
        fill="none"
        stroke="currentColor"
        stroke-width="1.7"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M8 2 14 13H2L8 2Z" />
        <path d="M8 6v3.5" />
        <path d="M8 11.5h.01" />
      </svg>
      <span>{{ t('app.internalBuildBanner') }}</span>
    </span>
  </Tooltip>
</template>

<style scoped>
.internal-build-tag {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 7px;
  border-radius: 999px;
  background: #f5a623;
  color: #3a2a00;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.01em;
  line-height: 1.4;
  white-space: nowrap;
  user-select: none;
  /* App.vue parks the tag with pointer-events: none (.internal-build-fab) so
     it never blocks the pane beneath; the tag itself opts back in (scoped
     specificity wins) so hover and click can reveal the diagnostics. */
  pointer-events: auto;
  cursor: default;
  transition: background-color var(--duration-fast) var(--ease-out),
    transform var(--duration-fast) var(--ease-out);
}
.internal-build-tag:hover { background: #f7b23b; }
.internal-build-tag:active { transform: scale(0.98); }
.internal-build-tag:focus-visible {
  outline: 2px solid var(--color-accent-bd);
  outline-offset: 1px;
}
</style>
