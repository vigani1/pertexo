# Codebase map

Start here when deciding where a change belongs. The
[backend plan](./workflow-platform-backend-plan.md) and accepted ADRs remain
authoritative; this map describes the current implementation, not a new layer
to build. The [structure audit](./repository-structure-audit.md) records the
review and verification behind the latest cleanup.

## Applications: process ownership

| Application | Start reading | Responsibility and internal organization |
| --- | --- | --- |
| API | [Composition](../apps/api/src/app.module.ts), [bootstrap](../apps/api/src/main.ts) | Product HTTP. Feature directories own their controllers, use cases, authorization and adapters; `platform/` owns shared HTTP/config/runtime wiring. `identity/`, `identity-infrastructure/`, and `identity-workspace/` distinguish identity policy, external adapters and authenticated workspace capabilities. |
| Worker | [Composition](../apps/worker/src/worker.module.ts), [bootstrap](../apps/worker/src/main.ts) | `transport/` receives jobs and dispatches outbox work; `execution/` coordinates attempts and capabilities; `triggers/` scans/reconciles triggers; `runtime/` owns process health and shutdown. No product HTTP server. |
| Lifecycle command | [Command runner](../apps/lifecycle-command/src/run.ts) | Narrow process for workspace lifecycle commands. Configuration, execution, readiness marker and executable entrypoint remain separate files. |
| Operator command | [Command runner](../apps/operator-command/src/run.ts) | Explicit operator command dispatch and its distinct database credentials. Keep this authority out of API/worker processes. |
| Recovery | [Restore-before-serve](../apps/recovery/src/restore-before-serve.ts) | Reconcile restored control state before serving traffic. The small config/main/orchestration layout is intentional. |
| Retention | [Runner](../apps/retention/src/run.ts), [loops](../apps/retention/src/maintenance-loops.ts) | Bounded maintenance loops, process metrics and shutdown. Persistence policy remains in the database package. |

API features currently live directly beneath `src/` rather than under an extra
`modules/` wrapper. Their capability ownership follows the plan; adding a
wrapper alone would change navigation/import paths without separating a new
responsibility. Do not introduce global controllers/services/repositories
folders. The maintenance apps similarly do not need empty layered directories.

## Packages: shared responsibility

Use workspace package exports, never a relative path into another package's
`src` or `dist`. Each manifest lists the supported import paths.

| Package | Source owners | What belongs here |
| --- | --- | --- |
| artifact-store | [Object adapter](../packages/artifact-store/src/store.ts), [ledger adapter](../packages/artifact-store/src/control-ledger.ts), [bucket policy](../packages/artifact-store/src/control-ledger/bucket-policy.ts) | Bounded object IO, integrity, dual-region adapters and storage protection checks. No database or tenant command orchestration. |
| contracts | [Public exports](../packages/contracts/src/index.ts), [HTTP contracts](../packages/contracts/src/http), [errors](../packages/contracts/src/errors) | Versioned public wire schemas and generated OpenAPI/client artifacts. Not canonical domain states or database rows. |
| database | [API surface](../packages/database/src/api.ts), [execution surface](../packages/database/src/execution.ts), [source domains](../packages/database/src) | Persistence and tenant transactions grouped into authoring, execution, triggers, connections, lifecycle, operator, compatibility and tenant access. `schema/` owns typed tables; `migrations/` remains the forward-only SQL history. Separate lifecycle/maintenance/operator/recovery exports enforce process authority. |
| integrations | [Manifests](../packages/integrations/src/index.ts), [server composition](../packages/integrations/src/server.ts) | HTTP, Slack, email and webhook adapters. `http/` owns secure transport and the shared bounded Retry-After parser; provider-specific limits remain with each provider. Credentials and crypto have explicit owners. |
| node-catalog | [Release ledger](../packages/node-catalog/src/registry.ts), [server composition](../packages/node-catalog/src/server.ts) | Compose concrete core/provider registrations and select supported release cohorts. Named historical releases are compatibility evidence, not duplication to compress away. |
| node-sdk | [Release contracts](../packages/node-sdk/src/release.ts), [schema documents](../packages/node-sdk/src/definitions/schema-document.ts), [registry](../packages/node-sdk/src/server.ts) | Portable manifests, compatibility, bounded schema projection and executor contracts. Runtime errors and JSON admission have named files. No engine/database/provider implementations. |
| nodes-core | [Definitions](../packages/nodes-core/src/index.ts), [executors](../packages/nodes-core/src/server.ts) | Each node family owns its definition, executor and validation where needed. Keep the existing per-family folders; do not invent a universal node base class. |
| observability | [Config](../packages/observability/src/config.ts), [logger](../packages/observability/src/logger.ts), [telemetry](../packages/observability/src/telemetry.ts) | Safe logging, tracing, transport/maintenance metrics and runtime adapters. Files already name distinct concerns; no extra directory is needed for every small module. |
| queue | [Contracts](../packages/queue/src/contracts.ts), [names](../packages/queue/src/names.ts), [admission](../packages/queue/src/delivery-admission.ts), [consumer](../packages/queue/src/consumer.ts) | Identifier-only job envelopes, transport admission, producers and bounded consumer lifecycle. PostgreSQL remains authoritative for execution decisions. |
| rate-limit | [Policy](../packages/rate-limit/src/policy.ts), [limiter](../packages/rate-limit/src/distributed-rate-limiter.ts), [Redis runtime](../packages/rate-limit/src/redis-runtime.ts) | Endpoint/dimension policy, distributed admission and Redis lifecycle. Keep these three cohesive owners instead of a generic constants/service hierarchy. |
| workflow-engine | [Public exports](../packages/workflow-engine/src/index.ts), [operations](../packages/workflow-engine/src/operations.ts), [executable identity](../packages/workflow-engine/src/executable-identity.ts), [graph rules](../packages/workflow-engine/src/executable-graph-rules.ts) | Deterministic compilation, checkpoint parsing, scheduling and transitions. Named checkpoint/transition/executable files preserve protocol ownership. No persistence, transport or Nest imports. |
| workflow-model | [Graph facade](../packages/workflow-model/src/graph.ts), [graph owners](../packages/workflow-model/src/graph), [expression owners](../packages/workflow-model/src/expressions), [browser graph contract](../packages/workflow-model/src/graph-contract.ts) | Authoring graph validation/identity, canonical JSON, mappings and restricted expressions. Browser schemas stay separate from server-only compilation/evaluation; public facades preserve callers while internal responsibilities are separated. |

## Placement rules

1. Put a helper beside the capability that owns its meaning. Extract shared
   behavior only when real callers share the same semantics.
2. Give independently meaningful policy a name: `names.ts`, `tokens.ts`,
   `policy.ts`, `retry-after.ts`, or `validation-contract.ts`. Keep obvious
   local constants local; there is no global constants or utils bucket.
3. Keep validation, transformation and orchestration distinct when they change
   for different reasons. Keep critical transaction/lease/cleanup ordering
   visible together instead of distributing it across tiny wrappers.
4. Preserve supported package exports. Private extractions are not automatically
   new public interfaces. Tests can exercise a pure internal policy, but the
   public behavior/contract tests remain the compatibility gate.
5. Place tests in the owning workspace's `test/`. Use its existing fixture
   owners and integration configuration; do not copy complete environments into
   every test or replace typed dependencies with broad casts.

## Build and verification

`pnpm build` uses TypeScript project references, which mirror runtime workspace
dependencies. `pnpm architecture:check` checks that graph and rejects local
static runtime import cycles and cross-workspace relative source traversal.
`pnpm check` adds
formatting, documented invariants, dependency checks, typechecks, contract
generation drift and unit tests. Complexity and duplication checks are
ratchets: an existing long function is not automatically permission to grow it.

`pnpm test:coverage` keeps workspace coverage floors and the selected critical
branch review inventory. `pnpm test:integration` exercises real local services;
it is required for changes that affect persistence, transport, object storage,
HTTP or process behavior. A passing unit gate is not deployed AWS evidence.

Infrastructure tooling stays under `infrastructure/`, with existing explicit
subdirectories for ECS, PostgreSQL, observability and exercises. Historical
audits and ADRs remain under `docs/`; use current implementation progress for
mutable delivery status rather than rewriting historical conclusions.
