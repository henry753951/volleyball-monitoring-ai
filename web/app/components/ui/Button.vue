<script setup lang="ts">
defineOptions({ inheritAttrs: false })

const props = withDefaults(defineProps<{
  variant?: 'default' | 'secondary' | 'ghost' | 'outline' | 'destructive' | 'link'
  size?: 'default' | 'sm' | 'icon' | 'icon-sm'
  type?: 'button' | 'submit' | 'reset'
  disabled?: boolean
}>(), {
  variant: 'default',
  size: 'default',
  type: 'button',
  disabled: false,
})
</script>

<template>
  <button
    v-bind="$attrs"
    :type="props.type"
    :disabled="props.disabled"
    class="ui-button"
    :class="[`ui-button--${props.variant}`, `ui-button--${props.size}`]"
  >
    <slot />
  </button>
</template>

<style scoped>
.ui-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: .5rem;
  min-width: 0;
  min-height: 2.25rem;
  padding: .5rem .875rem;
  border: 1px solid transparent;
  border-radius: .5rem;
  background: #fafafa;
  color: #09090b;
  font: inherit;
  font-size: .75rem;
  font-weight: 650;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  transition: background-color 120ms ease-out, color 120ms ease-out, border-color 120ms ease-out, transform 90ms ease-out;
}
.ui-button:hover:not(:disabled) { background: #e4e4e7; }
.ui-button:active:not(:disabled) { transform: scale(.98); }
.ui-button:focus-visible { outline: 2px solid #fafafa; outline-offset: 2px; }
.ui-button:disabled { opacity: .42; cursor: not-allowed; }
.ui-button--secondary { background: #27272a; color: #fafafa; }
.ui-button--secondary:hover:not(:disabled) { background: #3f3f46; }
.ui-button--ghost { background: transparent; color: #a1a1aa; }
.ui-button--ghost:hover:not(:disabled) { background: #27272a; color: #fafafa; }
.ui-button--outline { border-color: #3f3f46; background: transparent; color: #fafafa; }
.ui-button--outline:hover:not(:disabled) { background: #27272a; }
.ui-button--destructive { background: #dc2626; color: #fff; }
.ui-button--destructive:hover:not(:disabled) { background: #b91c1c; }
.ui-button--link { min-height: auto; padding: 0; background: transparent; color: #d4d4d8; text-underline-offset: 4px; }
.ui-button--link:hover:not(:disabled) { background: transparent; color: #fff; text-decoration: underline; }
.ui-button--sm { min-height: 2rem; padding: .375rem .75rem; font-size: .7rem; }
.ui-button--icon { width: 2.25rem; padding: 0; }
.ui-button--icon-sm { width: 2rem; min-height: 2rem; padding: 0; }
@media (prefers-reduced-motion: reduce) { .ui-button { transition-duration: 1ms; } }
</style>
