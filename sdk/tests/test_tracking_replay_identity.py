import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from examples.tracking_replay_provider.identity import (  # noqa: E402
    consolidate_tracking_identities,
    consolidated_track_rows,
    rewrite_analysis_track_ids,
)


def player(track_id: int, x: float, y: float) -> dict:
    return {
        "track_id": track_id,
        "frame_bbox": {"x1": 0.1, "y1": 0.1, "x2": 0.2, "y2": 0.3},
        "frame_foot_pos": {"x": 0.15, "y": 0.3},
        "court_pos": {"x": x, "y": y},
    }


def test_consolidates_short_fragments_into_six_identities_per_court_side() -> None:
    records = []
    for frame in range(4):
        players = [player(track_id, 0.1 + track_id * 0.04, 0.4) for track_id in range(1, 7)]
        players += [player(track_id, 0.55 + (track_id - 7) * 0.05, 0.4) for track_id in range(7, 13)]
        if frame >= 2:
            players += [player(13, 0.34, 0.42), player(14, 0.82, 0.42)]
        records.append({"frame_index": frame, "players": players})

    result = consolidate_tracking_identities(records)

    assert len(set(result.raw_to_canonical.values())) == 12
    assert result.raw_to_canonical[13] in range(1, 7)
    assert result.raw_to_canonical[14] in range(7, 13)
    assert all(len(record["players"]) == 12 for record in result.frame_records)
    assert result.duplicate_observations_suppressed == 4


def test_rewrites_analysis_references_and_retains_fragment_provenance() -> None:
    records = [
        {"frame_index": 0, "players": [player(1, 0.2, 0.4), player(2, 0.8, 0.4)]},
        {"frame_index": 1, "players": [player(1, 0.2, 0.4), player(2, 0.8, 0.4), player(3, 0.21, 0.4)]},
    ]
    consolidation = consolidate_tracking_identities(records, players_per_side=1)
    rewritten = rewrite_analysis_track_ids(
        {"actors": [{"track_id": 3}], "positions": [{"track_id": None}]},
        consolidation.raw_to_canonical,
    )
    rows = consolidated_track_rows(
        consolidation.frame_records,
        consolidation,
        [{"track_id": 1, "metadata": {"source": "recorded"}}, {"track_id": 2}],
    )

    assert rewritten["actors"][0]["track_id"] == 1
    assert rewritten["positions"][0]["track_id"] is None
    assert rows[0]["metadata"]["identity_consolidation"]["source_track_ids"] == [1, 3]
    assert rows[0]["court_side"] == "left"
    assert rows[1]["court_side"] == "right"
