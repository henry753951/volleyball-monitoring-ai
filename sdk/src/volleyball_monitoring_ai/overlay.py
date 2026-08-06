from importlib.resources import files
from pathlib import Path

FILE_IDENTIFIER = b"VOV1"

def overlay_schema_path() -> Path:
    return Path(str(files("volleyball_monitoring_ai.schemas").joinpath("overlay.fbs")))

def validate_overlay_bytes(data: bytes) -> None:
    if len(data) < 8 or data[4:8] != FILE_IDENTIFIER:
        raise ValueError("overlay is not a VOV1 FlatBuffer")

def quantize_frame_coordinate(value: float) -> int:
    if not 0 <= value <= 1: raise ValueError("frame coordinate outside [0,1]")
    return round(value * 65534)
