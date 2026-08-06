
from __future__ import annotations

import json
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
IGNORED_DIRECTORIES = {
    '.git',
    '.nuxt',
    '.output',
    '.pytest_cache',
    '.venv',
    '__pycache__',
    'dist',
    'generated',
    'node_modules',
}


def repository_files(pattern: str):
    for path in ROOT.rglob(pattern):
        relative_parts = path.relative_to(ROOT).parts
        if any(part in IGNORED_DIRECTORIES for part in relative_parts):
            continue
        yield path

REQUIRED = [
    'docs/MASTER_IMPLEMENTATION_SPEC.md',
    'docs/MAIN_AGENT_PROMPT.md',
    'packages/contracts/ai/job.schema.json',
    'packages/contracts/ai/result.schema.json',
    'packages/contracts/media/playback-window-request.schema.json',
    'packages/contracts/media/playback-window-descriptor.schema.json',
    'packages/contracts/media/playback-cursor.schema.json',
    'packages/contracts/media/resolved-media-anchor.schema.json',
    'packages/contracts/annotation/realtime.schema.json',
    'packages/db/prisma/schema.prisma',
    'sdk/pyproject.toml',
    'web/app/pages/annotate/[matchId].vue',
    'server/src/index.ts',
    'infra/compose.yaml',
]

for relative in REQUIRED:
    path = ROOT / relative
    assert path.exists(), f'missing required scaffold file: {relative}'

for path in repository_files('*.json'):
    json.loads(path.read_text(encoding='utf-8'))

for path in repository_files('*.toml'):
    tomllib.loads(path.read_text(encoding='utf-8'))

spec = (ROOT / 'docs/MASTER_IMPLEMENTATION_SPEC.md').read_text(encoding='utf-8')
assert '`X 結束`' in spec and 'target_key_point_id' in spec
assert '`? 未知`' in spec and '可以提交 AI' in spec
assert 'GraphQL Yoga' in spec and 'Pothos' in spec and 'Prisma' in spec
assert 'full-session' in spec.lower() or '完整 DVR' in spec

annotation_page = (ROOT / 'web/app/pages/annotate/[matchId].vue').read_text(encoding='utf-8')
for label in ['Z 發球', 'Space 擊球', 'X 結束', '< 左側得分', '> 右側得分', '? 未知', 'Enter 提交']:
    assert label in annotation_page, f'annotation UI missing: {label}'

sdk_overlay = (ROOT / 'sdk/src/volleyball_monitoring_ai/schemas/overlay.fbs').read_bytes()
canonical_overlay = (ROOT / 'packages/contracts/flatbuffers/overlay.fbs').read_bytes()
assert sdk_overlay == canonical_overlay, 'SDK overlay schema is stale'

print('scaffold validation passed')
