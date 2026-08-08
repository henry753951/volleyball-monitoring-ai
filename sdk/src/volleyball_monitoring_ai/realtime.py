from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter

from .models import AIJobRequest, ProviderCapabilities

PROVIDER_REALTIME_SCHEMA_VERSION = "1.0.0"


class RealtimeModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ActiveJob(RealtimeModel):
    ai_job_id: str = Field(min_length=1, max_length=128)
    delivery_id: str = Field(min_length=1, max_length=128)
    progress: float | None = Field(default=None, ge=0, le=1)


class ProviderHello(RealtimeModel):
    schema_version: Literal["1.0.0"] = PROVIDER_REALTIME_SCHEMA_VERSION
    type: Literal["provider_hello"] = "provider_hello"
    instance_id: str = Field(min_length=1, max_length=128)
    sdk_version: str = Field(min_length=1, max_length=128)
    provider_build_id: str = Field(min_length=1, max_length=128)
    max_concurrency: int = Field(ge=1, le=64)
    capabilities: ProviderCapabilities
    active_jobs: list[ActiveJob]


class JobAcceptedMessage(RealtimeModel):
    schema_version: Literal["1.0.0"] = PROVIDER_REALTIME_SCHEMA_VERSION
    type: Literal["job_accepted"] = "job_accepted"
    ai_job_id: str
    delivery_id: str
    accepted_at: datetime


class JobRejectedMessage(RealtimeModel):
    schema_version: Literal["1.0.0"] = PROVIDER_REALTIME_SCHEMA_VERSION
    type: Literal["job_rejected"] = "job_rejected"
    ai_job_id: str
    delivery_id: str
    code: str
    message: str
    retryable: bool


class HeartbeatMessage(RealtimeModel):
    schema_version: Literal["1.0.0"] = PROVIDER_REALTIME_SCHEMA_VERSION
    type: Literal["heartbeat"] = "heartbeat"
    instance_id: str
    active_jobs: list[ActiveJob]


class ProgressMessage(RealtimeModel):
    schema_version: Literal["1.0.0"] = PROVIDER_REALTIME_SCHEMA_VERSION
    type: Literal["progress"] = "progress"
    ai_job_id: str
    delivery_id: str
    progress: float = Field(ge=0, le=1)
    stage: str | None = None


class AbortAckMessage(RealtimeModel):
    schema_version: Literal["1.0.0"] = PROVIDER_REALTIME_SCHEMA_VERSION
    type: Literal["abort_ack"] = "abort_ack"
    ai_job_id: str
    delivery_id: str
    acknowledged_at: datetime


class ConnectionReadyMessage(RealtimeModel):
    schema_version: Literal["1.0.0"]
    type: Literal["connection_ready"]
    connection_id: str
    server_time: datetime
    heartbeat_interval_seconds: int = Field(ge=1)
    lease_seconds: int = Field(ge=5)


class JobOfferMessage(RealtimeModel):
    schema_version: Literal["1.0.0"]
    type: Literal["job_offer"]
    ai_job_id: str
    delivery_id: str
    lease_expires_at: datetime
    job: AIJobRequest


class LeaseRenewedMessage(RealtimeModel):
    schema_version: Literal["1.0.0"]
    type: Literal["lease_renewed"]
    ai_job_id: str
    delivery_id: str
    lease_expires_at: datetime


class AbortJobMessage(RealtimeModel):
    schema_version: Literal["1.0.0"]
    type: Literal["abort_job"]
    ai_job_id: str
    delivery_id: str
    reason: str


class ResumeJobMessage(RealtimeModel):
    schema_version: Literal["1.0.0"]
    type: Literal["resume_job"]
    ai_job_id: str
    delivery_id: str
    lease_expires_at: datetime


class DiscardJobMessage(RealtimeModel):
    schema_version: Literal["1.0.0"]
    type: Literal["discard_job"]
    ai_job_id: str
    delivery_id: str
    reason: str


class JobCommittedMessage(RealtimeModel):
    schema_version: Literal["1.0.0"]
    type: Literal["job_committed"]
    ai_job_id: str
    delivery_id: str
    committed_at: datetime


class ProtocolErrorMessage(RealtimeModel):
    schema_version: Literal["1.0.0"]
    type: Literal["protocol_error"]
    code: str
    message: str
    retryable: bool


ServerMessage = Annotated[
    ConnectionReadyMessage
    | JobOfferMessage
    | LeaseRenewedMessage
    | AbortJobMessage
    | ResumeJobMessage
    | DiscardJobMessage
    | JobCommittedMessage
    | ProtocolErrorMessage,
    Field(discriminator="type"),
]
SERVER_MESSAGE_ADAPTER = TypeAdapter(ServerMessage)


def parse_server_message(payload: str | bytes | dict[str, Any]) -> ServerMessage:
    if isinstance(payload, (str, bytes)):
        return SERVER_MESSAGE_ADAPTER.validate_json(payload)
    return SERVER_MESSAGE_ADAPTER.validate_python(payload)
