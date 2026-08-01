<!-- apps/kimi-web/src/components/ui/Toast.vue -->
<!-- Design-system §03 Toast: floating notice = status icon + title + description
     + close. Variants color the icon (info / success / warning / danger). The
     default slot carries extra body content (action links, detail panels…).
     Motion is opt-in via `animated`: the toast then owns an enter/leave
     <Transition> so a bare <Toast> animates on its own; consumers that bring
     their own motion (e.g. the WarningToasts <TransitionGroup>) leave it off
     and get the exact same static root as before. -->
<script setup lang="ts">
import { ref } from 'vue';
import IconButton from './IconButton.vue';
import Icon from './Icon.vue';

const props = withDefaults(defineProps<{
  variant?: 'info' | 'success' | 'warning' | 'danger';
  title: string;
  message?: string;
  dismissLabel?: string;
  /** Opt-in built-in enter/leave motion (default off). When on, the toast
   *  fades/rises in on mount and animates its own close: the dismiss emit
   *  fires only after the leave transition finishes, so a v-if-mounted toast
   *  exits cleanly instead of popping. Keep it off when an outer
   *  <Transition>/<TransitionGroup> already moves the toast. */
  animated?: boolean;
}>(), {
  variant: 'info',
  dismissLabel: 'Dismiss',
});

const emit = defineEmits<{ dismiss: [] }>();

/** Visibility of the animated branch. The close button flips this instead of
    emitting right away so the leave transition can run first — a parent v-if
    would unmount the surface before the leave could run otherwise (same
    contract as Menu's `open`). */
const open = ref(true);

function onDismissClick(): void {
  if (props.animated) {
    open.value = false;
  } else {
    emit('dismiss');
  }
}

/** <Transition> hook: the toast has finished animating out — now tell the
    consumer to unmount it. */
function onAfterLeave(): void {
  emit('dismiss');
}
</script>

<template>
  <!-- Animated branch (opt-in): the toast owns its enter (appear) / leave. -->
  <Transition v-if="animated" name="ui-toast" appear @after-leave="onAfterLeave">
    <div v-show="open" class="ui-toast" :class="`ui-toast--${variant}`">
      <span class="ui-toast__icon" aria-hidden="true">
        <slot name="icon">
          <Icon v-if="variant === 'success'" name="check" />
          <Icon v-else-if="variant === 'danger'" name="close" />
          <Icon v-else-if="variant === 'warning'" name="alert-triangle" />
          <Icon v-else name="info" />
        </slot>
      </span>
      <div class="ui-toast__body">
        <div class="ui-toast__title">{{ title }}</div>
        <div v-if="message" class="ui-toast__msg">{{ message }}</div>
        <slot />
      </div>
      <IconButton class="ui-toast__close" size="sm" :label="dismissLabel" @click="onDismissClick">
        <Icon name="close" size="sm" />
      </IconButton>
    </div>
  </Transition>
  <!-- Static branch (default): byte-identical to the pre-motion markup, so
       outer motion owners like WarningToasts are unaffected. -->
  <div v-else class="ui-toast" :class="`ui-toast--${variant}`">
    <span class="ui-toast__icon" aria-hidden="true">
      <slot name="icon">
        <Icon v-if="variant === 'success'" name="check" />
        <Icon v-else-if="variant === 'danger'" name="close" />
        <Icon v-else-if="variant === 'warning'" name="alert-triangle" />
        <Icon v-else name="info" />
      </slot>
    </span>
    <div class="ui-toast__body">
      <div class="ui-toast__title">{{ title }}</div>
      <div v-if="message" class="ui-toast__msg">{{ message }}</div>
      <slot />
    </div>
    <IconButton class="ui-toast__close" size="sm" :label="dismissLabel" @click="onDismissClick">
      <Icon name="close" size="sm" />
    </IconButton>
  </div>
</template>

<style scoped>
.ui-toast {
  display: flex;
  align-items: flex-start;
  gap: 11px;
  width: 360px;
  max-width: 100%;
  padding: 13px 14px;
  background: var(--color-surface-raised);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
  font-family: var(--font-ui);
  line-height: 1.45;
}
.ui-toast__icon {
  flex: none;
  width: 20px;
  height: 20px;
  margin-top: 1px;
  border-radius: var(--radius-full);
  display: grid;
  place-items: center;
  background: var(--color-accent-soft);
  color: var(--color-accent);
}
.ui-toast__icon svg { width: 12px; height: 12px; }
.ui-toast--success .ui-toast__icon { background: var(--color-success-soft); color: var(--color-success); }
.ui-toast--warning .ui-toast__icon { background: var(--color-warning-soft); color: var(--color-warning); }
.ui-toast--danger .ui-toast__icon { background: var(--color-danger-soft); color: var(--color-danger); }
.ui-toast--danger { border-color: color-mix(in srgb, var(--color-danger) 35%, transparent); }
.ui-toast__body { flex: 1; min-width: 0; }
.ui-toast__title {
  font-size: var(--text-base);
  font-weight: 500;
  color: var(--color-text);
  overflow-wrap: anywhere;
}
.ui-toast__msg {
  margin-top: 2px;
  font-size: var(--text-sm);
  color: var(--color-text-muted);
  overflow-wrap: anywhere;
}
.ui-toast--danger .ui-toast__msg { color: var(--color-danger); }
.ui-toast__close { flex: none; margin: -3px -4px 0 0; }

/* Built-in enter/leave (opt-in via `animated`): enter reuses the shared
   kimi-card-in rise; leave fades and settles 4px down. --duration-base at
   --ease-out matches the toast-stack tempo; reduced motion is covered by the
   global kill switch in style.css. */
.ui-toast-enter-active { animation: kimi-card-in var(--duration-base) var(--ease-out); }
.ui-toast-leave-active {
  transition: opacity var(--duration-base) var(--ease-out),
    transform var(--duration-base) var(--ease-out);
}
.ui-toast-leave-to {
  opacity: 0;
  transform: translateY(4px);
}
</style>
