
# REST boundaries

Use REST for resources that are a poor fit for GraphQL:

- playback-window descriptors and HLS manifests;
- playback-cursor resolution and frame stepping;
- signed/authorized canonical clip download;
- AI progress/failure/completed callbacks;
- overlay manifest and FlatBuffers chunks;
- health/readiness and binary artifacts.

Every JSON endpoint validates a versioned schema from `packages/contracts`. Large uploads
must stream to object storage and must not be buffered into the Node.js heap.
