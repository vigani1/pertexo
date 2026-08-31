# ADR 013: Retention, workspace deletion, legal hold, and backup erasure

- **Status:** accepted
- **Date:** 2026-08-25

## Context

Tenant data spans PostgreSQL, object storage, encrypted secret versions,
external subscriptions, and backups. Immutable execution and audit history
still requires bounded retention and an explicit deletion process; database
cascades alone cannot prove destruction across those systems.

## Decision

V1 defaults retain detailed node attempts, events, and logs for 30 days; run
summaries for 90 days; preview runs for seven days; run artifacts for 30 days
unless referenced by a longer-retained record; and audit/security events for
365 days, subject to legal policy. Idempotency records are operation-specific
and never expire before the corresponding retry or replay window. V1 request
idempotency for connection management/testing, secret rotation, workflow
publication, notification destinations, schedules, generic webhooks, and
workspace creation uses a 24-hour replay window. A bounded maintenance reaper
removes only terminal records after that window. It never removes an
`in_progress` claim: operations whose provider outcome may be unknown retain
the claim until their operation-specific recovery path safely reaches a
terminal state. Once a terminal record is reaped, reuse of the same key begins
a new claim and no longer replays or conflicts with the expired request.

Authentication sessions remain logically invalid immediately after expiry or
revocation. Their token digest and bounded user-agent/IP metadata are retained
for a 30-day security-audit grace period after that invalidation event, then a
bounded maintenance reaper physically removes them. Row-lock skipping makes
cleanup safe with concurrent logout; cleanup cannot make a session active.

Generic webhook raw bytes, signature headers, authorization material, and
request headers are never persisted. The parsed bounded payload is stored once
as run input and follows the 30-day detailed-run retention period. Trigger
delivery metadata and its safe run reference follow the 90-day run-summary
period. Raw-fingerprint replay records expire after five minutes; keyed webhook
idempotency records expire after 24 hours. Legal hold covers the retained parsed
payload, delivery metadata, and workspace-scoped replay/idempotency facts in
its scope. Session metadata is identity access state rather than workspace
evidence and follows its 30-day grace policy.

Retention and purge maintenance uses bounded, idempotent, resumable batches
with durable progress and metrics. A legal hold prevents destruction of the
covered data but does not reactivate a workspace, trigger, connection, session,
run, or provider subscription and does not block non-destructive lifecycle
steps. Hold scope, legal authority, and release are audited. The legal authority
for holds and the backup-rotation duration are launch policy inputs, not claims
made by this engineering decision.

Deletion requests, legal-hold placement/release, and deletion completion are
also written as ordered append-only records in a dedicated object-store control
ledger outside tenant prefixes and tenant purge. That independently retained
ledger is authoritative across PostgreSQL disaster restore; PostgreSQL stores
the tenant-scoped lifecycle projection and resumable step progress. A command
locks the workspace lifecycle row before creating its next ordered ledger record
and holds that lock through the PostgreSQL projection transition. If the
database transition fails after the record is created, reconciliation applies
the recorded command rather than discarding it. Object-ledger failure rejects
the command before tenant state is changed.

Workspace deletion follows this exact lifecycle:

1. `active` or `suspended` becomes `pending_deletion`, recording actor, reason,
   request time, and a default 30-day `purge_after` recovery deadline.
2. The request revokes sessions and API keys, disables public triggers, prevents
   new runs, queues idempotent connection/provider revocation, cancels queued
   runs, and durably cancels active runs with a bounded drain period.
3. Restore before `purge_after` returns the workspace to `suspended`; connections
   and triggers remain disabled until explicitly re-enabled.
4. At the deadline, `purging` performs resumable explicit deletion of tenant
   rows, object bytes and metadata, encrypted secret versions, indexes, and
   external subscriptions. Trigger endpoints are already disabled; purge removes
   their signing-secret versions, delivery history, and remaining replay facts
   before the workspace tombstone completes. Legal hold pauses only covered
   destructive steps.
5. Completion writes a non-sensitive deletion-ledger tombstone and transitions
   the workspace to `deleted`. Partial purge remains visible and retryable.

Legally retained audit or billing facts are minimized or anonymized according
to launch policy. Backup copies are beyond serving use and expire only through
normal backup rotation. The non-sensitive deletion ledger survives primary
purge and is replayed after a backup restore so restored tenant data is purged
again before it can return to use.

A restored deployment remains unavailable for tenant traffic until it has read
the control ledger through its current high-water mark and projected every
deletion and hold record into PostgreSQL. Every destructive purge batch checks
the external per-workspace ledger high-water mark while holding the same
workspace lifecycle row lock used by hold/deletion commands, and proceeds only
when it exactly matches the projected sequence. A newer or unavailable ledger
pauses destruction; a release resumes only after its ordered ledger record is
projected. This can conservatively retain data during uncertainty but cannot
serve or destroy data from a stale restored projection.

## Consequences

Retention and deletion are explicit, recoverable workflows across every storage
surface. Restore is safe but deliberately suspended, and backup restoration
cannot silently resurrect previously deleted tenant data. The trade-off is
durable maintenance and deletion-ledger state plus operated launch policies for
legal authority and backup duration.

## Rejected alternatives

- Treating immutable records as retained forever.
- Trusting foreign-key cascades to remove objects, secrets, or subscriptions.
- Letting legal hold preserve active access or execution.
- Restoring directly to `active` or automatically re-enabling integrations.
- Claiming immediate physical deletion from backup media.
- Inventing legal authority or a backup-retention duration in the ADR.
