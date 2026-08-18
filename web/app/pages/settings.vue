<template>
  <section class="mx-auto max-w-3xl space-y-6">
    <header>
      <h1 class="text-2xl font-semibold">教練面板設定</h1>
      <p class="mt-2 text-stone-600">此處只保留 iPad PWA、顯示與連線相關設定。</p>
    </header>

    <div class="rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
      <h2 class="font-semibold">PWA 與顯示</h2>
      <p class="mt-2 text-sm text-stone-600">
        使用瀏覽器的「加入主畫面」安裝教練面板；比賽頁以橫向顯示為主。
      </p>
    </div>

    <YoutubeAuthCard />

    <div class="rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
      <h2 class="font-semibold">連線狀態</h2>
      <p class="mt-2 text-sm text-stone-600">
        比分、路徑與分析資料由中央伺服器同步；網路中斷時會顯示離線狀態，恢復連線後自動更新。
      </p>
    </div>

    <p class="text-sm text-stone-600">僅授權角色可管理 AI Worker、資料保留與系統設定。</p>
  </section>
</template>
