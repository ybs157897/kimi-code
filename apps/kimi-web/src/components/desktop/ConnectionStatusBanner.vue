<!-- apps/kimi-web/src/components/desktop/ConnectionStatusBanner.vue -->
<!-- Persistent desktop connection-status affordance. A break of the realtime
     channel used to surface only as an auto-dismissing toast — inside the
     desktop shell, where the engine rides the IPC/sidecar link, a dead link
     froze the stream with no lasting cue or recovery. Renders while
     `connection !== 'connected'` with a manual retry action; browser sessions
     keep their toast + automatic reconnect backoff alone (desktopFlag gate). -->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useKimiWebClient } from '../../composables/useKimiWebClient';
import { isDesktop } from '../../lib/desktopFlag';
import Banner from '../ui/Banner.vue';
import Button from '../ui/Button.vue';

const { t } = useI18n();
const { connection, reconnectEvents } = useKimiWebClient();

// Desktop-only: the browser already pairs the same disconnect with an
// auto-reconnect backoff + toast, and a persistent duplicate there would
// change its existing behavior.
const visible = computed(() => isDesktop && connection.value !== 'connected');

const message = computed(() =>
  connection.value === 'connecting'
    ? t('status.connectionConnecting')
    : t('status.connectionDisconnected'),
);
</script>

<template>
  <Transition name="conn-banner">
    <Banner v-if="visible" variant="warning" class="conn-banner">
      <span class="conn-banner__msg">{{ message }}</span>
      <!-- While the channel is already re-establishing itself a retry is
           pointless — the label-only state reads as plain status. -->
      <Button
        v-if="connection !== 'connecting'"
        variant="secondary"
        size="sm"
        class="conn-banner__action"
        @click="reconnectEvents()"
      >
        {{ t('login.retry') }}
      </Button>
    </Banner>
  </Transition>
</template>

<style scoped>
/* Sits between the session list and the sidebar footer; the horizontal inset
   matches the sidebar rows (--sb-inset = --space-3). */
.conn-banner {
  margin: 0 var(--space-3) var(--space-2);
}
/* Banner.vue's text slot is a plain <span>; give it the row's slack so the
   message takes the room and the action pins to the right. */
.conn-banner :deep(.ui-banner__text) {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: 1;
  min-width: 0;
}
.conn-banner__msg {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.conn-banner__action {
  flex: none;
}

/* Quiet enter/leave (same idiom as the sidebar's row motion): fade + 4px
   rise on the ease-out curve. */
.conn-banner-enter-from,
.conn-banner-leave-to {
  opacity: 0;
  transform: translateY(4px);
}
.conn-banner-enter-active,
.conn-banner-leave-active {
  transition:
    opacity var(--duration-base) var(--ease-out),
    transform var(--duration-base) var(--ease-out);
}
</style>
