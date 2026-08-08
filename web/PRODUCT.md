# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- 標記員在桌上型電腦上，以鍵盤、滑鼠與長時間播放工作流建立、微調與提交排球回合標記。
- 教練與分析人員在橫向 iPad PWA 上，於比賽進行中查看比分、直播、已完成回合、球路與跨回合球員資料。
- 管理者在獨立控制頁建立場次、維護兩隊名單並設定影音來源。

## Product Purpose

將連續賽事影音、伺服器端完整 DVR、多人標記、不可變提交與外部 AI 分析整合為一套可在現場使用的排球賽事工作站。成功代表標記員能以低延遲完成回合，教練能快速讀懂最新比分與分析，而且每個畫面只顯示當下決策需要的資訊。

## Positioning

產品以 server-authoritative 媒體時間軸把持續直播、回放微調、不可變標記提交與外部 AI 結果連成同一條可追溯資料鏈；瀏覽器不自行推測 authoritative frame，也不保存整場 DVR。

## Operating Context

- Annotation 是 PC-first 高資訊密度工作站，參考 Volleyball AI Contract Lab 的操作與時間軸語彙。
- Coach/viewer 是 landscape-first、可安裝的 iPad PWA，以現場快速讀取為主。
- 場次固定有兩隊，名單包含先發與候補，但建立場次時不決定場上站位。
- 媒體來源包含 YouTube 直播或影片，以及本地 MP4；來源由中央系統處理並轉為 bounded playback windows。
- 已提交回合可建立修正草稿；新 submission 完成分析後取代教練端的舊分析，但歷史 submission 仍不可變。

## Capabilities and Constraints

- 完整 DVR 永遠保留在 server-side；所有瀏覽器只按需要載入 bounded playback windows。
- Browser cursor 是觀測值；capture epoch、PTS、capture time 與 frame 由後端解析。
- RallySubmission 不可變；Clip、AI 與分析都參照 submission。
- `court_pos` 由外部 AI 依固定 canonical court model 產生，可超出 `0..1`，中央與前端不得投影或 clamp。
- Track ID 只在單一 AnalysisRun 內有效。球員 mapping 綁定 match roster，完成 mapping 後才納入球員分析。
- 教練端只列已提交的回合；draft 留在標記工作站協作。
- 64-bit 時間、PTS、frame 與 byte 值以 decimal string 走 wire。
- Annotation 命令語意與預設鍵位屬公共契約；任何變更必須同步規格、fixtures、server、SDK 與 Web consumer。

## Brand Commitments

- 對外介面使用繁體中文與專業、簡潔、可直接操作的語氣；不顯示開發過程、架構解釋或測試式文案。
- 教練端採 Apple 平台熟悉的工具列、分頁與觸控回饋；標記端維持專業剪輯軟體的深色高密度工作區。
- Volleyball AI Contract Lab 是 Annotation 編輯器的既定操作與視覺參考，但本產品使用持續增長的 server DVR 時間軸。

## Evidence on Hand

- 產品與系統規格：`../docs/SYSTEM_SPEC_V3_2.md`。
- 參考編輯器：`H:/Repos/volleyball-ai-contract-lab`。
- 參考輸入與 AI 輸出：`H:/Repos/volleyball-ai-contract-lab/.data/exports`。
- 現有 repo 已具備 Nuxt、GraphQL/REST/WebSocket、Prisma、媒體 worker、YouTube relay、Fake AI provider 與 Docker Compose runtime。

## Product Principles

1. 畫面服務現場決策，不向使用者解釋內部實作。
2. 關鍵狀態一眼可辨，進階設定只在需要時展開。
3. 媒體與標記時間一律以 server authority 為準。
4. 回合、分析與球員身份皆可追溯，既有提交不可被靜默改寫。
5. PC 與 iPad 各自遵循其輸入方式與空間限制，不做折衷式共用介面。

## Accessibility & Inclusion

所有主要操作需支援鍵盤焦點、清楚的非純色狀態、至少 44px 的 iPad 觸控目標、`prefers-reduced-motion`、`prefers-reduced-transparency` 與高對比偏好。
