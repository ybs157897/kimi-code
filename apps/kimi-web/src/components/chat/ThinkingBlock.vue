<!-- apps/kimi-web/src/components/chat/ThinkingBlock.vue -->
<!-- The thinking block stays expanded while it streams, then folds into a
     compact status row. Historical thinking is folded by default and can be
     expanded inline; clicking the body still opens the full side panel. -->
<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import Icon from '../ui/Icon.vue';

const props = withDefaults(
  defineProps<{
    text: string;
    mobile?: boolean;
    streaming?: boolean;
    foldable?: boolean;
  }>(),
  { mobile: false, streaming: false, foldable: true },
);

const emit = defineEmits<{
  /** Show the full thinking text (right-side panel — App's shared slot). */
  open: [];
}>();

const { t } = useI18n();

// Keep the live thinking body visible while streaming; completed blocks use
// the compact status row until the user explicitly expands them.
const isFoldable = computed(() => props.foldable && props.text.trim().length > 0);
const expandedByUser = ref(false);
const open = computed(() => props.streaming || expandedByUser.value);

function toggleExpanded(): void {
  if (props.streaming) return;
  expandedByUser.value = !expandedByUser.value;
}

watch(
  () => props.streaming,
  (streaming) => {
    if (streaming) expandedByUser.value = false;
  },
);

const bodyEl = ref<HTMLElement | null>(null);

// On mount, a streaming block must land on its LATEST line. After a page refresh
// mid-stream the whole thinking text is present at once with scrollTop 0, so the
// "already at bottom?" check below would otherwise leave the live window parked
// at the top. A static/historical block is left at its start (we don't pin it).
onMounted(() => {
  if (!props.streaming) return;
  const el = bodyEl.value;
  if (el) el.scrollTop = el.scrollHeight;
});

watch(
  () => props.text,
  () => {
    const el = bodyEl.value;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (!atBottom) return;
    void nextTick(() => {
      if (bodyEl.value) bodyEl.value.scrollTop = bodyEl.value.scrollHeight;
    });
  },
  { immediate: true },
);
</script>

<template>
  <div class="think" :class="{ mob: mobile }">
    <!-- Foldable: live content while streaming, status row after completion. -->
    <template v-if="isFoldable">
      <button
        class="think-toggle"
        type="button"
        :aria-expanded="open"
        :aria-label="open ? t('thinking.collapse') : t('thinking.expand')"
        @click="toggleExpanded"
      >
        <span>{{ props.streaming ? t('thinking.processing') : t('thinking.completed') }}</span>
        <Icon :class="{ open }" name="chevron-right" size="sm" />
      </button>
      <div v-if="open" class="tc-wrap" @click="emit('open')">
        <div class="tc-anim">
          <pre ref="bodyEl" class="tc">{{ text }}</pre>
        </div>
      </div>
    </template>
    <!-- Explicitly non-foldable blocks retain the old full-content behavior. -->
    <pre v-else ref="bodyEl" class="tc">{{ text }}</pre>
  </div>
</template>

<style scoped>
.think {
  margin: 0;
}

.think-toggle {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  min-height: var(--p-ic-sm);
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--color-text-muted);
  font: var(--text-sm)/var(--leading-normal) var(--font-ui);
  cursor: pointer;
}

.think-toggle:hover {
  color: var(--color-text);
}

.think-toggle .kw-icon {
  transition: transform var(--duration-fast) var(--ease-out);
}

.think-toggle .kw-icon.open {
  transform: rotate(90deg);
}

.tc-wrap {
  display: grid;
  grid-template-rows: 1fr;
  margin-top: var(--space-2);
  cursor: pointer;
}
.tc-anim {
  /* min-height: 0 is required for the 0fr/1fr grid collapse to actually shrink
     below the tracks' content. Without it, an inner scroll container (`.tc`,
     overflow-y: auto) contributes its content as the automatic minimum, so the
     row keeps its streaming height and never collapses to the short teaser —
     most visible on iOS Safari. */
  overflow: hidden;
  min-height: 0;
}

/* Hover hints clickability (opens the full text in the side panel). */
.tc-wrap:hover .tc {
  color: var(--color-text-muted);
}

.tc {
  font: var(--text-base)/var(--leading-relaxed) var(--font-ui);
  font-weight: 425;
  color: var(--color-text-muted);
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
  max-height: calc(var(--leading-relaxed) * 1em * 5);
  overflow-y: auto;
  transition: color var(--duration-fast) var(--ease-out);
}

/* ---- Mobile tweaks ---- */
.mob {
  margin: 0;
}
.mob .tc {
  color: var(--color-text-faint);
  line-height: var(--leading-normal);
  max-height: calc(var(--leading-normal) * 1em * 5);
}
.mob .prev {
  color: var(--color-text-faint);
  line-height: var(--leading-normal);
}
</style>
