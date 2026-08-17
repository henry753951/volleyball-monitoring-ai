# VolleyAI single-node k3s deployment runbook

This document records the deployed single-node environment and the operational steps needed to
update, verify, and diagnose it. It intentionally contains no credentials or token values.

## Environment

- Node: `kube-1` (`nckusoc@192.168.50.223`)
- Kubernetes: k3s, namespace `volleyball-monitoring`
- GPU: NVIDIA RTX 3090, advertised to Kubernetes through the NVIDIA device plugin
- Main application: `https://volleyai.hsulab.net`
- Object-storage API: `https://volleyai-storage.hsulab.net`
- Deployment workspace: `/srv/volleyai/deploy`
- Model storage: `/srv/volleyai/models`
- Worker workspace and media data: `/srv/volleyai/workspaces`
- Node-local quick reference: `/home/nckusoc/DEPLOYMENT.md`

Cloudflare Tunnel publishes the two public hostnames. Tunnel and Access policy administration is
outside the k3s rollout procedure; diagnose the cluster through SSH and cluster-local endpoints
before attributing an application failure to the tunnel.

## Deployed topology

The namespace contains:

- `server`, `web`, `worker-media`, and `worker-workflow` from
  `henry753951/volleyball-monitoring-ai`;
- `analysis-engine` from `henry753951/volleyball-analysis-engine`;
- PostgreSQL, Redis, MinIO, OvenMediaEngine, and the internal gateway;
- a model bootstrap job and persistent local storage.

As verified on 2026-08-17, the application release was `1.3.0` at Git revision
`63eb156ced1b6ebb7027c8380f31098641cda0bc`, and the analysis engine was `0.9.0` at Git revision
`d0139f866633726ad1bf6dffbb7e9293475e2f5f`. Workloads are pinned to immutable OCI digests, not
mutable tags. Re-run the verification commands below instead of treating these recorded versions as
current forever.

## Update all application workloads

The node updater resolves the latest GitHub Releases, authenticates to private GHCR images, resolves
each tag to an immutable digest, patches the workload, updates its visible version/Git annotations,
and waits for every rollout:

```bash
sudo /usr/local/sbin/volleyai-update --force
```

Without `--force`, unchanged digests are not restarted:

```bash
sudo /usr/local/sbin/volleyai-update
```

Automatic checks run every 15 minutes:

```bash
systemctl status volleyai-update.timer
journalctl -u volleyai-update.service -n 200 --no-pager
```

The updater must keep the deployment annotations in sync with the image it applies:

- `vollyai.hsulab.net/version`
- `vollyai.hsulab.net/git-sha`

Updating only `spec.template.spec.containers[*].image` leaves the console showing an old version even
when the new digest is running.

## Verify a rollout

Do not infer a successful deployment from a published release or a completed image build. Verify the
actual node, readiness, image digest, release annotations, and GPU separately:

```bash
sudo k3s kubectl -n volleyball-monitoring get pods -o wide
sudo k3s kubectl -n volleyball-monitoring get deployments,statefulsets
sudo k3s kubectl -n volleyball-monitoring get deployment \
  server web worker-media worker-workflow analysis-engine \
  -o custom-columns='NAME:.metadata.name,VERSION:.metadata.annotations.vollyai\.hsulab\.net/version,GIT:.metadata.annotations.vollyai\.hsulab\.net/git-sha,IMAGE:.spec.template.spec.containers[0].image'
sudo k3s kubectl -n volleyball-monitoring rollout status deployment/server --timeout=20m
sudo k3s kubectl -n volleyball-monitoring rollout status deployment/web --timeout=20m
sudo k3s kubectl -n volleyball-monitoring rollout status deployment/worker-media --timeout=20m
sudo k3s kubectl -n volleyball-monitoring rollout status deployment/worker-workflow --timeout=20m
sudo k3s kubectl -n volleyball-monitoring rollout status deployment/analysis-engine --timeout=20m
nvidia-smi
sudo k3s kubectl -n volleyball-monitoring logs deployment/analysis-engine --tail=200
```

The analysis pod must be `Ready`, request an `nvidia.com/gpu` resource, connect to the Central Server,
and report CUDA availability. A running pod by itself does not prove GPU inference.

## GHCR authentication without the GitHub CLI

The token needs `read:packages`. Never put it in this document, a manifest, or shell history:

```bash
read -rsp 'GHCR read:packages token: ' GHCR_TOKEN; echo
printf '%s' "$GHCR_TOKEN" | sudo skopeo login \
  --username henry753951 \
  --password-stdin ghcr.io
unset GHCR_TOKEN

sudo k3s kubectl -n volleyball-monitoring create secret generic ghcr-pull-secret \
  --type=kubernetes.io/dockerconfigjson \
  --from-file=.dockerconfigjson=/root/.config/containers/auth.json \
  --dry-run=client -o yaml | sudo k3s kubectl apply -f -
```

## Runtime secrets

Runtime values, including `JERSEY_VISION_*`, are Kubernetes Secrets. Verify only their keys and
workload references; do not print values into logs or issue reports. Relevant secrets include:

- `volleyball-runtime`
- `analysis-worker-runtime`
- `ghcr-pull-secret`
- `minio-metrics`

Restart only the affected deployment after changing a secret because an existing process does not
automatically reload environment variables.

## MinIO capacity monitoring

The Server reads MinIO cluster capacity from `/minio/metrics/v3/cluster/health` using
`MINIO_METRICS_BEARER_TOKEN`. A stale or manually invented token returns HTTP 403 even when S3 object
operations work normally. Generate the token through the running MinIO admin client, replace the
secret, and restart the Server:

```bash
sudo k3s kubectl -n volleyball-monitoring exec -it minio-0 -- sh
mc alias set local http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
mc admin prometheus generate local cluster
exit

# Store the generated bearer token without placing it on the command line.
read -rsp 'MinIO metrics bearer token: ' MINIO_METRICS_TOKEN; echo
sudo k3s kubectl -n volleyball-monitoring create secret generic minio-metrics \
  --from-literal=MINIO_METRICS_BEARER_TOKEN="$MINIO_METRICS_TOKEN" \
  --dry-run=client -o yaml | sudo k3s kubectl apply -f -
unset MINIO_METRICS_TOKEN
sudo k3s kubectl -n volleyball-monitoring rollout restart deployment/server
sudo k3s kubectl -n volleyball-monitoring rollout status deployment/server --timeout=15m
```

Validate the cluster-local metrics endpoint before testing through the public hostname. HTTP 200 and
the `minio_cluster_health_capacity_usable_*_bytes` series prove that the capacity probe can work.

## YouTube VOD ingest and the misleading slow-rate symptom

The current VOD path is not a streaming-to-playback path:

1. `worker-media` asks `yt-dlp` to download the complete selected video and audio streams.
2. `yt-dlp` invokes FFmpeg to merge the complete inputs into MP4 using `-movflags +faststart`.
3. The Worker then cuts the merged file into two-second fragmented-MP4 files.
4. The recording monitor validates stable files, uploads objects to MinIO, and indexes them in strict
   capture order.

The console rate is therefore published/indexed media duration divided by elapsed wall time. It is
not the raw YouTube network throughput. During the 2026-08-17 investigation:

- a 256 MiB read from the same YouTube 1080p60 format took 6.82 seconds, approximately 37.5 MiB/s or
  315 Mbit/s including command startup;
- the selected source consisted of about 6.22 GB video plus 0.20 GB audio;
- the full download had already completed while FFmpeg was still performing the whole-file MP4
  merge/faststart pass;
- host `sda` reached 86-93% utilization with approximately 35-53 MiB/s reads and 39-61 ms read
  latency during that pass;
- the VM exposes the 400 GB QEMU disk as rotational storage;
- restarting `worker-media` during an unfinished VOD caused another full download/merge attempt.

Consequently a visible `0.10x` does not demonstrate a slow Internet link. For this incident the main
bottlenecks were whole-file staging, the second whole-file FFmpeg pass on virtual rotational storage,
and delayed two-second segmentation/indexing. A rollout also discarded the temporary download and
repeated the expensive work.

Inspect the real stages separately:

```bash
sudo k3s kubectl -n volleyball-monitoring logs deployment/worker-media --tail=300
sudo k3s kubectl -n volleyball-monitoring exec deployment/worker-media -- ps -ef
sudo k3s kubectl -n volleyball-monitoring exec deployment/worker-media -- \
  du -sh /var/lib/volleyball/media-imports/.work /var/lib/volleyball/media-spool
sudo iostat -dxm 1 5
```

When investigating a specific source, also inspect its `MediaSourceWork`, `DvrProgram`, and only
READY `DvrSegment` records. Declared source duration or temporary spool files must not be counted as
playable progress.

### Recommended ingest redesign

The durable fix is a separate change, not an operator timeout adjustment:

- pipe the selected YouTube inputs directly into FFmpeg segmentation so completed fragments become
  playable while later source data is still arriving;
- avoid `+faststart` for a temporary ingest artifact, or remove the intermediate merged artifact;
- persist a resumable source cache keyed by source identity and selected format so a Worker restart
  does not redownload completed bytes;
- expose explicit `PROBING`, `DOWNLOADING`, `MERGING`, `SEGMENTING`, `UPLOADING`, and `INDEXING`
  stages with a stage-specific rate;
- apply queue backpressure so segment discovery cannot create hundreds of jobs faster than strict
  ordered indexing can consume them.

Until that redesign lands, avoid forcing a `worker-media` rollout during a long VOD import unless the
restart is required to recover a failed worker.

## Recovery and rollback

Restarting one deployment without changing its version:

```bash
sudo k3s kubectl -n volleyball-monitoring rollout restart deployment/analysis-engine
sudo k3s kubectl -n volleyball-monitoring rollout status deployment/analysis-engine --timeout=15m
```

For rollback, patch the workload to a previously verified immutable image digest and wait for its
rollout. Record the repository release, Git SHA, digest, database migration compatibility, and reason
for rollback. Do not roll back PostgreSQL or delete media/object volumes as part of an application
rollback without a separately verified restore plan.
