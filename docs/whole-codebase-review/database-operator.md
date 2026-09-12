# Database operator commands and worker reconciliation

Date: 2026-09-12. Primary reviewer fully read all 17 files below and ADR 029.
Eight selected unit/static suites passed: 14 tests, 455 ms. An intercepted-source
runtime probe made no connection and confirmed pre-abort checkout, lack of
in-flight abort settlement and repeated-close rejection. All 17 inventory hashes
matched. Retention/operator integration and related replay tests were read, not
executed. Numbered migrations are reviewed separately; static tests are not live
SQL qualification.

## Individual file judgments

| File | Disposition | Specific judgment |
| --- | --- | --- |
| `packages/database/src/operator/operator-command-runtime.ts` | FIX/TEST WQ-171; KEEP privileged seam | Dedicated max-one pool, bounded statement/lock timeouts, exact role and narrow capability checks match ADR 029. Cancellation does not interrupt pg, pre-abort acquires a client and close is not memoized. Failed rollback needs WQ-150 disposal. |
| `packages/database/src/operator/operator-commands.ts` | KEEP explicit methods; FIX/TEST WQ-172; TEST/REFACTOR WQ-173 | Typed command inputs and parameterized narrow functions make authority visible. Evidence JSON can be transformed during serialization; replay validation recurses before its cap. Repeated result parsing can become private schemas without hiding command argument order. |
| `packages/database/src/operator/operator-command-contracts.ts` | KEEP | Stable options and generic command-result shape avoid coupling the runtime back to the larger method facade. Small dependency-light contract is justified. |
| `packages/database/src/operator/operator-command-errors.ts` | KEEP | A distinct conflict type is valuable to operational callers; preserve durable conflict audit before throwing it. |
| `packages/database/src/operator/operator-run-replay.ts` | KEEP atomic worker path; WQ-157 extension; TEST WQ-173 | Verifies durable outbox identity, request, retained workflow and compatibility before atomic acceptance/completion. Constructor parses release after creating its database. Optional runId typing could be made discriminated only if useful to callers. |
| `packages/database/src/operator/testing.ts` | KEEP | Explicit operator/replay test exports match ownership without exposing implementation helpers in the serving API. |
| `packages/database/src/execution/unknown-outcome-reconciliation.ts` | KEEP; TEST WQ-173 | Validates exact evidence/outbox identity and current unknown outcome inside inbox transaction. It intentionally acknowledges evidence, not changes historical attempt outcome or calls a provider. |
| `packages/database/test/operator-command-runtime.test.ts` | KEEP; TEST WQ-171/WQ-173 | Six cases prove readiness success ordering and selected denial groups through injected pool. They do not prove command execution, true driver cancellation, failed rollback disposal or repeated close. |
| `packages/database/test/inbox-cancellation.test.ts` | KEEP propagation test; TEST WQ-173 | Immediately observes rejection and confirms signal forwarding/no completion. Fake races never-settling work and sets rolledBack itself; it does not prove PostgreSQL cancellation or rollback. |
| `packages/database/test/operator-command-ledger-migration.test.ts` | KEEP static guard; TEST WQ-173 | Checks command vocabulary, result bound and narrow get grant; substring presence is not permission or runtime behavior proof. |
| `packages/database/test/operator-execution-recovery-migration.test.ts` | KEEP static guard; TEST WQ-173 | Asserts private core, command wrappers, due-work bound/index and no operator DML. Retain complementary live role, fence and idempotency cases. |
| `packages/database/test/operator-outbox-redispatch-migration.test.ts` | KEEP; TEST WQ-173 | Checks durable ledger/advisory lock and grant/revoke syntax. Broad cross-statement regexes can match unrelated clauses; exact role behavior remains integration evidence. |
| `packages/database/test/operator-run-replay-migration.test.ts` | KEEP; TEST WQ-173 | Guards asynchronous request/outbox/lineage/worker completion structure. Schedule/worker integration provides stronger behavioral evidence; don't replace it with source assertions. |
| `packages/database/test/operator-maintenance-rerun-migration.test.ts` | KEEP; TEST WQ-173 | Maintains operator-request versus maintenance-execution split; names/grant text alone cannot prove authority. |
| `packages/database/test/operator-attempt-reclaim-state-migration.test.ts` | KEEP; TEST WQ-173 | Guards current-attempt/fence-state repair on newly reclaimed work. Need actual failure/no-op/replay row-count behavior at current migration head. |
| `packages/database/test/retention-operator.integration.test.ts` | KEEP meaningful story; TEST WQ-173 | Proves dry-run, exact replay/conflict, maintenance processing and queryable result for retention plus purge wake. Purge target cleanup only follows success; fixture lifecycle belongs below. |
| `packages/database/test/support/retention.integration.support.ts` | KEEP disposable default; fixture FIX/TEST WQ-173 | Default random owned database is stronger than global TRUNCATE. Eager repositories precede database creation; partial setup makes owner undefined and sequential teardown can skip dropping the owned database. Shared Q11 mode needs explicit controlled ownership. |

## WQ-171 — make operator cancellation and pool shutdown truthful

P2 FIX/TEST. operator-command-runtime.ts:60–80 spreads signal onto a QueryConfig
extension; installed pg 8.23.0 Query/Client do not implement that field. The local
before/after checks reject at query boundaries, but an already running query waits
for driver/server settlement. Source-injected held-query proof stayed pending
after abort and rejected with the original abort reason only after query release.
The configured statement timeout is a real bound; it is not immediate caller
cancellation. At 126–147 and 215 onward, pool.connect precedes the first signal
check: an already-aborted call still checked out a client and issued ROLLBACK in
the probe. It can wait for checkout despite having no work to perform.

Check pre-abort before acquisition and use an existing ownership-aware
cancellation mechanism suitable for this privileged pool. Preserve role-specific
timeouts, no tenant-role substitution, eventual query observation, poisoned-client
disposal and original error. A Promise.race alone neither stops PostgreSQL nor
makes a connection safe to reuse. Define behavior for abort during checkout,
BEGIN, command execution and COMMIT; post-COMMIT cancellation must not be described
as proof the command rolled back. Durable command UUID/status remains the recovery
mechanism for an uncertain outcome.

Runtime close at 181 delegates directly to pool.end. Two sequential calls through
the actual source rejected the second with Cleanup failed caused by Called end
on pool more than once. The telemetry wrapper also releases monitor ownership
on each call; repeated owner close must not decrement a shared monitor lease
twice. Memoize one close promise at the operator owner and preserve its first
failure. Cover concurrent and sequential closes, close failure, in-flight drain,
and monitor sharing; don't create a fresh promise that calls pool.end each time.

Apply WQ-150 to both transaction/readiness catch blocks: if ROLLBACK fails, dispose
the client, retain the original failure and record cleanup appropriately. Group
duplicated begin/local-timeouts/commit ownership only as a private helper with
clear operation boundaries; retain the four meaningful readiness assertion groups.

## WQ-172 — validate bounded operator JSON without silent evidence rewriting

P2 FIX/TEST. operator-commands.ts:61–71 recursively parses replay JSON before
the 65,536-byte cap. At 82–90 and 348–355, evidenceRef is a record of unknown,
then JSON.stringify runs before its 4096-byte cap. Undefined/functions can be
omitted, nonfinite numbers become null, BigInt/cycles throw, and nested toJSON
can replace evidence. This is an operator-only boundary; no unauthenticated
network reachability is asserted. Still, audit/replay identity should describe
the accepted evidence, not silently altered caller values.

Use the appropriate bounded plain-JSON inspector for evidence and run input,
retaining the two distinct size limits and each database function's canonical
fingerprint semantics. State explicit policy for getters/proxies/toJSON and
non-JSON types; do not simply coerce everything to strings or serialize twice.
Share mechanics with WQ-168 only where contracts agree. Test exactly-at/over byte
limits, Unicode, depth, cycles, aliases, unsupported values, getters and stable
fingerprint replay. Assert invalid input never acquires command authority and
valid stored evidence exactly matches accepted JSON. Preserve existing database
backstops and replay-before-mutation semantics.

## WQ-173 — strengthen command/replay proof without flattening authority

P2 TEST; localized REFACTOR. Keep every command's explicit SQL function, argument
order, actor, reason, workspace and dry-run mapping. A generic command dispatch
table is not automatically clearer than the current facade. Derive duplicated
command/outcome vocabulary from private runtime schemas where helpful; use a
private command-record decoder to make required/nullable fields and valid dates
clear. Current new Date(z.union([string,date]).parse(...)) admits Invalid Date
for malformed strings; add decoder tests before claiming valid PostgreSQL rows
currently produce that value. Test malformed/empty results and every wrapper's
mapping, not just readiness.

Important distinction from WQ-169: operator conflict is returned by SQL so the
conflict invocation audit can COMMIT, then translated to OperatorCommandConflictError.
Blindly moving that throw inside a generic transaction would roll back the audit.
If shape decoding moves before COMMIT, distinguish validated conflict outcome
from post-commit public error and preserve durable conflict evidence. An invalid
response or lost ACK after commit requires status lookup by the same commandId,
not automatic creation of a new command. Retain transport's real conflict audit
count and exact replay assertions.

Apply WQ-157 to createOperatorRunReplayStore: parse release expectations before
creating owned database resources, preserving borrowed-runtime ownership. Replay
and unknown-outcome input signal schemas use z.custom without a predicate; either
document the trusted AbortSignal contract or validate at the public boundary.
Name private durable-delivery predicates if they reduce repeated row/payload
identity comparisons; do not remove any workspace, checksum, job/version or
aggregate check. Keep request admission, compatibility locking, inbox completion
and operator completion atomic. The SQL completion/failure functions arbitrate
pending status; a separate unlocked request read is not by itself proof of a
double-completion bug.

Add independent negative matrices for every delivery field, missing/wrong-state
request/evidence, unavailable V2 projection, workflow mismatch, checkpoint factory
failure, compatibility rejection, downstream acceptance/completion failure,
duplicate delivery, fail-after-completion and failure persistence rejection.
Assert rollback of acceptance/outbox/inbox on late failure and exact immutable
lineage on success. Unknown-outcome reconciliation must leave the attempt's
historical outcome unchanged. Pair injected tests with owned-database race proof
where pending replay completion competes with failure; do not replace status
arbitration with queue ordering assumptions.

inbox-cancellation.test.ts proves signal forwarding into a fake transaction. Its
rolledBack flag is not database rollback evidence, and the never-settling operation
does not demonstrate work disposal. Add a settling deferred-operation variant,
pre-abort checks, listener cleanup and real transaction cancellation tests at the
existing workspace engine seam. Bound milestone waits and close stores in finally.

Retention fixture: create database first, then repositories under protected setup;
track each acquired resource and database ownership separately. Attempt all
cleanup even if retention.close/operator.close/owner.end fails or owner was never
assigned. Only drop the exact created disposable database; retain explicit shared
benchmark mode without pretending it owns that database. The helper's 200 lock
polls are an iteration bound, not a stable elapsed-time deadline; use a bounded
deadline and precise lock identity when qualifying a race. Move purge target
cleanup into protected fixture ownership, without concealing cleanup failures.
Keep NO FORCE RLS setup transactional and restore FORCE before commit; it is
fixture construction, not runtime-role insertion proof.

Static migration tests remain useful packaging/structure guards. Add current-head
role denials, dry-run nonmutation, exact/conflicting replay, per-target state,
fence mismatch, 100/101 due-work boundaries and command/audit count assertions;
do not infer complete authorization from regex absence of a GRANT substring.

Implementation order: WQ-171 ownership/cancellation and WQ-172 bounded inputs;
constructor and command decoder/mapping regressions; replay races and fixture
cleanup; private schema/predicate cleanup only after behavioral coverage.
