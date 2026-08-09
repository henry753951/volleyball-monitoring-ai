# Progress

## 2026-08-09 — Runtime simplification Phase 1 baseline

Status: in progress on `codex/runtime-simplification`; architecture decision and removal inventory
are complete, while the external AI worker E2E remains the final destructive-cleanup gate.

- Accepted ADR 0024: daily development uses four Docker infrastructure services plus optional
  Traefik, full central deployment targets nine containers, and related loops compose into
  `worker-media` and `worker-workflow` without losing per-loop health or failure isolation.
- Declared external AI WS-only. Provider Realtime `1.0.0`, Job `1.1.0`, Result `1.0.0` and Callback
  `1.0.0` stay wire-compatible; the provider registry/configuration becomes WS-only `2.0.0` and the
  pre-1.0 Python SDK advances to `0.4.0` when its hosted HTTP provider helper is removed.
- Inventoried all seventeen current Compose services, volumes, Dockerfiles and environment-variable
  ownership in `docs/runtime-topology-inventory.md`. The development database has one enabled
  `WS_AGENT` integration, zero `HTTP_PUSH` integrations and zero active AI jobs.
- Preserved media/PTS/clip baselines: Media 88, focused Server 38 and focused Worker 16 tests passed.
  The external analysis engine receive/callback run is still required before replay/dispatcher/schema
  deletion.

## 2026-08-09 — Immediate buffered frame control and timeline seeking

Status: merged to `main` through [PR #54](https://github.com/henry753951/volleyball-monitoring-ai/pull/54)
at `d3861cc` after full GitHub CI passed.

- Restored actual browser-buffer ranges to green and made the upper canonical ruler seek with the
  same BigInt-safe mapping as the buffer rail.
- Frame controls now project immediately from the browser buffer, accept rapid repeated arrows,
  calibrate against exact sample-index deltas and reconcile to the server anchor without bouncing
  through the old cursor position.
- Analysis review WebSocket traffic now uses the dedicated `/ws/analysis-reviews/:analysisRunId`
  endpoint, so local Nuxt development connects directly to Server instead of depending on a failed
  dev proxy.
- Headed Chromium confirmed one and three rapid frame steps at 60 fps, ruler seeking, the DEMO
  analysis rail/panel and zero console errors. Full CI passed contracts/SDK, Compose, Prisma,
  GraphQL, TypeScript, all tests and production builds.

## 2026-08-09 — Resumable long-form YouTube VOD capture

Status: implemented and locally validated on `codex/youtube-relay-resume`; GitHub integration is pending.

- Replaced prefix suppression with a durable capture checkpoint: ffmpeg seeks to the next unpublished capture time and continues deterministic segment numbering instead of reading the source from zero.
- Added signed-URL refresh and progress-aware retry for multi-hour YouTube VOD/completed-live media. A retry budget resets whenever a new DVR segment is atomically published.
- A finite source can no longer emit completion/`END` when committed segment coverage is shorter than its declared duration. Existing local MP4 segmentation uses the same restart-safe checkpoint path.
- Added ADR 0021 and a configurable consecutive no-progress limit (`YOUTUBE_VOD_MAX_STALL_ATTEMPTS`, default 20).

Validation: relay unit tests 12/12; real ffmpeg checkpoint smoke resumed a 12-second 60fps H.264/AAC fixture from 4 seconds and produced a contiguous six-segment tail. The 5:48:02 completed-live test source resolved as 1920x1080 60fps AVC/AAC, and its signed video/audio URLs successfully decoded from a 00:06:12 seek checkpoint. Rebuilt relay container passed readiness.

## 2026-08-09 — Match administration and storage-aware operations console

Status: implemented and locally validated on `codex/control-console`; GitHub integration is pending.

- Added authorized match editing and explicit typed-confirmation deletion to the desktop control console. Deletion removes match-owned domain rows transactionally, stops managed sources, and returns a cleanup receipt instead of hiding post-commit media failures.
- Protected shared media assets by checking which asset rows actually disappeared before removing objects from MinIO. Local cleanup is restricted to descendants of the configured import and recording roots.
- Added host capacity and per-match capture, segment, gap, indexed-duration and stored-byte telemetry to the authenticated operations snapshot. The server now mounts the shared recording volume so the reported capacity and cleanup target describe the actual DVR store.
- Exported the additive GraphQL mutations and stored operation documents. ADR 0020 records the contract, authorization, cleanup and 64-bit wire decisions; AI wire schemas and the Python SDK are unchanged.

Validation: Server `219/219`, Web `154/154`, Contracts `13/13`, DB `4/4`, workspace typecheck and Nuxt production build passed. GraphQL SDL export, all 15 stored operations, canonical checksums and Compose configuration also passed; GitHub CI is the final merge gate.

## 2026-08-09 — Canonical DVR timeline and real browser-buffer rail

Status: implemented and locally validated on `codex/hls-canonical-buffer-rail`; GitHub integration is pending.

- Confirmed from hls.js and MSE semantics that native video controls can only represent the attached MediaSource duration and seekable ranges. A bounded rolling playlist therefore cannot truthfully expose the full server-side DVR duration through the native progress bar.
- Archive playback now keeps a finite rolling duration while only actual live sources use `liveDurationInfinity`. The production Annotation workstation continues to use its canonical capture-time timeline rather than exposing the misleading native control bar.
- Split the timeline's media readiness into three truthful layers: server DVR availability, the selected bounded playback window and the browser's actual `video.buffered` ranges. Only bytes appended to MSE render as bright green.
- Added BigInt-safe conversion from player-local `TimeRanges` to canonical capture microseconds. Buffer events, native progress and duration changes update the rail without resolving browser time as authoritative media identity.

Validation: Web `142/142`, Nuxt typecheck and production build passed. Headed Chromium reported a finite bounded duration of `486.22 s` for the 30-minute archive, while the canonical ruler remained `00:00–30:00`. Initial MSE buffer `182.08–365.38 s` rendered at `57.07%–67.25%`; seeking to canonical 15:00 retained the same MediaSource Blob and expanded the actual buffer to `54.16–365.38 s`, rendering at `49.96%–67.25%`, with zero console errors.

## 2026-08-09 — Predictive rolling-HLS buffer continuation

Status: implemented and locally validated on `codex/ome-player-buffer-tuning`; GitHub integration is pending.

- Fixed the buffer-health calculation to use only the browser's actual `TimeRanges`. A finite media duration is no longer treated as downloaded data, so an empty range or MSE hole triggers playback-window continuation before starvation.
- Archive attachment now disables automatic fragment loading and calls `hls.startLoad()` with the descriptor's bounded player-local target. This bypasses live-edge synchronization for rolling archive manifests while preserving LL-HLS behavior for actual live mode.
- hls.js buffer, fragment and playlist events now feed the existing continuation controller. A same-window extension refreshes the manifest without replacing the video source or recreating the MediaSource Blob.
- Kept OME's 2-second continuity recording interval and 2-second LL-HLS segments. A longer recording split reduced file churn but would delay finalized server-side DVR visibility, so it was rejected after the player-side root cause was proven.

Validation: Web `141/141`, Nuxt typecheck and production build passed; OME XML and Compose config parsed successfully. Headed Chromium opened the DEMO archive at canonical `17:09.166` with player-local `183.95 s`, proving the rolling manifest no longer forced the live edge. A forced near-window-edge run retained the same `blob:` URL, extended HTTP 200 before exhaustion, grew the buffered tail from `365.38 s` to `540.39 s`, and played 15 seconds without `stalled`, `ended`, source replacement or pipeline reset.

## 2026-08-09 — OvenMediaEngine and stable MSE playback

Status: merged to `main` through [PR #41](https://github.com/henry753951/volleyball-monitoring-ai/pull/41) at `8c2866c` after GitHub CI passed.

- Promoted OvenMediaEngine to the sole live ingest, LL-HLS and recording adapter; removed the MediaMTX image, configuration and hook runtime. OME configuration uses short LL-HLS chunks/segments, disk DVR and finalized recording files observed by a durable watcher.
- Added YouTube video/live and local MP4 onboarding directly to the two-step New Match flow. Server routes create match-scoped capture sessions and delegate YouTube extraction/relay to the uv-managed gateway without exposing signed upstream URLs to the browser.
- Added additive `PlaybackWindowExtendRequest 1.0.0` JSON Schema, fixture, TypeScript parser and Python SDK model. The server advances a continuous rolling segment selection under advisory lock: an already-buffered prefix may leave the active window while the overlapping suffix remains identical and a new tail is appended. Window ID, manifest URL and presentation origin remain stable.
- Removed archive source swapping at buffer boundaries. hls.js stays attached to one video element and owns MSE Blob creation, manifest reload, prefetch/retry and browser-buffer eviction; a same-window mapping revision cannot destroy the pipeline or clear `src`.
- Added regression coverage for stable client attachment, REST extension and the database-backed rolling manifest. ADR 0017 records the adapter and player lifecycle decision while preserving canonical sample-index/PTS authority.

- Applied the rolling-origin database migration and verified the real 30-minute DEMO archive in headed Chromium. One window extended with HTTP 200 to mapping version 2 while `captureStartUs` advanced, `presentationOriginCaptureUs` stayed fixed, the same MSE Blob URL remained attached, playback advanced continuously from 372.12 s to 382.12 s with `readyState=4`, and the buffered tail grew to 565.40 s.
- Recovered and integrated today's uncommitted Annotation UI/WebSocket refinements from the original user worktree without modifying it. The local Nuxt dev server now places the compact WS badge in the upper-right toolbar and continuously shows heartbeat round-trip latency (`WS 正常 12 ms` in the headed check).

- OME 0.20.5 passed the isolated 1920×1080 60 fps ingest, LL-HLS and recording smoke. The reconnect/sample-index suite retained monotonic canonical capture time across a real restart, and both supplied YouTube sources exposed FHD60-compatible video formats when probed (the URLs were ended `was_live` sources at validation time, so no claim of a currently active broadcast is made).
- Local gates passed: contracts 12, focused server 10, focused worker 14, focused Web 38, frozen-`uv` Python SDK 16, all workspace typechecks, 457-file scaffold/checksum validation, Prisma structure (43 models/26 enums), 245-file TypeScript/Vue syntax validation and the final UI detector with zero findings. The 42-page PDF was rebuilt with XeLaTeX and page 18 was visually inspected.

## 2026-08-08 — Live DVR reconnect authority and YouTube FHD60 gate

Status: implemented and locally validated on `codex/media-live-dvr-fhd60`; GitHub integration is pending.

- Added durable MediaMTX source-online/offline hook events. Offline writes a spool restart marker before best-effort worker notification, while periodic reconciliation remains the source of truth. The hook endpoint now parses a strict bounded event body instead of treating every request as an untyped scan hint.
- Fixed real MediaMTX fMP4 indexing when the final video frame omits `pkt_duration`: adjacent PTS remains authoritative for every non-tail sample, and the tail uses only the exact video-stream `start_pts + duration_ts`; conflicting evidence fails closed.
- Decoupled capture epochs from playback discontinuities. Recorder-local PTS resets retain their real PTS in a new epoch without splitting bounded playback; source restart, time-base/timestamp discontinuity and real gaps still increment the discontinuity. Availability ranges may span exactly touching epochs only when the discontinuity is unchanged.
- Upgraded the uv-managed YouTube relay to strict FHD60 H.264/AAC selection, separate VOD video/audio URL support, real-time pacing and host-independent LF normalization. It no longer silently selects 720p or exposes signed media URLs to the browser.
- Removed the final coach-side `frame × fps` approximation. Analysis coverage now reads the checksum-bound immutable timing-manifest `frame_map` from the rally bucket and maps first/last AI frames to exact capture times, including VFR clips.

Validation: Media `88/88`, focused Worker `34/34`, Server typecheck and focused timing/MinIO `30/30`. A real two-session MediaMTX reconnect spool produced four fMP4 segments and 478 contiguous canonical frames: recorder files stayed at discontinuity 0, reconnect changed it once to 1. The supplied YouTube VOD produced 1920×1080 H.264 at `60000/1001` with AAC; the supplied live source produced 1920×1080 H.264 at `60/1` with AAC. A second two-session live ingest produced 20 real fMP4 segments and 2,269 contiguous frames, with the persisted restart boundary at segment 10 and no capture-time/frame regression.

Remaining production acceptance outside this checkpoint: a long-duration bounded-memory soak, fault injection against real worker/PostgreSQL/MinIO services and product-level persisted `MediaSource` orchestration for direct upload/YouTube-VOD imports.

## 2026-08-08 — Media source isolation and frame-exact clip timing

Status: implemented and locally validated on `codex/timeline-pts-alignment`; continuous Live DVR and the new source adapters remain the next media slice.

- Fixed the control console's stale-source leak. The authenticated Operations API now scopes capture sessions to matches visible to the requesting non-admin operator, while the Nuxt monitor independently intersects streams with the current GraphQL match list. Historical `Phase 2A DVR Smoke` sessions no longer appear beside the DEMO match.
- Replaced the clip worker's CFR/FPS approximation with strict sample-index authority. The worker verifies every sample-index object and segment metadata, rejects epoch/time-base/gap discontinuities, snaps requested boundaries to actual source samples and identifies immutable key points by epoch, source PTS, capture time and canonical frame together.
- FFmpeg now selects exact source frame ordinals and uses passthrough frame timing; `-r`, time-times-FPS mapping and frame-count fallback were removed. ffprobe reads every produced frame, and a missing, duplicated or non-monotonic output frame fails the job instead of creating an approximate AI mapping.
- Advanced the internal timing manifest to `1.1.0`. It contains source time base, a complete source-sample-to-output-frame table and both source/clip identity for every immutable key point. Public AI Job `1.1.0` remains compatible because its key-point ID still joins to the immutable source anchor while its clip values come from the verified output frame.
- Accepted ADR 0016. MediaMTX remains the current live recording adapter; OME is a compatibility-gated candidate for continuous LL-HLS Live Rewind, not a replacement for `CaptureEpoch`/sample-index authority. Local upload and YouTube VOD will use direct import/index, while YouTube Live may use yt-dlp/FFmpeg only as the extractor/relay into the live adapter.

Validation: worker typecheck and full suite passed (`160` passed, `6` environment-gated skips); server typecheck and full suite passed (`187/187`); focused Web operations tests passed (`3/3`); a real FFmpeg no-audio trim produced exactly six selected frames without CFR coercion. Headed Chromium at `http://localhost:3100/control?view=media` showed exactly one DEMO source (`507/507`, zero gaps), no smoke fixtures and zero console errors; GraphQL and Operations returned HTTP 200. Impeccable detection returned no findings.

Open media work: implement the persisted `MediaSource` adapter/job lifecycle before exposing functional YouTube URL and local-upload controls; make live playback one long-lived playlist/player attachment; prefetch archive windows before boundaries; add deterministic reconnect/PTS-reset/time-base-change media fixtures; capability-probe hardware acceleration; replace the remaining coach AI-coverage FPS approximation with the timing manifest's actual frame map.

## 2026-08-08 — Local-first annotation input and event-driven collaboration

Status: implemented and validated on `codex/annotation-optimistic-input`; integration review is in progress.

- Split the Annotation workstation into dedicated header, match-inspector and transport components plus a read-only workstation view-model composable. The route now owns orchestration and media/annotation side effects instead of rendering every workspace surface inline, and unused route helpers were removed with `vue-tsc --noUnusedLocals` evidence.
- Added a persisted optimistic command queue. Z, X, left/right/unknown close and Enter project immediately from the client observation while commands remain serialized over the dedicated Annotation WebSocket. Rapid contacts no longer wait for the preceding network round trip, and each queued command rebases onto the latest confirmed revision before transmission.
- Preserved the authority boundary: projected points are marked estimated, while each ACK replaces them with the server-resolved capture epoch, PTS, capture time and frame. CLOSE still targets the server-confirmed final key point at send time and produces no standalone score event.
- Removed fixed `ActiveAnnotationRally` GraphQL polling and duplicate ACK-triggered refetches. The query now runs only for initial connection, reconnection or explicit recovery; after a durable command, the origin receives its ACK and the server broadcasts the committed `rally_snapshot` revision to every socket in the room. Annotation no longer polls the full coach read model, and live DVR growth refreshes only the lightweight selected capture timeline instead of refetching the full match.
- Fixed the submitted-to-new-service projection gap so Z creates the next local Rally immediately instead of waiting for a snapshot request. Hotkeys remain registered while temporarily unavailable so TanStack observes keyup and the first newly valid press is not swallowed.
- Key-point pointer drag now retains its client target while authoritative cursor resolution and MOVE run in the background. Invalid padded ranges are rejected before the visual move, and the server transaction independently rejects any MOVE that would overlap another mutable or immutable Rally clip without advancing the revision.

Validation passed: full workspace typecheck and production build; Contracts `12/12`, DB `4/4`, Media `88/88`, Server `187/187`, Worker `156/156` with 6 environment-gated skips, Web `121/121` and frozen-uv SDK `16/16`. Focused final checks passed 24 Web and 41 Annotation transport/command tests. Headed Chromium confirmed a fresh runtime with zero console errors, first-press Space playback toggling, one initial `ActiveAnnotationRally` recovery query and only lightweight capture-timeline refreshes afterward.

## 2026-08-08 — Match clip policy, correction rollback and timeline command synchronization

Status: implemented and locally integrated on `integration/phase3-annotation`. The Annotation workstation now uses a match-owned dynamic clip policy with a three-second default while preserving every immutable submission's original range.

- Added `Match.clipPreRollUs` and `Match.clipPostRollUs` as PostgreSQL BIGINT values with `3,000,000 µs` defaults. The setting accepts 0–30 whole seconds, is available only to ADMIN/OPERATOR roles, and updates the live draft/correction mask immediately. Existing submissions, clip jobs and completed analysis retain their immutable range; a later correction snapshots the then-current policy only when submitted.
- Added a dedicated Annotation settings page for the two clip extensions. The UI states the immutable boundary, reports success/failure through Sonner and reads the persisted match values through GraphQL rather than browser storage.
- Added server-authoritative service overlap rejection. Z is unavailable while any OPEN draft exists or when the proposed padded interval intersects another non-void segment. READY unsubmitted segments may coexist with a later OPEN segment only when their padded intervals do not overlap. X remains service-first and bounded by the editable mask; outcome commands can replace the terminal outcome on OPEN or READY drafts without creating a timestamp or score event.
- Added transactional correction cancellation. It restores the active immutable submission's exact key-point snapshot and rally-level score outcome, tombstones correction-only points, returns the Rally to SUBMITTED and records an audit operation plus outbox event without creating a new submission.
- Added explicit set winners and a transactional start-next-set mutation. The current set is finished with the selected team, the next set starts LIVE at 0:0 with copied court-side assignment, and OPEN/READY unsent drafts block the transition so point computation cannot cross an unresolved set boundary.
- Restricted ordinary timeline seek to the buffer/ruler strip. Mask clicks only select, the playhead drag surface is limited to its triangle/red line, and child pointer events no longer leave dragging stuck. Cursor-follow is now an explicit toggle; when enabled, current and historical key-point selection seeks to that key point. Editable points support pointer drag plus one-frame toolbar nudges.
- Added persistent mask labels for set, rally, outcome and processing/mapping state. Completed analysis receives a separate coverage rail carrying byte size, counts and extensible capability icons for player tracking, ball tracking, contact association and overlays.
- Moved selected-segment context immediately beside the timecode, added set-win controls to the score panel, and synchronized the six monochrome Annotation actions with the same eligibility reasons used by the server.

Local runtime evidence: migration `20260808130000_match_clip_policy_and_set_winner` applied to the running PostgreSQL container; the rebuilt server container returned healthy and GraphQL reported the DEMO match at `3,000,000 / 3,000,000 µs`. Headed Chromium changed the pre-roll from 3 to 4 seconds through the settings UI, observed the success toast, restored 3 seconds, verified buffer-strip seeking, mask-only selection and a completed playhead drag with no console errors.

Validation passed: workspace typecheck, production build, GraphQL SDL export plus all 13 stored operations, Prisma validation, `git diff --check`, contracts `12/12`, DB `4/4`, media `88/88`, server `186/186`, worker `156/156` with 6 environment-gated skips, Web `111/111` and frozen-uv SDK `16/16`.

## 2026-08-08 — Professional operations console and live subsystem telemetry

Status: the desktop control console now shares the Annotation workstation's neutral graphite visual language and exposes real operational telemetry for the application, persistence, object storage, media/DVR pipeline and external AI workflow.

- Replaced the single match table shell with a compact left navigation rail and five focused workspaces: operations overview, match management, system status, media/stream inspection and AI jobs. Match creation, roster editing, source management and Annotation launch remain available in the match workspace.
- Removed deep-blue dashboard surfaces in favor of near-black and neutral graphite structure. Color is limited to semantic green, amber, red and AI-ready blue states; the responsive rail collapses cleanly on narrower desktop windows.
- Added the role-restricted `GET /api/v1/operations/summary` REST endpoint for ADMIN/OPERATOR users. It combines PostgreSQL, Redis and MinIO readiness with aggregate Rally, clip, AI, callback, outbox, media-asset and annotation-command metrics without returning command payloads or media data.
- Added bounded per-capture telemetry for the 24 most recently updated inputs: source/status/health, latest DVR program, playlist revision, live edge, FPS, timebase, epoch count, total/ready/gap segments, indexed frame count and duration. All BIGINT values remain decimal strings on the wire.
- Added a same-origin monitor client with no-store server semantics, explicit access errors, automatic 10-second refresh and manual refresh. The UI displays loading, disconnected, degraded and empty states without illustrative values.
- Headed Chromium verified all five workspaces, responsive navigation at 1024 px, the match-creation dialog, live data from four capture sessions and zero console errors. The live snapshot reported PostgreSQL/Redis/MinIO ready, 7,865 media assets and DVR programs at 507/507, 2,088/2,088 and 4/4 ready segments.

Validation passed: Server typecheck and `184/184` tests, Nuxt typecheck, focused operations client `2/2` tests, Impeccable detector with zero findings, live API response and headed Chromium QA. The unrelated in-progress Annotation timeline test remains outside this checkpoint. Docker BuildKit did not emit progress and timed out during the image rebuild; for live QA only, the same locally built server `dist` was copied into the existing healthy server container and restarted successfully.

## 2026-08-08 — Actual correction submission, AI callback and 12-player identity consolidation

Status: the 30-minute Contract Lab DEMO completed a new operator-driven immutable correction through the real Annotation UI, clip worker, external-provider job endpoint, callback ingest and Coach replay surfaces. The provider remains an explicit deterministic replay of supplied inference data, not an in-repository AI model.

- Created a correction from active submission `67c7d8f8-ddf0-4ca7-bdb7-38edc60d6a5c`, automatically reopened it for editing, moved the eleventh contact from authoritative frame `62378` to `62379`, closed it with the original right-side outcome and submitted it with Enter. New immutable submission `51cb306b-4374-40f7-ac8c-fbfd38ef945f` superseded the prior submission without mutating its snapshot.
- The clip worker produced the real `21.207342 s` clip (`1024163257..1045370599` capture microseconds). The dispatcher sent `POST /v1/jobs` and received `202 Accepted`; provider job `55e51cea-c441-45ba-9c4c-b1d5df4035c3` completed its callback, producing active analysis run `60d363c6-51b4-4962-bec1-e600dca475f3` with version `contract-lab-tracking-replay-v3`.
- Added deterministic court-side/trajectory-continuity identity consolidation for the supplied 14 raw tracker IDs. Six long-lived slots per court side become the canonical analysis identities; short same-side fragments 13 and 14 map to canonical track 4, and 26 same-frame duplicate observations are suppressed. This is deliberately not learned ReID. The normalized run contains exactly 12 analysis tracks: six LEFT and six RIGHT.
- Kept roster identity ownership separate from AI tracking. The completed run has zero `TrackIdentityAssignment` rows and a null `identityMappingCompletedAt`; the Annotation assignment panel renders all 12 tracks as Unknown, while Coach replay already shows 12 tracked players, 12 contacts and 11 ball-path segments.
- Corrected the current-mask color cascade so an analyzed current segment is visibly blue and only a completed player mapping turns it green. Headed Chromium verified the `timeline-mask current analyzed` class with a blue `rgba(36, 111, 165, 0.45)` fill and blue border.
- Creating a correction now enters OPEN edit mode immediately after the transactional READY clone, allowing point adjustment before the operator explicitly closes and submits the replacement.

Validation passed: frozen-`uv` SDK `16/16`, scoped Ruff, Nuxt typecheck, Web `105/105`, `git diff --check`, replay-provider Docker build and health check. Headed Chromium captured the blue analyzed mask, the 6+6 Unknown assignment table and Coach replay backed by the new active analysis. The local operator UI remains available at `http://localhost:3100`.

## 2026-08-08 — Annotation timeline interaction and desktop UI refinement

Status: the PC Annotation workstation, correction replay and desktop/coach surfaces have completed the current commercial-UI and data-integrity checkpoint without changing the authoritative server-side DVR, immutable-submission or Annotation command contracts.

- Replaced per-presented-frame cursor resolution with frame-rate local playback projection. The workstation now resolves only after a new playback-window identity, seek, key-point move or frame-step operation; ordinary playback no longer polls `resolve-cursor`. Annotation commands still carry the observed browser cursor for authoritative server resolution.
- Reused an already-buffered bounded playback window for same-window seeks so normal scrubbing does not detach/reload HLS. A new server playback window is created only when the requested time is outside the active bounded window, and the last presented frame remains visible until the replacement target frame is ready instead of flashing black.
- Fixed bounded-window continuation so an initial, paused or seeking video cannot recursively recreate its source. Only playback that actually started and reached a finite ready window tail may advance; duplicate targets are coalesced and a live window waits for the server edge to advance.
- Removed pointer-drag timeline panning. Plain wheel scrolls the visible time range, Shift+wheel changes scale and both use short motion interpolation. The playback cursor has a larger drag target and retains its optimistic release position until browser playback catches up, preventing the old-position bounce.
- Combined segment masks and key points into one track so every mask visually contains its own points. Mask bounds use the server clip policy: service minus five seconds through terminal plus five seconds; overlapping clip ranges receive separate mask lanes instead of covering one another. Double-click fits the timeline scale while its first click seeks once.
- Restored immutable submission key points to the workstation read model and retained every unsubmitted READY draft. Reopening/submitting a correction therefore no longer makes the previous points appear deleted. A new OPEN Rally may coexist with earlier closed READY drafts, while reopening another READY draft is rejected until the current OPEN Rally closes. Correction drafts may be created and submitted alongside other drafts because they remain READY unless explicitly reopened.
- Migrated the DEMO Rally through a real immutable correction to `canonical-rally-v2`. Persisted proof is exactly `5,000,000 µs` before the service and `5,000,000 µs` after the terminal, a `21.207342 s` completed clip, all 12 immutable key points and completed analysis run `7b29a071-15d8-4868-a72f-eff6d2008074`. The workstation suppresses the superseded submission lane while its correction draft exists, so one Rally never renders as overlapping duplicate masks or duplicate list rows.
- Added configurable A/D previous/next-key-point navigation across Rally boundaries, repeatable arrow frame stepping with Shift for five frames, refined Kbd/Tooltip/Resizable/Combobox controls and a VollyAI coach shell. Room WebSocket command acknowledgements now refresh every connected workstation immediately instead of waiting for polling.
- Hardened the uv-managed Contract Lab replay provider for immutable correction submissions. It remaps saved analysis geometry to a correction clip/key-point identity, emits real BBOX overlay chunks and reports provider exceptions through the failed callback lifecycle instead of leaving an AI job permanently RUNNING. The DEMO correction job completed as analysis run `69ea7327-c4f4-4eaa-a4a9-713e8d8477ab`.
- Added reusable dark Animated Modal, Scroll Area, confirmation and connection components, global Sonner notifications, same-page roster/source editing, a compact connection inspector and a desktop-dark control workspace. The Annotation inspector now centers the Rally count above the score and lets the submitted-segment list fill its remaining height.

Validation passed: Web `103/103`, Server `182/182`, uv-managed Python `22/22`, scoped Ruff, Nuxt/workspace typechecks, full production build, `git diff --check` and the Impeccable UI detector. Headed Chromium rendered the real video and BBOX overlay with zero console errors, preserved all 12 immutable points, showed non-overlapping clip masks with five-second pre/post padding, dragged the cursor from 31.066 to 34.650 seconds with one release resolve, retained a preview during an artificially delayed source replacement and advanced exactly one bounded playback window at its tail. The local Nuxt server remains available at `http://localhost:3100` for operator testing.

## 2026-08-08 — Contract Lab DEMO match and recorded tracking replay

Status: the local product now contains one clean DEMO match backed by the supplied 30-minute Contract Lab source, one immutable submitted Rally and the saved YOLOX / Deep-EIoU / SAM / court-projection output. The active development AI integration no longer fabricates tracks or court data.

- Added `bun run demo:bootstrap`. It checksum-verifies the external source and canonical 17.239675-second clip, creates the Japan U16 vs India U16 match/rosters/score/submission, packages the source into 507 HLS fMP4 fragments and imports them through the authoritative DVR artifact/sample-index repository. The source remains outside Git; generated local fragments are ignored by Git and excluded from Docker build context.
- Replaced `examples/fake_ai_provider` with the uv-managed `contract-lab-tracking-replay` provider. It validates the exact immutable Job input and clip identity, replays recorded YOLOX detections plus Deep-EIoU/SAM tracking, emits a real VOV1 per-frame overlay and returns the saved normalized analysis. Provenance remains explicit: ball points are human frame annotations and action labels are ball-path heuristics, not claimed model output.
- Preserved the external-AI boundary for `court_pos`: the replay writes finite float32 values without projection or clamping. Runtime GraphQL evidence retained the terminal outside-court position (`x=1.0882928636339`, `y=-0.111756841341654`). The completed run contains 14 tracks, 12 contact events, 11 paths and nine lazy overlay chunks for 1,033 frames.
- The Coach live page now chooses media by capture kind. YouTube captures keep the embed path; local MP4 and server-ingested sources request a bounded DVR live window and use native iPad HLS or desktop `hls.js`. Headed Chromium rendered the real 1920×1080 DEMO source at `readyState=4`; Rally replay returned HTTP 206, advanced the 17-second canonical clip and loaded overlay chunks without console errors.
- The PC workstation displays the full `00:30:00.000` server-side timeline, the immutable 12-point DEMO segment and all 14 analysis-run-local track assignments grouped by court side with Unknown as the default. The home/control surfaces show the live `JPN 0:1 IND` score; three prior runtime-smoke memberships were removed from the development viewer without deleting their underlying test records.
- Fixed media-indexer lifecycle teardown so stateful queue/scanner methods retain their receiver binding. The regression passed 7/7 and the rebuilt worker starts cleanly. Removed 537 demo-only stale pg-boss jobs, 30 failed RTMP test fragments and the obsolete fake-provider container after the recorded replay completed.

Validation passed: Contracts 12, DB 4, Media 88, Server 180, Worker 156 with 6 environment-dependent skips, Web 100 and frozen-`uv` SDK 14. All workspace typechecks and the `app` + `dev-ai` Compose configuration passed. The idempotent bootstrap returned the same match, Rally, submission and analysis-run IDs with an exact 1,800,000,000 µs DVR; headed Chromium showed one DEMO match, `JPN 0:1 IND`, a live WS ping and no console warnings/errors. XeLaTeX rebuilt the searchable 42-page PDF, and changed pages 4, 15, 34–36, 39 and 42 were visually inspected without clipping or overlap.

Open boundary: this provider is a deterministic replay of genuine saved inference output, not an in-repository AI model or a claim that the original model ran during each demo request. Production still requires a live external provider endpoint and credentials.

## 2026-08-08 — Commercial Annotation and coach experience checkpoint

Status: the PC Annotation workstation now follows the supplied Volleyball AI Contract Lab interaction model while retaining the central system's growing server-side DVR, bounded replay windows and authoritative media-time resolution. The coach surface has been reduced to a landscape-first, commercial iPad experience rather than a diagnostic dashboard.

- Finalized the configurable command map: Z creates service/start, X creates contact, Space controls playback, `<` / `>` / `?` atomically close against the server-confirmed last key point with the rally-level outcome, and Enter creates the immutable submission. TanStack Hotkeys renders bindings with `formatForDisplay`; conflict-safe recording and Restore Defaults remain workstation-only.
- Rebuilt Annotation around a compact application bar, video-plus-inspector work area, editable growing timeline and precise transport. Draft masks and key points are selectable, Delete removes the selected item, points support authoritative drag/frame adjustment, archive playback lazy-loads bounded windows and the cursor returns to the continuing LIVE edge without issuing requests beyond a resolved window.
- Added historical submitted segments to the same workstation timeline. An operator can select a completed segment, create a correction draft and submit an immutable replacement through the existing supersession pipeline; the prior submission remains authoritative until the replacement is accepted.
- Added match roster editing to the control system and a typed `updateMatchRoster` GraphQL boundary. Existing roster-entry identities are preserved for analysis history, removed players become inactive, and a PostgreSQL partial unique index enforces jersey-number uniqueness only among active entries.
- Completed analysis identity assignment with immediate per-track player mapping, active-roster choices, explicit unknown as the default and a reversible completion switch. The segment progression is gray draft, yellow processing, blue analyzed and green player-confirmed.
- Redesigned coach home, live, completed-segment, replay and player pages with compact navigation, set score summaries, WebSocket ping, new-segment notifications, a real YouTube embed, custom playback/key-point track, rotated two-team court and cross-segment player analytics. Annotation preferences are absent from the PWA.
- Removed Saved Analysis Views from the pre-1.0 GraphQL, Nuxt and Prisma surfaces so the coach product no longer carries the unused filter/layout persistence feature. ADR 0015 records the intentional breaking removal; the local table was verified empty before its isolated drop migration was authored.
- Added the separate control workspace for match creation, source status and roster editing. The Annotation toolbar links directly to the selected match's control context, while coach pages remain presentation-only.
- Local Nuxt development now loads the root environment configuration without Docker. The running app served the configured YouTube embed at `http://localhost:3100`, roster edits persisted through reload, Annotation displayed historical correction actions and the WebSocket badge reported a live ping.
- Updated the canonical Markdown, LaTeX and PDF specifications for the final key bindings, rally-level outcome semantics, identity mapping and revised product surfaces. The two canonical Markdown specifications remain byte-identical and the 42-page PDF was rebuilt and visually inspected.
- Validation passed: Contracts 12, DB 4, Media 88, Server 180, Worker 155 with 6 environment-dependent skips, Web 100 and frozen-`uv` Python SDK 13 tests. All workspace typechecks, scaffold/contract/Prisma validators, 10 stored GraphQL operations and production builds passed.

Open limitations: the control UI currently registers RTMP/SRT/RTSP/external publisher targets. Starting a process-scoped YouTube relay and uploading/importing a local MP4 are not yet wired into that UI. Production identity/TLS, physical-iPad long-session acceptance, real external-AI output, off-host backup, retention approval and external observability remain environment- or deployment-owned work.

## 2026-08-08 — Complete durable worker runtime ownership

Status: every configured `WORKER_ROLE` now has a concrete start/stop composition; no production role falls through to the idle scaffold lifecycle.

- Implemented the PostgreSQL transactional Outbox publisher. It CAS-claims one eligible row, writes an idempotent `domain-events-v1` pg-boss job using the OutboxEvent UUID/dedupe key, marks `PUBLISHED` only after durable acceptance, treats an already-existing job ID as successful crash replay, and uses bounded exponential retry with a ten-attempt `FAILED` terminal state. Persisted failures contain only a secret-free error class.
- Implemented playback-window lifecycle cleanup. The deterministic DVR profile already consists of immutable indexed fMP4, so authorized Server requests compose bounded manifests without duplicating or transcoding the full DVR. `worker-playback` deletes only explicitly expired ephemeral `PlaybackWindow` rows in bounded batches; it never removes DVR segments or media assets.
- Implemented analysis terminal convergence. The public REST callback remains the single schema/checksum/passthrough/FlatBuffer/idempotent-receipt and normalized-data transaction. `worker-analysis-ingest` repairs only AiJob/Rally terminal projections for a COMPLETED AnalysisRun whose immutable submission is still active; it cannot reactivate `SUPERSEDED` work or rewrite provider results/`court_pos`. ADR 0014 records this ownership decision.
- Added an exhaustive worker entrypoint and scaffold validator assertions for all six roles. Focused lifecycle tests passed `8/8`; the full Worker suite passed `155` with 6 environment-dependent skips, plus typecheck and production build.
- Docker runtime evidence started all three formerly idle roles with `durable runtime active`. Before restart, PostgreSQL held 6 PENDING OutboxEvents and 528 expired PlaybackWindows. After convergence it held 6 PUBLISHED events, zero expired/total windows, and pg-boss held exactly 6 `domain-events-v1` jobs in durable `created` state. The YouTube relay, MediaMTX, indexer, Server and Web were not restarted.
- Updated the canonical Markdown/TeX/PDF specification and requirements matrix. Both Markdown specs remain byte-identical; XeLaTeX produced a searchable 42-page A4 PDF, and changed architecture pages 12–14 were visually inspected without clipping or layout defects.

Open limitations remain deployment acceptance: downstream consumers may subscribe to the durable domain-event queue as deployment integrations are added; production identity/TLS, off-host backup schedule, retention approvals, external observability and physical-iPad acceptance remain environment-owned.

## 2026-08-08 — Advisory marker soft locks and authoritative drag completion

Status: the remaining optional cross-operator marker-edit hint is implemented, contract-versioned and runtime-verified without weakening revision/CAS authority.

- Advanced only the Annotation Realtime registry to additive `2.1.0` for strict client `soft_lock_intent` messages. Canonical Rally commands, acknowledgements and revisions remain `2.0.0`; the intent carries no command ID, Rally revision or media anchor and never enters PostgreSQL, operation receipts or immutable history. ADR 0013 records this main-Agent boundary.
- Added Redis-only advisory edit state with an independent 12-second TTL, five-second client refresh, explicit `null` release, disconnect cleanup and server expiry publication. Presence identity is always taken from the authenticated connection; clients cannot choose the displayed user/device identity.
- Timeline draft markers now support pointer drag. A drop first opens a bounded archive window, waits for a real rendered browser cursor, asks the server to resolve that observation and only then sends the unchanged `MOVE_KEY_POINT` command. A failed/stale media resolution leaves the marker unchanged. Remote locks add a visible name/halo hint but never disable the marker or block a competing move; revision/CAS remains canonical.
- Two independent headed Chromium device sessions exercised the running Docker stack against the growing YouTube DVR. The second operator saw `Dev Operator 正在調整（不阻擋）` on the service marker while the marker remained enabled. Releasing the first operator's drag cleared the hint and moved the authoritative marker from frame 42107 to frame 50468 while the Rally revision advanced from 1 to 2. The temporary draft was closed through normal `VOID_RALLY`, both browsers reported zero console errors/warnings and both sessions were closed.
- The supplied YouTube relay remained running throughout the Server/Web rebuild and browser acceptance. Its server-side DVR timeline grew from 551 to 572 READY ranges during this smoke, demonstrating that drag/fine-tune operates on a buffer that continues to extend rather than a fixed uploaded file.
- Validation passed: contracts 12, DB 4, media 88, Server 180, Worker 147 with 6 environment skips, Web 97 and frozen-`uv` SDK 13 tests; all workspace typechecks and production builds passed. Server and Web production images rebuilt and returned healthy. The searchable A4 specification PDF was regenerated to 42 pages; all pages were rendered as a contact sheet and the changed realtime pages 20–23 were visually inspected without layout defects.

Open limitations are deployment acceptance rather than missing repository semantics: production identity/TLS, physical-iPad long-session acceptance, real AI-provider court/action data, scheduled off-host backup, approved retention durations, external metrics/alerts and audit-retention/dashboard policy remain environment- or operator-owned decisions. Real multi-operator production acceptance remains required beyond this local two-device proof.

## 2026-08-08 — Real YouTube ingest, recording and DVR replay acceptance

Status: a managed optional relay is implemented and is currently feeding the local Compose stack from the supplied YouTube former-livestream URL at real-time rate.

- Added the `youtube-relay` Compose profile with uv-managed pinned `yt-dlp 2026.7.4` and FFmpeg. The source URL is process-scoped rather than committed; only a caller-selected MediaMTX ingest path crosses into the central system. Active broadcasts start from their live edge, while completed livestreams run under FFmpeg `-re` as a deterministic live simulation.
- Registered capture `754f79bd-263c-4b9d-8e5c-e9866cbb5381` for `youtube/nmtbgyfa-zm`. It reached `LIVE / HEALTHY`; MediaMTX recorded H.264/AAC fMP4 segments and the media indexer produced a live `DvrProgram` with one sample index per media segment. At the persistence probe, 42 segments covered `209,944,216` microseconds and the playlist revision was 42.
- The authoritative playback-window REST path returned HTTP 200 with a server-bounded live manifest. Headed Chromium selected the YouTube capture automatically, rendered the actual 640×360 volleyball video, loaded an archive window at `readyState=4`, advanced playback time, observed the timeline grow by `6,006,367` microseconds during an eight-second polling interval and returned to a fresh live window. Browser console evidence was 0 errors / 0 warnings.
- Desktop HLS now lazy-loads the light runtime only when a bounded window attaches; the authority inspector and workstation-only dialogs are lazy components. The largest HLS client chunk fell from about 508 kB to 332 kB and the large-chunk warning disappeared. The rebuilt healthy Web container repeated archive playback with the light runtime at `readyState=4`, advanced from 0.5 to 1.65 seconds and again reported no console errors or warnings.
- The direct MediaMTX `/hls` edge currently requires its `cookieCheck=1` bootstrap query when used through the path-prefix proxy; the product Annotation flow is unaffected because it consumes authorized server-generated bounded playback windows. A production CDN/proxy deployment must preserve the MediaMTX HLS session query/cookie behavior rather than exposing raw full-DVR media.

The relay and Docker stack remain running for user testing. Recording rights and YouTube/platform terms remain operator responsibilities.

## 2026-08-08 — Annotation marker selection and authoritative frame fine-tune

Status: draft key points can now be selected from the growing DVR timeline and adjusted one authoritative frame at a time from the Contract Lab workstation.

- Timeline markers expose selection state and seek directly to their persisted capture time. Submitted markers remain visibly read-only; a selected marker receives a distinct focus ring without changing canonical data.
- Added an explicit fine-tune mode for gray drafts. Left/right arrows call the existing server frame-step endpoint, seek the player to the returned canonical frame, wait for a real ready `requestVideoFrameCallback`/fallback cursor from that rendered frame, resolve it again through server media authority and only then issue `MOVE_KEY_POINT`. One pending move gates overlapping frame commands.
- Web `95/95`, focused timeline interaction `4/4`, Nuxt typecheck and production build passed. The Web/Server images were rebuilt and remained healthy; headed Chrome selected the immutable service marker, opened the matching archive window at frame 15 and reported no console errors without mutating the submitted Rally.

Open limitation: the optional cross-operator drag soft-lock hint is still not implemented; revision/CAS remains the canonical concurrency authority.

## 2026-08-08 — Internal metrics and audit export

Status: the running Server now exposes payload-free aggregate operations evidence on internal-only routes.

- Added Prometheus text metrics for process memory/uptime and persisted Rally, ClipJob, AiJob, CaptureSession, OutboxEvent, AI callback, MediaAsset and Annotation receipt/operation state. The companion audit summary contains counts and newest-operation time only; command/callback payloads, tokens, storage keys and user identity are excluded.
- `/internal/metrics` and `/internal/audit/summary` are registered only on the Server service. The current Traefik rules do not route `/internal/**`; container-local requests returned HTTP 200 while `https://localhost/internal/metrics` returned HTTP 404.
- Pure renderer/route tests passed `3/3`, Server typecheck passed, the production Server image rebuilt successfully and its readiness remained healthy. External Prometheus/Grafana deployment, alert policy and long-term audit retention remain environment-owned work.

## 2026-08-08 — AI callback hardening acceptance

Status: the Phase 7 callback duplicate/retry/error matrix is now exercised against an isolated migrated PostgreSQL database through the real Fastify REST route.

- Added seven callback integration cases covering persisted processing progress, identical callback-ID replay, conflicting payload reuse, expired job-scoped token, checksum mismatch, invalid public metadata, invalid VOV1 FlatBuffer and the bounded analysis-part limit. Rejected callbacks create neither receipts nor AnalysisRuns; an identical retry returns the original persisted response and retains one receipt.
- Corrected `docs/requirements-matrix.md`, which still described the already runtime-proven Clip/AI and Coach Phase 4–6 slices as scaffolded. The matrix now separates verified local product behavior from production provider, identity/TLS, retention, off-host backup and physical-iPad acceptance.
- Focused callback acceptance passed `7/7`. Production retention durations remain an explicit human decision and no destructive lifecycle default was introduced.

## 2026-08-07 — Capture lifecycle and processing retry completion

Status: the remaining `startCapture`, `stopCapture` and `retryProcessing` GraphQL mutations are implemented with operator UI and durable job semantics.

- Added typed GraphQL inputs/results and stored operations for all three mutations. Start validates a safe MediaMTX ingest path, stores only an opaque secret reference, authorizes ADMIN/OPERATOR membership, moves a planned match live and emits a durable start-request outbox event. Stop terminally closes the capture/program/active epochs at the persisted live edge so later MediaMTX files are no longer resolved into that session.
- Added the Annotation top-bar stream-source dialog. Operators can see active capture health, register RTMP/SRT/RTSP/external ingest paths, copy the derived publisher target and stop a session without putting Annotation preferences into the Coach/PWA settings page.
- Added deterministic retry routing for the active immutable submission. A terminal ClipJob is reset in place with cleared lease/error/output state; a failed AI attempt is retained as `SUPERSEDED` and a fresh job receives a new callback scope and clean request without expired signed URLs or callback data. Rally processing state and outbox audit events change in the same serializable transaction.
- Failed History rows expose retry only to ADMIN/OPERATOR viewers. Four isolated PostgreSQL lifecycle/retry tests, full Server `168/168`, Web `94/94`, Server/Web typechecks and twelve stored GraphQL operations passed.

Boundary: `startCapture` registers the central ingest session and publisher target; it does not embed camera credentials or control a vendor camera. The external publisher/secret manager remains deployment-owned.

## 2026-08-07 — Immutable correction and score-ledger completion

Status: correction draft, immutable supersession, score correction and outcome-only geometry reuse are implemented on the Contract Lab-aligned Annotation workstation.

- Added the typed `createCorrectionDraft(submissionId: ID!): Rally!` GraphQL mutation. It authorizes the current operator/device, serializes against Rally/set edits, restores immutable submission key points into gray mutable rows, keeps the prior submission authoritative until Enter, records an audit operation/outbox event and rejects competing drafts.
- Enter now supports a correction chain. The replacement submission stores `supersedesSubmissionId`; the prior submission, ClipJobs, AiJobs and AnalysisRuns remain immutable and become `SUPERSEDED`. A no-op correction is durably rejected.
- Added one ordered `ScoreLedgerEntry` CAS ledger across initial `POINT_AWARD` and later `CORRECTION` mutations. Winner changes use deltas such as `(-1,+1)`; resolved-to-unknown reverses the old contribution; unknown-to-resolved adds exactly one. Unknown submission score snapshot fields and PointAward remain null/absent as required.
- Outcome-only corrections with identical key-point geometry reuse completed clip bytes, timing mappings, AI geometry, identities, paths, artifacts and FlatBuffers overlay assets under newly linked immutable job/run rows. They complete without transcoding or a provider request; if no completed reusable pipeline exists, the ordinary queued pipeline remains the fallback.
- The Annotation page now falls back to the newest submitted Rally when no draft is open, renders its mask green and exposes `建立修正草稿`; an open correction is gray and clearly labelled. Server/Web typechecks, 30 focused correction/command integration tests, full Server `164/164` and Web `94/94` suites, nine GraphQL documents and production builds passed before this checkpoint.

Open limitation: the optional short-lived key-point drag soft-lock hint is not yet implemented; revision/CAS remains the canonical concurrency authority. Production identity and retention durations remain explicit deployment decisions.

## 2026-08-07 — Phase 7 restart and restore acceptance

Status: restart and local backup/restore drills passed against the running Compose stack; the reusable safety procedure is documented in `docs/OPERATIONS_RUNBOOK.md`.

- Recorded pre-drill canonical counts and one persisted overlay chunk identity, then restarted Redis, Server, all six workers, MinIO and PostgreSQL in dependency-safe order. Server returned PostgreSQL/Redis/MinIO `ready` after every stateful restart; all application containers finished running/healthy with zero unexpected automatic restarts.
- Post-drill canonical counts remained exactly 2 Rallies, 1 RallySubmission, 2 AnalysisRuns, 19 MediaAssets and 1 OverlayChunk. AnalysisRun `985daee2-714d-4e2a-9514-0ebf58db1f51` retained its 816-byte chunk and SHA-256 `349858af4b6939a2e676dd2e4676f6c3289f2bad823797e867bba9830159f04b`; authorized manifest and chunk requests both returned HTTP 200.
- Created a 308,217-byte PostgreSQL custom-format dump, verified its TOC and SHA-256, restored it to the isolated `vmai_restore_smoke` database and reproduced all five canonical counts before dropping only that temporary database.
- Mirrored `raw-media`, `dvr-media`, `rally-media` and `analysis-artifacts` into an isolated Docker backup volume and restored them under a temporary MinIO bucket. Source/backup/restore object counts matched at 0/12/2/5; the temporary bucket and volume were removed afterward.

Open limitations: approved retention durations remain a human deployment decision, so no destructive lifecycle default is enabled. Production-grade scheduled/off-host backup automation, metrics export and audit dashboard remain hardening work; this checkpoint proves the underlying restart and restore paths rather than claiming those external operations are scheduled.

## 2026-08-07 — Contract Lab workstation and Saved Analysis View checkpoint

Status: implemented directly on `integration/phase3-annotation`, rebuilt into the local Compose runtime and ready for user-led workflow testing.

- Tightened the PC-only Annotation workstation to the Volleyball AI Contract Lab interaction model while preserving central-system boundaries. The route now auto-opens the newest live server DVR window, refreshes the capture timeline every 2.5 seconds so its buffer grows in place, hides native video controls, and keeps playback in the bottom transport. Plain wheel/pointer drag pans, Shift+wheel zooms, ready-range clicks create bounded playback windows and frame arrows still call authoritative server stepping.
- Kept the fixed Z service, X contact, Space playback, `<`/`>`/`?` close and Enter submit semantics with the Rally-level outcome model. The upper-right gear owns all TanStack Hotkeys rebinding, `formatForDisplay` keycaps and Restore All Defaults; the Coach/iPad PWA settings page contains only PWA/display/connectivity settings and no Annotation configuration.
- Added a versioned local Annotation outbox. One disconnected command is persisted with its original command ID and authoritative cursor, shown as pending, and replayed only after reconnect snapshot/revision comparison; a mismatch or server-requested refetch becomes `needs_confirmation` and requires discard/re-entry at the current frame. The one-pending-command gate avoids pretending that server-generated key-point IDs and revisions can be predicted offline.
- Added Redis-backed room presence with 30-second device TTL, 10-second heartbeat and pub/sub fan-out. Authorized WebSocket join/leave now emits the existing strict `presence_snapshot`; the workstation header shows the current online-device count and names without putting presence in durable canonical tables.
- Added strict, per-user Saved Analysis Views through additive GraphQL fields and stored operations. Versioned filter/layout documents can retain navigation, filters and overlay presentation only; metrics, aggregate samples and artifacts are rejected. Saving the same `(user, match, name)` updates one configuration, while membership/admin authorization and per-user listing prevent cross-user leakage.
- Validation passed: Server/Web typecheck, eight stored GraphQL operations, 13 core-domain integration tests, 23 focused timeline/hotkey tests, production Nuxt build and the UI detector. Local Web/Server are healthy; a headed 2048×1217 smoke auto-created a live window, played the bounded HLS sample and displayed four ready ranges plus frame 191. Annotation WebSocket interaction is not claimed in that browser run because the repo's generated local certificate is not trusted and `mkcert` is not installed on this host.
- A later two-tab headed runtime accepted the local certificate for the session and verified real Redis presence fan-out: both independent device sessions showed two online members, then the remaining tab returned to one after its peer disconnected. The outbox smoke queued one offline service command with a stable ID and persisted payload; its test Rally was subsequently voided through the normal GraphQL annotation command path.

Open limitations: correction-draft/score-ledger semantics, key-point soft locks and Phase 7 restart/backup/retention acceptance remain. Production identity provider and retention durations remain explicit deployment decisions and are not invented here.

## 2026-08-07 — Phase 5 windowed FlatBuffers overlay completion

Status: implemented directly on `integration/phase3-annotation`, migrated and runtime-verified in the local Compose stack.

- Added the official FlatBuffers runtimes to the TypeScript contracts and uv-managed Python SDK. Central callback ingest now parses the full VOV1 table, validates passthrough/video metadata and every SoA column, then creates fixed VOC1 chunks; the fake provider emits a real no-detection VOV1 with missing data represented by flags rather than fabricated observations.
- Added durable `OverlayManifest`/`OverlayChunk` metadata and immutable MinIO chunk assets. Central REST 1.3.0 serves an authorization-filtered manifest and chunk bytes without exposing storage identity.
- Replay now verifies chunk length/SHA-256/schema, keeps only the current and next chunk, cancels stale seek requests, and offers Off/Tracking/Coach/Tactical/Debug modes plus bbox, track ID, action, ball, trail, footprint and confidence layers. Action remains disabled when no taxonomy exists; contact-event JSON remains a fallback for historical runs.
- Runtime proof: a fresh fake-provider AiJob completed in one attempt and produced AnalysisRun `985daee2-714d-4e2a-9514-0ebf58db1f51`, a 60-frame manifest and one 816-byte VOC1 chunk. The authorized manifest and chunk endpoints both returned HTTP 200; the chunk content type and byte count matched persisted metadata, and the replay route returned HTTP 200.
- Validation passed: 11 contract tests, 4 DB tests, Prisma validation/generation/structural check (43 models, 25 enums), Server/Web typecheck and 13 frozen-uv SDK tests.

Open limitations: saved Analysis Views, correction-draft UI, local annotation outbox/presence polish and Phase 7 restart/backup/retention acceptance remain.

## 2026-08-07 — Contract Lab-aligned Annotation editor checkpoint

Status: implemented directly on `integration/phase3-annotation`; this is the accelerated single-branch checkpoint requested by the user.

- Rebuilt the PC Annotation route as a dark, full-screen Contract Lab-style editor with a top sync/media bar, full-height video stage, Rally/keypoint inspector, persistent transport controls, a two-lane DVR timeline and the fixed six-command strip. The implementation keeps server-side buffer/streaming truth: ready ranges and the live edge grow with the capture timeline, bounded seek creates a server playback window, and frame arrows use authoritative server stepping.
- Moved all Annotation and player shortcut customization into the workstation's upper-right gear dialog. TanStack Hotkeys still owns rebinding/recording; displayed keycaps use `formatForDisplay`, conflicts and reserved gestures fail without mutation, and Restore All Defaults remains available. The Coach/iPad PWA `/settings` page now contains no Annotation preferences.
- Added server support for draft-only MOVE/DELETE/REOPEN/VOID commands while preserving immutable SUBMITTED Rally behavior. MOVE re-resolves the browser observation through server media authority; DELETE keeps SERVICE undeletable and moves soft-deleted rows to tombstone sequence indexes; REOPEN clears terminal/outcome state; VOID closes only an unsubmitted draft.
- Fixed the discovered soft-delete unique-index collision by transactionally parking tombstones below active sequence space and using a two-phase active resequence. No score frame/event is introduced, and `<`, `>`, `?` still terminalize the existing last server-confirmed key point.
- Validation passed: Web and Server typecheck, 18 focused Hotkeys/command-strip tests, 29 Annotation command/snapshot integration tests and the UI detector. Docker remains running; broader visual and end-to-end acceptance is delegated to the user per the accelerated plan.

Open limitations: exact production video appearance depends on the real streamed capture and user viewport. Production SSO/provider selection, saved Analysis View editing, per-frame overlay chunk playback and deployment backup/retention drills remain outside this checkpoint.

## 2026-08-07 — Phase 6 identity and evidence-bearing analytics

Status: implemented directly on `integration/phase3-annotation`, rebuilt into the local server/Web containers and runtime-probed.

- Added same-match manual `(analysis_run_id, track_id) → roster_entry` correction with ADMIN/OPERATOR/COACH authorization. The AnalysisTrack is unchanged and remains run-local; unbound tracks stay visibly labeled as Track IDs.
- Added the versioned `coachMatchAnalytics` read model with baseline Rally/outcome, contact/participant, court-position, path-quality, identity-coverage and provider-action availability metrics. Every metric carries samples, excluded/unknown counts, quality breakdown and feature dependencies.
- Replaced Players/Stats placeholders with real roster evidence, unassigned-track mapping controls, feature availability and a full evidence table. Action metrics are explicitly unavailable rather than fabricated when the provider omits action.
- Server/Web typecheck, six stored GraphQL operations, production Nuxt build and the UI detector passed. A live GraphQL probe over the d003 smoke returned one unknown-outcome Rally, two contact events with unresolved/no-player quality, one unavailable path, zero identity/action/court-position availability and the exact sample/exclusion envelopes expected from the fake provider.

Open limitations: production SSO/auth provider selection is intentionally not invented by this repository and remains fail-closed outside development. Saved Analysis View editing, real-provider action/court data, per-frame FlatBuffer chunks and restart/backup/retention drills remain deployment hardening work.

## 2026-08-07 — Phase 5 Coach replay and normalized analysis

Status: implemented directly on `integration/phase3-annotation` and running in the local Compose stack.

- Completed callback ingestion now normalizes analysis-run-local tracks, contact events, actors/candidates, representative court positions and adjacent A/B path segments while activating the AnalysisRun. Optional action/confidence stays nullable and provider-defined; external `court_pos` is stored unchanged with no clamp/projection.
- Added the authorization-filtered `coachRallyReplay` GraphQL read model and stored operation. GraphQL carries immutable structured replay data only; canonical MP4 bytes remain on an authorized REST stream with HTTP Range/206 support.
- Replaced Replay and Paths placeholders with the landscape Coach UI: canonical clip playback, clip-frame tracking, event-local Canvas boxes/ball points, key-point seek controls, processing/outcome context and an SVG court path view that preserves out-of-court coordinates and missing-position empty states.
- Rebuilt the server and Nuxt production images. A live server-container probe returned the d003 Rally, clip metadata, two normalized events and one path over GraphQL; a `bytes=0-99` clip request returned HTTP 206, `video/mp4`, `Content-Range: bytes 0-99/652197` and exactly 100 bytes. Server and Web are healthy.

Open limitations: the fake provider intentionally has no court positions, so its one path renders the honest unavailable state. Per-frame FlatBuffer chunking/lazy overlay sequence playback, track-to-roster corrections, cross-Rally analytics/saved views and production identity are the remaining Phase 5/6/7 work.

## 2026-08-07 — Phase 4 canonical clip and external AI vertical slice

Status: implemented directly on `integration/phase3-annotation`; the Phase 4 runtime exit has passed locally against real persisted d003 DVR media and the development fake provider.

- Replaced the clip-worker and AI-dispatcher TODOs with cancellable durable PostgreSQL polling runtimes. Claims use `FOR UPDATE SKIP LOCKED`, bounded leases, attempt limits and sanitized retry state; immutable submission IDs remain the sole processing anchor.
- The clip worker verifies MinIO source metadata/bytes, clamps pre/post roll to the service anchor's contiguous DVR discontinuity, transcodes a canonical H.264/AAC MP4, probes authoritative video metadata, stores a timing manifest and persists submission-key-point-to-clip PTS/time/frame mappings.
- The dispatcher verifies provider capabilities, creates an independent short-lived MinIO download URL, derives a job-scoped callback token whose plaintext is not persisted, sends Job `1.1.0` with an idempotency key and records only a redacted request audit copy plus the exact request hash.
- Added authenticated REST JSON/multipart callback ingest with schema, passthrough, checksum, size and `VOV1` validation; completed results create raw analysis/overlay assets, one idempotent receipt and one activated AnalysisRun before moving the Rally to COMPLETED.
- Repaired the SDK provider adapter's deferred-annotation/FastAPI `BackgroundTasks` injection bug. The fake provider now returns deterministic contract-valid unresolved/no-player output for every immutable key point and does not fabricate AI tracks, action/confidence or `court_pos`.
- Real runtime evidence: the d003 smoke ClipJob completed in one attempt with actual capture bounds `0..2000333` µs; its AiJob was accepted and completed in one attempt; the server returned callback HTTP 200 and persisted one COMPLETED AnalysisRun plus one COMPLETED callback receipt. Server/fake-provider health remained green and both workers remained running.

Open limitations: detailed AnalysisTrack/ContactEvent/Path normalization, overlay chunk/manifest serving, authenticated Coach replay media and Canvas/court views remain Phase 5. Production secret-manager resolution and production cookie/device identity remain Phase 7 hardening.

## 2026-08-07 — Phase 3 workstation, Coach read model and Phase 2A soak exit

Status: direct single-branch implementation continues on `integration/phase3-annotation` after checkpoint merge `2480dfa` reached `main`; feature work no longer waits on subagent or per-slice PR overhead.

- The PC-first annotation workstation now uses the dedicated annotation WebSocket for Z service, X contact, `<`, `>`, `?` close and Enter submit, while Space toggles playback. It polls authorized server snapshots as reconnect/collaboration fallback, gates commands on authoritative media state and renders gray mutable versus green immutable timeline masks. TanStack Hotkeys remains customizable with Restore Defaults and `formatForDisplay`.
- Added the additive authorization-filtered `coachMatchState` GraphQL read model and stored operation. Its versioned `1.0.0` payload contains score/side assignment, capture health and immutable submission/clip/analysis summaries only; mutable drafts, media bytes and storage identity are excluded.
- Replaced the Coach live/history placeholders with landscape iPad-oriented real-data views: side-aware live scoreboard, capture health, latest submitted Rally processing, set filtering and immutable submission links into replay. Both views poll every two seconds and retain explicit loading/error/empty states.
- The real two-hour Compose soak completed successfully with 214 samples, all 14 services running, zero restarts, zero health failures and zero API failures. Aggregate container memory ranged from 902.708 MiB to 1004.429 MiB, ended at 957.440 MiB and reported 101.721 MiB bounded growth; stderr was empty. Docker remains running for continued development.
- Minimum integration gates passed: server and Nuxt typechecks, regenerated GraphQL SDL, three stored-operation validation and the UI detector. Broader manual workflow testing is intentionally delegated to the user under the accelerated development plan.

Open limitations: production clip creation/serving, external AI dispatch/callback ingestion, analysis overlays/corrections and production cookie/device identity remain unfinished. These are the next direct vertical slices; the current Coach pages show only persisted truth and do not fabricate unavailable analysis.

## 2026-08-07 — Phase 3 backend checkpoint

Status: Phase 3A service, Phase 3B contact/atomic close and the Phase 3C immutable-submit implementation are consolidated on `integration/phase3-annotation`. Phase 3C merged through [PR #33](https://github.com/henry753951/volleyball-monitoring-ai/pull/33) after all three CI jobs passed. This is a development checkpoint, not final product acceptance; remaining implementation now continues directly without subagents.

- Enter/`SUBMIT_RALLY` now creates immutable submission/key-point snapshots, freezes side/outcome/score/clip policy, updates the resolved score ledger with one `PointAward` or preserves explicit unknown nulls, queues one canonical clip job and transitions the Rally to SUBMITTED/CLIP_QUEUED in one serializable transaction.
- Existing server tests (158), server typecheck, checksum/scaffold gates and PR CI are green. The interrupted additional Phase 3C test expansion is intentionally not claimed; the user will lead broader manual testing while direct implementation proceeds.

## 2026-08-07 — Phase 3B contact, atomic close and snapshot

Status: Space/contact, `<`/`>`/`?` atomic close/outcome, the authorized rally snapshot and both annotation transports passed main-Agent review and merged into `integration/phase3-annotation` through [PR #31](https://github.com/henry753951/volleyball-monitoring-ai/pull/31). The focused WebSocket transport tests were independently reviewed and merged into the feature branch through [PR #32](https://github.com/henry753951/volleyball-monitoring-ai/pull/32).

- Space resolves the observational playback cursor before entering the durable service, then transactionally revalidates the active device, exact match/capture room, membership/admin role, playback window, mapping version, Rally DVR program, non-gap READY indexed segment, capture epoch, half-open capture-time/frame ranges and presentation-origin player time. A contact before service or outside that exact persisted mapping fails closed without draft mutation.
- Contacts are inserted in authoritative capture-time/frame order under the Rally lock while preserving sequence 0 for SERVICE. Same-frame CONTACT rows remain representable and both receive `possibleDuplicate=true`; the SERVICE point is never marked as a duplicate.
- `<`, `>` and `?` use one `CLOSE_RALLY` command against the server-confirmed last non-deleted key point. The transaction marks that existing point terminal, moves the Rally from OPEN to READY and records resolved left, resolved right or explicit unknown as a Rally-level outcome. It creates no new time, key point, score event/frame, submission, point award, clip job, AI job or analysis run.
- Contact, close and contact-vs-close races are serialized with revision CAS and durable loser receipts. Transaction-time room authorization is repeated for close as well as cursor-bearing commands; membership changes between the outer lookup and the SERIALIZABLE transaction produce a stored `ROOM_AUTHORIZATION_STALE` rejection while the Rally and terminal flag remain unchanged.
- Added strict GraphQL and dedicated WebSocket command paths plus an authorized `rally_snapshot` read containing the canonical side-assignment ID, full ordered key-point state and room-wide server sequence. Malformed JSON, room mismatch, stale/non-last/deleted targets and revision conflicts fail closed and require snapshot refetch where appropriate.
- Main review rejected weaker contact mapping checks, caught an incorrectly placed duplicate authorization guard and required a deterministic stale-close authorization test before merge. The final feature head passed contracts 8, database 4, media 88, server 158, worker 147 with 6 explicit skips, Web 91 and frozen-`uv` SDK 12 tests; every workspace typecheck, GraphQL SDL/operation check, `validate:all`, checksum reproduction, production build and `git diff --check` passed. PR #31 then passed `contracts-sdk`, `typescript` and `compose-config` before merge.
- Enter/`SUBMIT_RALLY`, immutable RallySubmission snapshots, score-ledger/PointAward CAS and the queued canonical clip request remain Phase 3C; no immutable submission is claimed by this slice.

## 2026-08-07 — Phase 3A durable Z/service command

Status: the durable receipt/idempotency foundation and Z/service vertical slice passed main-Agent review and merged into `integration/phase3-annotation` through [PR #30](https://github.com/henry753951/volleyball-monitoring-ai/pull/30). The bounded Phase 2A soak harness passed review and merged through [PR #29](https://github.com/henry753951/volleyball-monitoring-ai/pull/29); its real two-hour run is active in the background while Phase 3 continues.

- Accepted Annotation Realtime `2.0.0` as the strict pre-release contract, aligned the version registry and added schema-backed TypeScript discriminated unions for commands, ACKs, rejections, connection, rally snapshot, presence and processing messages. Canonical room IDs now require the exact lower-case `match:<uuid>:capture:<uuid>` form; non-UUID command/rally IDs, noncanonical rooms, v1/X/timestamp/score-frame payloads and extra fields fail closed.
- Added the deploy-safe `AnnotationCommandReceipt` migration with a transport-wide BIGINT server sequence, globally unique command ID, authenticated user/device, canonical request hash/JSON, accepted flag and stored response JSON. Legacy `AnnotationOperation` rows remain deployable with a nullable receipt link rather than fabricated receipts.
- Added one shared annotation-command service behind the dedicated `/ws/annotations` endpoint and Pothos GraphQL fallback. Development auth creates an active device session; production remains deliberately fail-closed until the production cookie/device-session boundary lands.
- Z resolves the observational browser cursor through the existing persisted media authority before the transaction. The serializable accepted transaction revalidates active device, membership/admin, capture-to-match, exact playback-window mapping, DVR program, segment, epoch, ready sample-index/range/frame identity, current set and side assignment.
- Rally creation persists the exact playback-window program, one OPEN rally, sequence-0 SERVICE key point and revision 1. The set-level lock rejects a sequential or concurrent second OPEN/READY draft with a durable `ACTIVE_RALLY_EXISTS`; a LIVE set wins over any future PLANNED set.
- Accepted mutation, receipt, operation and outbox rows commit atomically. Identical accepted and rejected retries are read back from stored JSON and emit byte-identical `JSON.stringify` output; same-ID/different-payload returns deterministic `COMMAND_ID_REUSED`. Known room/media/revision/domain failures retain rejected receipts without Rally/KeyPoint/Operation partial rows, while late infrastructure failures roll back everything.
- Main review rejected the first implementation until it removed newest-program selection, added exact segment membership, fixed active-draft semantics, transaction-time authorization, canonical room handling, JSONB replay ordering and strict ACK types. Added tests cover fresh and legacy migration, exact program, missing/foreign/removed mappings, revoked/stale authorization, LIVE-vs-PLANNED set selection, sequential/concurrent active drafts, command reuse and rollback.
- Final feature gates passed: contracts 8, database 4 and server 138 tests; the complete branch reported 458 JavaScript/TypeScript plus 12 frozen-`uv` Python tests, all repo typechecks/builds, `validate:all`, GraphQL SDL/operation checks and `git diff --check`. PR #30 passed `contracts-sdk`, `typescript` and `compose-config` before merge. The main Agent independently reran the affected 150 tests and three affected package typechecks.
- No contact, close, immutable submission, score ledger/`PointAward`, clip, AI or analysis write path is claimed by this historical slice. Phase 3B later added contact plus atomic `<`/`>`/`?` close/outcome and the authorized GraphQL rally snapshot/refetch boundary; the final physical defaults are X contact and Space playback. Phase 3C remains Enter/immutable submission.

## 2026-08-07 — Phase 2A round 2 persistence and ingest truth

Status: persistence/timeline [PR #12](https://github.com/henry753951/volleyball-monitoring-ai/pull/12), media ingest/sample-truth [PR #13](https://github.com/henry753951/volleyball-monitoring-ai/pull/13), production media runtime [PR #24](https://github.com/henry753951/volleyball-monitoring-ai/pull/24), real-ingest corrections [PR #25](https://github.com/henry753951/volleyball-monitoring-ai/pull/25), the PC-first DVR workstation [PR #26](https://github.com/henry753951/volleyball-monitoring-ai/pull/26) and the persisted playback sample resolver [PR #27](https://github.com/henry753951/volleyball-monitoring-ai/pull/27) passed the required `contracts-sdk`, `typescript` and `compose-config` checks before merge into `integration/phase-2a-media-truth`. The integration-to-main [PR #8](https://github.com/henry753951/volleyball-monitoring-ai/pull/8) is ready after the real ingest/read-path exit; the two-hour soak remains a release/operations gate and does not block the next annotation slice.

- Added the `PlaybackWindow`/ordered `PlaybackWindowSegment` persistence domain, artifact internal schema version, named range/readiness constraints and the second production migration. Prisma validate/generate, migration deploy, DB structural tests and live PostgreSQL server integration all passed.
- Added membership-filtered `CaptureSession`/`CaptureTimeline` GraphQL reads. They choose the newest program deterministically, expose decimal-string bigint timeline/range metadata only, coalesce touching ready ranges only within one discontinuity, and never expose segment/object/sample-index details.
- Added the shared `@volleyball-monitoring/media` authority package. Its strict v1 sample-index codec rejects numeric 64-bit values, extra/malformed fields, empty tables, holes, overlaps, frame discontinuities and invalid epoch/time-base context; serialization round-trips stably without changing the stored document shape.
- Fixed endpoint rounding to rescale the absolute epoch-relative sample end once. Exact adjacent 30 fps and true 60000/1001 segments no longer acquire a fabricated 1 microsecond gap. Realistic VFR, negative PTS, values beyond `2^53`, earlier-on-tie resolution and exact previous/next window/discontinuity boundaries are covered in the shared package.
- Added the pure capture epoch/discontinuity planner. PTS reset, timestamp jump, source restart/identity/time-base change and explicit gaps open deterministic epochs while canonical capture time/frame stay monotonic; unavailable intervals remain explicit half-open gaps with no fabricated samples.
- Added shell-free, bounded and cancellable ffprobe execution plus finalized-recording path validation. The ingest orchestrator produces exactly init/media/sample-index artifacts, verifies SHA-256/length/content type/internal schema version, uses deterministic content-aware idempotency, records stable retry stages and publishes readiness transactionally through typed ports.
- Added typed persisted playback-window create/get, bounded HLS manifest and authorized init/media resource routes through [PR #14](https://github.com/henry753951/volleyball-monitoring-ai/pull/14). Requested bounds are clamped to one contiguous discontinuity, the injected sample resolver creates the presentation origin, all wire time remains decimal-string bigint, expiry is 410, and same-origin opaque resource tokens reveal no bucket/object key.
- Live HTTP integration creates and drops an isolated PostgreSQL database and covers member/admin/outsider/anonymous access, bigint descriptor fields, manifest plus verified init/media bytes, gap/not-ready/missing/expired resources, corrupted object data, transaction rollback and zero forbidden Annotation/Submission/Clip/AI writes. Server now passes 34 tests.
- Full integrated gates passed after rebasing onto the persistence migration and again in feature CI: contracts 6, DB 2, media 55, server 34, worker 108, Web 43 and frozen-`uv` SDK 12 tests, plus all workspace typechecks, lint and production builds.
- Applied `20260807120000_playback_windows` to the local Docker PostgreSQL database and rebuilt the integration server/Web images. MinIO runs on the repo-configured `9100/9101`, server/Web are healthy, and a Traefik HTTPS GraphQL probe returned `health=ok`; PostgreSQL, Redis, MediaMTX, fake AI and all six workers remained running.
- Repaired every Bun Docker image's frozen-install layer to copy all workspace manifests, and made the scaffold validator derive that requirement from the root workspace list. Actual server, Web and worker images rebuilt successfully; [PR #8](https://github.com/henry753951/volleyball-monitoring-ai/pull/8) returned to three green required checks.
- Added the concrete finalized-file and MinIO artifact adapters through main-Agent-reviewed [PR #15](https://github.com/henry753951/volleyball-monitoring-ai/pull/15). The fMP4 reader is bounded, cancellable and strict about 32/64-bit box layout and source mutation; the official MinIO client performs conditional immutable writes, exact metadata verification, idempotent retries and secret-safe failures without exposing object identities to clients.
- Main-Agent runtime review generated a real fragmented MP4 with ffmpeg and split it into non-empty init/media artifacts, then exercised upload, verification and idempotent retry against the running local MinIO bucket. Both isolated smoke artifacts were removed, the worktree was clean, and the final PR #15 CI passed all three required checks after its TypeScript fixture syntax repair.
- Added deterministic cross-segment nearest-sample and exact frame-step resolution through [PR #16](https://github.com/henry753951/volleyball-monitoring-ai/pull/16). Complete indexes always return `frame_exact`, nonzero snap distance does not downgrade an exact persisted frame identity, ties select the earlier sample and stepping never crosses a half-open playback-window/discontinuity boundary.
- Added the bounded official-MinIO server reader through [PR #17](https://github.com/henry753951/volleyball-monitoring-ai/pull/17). It enforces configured bucket/object limits, exact expected length, incremental SHA-256 and secret-safe errors. The integration server image was rebuilt with Bun 1.3.14 and its Traefik GraphQL health probe passed against the running Compose stack.
- Added the one-segment incremental epoch planner through [PR #18](https://github.com/henry753951/volleyball-monitoring-ai/pull/18). It resumes exact persisted heads or opens a caller-supplied real epoch UUID for restart, time-base/PTS discontinuity and explicit gaps; the same persisted ID is used by both `CaptureEpoch` and its sample index.
- Added the read-only persisted sample-index repository through [PR #19](https://github.com/henry753951/volleyball-monitoring-ai/pull/19). One bounded Prisma read accepts only already-authorized ordered segment UUIDs, READY non-gap rows and strict v1 JSON whose byte length, SHA-256, epoch origin, sequence, half-open bounds, PTS and frame counts all reconcile with PostgreSQL.
- Added the serializable Prisma ingest persistence boundary through [PR #20](https://github.com/henry753951/volleyball-monitoring-ai/pull/20). A per-capture PostgreSQL advisory lock reserves one FIFO segment and three immutable `UPLOADING` artifact identities, records exact byte/hash expectations, and atomically publishes all artifacts, segment, epoch, program and session readiness. Replays are idempotent, packaged program-profile conflicts fail closed, transaction errors are sanitized, and publishing a draining final segment preserves `STOPPING` instead of resurrecting `LIVE`.
- Added authenticated resolve-cursor/frame-step HTTP composition through [PR #21](https://github.com/henry753951/volleyball-monitoring-ai/pull/21). Strict `unknown` request parsing, match membership, mapping version/expiry, half-open window bounds and persisted ordered indexes precede every authoritative anchor; frame step loads only the current mapping plus at most one ready exact neighbor and distinguishes `WINDOW_BOUNDARY` from `SAMPLE_NOT_FOUND`.
- Corrected the program/epoch time-base boundary through [PR #22](https://github.com/henry753951/volleyball-monitoring-ai/pull/22). `DvrProgram.timeBase*` remains stable packaged-rendition metadata, while `CaptureEpoch.sourceTimeBase*` remains the authoritative raw-PTS unit and may open a `TIME_BASE_CHANGE` epoch after reconnect without fabricating or renumbering samples.
- Added the production-bound media-indexer runtime kernel through [PR #23](https://github.com/henry753951/volleyball-monitoring-ai/pull/23). It validates strict private hook jobs, reconciles the recording spool deterministically, preserves per-capture FIFO/singleton semantics in pg-boss, classifies sanitized retry/dead-letter outcomes, resolves stable program profiles, and composes the reviewed ffprobe, ingest, immutable artifact and publish boundaries without making the hook the source of truth.
- Added the production media-indexer composition and MediaMTX completion hook through [PR #24](https://github.com/henry753951/volleyball-monitoring-ai/pull/24). The worker now starts the real pg-boss consumer, periodic spool reconciliation and bounded hook server with explicit cleanup; the custom MediaMTX image sends authenticated UTF-8-bounded completion notifications while reconciliation remains the source of truth. A real isolated PostgreSQL pg-boss test covered retry/dead-letter behavior.
- A real eight-second 1280×720 H.264/AAC RTMP stream exposed millisecond-quantized RTMP PTS and duplicate scan/hook jobs. [PR #25](https://github.com/henry753951/volleyball-monitoring-ai/pull/25) derives each non-final sample duration from the next PTS, preserves a validated positive final duration, assigns deterministic job IDs and classifies deterministic repository failures as permanent. The repeated hook scan left exactly four completed jobs with zero retries and no duplicates.
- The successful d003 ingest produced one DVR program, four authoritative epochs/segments, four READY init assets, four READY media assets and four READY sample indexes. MinIO contained exactly 12 non-empty immutable objects. All four jobs completed without retry; capture time/frame remained monotonic across the independent MediaMTX recording segments.
- Added the PC-first authoritative DVR workstation through [PR #26](https://github.com/henry753951/volleyball-monitoring-ai/pull/26). The desktop three-region layout uses bounded server windows, a BigInt-safe ready/gap/discontinuity timeline, 1×–8× zoom, bounded pan, reset, stale-response generation guards, descriptor-preserving frame step and an authority inspector. The later product revision finalized Z service, X contact, Space playback, `<`/`>`/`?` close and Enter submit; displayed bindings use the TanStack `formatForDisplay` wrapper. Mounted command-gate tests cover IDLE, stale OPEN, OPEN with a server-confirmed last point and READY submission state.
- Main-Agent review and live runtime testing found that production playback-window creation lacked the separate persisted sample resolver even though its MinIO reader was present. [PR #27](https://github.com/henry753951/volleyball-monitoring-ai/pull/27) now loads ordered READY sample indexes through the existing repository, uses the shared exact-BigInt nearest-sample resolver, preserves earlier-on-tie behavior, maps an exact live-edge target to the latest half-open sample and rejects out-of-range/mismatched loader results.
- The PR #27 candidate passed a complete d003 read-path smoke: live/archive window, descriptor and bounded HLS manifest returned HTTP 200; init/media resources returned `video/mp4` with 1,217 and 1,916,379 bytes; resolve-cursor returned exact source PTS 93,420, capture time 5,499,999 µs and frame 165; previous/next returned frames 164/166; stepping beyond the live edge failed closed with HTTP 422 `SAMPLE_NOT_FOUND`. All 14 Compose services remained running, and the merged Web and server images were rebuilt locally.
- Luna's real headed Chrome session used a session-only bypass for the local self-signed certificate and loaded the d003 workstation at 1440×900. It showed four ready ranges, created a live window, reached `cursor ready`, displayed epoch `61343742-df62-531a-9909-c21543220d85`, frame 191, capture time 6,366,999 µs and enabled Z only after authority was ready; GraphQL, window, bounded segment and resolve-cursor requests returned 200. The six fixed commands/no X, specific disabled reasons and no horizontal overflow were visually confirmed. A later interaction retry did not retain the local match session, so headed frame-step/zoom/gap interactions are not claimed; mounted Web tests and the real REST chain cover those mechanics separately.
- Current verified package totals are contracts 6, DB 2, media 88, server 124, worker 153, Web 91 and frozen-`uv` SDK 12 tests. PRs #16–#27 each passed the three required feature checks; main-Agent post-rebase/runtime gates additionally passed the affected package typechecks/builds, Prisma validation and the repository syntax gate.
- Recorded the read-only `H:\Repos\volleyball-ai-contract-lab` source/UI/data review in [REFERENCE_EDITOR_AUDIT.md](REFERENCE_EDITOR_AUDIT.md). Phase 3 may adapt its PC three-region editor, two-lane timeline, selected-point inspector and correction-as-new-submission workflow. It must not copy its X/Space bindings, client timestamp/localStorage truth, whole-file DVR loading, mock export contract or standalone-end wording. The annotation workstation is PC-first; only the coach display is required to be a landscape-first iPad PWA.
- The original untracked `.data/exports` snapshot contains 40 files totaling 87,165,356 bytes: 7 MP4, 14 JPEG, 18 valid JSON and one text file. Nothing is copied directly. Phase 4 may derive only compact deterministic schema fixtures after stripping all media, URLs, credentials, hashes, filenames, IDs, timestamps and unique metadata; preserved edge cases include unresolved/multiple actors, optional action/confidence, tracking present/absent, terminal/unknown states and external `court_pos` outside `0..1`.

Open limitations: production cookie identity, headed browser playback/timeline interaction against the real d003 media, deterministic reconnect/restart smoke beyond the observed per-recording discontinuities, the pg@9/Prisma adapter deprecation warning and the two-hour bounded-memory soak remain active. No Rally, KeyPoint, AnnotationOperation, RallySubmission, ClipJob or AiJob write path was added; Phase 3 begins only after the remaining Phase 2A exit checks are recorded.

## 2026-08-07 — Phase 2A round 1 media contract and authority kernel

Status: integrated on `integration/phase-2a-media-truth` through main-Agent-reviewed [PR #9](https://github.com/henry753951/volleyball-monitoring-ai/pull/9), [PR #10](https://github.com/henry753951/volleyball-monitoring-ai/pull/10) and [PR #11](https://github.com/henry753951/volleyball-monitoring-ai/pull/11). Every PR passed the required `contracts-sdk`, `typescript` and `compose-config` checks before merge.

- Accepted ADR 0005 as the Phase 2A integration boundary: full DVR remains server-side; the PWA consumes bounded contiguous windows; browser cursors remain observations; persisted sample indexes resolve authoritative epoch/PTS/capture time/frame; windows never cross a gap or discontinuity.
- Advanced the central REST document additively to OpenAPI 1.2.0 with authenticated create/get window, bounded manifest/segment/media, canonical `/api/v1/media/resolve-cursor` and exact one-sample frame-step routes. Media authorization uses a same-site session cookie while the external AI callback retains its bearer boundary.
- Added the strict Media API Error 1.0.0 envelope and all approved HTTP/code classes. The six existing media payloads remain 1.0.0; TypeScript runtime parsers and Python SDK models reject numeric 64-bit wire values, malformed signed PTS, extra fields and invalid shapes.
- Added live/archive, RVFC/fallback, negative source PTS, frame-step, canonical anchor and error fixtures beyond JavaScript's safe-integer range. Contracts tests passed 6 cases and the frozen `uv` SDK suite passed 12 cases.
- Added the pure worker sample-index/resolver kernel with exact bigint rational rescaling, half-away-from-zero rounding, strict ffprobe-shaped parsing, deterministic earlier tie-breaking, presentation-end availability ranges and one-sample stepping across normal segment boundaries without crossing playback windows or discontinuities. Worker tests passed 17 cases plus typecheck/build.
- Added the canonical PWA media adapter, bigint-safe timeline/gap helpers, bounded current/previous/next window cache, reference-aware cleanup and explicit error recovery states. `WINDOW_EXPIRED`/`MAPPING_STALE` recreate around the last authoritative position, `WINDOW_BOUNDARY` recenters and retries, gaps never fall back across missing media, and malformed envelopes are fatal. Luna executed the frontend package gate: 43 tests, Nuxt typecheck and production build passed.
- The PWA now consumes `@volleyball-monitoring/contracts` directly and validates every successful media response at runtime. `target_player_media_time_us` remains bounded player-local time; canonical capture values never pass through JavaScript `Number`.
- Local Compose stayed operational throughout the round: PostgreSQL, Redis, server, web and fake AI remained healthy; MinIO, MediaMTX, Traefik and all six worker containers remained up. The workers are still honest scaffolds until the persisted ingest adapters below land.

Open limitations: this round verifies contracts and pure authority/client kernels only. Playback-window migration/GraphQL timeline, production pg-boss/ffprobe/MinIO ingest adapters, authenticated REST media serving, real PWA player/timeline integration, discontinuity Docker smoke and the two-hour bounded-memory soak remain active Phase 2A-2/2A-3 work. No Rally, KeyPoint, AnnotationOperation, RallySubmission, ClipJob or AiJob path was added.

## 2026-08-07 — Phase 1B core-domain vertical slice

Status: integrated on `integration/phase-1b-core-domain` through main-Agent-reviewed [PR #7](https://github.com/henry753951/volleyball-monitoring-ai/pull/7), [PR #5](https://github.com/henry753951/volleyball-monitoring-ai/pull/5) and [PR #6](https://github.com/henry753951/volleyball-monitoring-ai/pull/6), then merged to `main` through green integration [PR #4](https://github.com/henry753951/volleyball-monitoring-ai/pull/4).

- Added the repository's first Prisma migration from the approved 38-model/24-enum schema. Fresh-database `migrate deploy` passed twice, and the deterministic development seed passed twice without increasing its graph: one user, one match, two teams, two players, two roster entries and one initial side assignment.
- Added explicit local development identity resolution. It is enabled only by `DEV_AUTH_ENABLED=true`, validates UUID and role, upserts the user server-side and is forcibly disabled in production. The local Compose example uses the deterministic seeded `OPERATOR`; no browser database or service credentials are exposed.
- Added strict, modular Pothos code-first `Viewer`, `Match`, `Team`, `Player`, `MatchRosterEntry`, `MatchSet` and `CourtSideAssignment` objects with the exact ADR 0004 names/nullability. Authenticated match reads are membership-filtered and inaccessible details do not disclose existence.
- Added the transactional `createMatchSetup` write for the match, both teams and players, roster snapshots, set 1, ordinal-1 court assignment and creator `OPERATOR` membership. Normalized duplicate/empty input is rejected before the transaction and rollback counts are covered by a live PostgreSQL test.
- Added transaction-scoped PostgreSQL advisory locking for `swapCourtSides`. Concurrent same-ordinal requests produce exactly one success and one `BAD_USER_INPUT`; history remains ordered and non-overlapping, with the prior assignment ending at the new ordinal minus one.
- Added 10 live PostgreSQL integration cases within the 19-test server suite. Every run creates and drops a unique temporary database; the final audit found no temporary database or generated test user left behind. Strict source/test TypeScript and schema-export reproducibility pass without `ts-nocheck`, `ts-ignore` or `any` shortcuts.
- CI now runs for feature PRs targeting `integration/**`, starts PostgreSQL 17, deploys migrations, checks generated SDL and stored operations, runs DB/server tests and preserves the stable `contracts-sdk`, `typescript` and `compose-config` job names. Checksum reproducibility remains mandatory for main-targeted PRs/pushes and is intentionally main-Agent-owned for integration feature PRs.
- Replaced Nuxt demo IDs with a real same-origin GraphQL adapter, authenticated route boundary, match list/detail and a landscape match setup form. Loading, empty, auth-unavailable, API error, not-found, retained-input, pending and duplicate-submit states are covered; successful setup navigates to the returned UUID.
- PR #5 passed all three CI jobs (`typescript` included migration, schema, 19 server tests and builds); PR #6 passed all three again with the final Web consumer. Main-Agent local gates passed Prisma validate/typecheck/build, server 19 tests/typecheck/build, Web 21 tests/typecheck/build and SDL export/diff.
- Rebuilt the local Bun 1.3.14 server and Nuxt images. PostgreSQL/Redis/MinIO readiness stayed `ok`; server and Web are healthy. Through Traefik HTTPS, the main Agent read the seeded identity/match, created a real two-team/four-player match, swapped sides at ordinal 3 and read the resulting `1..2` plus `3..open` history.
- Headed Chrome then exercised the real UI: duplicate team name/short-name validation retained every field, corrected input created another match and navigated to its real UUID live route, and the home list showed the created record. A review-found empty `/matches//history` header link was removed outside match context. The browser was closed and generated Playwright artifacts were deleted; the only console error was the expected local self-signed TLS warning.

Open limitations: media ingest/full DVR, authoritative playback-window/sample-index services, durable annotation WebSocket persistence/immutable submissions, clip/AI processing and coach overlays remain future Phase 2–5 slices. The six workers still run an honest idle lifecycle and do not yet claim pg-boss processing semantics.

## 2026-08-07 — Phase 1A CI and local runtime baseline

Status: integrated and validated on `integration/phase-1-round-1`; [PR #2](https://github.com/henry753951/volleyball-monitoring-ai/pull/2) passed its post-merge gate and was merged to `main`.

- Added stable GitHub Actions jobs `contracts-sdk`, `typescript` and `compose-config`. All three passed on PR #2, and `main` branch protection now requires a PR, strict success from all three checks, resolved review conversations, and disallows force-push/deletion.
- Adopted a frozen `uv` project workflow for the Python SDK, validators and fake AI provider image. `sdk/uv.lock` is committed and the provider has no runtime package installation.
- Repaired and cached the Bun workspace layers in the server, worker and Nuxt Dockerfiles. Nuxt container builds disable only the duplicate Vite checker after a dedicated strict typecheck; normal local/CI typecheck remains enabled.
- Added bounded PostgreSQL, Redis and MinIO readiness probes. The server and web containers expose Docker health checks, Nuxt listens on the Traefik-declared port 3000, and web waits for a healthy server.
- Added a cancellable scaffold worker lifecycle with SIGINT/SIGTERM cleanup so every configured worker remains alive without pretending pg-boss job semantics are implemented.
- Started the full `app` and `dev-ai` Compose profiles locally. PostgreSQL, Redis, MinIO, MediaMTX, Traefik, fake AI, server, web and all six worker containers are running; server/web are healthy and every app/worker restart count was zero after rebuild.
- Runtime probes passed: server readiness returned PostgreSQL/Redis/MinIO `ok`, container-internal Nuxt returned HTTP 200, and Traefik returned HTTPS 200 for `/` and `/graphql`. A headed Playwright smoke loaded the home, settings and live routes after accepting the local self-signed certificate; the browser session was then closed.
- Integrated the Annotation Realtime 2.0 insertion through reviewed [PR #3](https://github.com/henry753951/volleyball-monitoring-ai/pull/3). The feature agent did not self-merge.
- Local CI-equivalent validation passed before the Annotation insertion: Prisma generate/validate, all repository validators, workspace typecheck, 31 JavaScript/Python tests and the production build. The complete post-insertion gate is rerun below before PR #2 is marked ready.

Open limitations: the first Prisma migration and DB integration tests belong to Phase 1B; worker processes are intentionally idle lifecycle scaffolds until their vertical slices implement durable pg-boss claim/lease work. Media ingest/DVR, annotation persistence, AI dispatch and product E2E remain unimplemented and are not represented as complete.

## 2026-08-07 - Annotation Realtime 2.0 close/outcome migration

Status: implemented on `feat/annotation-close-outcome-v2`, reviewed by the main Agent and merged into `integration/phase-1-round-1` through [PR #3](https://github.com/henry753951/volleyball-monitoring-ai/pull/3).

- Replaced the v1.1 standalone terminal and score-setting sequence with breaking Annotation Realtime `2.0.0` `CLOSE_RALLY`. The command carries the server-confirmed last key-point target plus a strict resolved-left, resolved-right or unknown outcome.
- Close now terminalizes the target and saves the rally-level outcome atomically. It creates no playback anchor, timestamp, score frame or score event; stale targets require CAS/revision conflict and snapshot refetch.
- Removed the unreachable `AWAITING_SCORE` annotation state from the current Prisma enum, server state helper, web state and canonical specification. `pending` remains draft-only while open; `SUBMIT_RALLY` remains a distinct post-close command.
- Updated the PWA scaffold to six touch actions and an app-owned TanStack Hotkeys adapter. Exact-pinned `@tanstack/vue-hotkeys` `0.10.0` now owns dynamic scoped registration, recording, input suppression and cleanup; the centralized registry includes configurable `Z`, `Space`, `<`, `>`, `?`, `Enter`, `ArrowLeft` and `ArrowRight` defaults.
- Added versioned preference validation and v2 migration, portable duplicate and browser-reserved gesture rejection, atomic Restore All Defaults, modal-scope precedence, and `formatForDisplay` badges/hints in both the annotation deck and settings.
- Headed Playwright verified the integrated settings UI displays `Z`, `␣`, `<`, `>`, `?`, `↵`, `←`, `→`; remapping service to `S` persisted, assigning the same `S` to contact was rejected without mutation, Restore All Defaults restored all eight keys, and local storage contained the version 3 preference envelope. The annotation deck rendered the same formatted six command badges.
- Regenerated the searchable 41-page specification PDF from the updated TeX source. All pages were rendered; six contact sheets and detailed Annotation pages 5, 19, 20 and 21 were visually reviewed.
- Validation passed: frozen Bun install, contract validator/Vitest/typecheck/build, Prisma generate/validate/typecheck, server tests/typecheck/build, 14 web tests plus Nuxt typecheck/build, SDK tests, full scaffold validation and PDF searchable-text/render checks.
- No migration was added because this semantic enum removal is required before the repository's first migration. Docker/database/browser E2E remain future vertical-slice work.

## 2026-08-07 — Phase 0, round 1

Status: locally integrated and validated on `integration/phase-0-round-1`; GitHub integration review is recorded in [PR #1](https://github.com/henry753951/volleyball-monitoring-ai/pull/1) against `main`.

### Source-of-truth audit

- Read the delivery entrypoints, agent rules, main-agent prompts, master implementation spec, contracts, fixtures, Prisma schema, Nuxt PWA, server, workers and infrastructure scaffold.
- Rendered and visually inspected all 41 pages of `docs/SYSTEM_SPEC_V3_2.pdf`. The PDF and Markdown express the same fixed annotation, media timeline, DVR, immutable-submission, AI boundary and `court_pos` rules.
- `docs/SYSTEM_SPEC_V3_2.md` and `docs/MASTER_IMPLEMENTATION_SPEC.md` are byte-identical.
- Verified all 162 files listed by `SHA256SUMS.txt`: no missing files and no checksum mismatches before repository initialization.
- The scaffold is suitable for contract-first development after the round-1 repairs below. It is not yet a working end-to-end product.

### Git and integration strategy

- Initialized the delivered archive as Git because no `.git` directory, nested repository or upstream remote was present.
- Preserved the imported scaffold on `main` at `f851f84`.
- Used `integration/phase-0-round-1` as the local review/integration branch.
- Used independent worktrees and branches for every subagent:

| Workstream | Branch | Worktree | Reviewed source commits |
| --- | --- | --- | --- |
| Contracts / Python SDK | `feat/phase0-contract-fixtures` | `H:\Repos\volleyball-monitoring-ai-worktrees\contracts` | `b7ba9ee` |
| Prisma / server / worker | `feat/phase0-media-readiness` | `H:\Repos\volleyball-monitoring-ai-worktrees\backend-media` | `a07e1ab`, `2cd54c1`, `cc37b70` |
| Nuxt iPad PWA | `feat/phase0-web-contract-alignment` | `H:\Repos\volleyball-monitoring-ai-worktrees\web` | `27455f5` |

Subagents did not merge. The main agent reviewed their diffs, reran their tests, created the commits where requested, and locally merged the reviewed branches into the integration branch. A private remote was then created with the authenticated local GitHub CLI and all review branches were pushed before opening PR #1.

### Round-1 task contracts

#### Contracts / Python SDK

- Goal: close the required `resolved_multiple` golden-fixture gap without changing a public schema or version.
- Allowed paths: `packages/contracts/fixtures/**`, contracts tests/package metadata, and `sdk/tests/**`.
- Definition of Done: every AI fixture validates through the canonical JSON Schemas; the multiple-actor case preserves order, omits optional action/confidence, carries no candidates and proves external `court_pos` may be outside `0..1`.
- Tests: contracts Vitest suite, Python SDK pytest suite, contract validator and contracts typecheck.

#### Prisma / server / worker

- Goal: make the Phase 0 data/backend scaffold executable by Prisma 7 and add only the internal durability primitives required for claim/lease job processing.
- Allowed paths: `packages/db/prisma/schema.prisma`, `worker/**`, and follow-up compile repairs in `server/**`; no public contract changes or migrations.
- Definition of Done: preserve all 38 models and 24 enum domains, add `maxAttempts`, `availableAt`, `leasedUntil` and a status/availability index to `ClipJob` and `AiJob`, validate all configured worker roles, and compile/test the server without changing health or WebSocket scaffold behavior.
- Tests: Prisma generate/validate, database typecheck, worker build/test/typecheck, server build/test/typecheck and Compose config validation.

#### Nuxt iPad PWA

- Goal: align the handwritten playback-window type and bounded seek math with the canonical server-side DVR contract.
- Allowed paths: `web/**`; one reviewed `vue-tsc` dev dependency was allowed.
- Definition of Done: include timeline bounds, pagination flags and optional live edge; convert only the bounded BigInt delta to player seconds; reject out-of-window seeks; do not buffer the full DVR or claim browser cursor values are authoritative.
- Tests: Nuxt postinstall/typecheck/build and Vitest coverage using capture timestamps larger than JavaScript's safe-integer range.

### Integrated changes

- Repaired the Windows/repository validation gate, pinned an available `prisma-pothos-types` release and committed `bun.lock`.
- Replaced formatter-sensitive Prisma checks with semantic enum and durable-job assertions.
- Reformatted the invalid compact Prisma datasource/enums for Prisma 7 while preserving the existing domain, plus the approved internal job durability fields above.
- Added the required `resolved_multiple` contract fixture and schema-driven TypeScript/Python coverage. No public schema or schema version changed.
- Added bounded DVR playback helpers and complete playback-window descriptor fields in the PWA. Browser cursor data remains observational and full DVR remains server-side.
- Fixed server Pothos scalar/object typing and WebSocket raw-byte accounting without changing route behavior.
- Made test discovery exclude compiled `dist` files and isolated contract compiler output from `src`.

### Validation evidence

All commands below passed on the integrated branch:

- `bun run db:generate`
- `bun run db:validate` — 38 models, 24 enums
- `bun run validate:all` — contracts, scaffold, Prisma structure and syntax checks; 43 TypeScript/Vue files parsed
- `bun run typecheck` — contracts, DB, server, worker and Nuxt
- `bun run test` — contracts 3, server 3, worker 7, web 3 and Python SDK 10 tests passed; DB integration tests remain intentionally deferred until the first migration
- `bun run build` — contracts, DB, server, worker and production Nuxt/PWA build
- `docker compose --env-file .env.example -f infra/compose.yaml config --no-env-resolution --quiet`

The Nuxt build emits a dependency-level Node `DEP0155` deprecation warning but completes successfully.

### Open blockers and limitations

- Private remote: `git@github.com:henry753951/volleyball-monitoring-ai.git`. `main`, the integration branch and all three reviewed feature branches were pushed; PR #1 is the integration-to-main review record.
- The local Bun is `1.3.6`, while the repository pins `1.3.14`. Validation passed, but release/CI should use the pinned version.
- Docker Compose runtime, migrations, database integration tests, real media ingest/DVR packaging, browser/iPad E2E and external AI callback flows were not run.
- The server REST media routes, durable annotation WebSocket, queue workers and end-to-end vertical product flow remain scaffolds. Green in the UI must continue to mean an immutable submission exists, not AI completion.

### Recommended next round

1. Use PR #1 as the integration-to-main review and merge record, and preserve the feature branches for workstream auditability.
2. Implement the first small end-to-end slice around match/capture setup and an authoritative server-resolved playback window, including the first migration and DB integration tests.
3. Keep annotation submission, clip creation and external AI dispatch as subsequent vertical slices, preserving the fixed keyboard/touch semantics and immutable `RallySubmission` boundary.
# 2026-08-08 — Outbound AI SDK / WSS control plane / processing abort

- Added versioned AI Provider Realtime `1.0.0` TypeScript types, strict parsers, JSON Schema and
  hello/job/abort examples. Job `1.1.0`, Analysis Result `1.0.0` and Callback `1.0.0` remain
  compatible; video and full overlay data remain outside WSS.
- Upgraded the uv-managed Python SDK to `0.2.0` with `AIWorkerClient`, typed `WorkerConfig`,
  `JobContext`, cooperative `CancellationToken`, checksum-verified `.part` clip download,
  reconnect/resume, heartbeat/progress and server abort handling. FastAPI remains an optional legacy
  adapter and is not required by the new worker.
- Added an object-oriented `fixture_worker.py` example. It waits for a real server job, downloads the
  canonical MP4, runs an abort-aware placeholder frame loop, adapts bundled golden analysis data and
  sends a real multipart callback. The placeholder loop is explicitly not an AI model.
- Added `AiTransportMode`, persisted provider instances/delivery/lease/cancellation metadata and the
  `/api/v1/ai/providers/ws` gateway. HTTP-push dispatch now only claims `HTTP_PUSH` integrations.
- Added `deleteProcessingRally`: it is available only before completion, creates an immutable
  cancellation submission, records any score reversal as a correction ledger entry, soft-voids the
  rally, cancels jobs and emits durable abort outbox events. The annotation selection toolbar exposes
  the action for gray/yellow processing states with confirmation.
- Clip finalization, callback completion and cancellation now lock/recheck job state so cancellation
  cannot be overwritten by a late worker result. The clip worker monitors DB cancellation and aborts
  ffmpeg promptly.
- Validation completed so far: Provider Realtime contract validation and 13 contracts tests; Prisma
  format/generate/validate; DB/server/worker/web typechecks; 20 Python SDK tests; GraphQL SDL export
  and 13 operation checks; processing-cancellation PostgreSQL integration test.

# 2026-08-09 — OME clip continuity / outbound analysis engine E2E

- Added deterministic least-loaded assignment for outbound WebSocket AI workers, persisted worker,
  delivery, stage and progress data, annotation-room processing updates, and control-console worker/job
  observability. The annotation processing badge uses `motion-v` and reports the assigned worker,
  build, progress and pipeline stage while the job is active.
- Created the private uv-managed reference worker repository
  [`volleyball-analysis-engine`](https://github.com/henry753951/volleyball-analysis-engine). Its Docker
  worker uses the current Python SDK `0.2.0`, Ruff and strict Pyright, reads the Contract Lab handoff,
  projects detections into the canonical court, normalizes tracks into six players per court side,
  associates immutable key points with hitters, and emits analysis JSON plus FlatBuffers overlay
  artifacts. Ball/action/ReID inputs remain fixture-backed as explicitly allowed for this phase.
- Fixed the OME fragment boundary path without weakening canonical timing checks. Adjacent capture
  epochs may reset source PTS when capture time/frame remain exactly contiguous and the time base is
  unchanged. Clip construction now opens every `init + fragment` as an independent concat-demuxer
  entry, filters ffprobe to video frames, and never lets a shorter optional audio stream truncate the
  authoritative video frame map.
- Reduced automatic cursor-resolution retries to one request per playback-window/mapping/seek context.
  Authoritative resolution now crosses contiguous OME epoch resets while browser observations remain
  non-authoritative.
- Explicit Nuxt layout routing now keeps `/annotate/**` in the dark PC editor shell, `/control/**` in
  the desktop control shell, and only coach routes in the light PWA shell.

### Real end-to-end evidence

- Submitted immutable rally `502ddc84-8b31-4621-9579-f8f279184293` from match
  `51278d81-5ec7-4a74-a399-ba4f53ca8758` against the recorded OME YouTube source.
- Canonical clip job `49c9aa9a-c641-41eb-9f1d-aace9f14a9a4` completed on its first final retry with
  exactly 398 selected and probed video frames. Service/contact anchors map from capture frames
  `20066`/`20104` to clip frames `180`/`218`; the ingested AI contact anchors are the same `180`/`218`.
- Two SDK workers were simultaneously online at capacity one. Least-load assignment selected
  `analysis-worker-01`; AI job `f1dd89e7-9b59-44e8-b1c7-b3e1c02b8ebc` completed through the real
  multipart callback in one attempt.
- Analysis run `e8de313c-ddfc-4efe-9561-2110b6b8a035` is active/completed with 398 overlay frames,
  four overlay chunks, 12 tracks split LEFT 6 / RIGHT 6, two key-point contact records, one ball path
  and four persisted artifacts. Identity mapping is intentionally incomplete, so the annotation mask
  is AI-complete blue rather than mapping-complete green.
- Headed Playwright verified the editor shell contains no coach shell, displays `WS 正常` at 3–4 ms,
  shows the rally as `分析完成`, and the control AI view reports both live workers plus the completed
  match job and assigned worker.

### Validation and remaining limitation

- Passed focused server media-cursor tests (10), worker clip-timing tests (5), server/worker/web
  typechecks, Docker builds for server, clip worker and HTTP dispatcher, and the real container E2E
  above. The complete monorepo gate before these focused fixes passed contracts 13, DB 4, media 88,
  server 201, worker 165 (6 skipped), web 142, SDK 20, plus root typecheck/test.
- Playback-window continuation no longer polls from transient MSE buffer ranges. It measures canonical
  headroom from the playback-window capture bounds, treats duplicate extension prefetches as idempotent,
  and applies bounded retry backoff for transient live-edge availability.

# 2026-08-09 — OME epoch-aware HLS continuation

- Fixed the actual long-playback stall at OME recorder PTS resets. Every capture-epoch boundary now
  becomes an HLS discontinuity, and rolling playlists publish the matching
  `EXT-X-DISCONTINUITY-SEQUENCE`; canonical capture time and stored DVR availability semantics remain
  unchanged.
- A headed Chromium run loaded the production blob-backed hls.js player at 200 seconds and played
  continuously through the former 208-second boundary to 224 seconds. `readyState` remained 4, the
  blob URL stayed stable, and the buffered end advanced from 384.984 to 405.001 seconds without a
  source swap, `/extend` request or HTTP 409.
- The real generated manifest contained its rolling discontinuity sequence and 108 capture-epoch
  discontinuity markers. A fresh browser session reported zero console errors and rendered the dark
  annotation shell rather than the coach PWA shell.
- The complete post-fix gate passed: contracts 13, DB 4, media 88, server 201, worker 165 with six
  skipped, web 140 and Python SDK 20 tests, plus the full monorepo typecheck.

# 2026-08-09 — Stale AI worker cleanup

- Added an authenticated operator control to remove AI provider instances only after they are
  disconnected or have missed the 30-second heartbeat threshold and own no queued/running jobs.
- The backend repeats the liveness and active-job checks in the atomic delete condition, so a worker
  that reconnects or receives work while the confirmation dialog is open is rejected with a conflict.
- The control console exposes the destructive action only for inactive workers, disables it while
  work remains, confirms the selected instance and refreshes the fleet immediately after deletion.
  Completed analysis data remains intact; the remote worker may register again on its next connection.
- ADR 0022 records the authorization, atomic liveness/job recheck, versioned receipt and history-retention boundary; GraphQL and AI SDK contracts are unchanged.
- This is an additive internal operations-control route and does not change AI Provider Realtime,
  Job, Result, Callback, GraphQL or database schemas.

# 2026-08-09 — Linked analysis-result timeline selection

- Analysis coverage rails are now real toggle buttons. Selecting one pins and selects its parent rally;
  selecting it again, clicking the parent clip, choosing a key point or clicking timeline whitespace
  clears the analysis sub-selection and restores the existing cursor-driven clip context.
- A compact analysis marker remains visible and clickable at the full-match scale instead of being
  hidden by the micro-density presentation. Expanded views continue to show result size and available
  tracking capabilities.
- The selection reducer covers empty-cursor, different-rally, same-rally and toggle-off cases. All 145
  web tests and Nuxt typecheck passed; headed Chromium verified pressed state, linked parent selection,
  toggle-off, parent-only selection and whitespace dismissal with zero console errors.

# 2026-08-09 — Unified ingest and continuous DVR playback lifecycle

- Active live, ended live, progressively indexed YouTube VOD and complete local MP4 now share one
  canonical availability model while preserving distinct product states. Only active live exposes
  `LIVE`; a drained terminal source exposes `END`, and its final manifest emits `EXT-X-ENDLIST`.
- The browser keeps one long-lived hls.js/MSE blob attachment. Server-ready ranges, the authorized
  playback window, actual `HTMLMediaElement.buffered` ranges, indexing work and not-yet-downloaded
  source media are rendered as separate timeline layers; the ruler remains inert and only the thin
  availability rail performs click-to-seek.
- YouTube relay inputs now reuse yt-dlp's selected signed URLs and HTTP request headers, segment to
  independently playable fragmented MP4 with explicit PTS resets, re-probe active live sources after
  reconnects, and withhold an unsealed tail when an operator stops capture.
- Playback manifests use capture-epoch sequence as the absolute HLS transport discontinuity, cursor
  and frame snapping load only the target fragment plus touching neighbours, and an exact terminal
  observation snaps to the final indexed sample without changing half-open canonical ranges.
- Rolling extension is idempotent when no new READY media exists and renews the playback-window lease
  while the workstation is idle or paused. Browser buffer starvation inside an already-authorized
  window triggers hls.js recovery instead of a redundant server extension.
- The existing-match media dialog now exposes only a YouTube video/live URL or a local MP4 upload.
  A clean Chromium reload created exactly one playback window, showed `END`, rendered the four media
  availability layers, and reported zero console errors or warnings.
- Real runtime validation played one blob through the progressive 300-second window boundary while
  duration expanded from about 300 to 588 seconds, resolved the complete DEMO archive at its exact
  terminal frame, renewed an idle descriptor beyond its original TTL, and verified a FINISHED 291
  segment capture emits `EXT-X-ENDLIST`.
- Reconnect smoke used two generated 60 fps MP4 segments separated by a persisted restart marker. It
  produced epoch/discontinuity sequence `0 -> 1`, continuous capture time `0 -> 2,000,000 us` and
  continuous canonical frames `0 -> 119`; the temporary fixture was removed after verification.
- Permanent media-index failures now quarantine only a validated ingest envelope plus bounded failure
  metadata, never malformed source paths or tokens. The source pg-boss job completes and the manual
  dead-letter audit is correlated by `sourceJobId` without reusing the source job ID.
- The post-merge monorepo gate passed: contracts 13, DB 4, media 88, server 214, worker 175, web 154
  and Python SDK 20 tests; root typecheck, production build, 486-file checksum/scaffold validation,
  44-model/27-enum Prisma structure validation and 258-file TypeScript/Vue syntax validation also
  passed. The only build output is dependency-level deprecation/plugin-timing warnings.
# 2026-08-09 — Unified clip selection and frame analysis review

- Removed the video-stage status tint. Draft, submitted, processing, AI-complete and mapped states
  remain visible only on the canonical timeline clip mask.
- A completed analysis now renders its result rail even when the AI callback omitted optional coverage;
  the immutable clip range is the fallback, fixing the first DEMO clip.
- Analysis rails no longer maintain a second selection state. Clicking a rail selects its parent clip
  and opens the new Analysis Result inspector; normal clip selection and cursor behavior remain intact.
- The inspector supports optimistic per-frame ball-coordinate and action corrections. Corrections are
  batched by entity, persisted with idempotent patch IDs and synchronized as revision invalidations plus
  incremental deltas instead of full-overlay broadcasts.
- BBox interaction is contextual: Analysis Result edits the frame action, while Player Assignment opens
  a quick identity popover. The assignment list shows every track and reserves only players mapped to
  tracks active on the current frame, so an inactive pre-ReID track does not block reassignment.
- ADR 0023 records the immutable-result overlay, sparse correction and synchronization boundary.

# 2026-08-09 — External analysis SDK offline mode and real inference engine

- Python SDK `0.3.0` adds `OfflineRunner`: it accepts the same validated `AIJobRequest` used by an
  online worker, optionally replaces only the human key-point list, verifies the local canonical
  clip hash and byte length, and atomically writes `analysis-result.json`, `overlay.vov1` and a
  `network_used: false` run manifest without creating HTTP, WebSocket, download or callback clients.
- The sibling `volleyball-analysis-engine` remains an independent `uv` repository and uses the SDK
  through the sibling path. Online and offline modes now share one real-inference pipeline; no
  Contract Lab tracking, ball, court or action JSON is consumed as model output.
- The engine integrates the supplied 5-frame RT-DETRv4/X3D checkpoint with strict state-dict loading,
  OSNet appearance embeddings, harmonic-mean EIoU tracking, the order-fixed YOLO court-pose model,
  RANSAC projection, same-side 2D-court re-entry identity consolidation, hit association and typed
  AnalysisResult/VOV1 generation. Video-space bbox/ball values are bounded while AI-owned
  `court_pos` remains intentionally unclamped.
- Local PowerShell and shell launchers cover first-time `uv` setup, strict model diagnostics, an
  outbound central worker and fully offline clip analysis. Docker Compose remains optional for the
  online worker and its missing `.env` file is non-fatal.
- The supplied 1920x1080 60 fps clip ran through the GPU pipeline end to end: 1,033 decoded and
  canonical frames, 30 raw source track IDs consolidated to 12 court-side identities, 12/12 human
  key-point anchors preserved with exact PTS/time/frame values, and valid JSON, VOV1 plus a 1,033-frame
  H.264/AAC overlay. The run produced 1,033 track rows, 504 ball rows, 35 court rows and 11,994
  per-track action rows; its offline manifest records no network use.
