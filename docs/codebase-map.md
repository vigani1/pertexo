# Codebase map

Start here when deciding where a change belongs. The
[backend plan](./workflow-platform-backend-plan.md) and accepted ADRs remain
authoritative; this map describes the current implementation and its ownership
seams.

## Applications: process ownership

| Application | Start reading | Responsibility |
| --- | --- | --- |
| API | [`app.module.ts`](../apps/api/src/app.module.ts), [`main.ts`](../apps/api/src/main.ts) | Product HTTP; feature directories own controllers, use cases, authorization, and adapters; `platform/` owns shared HTTP/config/runtime wiring. |
| Worker | [`worker.module.ts`](../apps/worker/src/worker.module.ts), [`main.ts`](../apps/worker/src/main.ts) | Queue transport, execution, previews, triggers, resource health, and shutdown. It does not serve product HTTP. |
| Lifecycle command | [`run.ts`](../apps/lifecycle-command/src/run.ts) | Narrow workspace lifecycle dispatch with its own readiness and credentials. |
| Operator command | [`run.ts`](../apps/operator-command/src/run.ts) | Explicit audited operator commands with distinct database authority. |
| Recovery | [`restore-before-serve.ts`](../apps/recovery/src/restore-before-serve.ts) | Reconcile restored control state before traffic. |
| Retention | [`run.ts`](../apps/retention/src/run.ts), [`maintenance-loops.ts`](../apps/retention/src/maintenance-loops.ts) | Bounded maintenance loops and lifecycle cleanup. |

API features intentionally live directly under `apps/api/src/`; adding a
`modules/` wrapper or global controllers/services/repositories folders would
change navigation without creating a new responsibility.

## Packages: shared responsibility

Use workspace package exports, never relative paths into another package's
`src` or `dist`.

| Package | Primary owners | What belongs here |
| --- | --- | --- |
| artifact-store | `store.ts`, `control-ledger.ts` | Bounded object I/O, integrity, dual-region adapters, and storage protection. |
| contracts | `src/index.ts`, `src/http`, `src/errors` | Versioned public wire schemas and generated artifacts. |
| database | `src/api.ts`, `src/execution.ts`, `src/` domains | PostgreSQL persistence, tenant transactions, schema, and forward-only migrations. |
| integrations | `src/index.ts`, `src/server.ts` | HTTP, Slack, email, webhook, credentials, and crypto boundaries. |
| node-catalog | `registry.ts`, `server.ts` | Concrete registrations and supported compatibility cohorts. |
| node-sdk | `release.ts`, `server.ts` | Portable manifests, compatibility, schema projection, and executor contracts. |
| nodes-core | `src/index.ts`, `src/server.ts` | Built-in node definitions, executors, and validation. |
| observability | `config.ts`, `logger.ts`, `telemetry.ts` | Safe logging, tracing, metrics, and runtime adapters. |
| queue | `contracts.ts`, `consumer.ts`, `delivery-admission.ts` | Identifier-only envelopes, admission, producers, and bounded consumers. |
| rate-limit | `policy.ts`, `distributed-rate-limiter.ts` | Endpoint policy, distributed admission, and Redis lifecycle. |
| workflow-engine | `index.ts`, `operations.ts` | Deterministic compilation, scheduling, checkpoints, and transitions. |
| workflow-model | `graph.ts`, `graph/`, `expressions/` | Authoring graph validation, identity, canonical JSON, mappings, and restricted expressions. |

## Placement rules

1. Put a helper beside the capability that owns its meaning. Extract shared
   behavior only when callers share the same semantics.
2. Name independently meaningful policy (`policy.ts`, `names.ts`,
   `validation-contract.ts`); do not create global constants or utils buckets.
3. Keep validation, transformation, and orchestration distinct when they
   change for different reasons. Keep transaction/lease/cleanup ordering
   visible together.
4. Preserve supported package exports. Private extractions are not new public
   interfaces, and boundary tests remain compatibility gates.
5. Place tests in the owning workspace's `test/`; use existing fixture owners
   and integration configuration.

## Build and verification

`pnpm build` uses TypeScript project references. `pnpm architecture:check`
checks dependency direction, cycles, and cross-workspace traversal. `pnpm
check` adds formatting, contracts, typechecks, package tests, and static gates.
`pnpm test:integration` exercises real local PostgreSQL, Redis, and
S3-compatible services. `pnpm quality:local` owns disposable services,
source-stable coverage evidence, local performance, deployment rendering,
exercises, and cleanup; its AWS-only exclusions remain explicit.

Infrastructure tooling is grouped by purpose, with tests beside their owners:

| Directory | Responsibility |
| --- | --- |
| [`infrastructure/checks/`](../infrastructure/checks/) | Runtime, CI, schema, import/export, image, and network-registry checks |
| [`infrastructure/coverage/`](../infrastructure/coverage/) | Coverage merging, source witnesses, provenance, inventories, and risk reports; not generated coverage output |
| [`infrastructure/quality/`](../infrastructure/quality/) | Local qualification orchestration, mutation checks, and complexity/duplication budgets |
| [`infrastructure/documentation/`](../infrastructure/documentation/) | Local links, anchors, and current operational-policy references |
| [`infrastructure/support/`](../infrastructure/support/) | Shared process ownership, Git isolation, and temporary-resource cleanup helpers |
| [`infrastructure/development/`](../infrastructure/development/) | Developer Git-hook setup |

Existing `ecs/`, `postgres/`, `minio/`, `observability/`, `performance/`, and
`exercises/` directories retain their deployment, service, and exercise owners.
Use the root package commands instead of memorizing script paths. The
implementation progress document is the mutable delivery authority; ADRs and
runbooks preserve accepted contracts and operational procedures.

## Behavior-to-owner routes

| Journey | Entrypoint | Durable/policy owner | Short behavioral proof |
| --- | --- | --- | --- |
| Manual run and replay | `WorkflowRunsController` | API use cases plus database execution acceptance | `packages/database/test/workflow-run-api.integration.test.ts` |
| Webhook admission | `registerWebhookIngress` | API ingress/rate-limit policy and database trigger store | `apps/api/test/webhooks/direct-webhook.integration.test.ts` |
| Scheduled start | Worker trigger runtime | Schedule scanner and execution acceptance | `apps/worker/test/schedule-trigger.integration.test.ts` |
| Provider execution/retry | Node-attempt handler | Node-attempt/coordinator stores and execution runtime | `apps/worker/test/http-node-attempt.integration.test.ts` |
| Run-event streaming | `streamRunEvents` | SSE authorization lifetime and PostgreSQL event reader | `apps/api/test/executions/run-event-stream.integration.test.ts` |
| Failure notification | Failure-notification handler | Terminal persistence and completion store | `apps/worker/test/coordinator-consumer-failure-notification.integration.test.ts` |
| Artifact transfer | `ArtifactController` | Upload authority and artifact-store adapter | `apps/api/test/artifacts/transfer.integration.test.ts` |
| Retention and purge | Retention runner | Database lifecycle coordinators and control ledger | `packages/database/test/workspace-purge-foundation.integration.test.ts` |
| Restore before serve | `restoreBeforeServe` | Control-ledger coordinator and recovery runbook | `apps/recovery/test/restore-before-serve.test.ts` |

Workflow lifecycle, workspace lifecycle, activation, restoration, and replay
remain distinct contracts. Authenticated request objects are transport types;
feature input ports receive already-derived values and do not acquire headers,
sockets, or framework request fields.

## Current change navigation

| Concern | Owner | Focused proof |
| --- | --- | --- |
| SSE producer/projection cleanup | `apps/api/src/executions/` and `apps/api/src/workflow-runs/` | `apps/api/test/executions/run-event-stream*.test.ts` |
| Source-stable coverage and risk evidence | `infrastructure/coverage/` | coverage producer, report, and risk-validator tests |
| Local qualification orchestration | `infrastructure/quality/run-local-quality.mjs` | `infrastructure/quality/run-local-quality.test.mjs` |
| Deployment/evidence contracts | `infrastructure/ecs/` | ECS rendering and evidence validators |
| Documentation contracts | `infrastructure/documentation/` | documentation and operational-documentation tests |
