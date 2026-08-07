import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { parseAnnotationCommand, parseAnnotationCommandResponse, parseAnnotationServerMessage, parseMediaApiError, parsePlaybackCursor, parseResolvedMediaAnchor } from "../src/index";

const root = resolve(import.meta.dirname, "..");
const load = (relative: string) => JSON.parse(readFileSync(resolve(root, relative), "utf8"));

function validator(schemaPath: string) {
  // Existing schemas use conditional keywords on properties whose type is declared
  // in the base branch; retain AJV validation while allowing that draft-2020 form.
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(load(schemaPath));
}

describe("golden contract fixtures", () => {
  it("guards all media error codes and rejects numeric wire values", () => {
    const codes = ["BAD_REQUEST", "UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND", "MAPPING_STALE", "MEDIA_NOT_READY", "WINDOW_BOUNDARY", "WINDOW_EXPIRED", "CURSOR_NOT_READY", "CAPTURE_GAP", "SAMPLE_NOT_FOUND"] as const;
    for (const code of codes) expect(parseMediaApiError({ schema_version: "1.0.0", code, message: "x", request_id: "r" }).code).toBe(code);
    expect(() => parsePlaybackCursor({ schema_version: "1.0.0", playback_window_id: "w", mapping_version: 1, player_media_time_us: 9007199254740993, observation_source: "current_time_fallback", seek_generation: 0, cursor_status: "ready" })).toThrow();
    const anchor = load("examples/media/resolved-media-anchor.json");
    delete anchor.snap_distance_us;
    expect(parseResolvedMediaAnchor(anchor).snap_distance_us).toBeUndefined();
    expect(() => parseResolvedMediaAnchor({ ...anchor, mapping_version: 1.5 })).toThrow();
    expect(() => parseResolvedMediaAnchor({ ...anchor, source_time_base: { num: 0, den: 1 } })).toThrow();
    expect(() => parseResolvedMediaAnchor({ ...anchor, source_time_base: { num: 1, den: 60, extra: true } })).toThrow();
  });
  it("validates every AI fixture against the current schemas", () => {
    const validateJob = validator("ai/job.schema.json");
    const validateResult = validator("ai/result.schema.json");
    for (const name of readdirSync(resolve(root, "fixtures"))) {
      expect(validateJob(load(`fixtures/${name}/job.json`)), name).toBe(true);
      expect(validateResult(load(`fixtures/${name}/result.json`)), name).toBe(true);
    }
  });

  it("preserves resolved-multiple semantics and passthrough order", () => {
    const job = load("fixtures/resolved-multiple/job.json");
    const result = load("fixtures/resolved-multiple/result.json");
    expect(result.contact_events.map((event: any) => event.key_point_id)).toEqual(job.key_points.map((point: any) => point.key_point_id));
    const event = result.contact_events.find((item: any) => item.association_state === "resolved_multiple");
    expect(event.actors.length).toBeGreaterThanOrEqual(2);
    expect(event.actor_candidates).toEqual([]);
    expect(event.actors.every((actor: any) => actor.action === undefined && actor.association_confidence === undefined)).toBe(true);
    expect(event.actors.some((actor: any) => actor.court_pos.x < 0 || actor.court_pos.x > 1)).toBe(true);
  });

  it("validates existing media, annotation, and AI examples including formats", () => {
    const pairs: Record<string, string> = {
      "examples/media/playback-window-request.json": "media/playback-window-request.schema.json",
      "examples/media/playback-window-descriptor.json": "media/playback-window-descriptor.schema.json",
      "examples/media/playback-cursor.json": "media/playback-cursor.schema.json",
      "examples/media/resolved-media-anchor.json": "media/resolved-media-anchor.schema.json",
      "examples/media/playback-window-descriptor-live.json": "media/playback-window-descriptor.schema.json",
      "examples/media/playback-cursor-fallback.json": "media/playback-cursor.schema.json",
      "examples/media/resolved-media-anchor-negative-pts.json": "media/resolved-media-anchor.schema.json",
      "examples/media/frame-step-request.json": "media/frame-step-request.schema.json",
      "examples/media/canonical-frame-anchor.json": "media/canonical-frame-anchor.schema.json",
      "examples/media/error-classes.json": "media/media-api-error.schema.json",
      "examples/annotation/close-rally-left.json": "annotation/realtime.schema.json",
      "examples/annotation/close-rally-right.json": "annotation/realtime.schema.json",
      "examples/annotation/close-rally-unknown.json": "annotation/realtime.schema.json",
      "examples/annotation/close-rally-ack.json": "annotation/realtime.schema.json",
      "examples/annotation/close-rally-target-conflict.json": "annotation/realtime.schema.json",
      "examples/annotation/submit.json": "annotation/realtime.schema.json",
      "examples/ai/capabilities.json": "ai/capabilities.schema.json",
      "examples/ai/job-accepted.json": "ai/job-accepted.schema.json",
    };
    for (const [instance, schema] of Object.entries(pairs)) expect(validator(schema)(load(instance)), instance).toBe(true);
  });

  it("accepts only the atomic v2 CLOSE_RALLY outcomes", () => {
    const validate = validator("annotation/realtime.schema.json");
    for (const side of ["left", "right"]) {
      const close = load(`examples/annotation/close-rally-${side}.json`);
      expect(validate(close), side).toBe(true);
    }
    expect(validate(load("examples/annotation/close-rally-unknown.json")), "unknown").toBe(true);

    const oldTerminal = {
      schema_version: "1.1.0",
      command_id: "old-terminal",
      room_id: "room-001",
      base_revision: "12",
      rally_id: "rally-001",
      kind: "MARK_TERMINAL",
      payload: { target_key_point_id: "kp-004" },
    };
    expect(validate(oldTerminal), "v1.1 MARK_TERMINAL").toBe(false);
    expect(validate({ ...oldTerminal, schema_version: "2.0.0", kind: "SET_SCORE", payload: {
      score_resolution: "resolved",
      scoring_court_side: "left",
    } }), "standalone score command").toBe(false);
  });

  it("forbids close timestamps and requires ACK effects to carry the outcome", () => {
    const validate = validator("annotation/realtime.schema.json");
    const close = load("examples/annotation/close-rally-left.json");
    close.payload.capture_time_us = "9000000";
    expect(validate(close), "CLOSE_RALLY capture_time_us").toBe(false);
    delete close.payload.capture_time_us;
    close.payload.score_frame_index = "540";
    expect(validate(close), "CLOSE_RALLY score frame").toBe(false);

    const ack = load("examples/annotation/close-rally-ack.json");
    expect(validate(ack), "complete CLOSE_RALLY ACK").toBe(true);
    delete ack.effects.terminal_key_point_id;
    expect(validate(ack), "ACK without terminalization effect").toBe(false);
    ack.effects.terminal_key_point_id = "kp-004";
    ack.resolved_anchor = {
      playback_window_id: "window-1",
      capture_session_id: "capture-1",
      capture_epoch_id: "epoch-1",
      source_pts: "1",
      source_time_base: { num: 1, den: 60 },
      capture_time_us: "1",
      capture_frame_index: "1",
      resolved_player_media_time_us: "1",
      mapping_version: 1,
      timing_precision: "frame_exact",
    };
    expect(validate(ack), "CLOSE_RALLY ACK with a new anchor").toBe(false);
  });

  it("strictly parses v2 service commands and requires service ACK identity plus anchor", () => {
    const service = load("examples/annotation/create-service.json");
    const ack = load("examples/annotation/create-service-ack.json");
    expect(parseAnnotationCommand(service).kind).toBe("CREATE_SERVICE_KEY_POINT");
    expect(parseAnnotationCommandResponse(ack).type).toBe("command_ack");
    expect(() => parseAnnotationCommand({ ...service, unexpected: true })).toThrow();
    expect(() => parseAnnotationCommand({ ...service, base_revision: 0 })).toThrow();
    expect(() => parseAnnotationCommandResponse({ ...ack, resolved_anchor: null })).toThrow();
    const missingCreated = structuredClone(ack);
    delete missingCreated.effects.created_key_point_id;
    expect(() => parseAnnotationCommandResponse(missingCreated)).toThrow();
    expect(() => parseAnnotationCommand(load("examples/annotation/create-service-non-uuid.invalid.json"))).toThrow();
    expect(() => parseAnnotationCommand(load("examples/annotation/create-service-noncanonical-room.invalid.json"))).toThrow();
  });

  it("parses every v2 server-message discriminator without a record fallback", () => {
    const uuid = (suffix: number) => `84000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
    const common = { schema_version: "2.0.0", room_id: `match:${uuid(1)}:capture:${uuid(2)}` };
    const messages = [
      {
        ...common, type: "connection_ready", server_sequence: "0",
        authenticated_user_id: uuid(3), device_session_id: uuid(4),
      },
      {
        ...common, type: "rally_snapshot", rally_id: uuid(5), revision: "1", server_sequence: "1",
        snapshot: {
          annotation_status: "open", score_resolution: "pending", scoring_court_side: null,
          processing_status: "idle", key_points: [],
        },
      },
      {
        ...common, type: "presence_snapshot",
        members: [{ user_id: uuid(3), device_session_id: uuid(4), display_name: "Operator" }],
      },
      {
        ...common, type: "rally_processing_update", rally_id: uuid(5), submission_id: uuid(6),
        processing_status: "ai_processing", analysis_id: null, overlay_version: null, error: null,
      },
    ];
    for (const message of messages) expect(parseAnnotationServerMessage(message).type).toBe(message.type);
  });
});
