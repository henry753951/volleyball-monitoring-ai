from __future__ import annotations

import hashlib
import subprocess
from pathlib import Path

from checksum_utils import canonical_checksum_bytes

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / 'SHA256SUMS.txt'


def tracked_paths() -> list[str]:
    result = subprocess.run(
        ['git', 'ls-files', '-z'],
        cwd=ROOT,
        check=True,
        capture_output=True,
    )
    paths = result.stdout.decode('utf-8').split('\0')
    return sorted(path for path in paths if path and path != MANIFEST.name)


def main() -> None:
    lines: list[str] = []
    for relative in tracked_paths():
        path = ROOT.joinpath(*relative.split('/'))
        if not path.is_file():
            raise FileNotFoundError(f'checksum target is missing: {relative}')
        digest = hashlib.sha256(canonical_checksum_bytes(path)).hexdigest()
        lines.append(f'{digest}  ./{relative}')

    MANIFEST.write_text('\n'.join(lines) + '\n', encoding='utf-8', newline='\n')
    print(f'wrote canonical SHA256SUMS.txt ({len(lines)} files)')


if __name__ == '__main__':
    main()
