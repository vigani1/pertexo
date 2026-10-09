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
version/revision, revoked or legitimately purged source finishes without
mutation.

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

Retention deletes attempts with their node run. Observations cascade with
their source attempt, and the unapplied health command is removed in the same
transaction. Delivered commands after a purge are receipted no-ops. Workspace
purge removes observations before attempts and connections. Neither evidence
nor command extends source retention.

## Schema and ACL

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

Run health always applies (ADR 069, ADR 059 amendment): there is no rollout
mode, and an observation no longer records one.

The SDK callback is optional synchronous capture only. Executor outcomes, retries,
provider idempotency and published ABI identities remain unchanged.

Recovery is an authorized newly dispatched current-credential test or rotation;
revocation is absorbing. Use existing outbox age/retry/poison/recovery signals.
Never replay a provider request merely to update health.

Diagnose the authoritative outbox delivery, receipt and revision/version fences
before treating a stale disposition as a fault. Use existing dispatcher
retry, poison-job inspection and recovery paths, never direct connection updates.

Full database restore retains the dispatch evidence, observations and commands.
Run the normal migration and readiness checks before serving. There is no current user-data export endpoint to extend; safe public
connection/usage exports exclude revision, dispatch identity, credentials and
provider bodies. The private source-owned tables are registered as raw SQL.

## Outstanding qualification

Focused real PostgreSQL races, completion reconciliation, durable redelivery,
ACL/readiness, retention and bounded usage proofs pass. The isolated Slack
API/worker/HTTP/browser fixture passes with an acknowledged worker-runtime
restart. Its HTTP proof also abandons a real dispatcher's durable health-publication
claim before the event returns to the publication owner, with no publish,
acknowledgment or release. The unchanged 30-second lease remains authoritative
across runtime recreation and expires naturally before recovery. Exactly one
receipt/transition, unchanged accepted run/attempt state and no provider resend
are asserted. This is not an OS process-kill proof. Frozen-source broad qualification
passes; independent review/release remain open in the implementation tracker.
