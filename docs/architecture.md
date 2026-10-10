# Architecture

Pertexo is a pnpm monorepo with four applications and shared TypeScript
packages. [ADR 069](adr/069-architecture-reset.md) records the reset decisions;
[CONTEXT.md](../CONTEXT.md) defines the product vocabulary. Historical ADRs
remain in `docs/adr/`, with supersession noted where their decisions changed.

## Where things live

| Application   | Responsibility                                                                                       |
| ------------- | ---------------------------------------------------------------------------------------------------- |
| `apps/api`    | NestJS/Fastify HTTP routes, Better Auth sessions, authorization, request parsing, commands and reads |
| `apps/worker` | Run advancement, node attempts, previews, provider dispatch, triggers and maintenance loops          |
| `apps/web`    | React/Vite product UI, TanStack Router/Query, scoped Zustand editor state and React Flow rendering   |
| `apps/ops`    | Audited operator commands using the maintenance database role                                        |

| Package           | Responsibility                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| `workflow-model`  | Graph and JSON contracts, portable authoring, expressions and validation                                           |
| `workflow-engine` | Pure execution decisions and the checkpoint shape                                                                  |
| `execution`       | Run advancement orchestration, initial checkpoints, persisted projection verification and attempt input projection |
| `database`        | Drizzle tables, migrations, transactions, repositories, reads, command persistence, admission and outbox           |
| `contracts`       | Zod HTTP request/response/problem schemas and server-side OpenAPI generation                                       |
| `node-sdk`        | Node definitions, config/port contracts and executor interfaces                                                    |
| `nodes-core`      | Built-in deterministic and control nodes                                                                           |
| `integrations`    | HTTP, Slack and email nodes, credential boundaries and safe outbound HTTP                                          |
| `node-catalog`    | The registry combining built-in and provider nodes                                                                 |
| `templates`       | Curated workflow content and origin identities                                                                     |
| `queue`           | Redis/BullMQ job transport and pub/sub hints                                                                       |
| `artifact-store`  | One object-storage region, bounded streams and verified uploads                                                    |
| `observability`   | Structured logging, OpenTelemetry startup, traces and metrics                                                      |
| `rate-limit`      | Abuse policies and atomic Redis counters                                                                           |

Packages expose a browser-safe root and, when needed, `/server`. The database
exposes area doors because its consumers need distinct storage capabilities:
`/attempts`, `/authoring`, `/connections`, `/lifecycle`, `/notifications`,
`/outbox`, `/platform`, `/previews`, `/runs`, `/tenant-access` and `/triggers`.
`/testing` supplies fixtures. Observability's `/startup` must load before the
instrumented runtime libraries. Artifact storage, execution, queue and rate
limiting are server-side packages despite having a single root door.

The model supplies the engine's data contracts; execution connects pure engine
decisions to database stores; the API and worker assemble those dependencies.
The database uses engine plan/checkpoint types and the built-in schedule config
schema from `nodes-core`, without running node executors. The catalog combines
SDK definitions and executors; browser code gets live catalog metadata from the
API and imports only browser-safe packages. `pnpm architecture:check` verifies
workspace dependencies, TypeScript references and source import cycles.

## Execution and persistence

PostgreSQL owns durable state. Redis/BullMQ transports identifiers and provides
live hints; losing transport state does not replace accepted database facts.
Published workflow versions contain their immutable graph, executable and
checksums. The engine selects the next transition from the executable,
checkpoint and facts. `execution/src/runs/advance-run.ts` verifies the stored
projection and calls the pure engine through the run store's decision callback.
`database/src/runs/advance/` locks and loads state, checks deliveries, persists
transitions and completes receipts in a transaction.

Manual acceptance, cancellation and replay persist through
`database/src/runs/commands/`. HTTP owns actor authorization. Accepted commands
share workspace idempotency records; manual starts serialize a key with one
transaction advisory lock. Attempts persist through `/attempts`; execution
projects their inputs and the worker runs the pinned executor. The database and
worker retain durable retries, waits, deadlines, cancellation and
unknown-outcome reconciliation. Subworkflows are pending the separate F08 plan.

Outbox rows and delivery receipts bind durable work to an exact payload
checksum. Dispatch claims work fairly under the maintenance role and publishes
jobs. Consumers validate delivery identity before effects or receipt recovery.
Completion and checkpoint writes use existing transactional/CAS checks. Live run
and inbox SSE events are hints; clients refetch authoritative reads after
reconnect or missed events.

## Database boundaries

All 80 tables are declared once under `packages/database/src/schema/`. Typed
Drizzle reads/writes and typed `sql` statements share those definitions. Runtime
code contains application rules; PostgreSQL retains constraints, forced
workspace row security, transactions, queue claims, atomic capacity counters and
checkpoint revision checks. Claims spanning workspaces, integration/session
guards over multiple writers and locks on rows the app may not update also
remain in SQL.

| Role          | Use                                                              |
| ------------- | ---------------------------------------------------------------- |
| `owner`       | Schema and migrations                                            |
| `app`         | API and worker workspace transactions with forced row security   |
| `maintenance` | Cross-workspace dispatch, retention, lifecycle and operator work |

`DATABASE_URL` is the app connection and `DATABASE_MAINTENANCE_URL` the
maintenance connection. Workspace transactions set their tenant context; API
authorization is separate from database isolation. Better Auth uses its
dedicated adapter pool within the app role. Pool telemetry includes the existing
eight metrics and queries `pg_stat_activity` for its owned backend PIDs;
attachment and cleanup remain shared for pools with more than one owner.

`pnpm db:generate` runs drizzle-kit against the schema. Tracked snapshots allow
future incremental generation. `0000_baseline.sql` contains generated tables,
keys, checks, indexes and sequences, plus retained SQL for role grants, row
policies, functions/triggers, five deferred foreign keys and two covering
indexes. The custom `textC` type emits the required column collations. Changes
to those SQL exceptions require editing their SQL explicitly as well as the
relevant schema declaration. `pnpm database:schema:check` checks typed table
ownership.

`pnpm db:migrate` applies the migration files and checks their recorded history.
Databases from the former reset history must be recreated; the runner refuses to
reinterpret old checksums. The baseline seeds the singleton outbox dispatch
cursor required by fair claiming.

## Application organization

The API groups authentication/account security, authorization, workspace/access,
authoring, runs, connections, artifacts, inbox and usage by feature. The worker
groups run/attempt handlers, providers, triggers, identity, connections,
notifications, workflows, outbox, health and shutdown. Shared polling/scanner
runtimes own loop lifecycle. The ops CLI has no public HTTP listener.

The web keeps transport, routes, feature state and reusable UI separate. Query
owns server snapshots; route-scoped Zustand owns unsaved graph edits; React owns
local interactions. The API authorizes and validates publication/execution.
[Web architecture](../apps/web/ARCHITECTURE.md) covers state ownership, saving,
recovery, forms, Weft and browser verification.

## Development and verification

`pnpm dev` starts local PostgreSQL, Redis and one object store, builds shared
packages, migrates, seeds a development account, then runs API, worker and web.
[README](../README.md) covers setup. Shared package exports resolve compiled
`dist` files, so rebuild them after changes before restarting consumers.

`pnpm check` covers formatting, build, lint, typecheck, dependency ownership,
contract generation, schema inventory and architecture. Unit tests run with
`pnpm test`; service/database suites use `pnpm test:integration`, and mocked
browser journeys use `pnpm test:e2e`. Integration fixtures own isolated
databases and service namespaces. CI also runs the existing owned application
fixtures, images and security checks. The pre-push hook runs without bypass.
