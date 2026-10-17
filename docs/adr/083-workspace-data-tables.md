# ADR 083 — Bounded workspace data tables and atomic workflow writes

Status: accepted. Date: 2026-10-17. Feature: [F14](../feature-plans/14-data-tables.md).

## Context

Workflows need small shared lookup/state datasets without an external database.
A retried internal write must not duplicate an insert or apply an update twice.
The owner authorized typed workspace tables, bounded quotas, CSV management and
five read/write steps. PostgreSQL already owns transactions and workspace RLS.

## Decision

Store user schemas and typed row JSON in shared workspace-scoped PostgreSQL
tables, never user-created SQL tables. Keep type/filter/quota rules in TypeScript;
use database constraints for foreign keys, uniqueness, revisions and counters.
Use a fixed schema and optional single typed unique key in the first slice.

Every workflow write stores a bounded durable receipt in the same transaction as
its row mutation. Identity is the stable workspace/run/node invocation, not an
attempt number. Check the current attempt fence and cancellation/deadline after
locks. Preview writes use the existing preview attempt fence. Receipt replay
returns the original result; changed commands are refused. Receipts outlive retry
and are removed with execution retention/workspace purge. A new replay run has a
new identity. Reads are safe; writes are idempotent effects requiring draft-test
consent.

Editors manage data; active members can read it. Owners/admins can raise bounded
quotas. Workflow configs reference stable table names, so portability includes no
row data or workspace IDs. Table deletion is explicit and makes missing-table
references fail clearly. Use existing worker capabilities, roles and services.

## Consequences

One transaction serializes quota-sensitive writes per workspace, giving clear
bounds and race-safe accounting. This deliberately favors small datasets over
unbounded write throughput. Schema evolution stays explicit and bounded; there is no general migration language.
No arbitrary SQL, custom indexes, external storage or new infrastructure is
introduced. The plan owns exact limits and acceptance evidence.


## Amendment — editable columns (2026-10-17)

The owner approved bounded schema evolution. Each column has an immutable ID;
its name may change. Workflow config binds stable input/output aliases to IDs,
so renames preserve both effects and downstream output paths. Existing columns
receive their original name as ID, preserving old published graphs. IDs for later-added columns are
fresh and never reused. After a removal, legacy steps without declared bindings
must be reviewed before fresh starts rather than guessing from expressions.

Rows retain their current human column names. A rename atomically rewrites
those names while the scoped workflow adapter resolves IDs and projects stable
aliases. The existing quota/table locks serialize schema and row writes. Each
schema edit checks revision, updates bounded batches/counters, and records one
safe audit event in the same transaction. Required additions backfill a typed
default; unique-key changes validate all existing values. Type changes stay later.

Complete CSV export uses short workspace-scoped batch reads, as amended below.
No new storage service, role or background export subsystem is introduced.

## Amendment — streamed complete exports (2026-10-17)

The owner removed the 1 MiB complete-export cap. Keep the stored-data quotas,
workflow result envelope and import bounds. Use creation/row-ID keysets and
bounded batches with the availability amendment below; the UI explicitly
distinguishes this export order from on-screen sorting. Preserve quoting and formula protection.

A native browser form download and a backpressured API stream keep full exports
out of application buffers. The existing session and CSRF policy authorizes the
POST, with bounded form decoding only at this endpoint. Successful HTTP EOF is
sent only after all batch reads and cleanup complete; failures abort the download.
The existing rate limiter bounds export starts. No download tickets, temporary
artifact storage, browser service worker or background export system is added.


## Clarification — explicit workflow names (2026-10-17)

Renamed table columns do not rewrite workflow aliases. The editor shows both
names and offers an explicit review before adopting current names together for
the currently bound IDs. This is an ordinary undoable draft config change;
immutable published graphs remain unchanged. The review lists affected mappings
and identifies dynamic consumers for manual inspection. It never silently
rewrites mappings, expressions, Code or input data on the user's behalf.


## Amendment — export availability (2026-10-17)

A whole-download read snapshot pins one of the API's small number of pooled
connections for the client's lifetime. The owner approved replacing it with
short checkouts: read an ID-keyset batch, commit and release, then stream it.
Exports have no cross-batch snapshot guarantee; concurrent row changes may or
may not appear. Recheck workspace authority and the initial column definition
per batch; abort a schema-changing export rather than produce misleading CSV.

Use the existing Redis admission runtime for one active export per workspace
across instances, plus a two-export in-process cap. Slots expire after the
maximum transfer deadline plus cleanup margin; release checks the owner.
Abort stalled writes after about 60 seconds and scale the total budget with
stored size, capped at five minutes. The plan owns exact bounds. This trades
snapshot consistency for pool availability without adding storage, a dedicated
connection, background work or another service. Partial downloads still fail.
