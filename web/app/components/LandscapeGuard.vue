<template>
  <div class="portrait-only fixed inset-0 z-[100] hidden place-items-center bg-stone-950 p-8 text-center text-white">
    <div>
      <p class="text-xl font-semibold">請將 iPad 旋轉為橫向</p>
      <p class="mt-2 text-sm text-white/70">標註時間軸與教練球場視圖以橫向操作設計。</p>
    </div>
  </div>
</template>

<style scoped>
@media (orientation: portrait) and (max-width: 1024px) {
  .portrait-only { display: grid; }
}
</style>
