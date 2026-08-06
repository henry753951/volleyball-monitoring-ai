from __future__ import annotations

from pathlib import Path

from volleyball_monitoring_ai import AnalysisBundle, AIJobRequest, create_provider_app


def analyze(_job: AIJobRequest, _clip: Path) -> AnalysisBundle:
    raise NotImplementedError(
        "Fake provider scaffold: load a matching golden fixture and VOV1 overlay in the E2E test."
    )


app = create_provider_app(analyze=analyze)
