
from __future__ import annotations

import json
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker

ROOT = Path(__file__).resolve().parents[1]
CONTRACTS = ROOT / 'packages' / 'contracts'
FIXTURES = CONTRACTS / 'fixtures'


def load(path: Path):
    return json.loads(path.read_text(encoding='utf-8'))


def validate(schema_path: Path, instance_path: Path) -> None:
    schema = load(schema_path)
    Draft202012Validator.check_schema(schema)
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    errors = sorted(validator.iter_errors(load(instance_path)), key=lambda item: list(item.path))
    if errors:
        rendered = '\n'.join(f'{instance_path}: {list(e.path)}: {e.message}' for e in errors)
        raise AssertionError(rendered)


def assert_ai_invariants(job: dict, result: dict) -> None:
    passthrough = {
        'ai_job_id': job['ai_job_id'],
        'rally_submission_id': job['rally_submission_id'],
        'rally_id': job['rally_id'],
        'match_id': job['match_id'],
        'annotation_revision': job['annotation_revision'],
        'clip_asset_id': job['clip']['clip_asset_id'],
    }
    for field, expected in passthrough.items():
        assert result[field] == expected, f'PASSTHROUGH mismatch: {field}'
    assert result['input_clip_sha256'].lower() == job['clip']['sha256'].lower()

    points = job['key_points']
    events = result['contact_events']
    assert len(points) == len(events)
    assert len(result['path_segments']) == max(len(events) - 1, 0)
    for point, event in zip(points, events, strict=True):
        assert event['key_point_id'] == point['key_point_id']
        assert event['sequence_index'] == point['sequence_index']
        assert event['marker_kind'] == point['marker_kind']
        assert event['is_terminal'] == point['is_terminal']
        assert event['anchor_frame_index'] == point['clip_frame_index']

        state = event['association_state']
        actors = event['actors']
        candidates = event['actor_candidates']
        expected_shape = {
            'resolved_single': len(actors) == 1 and not candidates,
            'resolved_multiple': len(actors) >= 2 and not candidates,
            'ambiguous': not actors and len(candidates) >= 1,
            'unresolved': not actors and not candidates,
            'no_player': not actors and not candidates,
        }
        assert expected_shape[state], f'association shape mismatch: {state}'


def main() -> None:
    ai_job_schema = CONTRACTS / 'ai' / 'job.schema.json'
    ai_result_schema = CONTRACTS / 'ai' / 'result.schema.json'
    for folder in sorted(path for path in FIXTURES.iterdir() if path.is_dir()):
        validate(ai_job_schema, folder / 'job.json')
        validate(ai_result_schema, folder / 'result.json')
        assert_ai_invariants(load(folder / 'job.json'), load(folder / 'result.json'))

    example_pairs = {
        'examples/media/playback-window-request.json': 'media/playback-window-request.schema.json',
        'examples/media/playback-window-descriptor.json': 'media/playback-window-descriptor.schema.json',
        'examples/media/playback-cursor.json': 'media/playback-cursor.schema.json',
        'examples/media/resolved-media-anchor.json': 'media/resolved-media-anchor.schema.json',
        'examples/annotation/close-rally-left.json': 'annotation/realtime.schema.json',
        'examples/annotation/close-rally-right.json': 'annotation/realtime.schema.json',
        'examples/annotation/close-rally-unknown.json': 'annotation/realtime.schema.json',
        'examples/annotation/close-rally-ack.json': 'annotation/realtime.schema.json',
        'examples/annotation/close-rally-target-conflict.json': 'annotation/realtime.schema.json',
        'examples/annotation/submit.json': 'annotation/realtime.schema.json',
        'examples/annotation/soft-lock-intent.json': 'annotation/realtime.schema.json',
        'examples/ai/capabilities.json': 'ai/capabilities.schema.json',
        'examples/ai/job-accepted.json': 'ai/job-accepted.schema.json',
    }
    for instance, schema in example_pairs.items():
        validate(CONTRACTS / schema, CONTRACTS / instance)

    annotation_schema = load(CONTRACTS / 'annotation' / 'realtime.schema.json')
    annotation_validator = Draft202012Validator(annotation_schema, format_checker=FormatChecker())
    old_terminal = {
        'schema_version': '1.1.0',
        'command_id': 'old-terminal',
        'room_id': 'room-001',
        'base_revision': '12',
        'rally_id': 'rally-001',
        'kind': 'MARK_TERMINAL',
        'payload': {'target_key_point_id': 'kp-004'},
    }
    assert not annotation_validator.is_valid(old_terminal)
    close_with_score_frame = load(CONTRACTS / 'examples' / 'annotation' / 'close-rally-left.json')
    close_with_score_frame['payload']['score_frame_index'] = '540'
    assert not annotation_validator.is_valid(close_with_score_frame)

    # Validate every schema itself, including boundaries without golden fixtures yet.
    for path in CONTRACTS.rglob('*.schema.json'):
        Draft202012Validator.check_schema(load(path))

    unknown = load(FIXTURES / 'unknown-outcome' / 'job.json')
    assert unknown['outcome'] == {'score_resolution': 'unknown', 'scoring_court_side': None}

    normal = load(FIXTURES / 'normal-rally' / 'result.json')
    positions = [
        position['court_pos']['x']
        for event in normal['contact_events']
        for position in event['representative_court_positions']
    ]
    assert any(value < 0 for value in positions)
    assert any(value > 1 for value in positions)

    # Actor observations must identify the clip frame used; path segments use adjacent passthrough key-point IDs, not AI-generated segment IDs.
    for result_file in sorted(FIXTURES.glob('*/result.json')):
        result = load(result_file)
        for event in result['contact_events']:
            for actor in event['actors']:
                assert actor['observation_frame_index'].isdigit()
        for segment in result['path_segments']:
            assert 'segment_id' not in segment

    print('contract validation passed')


if __name__ == '__main__':
    main()

