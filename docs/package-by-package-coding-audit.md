# Package-by-package coding audit

Date: 2026-09-08. Source revision: `2206d6748c0c728ff9bf61f4ea06e64fb9eb0b1a`.
Branch: `feat/low-value-code-cleanup`, upstream
`origin/feat/low-value-code-cleanup`.

## Status and scope

**Expanded coding-quality assessment:** the per-part section below separately
evaluates file/folder naming and consistency; conditions, guards and constants;
readability and complexity; responsibility separation, interfaces and duplication;
runtime/error/data safety; and test quality. “Reviewed” in the inventory is not an
unconditional quality pass. Explicit change recommendations, retained complexity,
and verification limits accompany the individual assessments. The original
read-only findings are retained below as the reproduction baseline; the
implementation resolution in this section records their current status.

Production-source review complete across all 12 packages and 6 apps. This report
records the six confirmed findings from the preceding read-only audit and a
fresh package-by-package review followed by an app-by-app review. Manual test
inspection is not exhaustive for the database package; its limit is recorded
below, separately from passing test executions. Existing `AGENTS.md` edits belong
to the user and were not changed by this work. The user subsequently authorized
implementation of all F01–F09 and CQ01–CQ05 items. No commit, push, deployment,
or paused merge follow-up is included.

The review uses Node runtime, async, resource ownership, error handling, streams,
logging, configuration, and testing guidance; PostgreSQL guidance for schema,
transactions, concurrency, RLS, and queries; and NestJS guidance for modules,
DI, controllers, guards, and lifecycle. Existing project contracts override
generic skill preferences, including buildless TypeScript, vendor choices,
validation libraries, and module patterns.

The previous `code-review` skill run reviewed the fixed-point `main...HEAD` diff
along Standards and Spec axes. This new whole-repository pass is not presented
as another fixed-point review. Its coding-smell checklist covers Mysterious Name,
Duplicated Code, Feature Envy, Data Clumps, Primitive Obsession, Repeated Switches,
Shotgun Surgery, Divergent Change, Speculative Generality, Message Chains,
Middle Man, and Refused Bequest. These are judgment-based heuristics, not automatic
violations or reasons to reopen settled architecture. Tool-enforced style issues
are not duplicated as manual findings.

“Reviewed” records source inspection and the named checks, not proof of absence
of defects. Unit tests do not establish production concurrency, external network
policy, or live AWS behavior. Test executions from the preceding audit are
distinguished from fresh executions below.

## Finding index

All nine confirmed findings are resolved in the working tree: **2 P1, 6 P2,
1 P3**. The first six were carried forward; F07–F09 were additional findings
from this pass. Priorities remain as historical remediation priorities.

| ID | Priority | Issue | Primary ownership |
| --- | --- | --- | --- |
| F01 | P1 | Hold acknowledgment races physical deletion | Database lifecycle/retention |
| F02 | P1 | For Each starts with incompatible checkpoint V1 | API and worker initialization |
| F03 | P2 | Finalized uploads retain pending expiration | Database artifacts/retention |
| F04 | P2 | Late replica PUT recreates an orphan after cleanup | API, artifact store, retention |
| F05 | P2 | API provider egress is absent from deployment contract | API/deployment |
| F06 | P2 | Early API construction bypasses cleanup | API composition |
| F07 | P3 | PUBLIC grants disappear from grant-test assertions | Database tests |
| F08 | P2 | Error.name skips log sanitization/bounds | Observability |
| F09 | P2 | Trigger OpenAPI omits required security/headers | Contracts/API |

## Implementation resolution

| Item | Resolution and fresh evidence |
| --- | --- |
| F01 | Workspace purge, run-artifact retention, preview-artifact retention, control-ledger projection and direct legal-hold projection share a workspace-keyed advisory lock. Disposable PostgreSQL tests prove hold acknowledgment waits for both run and preview artifact deletion and a projected hold prevents object-store calls. |
| F02 | API and worker production selectors choose checkpoint V2 for `core.foreach@1`; verified-executable and worker-factory regressions pass. |
| F03 | Finalization replaces the pending deadline with the standard 30-day user-upload deadline. Migration `0083` backfills existing available uploads to 30 days from finalization under their FORCE RLS workspace scope, and grants only `expires_at` update authority to artifact writer roles. |
| F04 | Finalization verifies replicas under the same workspace lifecycle lock used by expiry cleanup, without holding a transaction during object-store I/O. A gated PostgreSQL/store interleaving proves cleanup waits, expired finalization fails, late bytes are removed and capacity returns to baseline. Cancellation while queued for a pool client rejects promptly and releases any client delivered later without querying; cancellation during the advisory-lock query destroys the checked-out connection. Deterministic and live-PostgreSQL regressions prove both waits are safe, no session lock leaks, and destructive work does not execute. |
| F05 | The ECS external-platform contract declares API `provider-api` egress; all 29 deployment checks pass. |
| F06 | Every runtime-construction stage is inside one cleanup boundary, including synchronous `close()` failures. Cleanup failures are aggregated after the original startup error instead of replacing it. Bootstrap regressions cover later factory failure, readiness failure plus rejected teardown, and Redis URLs without a hostname. |
| F07 | The ACL query maps grantee OID zero to `PUBLIC` instead of inner-joining it away. A disposable-schema regression injects a PUBLIC grant and proves it remains observable. |
| F08 | Structured logging sanitizes and bounds `Error.name` like other untrusted text; redaction and 20,000-character regressions pass. |
| F09 | Schedule and webhook OpenAPI sources and generated artifacts declare cookie security, required management/ingress headers, typed success bodies and error responses. Generation parity and all 38 contract tests pass. |
| CQ01 | Connection testing and provider outcome mapping moved to `connection-testing.ts`, with shared serialization in feature-local support; public use-case exports and DI identity remain compatible. |
| CQ02 | The operator runner has table-driven coverage for all ten command variants plus null status, pre-abort, readiness/operation failures, cleanup timeout and multiple cleanup failures; 23 tests pass. |
| CQ03 | `RetentionScheduleResult.capacityLimited` owns the 25-row policy. Database integration covers full, partial and empty results; the app proves capacity-filled batches drain immediately. |
| CQ04 | Browser-safe platform definition registrations have one catalog-owned collection while server executor assembly remains separate. |
| CQ05 | Schedule and webhook authorization tokens live in feature-local `tokens.ts` modules with symbol identity and Nest wiring preserved. |

## Coverage ledger

Package production-source review preceded the app review. Remaining database
test inspection and app inspection then proceeded concurrently. Each row records
concrete areas, checks, and remaining gaps.

| Part | Status | Evidence / gaps |
| --- | --- | --- |
| `packages/artifact-store` | Reviewed | 15 production / 13 test-support files; streaming, replicas, conditional ledger writes and ownership; F04 crosses the caller/retention boundary |
| `packages/contracts` | Reviewed | 23 production / 8 test files plus generator and generated schemas; API guard/contract cross-check confirms F09 |
| `packages/database` | Reviewed; test inspection partial | 168 production TS files and 84 migrations; selected tests/support inspected, all 245 configured unit tests passed; F01/F03/F07 |
| `packages/integrations` | Reviewed | 32 production / 9 test files; provider requests, bounded responses, SSRF, credentials and cancellation; F05 is deployment integration |
| `packages/node-catalog` | Reviewed | 5 production / 5 test-support files; registry and definition resolution; no additional confirmed finding |
| `packages/node-sdk` | Reviewed | 10 production / 2 test files; bounded JSON, definitions, release and executor contracts; no additional confirmed finding |
| `packages/nodes-core` | Reviewed | 57 production / 7 test files; all core definitions, validation, executors and registration; F02 is app initialization, not a new core-node defect |
| `packages/observability` | Reviewed | 11 production / 11 test files; logging, telemetry sanitization, metrics, lifecycle and abortable delays; F08 |
| `packages/queue` | Reviewed | 12 production / 12 test-support files; Redis transport identity, job contracts, publisher/consumer ownership and shutdown |
| `packages/rate-limit` | Reviewed | 4 production / 3 test files; Redis configuration, atomic limiter behavior, key bounds and resource ownership |
| `packages/workflow-engine` | Reviewed | 48 production / 28 test-support files; compilation, checkpoint versions, scheduling, transitions, retries and scope; F02's engine rejection confirmed |
| `packages/workflow-model` | Reviewed | 22 production / 9 test files; graph and JSON boundaries, expression worker/evaluator, mappings and identity; no additional confirmed finding |
| `apps/api` | Reviewed | 138 production / 86 test-support files; controllers, guards, composition, request boundaries and tests; F02/F04/F05/F06/F09 |
| `apps/lifecycle-command` | Reviewed | 4 production / 6 test files plus compiled-process fixture; 25 tests passed |
| `apps/operator-command` | Reviewed | 3 production / 2 test files; 23 tests passed |
| `apps/recovery` | Reviewed | 3 production / 2 test files; 10 tests passed |
| `apps/retention` | Reviewed | 5 production / 3 test files; 12 tests passed; F01/F03/F04 are cross-package retention risks |
| `apps/worker` | Reviewed | 54 production / 73 test-support TS files plus process/JSON fixtures and 7 configuration files; execution, transport, supervision and shutdown; 278 tests passed; F02 |

## Original confirmed-finding detail

The descriptions below record the state that produced each finding. They are
superseded by the implementation-resolution table above. “Introduced” means
introduced by the preceding audit's pinned branch diff.

### F01 — P1: legal holds can complete while physical purge continues

Origin: pre-existing. Areas: database lifecycle, retention.

Evidence: `packages/database/src/lifecycle/workspace-purge.ts:400–429`,
`packages/database/migrations/0058_workspace_object_versions_purge.sql:87–112`
and `:144–160`, and
`packages/database/migrations/0044_retention_control_foundation.sql:316–398`.

The purge claim releases the workspace lock before external object-version
deletion. A legal hold can commit while deletion is in flight. The checkpoint
rechecks the hold only after bytes have been erased; rejection cannot undo that
destruction. This conflicts with ADR 013's legal-hold protection. The preceding
audit's in-memory reproduction returned `idle` despite deletion after a
simulated hold. That reproduction was not a live PostgreSQL/S3 concurrency test.

Fresh package-pass extension: individual artifact retention has the same gap.
`packages/database/src/lifecycle/run-artifact-retention.ts:143–164` commits
preparation before external deletion at `:191–200`; its next transaction starts
at `:224`. `app.complete_run_artifact_retention` in
`packages/database/migrations/0055_standard_retention_classes.sql:580–600`
rejects a changed control high-water or active hold only after deletion. The
existing hold test in
`packages/database/test/retention-artifacts.integration.test.ts:537` installs
the hold before retention starts, not during the destructive I/O. This is an
additional affected path under F01, not a seventh independent finding.

Correction direction: coordinate hold acknowledgment with in-flight destructive
work. Regression: interleave an actual hold with a gated object deletion and
assert byte preservation, not only checkpoint rejection.

### F02 — P1: For Each workflows receive an incompatible initial checkpoint

Origin: pre-existing. Areas: API admission, worker initialization, workflow engine.

Evidence: `apps/api/src/executions/initial-workflow-checkpoint.ts:16–28` and
`apps/worker/src/execution/core-definition-identities.ts:31–36` omit
`core.foreach@1` from V2 selection. A valid workflow without another V2-triggering
node starts with V1, then fails with
`checkpoint_invalid: structured For Each requires checkpoint V2`.

The preceding audit reproduced this using the actual graph compiler, worker
initializer, and engine transitions without external services. Recovery fixtures
manually select V2 and therefore hide the admission defect.

Correction direction: include For Each in both initializers' V2 requirements.
Regression: use actual admission/initialization through the first loop execution,
without supplying a preselected V2 checkpoint in the fixture.

### F03 — P2: finalized uploads retain their pending-upload deadline

Origin: introduced. Areas: database artifact finalization and retention.

Evidence: `packages/database/src/execution/artifact-upload.ts:307` changes status
without changing `expires_at`;
`packages/database/migrations/0080_expired_artifact_upload_retention.sql:19`
selects expired unreferenced uploads. An available upload can consequently be
deleted at its original 15-minute deadline while public metadata reports
`expiresAt: null`.

Correction direction: distinguish pending-upload expiration from finalized
artifact retention. Regression: finalize an upload, advance past its original
pending deadline, run retention, and check metadata and download availability.
Evidence is the traced SQL/application contract, not a fresh live retention run.

### F04 — P2: expiry cleanup can finish before an in-flight replica write

Origin: introduced. Areas: API artifact service, artifact store, database retention.

Evidence: `apps/api/src/artifacts/service.ts:140` starts replication without
coordinating its lifetime with expiry cleanup. Cleanup can delete objects and
metadata and release capacity while a recovery PUT remains pending. A late PUT
then recreates an untracked recovery object.

The preceding audit reproduced the store interleaving: finalization rejected
but recovery bytes remained after the gated PUT completed. This was an in-memory
store reproduction, not live object-storage behavior verification.

Correction direction: retain cleanup authority and capacity accounting until
outstanding writes cannot recreate bytes. Regression: expire an upload while
recovery PUT is gated, complete cleanup, release the write, and assert no orphan
and no premature capacity release.

### F05 — P2: deployment egress excludes API connection tests

Origin: pre-existing. Areas: API connections, deployment network contract.

Evidence: `infrastructure/ecs/external-platform-contract.json:32` excludes
`provider-api` from API egress, while
`apps/api/src/connections/use-cases.ts:303` performs Resend, Slack, and configured
HTTP connection tests inside the API process. A deployment enforcing that
contract blocks those capabilities. This is a source/contract mismatch; the
preceding audit did not observe the production AWS network.

Correction direction: align API egress with existing connection-test behavior.
Regression: exercise all supported connection tests under the enforced network
policy, retaining the application's SSRF protections.

### F06 — P2: early API construction failures bypass resource cleanup

Origin: pre-existing. Areas: API composition, configuration, resource lifecycle.

Evidence: `apps/api/src/app.ts:118–141` constructs runtimes before its first
cleanup guard. Parser-accepted `redis:///0` fails in workflow construction before
that guard is reached, leaving previously created resources unclosed.

The preceding audit used parser output, no-I/O database/workflow overrides, and
an identity-runtime close counter: construction rejected with
`RunEventNotificationConfigurationError`, but the close count stayed zero.

Correction direction: guard partial composition with ownership-aware cleanup
and validate Redis endpoints before allocating resources. Regression: inject
failures during each constructor/factory stage, assert owned resources close,
and preserve the original failure alongside existing readiness-failure tests.

## Additional confirmed findings from the part-by-part pass

### F07 — P3: the schema-grant test cannot see PUBLIC privileges

Origin: pre-existing; no change to this file in the pinned `main...HEAD` diff.
Area: database integration-test correctness. Skill criteria: PostgreSQL grants
and Node test assertions that actually fail for the prohibited state.

Evidence: `packages/database/test/schema-shape.integration.test.ts:155–161`
expands ACL entries, then inner-joins `pg_roles` on the grantee OID. PostgreSQL
represents PUBLIC as grantee zero, which has no `pg_roles` row. PUBLIC entries
are therefore removed before the assertion at `:182` checks that the resulting
set does not contain `PUBLIC`. Adding a PUBLIC grant would not make that
assertion fail. This weakens the raw-table grant regression gate; it does not
establish that the current migrations expose data to PUBLIC.

Fresh read-only PostgreSQL probe:

```sql
WITH public_acl AS (
  SELECT * FROM aclexplode(ARRAY['=r/pertexo_owner']::aclitem[])
)
SELECT
  (SELECT count(*) FROM public_acl WHERE grantee = 0) AS public_grants,
  (SELECT count(*) FROM public_acl acl
   JOIN pg_roles role ON role.oid = acl.grantee) AS rows_seen_by_audit_query;
```

Observed result: `public_grants = 1`, `rows_seen_by_audit_query = 0`. No roles,
grants, or application data were changed by the probe.

Correction direction: preserve the zero-OID ACL entry with an explicit PUBLIC
label, or assert its absence before joining named roles. Regression: on a
disposable fixture, inject a PUBLIC table grant and prove the validator fails;
then remove it and prove the normal schema passes.

### F08 — P2: Error.name bypasses log redaction and text bounds

Origin: pre-existing; no change to this file in the pinned `main...HEAD` diff.
Area: observability logger. Evidence:
`packages/observability/src/logger.ts:214` copies `error.name` verbatim into the
otherwise sanitized Error. Pino emits that enumerable property as `err.name`.
The same redaction and 16 KiB text bound used for message and stack do not apply
to it, including Errors nested in causes. This violates the logger's tested
hostile-error/redaction boundary; it is not evidence of a current production
credential leak or an unauthenticated exploit.

Primary-reviewer reproduction used the actual logger with an in-memory sink:
an Error with `message = 'token=audit-sentinel-message'` and
`name = 'token=audit-sentinel-name'` produced
`{ nameRedacted: false, messageRedacted: true }`. A second Error with a
20,000-character name emitted all 20,000 characters. No actual secret was used.

Correction direction: sanitize and bound the name before serialization, or
accept only bounded error classification names with a safe fallback. Regression:
check credential-shaped and oversized names in both top-level errors and causes,
while retaining useful ordinary class names.

### F09 — P2: trigger OpenAPI documents omit required authentication and headers

Origin: pre-existing; neither source file changed in the pinned `main...HEAD`
diff. Areas: contracts and API request boundaries.

Evidence: `packages/contracts/src/schedules.ts:37–77` and
`packages/contracts/src/webhooks.ts:59–110` describe management operations
without a session security scheme or required `Idempotency-Key` and
`X-CSRF-Token` header parameters. The client-contract arrays in the same files
declare those headers, while `apps/api/src/schedules/controllers.ts:46–100`
and `apps/api/src/webhooks/controllers.ts:51–112` enforce session authentication,
authorization, CSRF protection and idempotency parsing. The documents also omit
the corresponding 403 responses and typed success bodies. Webhook ingress
likewise omits the timestamp/signature headers declared in its client contract.

A fresh primary-reviewer inspection of both generated `.openapi.json` artifacts
confirmed no root/operation security, no security schemes, no header parameters
and no 200 response content schemas for these management operations. A generated
client relying on OpenAPI therefore lacks material required to make valid
requests or type their successful results, despite `contracts:check` passing.
This is a semantic contract/client-generation defect, not an authentication
bypass; the runtime guards are present.

Correction direction: publish security, required headers and response schemas
consistent with the actual routes, separating signed public ingress from
session-authenticated management. Regression: compare generated operations
against client-contract headers and guarded-route success/error fixtures, not
only OpenAPI syntax and generated-file freshness.

## Verification from the preceding source pass

Primary-reviewer executions below were completed before implementation and are
retained as baseline evidence. Fresh post-implementation evidence is recorded
in the final verification section.

| Check | Result | What this establishes |
| --- | --- | --- |
| `pnpm build` | Passed | Production TypeScript project build |
| `pnpm architecture:check` | Passed; 15 assertions | Workspace ownership, runtime import cycles, project references |
| `pnpm database:schema:check` | Passed; 1 assertion | 68 migration-owned tables accounted for: 49 typed, 19 reviewed raw SQL |
| `pnpm contracts:check` | Passed | Generated contract consistency and all eight OpenAPI documents validate |
| `pnpm lint` | Passed | Repository ESLint rules |
| `pnpm dependencies:check` | Passed | Knip dependency/export checks |
| `pnpm complexity:check` | Passed; 2 assertions | No new or worsened hotspot against the existing baseline, not absence of complexity |
| `pnpm duplication:check` | Passed; 6 assertions | Reviewed duplication baseline: source 27 groups / 512 lines; tests 4 groups / 203 lines |
| `pnpm deployment:check` | Passed; 29 assertions | Local deployment contract, runtime closure, parser compatibility, deterministic rendering; not live AWS proof |
| `pnpm docs:check` | Passed; 13 assertions | Documentation links, historical tree consistency, operational-documentation checks |
| `pnpm runtime:check` | Passed; 15 assertions | Node 24 configuration consistency |
| `pnpm --filter './packages/*' --recursive --if-present typecheck` | Passed in all 12 packages | Test/support TypeScript compilation in addition to production build |
| Database `vitest run --config vitest.integration.config.ts test/retention-artifacts.integration.test.ts` | Passed; 4 tests | Real local PostgreSQL disposable fixtures; object-store operations mocked; does not cover F01/F04 in-flight interleavings |
| Read-only PostgreSQL PUBLIC ACL probe | Reproduced F07 | One PUBLIC ACL entry disappears from the test's inner join |
| In-memory structured logger probe | Reproduced F08 | Name leaks sentinel while message redacts; 20,000-character name remains unbounded |
| Database disposable runtime/schema/hygiene/cancellation integration selection | Passed; 4 files / 11 tests | Shared-pool ownership, schema shape, tenant context cleanup, wire cancellation and rollback; local PostgreSQL only |
| Node SDK/catalog/core/model/engine unit rerun by primary reviewer | Passed; 539 tests | 38 / 17 / 96 / 94 / 294 respectively |
| Lifecycle-command/operator-command/recovery/retention tests | Passed; 54 tests | 25 / 8 / 10 / 11 respectively; lifecycle includes actual compiled-process signal and exit tests with mocked external resources |
| `pnpm --filter './apps/*' --recursive --if-present typecheck` | Passed in all 6 apps | Production and test/support type contracts |
| Artifact-store/contracts/integrations/observability/queue/rate-limit unit rerun | Passed; 617 tests | 209 / 36 / 223 / 65 / 55 / 29 respectively; external integration suites excluded |
| Database/API/worker unit rerun | Passed; 991 tests | 238 / 476 / 277 respectively; configured unit cohorts, not integration/resilience suites |

Together these primary-reviewer reruns passed **2,201 package/app tests** plus
**15 selected local PostgreSQL integration tests**. This total excludes duplicate
worker-agent executions and repository-level guardrail checks listed above.

## Expanded coding-quality assessment by part

This section assesses how the code is written, not merely whether the configured
tests pass. It uses Node guidance throughout; NestJS guidance for the API, worker
and observability Nest adapter; PostgreSQL guidance for persistence and the apps
that orchestrate it; and module-depth/architecture guidance for responsibility
ownership and file layout. Existing ADRs and capability exports remain authoritative.
No frontend, Prisma, complex-type, or test-first skill was applied to unrelated code.

The source inventory covers all 18 parts. Each assessment considers naming and
navigation, repeated patterns, unnecessary conditions, authorization versus
defensive validation, policy constants, nesting, responsibility ownership,
type/error contracts, async/resource safety, and behavioral tests. Test inspection
is not exhaustive for database, as explicitly recorded below. A test-file count
is not a coverage percentage, and a large file is not automatically a bad module.

### Verdict key and matrix

- **M — Meets:** inspected evidence supports the criterion; no required change
  identified on that axis. This is not a claim of perfection.
- **N — Needs changes:** a concrete defect, maintainability finding, or missing
  regression is described in the part's assessment.
- **R — Retained debt:** readability/complexity friction exists, but a broad
  extraction is not justified without the named characterization. This is not M.
- **U — Unverified:** insufficient evidence for an exhaustive verdict.

“Runtime” is the code-level assessment, not a live-service certification. F-prefixed
findings are the nine existing defects; CQ-prefixed findings below are additional
maintainability/test work and are not counted as new correctness defects.

| Part | Names / layout | Guards / constants | Readability | Interfaces / ownership | Runtime / data / errors | Tests |
| --- | --- | --- | --- | --- | --- | --- |
| `packages/artifact-store` | M | M | R | M | M; F04 integration risk | M; AWS unverified |
| `packages/contracts` | M | M | M | N: F09 parity | N: F09 | N: F09 regression |
| `packages/database` | M | N: CQ03 | R | N: CQ03 | N: F01/F03 | N: F07; U: exhaustive inspection |
| `packages/integrations` | M | M | R | M | M; F05 deployment risk | M; providers unverified |
| `packages/node-catalog` | M | M | M | N: CQ04 | M | M |
| `packages/node-sdk` | M | M | R | M | M | M |
| `packages/nodes-core` | M | M | M | M | M | M; F02 app seam gap |
| `packages/observability` | M | M | M | M | N: F08 | N: F08 regression |
| `packages/queue` | M | M | R | M | M | M; live transport unverified |
| `packages/rate-limit` | M | M | M | M | M | M; live Redis unverified |
| `packages/workflow-engine` | M | M | R | M | M | M; F02 app seam gap |
| `packages/workflow-model` | M | M | R | M | M | M |
| `apps/api` | N: CQ01/CQ05 | M | N: CQ01; R: ingress/OIDC | N: CQ01 | N: F02/F04/F05/F06 | N: production seam regressions |
| `apps/lifecycle-command` | M | M | M | M | M | M |
| `apps/operator-command` | M | M | M | M | M | N: CQ02 |
| `apps/recovery` | M | M | M | M | M | M; live restore unverified |
| `apps/retention` | M | N: CQ03 | M | N: CQ03 | N: F01/F03/F04 integration | N: destructive interleaving regressions |
| `apps/worker` | M | M | R | R: capability composition | N: F02 integration | N: F02 production-selector regression |

### `packages/artifact-store`

- **Names/layout:** artifact metadata, downloads, regional orchestration and
  control-ledger modules are named for their jobs. `store.ts` is broad but its
  package context is meaningful; `artifact-download.ts` and
  `dual-region-artifact-store.ts` make the distinct capabilities discoverable.
- **Guards/constants:** metadata, checksum, request deadline and closed-state
  checks protect different invariants. In `src/control-ledger.ts:638`, the empty
  projection check and the later nonempty anchor checks are different cases,
  not redundant `if` statements. Record limits are named.
- **Readability:** ledger reconciliation (`src/control-ledger.ts:638`) and paged
  purge (`src/store.ts:668`) mix validation with ordered external work. Retain as
  explicit debt under the complexity register; a future private extraction must
  preserve pagination, hash-chain checks and delete acknowledgement ordering.
- **Interfaces/types:** `AwsArtifactStore` implements storage, download and purge
  capabilities (`src/store.ts:403`) while sharing one client and ownership policy.
  That alone is not a single-responsibility failure: callers already have narrow
  capability interfaces. Splitting it into separately owned clients would add
  lifecycle complexity without established leverage.
- **Runtime/tests:** request cancellation, stream destruction, checksum checks
  and owned-versus-borrowed close are explicit (`src/store.ts:480`, `:759`). Tests
  exercise corruption, cancellation, purge and ledger concurrency through the
  interfaces. F04 concerns a wider upload/retention protocol that these mocked
  object-store tests do not prove; real AWS/Object Lock behavior remains unverified.

### `packages/contracts`

- **Names/layout:** domain files and `openapi-primitives.ts` give schemas and
  document construction clear homes (`src/artifacts.ts:31`,
  `src/openapi-primitives.ts:6`). Generated artifacts are distinct from source.
- **Guards/constants/readability:** small declarative schemas are appropriate;
  adding imperative guards around every schema would duplicate validation.
  Named enums and bounded schemas are preferable to scattering raw accepted values.
- **Interfaces/duplication:** route descriptors and OpenAPI paths are independently
  maintained (`src/schedules.ts:17`, `:59`; `src/webhooks.ts:24`, `:95`). F09 shows
  actual drift in required request metadata, not merely similar-looking code.
  Add parity validation or one authoritative metadata model; do not redesign the
  entire contract package just to fix these routes.
- **Runtime/types/tests:** Zod schemas provide runtime parsing and inferred types,
  but valid OpenAPI syntax does not prove endpoint fidelity. Schedule/webhook
  tests (`test/schedules.test.ts:28`, `test/webhooks.test.ts:8`) cover schema inputs,
  not the missing security/header declarations. Add assertions that cross the
  generated-document/actual-route seam as part of F09.

### `packages/database`

- **Names/layout:** capability directories such as `execution`, `lifecycle`,
  `tenant-access`, `connections`, `triggers`, `authoring`, `operator`, `platform`
  and `validation` express ownership. Long names such as
  `execution/coordinator-run-store-commit-state.ts` are specific rather than
  mysterious: they identify the operation and persistence role. Flattening the
  package or shortening these to `helpers.ts` would worsen navigation.
- **Guards/constants:** transaction/lease/workspace/fence checks are not redundant
  with HTTP authorization or RLS. CQ03 is a real exception to good policy locality:
  the retention batch size is duplicated in SQL invocation, row validation and
  the calling app's polling decision (`src/lifecycle/retention.ts:572`).
- **Readability:** large transaction factories and state transitions remain debt.
  The current complexity scan identifies `workspace-purge.ts#processNext` at
  513 lines/46 branches and the coordinator-observation callback at 263/37.
  Factory size with few branches differs from decision complexity; neither is
  excused as “clean” merely because the ratchet passes. Keep lock/query/commit
  order local until a behavior-preserving extraction has real PostgreSQL evidence.
- **Interfaces/types/errors:** capability exports and workspace transaction
  ownership are useful deep modules; typed schemas coexist with reviewed raw SQL.
  Do not spread transaction ownership into apps or invent a repository abstraction
  per query. Two retained locality concerns deserve explicit acknowledgment:
  `src/lifecycle/retention.ts:107` exposes dry-run execution, scheduling, reruns,
  reaping and lag observation in one interface; connection persistence is similarly
  broad but provides role-specific `Pick` views (`src/connections/connection-persistence.ts:325`).
  Also, child implementations import types from their composing parent
  (`src/authoring/workflow-authoring-drafts.ts:24` imports `workflow-authoring.ts`,
  which imports that child at `:24`; `src/tenant-access/identity-workspace-rows.ts:4`
  has the same type-ownership pattern). These erased cycles are not runtime import
  cycles, but they make contract discovery less local. Consider leaf-owned
  contracts and capability-specific internal implementations when those modules
  next change, preserving public exports and transaction ownership. F01/F03 are
  actual lifecycle invariant failures requiring coordinated corrections, not
  naming changes.
- **Tests:** selected pool ownership, RLS, migration, cancellation, schema and
  transaction tests provide good behavioral evidence. F07 weakens the grants gate.
  The 26-file explicitly reconciled test/support subset and 133-file remaining
  manual-inspection limit still apply; this report does not convert passing unit
  tests into a claim that every database test is well written or complete.

### `packages/integrations`

- **Names/layout:** `credentials`, `crypto`, `http`, `email` and `slack` separate
  policy, cryptography and provider implementations. Repeated `executor.ts` names
  are readable inside provider directories and make corresponding roles easy to find.
- **Guards/constants:** executor parsing is intentionally repeated at a directly
  callable seam (`src/email/executor.ts:125`, `src/slack/executor.ts:120`). Identity,
  auth-type and pre-dispatch currency checks each protect a different invariant;
  deleting them because the registry also validates would weaken the contract.
- **Readability/duplication:** HTTP DNS/TLS/redirect admission remains a retained
  ordered security path. Email and Slack have parallel parse/resolve/dispatch/
  zeroize flows (`src/email/executor.ts:119`, `src/slack/executor.ts:114`), but email
  is idempotent-with-key and Slack is unsafe after possible dispatch. Their cancel,
  retry and unknown-outcome branches differ materially. Retain those differences;
  do not introduce a generic provider executor solely to remove similar lines.
- **Interfaces/types:** narrow injected clients and telemetry contracts
  (`src/email/executor.ts:43`, `src/slack/executor.ts:59`) isolate provider behavior.
  Shared pre-dispatch fencing is already factored without hiding classification.
- **Runtime/tests:** byte/time bounds, SSRF policy, secret zeroization and typed
  ambiguous outcomes are strong. Tests cover fences, cancellation, retry and
  hostile responses. F05 concerns actual API egress configuration; mocked provider
  tests cannot certify that deployment or live provider behavior.

### `packages/node-catalog`

- **Names/layout:** `definition-resolution.ts` owns browser-safe definition lookup;
  `server.ts` owns executable assembly. Keeping these distinct preserves the
  browser/server split rather than applying identical imports everywhere.
- **Guards/constants/readability:** release identity is verified before resolution
  (`src/definition-resolution.ts:23`); unsupported definitions/executors fail
  closed. Explicit registration and executor selection is easier to inspect than
  reflective discovery of whatever happens to be imported.
- **Interfaces/duplication:** CQ04 identifies the same platform definition list
  in `src/definition-resolution.ts:48` and `src/server.ts:62`. Adding a provider
  requires updating both paths. Centralize only the browser-safe registration
  data; do not make browser consumers import server executors.
- **Runtime/types/tests:** readonly registry/dependency contracts
  (`src/server.ts:40`) and release history tests pin exact manifests, schemas and
  compatibility (`test/release-history.test.ts:561`). Construction/execution and
  package export tests are behavior-based evidence. No additional runtime defect
  is established by the duplicated list.

### `packages/node-sdk`

- **Names/layout:** `identity.ts`, `json-boundary.ts`, `release.ts`, `server.ts`
  and explicit entrypoints separate identity, bounded values, compatibility and
  execution. Here `server.ts` means the server-only registry/execution entrypoint,
  not an HTTP listener; renaming it without considering package exports is unwarranted.
- **Guards/constants:** ABI versions and connection-reference limits are bounded
  (`src/server.ts:85`, `:124`); config/input/output errors are mapped explicitly
  (`:184`). Runtime validation is justified for external and persisted values
  even when TypeScript callers have compile-time types.
- **Readability:** release and registry construction are substantial retained
  compatibility modules. Their size is debt, but fingerprinting and successor
  checks must remain canonical. Do not split version grammar into speculative
  mini-modules just to lower a number.
- **Interfaces/duplication:** the registry offers catalog, dispatch and execution
  (`src/server.ts:103`). Duplicate-identity loops in `src/release.ts:288` and
  `src/server.ts:167` differ in error contracts; identity-list comparison also uses
  different algorithms (`release.ts:377`, `server.ts:129`). These are low-impact
  cleanup opportunities, not proven bugs or reasons to unify validation ownership.
- **Runtime/tests:** stable typed failures and abort checks are explicit. Registry
  tests exercise browser/server parity, hostile JSON, duplicate identities and
  schema drift (`test/registry.test.ts:412`, `:589`); package-contract tests protect
  server-only exports. No required new SDK fix was found on these axes.

### `packages/nodes-core`

- **Names/layout:** per-node definitions/executors and explicit versioned imports
  (`src/definitions.ts:3`, `src/registrations.ts:8`) make behavior and retained
  releases discoverable. Similar node directories use similar roles without
  unnecessary Nest-style folders in this pure package.
- **Guards/constants/readability:** registration validation rejects duplicate or
  missing bindings (`src/registrations.ts:43`); successor epoch/fingerprint checks
  (`src/server.ts:41`) are meaningful compatibility checks, not defensive clutter.
- **Interfaces/types:** immutable registration arrays and small registry contracts
  (`src/definitions.ts:88`, `src/server.ts:25`) expose useful behavior. Tiny local
  `identityToken` helpers (`registrations.ts:39`, `server.ts:21`) are not worth a
  new cross-package utility abstraction on their own.
- **Runtime/tests:** retained-registry tests check exact binding, immutability,
  successor rejection and unshipped implementation rejection
  (`test/retained-registry.test.ts:33`, `:87`). F02 is the app's initial-checkpoint
  selection problem, not evidence that the core For Each definition should be
  renamed or made responsible for workflow admission.

### `packages/observability`

- **Names/layout:** logger, telemetry sanitization, metrics, tracing, runtime and
  Nest adaptation have clear homes. `nest-runtime.ts` is an adapter, not a reason
  for the whole package to depend on app internals.
- **Guards/constants/readability:** bounded sanitizer helpers make recursive
  handling reviewable (`src/logger.ts:155`, `src/telemetry-sanitization.ts:11`).
  Metrics factories with many instruments but little branching should not be
  confused with tangled decision logic.
- **Interfaces/types:** `StructuredLogger` and telemetry lifecycle contracts
  (`src/logger.ts:12`, `src/nest-runtime.ts:153`) keep calling code small. Broad
  arbitrary payloads are narrowed/sanitized at the logging seam, not trusted
  merely because TypeScript describes a record.
- **Runtime/tests:** F08 is the exception: `sanitizeError` copies `Error.name`
  verbatim (`src/logger.ts:195`). Existing hostile-message/stack tests missed
  names. Add oversized, secret-bearing and nested error-name cases; passing
  telemetry tests do not justify a blanket error-sanitization verdict.

### `packages/queue`

- **Names/layout:** producer, consumer, delivery admission, contract, Redis
  endpoint and notification modules describe their roles. There is no need to
  impose app feature-controller naming on this transport adapter.
- **Guards/constants:** lease/admission/acknowledgement checks and bounded
  operation deadlines serve different stages. Endpoint normalization has one
  named implementation (`src/redis-endpoint.ts:3`).
- **Readability:** producer methods and consumer lifecycle helpers keep decisions
  local (`src/producer.ts:220`, `src/consumer.ts:430`), but the stateful consumer
  remains retained complexity. Splitting redelivery from drain/acknowledgement
  without characterization would obscure the ordering that matters.
- **Interfaces/types:** producer, consumer, handler, tracing and observation
  contracts (`src/producer.ts:43`, `src/consumer.ts:45`) are suitably narrow.
  Small repeated error adapters do not justify an additional shared package.
- **Runtime/tests:** ownership-aware close, deadline handling, outcome-unknown
  publication and forced drain are explicit. Tests cover admission, cancellation,
  endpoint identity and lifecycle. Most transport tests use doubles; live
  Redis/BullMQ outage/redelivery behavior remains a separate verification layer.

### `packages/rate-limit`

- **Names/layout:** four focused modules separate policy, script protocol and
  Redis runtime; the small package does not need deeper folders.
- **Guards/constants/readability:** policy evaluation is compact
  (`src/policy.ts:171`); script responses are validated before use
  (`src/distributed-rate-limiter.ts:71`). `DEFAULT_OPERATION_TIMEOUT_MS` and
  bounded timeout parsing (`src/redis-runtime.ts:13`, `:114`) expose policy intent.
- **Interfaces/types:** the script-executor seam and decision/result types are
  narrow (`src/distributed-rate-limiter.ts:10`). Concurrent connection deduplication
  belongs to the Redis adapter, not callers.
- **Runtime/consistency:** queue normalizes endpoints while this runtime accepts
  a string (`src/redis-runtime.ts:23`). Current API and worker configs already
  validate Redis URL schemes; no in-scope bad-endpoint failure is demonstrated.
  Treat package-level validation alignment as optional hardening, not a new
  runtime defect or permission to add a dependency on queue internals.
- **Tests:** script validation, timeout/reconnect, concurrent connect and
  close/connect races are exercised. These are meaningful runtime tests; the
  live Redis deployment was not verified by the unit cohort.

### `packages/workflow-engine`

- **Names/layout:** checkpoint versions, executable validation, scheduling,
  observations and transitions are distinct modules with curated exports
  (`src/index.ts:3`). Long operation-specific names convey domain meaning.
- **Guards/constants:** readonly transition tables (`src/transitions.ts:4`) and
  named terminal dispositions (`src/scheduling.ts:13`) avoid scattered policy.
  Recursive checkpoint/graph membership validation is not redundant with JSON
  shape parsing; it establishes semantic compatibility.
- **Readability:** checkpoint grammar and scheduling functions retain considerable
  decision complexity. `assertCheckpointMatchesExecutable` currently measures
  168 lines/42 branches. Keep this as explicit debt; avoid hiding transition order
  inside generic rule pipelines solely to satisfy line/branch limits.
- **Interfaces/types/errors:** public operations use typed inputs/results
  (`src/operations.ts:64`); `WorkflowEngineError` has a closed code union
  (`src/errors.ts:1`). The engine remains portable rather than importing worker
  resources or database ownership.
- **Tests:** For Each admission, empty/over-limit cases and stable keys
  (`test/foreach-scheduling.test.ts:10`) and executable identity tests
  (`test/executable-workflow-identity.test.ts:22`) exercise public behavior.
  F02 demonstrates why these tests must be complemented by the app's production
  selector/admission path; fixtures that already choose V2 cannot prove that path.

### `packages/workflow-model`

- **Names/layout:** graph and expression subdirectories are appropriate for
  growing subdomains; `canonical-json.ts`, `lifecycle.ts` and `mapping.ts` remain
  readable standalone modules. Neither one giant model file nor a directory per
  tiny helper would improve this layout.
- **Guards/constants:** canonical JSON enforces depth, cycles, plain-object and
  accessor rules (`src/canonical-json.ts:29`); graph validation applies bounded
  schemas and structural checks (`src/graph/validation.ts:17`, `:74`). These are
  separate input hazards, not repetitive null checking.
- **Readability/interfaces:** pure lifecycle decisions (`src/lifecycle.ts:36`)
  and small canonicalization entrypoints (`src/canonical-json.ts:108`) provide
  good leverage. Expression worker supervision and graph grammar retain complexity;
  preserve one owner for worker timing/message order and canonical graph semantics.
- **Runtime/errors/tests:** evaluator limits, typed errors, cancellation and
  shutdown are explicit (`src/expressions/evaluator.ts:29`, `:79`, `:151`). Tests
  exercise normalization, hostile/cyclic/deep values and lifecycle convergence
  (`test/canonical-json.test.ts:9`, `test/lifecycle.test.ts:36`) as well as graphs
  and expression policy. No required new model change was identified.

### `apps/api`

- **Names/layout:** feature-owned controllers, guards, modules, ports and errors
  are consistent with NestJS. CQ01 identifies a broad `connections/use-cases.ts`
  containing several change reasons. CQ05 identifies smaller token-placement
  inconsistency. Singular `node-testing/controller.ts`/`use-case.ts` versus plural
  files containing multiple classes is intentional, not a naming defect.
- **Guards/constants:** session authentication, CSRF and workspace capability
  checks are separate policies (`src/identity-workspace/guards.ts:34`, `:63`,
  `:82`). Read/cancel guards admit lifecycle states that start/replay guards do
  not (`src/workflow-runs/guards.ts:9`, `:24`, `:35`, `:46`). Preserve the repeated
  state lists unless one named policy genuinely owns identical semantics.
  Post-encryption/revocation abort checks also protect against cancellation during
  an await; they are not redundant with request-entry checks.
- **Readability:** CQ01's connection test path combines provider branches and
  mapping with orchestration. Conversely, OIDC validation and webhook ingress
  remain ordered security-sensitive debt; the long declarative Nest registration
  methods are not “complex” merely because they list many providers.
- **Interfaces/types/errors:** constructor injection and feature ports expose
  testable seams. HTTP/problem-details mapping remains centralized. Avoid merging
  feature ports into a universal repository or moving workspace authorization
  into generic decorators that hide the capability/status policy.
- **Runtime/tests:** The original F02/F04/F05/F06 and F09 gaps are resolved by
  the implementation and evidence table above.
  Existing HTTP-injection and use-case tests are useful but do not cover the exact
  production For Each initializer, early resource-construction failure, or late
  replica-write interleavings. Those need focused regressions through composition
  and persistence seams, not more assertions on already-correct isolated helpers.

### `apps/lifecycle-command`

- **Names/layout:** `config.ts`, `main.ts`, `run.ts`, `readiness-marker.ts` are
  sufficient for four focused source files; the package name supplies context.
  `runLifecycleCommandWorker` names the long-running responsibility explicitly.
- **Guards/constants/readability:** timeout-versus-lease bounds are validated in
  configuration. The runner distinguishes idle/released/stale polling outcomes
  and expected abort from real failure (`src/run.ts:23`). The `operationFailed`
  flag is intentional: it does not conflate a thrown `undefined` with no failure.
- **Interfaces/types:** injected bootstrap modules/resources
  (`src/main.ts:21`, `:43`, `:63`) and a two-operation readiness-marker interface
  make ownership testable without introducing a shared process framework.
- **Runtime/tests:** readiness is cleared before startup and during teardown;
  every cleanup operation is attempted and failures are aggregated. Bootstrap
  tests cover partial construction and listener removal (`test/main.test.ts:159`);
  runner tests cover abort/error distinctions (`test/run.test.ts:162`, `:196`)
  and compiled-process tests cover actual signal/exit behavior. External resources
  are mocked. No required coding-quality change was identified here.

### `apps/operator-command`

- **Names/layout:** `config.ts`, `main.ts`, `run.ts` follow the same small-app
  convention. The discriminated command names say what changes operational state.
- **Guards/constants/readability:** explicit command dispatch in `src/run.ts:42`
  is clearer than dynamic method lookup for privileged operations. Configuration
  requires bounded actor/reason/identity and mutation material; timeout cleanup
  is isolated in `boundedCleanup` (`src/run.ts:21`). Repeated command fields
  make audit material explicit rather than justifying a generic command framework.
- **Interfaces/types:** the runner receives a database capability, logger,
  telemetry and signal. The result union follows the command family; one logging
  assertion about `replayed` is a small narrowing opportunity, not a reason for
  advanced type machinery or a new abstraction.
- **Runtime/tests:** operation errors and cleanup errors are aggregated; startup
  tracks whether ownership transferred to the runner (`src/main.ts:18`, `:36`,
  `:55`). CQ02 is a concrete weakness: `test/run.test.ts:8` exercises only successful
  redispatch. Other routing, null status, cancellation, timeout and aggregate-error
  behavior need direct tests. Configuration tests do not establish runner behavior.

### `apps/recovery`

- **Names/layout:** `restore-before-serve.ts` is more informative than a generic
  `run.ts` for this one-shot gate. This intentional difference from daemon apps
  improves clarity; identical filenames are not the goal.
- **Guards/constants/readability:** pagination is bounded, explicitly rejects
  no progress, and advances both workspace/artifact cursors
  (`src/restore-before-serve.ts:43`). Sequential replica verification is visible
  and bounded; unbounded `Promise.all` would not automatically be an improvement.
- **Interfaces/types:** readiness, inventory and artifact verification sit behind
  a typed resource/result interface (`src/restore-before-serve.ts:17`, `:37`).
  The private inventory function keeps hashing/pagination out of bootstrap.
- **Runtime/tests:** readiness precedes reconciliation; failure still attempts
  cleanup (`src/restore-before-serve.ts:88`). Tests cover readiness order, bad
  replicas, page bounds, cancellation and cleanup failure
  (`test/restore-before-serve.test.ts:177`). Real multi-region restoration and
  bootstrap process behavior are not established by these mocked runner tests;
  no new source-level defect is inferred from that limitation.

### `apps/retention`

- **Names/layout:** `maintenance-loops.ts`, `metrics.ts`, `run.ts`, `config.ts`
  and `main.ts` separate scheduling, observation and process ownership cleanly.
- **Guards/constants:** named capped failure backoff and deduplicated readiness
  gates are clear (`src/maintenance-loops.ts:15`, `:37`, `:54`). CQ03 identifies
  the unexplained cross-package `scannedCount < 25` at `:152`.
- **Readability/interfaces:** eight named loops are repetitive but have different
  progress/pause conditions. Shared failure/recovery/readiness helpers already
  remove mechanical repetition. Do not replace all loops with a configurable
  mini-framework that hides when purge/enforcement continue or wait.
- **Runtime/types:** supervision is joined before ordered resource cleanup
  (`src/run.ts:38`, `:64`, `:70`). Keeping database-only maintenance independent
  from artifact/ledger readiness is intentional availability policy.
- **Tests:** `test/run.test.ts:215`, `:289`, `:339` exercise per-operation metrics,
  backoff and failure isolation. F01/F03/F04 require hold/deletion/finalization and
  in-flight PUT regressions at the database/storage orchestration seam. Current
  green loop tests do not establish those destructive protocols are safe.

### `apps/worker`

- **Names/layout:** `execution`, `transport`, `runtime`, `triggers`, `platform`
  and `config` separate attempt behavior, delivery, process supervision and Nest
  wiring. `node-attempt-handler`, `node-attempt-engine` and `node-attempt-runtime`
  describe different responsibilities; renaming them all to `service` would lose
  information. Provider-specific telemetry filenames remain discoverable.
- **Guards/constants:** identity/checksum/fence/dispatch-evidence guards protect
  different trust and timing stages (`src/execution/node-attempt-handler.ts:178`).
  `beforeDispatch` must reject duplicate dispatch and establish durable evidence;
  it is not redundant with claim admission. Outbox capacity sample intervals and
  bounds are named (`src/transport/outbox-dispatcher.ts:100`).
- **Readability/ownership:** attempt and preview handlers retain nested heartbeat,
  cancellation, execution and completion sequencing. Capability composition also
  contains both credential resolution and artifact spooling
  (`src/execution/node-runtime-capabilities.ts:108`, `:218`, `:371`). This is real
  navigation/readability debt, but the public factory is already small and owns
  shutdown. A future private connection/artifact split must retain that single
  ownership interface; do not create another public lifecycle for each helper.
- **Types/errors/runtime:** outcome unions distinguish duplicate, committed,
  failed and unknown outcomes; errors are translated at execution seams. Secret
  zeroization after canceled decryption, bounded spool writes, finalization and
  cleanup are explicit. Best-effort Redis resync failure is deliberately ignored
  after PostgreSQL commits (`src/execution/node-attempt-handler.ts:150`), not an
  accidentally swallowed authoritative failure.
- **Tests:** capability tests cover partial construction, borrowed runtime,
  cleanup failure, currency checks, zeroization, stream bounds and retention
  deadlines (`test/node-runtime-capabilities.test.ts:63`, `:406`, `:552`, `:728`).
  Process tests and lease/fence/outcome tests are useful. F02 still needs a
  regression through production initial-checkpoint selection rather than fixtures
  that preselect V2; full destructive resilience suites were not freshly executed.

## Additional maintainability and test findings

These are reviewable work items, not implementation changes and not additional
P1/P2 correctness defects. P3 means focused maintenance priority. Retained
state-machine/security complexity above is separately acknowledged, not silently
marked resolved or made an instruction for a repository-wide rewrite.

### CQ01 — P3: connection orchestration is hidden in one broad file

`apps/api/src/connections/use-cases.ts:85`, `:144`, `:207` and `:233` hold create,
rotate, revoke and test use cases; `:404` onward also contains credential decoding,
provider outcome mapping, hashing and response serialization. The test use case
combines three provider branches with nested exception handling. A provider-test
change requires navigating a 575-line file also owning unrelated mutation flows.
This is a concrete responsibility/discoverability issue, not a prohibition on
multiple classes per file. It was already retained pending a focused feature-local
split in the complexity register.

Direction: give connection testing and its provider outcome mapping an explicit
feature-local home; keep shared command types/serialization local to the feature,
and avoid one trivial forwarding file per class. Keep the current public use-case
interfaces and DI behavior. Verify create/rotate/revoke cancellation after external
work, secret cleanup, test authorization and every provider classification before
and after any extraction. Do not move or remove security checks to make it shorter.

### CQ02 — P3: operator runner tests do not exercise its operational contract

`apps/operator-command/src/run.ts:42` routes ten command variants and handles
readiness, cancellation, null status, operation failure and bounded cleanup.
`apps/operator-command/test/run.test.ts:8` contains one successful redispatch test.
Seven config tests do not cover that dispatch/teardown behavior.

Direction: add a table-driven runner test for each command-to-method mapping and
forwarded audit fields, plus null status, pre-abort/readiness failure, operation
failure, cleanup timeout and multiple cleanup failures. Assert other operations
are not called and cleanup is attempted exactly as owned. Test through
`runOperatorCommand`; do not export `boundedCleanup` solely to test an implementation
detail. No current dispatch failure was demonstrated.

### CQ03 — P3: retention batch capacity leaks into its caller

`packages/database/src/lifecycle/retention.ts:572` calls the scheduler with `25`;
`:585` and `:591` repeat that limit in result validation.
`apps/retention/src/maintenance-loops.ts:152` independently uses
`result.scannedCount < 25` to decide whether to pause. Changing the database batch
capacity requires knowledge of a literal in another workspace. The SQL function
also enforces `1..25` in
`packages/database/migrations/0055_standard_retention_classes.sql:170`; changing
that bound would require a new forward migration, not editing migration history.
The values agree today; this is policy duplication/change coupling, not a
demonstrated busy-loop bug.

Direction: keep knowledge of whether a batch was capacity-limited with its owning
database operation, or use an explicitly shared capacity policy if that is truly
part of the existing interface. A local `const` in each file would only rename
the duplication. Verify empty, partial and capacity-filled batches and the app's
pause/drain behavior together. Any interface change requires separate design and
implementation authorization; this audit does not prescribe a new signature.

### CQ04 — P3: catalog registration has two update sites

`packages/node-catalog/src/definition-resolution.ts:48` and
`packages/node-catalog/src/server.ts:62` independently enumerate core, HTTP, Slack
and email definition registrations. A newly shipped definition can be wired into
server execution without browser-safe lookup, or vice versa. Existing values agree.

Direction: use one browser-safe definition-registration collection within the
catalog implementation, retaining separate server executor assembly. Verify both
lookup and executable construction for every supported definition/release and
preserve package export/browser-safety tests. No new package or generic registry
framework is needed.

### CQ05 — P3: API authorization tokens have inconsistent homes

Most features expose DI tokens from `tokens.ts`, for example
`apps/api/src/connections/tokens.ts` and `apps/api/src/workflow-runs/tokens.ts`.
Schedules and webhooks instead define their authorization tokens inside
`guards.ts:7`; their modules must import token data from guard implementations.
This makes the same dependency-wiring task follow different navigation patterns.
It is a small consistency issue, not an authorization vulnerability.

Direction: align token ownership within those features with the established
feature-local convention when next editing them. Preserve symbol identity and
module bindings; verify Nest construction and read/update authorization. Do not
move every token into a global registry or rename otherwise clear feature files.

## Cross-part conventions and retained decisions

The right consistency is **the same role has a predictable home**, not identical
folder trees regardless of purpose:

| Role | Existing convention to preserve | Audit disposition |
| --- | --- | --- |
| Package entrypoints | Explicit `index.ts` and server/testing/capability exports | Keep curated exports; no app-to-package source traversal |
| Nest feature | Feature directory with controller(s), guards, module and owned ports/errors/tokens | CQ01/CQ05 are local exceptions to improve |
| Small process app | Config, bootstrap (`main.ts`), named runner and only necessary support modules | Keep; recovery's descriptive runner filename is intentional |
| Provider or core node | Domain directory with definition, schemas/validation and executor roles | Keep provider semantics local; do not flatten into generic utilities |
| Database capability | Capability directory; operation-specific persistence/transaction files | Keep authority and transaction ownership local |
| Larger pure model/engine | Domain or version-specific modules, canonical parsing and small public operations | Retain grammar/state-machine order rather than forced miniature files |
| Tests | Behavior-named tests plus explicit support/testing entrypoints | Add missing seam regressions, not one test file per source file mechanically |

No repository-wide rename of `types.ts`, `ports.ts`, `module.ts`, `config.ts`,
`server.ts` or `index.ts` is warranted: their directory/entrypoint role supplies
meaning. Short names become a problem when they collect unrelated behavior, as
CQ01 does. `service.ts` for a cohesive feature and `use-cases.ts` for multiple
operation classes are not automatically inconsistent abstractions.

Repeated checks were assessed semantically, not deleted by appearance. Examples
to preserve include workspace permissions versus RLS, executor entry validation
versus registry parsing, connection currency at dispatch versus initial lookup,
and post-await abort checks versus request-entry checks. Tiny identity helpers,
provider-specific error mapping and result-specific maintenance loops are not
automatically valuable abstraction opportunities.

The architecture guidance therefore influenced this assessment toward **local
ownership and behavior-tested seams**, not a new framework, universal repository,
shared “utils” package, rewritten state machine, or reopened ADR. The first coding
quality improvements are CQ02's test gap and CQ03's duplicated policy; CQ01/CQ04
are focused locality improvements and CQ05 is lower-impact consistency work.
The P1/P2 correctness findings remain higher remediation priorities.

## Verification for the expanded coding-quality pass

- A read-only ESLint diagnostic scanned **610 production TypeScript files** across
  all 18 parts, retaining the repository rules and adding `no-unreachable`,
  `no-else-return`, `no-lonely-if` and `no-useless-return`: **0 errors, 0 warnings**.
  Existing type-aware unnecessary-condition/assertion and constant-condition rules
  also remained active. This is evidence against mechanically redundant control
  flow, not proof that every domain condition is necessary.
- Fresh `pnpm build`, `pnpm architecture:check` (15 assertions),
  `pnpm complexity:check` (2 assertions) and `pnpm duplication:check` (6 assertions)
  passed. The duplication baseline still contains 27 source groups/512 lines and
  4 test groups/203 lines; passing means reviewed debt has not grown, not zero debt.
- The preceding **2,201 package/app tests and 15 selected PostgreSQL tests** are
  retained evidence at the same source revision, not advertised as newly rerun
  for this documentation expansion. No extra live-service or destructive suite
  was required to change the report.
- Final `pnpm docs:check` passed: 13 assertions and 292 validated local links;
  focused Prettier validation passed. No source, configuration, migration, test,
  dependency or deployment fix is part of this work. A temporary visual companion
  illustrates CQ01/CQ03/CQ04; the findings and all 18 verdicts are recorded here,
  so this report does not depend on that temporary file.

## Earlier part-specific source review notes

All ledger rows include package manifests, TypeScript project references and
Vitest configuration, not only implementation files.

### Package foundations and execution

- `node-sdk`: JSON size/depth boundaries, definition release contracts,
  executable types and executor interfaces. No additional confirmed issue.
- `node-catalog`: registration conflicts, immutable definitions and locked
  resolution. No additional confirmed issue.
- `nodes-core`: every node definition and executor, input validation, failure
  classifications and registration. F02 arises when apps choose the checkpoint,
  not from the For Each definition itself.
- `workflow-model`: graph/schema validation, identity, mappings and expression
  evaluation worker boundaries. No additional confirmed issue.
- `workflow-engine`: compilation, executable/checkpoint versions, admission,
  transitions, retry/cancellation, branch scope and structured iteration. The
  selected coverage configuration includes 28 of 48 source files; its percentages
  are not whole-package coverage. Synthetic checkpoint corruption without a
  legitimate producer was not promoted into a security finding.

### I/O and shared contracts

- `artifact-store`: streams, bounded reads, direct uploads, replication,
  object-version purge, control-ledger immutability, configuration and cleanup.
  F04 requires coordination with API admission and database cleanup. AWS/MinIO
  integration fixtures were inspected but not executed; retained immutable test
  objects are not automatically classified as a cleanup defect.
  Non-blocking test hygiene: `test/control-ledger.integration.test.ts:179–217`
  allocates four raw S3 clients without an `afterAll` destroy hook. Explicit
  teardown would clarify ownership; no hung test run was reproduced, and this
  observation is not counted among the nine confirmed findings.
- `contracts`: request/response schemas, bounded inputs, contract generation and
  generated OpenAPI. Schema validity alone does not prove agreement with guards.
- `integrations`: HTTP/Slack/Resend request boundaries, cancellation, bounded
  payloads, provider error handling, credential isolation and network validation.
  F05 is the mismatch with the deployment egress contract.
- `observability`: error/log redaction, telemetry attribute bounds, metrics
  cardinality, startup/shutdown and abortable timers. F08 is independently
  reproduced with the actual logger.
- `queue`: transport configuration, queue/job contracts, deduplication and
  ownership-aware closing. Unit checks do not prove Redis outage recovery.
- `rate-limit`: validated key/configuration boundaries, Redis command behavior,
  fail behavior and ownership. No additional confirmed issue.

### Database

Production-source inspection covers platform pools/readiness/telemetry,
configuration and migration execution; tenant identity/session/workspace access;
workflow authoring/publication and release compatibility; connection persistence;
trigger projection, webhooks and schedules; execution acceptance, outbox/inbox,
coordinator and node-attempt stores, preview/failure-notification/reconciliation;
artifacts, retention, control ledger, workspace lifecycle and operator commands;
and typed schema definitions. All 84 SQL migrations were inspected for schema,
grants/RLS, transactional state transitions, leases/fences and retention behavior.
F01, F03 and F07 remain the confirmed findings attributable to this package.

Manual test-inspection coverage is **partial**, not 159/159. The explicitly
verified primary-reviewer subset contains 29 TS test/support files: all eight
files under `test/support/`; configuration; database runtime unit/integration;
PostgreSQL telemetry unit/integration; migration checksum, execution-mode,
execution-plan and runner tests; package contract; readiness and serving-readiness;
schema shape; RLS; tenant-context hygiene; workspace transaction engine;
retention transaction and cancellation. The queue-duplicate SQL fixture and
targeted retention-artifact interleaving coverage were also inspected. Additional
test inspection informed the delegated source review, but its complete file
ledger was not reliably reconciled, so the remaining 133 TS files are not
claimed as exhaustively reviewed. Passing all 245 unit tests and 24 selected
PostgreSQL integration tests is execution evidence, not a substitute for that
missing manual-coverage evidence.

### Maintenance apps

- `lifecycle-command`: timeout-versus-lease validation, readiness marker,
  partial-bootstrap cleanup, signal listeners, expected-abort classification,
  polling and aggregate cleanup errors. Tests exercise both source seams and
  compiled child-process behavior with external dependencies mocked.
- `operator-command`: all command variants, explicit mutation/dry-run material,
  role configuration, dispatch, cancellation and bounded cleanup. Table-driven
  runner coverage now exercises all ten command variants, null status,
  pre-abort, readiness and operation failures, cleanup timeout, and multiple
  cleanup failures.
- `recovery`: bounded inventory/pagination, region/principal separation,
  readiness ordering, reconciliation, replica verification, cancellation and
  cleanup. The app tests mock storage/database; no live restore was performed.
- `retention`: shared runtime ownership, eight independent maintenance loops,
  deduplicated readiness, failure backoff, replica monitoring, metrics and shutdown.
  Existing tests cover failure isolation/recovery, not real destructive-I/O
  interleavings. The shared abortable delay resolves on cancellation; ordinary
  shutdown supervision awaits pending operations. No additional shutdown defect
  was confirmed.

### API

Reviewed all feature controllers/services/guards, Nest module boundaries,
runtime composition, HTTP errors and limits, sessions/CSRF/workspace permissions,
workflow publication/execution admission, SSE, artifacts, connections, webhook
ingress/management, schedules, previews and lifecycle endpoints. The original
F02/F04/F05/F06/F09 gaps are resolved by the implementation above.
API unit/HTTP-injection tests are not live database/Redis integration, compatibility
rollout, or SSE resilience evidence; those separate suites were inspected but
not freshly run during this pass.

### Worker

All production configuration, Nest composition, execution engines/handlers and
runtimes, provider capabilities/telemetry, transport dispatch and consumers,
trigger supervision, readiness, resource monitoring and process lifecycle were
reviewed. Tests cover identity/checksum binding, claims/fences, outcomes and
dispatch ambiguity, capability cleanup, bounded artifacts, preview deadlines,
failure notifications, lease renewal, retry/drain behavior and compiled-process
signals. The review includes 16 support TS files, 21 integration/resilience TS
files, remaining unit/fixture TS files and related process/retained-workflow
fixtures. F02 is resolved by the API and worker selector regressions; no
additional confirmed worker finding was identified.

The retained executable fixture is checked against its graph, exact envelope,
checksum and executor identities. By contrast, For Each integration fixtures
that preselect V2 do not prove the production initial-checkpoint selector works.
The fresh 278-test run is the configured unit/process cohort; the separately
inspected destructive integration/resilience suites were not run.

## Remaining verification limits and suggested order

The review covers every package and app, plus the cross-cutting contracts cited
above; it does not claim every infrastructure tool received a new line-by-line
audit. The build, architecture, deployment, dependency and documentation gates
provide the additional repository-level evidence listed earlier.

Full database integration, Redis transport/outage, compatibility rollout, real
restore and AWS policy/Object Lock suites were not rerun. Shared-service tests
can truncate fixtures, obliterate queues or stop PostgreSQL/Redis, so the fresh
integration selection used disposable local PostgreSQL fixtures instead. No
production environment, external provider, grant or cloud configuration was
modified.

The suggested implementation order was followed: F01/F02 first, F03/F04 as one
artifact-lifetime protocol, then the remaining owning boundaries and CQ items.
The resolution table and final verification record supersede the original open
status while preserving the original correction rationale below.

## Final implementation verification

Fresh post-implementation checks on 2026-09-08:

| Check | Result |
| --- | --- |
| `pnpm build` | Passed |
| `pnpm typecheck` | Passed across all 18 workspace projects |
| `pnpm lint` and `pnpm format:check` | Passed |
| `pnpm test` | Passed; 2,232 tests across all configured package/app unit cohorts, including focused lock-cancellation, migration-backfill, and startup-cleanup regressions |
| Selected database integration set | Passed; 9 files / 24 tests covering lifecycle locks, upload/retention races, preview deletion, schema ACLs, capacity scheduling, workspace purge and prior-head migrations |
| `pnpm contracts:check` | Passed; generated artifacts are current, all eight OpenAPI documents validate, 38 contract tests pass |
| `pnpm deployment:check` | Passed; 29 assertions plus runtime typecheck, deterministic render and deployment validators |
| `pnpm architecture:check` | Passed; 15 assertions and both graph validators |
| `pnpm database:schema:check` | Passed; all 68 migration-owned application tables accounted for |
| `pnpm dependencies:check` | Passed |
| `pnpm complexity:check` | Passed after refreshing the reviewed hotspot inventory; CQ01 removed the former 575-line connection use-case hotspot, while the lifecycle lock protocol deliberately extends existing database hotspots |
| `pnpm duplication:check` | Passed; 29 source groups / 527 lines and 4 test groups / 203 lines, with the lifecycle locking, separate trigger contracts, and provider outcome unions explicitly reviewed |

The selected PostgreSQL suites use disposable databases. The full shared-service
integration matrix and live AWS/provider behavior remain outside this run; no
production environment or external provider was modified.

## Source inventory baseline

Counts are inventory, not a claim that every file has already been reviewed.
Production means `.ts` files beneath `src/`; test/support means `.ts` files
beneath `test/`. Generated `dist/`, dependencies, caches, and coverage outputs
are excluded. Manifest, TypeScript, test-runner, and contract-generator
configuration are reviewed separately from those counts.

| Part | Production files | SQL migrations | Test/support files |
| --- | ---: | ---: | ---: |
| `packages/artifact-store` | 15 | 0 | 13 |
| `packages/contracts` | 23 | 0 | 8 |
| `packages/database` | 168 | 84 | 162 |
| `packages/integrations` | 32 | 0 | 9 |
| `packages/node-catalog` | 5 | 0 | 5 |
| `packages/node-sdk` | 10 | 0 | 2 |
| `packages/nodes-core` | 57 | 0 | 7 |
| `packages/observability` | 11 | 0 | 11 |
| `packages/queue` | 12 | 0 | 12 |
| `packages/rate-limit` | 4 | 0 | 3 |
| `packages/workflow-engine` | 48 | 0 | 28 |
| `packages/workflow-model` | 22 | 0 | 9 |
| `apps/api` | 138 | 0 | 86 |
| `apps/lifecycle-command` | 4 | 0 | 6 |
| `apps/operator-command` | 3 | 0 | 2 |
| `apps/recovery` | 3 | 0 | 2 |
| `apps/retention` | 5 | 0 | 3 |
| `apps/worker` | 54 | 0 | 73 |
