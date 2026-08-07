
from __future__ import annotations

import argparse
import hashlib
import json
import re
import tomllib
from pathlib import Path

from checksum_utils import canonical_checksum_bytes, canonicalize_checksum_bytes

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


parser = argparse.ArgumentParser(description='Validate repository scaffold invariants.')
parser.add_argument(
    '--skip-checksums',
    action='store_true',
    help='validate SHA256SUMS structure but skip target existence and digest verification',
)
args = parser.parse_args()

REQUIRED = [
    'bun.lock',
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
    'scripts/checksum_utils.py',
    'scripts/refresh_checksums.py',
    'sdk/pyproject.toml',
    'web/app/pages/annotate/[matchId].vue',
    'web/tsconfig.json',
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

assert canonicalize_checksum_bytes(Path('text.md'), b'a\r\nb') == b'a\nb'
assert canonicalize_checksum_bytes(Path('image.png'), b'a\r\nb') == b'a\r\nb'

checksum_manifest = ROOT / 'SHA256SUMS.txt'
checksum_entries: list[tuple[str, str]] = []
for line_number, line in enumerate(checksum_manifest.read_text(encoding='utf-8').splitlines(), start=1):
    match = re.fullmatch(r'([0-9a-f]{64})  \./(.+)', line)
    assert match, f'invalid SHA256SUMS.txt line {line_number}: {line!r}'
    expected_digest, relative = match.groups()
    checksum_entries.append((relative, expected_digest))

checksum_paths = [relative for relative, _ in checksum_entries]
assert checksum_paths == sorted(checksum_paths), 'SHA256SUMS.txt paths must be sorted'
assert len(checksum_paths) == len(set(checksum_paths)), 'SHA256SUMS.txt contains duplicate paths'
if not args.skip_checksums:
    for relative, expected_digest in checksum_entries:
        path = ROOT.joinpath(*relative.split('/'))
        assert path.is_file(), f'checksum target is missing: {relative}'
        actual_digest = hashlib.sha256(canonical_checksum_bytes(path)).hexdigest()
        assert actual_digest == expected_digest, f'checksum mismatch: {relative}'

spec = (ROOT / 'docs/MASTER_IMPLEMENTATION_SPEC.md').read_text(encoding='utf-8')
assert '`CLOSE_RALLY`' in spec and 'target_key_point_id' in spec
assert 'Annotation Realtime Schema v2.0' in spec
assert '`? 未知`' in spec and '可以提交 AI' in spec
assert 'GraphQL Yoga' in spec and 'Pothos' in spec and 'Prisma' in spec
assert 'full-session' in spec.lower() or '完整 DVR' in spec
assert (ROOT / 'docs/SYSTEM_SPEC_V3_2.md').read_bytes() == (ROOT / 'docs/MASTER_IMPLEMENTATION_SPEC.md').read_bytes()

annotation_page = (ROOT / 'web/app/pages/annotate/[matchId].vue').read_text(encoding='utf-8')
hotkey_registry = (ROOT / 'web/app/utils/annotationHotkeys.ts').read_text(encoding='utf-8')
for action in ['service', 'contact', 'close_left', 'close_right', 'close_unknown', 'submit']:
    assert action in hotkey_registry, f'annotation registry missing: {action}'
for binding in ["service: 'Z'", "contact: 'Space'", "close_left: '<'", "close_right: '>'", "close_unknown: '?'", "submit: 'Enter'"]:
    assert binding in hotkey_registry, f'annotation default missing: {binding}'
assert "'terminal'" not in annotation_page
assert 'CLOSE_RALLY' in annotation_page

active_annotation_sources = [
    ROOT / 'AGENTS.md',
    ROOT / 'CODEX_SOL_PROMPT.txt',
    ROOT / 'README.md',
    ROOT / 'docs/MAIN_AGENT_PROMPT.md',
    ROOT / 'packages/contracts/README.md',
    ROOT / 'server/src/realtime/README.md',
    ROOT / 'web/app/pages/annotate/[matchId].vue',
    ROOT / 'web/app/utils/annotationHotkeys.ts',
]
for path in active_annotation_sources:
    text = path.read_text(encoding='utf-8')
    for forbidden in ('MARK_TERMINAL', 'SET_SCORE', 'AWAITING_SCORE', 'X 結束'):
        assert forbidden not in text, f'active old annotation flow in {path.relative_to(ROOT)}: {forbidden}'

sdk_overlay = (ROOT / 'sdk/src/volleyball_monitoring_ai/schemas/overlay.fbs').read_bytes()
canonical_overlay = (ROOT / 'packages/contracts/flatbuffers/overlay.fbs').read_bytes()
assert sdk_overlay == canonical_overlay, 'SDK overlay schema is stale'

if args.skip_checksums:
    print(
        'scaffold validation passed; '
        f'SHA256SUMS structure valid ({len(checksum_entries)} entries), '
        'target and digest verification skipped by --skip-checksums'
    )
else:
    print(f'scaffold validation passed; SHA256SUMS verified ({len(checksum_entries)} files)')
