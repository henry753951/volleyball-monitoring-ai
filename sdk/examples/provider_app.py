from pathlib import Path
from volleyball_monitoring_ai import AnalysisBundle, AIJobRequest, create_provider_app

def analyze(job: AIJobRequest, clip_path: Path) -> AnalysisBundle:
    raise NotImplementedError("Call the AI team's existing work and return AnalysisBundle")

app=create_provider_app(analyze=analyze)
