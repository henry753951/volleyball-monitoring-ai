# SDK / Contract Suggestions

這份文件是給主專案維護者的整合建議，來源是 `volleyball-ai-contract-lab` 的 mock SDK 相容性驗證。

## 1. 發布明確的 SDK 版本與相容性政策

目前外部團隊需要直接從 Git subdirectory 安裝 SDK。建議主專案發布帶有 SemVer 的 SDK tag，例如 `sdk-v0.2.0`，並在每次 public schema 變更時同步更新 SDK major/minor 版本。

外部安裝範例應固定到 tag 或 commit，而不是永遠追蹤 `main`：

```powershell
uv add "volleyball-monitoring-ai-sdk @ git+https://github.com/henry753951/volleyball-monitoring-ai.git@sdk-v0.2.0#subdirectory=sdk"
```

## 2. 將 SDK public API 建立 compatibility test

外部 mock SDK 目前已對齊以下 public surface：

- `AIJobRequest`
- `AnalysisResult`
- `validate_passthrough`
- Pydantic `model_validate` / `model_validate_json` / `model_dump`

建議主專案加入一組可被外部 fixture 執行的 compatibility test，至少驗證：

1. `input/ai-job.json` 可以被 `AIJobRequest` 解析。
2. `analysis-result` 可以被 `AnalysisResult` 解析。
3. passthrough IDs、key point 順序、terminal marker 與 frame/time/PTS 單調性不被改變。
4. mock SDK 與正式 SDK 的錯誤案例產生相同的 validation failure 類型。

## 3. 明確區分 core SDK 與 provider runtime

`provider` extra 應維持可選。core SDK 不應依賴 FastAPI、uvicorn 或任何 AI model；只有要建立 HTTP provider service 時才安裝：

```powershell
uv add "volleyball-monitoring-ai-sdk[provider] @ git+https://github.com/henry753951/volleyball-monitoring-ai.git@sdk-v0.2.0#subdirectory=sdk"
```

離線讀取資料、驗證 schema、產生 overlay 不需要 provider extra，也不應嘗試呼叫外部 API。

## 4. 保持座標責任邊界

- 一般球的 `frame_pos` 不可以直接投影成 `court_pos`。
- `court_pos` 由 AI provider 負責，中央系統不得 clamp 或重新投影。
- 只有 terminal、落地/出界且附近沒有 player association 時，才允許使用 terminal projection。
- `frame_pos`、`frame_bbox`、player footprint 與 canonical `court_pos` 建議在 SDK docstring 和 fixture 中持續保留這個區分。

## 5. 建議增加 provider fixture harness

主專案可以提供一個不含模型的 `sdk/tests/fixtures/` harness，讓外部 AI 團隊只需要替換：

- player tracking input
- court keypoint input
- ball tracking input
- provider-specific action extension

Harness 應負責固定的 job/result validation、callback envelope、overlay metadata 與 checksum 檢查，避免每個 AI 團隊自行複製 contract 邏輯。

## 6. Mock SDK 的定位

`volleyball-ai-contract-lab-mock-sdk` 適合用來產生 deterministic sample data 和 OpenCV preview，不應被視為正式 AI inference SDK。正式 SDK 與 mock SDK 應共用同一份 schema/fixture compatibility test，避免兩邊模型定義漂移。
