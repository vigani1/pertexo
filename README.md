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
  api/       NestJS control-plane API
  worker/    workflow coordination and node-attempt execution

packages/
  database/       PostgreSQL persistence and migrations
  engine/         framework-independent execution logic
  integrations/   provider and credential boundaries
  observability/  logging, tracing, and metrics
```

The architecture is recorded in [`docs/adr/`](./docs/adr/). The authoritative
backend plan and product vocabulary live in
[`docs/workflow-platform-backend-plan.md`](./docs/workflow-platform-backend-plan.md).

## Stack

- TypeScript, pnpm workspaces, and Turborepo
- NestJS API with separately deployable workers
- PostgreSQL with explicit SQL and row-level security
- Redis and BullMQ
- Zod contracts
- OpenTelemetry and structured logging
- S3-compatible object storage

## Local Development

Prerequisites: Node.js, pnpm, Docker, and Docker Compose.

```bash
pnpm install
cp .env.example .env
docker compose up -d --wait
pnpm check
```

Common commands:

```bash
pnpm dev:api
pnpm dev:worker
pnpm test
pnpm test:integration
pnpm check
```

## Project Status

Pertexo is a personal engineering project in active development, not a hosted
commercial service. Completed phases and their verification evidence are tracked
in [`docs/implementation-progress.md`](./docs/implementation-progress.md).
