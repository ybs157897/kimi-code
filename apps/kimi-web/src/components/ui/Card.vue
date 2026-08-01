<!-- apps/kimi-web/src/components/ui/Card.vue -->
<!-- Design-system §03 Card: a single flat surface with head / body / foot slots. -->
<script setup lang="ts">
withDefaults(defineProps<{
  elevated?: boolean;
  /** Opt-in hover affordance (1px lift + soft shadow) for clickable cards. */
  interactive?: boolean;
}>(), {
  elevated: false,
  interactive: false,
});
</script>

<template>
  <div class="ui-card" :class="{ 'is-elevated': elevated, 'is-interactive': interactive }">
    <div v-if="$slots.head" class="ui-card__head"><slot name="head" /></div>
    <div class="ui-card__body"><slot /></div>
    <div v-if="$slots.foot" class="ui-card__foot"><slot name="foot" /></div>
  </div>
</template>

<style scoped>
.ui-card {
  background: var(--color-surface);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  overflow: hidden;
}
.ui-card.is-elevated { box-shadow: var(--shadow-md); border-color: transparent; }
/* Hover lift is opt-in (interactive prop) — static cards never move. Same
   idiom as the clickable team cards: 1px rise + the soft md shadow. */
.ui-card.is-interactive {
  transition: transform var(--duration-fast) var(--ease-out),
    box-shadow var(--duration-fast) var(--ease-out);
}
.ui-card.is-interactive:hover { transform: translateY(-1px); box-shadow: var(--shadow-md); }

.ui-card__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 10px 14px;
  border-bottom: 1px solid var(--color-line);
  background: var(--color-surface);
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  color: var(--color-text);
}
.ui-card__body { padding: 14px; color: var(--color-text-muted); }
.ui-card__foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
  padding: 10px 14px;
  border-top: 1px solid var(--color-line);
  background: var(--color-surface);
}
</style>
