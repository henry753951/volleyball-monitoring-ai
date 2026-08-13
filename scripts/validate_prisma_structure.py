#!/usr/bin/env python3
"""Structural Prisma schema checks used before the real `prisma validate` step.

This catches truncated blocks, duplicate model/enum names and fields, unknown relation targets,
and a few project-specific invariants. It is intentionally not a replacement for the Prisma CLI.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = ROOT / "packages" / "db" / "prisma" / "schema.prisma"
TEXT = SCHEMA.read_text(encoding="utf-8")


def normalized(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def blocks(kind: str) -> dict[str, str]:
    # Prisma permits compact one-line enum/model blocks; match the nearest closing brace.
    pattern = re.compile(rf"(?ms)^\s*{kind}\s+(\w+)\s*\{{(.*?)\}}")
    found: dict[str, str] = {}
    for name, body in pattern.findall(TEXT):
        if name in found:
            raise AssertionError(f"duplicate {kind}: {name}")
        found[name] = body
    return found


models = blocks("model")
enums = blocks("enum")
if not models or not enums:
    raise AssertionError("no Prisma models/enums parsed; schema may be truncated")
if TEXT.count("{") != TEXT.count("}"):
    raise AssertionError("unbalanced braces")

field_types: dict[str, set[str]] = {}
for model_name, body in models.items():
    seen: set[str] = set()
    types: set[str] = set()
    for raw in body.splitlines():
        line = raw.strip()
        if not line or line.startswith("//") or line.startswith("@@"):
            continue
        match = re.match(r"^(\w+)\s+([\w\[\]?]+)", line)
        if not match:
            continue
        field, type_name = match.groups()
        if field in seen:
            raise AssertionError(f"duplicate field {model_name}.{field}")
        seen.add(field)
        types.add(type_name.removesuffix("?").removesuffix("[]"))
    field_types[model_name] = types

scalar_types = {
    "String", "Boolean", "Int", "BigInt", "Float", "Decimal", "DateTime", "Json", "Bytes",
}
known = set(models) | set(enums) | scalar_types
for model_name, types in field_types.items():
    unknown = sorted(type_name for type_name in types if type_name not in known)
    if unknown:
        raise AssertionError(f"unknown field types in {model_name}: {unknown}")

required_models = {
    "CaptureEpoch", "DvrProgram", "DvrSegment", "Rally", "KeyPoint", "RallySubmission",
    "RallySubmissionKeyPoint", "ClipJob", "AiJob", "AiCallbackReceipt", "AnalysisRun",
    "ContactEvent", "BallPathSegment", "OutboxEvent", "AiWorkerAccessToken",
    "AiProviderInstance",
}
missing = sorted(required_models - set(models))
if missing:
    raise AssertionError(f"missing required models: {missing}")

required_tokens = [
    'scoreResolutionState SubmissionScoreResolution',
    'jobSchemaVersion String @default("3.0.0")',
    'sourcePts BigInt',
    'captureTimeUs BigInt',
    'captureFrameIndex BigInt',
    'requestPayloadHash String',
    'callbackId String @unique @db.Uuid',
    'serviceKeyPointId String? @unique @db.Uuid',
    'terminalKeyPointId String? @unique @db.Uuid',
    'boundaries RallyBoundary[]',
    'boundaries RallySubmissionBoundary[]',
    'producerName String',
    'producerBuildId String',
    'producerSdkVersion String?',
    'meanConfidence Float?',
    'resolvedFrameIndex BigInt?',
    'observationFrameIndex BigInt',
]
for token in required_tokens:
    if normalized(token) not in normalized(TEXT):
        raise AssertionError(f"missing required Prisma invariant: {token}")

submission_score_values = set(re.findall(r"\b[A-Z][A-Z0-9_]*\b", enums.get("SubmissionScoreResolution", "")))
if submission_score_values != {"PENDING", "RESOLVED", "UNKNOWN"}:
    raise AssertionError(
        "SubmissionScoreResolution must preserve PENDING, RESOLVED and UNKNOWN"
    )

for durable_job_model in ("ClipJob", "AiJob"):
    body = normalized(models[durable_job_model])
    for token in (
        "maxAttempts Int @default(5)",
        "availableAt DateTime @default(now())",
        "leasedUntil DateTime?",
        "@@index([status, availableAt])",
    ):
        if normalized(token) not in body:
            raise AssertionError(f"missing durable job invariant in {durable_job_model}: {token}")

if '@@index([analysisId])' in TEXT:
    raise AssertionError('analysisId is already @unique; redundant @@index must be removed')

print(f"Prisma structural validation passed ({len(models)} models, {len(enums)} enums)")
print("NOTE: run `bun run db:validate` with installed Prisma before migration or deployment.")
