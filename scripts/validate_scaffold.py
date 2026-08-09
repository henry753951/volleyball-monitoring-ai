
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
    'scripts/storage_bootstrap.ts',
    'scripts/storage_bootstrap.test.ts',
    'scripts/dev_host.ts',
    'scripts/dev_host.test.ts',
    'scripts/dev_infra.ts',
    'sdk/pyproject.toml',
    'web/app/pages/annotate/[matchId].vue',
    'web/tsconfig.json',
    'server/src/index.ts',
    'infra/compose.yaml',
    'infra/compose.host-dev.yaml',
    'worker/src/runtime-health.ts',
]

for relative in REQUIRED:
    path = ROOT / relative
    assert path.exists(), f'missing required scaffold file: {relative}'

for path in repository_files('*.json'):
    json.loads(path.read_text(encoding='utf-8'))

for path in repository_files('*.toml'):
    tomllib.loads(path.read_text(encoding='utf-8'))

root_package = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))
for script in ('dev', 'storage:bootstrap', 'dev:infra', 'dev:https', 'dev:worker-media', 'dev:worker-workflow'):
    assert script in root_package['scripts'], f'missing root runtime script: {script}'
workspace_manifests: set[Path] = set()
for workspace_pattern in root_package['workspaces']:
    for workspace_path in ROOT.glob(workspace_pattern):
        manifest = workspace_path / 'package.json'
        if manifest.is_file():
            workspace_manifests.add(manifest)
assert workspace_manifests, 'no Bun workspace manifests found'
for dockerfile in (ROOT / 'infra/docker').glob('*.Dockerfile'):
    dockerfile_text = dockerfile.read_text(encoding='utf-8')
    if 'bun install --frozen-lockfile' not in dockerfile_text:
        continue
    for manifest in sorted(workspace_manifests):
        relative = manifest.relative_to(ROOT).as_posix()
        expected_copy = f'COPY {relative} {relative}'
        assert expected_copy in dockerfile_text, (
            f'{dockerfile.relative_to(ROOT)} must copy {relative} before frozen install'
        )

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
assert 'Annotation Realtime Schema v2.1' in spec
assert '正式registry版本為`2.1.0`' in spec and 'Canonical Rally command／ACK仍使用`2.0.0`' in spec
assert '`soft_lock_intent`' in spec and 'revision/CAS' in spec
assert '`? 未知`' in spec and '可以提交 AI' in spec
assert 'GraphQL Yoga' in spec and 'Pothos' in spec and 'Prisma' in spec
assert 'full-session' in spec.lower() or '完整 DVR' in spec
assert (ROOT / 'docs/SYSTEM_SPEC_V3_2.md').read_bytes() == (ROOT / 'docs/MASTER_IMPLEMENTATION_SPEC.md').read_bytes()

annotation_page = (ROOT / 'web/app/pages/annotate/[matchId].vue').read_text(encoding='utf-8')
annotation_room = (ROOT / 'web/app/composables/useAnnotationRoom.ts').read_text(encoding='utf-8')
hotkey_registry = (ROOT / 'web/app/utils/annotationHotkeys.ts').read_text(encoding='utf-8')
for action in ['service', 'contact', 'close_left', 'close_right', 'close_unknown', 'submit']:
    assert action in hotkey_registry, f'annotation registry missing: {action}'

worker_index = (ROOT / 'worker/src/index.ts').read_text(encoding='utf-8')
for role in ['media', 'workflow']:
    assert role in worker_index, f'worker entrypoint missing runtime role: {role}'
workflow_composition = (ROOT / 'worker/src/workflow-composition.ts').read_text(encoding='utf-8')
for factory in ['createClipWorker', 'createPlaybackPackagerWorker', 'createAnalysisIngestWorker', 'createOutboxPublisherWorker']:
    assert factory in workflow_composition, f'workflow composition missing module: {factory}'
for role_file in ['playback-packager.ts', 'analysis-ingest.ts', 'outbox-publisher.ts']:
    source = (ROOT / 'worker/src/roles' / role_file).read_text(encoding='utf-8')
    assert 'TODO' not in source and 'createPollingLifecycle' in source, f'worker role remains a scaffold: {role_file}'
for binding in ["service: 'Z'", "contact: 'X'", "play_pause: 'Space'", "close_left: '<'", "close_right: '>'", "close_unknown: '?'", "submit: 'Enter'"]:
    assert binding in hotkey_registry, f'annotation default missing: {binding}'
for forbidden_terminal_flow in ["kind: 'terminal'", "type: 'terminal'", "kind === 'terminal'"]:
    assert forbidden_terminal_flow not in annotation_page, 'standalone terminal key-point flow returned'
assert 'CLOSE_RALLY' in annotation_room

compose_source = (ROOT / 'infra/compose.yaml').read_text(encoding='utf-8')
compose_services = compose_source.split('\nservices:\n', 1)[1].split('\nvolumes:\n', 1)[0]
service_names = set(re.findall(r'^  ([a-z0-9-]+):(?:\s.*)?$', compose_services, flags=re.MULTILINE))
expected_services = {
    'traefik',
    'postgres',
    'redis',
    'minio',
    'ovenmediaengine',
    'server',
    'web',
    'worker-media',
    'worker-workflow',
}
assert service_names == expected_services, f'Compose service allowlist mismatch: {sorted(service_names)}'
environment_example = (ROOT / '.env.example').read_text(encoding='utf-8')
for variable in (
    'OBJECT_STORAGE_BOOTSTRAP_MODE',
    'REDIS_HOST_PORT',
    'MEDIA_SPOOL_HOST_PATH',
    'MEDIA_IMPORT_HOST_PATH',
    'WORKER_MEDIA_HEALTH_PORT',
    'WORKER_WORKFLOW_HEALTH_PORT',
):
    assert variable in environment_example, f'missing host runtime environment variable: {variable}'
for required_runtime_literal in ('WORKER_HEALTH_PORT', 'health/ready', 'MEDIA_SPOOL_HOST_PATH'):
    assert required_runtime_literal in compose_source, f'Compose missing runtime health/bind contract: {required_runtime_literal}'
host_override = (ROOT / 'infra/compose.host-dev.yaml').read_text(encoding='utf-8')
for route in ('Path(`/graphql`)', 'PathPrefix(`/api/`)', 'PathPrefix(`/ws/`)'):
    assert route in host_override, f'host-dev Traefik override missing unchanged route: {route}'

active_annotation_sources = [
    ROOT / 'AGENTS.md',
    ROOT / 'CODEX_SOL_PROMPT.txt',
    ROOT / 'README.md',
    ROOT / 'docs/MAIN_AGENT_PROMPT.md',
    ROOT / 'packages/contracts/README.md',
    ROOT / 'server/src/realtime/README.md',
    ROOT / 'web/app/pages/annotate/[matchId].vue',
    ROOT / 'web/app/composables/useAnnotationRoom.ts',
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
