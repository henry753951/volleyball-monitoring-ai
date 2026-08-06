# Local HTTPS for the iPad PWA

A Service Worker and installable PWA require a trusted HTTPS origin on iPad. Traefik listens on 443 and uses a generated default certificate until you create a trusted development certificate.

Run:

```bash
./scripts/generate-local-tls.sh volleyball.lan 192.168.1.50
```

The script uses `mkcert`, writes ignored files under `infra/traefik/certs/`, and creates `infra/traefik/dynamic/tls.yml`. Add the hostname to local DNS, transfer the mkcert root CA to the iPad, install the profile, then enable full trust under iOS Certificate Trust Settings.

Never commit `tls.key`, local CA material, or generated `tls.yml`.
