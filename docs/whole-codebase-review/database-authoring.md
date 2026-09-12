# Database workflow authoring, publication and restoration

Date: 2026-09-12. Primary reviewer fully read these 22 files, including all
seven integration suites and their shared support. The six isolated unit tests
passed (`pnpm exec vitest run test/workflow-authoring.test.ts` in the database
package). No integration test, database mutation or provider operation ran.
ADR 002 and existing compatibility/lifecycle contracts constrain the proposals.

## Individual file judgments

| File | Disposition | Specific judgment |
| --- | --- | --- |
| `packages/database/src/authoring/testing.ts` | KEEP | Explicit test-only options/hooks and repository exports make failure injection accessible without extending production role capabilities. |
| `packages/database/src/authoring/workflow-authoring-contracts.ts` | KEEP | Named command/result/page contracts distinguish revision saves, representation validators, lifecycle commands and historical restoration. Do not collapse these into a generic mutation. |
| `packages/database/src/authoring/workflow-authoring-errors.ts` | KEEP | Small domain errors preserve current revision/representation details and safe not-found behavior; no generic error framework needed. |
| `packages/database/src/authoring/workflow-authoring-records.ts` | KEEP | Persisted draft/version/workflow records name their separate identities and lifecycle state; ordinary types suffice. |
| `packages/database/src/authoring/workflow-authoring-rows.ts` | KEEP | Stored graph parsing and V1 checksum verification are appropriate fail-closed work. V2 checksum identifies compiled content, not a rehash of authoring JSON. |
| `packages/database/src/authoring/workflow-authoring-types.ts` | KEEP; REFACTOR WQ-148 | Shared internal context gathers transaction, authority, catalogs and hooks; static mapper injection can be reduced if it eliminates knowledge rather than creating more options. |
| `packages/database/src/authoring/workflow-authoring.ts` | KEEP; REFACTOR WQ-148; TEST WQ-144 extension | One pool lease composes focused stores. Compatibility-option normalization overwhelms factory assembly; preserve all authority invariants while separating that private concept. Actor revocation ordering needs the same qualification as connections. |
| `packages/database/src/authoring/workflow-authoring-drafts.ts` | KEEP | Atomic creator, exact-revision save, locked compatibility selection and retained-node placement checks are coherent. Input named emptyGraph is not evidence that every internal fixture must have no nodes. |
| `packages/database/src/authoring/workflow-authoring-lifecycle.ts` | KEEP; TEST WQ-148 | Distinct activate/deactivate/archive/unarchive state rules, idempotency and outbox facts justify explicit branches. Preserve archived visibility and no-op/replay semantics. |
| `packages/database/src/authoring/workflow-authoring-reads.ts` | KEEP | Validated bounded keyset pages and explicit tenant predicates are readable. Finite date validation exists; timestamp precision has a database contract, so do not invent a microsecond cursor defect. |
| `packages/database/src/authoring/workflow-authoring-version-restore.ts` | KEEP | Restoration copies a retained snapshot into the mutable draft under locks and placement checks; it does not republish or mutate historical versions/runs. |
| `packages/database/src/authoring/workflow-publication.ts` | KEEP; CONDITIONAL WQ-147 | Named claim/locked-compile/version/projection/fact phases make atomic publication readable. Full retained-history materialization is a scaling concern with deliberate corruption-detection behavior. |
| `packages/database/src/authoring/workflow-trigger-reconciliation.ts` | KEEP | Small explicit outbox insertion localizes event/payload vocabulary shared with lifecycle work; no provider operation escapes the transaction. |
| `packages/database/test/workflow-authoring.test.ts` | KEEP | Strict identifier-only payload checks and six migration-contract tests passed. SQL substring tests describe historical DDL, not live RLS/readiness qualification. |
| `packages/database/test/workflow-authoring-atomicity.integration.test.ts` | KEEP; TEST WQ-149 | Strong row counts and injected publication steps, but empty graphs do not exercise nonempty usage/trigger projection rollback. One random-version null assertion is not proof that no version was written. |
| `packages/database/test/workflow-authoring-coordination.integration.test.ts` | KEEP; FIX fixture WQ-149 | Real lock-order scenarios are important; final save-first/publish-first blocks can enter teardown with their JavaScript barrier still unreleased. |
| `packages/database/test/workflow-authoring-drafts.integration.test.ts` | KEEP; TEST WQ-147/WQ-149 | Revision races, rollback, tenancy and corrupt retained-version rejection protect real contracts. Preserve rejection of corruption in a nonmatching historical version. |
| `packages/database/test/workflow-authoring-lifecycle.integration.test.ts` | KEEP; REFACTOR fixture WQ-149 | Before/after durable facts plus retry after each injected failure establish lifecycle atomicity. Barrier release in finally is worth preserving; early operation failure must also settle the entry wait. |
| `packages/database/test/workflow-authoring-publication.integration.test.ts` | KEEP; TEST WQ-146/WQ-149 | Exact replay, executable identity versus presentation, compiled authority and rebuilding missing usage are substantive. Usage discovery needs complete multi-page traversal. |
| `packages/database/test/workflow-authoring-readiness.integration.test.ts` | FIX fixture WQ-149 | Commits policy/grant/search-path/index drift against configured shared state and restores literals. Move to an owned disposable database before execution. |
| `packages/database/test/workflow-authoring-version-restore.integration.test.ts` | KEEP; REFACTOR fixture WQ-149 | Detailed stale-validator, retained-placement, rollback and unchanged run/version identity evidence merits retention. A seeded completed run proves row preservation, not execution delivery. |
| `packages/database/test/support/workflow-authoring.integration.support.ts` | FIX fixture/REFACTOR WQ-149 | Import-time runtime and shared global compatibility reset obscure lifetime and make suite isolation unsafe; explicit owned fixtures are needed. |

## WQ-147 — bound publication's retained-history working set without weakening validation

P2 CONDITIONAL. `workflow-publication.ts:241–290`, especially 248–257, fetches
every retained version including JSON bodies into one result and maps every row
for every fresh publication, while workflow/draft/compatibility locks are held:

```ts
const retained = await client.query(/* all versions ordered by version_number */);
for (const row of retained.rows) {
  const version = dependencies.mapVersion(row);
  if (version.checksum === publication.checksum) versionRow = row;
}
```

Per-graph bounds do not bound total retained-history bytes. The code's work
scales with retained graph count and size even for unchanged content. This is
source evidence of repeated allocation/validation, not a measured latency or
outage claim. The last drafts integration case intentionally corrupts a retained
nonmatching version and expects publication to reject it. A checksum-only
`LIMIT 1` lookup would silently remove that behavior and is not an acceptable
routine optimization.

First benchmark realistic histories with small and near-limit graphs, measuring
peak memory, validation duration and lock hold time for reused/new content.
Include supported V1/V2 retained records and current transaction budgets. If
material, use an ordered bounded-batch/cursor scan that still validates every
retained record and retains only the matching row. Establish a stable scan upper
bound/snapshot and current workflow lock order; do not let paging skip concurrent
history or create duplicate version numbers. Batching limits memory but does not
remove total validation cost: report those separately. If reducing validation
frequency is necessary, that needs an explicit integrity contract and invalidation
design, not a speculative cache. KEEP current behavior if the measured workload
does not justify the complexity.

Acceptance: corruption in first/middle/last and nonmatching historical rows still
fails before mutation; unchanged semantic content reuses the same stored snapshot;
presentation edits do not rewrite it; current unique checksums/version numbers,
concurrent one-winner publication and exact replay remain intact. Benchmark
evidence must compare equivalent behavior under the same retained histories.

## WQ-148 — localize compatibility normalization and clarify trusted data contracts

P2/P3 REFACTOR/TEST. `workflow-authoring.ts:297–438` combines option-mode
validation, authority parsing, matching catalogs, retained history, bounded
readiness sets and runtime variant selection before ordinary store assembly.
The invariants are real; the reading burden is their interleaving with ownership.
Prefer a private normalization concept with explicit modes, then one selection
operation rather than more optional booleans:

```ts
const publicationAuthority = normalizePublicationAuthority(options);
// validates singular vs rolling variants before acquiring an owned pool
const selectCatalogs = (client: Pick<PoolClient, 'query'>) =>
  publicationAuthority.selectLocked(client);
```

This is an illustrative private shape, not a required new exported class or
interface. Preserve exact epoch/fingerprint/catalog JSON comparisons, compiled
and placement catalog matching, rejected mixed singular/variant options, bounded
readiness for histories longer than two, and replay before current-authority
validation. Completed replay after authority changes is intentional and tested.
Do not use malformed-new-option fallback to legacy mode. Tests should exercise
factory admission with an injected matching runtime and no live database monitor.

The static mapDraft/mapVersion/mapWorkflow functions are passed through several
internal contexts despite having one implementation. Direct private imports may
make dependencies easier to follow; retain actual transaction/authority/hooks
seams. Apply only if it removes plumbing and leaves call order legible. The comment
at line 439 says "Runtime import is kept here" although it precedes acquiring an
already imported pool lease; correct it to explain actual delayed acquisition, or
remove it. Name benchmark outcome classification instead of a long nested ternary
if that improves the publication result path; don't split every small helper.

Authority checks at 215–249 read membership/actor/workspace without share locks.
Extend WQ-144's controlled revocation-order test to save/publish/lifecycle commands
before proposing stronger locks. Use existing capability role mappings only
where exactly equivalent; keep safe not-found disclosure. No claim of an observed
authorization exploit follows merely from READ COMMITTED reads.

For durable publish/lifecycle result decoding, add mismatched stored workspace/
workflow/result-identity cases if fail-closed corrupted-row handling is promised.
Schema-valid result JSON alone does not establish command identity. Current
normal writers populate matching identifiers; this is hardening evidence, not a
public request bypass. V2 compiled checksum is a trusted compiler result checked
against locked release metadata; do not incorrectly compare it to V1 authoring
graph identity or turn this refactor into a replacement compiler.

Keep occurrence counting for retained retired definitions: identity is the
node-ID/definition occurrence, not necessarily its old nesting path. Existing
nodes may remain while newly placed unavailable definitions are rejected. Changing
that rule requires compatibility tests and a product contract, not a cleaner loop.

Acceptance: normalization tests cover each rejected combination and supported
legacy/rolling mode; exact replay, stale representation tags, restoration, immutable
history and role/tenant denials are unchanged. No new public seam or flag matrix.

## WQ-149 — make authoring integration fixtures safe and rollback claims meaningful

P2 FIX fixture/TEST. `workflow-authoring.integration.support.ts` constructs the
runtime at module evaluation (103–105); suite setup resets the global current
compatibility pointer before creating workspace fixtures. Seven integration files
share this pattern against configured URLs. Readiness tests then commit global
schema drift and restore hard-coded policies/grants/settings. These tests must
own disposable databases before this review would execute them. Reuse exact-name,
owned database helpers, not a permissive URL-suffix check or unconditional drop.
Keep privileged setup separate from runtime-role assertions.

`workflow-authoring-coordination.integration.test.ts:332–340,402–412` releases
its save/publish barrier only on the happy path. If lock observation/assertion
fails first, finally closes a pool with a transaction still awaiting that barrier.
SQL statement timeouts cannot resolve a JavaScript deferred promise. Every started
operation must be immediately observed, every barrier released in finally, then
all operations drained before runtimes close. Entry waits must race operation
settlement so an error before the hook cannot strand the test. Keep the primary
assertion failure while reporting cleanup failures; attempt all owned closes.
Lifecycle/restore already release barriers in finally; preserve that and fix their
early-entry-wait failure path too.

`waitForPostgresLock:124–145` uses 200 setImmediate polls, not an elapsed-time
budget, and matches any Lock wait with application_name alone. Match database,
exact waiter/backend and expected blocker/lock relation as appropriate; bound
connection/query/overall waits and include safe last-observed evidence on failure.
Do not replace controlled interleaving with a fixed sleep.

Several explicit BEGIN/assert/ROLLBACK blocks only release in finally; an assertion
can return an open transaction to the pool. Always rollback/end safely, release
even when rollback fails, and discard a damaged client. Register cleanup after each
acquisition so a later factory failure cannot leak earlier owners. Split independent
stories into per-case valid fixtures where global draft revisions/list counts
currently assume earlier tests. Do not hide transaction order in a generic helper.

Rollback evidence improvements:

- The atomicity step loop uses an empty graph. Zero usage/trigger rows after failure
  proves zero stayed zero, not rollback of actual inserted projections. Add valid
  nonempty integration and trigger graphs with owned connections/catalogs, inject
  failure after each real write, and assert exact before/after durable facts.
- Reuse a published version with existing nonempty projections and force failure
  after deletion/rebuild; assert the original projection rows remain unchanged.
  Preserve the separate successful missing-usage rebuild test.
- Replace getVersion(randomUUID()) === null as evidence of no publication with
  counts/identities scoped to the actual workflow, plus unchanged pointer, audit,
  idempotency and outbox facts. Do not remove useful cross-tenant null checks.
- Extend WQ-146 with full usage-page traversal rather than only a single-item page.
- Existing lifecycle/restore fault tests compare persisted facts and retry the same
  command; retain these. Overlong trace ID deliberately causes a late database error
  in one rollback case. If input validation moves earlier, replace that late fault
  with another controlled database failure rather than losing rollback coverage.

Order: fixture isolation/teardown first, behavior/evidence additions second,
selective normalization refactor third, measured history optimization last. No
source, migration, runtime state, commit or push changed during this review.
