"""Runnable outbound AI worker using bundled example analysis data.

Required environment variables:
  VOLLEYBALL_AI_WS_URL=wss://central.example.com/api/v1/ai/providers/ws
  VOLLEYBALL_AI_TOKEN=replace-with-provider-token

Optional:
  VOLLEYBALL_AI_WORKSPACE=./.volleyball-ai-jobs
  VOLLEYBALL_AI_INSTANCE_ID=my-gpu-pc
"""

from __future__ import annotations

import asyncio
import os
from pathlib import Path

from volleyball_monitoring_ai import (
    AIWorkerClient,
    FixtureResultBuilder,
    JobContext,
    ProviderCapabilities,
    WorkerConfig,
)

CAPABILITIES = ProviderCapabilities.model_validate(
    {
        "schema_version": "2.0.0",
        "provider_name": "fixture-worker",
        "provider_build_id": "fixture-example-v1",
        "supported_job_schema_versions": ["3.0.0"],
        "supported_analysis_data_versions": ["1.0.0"],
        "supported_analysis_modules": ["court", "tracking", "reid", "contacts"],
        "supports_selective_rerun": True,
        "optional_extensions": {"action": False, "group_phase": False, "confidence": False},
        "action_taxonomies": [],
    }
)


class ExampleInferencePipeline:
    def __init__(self) -> None:
        self.result_builder = FixtureResultBuilder()

    async def __call__(self, context: JobContext) -> None:
        clip_path = await context.download_clip()
        print(f"downloaded {context.job.ai_job_id} to {clip_path}")

        # TODO(AI team): open clip_path with the actual decoder and run tracking/inference.
        # The loop demonstrates progress and cooperative abort checkpoints without pretending
        # to be a real model.
        for step in range(1, 11):
            context.cancellation.raise_if_aborted()
            await asyncio.sleep(0.1)
            await context.report_progress(0.05 + step * 0.08, "fixture_inference")

        bundle = self.result_builder.build(context.job)
        await context.complete(bundle)
        print(f"completed {context.job.ai_job_id}")


async def main() -> None:
    ws_url = os.environ["VOLLEYBALL_AI_WS_URL"]
    token = os.environ["VOLLEYBALL_AI_TOKEN"]
    workspace = Path(os.getenv("VOLLEYBALL_AI_WORKSPACE", ".volleyball-ai-jobs"))
    instance_id = os.getenv("VOLLEYBALL_AI_INSTANCE_ID")
    config_kwargs = {
        "server_ws_url": ws_url,
        "token": token,
        "workspace": workspace,
        "provider_build_id": "fixture-example-v1",
        "capabilities": CAPABILITIES,
        "max_concurrency": 1,
    }
    if instance_id:
        config_kwargs["instance_id"] = instance_id
    client = AIWorkerClient(WorkerConfig(**config_kwargs))
    await client.run_forever(ExampleInferencePipeline())


if __name__ == "__main__":
    asyncio.run(main())
