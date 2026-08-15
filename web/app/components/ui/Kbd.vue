<template>
  <kbd class="ui-kbd"><slot /></kbd>
</template>

<style scoped>
.ui-kbd {
  display: inline-flex;
  min-width: 1.35rem;
  height: 1.35rem;
  align-items: center;
  justify-content: center;
  padding: 0 0.34rem;
  border: 1px solid #3f3f46;
  border-bottom-width: 2px;
  border-radius: 0.3rem;
  background: #09090b;
  color: #fafafa;
  font:
    700 0.66rem 'Cascadia Mono',
    Consolas,
    monospace;
  line-height: 1;
  white-space: nowrap;
}
</style>
