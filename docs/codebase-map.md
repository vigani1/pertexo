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
| Worker | [Composition](../apps/worker/src/worker.module.ts), [bootstrap](../apps/worker/src/main.ts), [provider credential capability](../apps/worker/src/execution/provider-connection-runtime.ts) | `transport/` receives jobs and dispatches outbox work; `execution/` coordinates attempts and capabilities, with provider credential resolution/fencing isolated from artifact ownership; `triggers/` scans/reconciles triggers; `runtime/` owns process health and shutdown. No product HTTP server. |
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
`pnpm check` adds formatting, documented invariants, dependency checks,
typechecks, contract generation drift, built-package self-reference/browser
export checks and unit tests. Complexity and duplication checks are ratchets:
an existing long function is not automatically permission to grow it.

`pnpm test:coverage` keeps workspace coverage floors and the selected critical
branch review inventory. `pnpm test:integration` exercises real local services;
it is required for changes that affect persistence, transport, object storage,
HTTP or process behavior. A passing unit gate is not deployed AWS evidence.
`pnpm quality:local` owns disposable services, serializes fixed coverage output,
runs the repeated local performance cohort, and emits a source-stable manifest
for the complete applicable local matrix.
The [Q9 plan](./backend-code-quality-9-plan.md) is the frozen specification for
the completed repository-local code-quality checkpoint, while its
[implementation record](./backend-code-quality-9-implementation.md) owns the
qualified candidate identity, occurrence dispositions and verification.
The earlier [next-stage implementation
record](./backend-quality-next-stage-plan.md#implementation-record--maintain-during-execution)
and other Q/N records remain remediation history, not the current evidence
entrypoint.

Infrastructure tooling stays under `infrastructure/`, with existing explicit
subdirectories for ECS, PostgreSQL, observability and exercises. Historical
audits and ADRs remain under `docs/`; use current implementation progress for
mutable delivery status rather than rewriting historical conclusions.

## Behavior-to-owner routes

These routes name the first production entrypoint and the owners of policy,
durable truth and acquired resources. The linked test is the shortest composed
behavioral route; owner-local unit suites remain useful but do not replace it.

| Journey | Entrypoint | Policy owner | Persistence owner | Resource owner | Owning behavioral test |
| --- | --- | --- | --- | --- | --- |
| Manual run and run replay | [`WorkflowRunsController`](../apps/api/src/workflow-runs/controllers.ts) | API [run use cases and authorization](../apps/api/src/workflow-runs/use-cases.ts); replay identity stays in the [database transaction](../packages/database/src/execution/workflow-run-replay.ts) | [Workflow-run API](../packages/database/src/execution/workflow-run-api.ts) and [execution acceptance](../packages/database/src/execution/execution-acceptance.ts) | [API workflow-runtime composition](../apps/api/src/platform/workflow/workflow-runtime.module.ts) owns its pool/queue adapters; the database transaction owns locks | [Workflow-run API integration](../packages/database/test/workflow-run-api.integration.test.ts) |
| Webhook admission | [`registerWebhookIngress`](../apps/api/src/webhooks/ingress.ts) | Ingress security order and API rate-limit policy; trigger interpretation in the [webhook service](../apps/api/src/webhooks/service.ts) | [Webhook trigger store](../packages/database/src/triggers/webhook-triggers.ts) and execution acceptance | API bootstrap owns the HTTP body stream and rate limiter; persistence owns its transaction | [Direct webhook integration](../apps/api/test/webhooks/direct-webhook.integration.test.ts) |
| Scheduled start | [Worker trigger runtime](../apps/worker/src/triggers/trigger-runtime.ts) | [Schedule recurrence](../packages/database/src/triggers/schedule-recurrence.ts) and trigger scanner | [Schedule trigger scanner/database](../packages/database/src/triggers/schedule-trigger-scanner.ts) and execution acceptance | Worker runtime owns scanner timers and database/queue clients | [Schedule trigger integration](../apps/worker/test/schedule-trigger.integration.test.ts) |
| Provider execution, retry and cancellation | [Node-attempt handler](../apps/worker/src/execution/node-attempt-handler.ts) | Registered provider executor, shared [persisted projection verifier](../apps/worker/src/execution/persisted-workflow-projection.ts), and [dispatch fence](../packages/integrations/src/provider-dispatch-fence.ts); [`engine.retry@1`](../packages/workflow-engine/src/retries.ts) owns retry eligibility | [Node-attempt run store](../packages/database/src/execution/node-attempt-run-store.ts) and [coordinator run store](../packages/database/src/execution/coordinator-run-store.ts) | [Node-attempt runtime](../apps/worker/src/execution/node-attempt-runtime.ts) owns consumer and cleanup; [execution capability contracts](../apps/worker/src/execution/node-execution-capabilities.ts) are neutral between production and preview | [HTTP node-attempt integration](../apps/worker/test/http-node-attempt.integration.test.ts) |
| Run-event streaming | [`WorkflowRunsController.streamRunEvents`](../apps/api/src/workflow-runs/controllers.ts) | [SSE authorization lifetime](../apps/api/src/workflow-runs/sse-authorization-lifetime.ts) and streamer backpressure/reconciliation | [PostgreSQL run-event reader](../apps/api/src/executions/postgres-run-event-reader.ts) over [run events](../packages/database/src/execution/run-events.ts) | API request owns its abort signal; event streamer owns subscription and polling cleanup | [Run-event stream integration](../apps/api/test/executions/run-event-stream.integration.test.ts) and [resilience integration](../apps/api/test/executions/run-event-stream.resilience.integration.test.ts) |
| Failure notification | [Failure-notification handler](../apps/worker/src/execution/failure-notification-handler.ts) | [ADR 022](./adr/022-run-failure-notification.md), immutable notification context and registered destination executor | Terminal commit creates the intent in [coordinator terminal persistence](../packages/database/src/execution/coordinator-run-store-terminal.ts); [completion store](../packages/database/src/execution/failure-notification-completion-store.ts) fences delivery | Worker transport owns the consumer; handler owns timeout/abort; destination store owns secret lease/fence lifetime | [Coordinator consumer notification integration](../apps/worker/test/coordinator-consumer-failure-notification.integration.test.ts) |
| Artifact transfer | [`ArtifactController`](../apps/api/src/artifacts/controllers.ts) | API artifact service enforces media, authorization and bounded transfer policy | [Artifact upload persistence](../packages/database/src/execution/artifact-upload.ts) owns metadata/intent truth | [Artifact-store adapter](../packages/artifact-store/src/store.ts) owns object streams and clients; request abort owns transfer cancellation | [Artifact transfer integration](../apps/api/test/artifacts/transfer.integration.test.ts) |
| Retention and workspace purge | [Retention runner](../apps/retention/src/run.ts) | Database [retention](../packages/database/src/lifecycle/retention.ts) and [workspace-purge](../packages/database/src/lifecycle/workspace-purge.ts) coordinators | Those coordinators own transaction, advisory-lock and durable cursor/job state | Retention composition owns pools/object-store clients; runner owns loop abort and close ordering | [Retention transaction integration](../packages/database/test/retention-transaction-cancellation.integration.test.ts) and [workspace purge integration](../packages/database/test/workspace-purge-foundation.integration.test.ts) |
| Restore-before-serve and durable recovery | [`restoreBeforeServe`](../apps/recovery/src/restore-before-serve.ts) | [Control-ledger coordinator](../packages/database/src/lifecycle/control-ledger-coordinator.ts) and recovery runbook | PostgreSQL control state plus the artifact-store [control ledger](../packages/artifact-store/src/control-ledger.ts) | Recovery composition owns pool, dual-region ledger clients and their cleanup | [Restore-before-serve process test](../apps/recovery/test/restore-before-serve.test.ts) and [control-ledger integration](../packages/artifact-store/test/control-ledger.integration.test.ts) |

Workflow lifecycle, workspace lifecycle, activation, workflow restoration,
version restoration and run replay are deliberately distinct terms. They
represent different authorization, identity and persistence contracts; stable
wire, database and versioned identifiers retain those names.

Authenticated request objects are transport types. The canonical shared
session/workspace fields belong to
[`IdentityWorkspaceRequest`](../apps/api/src/identity-workspace/types.ts).
The common successful actor, guard context and request/trace projection belongs
to the
[`authenticated-command-context`](../apps/api/src/identity-workspace/authenticated-command-context.ts);
feature error mapping, traceparent parsing, SSE lifetime and socket behavior stay
with their controllers.
Feature request types select those fields and add only feature-specific HTTP
extensions such as raw close notification or reauthorization. Application
[`Input` ports](../apps/api/src/workflow-runs/ports.ts) contain already-derived
values and must not acquire headers, sockets or framework request fields.

The generic filenames `module.ts`, `types.ts` and `use-cases.ts` remain
intentional inside feature directories: their directory supplies the bounded
context and Nest discovers the module as the composition entrypoint. The
`create*Runtime` factory names also remain intentional because they construct
and transfer ownership of live resources rather than describe domain services.
No misleading owner name was found in the mapped routes, so N01 makes no
symbol rename.

## Q9 change navigation

| Rule to change | Production owner | Focused proof |
| --- | --- | --- |
| Persisted node-attempt input assembly and structured collection proof | [`node-attempt-run-store-inputs.ts`](../packages/database/src/execution/node-attempt-run-store-inputs.ts) | Database node-attempt/For Each integration suites and [`q9-bounded-work.test.ts`](../packages/database/test/q9-bounded-work.test.ts) |
| Persisted checkpoint relationship validation | [Checkpoint codec](../packages/database/src/compatibility/persisted-workflow-checkpoint.ts) and its [named refinement families](../packages/database/src/compatibility/persisted-workflow-checkpoint-refinements.ts) | [`persisted-workflow-checkpoint.test.ts`](../packages/database/test/persisted-workflow-checkpoint.test.ts) and workflow-engine checkpoint seams |
| Worker persisted-executable release verification | [`verifyPersistedWorkflowProjection`](../apps/worker/src/execution/persisted-workflow-projection.ts) | Coordinator and node-attempt engine suites |
| API authenticated command projection | [`projectAuthenticatedWorkspaceContext`](../apps/api/src/identity-workspace/authenticated-command-context.ts) | The six owning controller suites; SSE transport remains separate |
| Nested graph enumeration for disposable identity reports | [`workflowNodes`](../packages/workflow-model/src/graph/identity.ts) | Workflow-model graph and graph-contract suites |
| Integration-linked risk evidence | [`report-risk-coverage.mjs`](../infrastructure/report-risk-coverage.mjs) and [`run-local-quality.mjs`](../infrastructure/run-local-quality.mjs) | Their Node test suites plus a full run's worker integration report |
| Local benchmark evidence contract | [`validateBenchmarkEvidence`](../infrastructure/performance/compare-local-benchmark.mjs) | Producer/comparator tests and the full runner's emitted artifact |
