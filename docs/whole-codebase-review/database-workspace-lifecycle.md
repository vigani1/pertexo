# Database workspace lifecycle commands and purge

Date: 2026-09-12. Primary reviewer fully read these seven files, including both
integration suites. Three cancellation unit tests passed (445 ms).
Service-backed tests were not run. Findings extend the
retention/control-ledger records rather than duplicating their remediation.

## Individual file judgments

| File | Disposition | Specific judgment |
| --- | --- | --- |
| `packages/database/src/lifecycle/workspace-lifecycle-commands.ts` | FIX WQ-194/WQ-195; REFACTOR/TEST WQ-198 | Durable authorization precedes external append so accepted partial writes remain repairable. Exact record and final projection-anchor comparison are good. Private transaction swallows every rollback failure; claim/readiness use signal-shaped query config without cancellation ownership; catch cleanup has no deadline. |
| `packages/database/src/lifecycle/workspace-purge.ts` | FIX WQ-193; REFACTOR/TEST WQ-199 | Bounded object/row pages, zero-delete completion verification, lease fencing, partial claim capture and short transactions are intentional. Discovery correctly uses inRetentionTransaction. Three ordered scenarios dominate processNext; candidate/repair/append checks repeat with weaker page metadata checks in the second reconcile. |
| `packages/database/src/lifecycle/testing.ts` | KEEP explicit testing exports | Grouped lifecycle test seams expose concrete factories/types, not an alternate runtime facade. Deleted preview-cleanup exports are absent; keep consumer import migration evidence with the existing dirty change. |
| `packages/database/src/execution/testing.ts` | KEEP explicit testing exports | Large export list reflects the broad execution test surface, not execution logic. Existing namespace grouping and type-only exports aid navigation. Do not merge role-specific production exports into this facade. |
| `packages/database/test/workspace-purge-cancellation.test.ts` | KEEP; TEST WQ-199 | Covers pre-abort, disposal during discovery and late checkout. Fake client disposal rejects blocked work. Strengthen the discovery checkpoint to wait for the target query itself, not any setup query. |
| `packages/database/test/workspace-purge-foundation.integration.test.ts` | KEEP; TEST/REFACTOR WQ-193/WQ-199 | Meaningful ambiguous append/delete repair, fencing, tombstone redaction, held-step recovery, no-open-transaction and observed PostgreSQL lock cancellation checks. Sequential shared discovery state and all-exit resource draining need explicit fixture ownership. |
| `packages/database/test/workspace-lifecycle-command-intents.integration.test.ts` | KEEP assertions; REFACTOR/TEST WQ-198 | Tests least privilege, revoked ownership, durable intents, side effects, repair, fencing and expired restore. firstOperationId and one workspace couple separate tests into an undocumented ordered scenario. Twenty-millisecond sleep and optional lease fields weaken the evidence. |

## WQ-198 — own lifecycle transaction failure and name its durable phases

P1 cleanup fix is owned by WQ-195; P2 REFACTOR/TEST here. In
workspace-lifecycle-commands.ts:217–249, rollback rejection is ignored and
releaseError is set only on cancellation. An ordinary operation failure plus
rollback failure therefore returns the client clean. Track cleanup failure
independently of its rejection value and preserve the initiating error. Use the
existing transaction owner when compatible with lifecycle authority; do not
introduce another near-copy. WQ-194 must also cover readiness, claim and catch
release/fail queries: pre/post abort checks do not stop an in-flight pg query.
Give cleanup a separate bounded lifetime rather than the already-aborted work
signal, and do not report successful release until SQL confirms it.

Keep these phases visible in processNext: claim → commit append authorization →
read anchor → reconcile/repair or append → verify exact material → re-lock,
compare anchor and project/complete. This ordering is a durable protocol, not
incidental complexity. A private prepareAppend and projectExactRecord can hide
SQL setup while preserving the phase names. Replace the nested released/failed/
stale ternary at the return with an explicit outcome decision after changed is
decoded. Preserve the distinction between retryable errors and the two exact
SQLSTATE/message combinations representing permanent failure. Read unknown
error properties defensively so a getter/proxy cannot prevent lease cleanup.
Cache close() as in WQ-171; verify the telemetry role for custom role names
instead of depending on username inference.

Acceptance: isolated tests for every phase failure, rollback Error/string/null/
undefined, aborted claim/SQL/reconcile/append/projection/cleanup, lost append ACK,
revocation before and after durable append authorization, changed=false cleanup,
invalid record/hash/page end and projection fence mismatch. Assert append count,
transaction boundaries, retained original cause, disposal count, final lease
state and no external I/O in an open transaction. Do not claim a prompt race
settlement proves noncooperative ledger work has stopped.

Integration fixture change: create a workspace and durable operation per test,
or explicitly combine a genuine chronological scenario into one named test.
Do not let firstOperationId connect independent it blocks. Require each claimed
row before constructing arguments; make lease expiry deterministic via the
existing owner fixture seam rather than a 20 ms sleep. Restore suspended
membership in finally. Place readiness assertions inside coordinator cleanup
scope and drain paused operations even when the observer assertion fails.

## WQ-199 — separate purge phases without hiding destructive authorization

P2 REFACTOR/TEST, depends on WQ-193 serialization design. In
workspace-purge.ts:345–871 split private processStep, processCompletion and
processStart methods returning an explicit handled/absent distinction. An idle
claim race is a handled result and must not accidentally fall through to another
discovery path. Keep stepClaim captured immediately after SQL claim and before
tenant-row execution: otherwise a thrown page operation loses the lease needed
for cleanup. Keep advisory lock ownership around the actual destructive effect,
not just around preparation or a raced timeout promise.

Completion :507–673 and start :711–847 repeat anchor/candidate repair/prepare/
append-anchor/reconcile/append/verify/project phases. Extract private exact-page
validation and record verification with a narrowly typed expected material;
retain scenario-specific SQL and completion authorization. Second reconciliation
:602–617 and :782–797 checks record count/high-water flags but not pageEndHash/
pageEndSequence as the lifecycle command coordinator does. Add malformed adapter
tests before deciding whether this is a defensive contract fix or redundant
validation guaranteed by the production ledger. Also test recordHash equal to
previousHash: purge verification currently differs from lifecycle verification.
Never normalize signed fields in place.

Acceptance: branch matrix for absent, race, held, stale anchor, repaired append,
ambiguous append, failed delete, delete-success/checkpoint-failure, partial claim,
completion/start lease release=false, malformed page and already-aborted signals.
Assert per-page bounds and the final empty object-store verification. Time each
whole lease-bearing operation, not just one external call plus one statement;
multiple short transactions and separately renewed timeouts can exceed the
option formula. Preserve fail-closed fencing if a lease expires.

Improve test doubles deliberately: MemoryObjectPurgeStore currently models calls,
not actual version deletion; MemoryPurgeLedger's artificial hashes do not prove
cryptographic chaining. Keep these focused decision tests and add the real
database/ledger-interleaving evidence requested by WQ-193. Unit discovery abort
should wait for find_due_workspace_purge_step, then assert it was in flight and
that no completion/start discovery or provider call followed. Every opened pool
must be attempted during teardown even if an earlier close fails; pool.query
transaction fixtures should reserve one client. Drain paused purge promises on
all exits. No provider erasure or live integration execution was performed here.
