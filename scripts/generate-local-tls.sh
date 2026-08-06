#!/usr/bin/env bash
set -euo pipefail

HOSTNAME="${1:-volleyball.lan}"
LAN_IP="${2:-}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CERT_DIR="$ROOT_DIR/infra/traefik/certs"
DYNAMIC_DIR="$ROOT_DIR/infra/traefik/dynamic"

command -v mkcert >/dev/null 2>&1 || {
  echo "mkcert is required. Install it first, then rerun this script." >&2
  exit 1
}

mkdir -p "$CERT_DIR" "$DYNAMIC_DIR"
mkcert -install
NAMES=("$HOSTNAME" localhost 127.0.0.1 ::1)
if [[ -n "$LAN_IP" ]]; then NAMES+=("$LAN_IP"); fi
mkcert -cert-file "$CERT_DIR/tls.crt" -key-file "$CERT_DIR/tls.key" "${NAMES[@]}"

cat > "$DYNAMIC_DIR/tls.yml" <<'EOF'
tls:
  certificates:
    - certFile: /etc/traefik/certs/tls.crt
      keyFile: /etc/traefik/certs/tls.key
EOF

cat <<EOF
Generated certificate for: ${NAMES[*]}
mkcert CA directory: $(mkcert -CAROOT)
Next: put $HOSTNAME in local DNS, install rootCA.pem on the iPad, enable full trust, and restart Traefik.
EOF
