from __future__ import annotations

from pathlib import Path

BINARY_SUFFIXES = {
    ".bin",
    ".gif",
    ".gz",
    ".ico",
    ".jpeg",
    ".jpg",
    ".mp4",
    ".otf",
    ".pdf",
    ".png",
    ".ttf",
    ".wasm",
    ".webp",
    ".woff",
    ".woff2",
    ".zip",
    ".zst",
}


def canonicalize_checksum_bytes(path: Path, data: bytes) -> bytes:
    """Make text checksums independent of Git checkout line-ending policy."""
    if path.suffix.lower() in BINARY_SUFFIXES:
        return data
    return data.replace(b"\r\n", b"\n")


def canonical_checksum_bytes(path: Path) -> bytes:
    return canonicalize_checksum_bytes(path, path.read_bytes())
