# 人工球種、球路、教練回放與分析重構規格分析書

狀態：Accepted；核心資料契約與首批 UI 已實作，整合驗證中

版本：0.2

日期：2026-08-16

範圍：標記工作站、修正版草稿、教練回放、球員／球隊／Local ID 分析、集合影片、Pose 衍生投影、VLM Provider

實作狀態：第 16 節已確認。Annotation Realtime v4、BallEvent draft/submission、共用正規化器、C/V/B、單球發球決策、教練人工事件投影、Overlay／速度控制與 VLM capability 開關已進入程式；第 19 節列出已驗證範圍與仍待完成項目。

---

## 1. 文件目的

本文件把以下內容整合成同一份可交接規格：

1. 現有標記、播放、多人同步與 ReID User Flow 的既有決策。
2. 人工球種快捷鍵、結果、球員關聯及送出後修正規則。
3. 教練端球路回放、顯示模式、上一／下一回合與三秒前跳轉。
4. 球員、球隊與 Local ID 的球路分析及集合影片。
5. Pose、球員關聯、球路幾何與人工事件之間的資料責任。
6. 哪些修正可只重建衍生資料，哪些情況才需要重新跑 AI。
7. VLM 常駐、warm-up、資源隔離與 ReID 整合邊界。

這不是把需求直接翻成欄位的施工單。每一項都先區分：

- 已由程式碼或執行環境驗證的現況。
- 可由現有資料可靠推導的能力。
- 建議設計。
- 尚未確認、不可擅自假設的產品規則。

先前已確認的 Annotation、播放、多人草稿及 ReID 重構細節仍以
[ANNOTATION_WORKSTATION_USER_FLOWS_AND_REID_EVOLUTION.md](./ANNOTATION_WORKSTATION_USER_FLOWS_AND_REID_EVOLUTION.md)
與
[REID_EVIDENCE_AND_HUMAN_CORRECTION_GUIDE.md](./REID_EVIDENCE_AND_HUMAN_CORRECTION_GUIDE.md)
為基礎。本文件新增的是「人工球種與教練球路」領域，並明確說明它如何與前述架構銜接。

---

## 2. 目標與非目標

### 2.1 目標

- 人工標記是球種與結果的主要真相來源。
- 動作模型可以協助 overlay，但不得覆蓋人工球種或成為教練統計的主要分類來源。
- 擊球時間、球員關聯、球種與結果在送出前可直接修改；送出後只能透過修正版草稿建立新的 immutable submission。
- 能在已有每 frame Pose／track／ball 證據時，只重建關聯與球路投影，不重跑重型 AI。
- 教練能清楚看見一條球路的起點、終點、球員、球種、結果及證據可靠度。
- 教練統計改以發球、接發、殺球與一般擊球為主，支援落點 heatmap 與對應回放。
- 支援「即時集合播放」與「製作集合影片」兩種不同用途。
- VLM Provider 啟動後完成 warm-up 並保持常駐，但不因此擠壓分析 Worker 的 GPU 資源。

### 2.2 非目標

- 不承諾 VLM、Pose、ReID 或球路投影永遠正確；低信心必須能保持 unknown。
- 不把「攻方最後贏得回合」直接等同於「先前每一記殺球都成功」。
- 不讓前端自行猜測影片 frame、PTS 或 authoritative capture time。
- 不以瀏覽器匯出長集合影片作為主要製作管線。
- 不為保留舊回合資料而扭曲新資料模型。舊資料不重要，可採乾淨 cutover。
- 不在此 Proposal 尚未確認時修改公共 contract、資料庫或 UI 行為。

---

## 3. 實作前已驗證的基線現況

### 3.1 標記端

- 目前公開 Annotation contract 只有 START／END、SET_OUTCOME、CREATE／MOVE／DELETE_CONTACT、REOPEN 與 SUBMIT 等命令。
- MarkerKind 只有 SERVICE 與 CONTACT，沒有 RECEIVE、SPIKE 或各球種結果。
- 目前 X 是唯一人工 contact 快捷鍵；C、V、B 尚不是公開語意。
- mutable KeyPoint 與 immutable RallySubmissionKeyPoint 都沒有人工 event kind、result 與 actor 欄位。
- Analysis Review 已能修正 contact time、actor、add／delete contact，但 set_action 使用的是 AI 動作模型分類，不能當成人工球種欄位。
- 送出後已有 correction draft 與 successor submission 的基礎，可用來保留舊 submission 不變。

結論：需求不是新增三個按鍵而已，而是新的公共領域 contract。若硬塞進 MarkerKind 或 AI action，會讓人工真相、AI 預測與 boundary marker 混在一起。

### 3.2 教練回放

- 回放頁已經有 Popover 播放速度、Settings Sheet、overlay mode 與 layer toggles。
- 播放跳轉目前使用事件前 5 秒，不是需求中的 3 秒。
- 回放頁 header 與 coach layout footer 有重複時間、contact、path 等資訊。
- 右側 overlay track 資料已有球員姓名與背號，但 CourtPathView 顯示標籤只組合位置與背號，未顯示姓名。
- CourtPathView 已畫半透明虛線、起點圓與終點圓；問題不是完全沒有圖元，而是語意與 actor 選擇錯誤。
- 回放 API 尚未直接提供上一／下一回合鄰居。

### 3.3 為何一球會亮起很多人

已確認根因不是單純 CSS：

1. 一個事件可以帶多個 representative court positions 或 actor candidates。
2. CourtPathView 會依起點與終點陣列的最大長度建立多條線。
3. focusedTrackIds 收集所有起點與終點的 track ID。
4. 當前 frame 中只要 track ID 位於此集合，就套用 hitter ring／highlight。

這把「候選人」畫成「多個確定擊球者」，也把終點接球者用 hitter 視覺強調，因此使用者看見多人同時亮起。

修正原則：

- 一條有效球路最多只有一個 effective source actor。
- 人工 actor override 優先，其次是 Pose 關聯投影，再來才是 unresolved。
- candidates 只能出現在診斷模式或 Popover 證據列表，不得以確定擊球者樣式顯示。
- 終點 actor 使用 receiver／target 樣式，不能沿用 hitter 樣式。
- unresolved 時畫中性起點，不猜一名球員。

### 3.4 目前分析

- 球員頁以 action model 類別與 actor court position 為主。
- 現有 UI 已明確提示「動作後回合勝率」不等於殺球成功率。
- 系統能驗證回合結果、部分 contact actor、動作、track、court position 與路徑資料。
- 系統目前沒有人工 serve／receive／spike 結果 contract，因此不能可靠聲稱已有對應成功率。

### 3.5 Pose、擊球者關聯與 ReID

- Analysis provider 已要求 Person Pose evidence 具備 full-frame coverage。
- 目前 contact actor association 已依序使用：
  1. Pose 手部／手臂距離。
  2. action-aware bbox。
  3. spatial bbox。
  4. unresolved。
- 關聯 Worker 可讀取已保存的逐 frame 分析與 Pose evidence。
- ReID feature extraction 可消費既有 Pose，不需要為 ReID 再跑一次 Pose。

因此，「修改擊球時間後自動重新關聯」可被設計成輕量 projection job，但前提是新時間仍位於已有逐 frame evidence 的 coverage 內。

### 3.6 VLM 與本機資源

- 外部 engine branch 的 jersey VLM 使用 Qwen3-VL-8B-Instruct、BF16 並直接放到 CUDA。
- 目前為首次 identify 時 lazy load，載入後不主動 unload，但沒有啟動階段的 warm-up 與 READY gate。
- 該 branch 的 benchmark 只涵蓋單一場次／場館，不能視為跨場次 production truth。
- 本機 RTX 5070 只有約 12 GB VRAM；觀測時已使用約 5 GB。
- 8B BF16 權重本身約需 16 GB 十進位記憶體，尚未包含 vision tower、activation、cache 與 allocator overhead。

結論：目前 BF16 8B VLM 無法合理地與本機 12 GB 分析 Worker 共用同一張卡。常駐目標應採 capability-gated 的獨立 VLM Worker／GPU；量化只能列為待 benchmark 的替代方案，不能先承諾可用。

---

## 4. 核心設計方向

### 4.1 三層真相必須分離

| 層級           | 責任                                                          | 可否被 AI 自動覆蓋         |
| -------------- | ------------------------------------------------------------- | -------------------------- |
| 人工事件語意   | 球種、人工結果、人工 actor override                           | 不可                       |
| 衍生關聯與幾何 | Pose actor projection、球路起終點、落點、信心與 evidence refs | 可以重算，但不能改人工語意 |
| AI overlay     | 動作、bbox、pose、track、模型標籤                             | 可以隨 analysis run 更新   |

同一個畫面可以同時使用三層資料，但 UI 必須讓來源可辨識。例如「殺球」來自人工標記，「擊球者可能為 11 號」來自 Pose projection，「JUMPING」只屬於 overlay。

### 4.2 人工球種事件不可沿用 MarkerKind

建議新增獨立 BallEvent 領域：

- event_kind：SERVE、RECEIVE、CONTACT、SPIKE。
- result：依 event_kind 使用不同枚舉，不用一個含糊的 success boolean。
- event_time：權威 PTS／frame／capture time，由後端 playback resolver 建立。
- actor_override：人工作出的球員或 Local ID 關聯。
- ordinal：在確認「第一／第二球」定義後由 canonical ordered projection 產生。
- provenance：HUMAN、SYSTEM_DEFAULT、POSE_PROJECTION、UNRESOLVED。
- correction lineage：指向被修正 submission／event，禁止原地改 immutable submission。

### 4.3 已確認的結果語意

draft 在尚未完成輸入時允許 result 為 null；immutable submission 不保存 UNKNOWN。已確認的 wire enum 與顯示語意如下：

| 球種     | wire result                  | 中文顯示與規則             |
| -------- | ---------------------------- | -------------------------- |
| 發球     | POINT_SCORED、SUCCESS、ERROR | 得分、成功、失誤           |
| 接發     | SUCCESS、ERROR、POINT_LOST   | 成功、失誤、失分           |
| 殺球     | SUCCESS、FAILURE             | 成功、失敗                 |
| 一般擊球 | null                         | 沒有結果分類，不產生成功率 |

接發的 ERROR 表示沒有成功傳到舉球員但球仍繼續；POINT_LOST 表示該次接發直接造成失分。V 固定設定 SUCCESS；B 快速設定 ERROR，POINT_LOST 由同組 UI 的明確選項設定，不以重複按 B 猜狀態。

殺球 SUCCESS 僅指該殺球直接得分；防守方接觸到該球後，即使攻方最後仍贏得回合，該殺球也屬 FAILURE。系統可以依球路與比分提出建議，但人工結果優先。

系統可以提出建議，但人工 result 一旦存在即為統計真相，不被後續 AI 覆蓋。

---

## 5. 標記端目標 User Flow

### 5.1 開啟工作站與恢復草稿

1. 分頁建立自己的 client-owned session。
2. 載入同 capture session 的本地 cursor、viewport、OPEN／READY draft 與 outbox。
3. 伺服器／其他使用者只提供已提交資料與 peer awareness，不得移動本分頁 cursor 或改變本分頁 active draft。
4. reconnect 後以 idempotency key 重送未確認命令；有限次 refetch／rebase 後恢復。
5. 不可因網路斷線把 UI 永久卡在「目前狀態不能執行」。

### 5.2 Z 建立與結束片段

1. 第一次 Z 在本地建立 START。
2. OPEN 時 provisional end 可以跟隨本地 cursor，僅供該分頁視覺化。
3. 第二次 Z 建立 END，狀態變成 READY，而不是 immutable。
4. READY 仍能新增、移動、刪除 BallEvent，並修改球種、時間、actor 與 result。
5. Enter 才建立 immutable RallySubmission。
6. END 最大值不得超過下一個 canonical rally start；沒有下一回合時才使用可播放 coverage 終點。
7. 其他使用者的 cursor、START、END 不得完成或移動本分頁的 draft。

### 5.3 人工事件快捷鍵

在尚未送出，或已開啟 correction draft 時：

- X：新增人工事件。系統依事件序位提供預設球種，但使用者可改。
- C：有選取時把該點改成 SPIKE；沒有選取時新增 SPIKE。目標 ordinal 為第一／第二點時禁止，UI 顯示具體原因，不連續噴出 toast。
- V：有選取時把第二點改成 RECEIVE／SUCCESS；沒有選取時只在新點將成為第二點時新增 RECEIVE／SUCCESS。
- B：有選取時把第二點改成 RECEIVE／ERROR；沒有選取時只在新點將成為第二點時新增 RECEIVE／ERROR。接發 POINT_LOST 由同組 UI 選擇。
- A／D：在本地 canonical ordered event projection 中選擇上一／下一事件，不依遠端 arrival order。
- Arrow：frame navigation。
- Z：只負責 boundary，不是發球事件。
- Enter：送出 immutable submission。

長按按鍵的處理要求：

- repeat 必須受單一輸入狀態機控制，不可同時由 keydown、video seek 與 server echo 疊加。
- cursor 應立即採本地 optimistic target，seek 完成後再以 authoritative presented frame 校正。
- 釋放按鍵時不得把舊的 delayed seek response 套回目前 cursor。
- UI 禁用狀態在 keyup、blur、visibilitychange 與 reconnect 時都要清理，避免卡住。

### 5.4 預設球種

第一／第二球以片段內所有未刪除、按權威時間排序的有效擊球 keypoint 計算，不區分人工或自動來源；START／END boundary 不計入 ordinal。

- 第一點預設 SERVE。
- 第二點預設 RECEIVE。
- 第三個以後 X 預設 CONTACT。
- 第三個以後 C 明確建立 SPIKE。

預設是可修改的初值，但序位限制是資料 invariant。若插入、刪除、移動或 Z 設定 END 造成序位／coverage 變化，共用驗證自動修正器必須產生 deterministic correction plan：

- END 之後或 START 之前的點改為 tombstone。
- 第一點修正為 SERVE，第二點修正為 RECEIVE。
- 移到第一／第二點的 SPIKE 自動改為對應合法球種並清除不相容 result。
- 移出第二點的 RECEIVE 自動改為 CONTACT 並清除 receive result。
- 保留每一項 before／after／reason，前端以單一彙整通知說明自動修正或取消了哪些點。
- 按鍵、按鈕 disabled 狀態與後端驗證使用同一套 rule engine，不允許出現 UI 可執行但 command 永遠被拒絕的漂移。

### 5.5 Event Inspector

選中事件後，以固定 inspector 或 Popover 編輯：

- 球種。
- 結果。
- 球員／Local ID。
- frame 與時間。
- 資料來源與信心。
- 前一球／下一球。
- 刪除、還原與重新執行輕量關聯。

每個欄位要分開儲存 provenance，避免人工只改 actor 卻使 event kind 又被系統重設。

### 5.6 只有一個事件的送出檢查

當 submission 只含一個有效 keypoint 時，不區分人工或自動來源：

1. 系統依發球方與得分方自動提出 POINT_SCORED 或 ERROR 建議；證據不足時不猜。
2. 顯示 Dialog：「這球是發球得分，還是發球失誤？」
3. 動作：
   - 發球得分：標記 SERVE／POINT_SCORED 並送出。
   - 發球失誤：標記 SERVE／ERROR 並送出。
   - 返回編輯。
4. Dialog 必須說明這會影響發球統計。

如果唯一事件不是 SERVE，驗證自動修正器先產生可見修正計畫；Dialog 不保存 UNKNOWN。

### 5.7 送出後修正

1. 已送出狀態保持 immutable。
2. 使用者點「建立修正版草稿」。
3. 草稿複製 boundary、人工 BallEvent 與必要證據引用。
4. 可修改 event time、actor、kind、result，或新增／刪除 event。
5. 送出後建立 successor submission。
6. 舊 submission 與舊分析保留供 audit，但教練端預設使用最新有效 submission。

### 5.8 Overlay 與播放速度

- 最上層工具列提供 Overlay 快捷入口。
- Settings 中提供完整 overlay mode／layer 選項。
- 播放速度放在時間／播放控制 section，不散落於無關區域。
- 快捷入口與 Settings 讀寫同一份 client preference。
- overlay 僅改顯示，不改人工事件或 submission。

---

## 6. 修改後是否重跑 AI

| 修改                                 | 預設處理                                                                | 重型 AI      |
| ------------------------------------ | ----------------------------------------------------------------------- | ------------ |
| 修改 event kind                      | 更新 submission draft 與 analytics projection                           | 不重跑       |
| 修改 result                          | 更新 analytics projection                                               | 不重跑       |
| 人工指定 actor                       | 更新 effective actor、identity 與 analytics projection                  | 不重跑       |
| 修改時間且仍在現有 evidence coverage | 用既有逐 frame Pose／track／ball evidence 重建 actor 與 path projection | 不重跑       |
| 新增／刪除事件且仍在 coverage        | 重建 ordered events、association、path 與 analytics                     | 不重跑       |
| 修改 boundary 但仍在已分析 coverage  | 重建 clip-relative manifest 與 projections                              | 原則上不重跑 |
| 修改 boundary 超出 evidence coverage | 必須建立缺少的 clip／evidence；依缺少模組重跑                           | 可能需要     |
| 使用者要求重新取特徵                 | 建立獨立 ReID feature job                                               | 只跑指定能力 |
| 使用者要求新的 Pose evidence         | 建立 Pose rebuild job                                                   | 只跑 Pose    |

UI 不應只顯示「會／不會跑 AI」，而要在送出前顯示實際 impact：

- 只更新人工資料。
- 會重建關聯／球路／統計。
- 缺少 evidence，需要重新分析。

若 evidence 不足，預設可以先保存人工修正並把幾何標成 unavailable；是否立即重跑 AI 應是明確操作，不得悄悄排入昂貴工作。

---

## 7. 建議資料模型

名稱是設計方向，實際 schema 於 ADR／contract vNext 階段確定。

### 7.1 Mutable draft

BallEventDraft：

- id、draft_id。
- event_kind、result、semantic_source。
- observed browser cursor。
- resolved capture epoch、PTS、capture time、frame。
- actor_override_identity_id／local_track_ref。
- actor_source。
- user_locked_kind、user_locked_result、user_locked_actor。
- client command id、revision。

### 7.2 Immutable submission

SubmissionBallEvent：

- submission_id、stable event lineage id。
- canonical ordinal。
- immutable time tuple。
- event kind／result。
- effective actor snapshot 與人工 override reference。
- correction predecessor reference。

### 7.3 可重建 projection

BallEventActorProjection：

- submission event id。
- analysis run／pose manifest references。
- effective actor。
- candidates 與分數。
- method：HUMAN、POSE_HAND_DISTANCE、ACTION_BBOX、SPATIAL_BBOX、UNRESOLVED。
- evidence version。

BallFlightProjection：

- source event、target event 或 landing。
- source／target video and court coordinates。
- path samples 或 compact geometry reference。
- source actor、target actor。
- confidence、coverage、unresolved reason。
- projection version。

AnalyticsProjection：

- submission revision。
- event semantics。
- team／player／Local ID dimensions。
- landing／origin bins。
- result category。
- materialization version。

### 7.4 為何不把所有內容塞在同一列

- 人工 event 是 immutable business fact。
- actor 與 path 是能隨更佳 Pose／tracking 重建的 projection。
- analytics 是可重建 read model。
- 三者生命週期不同；分離後，修正球種不會觸發 AI，升級 Pose 也不會改人工球種。

---

## 8. API 與 Worker 邊界

### 8.1 Realtime Annotation contract vNext

需要新增概念命令：

- CREATE_BALL_EVENT。
- MOVE_BALL_EVENT。
- SET_BALL_EVENT_KIND。
- SET_BALL_EVENT_RESULT。
- SET_BALL_EVENT_ACTOR。
- DELETE／RESTORE_BALL_EVENT。

每個命令必須具備：

- client command id。
- expected local／server revision。
- idempotent result。
- bounded conflict response。
- 欄位級 provenance。

這是公共 contract 變更，必須：

1. 新增 ADR。
2. 決定 contract version。
3. 更新 fixtures、validators、server、SDK 與 web consumer。
4. 重新產生 GraphQL snapshot／checksum 產物。

### 8.2 Durable jobs

建議將主流程拆成：

1. ANALYSIS：輸出全 frame detector／track／ball／court 等證據。
2. PERSON_POSE_EVIDENCE：每 frame Pose，可獨立重建。
3. EVENT_PROJECTION：使用已存證據重建 actor 與 path，不執行重型模型。
4. REID_FEATURE_EXTRACTION：獨立取得 appearance／pose／VLM features。
5. REID_ASSOCIATION：使用 versioned bank 進行配對。
6. ANALYTICS_MATERIALIZATION：由最新有效人工 events 與 projections 建 read model。
7. IDENTITY_PREVIEW_GENERATION：動態預覽。
8. MONTAGE_RENDER：製作可下載的集合影片。

所有 job 要能依 submission／analysis version 判斷 stale，並以 idempotency key 防止重複 callback 或網路重試造成重複寫入。

---

## 9. 教練回放目標 User Flow

### 9.1 進入回合

- Header 顯示場次、局、回合與核心狀態。
- 下方 bar 不重複 header 的 contacts／paths／duration。
- 下方 bar 改為：
  - 第幾局、第幾回合。
  - 上一回合。
  - 下一回合。
  - 播放控制與時間。
- 不存在上一／下一回合時，按鈕反白且 disabled，不能點擊後才報錯。
- Rally 鄰居由後端依 canonical order 回傳，避免前端以載入順序猜測。

### 9.2 球路視覺

每條球路最少呈現：

- 起點 marker。
- 終點／落點 marker。
- 半透明虛線連線。
- 起點球員：背號＋姓名；沒有背號時只顯示姓名或 Local ID。
- 球種與人工 result。
- unresolved 或低信心狀態。

視覺優先序：

1. 選中球路。
2. 人工 actor 與人工 ball type。
3. receiver／target。
4. 非當前事件的其他球員。
5. 候選與 AI 診斷資料。

只有 effective source actor 使用 hitter highlight。receiver 使用另一種較弱樣式；candidate 預設不亮。

### 9.3 Display mode Popover

利用既有 Popover 元件提供：

- 顯示目前一球／整個回合。
- 標籤：背號＋姓名、只背號、只姓名、Local ID。
- 路徑：人工事件、完整推估路徑、只起終點。
- 其他球員：顯示、淡化、隱藏。
- 候選證據：關閉、診斷模式。
- heatmap／path overlay layer。

Settings Sheet 保留完整選項；Popover 放常用切換。兩者共用 preference，不建立兩套狀態。

### 9.4 跳轉與短回放

- 點事件或球路時，從 event 前 3 秒開始。
- 不是把整個 rally 重新播放。
- 播放窗結束依球種決定，詳見第 12 節。
- 起點不足 3 秒時 clamp 到 submission clip／capture coverage 起點。
- 終點不得越過下一 canonical rally start。

### 9.5 Tailwind 使用原則

- 版面、spacing、顏色 token、responsive、focus、disabled 與 typography 優先使用既有 Tailwind utilities。
- SVG path、marker 與複雜幾何樣式可保留局部 scoped CSS。
- Coach 是 landscape-first iPad PWA，維持 44 px 以上 touch target、compact translucent chrome 與 reduced-motion／reduced-transparency。
- Annotation 是 PC-first 高密度工作站，不應直接套用教練端的大卡片密度。

---

## 10. 球路幾何與來源規則

### 10.1 人工標記不等於人工畫路徑

人工事件決定：

- 何時發生。
- 是哪一種球。
- 誰擊球。
- 結果。

AI／投影決定：

- 起點／終點座標。
- 中間 path samples。
- landing。
- geometry confidence。

如果幾何不足，仍可保留完整人工事件並顯示「球路暫無資料」。不可因為沒有路徑就丟棄人工標記，也不可為了畫線而捏造落點。

### 10.2 起點

依序使用：

1. event time 附近可靠 ball position。
2. effective actor 的手部／臂部位置附近球點。
3. bbox 鄰近球點。
4. unresolved。

起點球員優先使用人工 override；沒有人工 override 才使用 Pose association。

### 10.3 終點

依序使用：

1. 下一個人工 event 的可靠 ball position。
2. 可確認的防守接觸點。
3. 球落地／出界點。
4. clip coverage 結束前的最後可靠 ball point。
5. unresolved。

終點不能只因陣列裡有多個 candidate 就生成多條「確定球路」。多 hypotheses 只能放在診斷模式並清楚標信心。

---

## 11. 教練分析規格

### 11.1 共通維度

球員、球隊及 Local ID 頁面共用：

- 球種分頁：發球、接發、殺球、一般擊球、全部。
- 局、回合、輪次、左右場、結果、球員／Local ID 等 filter。
- 起點 heatmap、落點 heatmap、球路圖。
- 對應事件列表與三秒前回放。
- 製作／即時集合影片。

AI action 可作為 overlay 或診斷 filter，但不是預設統計主軸。

### 11.2 發球

顯示：

- 發球起點與落點 heatmap。
- ACE、IN_PLAY、ERROR、UNKNOWN 次數與比例。
- 如產品仍需要「成功率」，必須先定義成功分子；不能混用 ace rate 與合法進場率。
- 每筆發球路徑與回放。

### 11.3 接發

顯示：

- TO_SETTER、FAILED、UNKNOWN 次數與比例。
- 接發事件本身的位置。
- 與其配對的前一球發球路徑。
- 接發失敗事件的完整「發球 → 接發」球路。
- 回放一律從前一記發球前 3 秒開始。

如果前一球不存在、跨 coverage 或配對信心不足，顯示 unresolved，不猜一條發球。

### 11.4 殺球

顯示：

- 起點與落點 heatmap。
- KILL、DEFENDED、ERROR、UNKNOWN。
- kill rate、error rate、defended rate，各自顯示分母。
- 球路與防守第一接觸點。

判定不得只看該回合最後贏家：

- 防守方接到後攻方稍後得分，原殺球仍為 DEFENDED。
- 無防守接觸且殺球直接得分才是 KILL。
- 證據不足保持 UNKNOWN。

### 11.5 一般擊球

- 顯示起點、終點、球員與序位。
- 不在沒有產品定義時產生「成功率」。
- 可用於完整 rally ball path 與集合播放。

### 11.6 分母與 unknown

每個百分比都要顯示：

- 分子。
- 可判定分母。
- unknown 筆數。
- filter 範圍與資料版本。

不允許把 unknown 自動算成失敗，也不允許把缺少球路的人工事件排除後不告知。

---

## 12. 即時集合播放與製作集合影片

### 12.1 技術選型結論

建議分成兩個產品能力：

#### A. 即時集合播放

- 前端取得符合 filter 的 event windows 與短片 URL。
- 以 playlist 連續播放，prefetch 下一個 bounded window。
- 切換回合時顯示簡短分隔資訊。
- 不在瀏覽器內重新編碼或先合併成一個大檔。

優點是反應快、filter 即時、伺服器負擔小。缺點是跨片可能有短切換，需靠 prefetch 與播放器狀態機處理。

#### B. 製作集合影片

- 建立 durable MONTAGE_RENDER job。
- Worker 依 authoritative media windows 使用 FFmpeg trim。
- 統一 codec、timebase、audio 與解析度後 concat。
- 輸出可下載 artifact，保存 filter、event ids、source submission versions 與 render manifest。
- 相同輸入 idempotent，可因修正版 submission 重新製作。

這比讓瀏覽器承擔 WebCodecs／MSE 編碼、封裝與長檔記憶體壓力更可靠。MSE 適合 JavaScript 控制播放 SourceBuffer；WebCodecs 提供低階 codec 介面，但不是完整跨片剪輯與 muxing 工作流。

參考：

- [W3C Media Source Extensions](https://www.w3.org/TR/media-source-2/)
- [W3C WebCodecs](https://www.w3.org/TR/webcodecs/)

### 12.2 事件播放窗建議

| 球種     | 起點              | 終點                                                   |
| -------- | ----------------- | ------------------------------------------------------ |
| 發球     | 發球前 3 秒       | 下一人工事件後 1 秒；發球 error／ace 則回合終點後 1 秒 |
| 接發     | 前一記發球前 3 秒 | 接發後下一 event／舉球結果後 1 秒，或回合終點          |
| 殺球     | 殺球前 3 秒       | 若被防起，到防守第一接觸後 1 秒；否則到回合終點後 1 秒 |
| 一般擊球 | event 前 3 秒     | 下一 event 後 1 秒，或回合終點                         |

所有時間都 clamp 到：

- immutable submission clip coverage。
- 可播放 READY media。
- 下一 canonical rally start。

終點規則可在實際 UX 測試後調整，但必須由 manifest 記錄，不能由播放器臨時猜測。

---

## 13. VLM warm-up 與常駐設計

### 13.1 Provider lifecycle

建議狀態：

1. STARTING：載入程式與 runtime。
2. LOADING_MODEL：載入 VLM weights。
3. WARMING：以固定小樣本執行一次完整 preprocess＋generation。
4. READY：成功且記憶體在安全門檻內，才 advertise capability。
5. DEGRADED：模型仍在但 OOM／latency／health 異常，不接新 work。
6. DRAINING：不接新 job，等待現有 job 完成。

模型在 READY 期間不 unload。若 process crash，由 supervisor 重啟並重新 warm-up；中央系統不能只看 process 存在。

目前已交付的第一階段只有 capability 開關，不包含本節描述的 warm-up 狀態機。外部
`volleyball-analysis-engine` Worker 的精確控制方式是：

- 環境變數：`VOLLYAI_REID_VLM_ENABLED=false`（預設）或 `true`。
- CLI：`volleyball-analysis worker --enable-reid-vlm`／`--disable-reid-vlm`。
- 相容入口：`volleyball-analysis-worker` 也接受相同參數。
- CLI 明確值優先於 env。
- 關閉時不建立 `CandidateConstrainedJerseyVlm`、不宣告 `JERSEY_VLM_RESPONSE`，也不宣告 `jersey-vlm/qwen-v1` recipe。
- `REID_FEATURE_EXTRACTION` 本身另由 `VOLLYAI_REID_FEATURE_ENABLED` 控制；VLM 開啟但 feature job 關閉時仍不載入 VLM。

### 13.2 資源隔離

- VLM Worker 與一般 analysis Worker 使用不同 capability queue。
- VLM concurrency 預設 1。
- 以實測 peak VRAM／RAM 設 reservation 與 admission threshold。
- 目前 12 GB RTX 5070 不承載 BF16 8B VLM。
- 建議先以 24 GB 以上獨立 GPU 做 BF16 8B 基準測試；實際最低值必須由 warm-up 與最壞 batch 的 peak measurement 決定。
- 若測試 4-bit／8-bit quantization，必須另外評估準確率、latency、峰值 VRAM 與與其他工作共存情況。

### 13.3 VLM 在真相鏈的位置

- VLM 產生 jersey／identity evidence，不直接綁定永久 player truth。
- 結果進入 REID feature／association job。
- 低信心可 abstain，交由人工修正。
- 人工修正更新 versioned feature bank 的正／負 membership 與 cannot-link。
- 後續片段使用已確認 evidence；被判定錯誤的 feature 不得繼續污染 bank。

詳細 ReID 設計仍以既有 ReID 文件為準，本文件只新增 warm-up 與人工球種整合。

---

## 14. 介面資訊架構

### 14.1 標記端

- 頂部：Overlay quick entry、工作狀態、網路／outbox 狀態。
- 播放控制區：時間、frame、速度。
- Timeline：boundary、人工 events、選取狀態。
- Inspector：球種、結果、actor、時間、projection evidence。
- Settings：快捷鍵、overlay mode／layers、Restore Defaults。

### 14.2 教練回放

- 主畫面：影片＋overlay。
- 右側：球路列表，背號＋姓名、人工球種、結果。
- Display mode Popover：常用視覺切換。
- Settings Sheet：完整 overlay 與 accessibility。
- 下方控制列：局／回合、上一／下一、時間／播放；不再重複 header metrics。

### 14.3 教練分析

- 上方 entity：球員／球隊／Local ID。
- 球種 tabs。
- KPI cards：只呈現定義清楚的指標。
- heatmap／path mode。
- event table。
- 即時集合播放／製作集合影片。

---

## 15. 實作階段與驗收

### Phase 0：確認規則與 ADR

- 回答第 16 節決策。
- 定稿 event taxonomy、result 與 sequence semantics。
- 建立 public contract ADR 與 cutover 計畫。
- 更新舊規格中「X 是唯一 contact」等已被 vNext 取代的敘述，避免 agent 遵循互相衝突文件。

### Phase 1：資料庫與 contract vNext

- 建立 BallEvent draft／submission／projection tables。
- 新增 realtime commands、fixtures、validators、GraphQL read models。
- 建立一次性 clean cutover；不為舊 rally 做複雜兼容。

驗收：

- BIGINT、PTS、frame wire rules 正確。
- command idempotency、conflict、reconnect fixtures 通過。
- immutable submission 無原地 update path。

### Phase 2：標記端

- X／C／V／B 與 Event Inspector。
- READY 送出前完整編輯。
- 單事件發球失誤 Dialog。
- Overlay quick entry／Settings 與速度位置。
- 修復長按 seek、stale response、keyup cleanup 與 A／D 順序。

驗收：

- 離線、延遲、丟包、重連、雙使用者、雙分頁測試。
- Z 結束後仍能標記與修改。
- boundary 不超過下一回合開始。
- 長按畫面持續前進，不在放開時跳回舊片段。

### Phase 3：Projection

- 以 stored every-frame Pose／track／ball evidence 建 event actor 與 path。
- 人工 override 優先。
- candidates 與 effective actor 分開。
- 修改 time／actor／kind／result 使用 rerun impact classifier。

驗收：

- 在 coverage 內改時間不建立新的 Pose／analysis provider work。
- 同一 event 只亮 effective source actor。
- unresolved 不冒充確定球員。

### Phase 4：教練回放

- 球路標籤背號＋姓名。
- source／target／dashed path 語意修正。
- Display mode Popover。
- 上一／下一回合與 disabled state。
- 三秒前跳轉與球種終點。
- 移除 header／footer 重複內容。

驗收：

- landscape iPad touch、keyboard、reduced motion／transparency。
- 每個顯示模式有 deterministic screenshot／component test。
- 網路慢時不跳到錯誤 rally。

### Phase 5：分析

- 人工 event read model。
- serve／receive／spike／contact tabs。
- player／team／Local ID heatmaps、paths、results。
- unknown 與分母顯示。
- 接發與前一記發球配對。

驗收：

- 防守接到後攻方最後得分，原 spike 不算 KILL。
- receive replay 從前一記 serve 開始。
- action model 改變不會改人工球種統計。

### Phase 6：集合影片

- 前端即時 playlist。
- durable MONTAGE_RENDER。
- artifact manifest、stale detection、重新製作。

驗收：

- 跨 codec／timebase 測試。
- 不越過下一 rally。
- correction 後舊 montage 標 stale，新 montage 引用 successor submission。

### Phase 7：VLM Provider

- capability queue、warm-up、READY gate、常駐。
- GPU reservation、health／peak telemetry、concurrency 1。
- ReID evidence abstention 與人工 correction integration。

驗收：

- 未 warm-up 不領 job。
- OOM 不讓中央 work 永久卡死。
- BF16／quantized 各自有可重現 benchmark，沒有測量就不宣布可共存。

### Phase 8：整體測試與 k3s 部署

- 跑最小相關測試後執行 release gate。
- 本地完成真實瀏覽器 User Flow。
- 更新 GitOps image／revision。
- 驗證 Flux revision、Deployment readiness、immutable image digest、實際 node 與外部瀏覽器。
- 部署成功與 source merge 分開回報。

---

## 16. 已確認的產品決策

產品 owner 已於 2026-08-16 確認以下規則，可開始資料庫與 public contract 實作。

### 決策 A：第一球／第二球與 V／B

1. 第一／第二球是片段內第一／第二個有效 keypoint，包含人工與自動產生的點，但不包含 START／END boundary。
2. V 是接發成功，B 是接發失誤。
3. 有選取點時 C／V／B 修改該點；沒有選取點時新增帶對應球種／結果的點。
4. C 只允許第三點以後；V／B 只允許第二點。
5. 插入、移動、刪除或 Z END 改變 coverage／ordinal 時，由共用驗證自動修正器 tombstone 或降級不合法點，並向使用者彙整通知。

### 決策 B：結果分類

- 發球：POINT_SCORED／SUCCESS／ERROR。
- 接發：SUCCESS／ERROR／POINT_LOST。
- 殺球：SUCCESS／FAILURE。
- 一般擊球：不帶 result。
- draft 可暫時未選結果；immutable submission 不保存 UNKNOWN。

### 決策 C：交付與基礎設施方向

1. 人工球種／結果為教練統計真相，AI action 僅用 overlay。
2. 球路幾何由 AI／stored evidence 投影；沒有證據時顯示 unavailable，不為了畫線而猜。
3. 集合影片拆成「前端即時 playlist」與「Worker 製作可下載 montage」。
4. 本階段不更換、不 warm-up 新 VLM 模型，只增加 Worker 啟動參數與環境變數開關。關閉時不得初始化 VLM、advertise VLM capability 或領取 VLM work；Docker／k3s 可用 env 控制。獨立 GPU 與模型資源選型延後。

---

## 17. Agent 交接守則

後續 agent 開始此領域前必須：

1. 先讀本文件、第 16 節已確認答案、相關 ADR 與兩份既有 Annotation／ReID 文件。
2. 不把 AI action 當人工 ball type。
3. 不把 browser cursor 當 authoritative media time。
4. 不讓 peer cursor／draft 改動本地 active draft。
5. 不在 immutable submission 原地修正。
6. 不因 event kind／result 修改而重跑重型 AI。
7. 不把 candidates 畫成多個確定 hitter。
8. 不把 rally winner 直接等同每一記 spike 的 success。
9. 不把 unknown 隱藏在成功率分母之外。
10. 不宣稱 VLM 可常駐或與其他工作共存，除非有實測 peak memory 與健康證據。
11. 不宣稱部署完成，除非已驗證 GitOps revision、ready pods、image digest、node 與真實瀏覽器。

---

## 18. 已驗證來源索引

- 標記快捷鍵：web/app/utils/annotationHotkeys.ts
- Annotation wire contract：packages/contracts/src/annotation.ts
- Analysis review correction：packages/contracts/src/analysis-review.ts
- 教練回放頁：web/app/pages/matches/[matchId]/replay/[rallyId].vue
- 教練 layout：web/app/layouts/coach.vue
- 球路 Canvas：web/app/components/CourtPathView.vue
- Coach replay projection：server/src/services/coach-replay.ts
- Coach analytics：server/src/services/coach-analytics.ts
- Coach domain client：web/app/lib/coachDomain.ts
- Contact actor association：worker/src/services/contact-actor-association.ts
- 既有 Annotation／ReID 規格：docs/ANNOTATION_WORKSTATION_USER_FLOWS_AND_REID_EVOLUTION.md
- ReID 人工修正說明：docs/REID_EVIDENCE_AND_HUMAN_CORRECTION_GUIDE.md

---

## 19. 2026-08-16 實作快照與交接界線

### 19.1 已實作並通過聚焦測試

- Annotation Realtime `4.0.0`：typed contact、`SET_BALL_EVENT`、snapshot BallEvent 與 repair effects。
- Prisma：`BallEventDraft`、`RallySubmissionBallEvent`、結果與球種的資料庫 CHECK，以及 immutable submission snapshot。
- 共用純函式正規化器：canonical time/frame/order、boundary tombstone、ordinal reindex、球種／結果降級與穩定 repair code。
- 標記 UI：X/C/V/B，同一球點群組；選取時修改，未選取時新增；不合法 ordinal 共用同一原因；READY 在 Enter 前仍可編輯。選取球點後可由同一個 event-detail 區指定或清除 active match-roster 球員。
- 單一有效點送出：Dialog 強制選擇 `POINT_SCORED` 或 `ERROR`；server 也拒絕未決結果。
- 修正版：kind／result 等幾何未變的修正沿用已完成的 clip 與 `analysisSourceRunId`，不建立新的重型 AI job；coach replay／analytics 可沿 lineage 讀舊 evidence。
- 教練回放：人工 BallEvent kind/result/actor snapshot 為語意；只有 effective source actor 使用 hitter highlight；球路標籤顯示背號＋姓名；跳轉 lead 為 3 秒；上一／下一回合有 disabled state；顯示設定使用 Popover。
- 標記畫面：播放速度位於 timecode control；Overlay 同時提供畫面快捷開關與 Settings 開關，並保存為 browser preference。
- Pose 關聯：既有 stored every-frame Pose 的腕／前臂距離優先，action-aware bbox 與 spatial bbox 依序降級；聚焦 Worker 測試已通過。
- 外部 Engine VLM：env／CLI opt-in，關閉時不初始化且不 advertise VLM artifact／recipe；CLI、capability 與 feature-job 測試已通過。

### 19.2 尚未宣稱完成

- 修改 event time／新增或刪除 event 時，目前尚未完成「coverage 內只重建 actor/path projection」的完整 durable job；幾何完全相同的修正才已保證不跑重型 AI。
- draft BallEvent 的 active match-roster actor 已可在標記端指定或清除，並會 immutable copy；尚未完成的是直接指定未綁定 Local ID 的獨立 wire reference，以及 actor 欄位自己的 provenance／lock history。
- 教練 analytics 已改用人工 kind/result 計數，但跨 event 的真正 ball landing projection 仍取決於 evidence；證據不足必須顯示 unavailable，不能把 hitter position 冒充落點。
- 前端即時 playlist 與 durable `MONTAGE_RENDER` 尚維持第 12 節技術選型，未宣稱已交付。
- VLM warm-up、常駐 READY gate、量化與獨立 GPU placement 尚未實作；本輪只有安全 capability 開關。
- 完整 browser multiplayer／丟包 QA、release gate 與 k3s rollout 必須在程式整合完成後另行驗證，不得只憑 unit tests 宣稱完成。
