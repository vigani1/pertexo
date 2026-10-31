# Architecture

Pertexo is a pnpm monorepo with five applications and shared TypeScript
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
| `apps/cli`    | Personal-token HTTP workflow/run commands; no database or telemetry configuration                    |

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
`/outbox`, `/platform`, `/previews`, `/runs`, `/tenant-access`, `/triggers` and
`/variables`.
`/testing` supplies fixtures. Observability's `/startup` must load before the
instrumented runtime libraries. Artifact storage, execution, queue and rate
limiting are server-side packages despite having a single root door.

The model supplies the engine's data contracts; execution connects pure engine
decisions to database stores; the API and worker assemble those dependencies.
The database uses engine plan/checkpoint types and the built-in schedule config
schema from `nodes-core`, without running node executors. The webhook configuration
contract lives in `workflow-model` and is re-exported by its node definition. The catalog combines
SDK definitions and executors; browser code gets live catalog metadata from the
API and imports only browser-safe packages. `pnpm architecture:check` verifies
workspace dependencies, TypeScript references and source import cycles.

Workspace roles, capability grants and membership-role transitions live in the
browser-safe `workflow-model/src/workspaces/policy.ts`. Database and API
consumers share those rules; contracts derive role schemas and the web derives
its role matrix from them. API persistence ports import stored record types,
with `Pick`/`Partial` only for deliberately narrower projections and test fakes.
Notice audiences are selected by the TypeScript inbox reader before pagination.
The existing `app.clear_removed_member_notices` storage bridge remains an
exception: it checks workspace/removal state and clears actor-private rows in
the same removal transaction without broadening private-row visibility.

UTF-8 sizing and Unicode well-formedness use `workflow-model/src/values/text.ts`.
Its bounded JSON string measurement preserves escaping and stops on overflow.
The graph-independent SDK uses the platform Unicode primitive and retains its
bounded PostgreSQL-compatible string counter in `values/stored-json.ts`:
importing graph and expression code into the isolated Code runner would weaken
that package separation. Actual encoders for hashing and transport still
produce their byte buffers at their existing owners.

## Runtime lifecycle

The API and worker use `observability`'s shutdown coordinator: drain first,
then close resources in reverse registration order. Each app supplies its drain
state through its existing Nest adapter. Shared client database environment
parsing lives in the startup-safe entry point, separate from database drivers.
Feature telemetry uses `measureOperation`; a failed diagnostic sink or tracer
cannot replace, repeat or fail the business operation.

## HTTP problems

The API projects domain failures through `problems/registry.ts`'s
`toProblem(error)`. Each error class has one registration beside its application
area; the shared HTTP filter knows no feature URLs. Operation boundaries supply
explicit meaning where access loss must stay hidden or request/preview wording
differs. Register new domain failures in this owner; services and persistence
adapters propagate them without translating them into HTTP problems.

## Built-in node layout

`nodes-core/src/triggers/` owns start steps; `flow/` owns control steps;
`data/` owns Date, Set and Validate, with the seven list steps and their private
semantics under `data/lists/`. Each step retains its own definition, validation,
executor and index. Public index/server and definition/executor registrations
remain at the package root. Folder grouping does not change node identities,
versions or runtime behavior.

The web run feature keeps command/recovery intent under `model/commands/` and
run wording/status under `model/presentation/`. Existing list, timeline, loom
and step-inspection owners remain separate; live-update reconciliation stays
beside these owners. Public feature interfaces and rendered UI stay unchanged.

Database run recovery owns its contract, acceptance and reads under
`runs/recovery/`. Run events and published-workflow reads live in `runs/queries/`;
the initial checkpoint interface belongs to `runs/commands/`. The existing
repository and `/runs` public entry retain their interfaces, with no persistence
or execution change.

## Execution and persistence

PostgreSQL owns durable state. Redis/BullMQ transports identifiers and provides
live hints; losing transport state does not replace accepted database facts, and
every active run has a next step in PostgreSQL with a time on it. The stalled-work
scanner acts when that time passes, so a crash or lost job delays a run but never
strands it (ADR 007).
Published workflow versions contain their immutable graph, executable and
checksums. The engine selects the next transition from the executable,
checkpoint and facts. `execution/src/runs/advance.ts` verifies the stored
projection and calls the pure engine through the run store's decision callback.
`database/src/runs/advance/` locks and loads state, checks deliveries, persists
transitions and completes receipts in a transaction.

Finished For Each iteration scopes leave the checkpoint once every owner is
terminal. Compact loop frontiers and conserved iteration budgets support
restart; ordinary node/attempt outputs and events retain inspection history. The
[F08 plan](feature-plans/08-subworkflows.md) records the pruning evidence and
unchanged limits.

Callable workflows declare bounded JSON types and one result selector on their
graph. The immutable executable retains that declaration. Execution supplies
the acceptance validator and resolves the result once before success; the
database persists it with the ordinary terminal transition. Selecting a step
output requires exactly one successful invocation, including retained loop
scopes. The editor applies contract edits through its existing draft history.
The model owns the Call pin/config; the SDK adapter only prepares bounded JSON.
The engine records a Call wait and intent. Execution performs the durable Call
action before the parent advance transaction; the maintenance store reuses
ordinary child acceptance and atomically transfers the existing slot. Direct
child completion records a fact and parent hint without locking the parent.
Parents consume that fact through their existing checkpoint CAS. One typed Call
relation owns spawn identity, input/result lifetime and the direct slot return;
publication dependencies retain immutable target versions. Parallel Calls lend
one slot in stable invocation order, and nested Calls pass the same slot down
and return it one direct level at a time. Parent close uses direct cancellation
intents consumed under each child’s own lock. There is no recursive executor or
separate family ledger.

Manual acceptance, cancellation and replay persist through
`database/src/runs/commands/`. HTTP owns actor authorization. Accepted commands
share workspace idempotency records; manual starts serialize a key with one
transaction advisory lock. Attempts persist through `/attempts`; execution
projects their inputs and the worker runs the pinned executor. The database and
worker retain durable retries, waits, deadlines, cancellation and
unknown-outcome reconciliation, including reusable subworkflows under ADR 070.

Outbox rows and delivery receipts bind durable work to an exact payload
checksum. Dispatch claims work fairly under the maintenance role and publishes
jobs. Consumers validate delivery identity before effects or receipt recovery.
Completion and checkpoint writes use existing transactional/CAS checks. Live run
and inbox SSE events are hints; clients refetch authoritative reads after
reconnect or missed events.

Whole-draft tests use the ordinary engine, workers, checkpoints, events and
capacity counters with trigger type `test`. An immutable `workflow_test_snapshots`
row owns their saved graph, executable and pins; its execution identity never
enters publication queries. The coordinator reads pin identities and the worker
reads only its step’s frozen sample. Terminal producers suppress operational
notifications and trigger outcomes for tests. Authoring owns admission and the
editor owns test history; lifecycle retention expires their data after seven days.

## Database boundaries

Storage may import `@pertexo/contracts` types for read models; it never loads
runtime HTTP schemas or limits. ESLint enforces that boundary. Shared workspace
identity, governance and authoring rules live in `workflow-model`; contracts
re-export them and derive transport schemas. The unchanged template provenance
format also lives in the model; storage retains its bounded-format check and
imports only template types. ESLint permits only the schedule schema as a
runtime import from `nodes-core`. Stored command receipts and query
records are typed at their reads. The API prepares webhook run input and verifies
curated template manifests before calling storage; acceptance still locks and
rechecks the exact endpoint/version or draft binding in its transaction.

All application tables are declared once under `packages/database/src/schema/`. Typed
Drizzle reads/writes and typed `sql` statements share those definitions. Runtime
code contains application rules; PostgreSQL retains constraints, forced
workspace row security, transactions, queue claims, atomic capacity counters and
checkpoint revision checks. Claims spanning workspaces, integration/session
guards over multiple writers and locks on rows the app may not update also
remain in SQL. The retained run-admission guards include
`app.require_workflow_skip_protocol`: every run writer must participate in the
workflow concurrency Skip protocol before inserting a run under a bounded Skip
policy. TypeScript decides admission and configures the transaction protocol;
the trigger prevents another writer from bypassing that protocol. This stays
beside the atomic capacity counters and admission locks.

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


Error workflows are an F09 follow-up. Operational Settings select a same-workspace
published target with **When a workflow fails**. The terminal transaction writes
one source-run intent and outbox delivery; the existing maintenance consumer
admits the captured version through ordinary run admission. Only a strict safe
summary crosses that interface. Error-origin flags propagate through Calls,
replays and recovery to prevent notification loops. Settings belong to authoring,
intent production/admission to database `/runs`, and delivery to the worker’s
existing maintenance runtime. See [the guide](guides/error-workflows.md).
