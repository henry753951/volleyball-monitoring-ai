FROM bluenviron/mediamtx:1.20.0 AS mediamtx
FROM python:3.12-alpine
COPY --from=mediamtx /mediamtx /mediamtx
COPY --chmod=0555 infra/mediamtx/hook_client.py /usr/local/bin/media-indexer-hook.py
COPY infra/mediamtx/mediamtx.yml /mediamtx.yml
ENTRYPOINT ["/mediamtx", "/mediamtx.yml"]
