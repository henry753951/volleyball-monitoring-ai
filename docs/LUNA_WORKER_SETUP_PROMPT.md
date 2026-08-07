# 建立個人層級 `luna_worker` 的 Prompt

將下列內容貼給 Codex。它只建立 `~/.codex/agents/luna-worker.toml`，不覆蓋其他設定。

```text
請建立個人層級 Codex 自訂 Agent：

~/.codex/agents/luna-worker.toml

先執行 `codex --version`、`codex --help`，並依目前版本支援的 standalone custom-agent TOML 格式確認欄位。保留所有現有設定，不刪除或覆寫無關檔案。

請使用本 repository `.codex/agents/luna-worker.toml` 的完整內容作為來源；必要時只做目前版本的欄位相容調整，不改變它的任務邊界。此 Agent 必須命名為 `luna_worker`，使用 `gpt-5.6-luna`、`model_reasoning_effort = "medium"`，並專責 PC-first Nuxt Annotation Workstation、DVR 播放、Annotation Timeline、coach/viewer iPad PWA、Coach Dashboard 與 Canvas Overlay 的邊界清楚執行任務。只有 coach/viewer 顯示面板以 iPad PWA 驗收；annotation editor 保留 touch parity，但主要版面與操作針對 desktop keyboard/mouse。

它必須善用父 session 已啟用且適用的 Animation Vocabulary、Apple Design、Find Animation Opportunities skills；不得改產品目標、架構、public schema、database semantics、依賴版本或其他 worker 的檔案。遇到跨團隊決策或缺少 contract 時停止並回報主 Agent。

完成後：
1. 顯示建立檔案的完整內容與僅該檔案的 diff。
2. 用可用 TOML parser 驗證語法。
3. 確認檔案位於個人 agent 目錄，且必要欄位 name、description、developer_instructions 可被目前 Codex 版本辨識。
4. 在新的 session 以一個 read-only、只讀 web/README.md 的小任務要求主 Agent spawn `luna_worker`，確認可辨識；不得使用 help 未列出的虛構 CLI 指令。
5. 回報 Codex 版本、驗證命令、結果與相容性調整。
6. 不修改任何其他設定。
```
