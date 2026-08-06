import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

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
      "examples/annotation/mark-terminal.json": "annotation/realtime.schema.json",
      "examples/annotation/score-unknown.json": "annotation/realtime.schema.json",
      "examples/annotation/submit.json": "annotation/realtime.schema.json",
      "examples/ai/capabilities.json": "ai/capabilities.schema.json",
      "examples/ai/job-accepted.json": "ai/job-accepted.schema.json",
    };
    for (const [instance, schema] of Object.entries(pairs)) expect(validator(schema)(load(instance)), instance).toBe(true);
  });
});
