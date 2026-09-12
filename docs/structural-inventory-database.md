# Database structural inventory

Read-only inventory of the current working tree at 2026-09-12. The source
inventory is reconciled against `rg --files packages/database/src -g '*.ts'`:
179 files, all reviewed once below. Decisions describe structural fit, not
file length. Existing uncommitted changes were treated as user-owned; no
source changes were made.

Decision vocabulary:

- **KEEP**: cohesive module with an identifiable caller/test seam; no
  structural extraction justified by this audit. A linked behavior fix can
  still be required.
- **SIMPLIFY**: low-risk seam or barrel/adapter can be reduced, but behavior is
  currently sound and this is not a priority fix.
- **SPLIT**: multiple independently changing responsibilities should become
  narrower modules when the next change touches the seam.
- **INVESTIGATE**: evidence or environment work is required before source
  change; this is not a confirmed code defect.

## Inventory

### Package and authoring

| File | Decision | Per-file reason and current seam |
|---|---|---|
| `packages/database/src/api.ts` | KEEP | Public compatibility barrel; stable export surface is intentional and has no independent behavior to simplify. |
| `packages/database/src/authoring/testing.ts` | KEEP | Test-only compatibility barrel; retaining the established test seam avoids production coupling. |
| `packages/database/src/authoring/workflow-authoring-contracts.ts` | KEEP | Authoring command/query interfaces and pagination contracts; callers depend on stable DTO shapes. |
| `packages/database/src/authoring/workflow-authoring-drafts.ts` | KEEP | Transactional create/save-draft CAS boundary; preserves author checks, graph validation, idempotency, and audit ordering. |
| `packages/database/src/authoring/workflow-authoring-errors.ts` | KEEP | Error taxonomy maps database conflicts to API behavior; intentionally small. |
| `packages/database/src/authoring/workflow-authoring-lifecycle.ts` | KEEP | Archive/restore idempotency and lifecycle revision transition are one cohesive transaction seam. |
| `packages/database/src/authoring/workflow-authoring-reads.ts` | KEEP | Scoped read/pagination mapper; no independent state mutation to extract. |
| `packages/database/src/authoring/workflow-authoring-records.ts` | KEEP | Persisted authoring record types shared by stores and adapters. |
| `packages/database/src/authoring/workflow-authoring-rows.ts` | KEEP | SQL row selections and strict mappers centralize persisted-shape validation. |
| `packages/database/src/authoring/workflow-authoring-types.ts` | KEEP | Dependency/test-hook contracts prevent production stores from depending on test implementations. |
| `packages/database/src/authoring/workflow-authoring-version-restore.ts` | KEEP | Restore-version transaction owns revision and compatibility checks as one operation. |
| `packages/database/src/authoring/workflow-authoring.ts` | KEEP | Composition root for authoring stores; delegates drafts, reads, lifecycle, and restore without duplicating SQL. |
| `packages/database/src/authoring/workflow-publication.ts` | KEEP | Publication transaction coordinates compatibility, immutable version, trigger payload, idempotency, and audit invariants. |
| `packages/database/src/authoring/workflow-trigger-reconciliation.ts` | KEEP | Pure payload normalization used by publication and trigger workers; narrow responsibility. |
| `packages/database/src/config.ts` | KEEP | Zod-validated role/pool/migration configuration is the authority for environment boundaries and role-specific composition. |

### Compatibility

| File | Decision | Per-file reason and current seam |
|---|---|---|
| `packages/database/src/compatibility/compatibility-release-maintenance.ts` | KEEP | Maintenance-role release transitions and monotonic checks match migration authority. |
| `packages/database/src/compatibility/compatibility-release-readiness.ts` | KEEP | Readiness adapter is deliberately separate from mutating maintenance capability. |
| `packages/database/src/compatibility/compatibility-release.ts` | KEEP | Shared parser/lock/expectation contract used by authoring and execution; centralizing version semantics is important. |
| `packages/database/src/compatibility/persisted-workflow-checkpoint-refinements.ts` | KEEP | Pure bounded checkpoint refinements; no database coupling to split. |
| `packages/database/src/compatibility/persisted-workflow-checkpoint.ts` | KEEP | Persisted checkpoint parser/serializer is the durable execution boundary with explicit size limits. |
| `packages/database/src/compatibility/testing.ts` | KEEP | Test-only compatibility barrel; retaining the established test seam avoids production coupling. |

### Connections

| File | Decision | Per-file reason and current seam |
|---|---|---|
| `packages/database/src/connections/connection-health-persistence.ts` | KEEP | Health transition persistence is a narrow capability used by connection runtime. |
| `packages/database/src/connections/connection-management-persistence.ts` | KEEP | CRUD/status management seam owns authorization and audit transaction boundaries. |
| `packages/database/src/connections/connection-persistence.ts` | KEEP | Shared connection persistence owns one transaction/security boundary; no independently changing caller seam was evidenced. |
| `packages/database/src/connections/connection-resolution-persistence.ts` | KEEP | Worker-safe resolution read path intentionally excludes management authority. |
| `packages/database/src/connections/connection-secret-persistence.ts` | KEEP | Secret-version encryption/storage boundary has distinct security invariants and is correctly isolated. |
| `packages/database/src/connections/connection-test-persistence.ts` | KEEP | Connection test lease/status persistence is a separate state machine from management. |
| `packages/database/src/connections/connections.ts` | KEEP | Composition root exposes API management and worker resolution capabilities with role-specific pools. |
| `packages/database/src/connections/testing.ts` | KEEP | Test-only compatibility barrel; retaining the established test seam avoids production coupling. |
| `packages/database/src/connections/workflow-integration-usage.ts` | KEEP | Impact queries support deletion/connection guards and are scoped by workspace/provider. |

### Core database and execution exports

| File | Decision | Per-file reason and current seam |
|---|---|---|
| `packages/database/src/database.ts` | KEEP | Workspace database composition and tenant transaction entry point; callers rely on role/pool isolation. |
| `packages/database/src/execution.ts` | KEEP | Public execution compatibility barrel; stable exports are an intentional package boundary. |
| `packages/database/src/execution/artifact-upload-contract.ts` | KEEP | Strict upload identity/metadata normalization and result contract protect object/database agreement. |
| `packages/database/src/execution/artifact-upload.ts` | KEEP | Upload begin/read/finalize coordinates quota, destructive lock, verification, and idempotency in one vertical slice. |
| `packages/database/src/execution/artifacts.ts` | KEEP | Artifact state and capacity transition persistence are coupled to migration triggers and retention. |
| `packages/database/src/execution/coordinator-pending-failure-observations.ts` | KEEP | Small append-only observation helper; preserves pending-failure evidence. |
| `packages/database/src/execution/coordinator-run-store-commit-state.ts` | KEEP | Lock/read of coordinator durable commit state is a focused transaction seam. |
| `packages/database/src/execution/coordinator-run-store-commit.ts` | KEEP | Commit orchestration owns one CAS transition and delegates validation/state helpers. |
| `packages/database/src/execution/coordinator-run-store-contract.ts` | KEEP | Coordinator public inputs/results encode delivery and commit state boundaries. |
| `packages/database/src/execution/coordinator-run-store-delivery.ts` | KEEP | Inbox/receipt delivery claims and mismatch audit share one transport invariant. |
| `packages/database/src/execution/coordinator-run-store-execution.ts` | KEEP | Execution transition families share one coordinator transaction and fence contract; no safe independent seam was evidenced. |
| `packages/database/src/execution/coordinator-run-store-fact-physical-state.ts` | KEEP | Physical attempt/event projection mapper is a read-only consistency seam. |
| `packages/database/src/execution/coordinator-run-store-observations.ts` | KEEP | Observation normalization and persistence share the coordinator fact/capacity contract; no independent owner or contract was evidenced. |
| `packages/database/src/execution/coordinator-run-store-physical-state.ts` | KEEP | Loaded-checkpoint versus physical-state validation protects replay and recovery invariants. |
| `packages/database/src/execution/coordinator-run-store-plan-validation.ts` | KEEP | Pure transition-plan key/scope validation; no database seam to simplify. |
| `packages/database/src/execution/coordinator-run-store-plan.ts` | KEEP | Parses and fingerprints the durable transition plan; central point for bounded plan validation. |
| `packages/database/src/execution/coordinator-run-store-run-transition.ts` | KEEP | Run-level CAS/status persistence remains narrow and migration-coupled. |
| `packages/database/src/execution/coordinator-run-store-settlement.ts` | KEEP | Loop barrier and due-ready settlement operations are cohesive terminal scheduling helpers. |
| `packages/database/src/execution/coordinator-run-store-status-validation.ts` | KEEP | Pure state transition matrix; centralizing allowed transitions avoids caller drift. |
| `packages/database/src/execution/coordinator-run-store-terminal.ts` | KEEP | Terminal transition plus failure-notification intent is one durable outcome boundary. |
| `packages/database/src/execution/coordinator-run-store-transactions.ts` | KEEP | Abort-aware read/write client wrappers preserve transaction cancellation semantics. |
| `packages/database/src/execution/coordinator-run-store-validation-values.ts` | KEEP | Tiny pure assertions used by plan validation; no change justified. |
| `packages/database/src/execution/coordinator-run-store.ts` | KEEP | Coordinator composition root; callers use narrow store interface and options. |
| `packages/database/src/execution/deadline-wakeup-scanner.ts` | KEEP | Read-only bounded due-deadline scanner with role-specific pool; current working-tree change is focused. |
| `packages/database/src/execution/dispatcher-contracts.ts` | KEEP | Leased outbox event contract shared by dispatcher and workers. |
| `packages/database/src/execution/dispatcher-rows.ts` | KEEP | Strict claim-row parser prevents SQL shape drift at dispatcher boundary. |
| `packages/database/src/execution/dispatcher.ts` | KEEP | Claim/release/backlog operations form one outbox lease state machine; role and fence invariants are coupled. |
| `packages/database/src/execution/due-node-wakeup-scanner.ts` | KEEP | Read-only bounded due-node scanner; parallel shape with deadline scanner is intentional. |
| `packages/database/src/execution/execution-acceptance.ts` | KEEP | Admission/idempotency/entitlement transaction is the primary run-creation boundary. |
| `packages/database/src/execution/execution-state.ts` | KEEP | Shared conflict/gap errors define event-stream failure semantics. |
| `packages/database/src/execution/failure-notification-completion-store.ts` | KEEP | Completion and retry persistence preserves possibly-dispatched terminal evidence. |
| `packages/database/src/execution/failure-notification-contracts.ts` | KEEP | Delivery/claim/store contracts keep worker and database responsibilities separate. |
| `packages/database/src/execution/failure-notification-destination-errors.ts` | KEEP | Destination validation error taxonomy maps persisted safety failures. |
| `packages/database/src/execution/failure-notification-destination-store.ts` | KEEP | Worker completion store is distinct from operator-facing destination management. |
| `packages/database/src/execution/failure-notification-destinations.ts` | KEEP | Destination, version, policy, and idempotency operations share one security/authorization boundary. |
| `packages/database/src/execution/failure-notification-errors.ts` | KEEP | Small state error used by completion path. |
| `packages/database/src/execution/failure-notification-store-support.ts` | KEEP | Deterministic outbox/audit helpers centralize notification evidence encoding. |
| `packages/database/src/execution/failure-notifications.ts` | KEEP | Composition root for notification delivery capabilities; no duplicate state logic found. |
| `packages/database/src/execution/inbox.ts` | KEEP | Generic receipt claim/duplicate/checksum transaction is a cross-consumer transport primitive. |
| `packages/database/src/execution/node-attempt-run-store-claim.ts` | KEEP | Attempt lease claim and stale-fence handling are one state transition. |
| `packages/database/src/execution/node-attempt-run-store-completion.ts` | KEEP | Attempt completion CAS and durable outcome persistence are coupled. |
| `packages/database/src/execution/node-attempt-run-store-contract.ts` | KEEP | Input, delivery, fence, and payload schemas encode worker/database boundary. |
| `packages/database/src/execution/node-attempt-run-store-delivery.ts` | KEEP | Attempt inbox delivery validation/receipt handling is a focused transport seam. |
| `packages/database/src/execution/node-attempt-run-store-dispatch.ts` | KEEP | Dispatch outbox and attempt status transition share dispatch-fence invariants. |
| `packages/database/src/execution/node-attempt-run-store-heartbeat.ts` | KEEP | Heartbeat lease extension is a bounded, independently retriable operation. |
| `packages/database/src/execution/node-attempt-run-store-inputs.ts` | KEEP | Input reference loading/validation isolates artifact and payload limits. |
| `packages/database/src/execution/node-attempt-run-store-outcomes.ts` | KEEP | Outcome validation and persistence shape are a narrow durable boundary. |
| `packages/database/src/execution/node-attempt-run-store-transactions.ts` | KEEP | Abort-aware worker transaction wrapper preserves lease rollback behavior. |
| `packages/database/src/execution/node-attempt-run-store.ts` | KEEP | Composition root for attempt store; delegates claim/dispatch/completion helpers. |
| `packages/database/src/execution/outbox.ts` | KEEP | Canonical payload checksum and outbox helpers are shared across all dispatchers. |
| `packages/database/src/execution/preview-execution-acceptance.ts` | KEEP | Preview admission uses separate retention/side-effect contract from durable runs. |
| `packages/database/src/execution/preview-execution-claim.ts` | KEEP | Preview lease claim state machine is isolated from completion. |
| `packages/database/src/execution/preview-execution-completion.ts` | KEEP | Preview completion/failure CAS preserves terminal metadata and artifact references. |
| `packages/database/src/execution/preview-execution-contract.ts` | KEEP | Preview payload/result schemas define worker boundary. |
| `packages/database/src/execution/preview-execution-delivery.ts` | KEEP | Preview delivery receipt and checksum verification are focused. |
| `packages/database/src/execution/preview-execution-dispatch.ts` | KEEP | Preview dispatch state transition and outbox publication are coupled. |
| `packages/database/src/execution/preview-execution-heartbeat.ts` | KEEP | Lease heartbeat has one bounded responsibility. |
| `packages/database/src/execution/preview-execution-reconciliation.ts` | KEEP | Reconciliation handles stale/duplicate preview deliveries as one transport seam. |
| `packages/database/src/execution/preview-execution.ts` | KEEP | Preview composition root keeps the preview vertical slice separate from production runs. |
| `packages/database/src/execution/published-workflow-reader.ts` | KEEP | Strict published-version projection reader protects execution from authoring shape drift. |
| `packages/database/src/execution/run-events.ts` | KEEP | Append/read event stream helper owns sequence and gap invariants. |
| `packages/database/src/execution/stored-execution-value.ts` | KEEP | Bounded persisted-value serializer is shared by event/checkpoint paths. |
| `packages/database/src/execution/testing.ts` | KEEP | Test-only compatibility barrel; retaining the established test seam avoids production coupling. |
| `packages/database/src/execution/unknown-outcome-reconciliation.ts` | KEEP | Unknown-outcome evidence reconciliation has explicit inbox/idempotency and retry semantics. |
| `packages/database/src/execution/workflow-run-api.ts` | KEEP | Public run command/query contract separates API inputs from persistence. |
| `packages/database/src/execution/workflow-run-cancellation.ts` | KEEP | Cancellation command transition is scoped and idempotent; prior cancellation findings are closed. |
| `packages/database/src/execution/workflow-run-errors.ts` | KEEP | Run error taxonomy is consumed across API and persistence adapters. |
| `packages/database/src/execution/workflow-run-persistence-support.ts` | KEEP | Shared run-row persistence/audit helpers prevent replay and normal acceptance divergence. |
| `packages/database/src/execution/workflow-run-replay.ts` | KEEP | Replay source/version locks and acceptance are intentionally serialized; migration 0077 is the matching SQL seam. |

### Lifecycle and operator

| File | Decision | Per-file reason and current seam |
|---|---|---|
| `packages/database/src/lifecycle.ts` | KEEP | Public lifecycle compatibility barrel; stable exports are an intentional package boundary. |
| `packages/database/src/lifecycle/control-ledger-coordinator.ts` | KEEP | Fenced control-ledger projection coordinator owns lease and hash-chain sequencing. |
| `packages/database/src/lifecycle/control-ledger-errors.ts` | KEEP | Control-ledger error taxonomy maps stale/invalid commands. |
| `packages/database/src/lifecycle/control-ledger-postgres.ts` | KEEP | PostgreSQL ledger adapter isolates SQL transaction details from coordinator. |
| `packages/database/src/lifecycle/control-ledger-read-side.ts` | KEEP | Read-side projection and anchor enumeration are separate from command mutation. |
| `packages/database/src/lifecycle/preview-retention.ts` | KEEP | Preview retention coordinator remains separate from production artifact retention. |
| `packages/database/src/lifecycle/retention-contracts.ts` | KEEP | Retention command/process contracts are shared with apps/retention. |
| `packages/database/src/lifecycle/retention-database-capabilities.ts` | KEEP | Role-specific capability composition prevents maintenance authority from leaking into serving paths. |
| `packages/database/src/lifecycle/retention-support.ts` | KEEP | Retention parsers and bounded options are pure shared validation. |
| `packages/database/src/lifecycle/retention-transaction.ts` | KEEP | Destructive-operation lock and retention transaction are deliberately coupled to legal-hold and cancellation invariants. |
| `packages/database/src/lifecycle/retention.ts` | KEEP | Retention composition root delegates dry-run, enforcement, scheduling, and health capabilities. |
| `packages/database/src/lifecycle/run-artifact-retention.ts` | KEEP | Run artifact retention claim/process loop has one lease state machine. |
| `packages/database/src/lifecycle/testing.ts` | KEEP | Test-only compatibility barrel; retaining the established test seam avoids production coupling. |
| `packages/database/src/lifecycle/transient-data-retention.ts` | KEEP | Bounded transient reap operation is a narrow maintenance capability. |
| `packages/database/src/lifecycle/workspace-lifecycle-commands.ts` | KEEP | Legal hold/delete/restore command ledger owns projection and idempotency invariants. |
| `packages/database/src/lifecycle/workspace-purge.ts` | KEEP | Leased object/tenant purge coordinator is cohesive; migration PF04 is the defect, not a reason to split this orchestration prematurely. |
| `packages/database/src/maintenance.ts` | KEEP | Maintenance public compatibility barrel; role-specific exports are an intentional package boundary. |
| `packages/database/src/migrate.ts` | KEEP | CLI entry adapter delegates migration runner; intentionally tiny. |
| `packages/database/src/migration-execution-plan.ts` | KEEP | Explicit migration plan load/validation is the deployment safety boundary. |
| `packages/database/src/migrations.ts` | KEEP | Migration runner owns one ordered/checksum/role transaction boundary; no independent caller contract was evidenced. |
| `packages/database/src/operator.ts` | KEEP | Public operator compatibility barrel; narrow authority exports are an intentional package boundary. |
| `packages/database/src/operator/operator-command-contracts.ts` | KEEP | Operator command result/runtime option contracts are shared with CLI and API adapters. |
| `packages/database/src/operator/operator-command-errors.ts` | KEEP | Small operator conflict error boundary. |
| `packages/database/src/operator/operator-command-runtime.ts` | KEEP | Capability/readiness probe for operator role is one authority gate. |
| `packages/database/src/operator/operator-commands.ts` | KEEP | Operator command families share validation, idempotency, and role authority; no independently changing seam was evidenced. |
| `packages/database/src/operator/operator-run-replay.ts` | KEEP | Worker-side durable replay request consumption and completion/failure callbacks form one transaction. |
| `packages/database/src/operator/testing.ts` | KEEP | Test-only compatibility barrel; retaining the established test seam avoids production coupling. |

### Platform and readiness

| File | Decision | Per-file reason and current seam |
|---|---|---|
| `packages/database/src/platform/database-runtime.ts` | KEEP | Pool lease/runtime injection isolates production and test ownership. |
| `packages/database/src/platform/persisted-id.ts` | KEEP | UUID generation helper is the persisted-ID seam. |
| `packages/database/src/platform/postgres-pool-checkout-telemetry.ts` | KEEP | Checkout timing instrumentation is a focused pool hook. |
| `packages/database/src/platform/postgres-pool-policy.ts` | KEEP | Role/deadline policy is pure and shared by pool callers. |
| `packages/database/src/platform/postgres-telemetry.ts` | KEEP | Pool diagnostics and lifecycle telemetry share the runtime observability contract; no independent owner seam was evidenced. |
| `packages/database/src/platform/readiness-artifact-capacity.sql.ts` | KEEP | Dedicated readiness SQL checks the artifact-capacity migration contract. |
| `packages/database/src/platform/readiness-probe-1.sql.ts` | KEEP | Identity/authoring readiness SQL is versioned evidence for one schema cohort. |
| `packages/database/src/platform/readiness-probe-2.sql.ts` | KEEP | Execution readiness SQL checks role grants, RLS, and function support. |
| `packages/database/src/platform/readiness-probe-3.sql.ts` | KEEP | Connections/preview readiness SQL is a separate migration cohort. |
| `packages/database/src/platform/readiness-probe-4.sql.ts` | KEEP | Trigger/migration readiness SQL checks late-head repairs and grants. |
| `packages/database/src/platform/readiness-probe-sql.ts` | KEEP | Ordered probe list is the single readiness query composition seam. |
| `packages/database/src/platform/readiness-probe.ts` | KEEP | Readiness row parsing and compatibility assertions are pure deployment guards. |
| `packages/database/src/platform/readiness.ts` | KEEP | Serving/readiness checks coordinate pool, migration head, and role expectations. |
| `packages/database/src/recovery.ts` | KEEP | Public recovery compatibility barrel; stable exports are an intentional package boundary. |

### Schema

| File | Decision | Per-file reason and current seam |
|---|---|---|
| `packages/database/src/schema.ts` | KEEP | Drizzle schema composition root; migration SQL remains source of truth for behavior. |
| `packages/database/src/schema/app-schema.ts` | KEEP | Single `app` schema namespace declaration. |
| `packages/database/src/schema/authoring.ts` | KEEP | Authoring table definitions mirror migration constraints and relations. |
| `packages/database/src/schema/compatibility.ts` | KEEP | Compatibility release tables and indexes mirror migration ownership. |
| `packages/database/src/schema/connections.ts` | KEEP | Connection and secret-version schema mirror tenant FKs/RLS. |
| `packages/database/src/schema/execution-support.ts` | KEEP | Idempotency/artifact-link support tables are shared persistence primitives. |
| `packages/database/src/schema/execution.ts` | KEEP | Run/node/preview table definitions centralize execution relation metadata. |
| `packages/database/src/schema/foundation.ts` | KEEP | Identity/workspace tables define tenant root and membership relations. |
| `packages/database/src/schema/retention.ts` | KEEP | Retention/control tables mirror lease and legal-hold constraints. |
| `packages/database/src/schema/transport.ts` | KEEP | Outbox/inbox/artifact transport tables mirror delivery and RLS contracts. |
| `packages/database/src/schema/triggers.ts` | KEEP | Webhook/schedule materialization definitions mirror trigger migration surfaces. |

### Tenant access and triggers

| File | Decision | Per-file reason and current seam |
|---|---|---|
| `packages/database/src/tenant-access/identity-workspace-contracts.ts` | KEEP | Identity/workspace statuses and command DTOs are shared domain contracts. |
| `packages/database/src/tenant-access/identity-workspace-errors.ts` | KEEP | Identity and lifecycle conflict taxonomy maps authorization and CAS outcomes. |
| `packages/database/src/tenant-access/identity-workspace-identity-store.ts` | KEEP | Identity linking and uniqueness transactions form one security boundary. |
| `packages/database/src/tenant-access/identity-workspace-member-store.ts` | KEEP | Membership authorization/status transitions are a focused store. |
| `packages/database/src/tenant-access/identity-workspace-rows.ts` | KEEP | Strict row selections/mappers isolate SQL shape. |
| `packages/database/src/tenant-access/identity-workspace-session-store.ts` | KEEP | Session create/consume/revoke state machine is intentionally isolated. |
| `packages/database/src/tenant-access/identity-workspace-support.ts` | KEEP | Shared UUID/metadata/conflict parsers are pure helpers. |
| `packages/database/src/tenant-access/identity-workspace.ts` | KEEP | Identity/workspace composition root delegates stores under scoped transactions. |
| `packages/database/src/tenant-access/oidc-login-transactions.ts` | KEEP | OIDC transaction sealing/consumption has distinct capacity and secret invariants. |
| `packages/database/src/tenant-access/testing.ts` | KEEP | Test-only compatibility barrel; retaining the established test seam avoids production coupling. |
| `packages/database/src/tenant-access/workspace-policy.ts` | KEEP | Capability matrix is a pure authorization source shared by stores and callers. |
| `packages/database/src/tenant-access/workspace.ts` | KEEP | Tenant context, SET LOCAL, abort cleanup, and transaction lifecycle are a deliberate security seam; prior uncovered release branch is justified, not a refactor target. |
| `packages/database/src/triggers/schedule-recurrence.ts` | KEEP | Pure recurrence/DST resolution is independently testable and versioned. |
| `packages/database/src/triggers/schedule-trigger-database.ts` | KEEP | Schedule command/read persistence owns lease, configuration, and audit invariants. |
| `packages/database/src/triggers/schedule-trigger-errors.ts` | KEEP | Small schedule error boundary. |
| `packages/database/src/triggers/schedule-trigger-scanner.ts` | KEEP | Due schedule claim/lease scan and checkpoint factory form one worker capability. |
| `packages/database/src/triggers/schedule-triggers.ts` | KEEP | Public schedule-trigger compatibility barrel; stable exports are an intentional package boundary. |
| `packages/database/src/triggers/testing.ts` | KEEP | Test-only compatibility barrel; retaining the established test seam avoids production coupling. |
| `packages/database/src/triggers/trigger-management-access.ts` | KEEP | Small workspace capability check reused by trigger management. |
| `packages/database/src/triggers/webhook-triggers.ts` | KEEP | Webhook ingress, replay, and management share signature/idempotency and trigger authority contracts. |
| `packages/database/src/triggers/workflow-trigger-activation.ts` | KEEP | Activation/deactivation SQL helpers preserve archived-workflow safety. |
| `packages/database/src/triggers/workflow-trigger-errors.ts` | KEEP | Reconciliation/stale-publication error taxonomy is narrow. |
| `packages/database/src/triggers/workflow-trigger-health.ts` | KEEP | Health projection refresh/read is a focused materialization helper. |
| `packages/database/src/triggers/workflow-trigger-materialization.ts` | KEEP | Desired-to-materialized trigger reconciliation owns one projection transition. |
| `packages/database/src/triggers/workflow-trigger-projection.ts` | KEEP | Pure graph-to-trigger projection and fingerprinting is the authoring/runtime contract. |
| `packages/database/src/triggers/workflow-triggers.ts` | KEEP | Reconciliation composition root coordinates receipt, publication authority, materialization, and health. |
| `packages/database/src/validation/persisted-primitives.ts` | KEEP | Shared persisted hash primitive prevents divergent validation regexes. |
| `packages/database/src/testing.ts` | KEEP | Package-wide test-only compatibility barrel; retaining the established test seam avoids production coupling. |

## Existing test-group mapping

The following is the evidence map for all 179 inventory rows. A row inherits
the group for its `###` inventory section and the narrower file-family group
listed below; this is a map to existing suites, not a claim that every helper
is directly imported by every test. Public barrels and type/test barrels map
to the package-contract and owning family suites that exercise their exported
surface.

Bare test filenames below resolve under `packages/database/test/`. The
`platform/persisted-id.ts` row also maps to `persisted-id.test.ts`;
`validation/persisted-primitives.ts` maps through the persisted-checkpoint
suite; the wakeup scanners use the coordinator wakeups group;
`unknown-outcome-reconciliation.ts` uses `inbox-cancellation.test.ts` and
`coordinator-run-store-node-attempts.integration.test.ts`; and
`tenant-access/oidc-login-transactions.ts` uses
`identity-workspace.integration.test.ts`. These are existing evidence seams,
not claims of complete execution coverage.

| Inventory family (rows above) | Existing test group(s) |
|---|---|
| Package/config/database/runtime barrels and `config.ts`, `database.ts`, `platform/database-runtime.ts` | `packages/database/test/package-contract.test.ts`, `config.test.ts`, `database-runtime.test.ts`, `database-runtime.integration.test.ts` |
| Authoring rows | `workflow-authoring.test.ts`, `workflow-authoring-atomicity.integration.test.ts`, `workflow-authoring-coordination.integration.test.ts`, `workflow-authoring-drafts.integration.test.ts`, `workflow-authoring-lifecycle.integration.test.ts`, `workflow-authoring-publication.integration.test.ts`, `workflow-authoring-readiness.integration.test.ts`, `workflow-authoring-version-restore.integration.test.ts`, `workflow-activation-projection.test.ts`, `workflow-activation-projection.integration.test.ts` |
| Compatibility rows | `compatibility-release.test.ts`, `compatibility-release.integration.test.ts`, `persisted-workflow-checkpoint.test.ts`, `q9-bounded-work.test.ts` |
| Connection rows | `connections-lifecycle.integration.test.ts`, `connections-compatibility.integration.test.ts`, `connections-concurrency-security.integration.test.ts`, `connection-tests.integration.test.ts`, `package-contract.test.ts` |
| Artifact/upload rows | `artifact-upload-contract.test.ts`, `artifact-upload-runtime.test.ts`, `artifact-upload.integration.test.ts`, `artifacts-validation.test.ts`, `artifacts.integration.test.ts`, `artifact-capacity-readiness.integration.test.ts`, `artifact-media-type-http-safety-migration.test.ts`, `artifact-media-type-http-safety-migration.integration.test.ts`, `artifact-finalization-retention-deadline-migration.test.ts`, `artifact-finalization-retention-deadline-migration.integration.test.ts` |
| Execution acceptance, run/value/event rows | `execution-acceptance.test.ts`, `execution-acceptance-capacity.integration.test.ts`, `execution-acceptance-lifecycle.integration.test.ts`, `execution-acceptance-notifications.integration.test.ts`, `execution-acceptance-persistence.integration.test.ts`, `execution-acceptance-regional.integration.test.ts`, `execution-acceptance-security.integration.test.ts`, `execution-value-persistence.test.ts`, `execution-value-persistence.integration.test.ts`, `run-events.integration.test.ts`, `workflow-run-api.integration.test.ts` |
| Coordinator/node-attempt rows | `coordinator-run-store.test.ts`, `coordinator-run-store-cas.integration.test.ts`, `coordinator-run-store-commit-output.integration.test.ts`, `coordinator-run-store-foreach.integration.test.ts`, `coordinator-run-store-migrations.integration.test.ts`, `coordinator-run-store-node-attempts.integration.test.ts`, `coordinator-run-store-observations.integration.test.ts`, `coordinator-run-store-parallel-output.integration.test.ts`, `coordinator-run-store-pending-failures.integration.test.ts`, `coordinator-run-store-scheduling.integration.test.ts`, `coordinator-run-store-wakeups.integration.test.ts`, `node-attempt-run-store.test.ts` |
| Dispatcher/inbox/outbox/transport rows | `transport.test.ts`, `transport.integration.test.ts`, `transport-part-2.integration.test.ts`, `inbox-cancellation.test.ts`, `inbox-cancellation.integration.test.ts`, `q9-bounded-work.test.ts` |
| Preview rows | `preview-execution.integration.test.ts`, `preview-execution-deadline-migration.test.ts`, `preview-execution-deadline-migration.integration.test.ts`, `preview-worker-attempt-lifecycle.integration.test.ts`, `preview-worker-artifact-retention.integration.test.ts`, `preview-worker-reconciliation.integration.test.ts`, `preview-worker-schema.integration.test.ts`, `preview-retention-enforcement-migration.test.ts`, `preview-retention-migration.integration.test.ts` |
| Failure-notification rows | `failure-notification-completion-store.test.ts`, `execution-acceptance-notifications.integration.test.ts`, `retention-execution-purge.integration.test.ts`, `rls.integration.test.ts` |
| Lifecycle/control-ledger/retention rows | `control-ledger-coordinator.test.ts`, `control-ledger-coordinator.integration.test.ts`, `control-ledger-coordinator-part-2.integration.test.ts`, `retention-transaction.test.ts`, `retention-transaction-cancellation.integration.test.ts`, `retention-execution-purge.integration.test.ts`, `retention-artifacts.integration.test.ts`, `retention-inventory.integration.test.ts`, `retention-scheduling.integration.test.ts`, `retention-legal-hold.integration.test.ts`, `transient-data-retention.integration.test.ts`, `transient-data-retention-migration.test.ts` |
| Workspace lifecycle/purge rows | `workspace-lifecycle-command-intents.integration.test.ts`, `workspace-lifecycle-command-intents-migration.test.ts`, `workspace-lifecycle-command-hardening-migration.test.ts`, `workspace-lifecycle-api-authority-migration.test.ts`, `workspace-deletion-control-projection-migration.test.ts`, `workspace-deletion-side-effects-migration.test.ts`, `workspace-purge-foundation.integration.test.ts`, `workspace-purge-foundation-migration.test.ts`, `workspace-purge-cancellation.test.ts`, `workspace-purge-completion-migration.test.ts`, `workspace-purge-step-release-migration.test.ts`, `workspace-object-versions-purge-migration.test.ts`, `workspace-tenant-rows-purge-migration.test.ts`, `legal-hold-destruction-serialization-migration.test.ts` |
| Operator rows | `operator-command-runtime.test.ts`, `operator-command-ledger-migration.test.ts`, `operator-outbox-redispatch-migration.test.ts`, `operator-execution-recovery-migration.test.ts`, `operator-attempt-reclaim-state-migration.test.ts`, `operator-run-replay-migration.test.ts`, `operator-maintenance-rerun-migration.test.ts`, `operator-trigger-reconciliation-migration.test.ts`, `retention-operator.integration.test.ts` |
| Migration runner/plan rows | `migration-runner.test.ts`, `migration-checksum-compatibility.test.ts`, `migration-execution-plan.test.ts`, `migration-execution-modes.integration.test.ts`, `published-migration-repair.test.ts`, `published-migration-repair.integration.test.ts`, `coordinator-run-store-migrations.integration.test.ts` |
| Readiness/telemetry rows | `readiness-probe.test.ts`, `serving-readiness.test.ts`, `artifact-capacity-readiness.integration.test.ts`, `postgres-telemetry.test.ts`, `postgres-telemetry.integration.test.ts` |
| Schema rows | `schema-shape.integration.test.ts`, `rls.integration.test.ts`, plus the owning migration/integration group named for each schema family above |
| Tenant-access rows | `identity-workspace-session-cancellation.test.ts`, `identity-workspace.integration.test.ts`, `tenant-context-hygiene.integration.test.ts`, `workspace-authorization-policy.test.ts`, `workspace-transaction-engine.test.ts` |
| Trigger/schedule/webhook rows | `schedule-recurrence.test.ts`, `schedule-recurrence-dst.test.ts`, `schedule-claim-migration.test.ts`, `schedule-claim-concurrency.integration.test.ts`, `schedule-triggers.integration.test.ts`, `schedule-triggers-part-2.integration.test.ts`, `schedule-trigger-migration.test.ts`, `webhook-trigger-migration.test.ts`, `webhook-trigger-prior-head.integration.test.ts`, `webhook-triggers.integration.test.ts`, `workflow-trigger-projection.test.ts` |

The workspace-purge row links the confirmed PF04 behavior correction below;
its structural disposition remains `KEEP`. All 179 structural dispositions
are `KEEP`; the test groups above are retained evidence seams, not
proposed new tests.

## Findings

### Confirmed bug

#### PF04 — workspace purge leaves maintenance rerun rows (P1)

`packages/database/migrations/0057_workspace_tenant_rows_purge.sql:109-121`
hard-codes the tenant deletion order. Its residual scan at `:322-335` checks
every `app` table containing `workspace_id` unless it is in `v_preserved`, and
raises if any row remains. Migration
`0066_operator_maintenance_rerun.sql:4-24` adds
`operator_maintenance_rerun_requests`, which has `workspace_id` but is in
neither list. It has only a `command_id` foreign key to the global
`operator_commands` table (`:5-6`), not a workspace cascade. The only table
operations are insert (`:129-132`), claim/read (`:179-182`), and completion
update (`:211-217`); there is no delete path or cascading workspace parent.
The production caller `packages/database/src/operator/operator-commands.ts:394-408`
creates these rows through `request_operator_maintenance_rerun`, while the
maintenance worker calls `process_operator_maintenance_rerun` through
`packages/database/src/lifecycle/retention-database-capabilities.ts:196-205`.

After a request is made—even after maintenance marks it completed—the purge
pages exhaust their listed tables, the residual scan finds the rerun row, and
the tenant step raises `workspace tenant-row purge has residual rows in
operator_maintenance_rerun_requests`. The step cannot complete, so workspace
deletion cannot reach its terminal state. This is statically confirmed against
the current migration head; no disposable database was started for this
read-only audit.

Minimal fix: add an append-only migration that explicitly deletes these rows
at a safe dependency point before the residual scan (or, only with an ADR,
moves them into the retained set with a documented minimization policy).
Preserve ADR-013/027's leased, ordered, legal-hold-safe purge, the
workspace high-water/lease fences, and the fail-closed residual scan; do not
edit 0057 in place. Acceptance must use a real PostgreSQL integration test:
create a workspace, create at least one maintenance rerun request, run tenant
purge pages until completion, assert the request is deleted, and assert
workspace deletion completes. The existing
`packages/database/test/operator-maintenance-rerun-migration.test.ts:5-27`
only checks SQL/grant text; fixture reset truncation is not a purge regression
test.

`operator_unknown_outcome_evidence` and `operator_run_replay_requests` are
additional explicit-surface coverage gaps, but not independently proven
residuals: evidence cascades from `node_attempts`
(`0063:12-14`), and replay requests cascade from workflow run/version parents
(`0065:50-58`).

### External evidence gaps retained

Database operational evidence remains external to source review: representative
workload measurements, deployed backup/pooler/failover/vacuum evidence, and
compatibility inventory. These are evidence tasks, not source defects.

### Retained clusters

The tenant transaction helper, coordinator/node-attempt state machines,
preview cleanup/cancellation/failure-notification fixes, role-specific pool
composition, and readiness SQL probes were retained. Their apparent branching
or duplication is explained by transaction, lease, RLS, or migration-head
invariants and current callers/tests. The deleted working-tree
`packages/database/src/lifecycle/preview-cleanup.ts` was not counted because it
is absent from the current `rg --files` source set; it was treated as unrelated
user work.

## Reconciliation

The inventory table contains one row for each of the 179 current
`packages/database/src/**/*.ts` paths. Migration coupling was reviewed for the
workspace purge surface, operator command tables, execution/retention tables,
RLS role boundaries, and the schema definitions. No implementation, test,
coverage, service, migration, commit, or push was performed.
