# ADR 028: ECS deployment manifest and release job

- **Status:** accepted
- **Date:** 2026-08-26

## Context

ADR 015 fixes AWS ECS/Fargate as the V1 container platform, but does not choose
a repository-owned deployment representation. Phase 7 needs a locally
verifiable contract for independent process roles, least-privilege credentials,
immutable containers, and migrations that finish before serving tasks roll.

## Decision

The repository owns a small declarative ECS workload manifest, a deterministic
renderer for ECS task-definition JSON, and a versioned external-platform
contract. The manifest is the reviewed source of truth for the API, worker,
lifecycle-command, retention, recovery, and migration roles. API, worker,
lifecycle-command, and retention are independent services; recovery and
migration are explicitly invoked jobs.

All deployed credentials are individual AWS Secrets Manager values injected
through the ECS `secrets` field. Plaintext task environment values are limited
to non-sensitive process configuration. Task and execution roles are supplied
by the external platform and are distinct for every workload. Fargate tasks use
a non-root image user, the ECS init process, read-only root filesystems, and
writable ephemeral `/tmp` mounts only where Node requires scratch space.

The migration task is the release job. Deployment automation must run it, wait
for a zero exit code, and only then update serving services to the compatible
task definitions. API startup migration compatibility remains a second,
fail-closed guard; the API never runs migrations.

API container health calls dependency-aware `/health/ready`. Long-running
non-HTTP roles use process health because their dependency readiness is proven
at bootstrap and their internal loops already expose operational metrics.
One-shot migration and recovery jobs have no container health check: their exit
status is the truthful result.

The external platform remains free to use its own versioned IaC implementation,
but it must export a normalized AWS-API snapshot matching
`infrastructure/ecs/external-platform-contract.json`. The repository validator
binds that snapshot to the exact contract hash and rejects stale or synthetic
evidence, role reuse or wildcard IAM, public task addresses, network endpoint or
secret/KMS drift, unhealthy rollout/drain state, missing telemetry and alarm
wiring, scaling drift, overlapping or late migrations, and an open recovery
writer fence. This normalized snapshot is the deployment seam: platform
implementation details stay behind it while release review has one small,
versioned interface.

## Consequences

Task definitions can be rendered and inspected without cloud credentials, and
CI can reject root containers, plaintext credential variables, combined roles,
missing health contracts, writable roots, or accidental services for one-shot
jobs. Repository checks validate the external contract, while a release-time
AWS snapshot detects drift in account resources, networking, IAM policies,
autoscaling, release orchestration, and the regional writer fence. Live AWS
collection, independent policy review, and regional recovery drills remain
external deployment gates.

The renderer is intentionally narrower than a general infrastructure framework.
If broader AWS resources become repository-owned, this manifest may be replaced
by CloudFormation or another accepted IaC decision without changing process-role
or secret boundaries.
