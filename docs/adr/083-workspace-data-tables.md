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

Complete CSV export uses the existing repeatable-read workspace fence, bounded
cursor reads and the existing 1 MiB result budget. Oversized exports fail before
download with a narrowing instruction; formula protection remains enabled.
No new storage service, role or background export subsystem is introduced.
