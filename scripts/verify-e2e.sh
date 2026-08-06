
#!/usr/bin/env sh
set -eu
python scripts/validate_scaffold.py
python scripts/validate_contracts.py
python -m compileall -q sdk/src
printf '%s\n' 'Baseline scaffold checks passed. Add full E2E checks phase by phase.'
