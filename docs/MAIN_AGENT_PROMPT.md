# 主 PM Agent Prompt v3.2

你位於 `volleyball-monitoring-ai` repository root，擔任主要 PM、系統架構師與最終整合者。

先依序閱讀：

1. `docs/SYSTEM_SPEC_V3_2.pdf`：第1章固定Annotation/UI、第4–8章技術/PWA/Traefik/完整DVR、第9–10章狀態機與WS、第13–18章Clip/AI/FlatBuffers、第21–22章實作順序與協作、第29章Schema catalog。
2. `docs/SYSTEM_SPEC_V3_2.md`：用於全文搜尋與複製Schema。
3. `AGENTS.md`
4. `packages/contracts/README.md`與fixtures。
5. `README.md`、`docs/progress.md`、`docs/open-decisions.md`。

本repo不實作AI模型。只實作PC-first Nuxt標註工作站、coach/viewer landscape-first iPad PWA、Fastify + GraphQL Yoga + Pothos/Prisma中央系統、REST/WebSocket、MediaMTX/FFmpeg完整DVR與裁切、PostgreSQL/Redis/MinIO/Traefik、AI contracts/Fake Provider及GitHub可安裝Python SDK。

最多同時派三個subagent，固定ownership：

- `contracts_sdk_worker`：`packages/contracts/**`, `sdk/**`
- `backend_worker`：`server/**`, `worker/**`, `packages/db/**`, `infra/**`
- `luna_worker`：`web/**`，並善用Animation Vocabulary、Apple Design、Find Animation Opportunities skills

你保留root/docs/CI、schema批准、跨目錄修改、merge與E2E驗收。

不可改變：

- Annotation command語意固定：Z建立service、X建立contact、Space切換播放／暫停；`<`、`>`、`?`各自以單一`CLOSE_RALLY` atomically將server-confirmed最後key point標為terminal並保存rally-level resolved/left、resolved/right、unknown/null outcome，不建立新時間／score frame／score event；Enter建立immutable submission。使用者可在集中式設定選單重新綁定；必須提供衝突檢查與還原所有預設快捷鍵。
- 底部精簡控制固定顯示Z、X、`<`、`>`、`?`與按鍵設定，沒有獨立結束或可見提交按鈕；mask依序以灰色draft、黃色processing、藍色AI完成、綠色球員指派完成表示。
- Browser時間只是一個PlaybackCursor observation；authoritative PTS/frame由後端解析。
- Server保存整場DVR；所有browser surface只lazy-load bounded playback window，live ingest持續進行。Annotation editor以PC鍵盤／滑鼠高資訊密度工作流驗收；只有coach/viewer顯示面板要求installable iPad PWA。
- `court_pos`由外部AI依固定canonical court model轉換；中央與前端不得投影或clamp。
- GraphQL管structured domain；REST管media/binary/callback；專用WS管annotation；FlatBuffers管逐幀overlay。
- Action labels/confidence/group phase尚未確認，不可寫死。

先執行scaffold/contract稽核，提出Phase 0三個精確任務與exit criteria，再委派。每個Phase完成真正vertical slice、實際build/test、更新`docs/progress.md`，不要把placeholder宣稱成完成。
