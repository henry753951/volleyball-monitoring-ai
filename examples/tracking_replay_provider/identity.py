from __future__ import annotations

from collections import defaultdict
from copy import deepcopy
from dataclasses import dataclass
from math import hypot, isfinite
from statistics import median
from typing import Any


@dataclass(frozen=True)
class IdentityConsolidation:
    frame_records: list[dict[str, Any]]
    raw_to_canonical: dict[int, int]
    court_sides: dict[int, str]
    source_track_ids: dict[int, tuple[int, ...]]
    duplicate_observations_suppressed: int


@dataclass(frozen=True)
class _TrackStats:
    track_id: int
    first_frame: int
    last_frame: int
    observation_count: int
    median_x: float
    median_y: float
    court_side: str


def _track_stats(frame_records: list[dict[str, Any]]) -> dict[int, _TrackStats]:
    observations: dict[int, list[tuple[int, float, float]]] = defaultdict(list)
    for record in frame_records:
        frame_index = int(record["frame_index"])
        for player in record.get("players", []):
            track_id = int(player["track_id"])
            court = player.get("court_pos")
            if not isinstance(court, dict):
                continue
            x = float(court.get("x", float("nan")))
            y = float(court.get("y", float("nan")))
            if isfinite(x) and isfinite(y):
                observations[track_id].append((frame_index, x, y))

    result: dict[int, _TrackStats] = {}
    for track_id, rows in observations.items():
        xs = [row[1] for row in rows]
        ys = [row[2] for row in rows]
        median_x = median(xs)
        result[track_id] = _TrackStats(
            track_id=track_id,
            first_frame=min(row[0] for row in rows),
            last_frame=max(row[0] for row in rows),
            observation_count=len(rows),
            median_x=median_x,
            median_y=median(ys),
            court_side="left" if median_x < 0.5 else "right",
        )
    return result


def _canonical_seeds(stats: dict[int, _TrackStats], *, players_per_side: int) -> dict[str, list[_TrackStats]]:
    seeds: dict[str, list[_TrackStats]] = {"left": [], "right": []}
    for side in seeds:
        candidates = [item for item in stats.values() if item.court_side == side]
        # Long-lived identities are the stable on-court slots. The source track ID
        # is only a deterministic tie-breaker and has no cross-run meaning.
        candidates.sort(key=lambda item: (-item.observation_count, item.first_frame, item.track_id))
        seeds[side] = candidates[:players_per_side]
    return seeds


def _identity_cost(fragment: _TrackStats, seed: _TrackStats) -> tuple[float, int, int]:
    distance = hypot(fragment.median_x - seed.median_x, fragment.median_y - seed.median_y)
    if fragment.first_frame > seed.last_frame:
        frame_gap = fragment.first_frame - seed.last_frame
    elif seed.first_frame > fragment.last_frame:
        frame_gap = seed.first_frame - fragment.last_frame
    else:
        frame_gap = 0
    return distance, frame_gap, seed.track_id


def consolidate_tracking_identities(
    frame_records: list[dict[str, Any]],
    *,
    players_per_side: int = 6,
) -> IdentityConsolidation:
    """Collapse tracker fragments into stable per-side analysis identities.

    This is deliberately not a learned REID implementation. Long-lived tracks
    establish six deterministic identity slots per court side. Short fragments
    are associated with the nearest slot on the same AI-projected court side.
    If a fragment and its slot coexist in one frame, the long-lived observation
    wins so one canonical identity never renders twice.
    """

    if players_per_side <= 0:
        raise ValueError("players_per_side must be positive")
    stats = _track_stats(frame_records)
    seeds = _canonical_seeds(stats, players_per_side=players_per_side)
    raw_to_canonical: dict[int, int] = {}
    seed_ids = {item.track_id for values in seeds.values() for item in values}
    for seed_id in seed_ids:
        raw_to_canonical[seed_id] = seed_id
    for fragment in sorted(stats.values(), key=lambda item: item.track_id):
        if fragment.track_id in raw_to_canonical:
            continue
        side_seeds = seeds[fragment.court_side]
        if not side_seeds:
            raw_to_canonical[fragment.track_id] = fragment.track_id
            continue
        raw_to_canonical[fragment.track_id] = min(
            side_seeds,
            key=lambda seed: _identity_cost(fragment, seed),
        ).track_id

    source_track_ids: dict[int, list[int]] = defaultdict(list)
    for raw_id, canonical_id in sorted(raw_to_canonical.items()):
        source_track_ids[canonical_id].append(raw_id)

    consolidated_records: list[dict[str, Any]] = []
    suppressed = 0
    for source_record in frame_records:
        record = deepcopy(source_record)
        selected: dict[int, tuple[bool, dict[str, Any]]] = {}
        for source_player in record.get("players", []):
            player = deepcopy(source_player)
            raw_id = int(player["track_id"])
            canonical_id = raw_to_canonical.get(raw_id, raw_id)
            player["track_id"] = canonical_id
            is_seed = raw_id == canonical_id
            previous = selected.get(canonical_id)
            if previous is None or (is_seed and not previous[0]):
                if previous is not None:
                    suppressed += 1
                selected[canonical_id] = (is_seed, player)
            else:
                suppressed += 1
        record["players"] = [selected[key][1] for key in sorted(selected)]
        consolidated_records.append(record)

    court_sides = {
        seed.track_id: seed.court_side
        for values in seeds.values()
        for seed in values
    }
    return IdentityConsolidation(
        frame_records=consolidated_records,
        raw_to_canonical=raw_to_canonical,
        court_sides=court_sides,
        source_track_ids={key: tuple(value) for key, value in source_track_ids.items()},
        duplicate_observations_suppressed=suppressed,
    )


def rewrite_analysis_track_ids(value: Any, raw_to_canonical: dict[int, int]) -> Any:
    if isinstance(value, list):
        return [rewrite_analysis_track_ids(item, raw_to_canonical) for item in value]
    if not isinstance(value, dict):
        return value
    rewritten: dict[str, Any] = {}
    for key, item in value.items():
        if key == "track_id" and item is not None:
            raw_id = int(item)
            rewritten[key] = raw_to_canonical.get(raw_id, raw_id)
        else:
            rewritten[key] = rewrite_analysis_track_ids(item, raw_to_canonical)
    return rewritten


def consolidated_track_rows(
    frame_records: list[dict[str, Any]],
    consolidation: IdentityConsolidation,
    reference_tracks: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    spans: dict[int, list[int]] = defaultdict(list)
    for record in frame_records:
        frame_index = int(record["frame_index"])
        for player in record.get("players", []):
            spans[int(player["track_id"])].append(frame_index)
    templates: dict[int, dict[str, Any]] = {}
    for track in reference_tracks:
        # Rewritten fragment rows can share a canonical ID. Preserve the first
        # (stable seed) template instead of allowing a later fragment to replace it.
        templates.setdefault(int(track["track_id"]), track)
    rows: list[dict[str, Any]] = []
    for canonical_id in sorted(spans):
        row = deepcopy(templates.get(canonical_id, {}))
        metadata = deepcopy(row.get("metadata") or {})
        metadata["identity_consolidation"] = {
            "method": "deterministic_court_side_continuity_v1",
            "source_track_ids": list(consolidation.source_track_ids.get(canonical_id, (canonical_id,))),
        }
        row.update(
            {
                "track_id": canonical_id,
                "court_side": consolidation.court_sides.get(canonical_id, "unknown"),
                "first_frame_index": str(min(spans[canonical_id])),
                "last_frame_index": str(max(spans[canonical_id])),
                "metadata": metadata,
            }
        )
        rows.append(row)
    return rows
