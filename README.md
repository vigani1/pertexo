# Pertexo

Pertexo is an in-progress, multi-tenant workflow automation platform built to
execute durable workflows across APIs and SaaS integrations. The repository
focuses on the backend foundations that make workflow execution reliable:
immutable published versions, resumable runs, idempotent side effects, tenant
isolation, and observable API and worker processes.

## What Is Implemented

- Separate NestJS API and worker process roles in a TypeScript monorepo.
- PostgreSQL-backed workspaces with enforced row-level tenant isolation.
- Workflow drafting, immutable publication, version pinning, and execution.
- Durable checkpoints, node attempts, retries, cancellation, and recovery.
- Transactional outbox and idempotent BullMQ consumers over Redis.
- Bounded artifact storage and lifecycle handling for larger payloads.
- Structured logs, OpenTelemetry traces and metrics, readiness, and draining.
- Contract drift checks plus unit, integration, recovery, outage, and rollout
  verification.

The orchestration slice is under active development. See
[`docs/implementation-progress.md`](./docs/implementation-progress.md) for the
current, evidence-backed status rather than relying on a roadmap claim.

## Architecture

PostgreSQL is authoritative for workflows, runs, waits, and execution state.
Redis and BullMQ provide immediate transport and coordination but are treated as
rebuildable infrastructure. Queue messages carry identifiers rather than graphs,
credentials, or large payloads.

```text
apps/
  api/                 NestJS control-plane API
  worker/              coordination, node attempts, previews, and triggers
  retention/           retention and purge processing
  lifecycle-command/   workspace lifecycle command dispatch
  recovery/            recovery checks before serving
  operator-command/    audited operator command execution

packages/
  database/         PostgreSQL persistence, roles, and migrations
  workflow-model/   versioned authoring model and expression policy
  workflow-engine/  framework-independent execution state machine
  node-sdk/          node definition and executor contracts
  nodes-core/        built-in deterministic nodes
  node-catalog/      immutable compatibility releases
  integrations/     provider and credential boundaries
  queue/             BullMQ transport and Redis event hints
  artifact-store/    bounded dual-region object storage
  rate-limit/        distributed abuse-limit policy and atomic counters
  contracts/         public API schemas and generated artifacts
  observability/     logging, tracing, and metrics
```

The architecture is recorded in [`docs/adr/`](./docs/adr/). The authoritative
backend plan and product vocabulary live in
[`docs/workflow-platform-backend-plan.md`](./docs/workflow-platform-backend-plan.md).

## Stack

- TypeScript and pnpm workspaces
- NestJS API with separately deployable workers
- PostgreSQL with explicit SQL and row-level security
- Redis and BullMQ
- Zod contracts
- OpenTelemetry and structured logging
- S3-compatible object storage

## Local Development

Prerequisites: Node.js 24, pnpm 11, Docker, and Docker Compose.

```bash
pnpm install
cp .env.example .env
docker compose up -d --wait postgres redis artifact-store control-ledger-primary control-ledger-recovery
docker compose run --rm control-ledger-primary-bootstrap
docker compose run --rm control-ledger-recovery-bootstrap
pnpm db:migrate
```

The example environment is for local development only. Review `.env` before
starting processes; do not commit credentials or production configuration.

Common commands:

```bash
pnpm dev:api
pnpm dev:worker
pnpm test
pnpm check
pnpm test:integration
pnpm --filter @pertexo/worker test:phase0e
pnpm --filter @pertexo/api test:sse-resilience
pnpm --filter @pertexo/worker test:resilience
pnpm --filter @pertexo/api test:compatibility-rollout
```

`pnpm check` is the static and unit gate: formatting, build, lint, generated
contract drift, TypeScript, and package unit tests. It does not replace
`pnpm test:integration`, which requires the local PostgreSQL, Redis, and
S3-compatible services above. Phase 0E, resilience, and compatibility rollout
commands are separate destructive or recovery-focused gates.

## Project Status

Pertexo is a personal engineering project in active development, not a hosted
commercial service. Completed phases and their verification evidence are tracked
in [`docs/implementation-progress.md`](./docs/implementation-progress.md).
