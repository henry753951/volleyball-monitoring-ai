FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /repo

COPY sdk ./sdk
COPY packages/contracts ./packages/contracts
COPY examples/fake_ai_provider ./examples/fake_ai_provider

RUN python -m pip install --no-cache-dir './sdk[provider]'

CMD ["uvicorn", "examples.fake_ai_provider.app:app", "--host", "0.0.0.0", "--port", "8080"]
