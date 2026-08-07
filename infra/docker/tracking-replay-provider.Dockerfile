FROM ghcr.io/astral-sh/uv:0.11.31 AS uv
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    CONTRACT_LAB_HANDOFF_ROOT=/data/contract-lab-handoff

WORKDIR /repo

COPY --from=uv /uv /uvx /bin/

COPY sdk ./sdk
COPY packages/contracts ./packages/contracts
COPY examples/tracking_replay_provider ./examples/tracking_replay_provider

RUN uv sync --project sdk --frozen --no-dev --extra provider

CMD ["./sdk/.venv/bin/uvicorn", "examples.tracking_replay_provider.app:app", "--host", "0.0.0.0", "--port", "8080"]
