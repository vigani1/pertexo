# Architecture

Pertexo has six applications and shared TypeScript packages. Single-server
self-hosting with Docker Compose is the only supported deployment. PostgreSQL
holds durable facts; Redis/BullMQ carries identifiers and wakeups.

Read the [glossary](../CONTEXT.md#core-terms), [docs index](README.md) and
[active decisions](adr/README.md). ADR 069 records the completed architecture
reset; ADR 091 overrides its core-layer and entry-point rules.

## Where things live

| Application        | Responsibility                                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------------- |
| `apps/api`         | NestJS/Fastify HTTP routes, Better Auth sessions, authorization, request parsing, commands and reads |
| `apps/worker`      | Run advancement, node attempts, previews, provider dispatch, triggers and maintenance loops          |
| `apps/web`         | React/Vite product UI, TanStack Router/Query, scoped Zustand editor state and React Flow rendering   |
| `apps/ops`         | Audited operator commands using the maintenance database role                                        |
| `apps/code-runner` | Isolated JavaScript/Python execution in single-use processes                                         |
| `apps/cli`         | Personal-token HTTP workflow/run commands; no database or telemetry configuration                    |

| Package           | Responsibility                                                                                                       |
| ----------------- | -------------------------------------------------------------------------------------------------------------------- |
| `workflow-model`  | Graph and JSON contracts, portable authoring, expressions and validation                                             |
| `workflow-engine` | Pure execution decisions and the checkpoint shape                                                                    |
| `core`            | Whole product areas, each with its flows, queries and decisions; its `execution` area advances runs                  |
| `database`        | Drizzle tables, migrations, transactions, row security, and the shared outbox, audit and idempotency helpers         |
| `secrets`         | Cryptography, key custody and verification, safe outbound HTTP, and durable system mail, below `core`                |
| `contracts`       | Zod HTTP request/response/problem schemas and server-side OpenAPI generation                                         |
| `node-sdk`        | Node definitions, config/port contracts and executor interfaces                                                      |
| `nodes-core`      | Built-in deterministic and control nodes                                                                             |
| `integrations`    | Provider protocol clients and HTTP, Slack and email step execution; apps inject security and network implementations |
| `node-catalog`    | The registry combining built-in and provider nodes                                                                   |
| `templates`       | Curated workflow content and origin identities                                                                       |
| `queue`           | Redis/BullMQ job transport and pub/sub hints                                                                         |
| `artifact-store`  | One object-storage region, bounded streams and verified uploads                                                      |
| `observability`   | Structured logging, OpenTelemetry startup, traces and metrics                                                        |
| `rate-limit`      | Abuse policies and atomic Redis counters                                                                             |

| Package  | Responsibility                                           |
| -------- | -------------------------------------------------------- |
| `policy` | Workspace roles, capabilities and workspace status lists |

## Dependency and authority boundaries

Applications call core product areas. Core depends on secrets, database,
workflow-engine, workflow-model and policy. Secrets owns cryptography, key
custody, safe outbound HTTP and system mail. The engine makes pure decisions; it
does not query storage or execute effects. Database stores facts and enforces
constraints, workspace isolation, transactions, queue claims, capacity counters
and checkpoint version checks. Product rules live in TypeScript.

Core exposes `@pertexo/core/<area>` and `/testing`, with no root or `/server`.
Areas import another area's implementation files directly, as named by its
index, rather than creating barrel edges. Database exposes `/schema` and
`/primitives` to core/secrets, `/platform` for application pools/startup and
`/testing` for fixtures. Applications cannot import database storage internals.
Other packages use browser-safe roots and Node-only `/server` where applicable;
observability's `/startup` loads before the libraries it instruments.

A workspace flow opens its transaction through `withWorkspaceAccess` in
`core/src/shared/workspace-access.ts`. It declares its capability, status list
and access mode once. Authority is checked inside that transaction, which hands
the flow the role it found. API code owns HTTP parsing and safe problem
projection; it does not own a second durable authorization policy.

## Author and publish

The web editor keeps unsaved graph changes in a route-scoped Zustand store.
TanStack Query owns remote snapshots. The API validates the request boundary;
core authoring checks workspace authority, draft revision and graph semantics.
Publishing saves an immutable version with graph, executable and checksums.
Connections and Call targets are explicitly bound; a later draft cannot change
the definition of a running workflow. Saved draft tests use immutable test
snapshots rather than publication versions.

## Accept and execute a run

Manual requests and triggers enter core run admission. Acceptance records the
pinned definition, initial checkpoint, capacity and durable outbox work in a
transaction. The worker dispatches identifiers through Redis/BullMQ. Consumers
check delivery identity against durable receipts before advancing or effects.

Core execution loads state and asks the pure engine for the next transition. Run
persistence locks state and saves transitions with checkpoint version checks.
Attempts execute pinned step implementations; Code goes to the isolated runner.
Durable waits and retries survive restarts. The stalled-work scanner uses
PostgreSQL's next-work time to recover missed transport wakeups. An effect whose
outcome is unknown is never blindly retried. SSE is a hint: reconnecting clients
refetch authoritative reads.

Call steps pin child versions and use durable parent/child facts and slot
lending, not recursive execution. Human input resumes a stored wait. Error
workflows receive a safe failure summary through normal run admission;
propagated error-origin flags prevent notification loops. See
[error workflows](guides/error-workflows.md).

## Back up and restore

The single-server backup command holds the operation lock and captures an online
PostgreSQL dump while immutable artifact capture runs. Serving writers remain
available; physical deletion is paused so referenced bytes remain recoverable.
Shared immutable objects are copied incrementally. Rclone encrypts recovery
points off server; a COMPLETE marker follows checksums and successful capture.
Restore uses a completed point, verifies keys and bytes, and checks the restored
stack. The [runbook](operations/single-server.md) owns commands and drill steps.
Scratch files are disposable and excluded from backups.

## Database roles and migration history

| Role          | Use                                                               |
| ------------- | ----------------------------------------------------------------- |
| `owner`       | Schema and migrations                                             |
| `app`         | API/worker transactions with row security                         |
| `maintenance` | Cross-workspace dispatch, retention, lifecycle and ops; BYPASSRLS |

`DATABASE_URL` uses app; `DATABASE_MAINTENANCE_URL` uses maintenance. Workspace
transactions set tenant context. Organization settings, SSO/SAML completion and
SCIM use the app login with verified transaction-local organization context,
with workspace projection scopes and core authority checks intact. Better Auth
has its own adapter pool using the app role.

Tables are declared once in `packages/database/src/schema/`. The baseline,
`0000_baseline.sql`, includes generated tables and retained SQL for grants,
policies, functions, triggers and admission/storage guards. The migration runner
adopts only the verified complete pre-baseline history; partial histories must
upgrade through v0.2.0 first. Unknown checksums are refused. Later migrations
are incremental; every file currently runs in a transaction. The committed
`packages/database/schema.sql` records the catalog. See
[upgrading](operations/upgrading.md) and the
[data dictionary](operations/data-dictionary.md).

## Development and verification

[README](../README.md) describes local setup. Shared package exports resolve
compiled `dist` files, so rebuild them before restarting consumers. `pnpm check`
runs formatting, build, lint, typecheck, dependency, contract, schema,
architecture and naming checks. Unit tests use `pnpm test`; service/database
suites use `pnpm test:integration`, and controlled browser journeys use
`pnpm test:e2e`. Tests use isolated databases, ports and browser contexts.

[Web architecture](../apps/web/ARCHITECTURE.md) covers browser state and UI
rules. [Feature plans](feature-plans/README.md) retain scope and delivery
evidence; [architecture reset history](architecture-reset-plan.md) is completed
history, not a tracker or current architecture map.
