# Phase terminology compatibility ledger

Recorded: 2026-09-04

Current source names describe durable workflow concepts rather than delivery
phases. The remaining `phase3`/`Phase 3` occurrences below are retained only
where the text is itself a compatibility contract, immutable migration history,
historical planning record, or a test that verifies one of those contracts.

Repository-wide inventory command:

```sh
rg -n -i 'phase[ _-]?3|phase three|PHASE3' \
  apps packages infrastructure .github docs \
  --glob '!**/dist/**' --glob '!**/node_modules/**'
```

## Retained occurrences

| Location | Classification and reason |
| --- | --- |
| `apps/api/src/executions/initial-workflow-checkpoint.ts` | Durable serialized engine identity. Existing checkpoints and runs store `phase3-engine-v1`; changing it would create a different engine contract. |
| `apps/worker/src/execution/core-definition-identities.ts` | Current shared checkpoint constructor owns the durable serialized engine identity used by worker replay and trigger acceptance. |
| `packages/workflow-engine/src/executable-foundation.ts` | Deprecated public `PHASE3_RUNTIME_POLICIES_V1` compatibility alias; new implementation code uses `BASELINE_RUNTIME_POLICIES_V1`. |
| `packages/workflow-engine/src/executable-workflow.ts` | Re-export of the deprecated public alias through the existing supported entry point. |
| `packages/workflow-engine/src/index.ts` | Package-root re-export of the deprecated public alias. |
| `packages/database/src/platform/readiness-probe-2.sql.ts` | Persisted readiness column aliases introduced by deployed migrations and consumed by the readiness row contract. |
| `packages/database/src/platform/readiness-probe.ts` | Typed parsing of those retained readiness column aliases. |
| `packages/database/src/platform/readiness.ts` | Exact deployed trigger and function identities from migration `0018_phase3_core_executor_non_removal.sql`; readiness must verify the existing database objects by name. |
| `packages/database/migrations/0013_published_workflow_execution.sql` | Immutable migration history describing the delivery phase that introduced the executable projection; changing an applied migration would break checksum verification. |
| `packages/database/migrations/0016_engine_invocation_keys.sql` | Immutable migration history describing the phase that introduced invocation keys. |
| `packages/database/migrations/0017_node_compatibility_releases.sql` | Immutable migration history and persisted bootstrap-release description; changing either would alter applied migration checksums or durable seed data. |
| `packages/database/migrations/0018_phase3_core_executor_non_removal.sql` | Applied migration filename, function, trigger, exception text, and comments define the deployed non-removal guard and are checksum- and database-object-sensitive. |
| `apps/worker/test/coordinator-consumer.fixtures.ts` | Fixture exercises the retained serialized engine identity. |
| `apps/worker/test/coordinator-engine.test.ts` | Regression expectations for the retained serialized engine identity. |
| `apps/worker/test/coordinator-handler.test.ts` | Regression expectation for the retained serialized engine identity. |
| `apps/worker/test/schedule-trigger.integration.test.ts` | Real-service proof that trigger acceptance persists the retained engine identity. |
| `packages/database/test/compatibility-release.test.ts` | Verifies the exact deployed migration, function, and trigger names. |
| `packages/database/test/compatibility-release.integration.test.ts` | Real-PostgreSQL non-removal and readiness tests exercise the exact deployed Phase 3 database guard identities; descriptive names retain the historical policy name because that is the object under test. |
| `packages/database/test/readiness-probe.test.ts` | Row fixture and assertions verify the retained readiness column aliases. |
| `packages/database/test/workflow-run-api.integration.test.ts` | Real-PostgreSQL run reconstruction verifies the retained serialized engine identity. |
| `docs/operations/database-function-readiness.md` | Operational readiness evidence intentionally names the deployed `0018` migration, function, and trigger guard exactly as operators must inspect them. |

## Removed source-only terminology

The current checkpoint owner is
`packages/database/src/compatibility/persisted-workflow-checkpoint.ts`; the
engine's current internal policy is `BASELINE_RUNTIME_POLICIES_V1`; baseline
compatibility test construction is owned by
`packages/database/test/baseline-compatibility-fixture.ts`; and workflow test
descriptions use domain behavior rather than a project phase. Test-only actor,
deployment, oversized-value, and catalog identifiers likewise use durable
baseline or compatibility terminology.

Any new phase-number occurrence fails review unless it is added to this ledger
with a persisted, operational, or supported-public compatibility reason.

### Source-alias removal milestone

`PHASE3_RUNTIME_POLICIES_V1` is a source-compatibility alias only. Remove it at
the first explicitly breaking `@pertexo/workflow-engine` public-interface
release after both of these conditions are met:

1. a repository-wide import search at that release candidate finds no source
   consumer of the alias; and
2. the release notes name `BASELINE_RUNTIME_POLICIES_V1` as the replacement.

The removal change must update the package-surface snapshot and retain the
checkpoint/executable compatibility corpus. It must not rename the durable
`phase3-engine-v1` value or any applied migration/database object. Until that
breaking release is deliberately scheduled, retaining the deprecated alias is
an accepted compatibility obligation rather than an actionable code defect.

## Historical documentation

`docs/workflow-platform-backend-plan.md`, `docs/implementation-progress.md`,
`docs/current-implementation-status.md`, ADR 002, and ADR 010 intentionally
retain Phase 3 headings and narrative because they record the named delivery
phase and its decisions. They do not define current source owners. Audit
documents may also quote or classify the historical term; those occurrences
are evidence about this finding rather than implementation terminology.
