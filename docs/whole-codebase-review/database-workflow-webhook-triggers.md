# Database workflow-trigger reconciliation and webhooks

Date: 2026-09-12. Primary reviewer fully read all 14 files below; hashes match
the frozen inventory. Six selected unit tests passed. The two database suites
were read completely, not executed. An injected constructor probe intercepted
all PostgreSQL queries and cleaned up captured pools; no connection was made.
Numbered SQL bodies and schedule implementation have separate review entries.

## Individual file judgments

| File | Disposition | Specific judgment |
| --- | --- | --- |
| `packages/database/src/triggers/workflow-triggers.ts` | KEEP; REFACTOR WQ-154 | Durable event/payload/delivery identity checks are necessary. Receipt completion before throwing stale-publication outside the transaction is intentional; duplicate delivery returns no new work. Large mixed verification expression can become private phases. |
| `packages/database/src/triggers/workflow-trigger-materialization.ts` | KEEP; REFACTOR WQ-154 | Retires prior-version resources, anchors schedules to one database observation, verifies immutable fingerprints and preserves explicit disablement. The repeated SQL disposition predicates are a real paired-field maintenance burden. |
| `packages/database/src/triggers/workflow-trigger-activation.ts` | KEEP | Workflow-first configuration lock order is explicit. Archive pauses effective admission and clears claims without erasing saved endpoint/schedule intent; do not turn this into permanent configuration disablement. |
| `packages/database/src/triggers/workflow-trigger-health.ts` | KEEP | One validated public projection excludes credentials; workflow-model owns aggregate activation. endpointReady describes an active configured endpoint, not overall ingress eligibility, including during archive. |
| `packages/database/src/triggers/workflow-trigger-errors.ts` | KEEP | Two stable, distinct errors encode mismatched transport versus stale publication; no hierarchy/framework needed. |
| `packages/database/src/triggers/trigger-management-access.ts` | KEEP; CONDITIONAL WQ-144 extension | Validates parent/actor/tenant and acquires workflow authority before configuration. Membership/workspace/user reads are not locked: apply the existing explicit revocation-linearization decision, not an unproved security finding. |
| `packages/database/src/triggers/workflow-trigger-projection.ts` | KEEP; TEST/CONDITIONAL WQ-155 | Version-specific strict configs and stable digest fixtures are appropriate. Graph disabled is ignored; establish intended external-activation semantics before changing that behavior. This is a publication projection, not a replacement graph validator. |
| `packages/database/src/triggers/webhook-triggers.ts` | KEEP; REFACTOR/TEST WQ-156; FIX WQ-157 | Transactional authority, sealed references, parent-bound commands, replay and acceptance earn a deep repository. Two replay branches obscure expiry handling. Owned pools start before compatibility validation and escape cleanup if it throws. |
| `packages/database/src/triggers/testing.ts` | KEEP | Explicit testing exports preserve the package's trigger, schedule and recurrence test seams; not an unnecessary public abstraction. |
| `packages/database/test/workflow-trigger-projection.test.ts` | KEEP; TEST WQ-155 | Exact golden fingerprints and V2/V3 strict-timezone cases are meaningful. Add explicit graph-disabled policy evidence; don't casually regenerate expected hashes. |
| `packages/database/test/webhook-triggers.integration.test.ts` | KEEP; TEST/fixture REFACTOR WQ-158 | Real parent binding, concurrent dedupe, lifecycle convergence and rotation gates are valuable. Several scenarios depend on earlier cases and sealed-reference/expiry assertions need stronger scope. |
| `packages/database/test/webhook-trigger-prior-head.integration.test.ts` | KEEP; TEST WQ-158 | Creates random isolated database and exact 0040 prefix. Suffix application is checked, but no retained endpoint/secret/replay data proves preservation through hardening. |
| `packages/database/test/webhook-trigger-migration.test.ts` | KEEP; TEST WQ-158 | Useful historical SQL tripwire for forced RLS, credentials and retention; substring presence is not runtime grant or trigger enforcement proof. |
| `packages/database/test/operator-trigger-reconciliation-migration.test.ts` | KEEP; TEST WQ-158 | Checks narrow wrapper and fresh delivery syntax without granting operator DML. Needs complementary live role/invariant proof, not removal of static coverage. |

## WQ-154 — make reconciliation authority and materialized disposition legible

P2 REFACTOR. In workflow-triggers.ts:126–147, aggregate identity, persisted
payload identity, canonical checksum and optional transport receipt checks all
share one OR expression. These are distinct proof phases, not excessive domain
rules. Use private assertStoredReconciliationIdentity and assertDeliveryIdentity
helpers, or equivalently named sequential guards. Preserve every field, checksum
normalization, optional-delivery distinction, and current error contracts. Do not
replace exact equality with permissive matching or add a public validation layer.

In workflow-trigger-materialization.ts:125–158, status and health_status repeat
the same enabled-schedule/active-endpoint/disabled-resource EXISTS decisions:

```ts
// Proposed private SQL shape, not implemented:
// resource_disposition: active | disabled | configuration_required
// status = disposition
// health = active ? healthy : disabled ? disabled : pending
```

Prefer one scoped SQL disposition calculation and explicit mapping to the pair
of columns, retaining one atomic UPDATE and current precedence. If a CTE/join
makes row identity or locking harder to verify, retain the SQL and instead add
the complete paired-column matrix and an explanation of the duplication. Do not
introduce a generic status-machine framework or per-row application updates.

Acceptance: mutate each of the transport identity fields independently and
prove no receipt/trigger effects on mismatch; stale current-version authority
commits receipt then reports stale; duplicate is inert. Matrix covers schedule
enabled/disabled, webhook active/disabled/absent, archive/restore, prior-version
retirement and inconsistent immutable fingerprints. Preserve current archive
endpointReady behavior and global/partial failure projections. Run existing
publication, trigger and worker reconciliation integration in isolated fixtures.

## WQ-155 — specify graph-disabled trigger behavior before modifying projection

P2 TEST/CONDITIONAL. workflow-trigger-projection.ts:85–106 materializes known
trigger identities regardless of node.disabled. Its digest covers config and
kind only. Engine disabled invocation semantics skip execution; neither that
fact nor ADR 002's deliberate inclusion of disabled in workflow identity alone
settles whether a graph-disabled trigger should accept external deliveries.
ADR 014/026 describe configuration disablement, a different stored state.

Add a focused contract case covering disabled absent/false/true for webhook and
each retained Schedule identity through publication, reconciliation and ingress
or scanning. If disabled is intended only for execution, KEEP the projection
and document that distinction. If it must suppress external activation, define
desired/effective behavior and restoration first, then update projection and
materialization together; do not simply filter rows and accidentally orphan
existing endpoints. Preserve published history and existing fingerprint identity
unless an explicit compatibility decision authorizes a versioned change.

This is an unresolved semantic qualification, not a demonstrated vulnerability.

## WQ-156 — give webhook replay one lock/read/expiry decision

P2 REFACTOR/TEST. webhook-triggers.ts:496–572 first queries existing replay with
an advisory-lock expression and row lock. The absent-row path then explicitly
takes the advisory lock and repeats the select and active/mismatch/incomplete
decision. The original expired row is deleted; an expired row in the second
read has no corresponding delete before the later INSERT.

The source asymmetry is certain; reachability of that second expired result
under production timeout/retention/concurrency behavior is not established by
this offline review. Do not label it reproduced duplicate acceptance or a proven
deadlock. Normal concurrent fresh acceptance already has a real integration test.

Proposed shape:

```ts
await lockEndpointDedupeKey(transaction, identity);
const replay = await readLockedReplay(transaction, identity);
if (replay?.active) return resolveExactReplay(replay, fingerprint);
if (replay) await deleteExpiredReplay(transaction, identity);
// Existing new-delivery eligibility and atomic run acceptance follow.
```

Keep helpers private and retain transaction-scoped hash key, tenant/endpoint/
dedupe-kind scoping, database time, exact byte fingerprint, same-run return,
five-minute/24-hour windows, and all-or-nothing delivery/run/outbox persistence.
Do not move external crypto or provider work into the transaction. Measure query
count/contended latency if unconditional locking changes the common replay path.
Tests must deliberately coordinate two sessions for absent, active, expired and
concurrently replaced records; distinguish cleanup racing expiry from acceptance
racing another acceptance. Prove one new delivery/run, exact replay, changed
fingerprint conflict, and no extra rows on failure. Explicitly test stale
verification replay versus new admission after rotation/archive; don't silently
change already-accepted replay policy while simplifying conditions.

## WQ-157 — validate compatibility before acquiring the webhook pool

P2 FIX. webhook-triggers.ts:297–307 calls acquireDatabasePool before parsing the
required compatibility release/set. Invalid configuration throws before the
returned repository provides close(). A source probe passed an empty release
set, intercepted Pool.query, and observed: rejected=true, two pools constructed,
one immediate monitor query, both ending=false before probe cleanup. The two
pools are the repository and its lock-wait monitor. This reproduces failed-
construction ownership loss without connecting to PostgreSQL.

Parse the entire pure configuration first, then acquire ownership. If later
fallible setup is ever added, make its partial-construction cleanup explicit.
Tests: invalid single/set input causes zero pool creation or monitor activity;
valid owned close is idempotent; injected shared runtime remains borrowed and
open when this repository closes or validation rejects. No new lifecycle wrapper
is necessary. Audit adjacent constructors when implementing this exact pattern,
but do not use this finding as permission to refactor every repository factory.

## WQ-158 — make trigger evidence independent and time-authority aware

P2 TEST/fixture REFACTOR. webhook-triggers.integration.test.ts:959 onward has an
ordered root endpoint story: provision, dedupe, 61 ingress attempts, rotation,
then suspension/retry. Selected later cases fail without earlier state. Use a
test-owned workflow/endpoint factory per independent scenario; preserve coherent
multi-step assertions within a single scenario. Move acquisition under owned
setup and ensure every closer/drop is attempted even if an earlier closer fails.
Random database names are appropriate; don't replace them with shared-schema
resets. Apply WQ-150 disposal hygiene to ownerQuery/workerQuery test helpers.

The overlap assertion near 1530 subtracts Date.now() from a database timestamp
and only checks >290 seconds. Compare with the returned databaseTime, bound both
ends, and test previous-secret acceptance before and rejection after persisted
expiry. Test keyed and fingerprint expiry independently. The workspace rejection
case fails before replay INSERT; it is useful eligibility evidence but is not
proof of rollback after partial acceptance. Inject a failure after replay/run
creation at an existing safe test seam and compare all durable row counts.

The root checkpoint factory uses empty executable JSON and empty ready state;
keep it scoped as an acceptance-storage fixture, not evidence of executable
trigger correctness. Retain separate real compiled graph integration. Extend
prior-head migration qualification with seeded retained rows and runtime-role
checks, and retain static migration tests as tripwires only. Do not rewrite
historical migration SQL to satisfy cleaner test expectations.

Implementation order: WQ-157 independently; WQ-158 fixture/evidence work; WQ-154
and WQ-156 as separate behavior-preserving changes with their matrices; WQ-155
only after its explicit semantic gate. No implementation was performed here.
