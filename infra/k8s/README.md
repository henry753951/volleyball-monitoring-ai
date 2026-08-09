# Kubernetes deployment

The HSULab deployment is managed by Flux from the separate GitOps repository:

```text
henry753951/shrimp_farm
  clusters/lab/apps/volleyball-monitoring
```

This source repository owns application code, Dockerfiles, CI, Release Please,
and the three versioned GHCR images (`server`, `web`, and `worker`). The GitOps
repository owns Kubernetes resources and Flux image automation.

Runtime credentials, database URLs, AI worker tokens, and registry credentials
must be created directly in the `volleyball-monitoring` namespace. Never copy
`.env`, kubeconfig, or rendered Secret YAML into either repository.

The deployment keeps the existing application interfaces intact:

- project Traefik gateway: same-origin web, GraphQL, REST, WebSocket, and OME LL-HLS routing;
- PostgreSQL, Redis, MinIO, and OvenMediaEngine: internal stateful services;
- server, web, worker-media, and worker-workflow: versioned application workloads;
- external AI workers: outbound WSS to `/api/v1/ai/providers/ws` using a token.

Images are published by `.github/workflows/release.yml`. Flux selects strict
SemVer tags and commits both tag and digest updates to the GitOps repository.
