# Pertexo

Pertexo is an in-progress, multi-tenant workflow automation platform built to
execute durable workflows across APIs and SaaS integrations. The repository
focuses on the backend foundations that make workflow execution reliable:
immutable published versions, resumable runs, idempotent side effects, tenant
isolation, and observable API and worker processes.

The backend is accompanied by the [React web application](./apps/web/README.md),
including authentication, workspace administration, workflow authoring and
execution surfaces. Start the mocked frontend with `pnpm dev:web`; integrated
authentication and data flows also require the API and its local dependencies.

For where things live and how the code is changing, start with the
[architecture reset plan](./docs/architecture-reset-plan.md).

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

The backend has implemented vertical slices, but unresolved API scope decisions
and Phase 7 production evidence still prevent a production-ready claim. See the
concise `current implementation status` for current blockers and
`implementation progress` for detailed evidence and history.

## Architecture

PostgreSQL is authoritative for workflows, runs, waits, and execution state.
Redis and BullMQ provide immediate transport and coordination but are treated as
rebuildable infrastructure. Queue messages carry identifiers rather than graphs,
credentials, or large payloads.

```text
apps/
  web/                 React/Vite product application
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
`docs/workflow-platform-backend-plan.md`.

## Stack

- TypeScript and pnpm workspaces
- React, Vite, TanStack Router/Query, Tailwind and shadcn/Base UI for the web
  foundation
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
docker compose up -d --wait postgres redis artifact-store artifact-store-recovery control-ledger-primary control-ledger-recovery
docker compose run --rm control-ledger-primary-bootstrap
docker compose run --rm control-ledger-recovery-bootstrap
set -a; . ./.env; set +a
pnpm build
pnpm db:migrate
```

The example environment is for local development only. Review `.env` before
starting processes; do not commit credentials or production configuration.
Compose reads `.env` itself, but the pnpm commands read only the shell
environment, so load `.env` (`set -a; . ./.env; set +a`) in every terminal that
runs one. Refresh a `.env` copied from an older `.env.example`: the artifact
recovery store now runs on its own port (`ARTIFACT_STORE_RECOVERY_*`), and the
worker needs `OUTBOX_DISPATCH_JOB_NAMES` to dispatch runs.

To use the app in a browser, start each process in its own terminal:

```bash
pnpm dev:api
pnpm dev:worker
pnpm dev:web
```

Open `http://127.0.0.1:5173` and create an account. Local authentication mail is
never sent: in development the API prints each verification or reset link to its
console. The example environment leaves connection encryption
(`CONNECTION_KMS_*`) unset, so the connections API is off and the workflow
editor offers no connections. The worker dispatches only the job kinds in
`OUTBOX_DISPATCH_JOB_NAMES`, which the example sets to run workflows started
manually.

Common commands:

Workspace packages resolve their compiled `dist` exports. After changing a
shared package, run `pnpm build` and restart the affected development process.
The API/worker source watchers do not replace the shared-package build step.
`pnpm dev:api` and `pnpm dev:worker` compile with TypeScript before watching the
emitted JavaScript, preserving the decorator metadata required by NestJS.

```bash
pnpm dev:api
pnpm dev:worker
pnpm dev:web
pnpm check
pnpm test
pnpm test:integration
pnpm test:e2e
```

`pnpm check` runs formatting, build, lint, typecheck, unused-code detection,
generated-contract drift, the schema check and package-boundary checks.
`pnpm test` runs the unit tests. `pnpm test:integration` needs the local
PostgreSQL, Redis and S3-compatible services above. `pnpm test:e2e` runs the
browser tests against the mocked API.

`pnpm install` configures the pre-push hook. Every push runs `pnpm prepush`:
formatting, typecheck, and lint and unit tests for the packages changed since
`origin/main`. CI runs everything on the pull request.

## Contributing, Security, and License

Development and review expectations are in
[`CONTRIBUTING.md`](./CONTRIBUTING.md). Report vulnerabilities privately as
described in [`SECURITY.md`](./SECURITY.md).

No open-source license is granted for this repository at present. Public
visibility does not grant permission to use, copy, modify, or redistribute the
code. Selecting an open-source license is intentionally deferred until the owner
makes that legal/product decision.

## Project Status

Pertexo is a personal engineering project in active development, not a hosted
commercial service. The [product roadmap](./docs/product-roadmap.md) lists what
is built and what is planned; the
[architecture reset plan](./docs/architecture-reset-plan.md) tracks the current
structural work.
