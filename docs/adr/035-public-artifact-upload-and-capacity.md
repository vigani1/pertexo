# ADR 035: Public artifact upload, finalization and capacity

- **Status:** accepted
- **Date:** 2026-09-06

The plan requires direct signed uploads, verified finalization, authorized
metadata/download access and bounded workspace artifact storage. PostgreSQL
owns artifact identity, lifecycle and capacity; object storage owns immutable
bytes. No object-store request or signing operation runs inside a database
transaction. An observational aggregate is not sufficient quota authority
because simultaneous uploads can both pass the same check.

## Public boundary

`POST /v1/workspaces/:workspaceId/artifacts/uploads` accepts only byte length,
media type and lowercase hexadecimal SHA-256. The server creates a random
artifact ID, canonical workspace-scoped storage key, `user-upload` purpose and
pending deadline; clients cannot choose a key, owner link, lifecycle, retention
policy or filename/path. The request requires session, CSRF, an idempotency key
and the dedicated `artifact:upload` capability. Owners, admins, builders and
operators may upload run inputs; viewers cannot mutate artifacts. Metadata and
download access require `artifact:read`, granted to active workspace members.
Suspended or deleting workspaces reject these public operations.

Begin atomically claims an actor/workspace/operation-scoped idempotency key and
reserves the declared bytes and one artifact before creating pending metadata.
The key's request hash covers the canonical declared metadata. Exact retries
return the same artifact identity; changed request material conflicts. The
durable result never stores a signed URL. After commit, the store issues a
bounded, immutable PUT capability for that exact identity and metadata. A
signing failure leaves a retriable pending reservation, not an untracked
object. A retry may refresh the URL only within the original pending deadline;
it never extends that deadline or revives an expired/deleting artifact.

`POST /v1/workspaces/:workspaceId/artifacts/:artifactId/finalize` accepts a
strict empty body, not a second client claim about uploaded metadata. It loads
authorized pending metadata, validates the actual primary object and creates
and verifies its recovery copy through the existing dual-region store, then
rechecks authorization, immutable metadata, lifecycle and expiry in a short
transaction before making the artifact available. Exact repeated finalization
of an available artifact is idempotent. Missing, mismatched, partial,
expired or concurrently deleting objects never become available. External
verification can be retried after process loss without changing artifact
identity or trusting client claims.

`GET /v1/workspaces/:workspaceId/artifacts/:artifactId` returns safe metadata
without a storage key or credentials. The sibling `/download` read issues a
short-lived GET capability only for an authorized available artifact. Signing
accepts an artifact identity, never an arbitrary object key or client URL.
Downloads force attachment disposition and do not reflect a client filename.
Signed URLs are bearer credentials: responses use `Cache-Control: no-store`,
URLs are never logged or persisted, and authorization revocation cannot revoke
an already issued URL before its short expiry. API byte proxying was rejected
because the plan explicitly calls for signed download and direct storage
transfer; this bounded revocation window is the accepted trade-off.

## Capacity authority and retention

A tenant-owned capacity record stores byte/count limits and charged totals.
All artifact writers, including execution/preview writers, must reserve through
the same database-enforced authority. Pending, available and deleting artifacts
remain charged. Finalization changes lifecycle, not total charge. Capacity is
released exactly once only when deletion is durably completed; partial
dual-region deletion, retries, legal holds and an expired pending deadline do
not release it early. Existing metadata is backfilled into charged totals by
the forward migration. Capacity changes and artifact changes roll back together.

Default workspace limits are 1 GiB and 1,000 live artifacts, with the existing
per-object runtime maximum enforced independently. These are conservative V1
operational defaults, not billing promises. Runtime roles cannot raise limits
or reset counters. An authorized operational migration may adjust limits, and
lowering a limit below current usage blocks new reservations rather than
deleting data. Workspace purge must remove capacity rows in its reviewed
dependency order; restoration/recovery must retain or reconcile charge from
the restored artifact inventory before allowing new uploads.

## Required evidence

Strict shared contracts, real authenticated HTTP and real PostgreSQL/object
storage proofs must cover role/tenant/CSRF/state denial before storage access,
parallel begin idempotency and quota races, immutable signed PUT restrictions,
wrong size/type/checksum, missing and partial replicas, expiry/finalize races,
process-loss retries, authorized metadata/download, URL redaction, and cleanup
without early or duplicate quota release. Existing preview, execution and
retention/purge paths must remain green. IWA-17 stays open until that vertical
slice and its runtime wiring are verified.
