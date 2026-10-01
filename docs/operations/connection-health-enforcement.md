# Connection health enforcement

This records implementation boundaries before migration work for
[ADR059](../adr/059-connection-health-observations.md). It is not qualification
or production activation evidence.

## Lock order

Dispatch takes the existing current-connection shared fence before node and
attempt write locks. The database validates the immutable published slot binding
and persists connection/provider/authentication/secret-version/health-revision
identity once. Repeated dispatch cannot replace it.

Accepted completion retains receipt, run, then node/attempt lock order. It inserts
one classified observation and its canonical outbox command atomically with the
outcome and receipt. It never locks or updates a connection. Observations reference
their source attempt; copied dispatch identity adds no connection foreign-key
lock to completion. Duplicate completion also compares observation evidence.

Health application takes workspace shared authority, authoritative delivery
receipt, observation, then connection update lock. Source attempt and published
binding checks are reads. It takes no run, checkpoint, policy or admission-counter
write lock. Mutation, transition event and receipt commit atomically. Stale
version/revision, revoked, legitimately purged source, or non-enforcing mode
finishes without mutation.

Manual tests take workspace/actor/membership shared authority, idempotency claim,
then connection update lock. Dispatch captures revision; completion rechecks
version and revision under that lock. Rotation takes authority, idempotency receipt,
then connection; revocation takes authority then connection. No connection writer
takes an execution row lock.

The pre-existing workspace-deletion projection is the exception: it owns the
workspace exclusive lock first, fences current connections, then cancels runs.
All connection transactions, dispatch, completion and health application take
workspace shared authority before downstream locks, so this projection cannot
invert their connection/run lock order. Lifecycle fencing advances revision,
retains its existing pending-deletion reason, and leaves provider transition
provenance unknown rather than labeling it as a run or test.

Attempt retention owns its existing workspace lock before deleting attempts.
Observations cascade with their source attempt; corresponding unapplied commands
must be removed in the same transaction. Delivered commands after legitimate
purge are receipted no-ops. Workspace purge removes observations before attempts
and connections. Neither evidence nor command extends source retention.

The combined proof also requires deleting completed retention batches and real
coordinator/attempt transport receipts. The retention guard now admits only the
existing armed, leased tenant-purge delete capability. Inbox owner SELECT,
DELETE and candidate-lock UPDATE policies require that same workspace-bound
capability; outbox owner DELETE does too. They add no serving-role table grants
and remain inert outside an authorized purge. Ordinary mutation and forged-token
deletion remain rejected.

## Schema, ACL and mixed versions

Migration 0128 is additive; published migrations remain unchanged. Readiness must
verify the exact schema head, constraints, indexes, narrow function bodies and
grants. Worker general connection health UPDATE and event INSERT are revoked;
tenant-bound credential-access audit and health application functions replace them.
There is no arbitrary health setter. Evidence uses closed safe codes and persisted
identity; command payloads contain IDs only.

Notification acceptance uses the tenant-scoped `lock_notification_connection`
definer to read the current secret under its connection row lock, including after
a concurrent rotation commits. API and worker admission share this bounded read
capability; neither gains worker connection UPDATE. Delivery credential access
uses the narrow audit function rather than direct event INSERT.

`CONNECTION_RUN_HEALTH_MODE=off|observe|enforce` defaults to off. Production mode
is persisted on each accepted observation. Both produced and consumed mode must
be enforce to mutate. Observe evidence never becomes enforcing retroactively.
Off stops new automatic observations but does not reactivate connections.

The SDK callback is optional synchronous capture only. Executor outcomes, retries,
provider idempotency and published ABI identities remain unchanged. Old artifacts
are not enforcing-capable: install migration, quiesce old consumers, verify the new
readiness/capture/application path, then explicitly enable upgraded artifacts.
Old manual-test claims without revision can record results but cannot mutate health.

Rollback requires stopping automatic production and draining or explicitly
non-enforcing consumption of the bounded health backlog; retain the new schema.
Recovery is an authorized newly dispatched current-credential test or rotation;
revocation is absorbing. Use existing outbox age/retry/poison/recovery signals.
Never replay a provider request merely to update health.

The ECS worker manifest explicitly retains `off`; changing the closed runtime
mode alone does not select the health consumer. Its existing
`OUTBOX_DISPATCH_JOB_NAMES` must also include
`apply-connection-health-observation`. Diagnose the persisted observation mode,
current consumer mode, authoritative outbox delivery, receipt and revision/version
fences before treating a stale disposition as a fault. Use existing dispatcher
retry, poison-job inspection and recovery paths, never direct connection updates.

Full database restore retains the dispatch evidence, observations and commands.
Run the normal `restore:before-serve` migration/readiness and control-ledger replay
boundary before serving; verify supported artifacts and mode-preserving backlog
handling again. Restore does not activate enforcement or make observe evidence
eligible. There is no current user-data export endpoint to extend; safe public
connection/usage exports exclude revision, dispatch identity, credentials and
provider bodies. The private source-owned tables are registered as raw SQL.

## Outstanding qualification

Focused real PostgreSQL races, completion reconciliation, durable redelivery,
ACL/readiness, retention and bounded usage proofs pass. The isolated Slack
API/worker/HTTP/browser fixture passes with an acknowledged worker-runtime
restart; this is not an OS process-kill proof. Frozen-source broad qualification
passes; independent review/release remain open in the implementation tracker. Local
enforce mode is permitted only for owned fixtures; production activation is not
authorized.
