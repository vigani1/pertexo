# Database migrations 0000–0016

Date: 2026-09-12. Primary reviewer fully read all 17 SQL files. Evaluated historical
intent against current source/readiness and already reviewed tests. SQL was not
executed during this pass. Published bytes must remain unchanged; disposition
names describe follow-up work, not permission to edit historical files.

## Individual file judgments

| File | Disposition | Specific judgment |
| --- | --- | --- |
| `packages/database/migrations/0000_rls_probe.sql` | KEEP | Small explicit tenant probe, fail-closed missing context, ENABLE/FORCE RLS and denied whole-table authority. Workspace/id index matches probe scope. |
| `packages/database/migrations/0001_queue_transport.sql` | KEEP historical contract | Complete lease tuple, terminal exclusivity, bounded payload/checksum and role-specific policies separate serving insertion from dispatcher mutation. Inbox identity-update authority is subsequently narrowed by 0005. |
| `packages/database/migrations/0002_artifacts.sql` | KEEP; follow current artifact findings | Canonical workspace/id storage key, bounded size and explicit lifecycle alternatives are justified. Media-type and capacity/finalization rules have later repairs; judge current behavior through 0079–0085, not this initial regex alone. |
| `packages/database/migrations/0003_transport_security_audit.sql` | KEEP | Minimal checksum-mismatch fact avoids storing payload; tenant policies and select/insert grants preserve append-only serving behavior. Later purge minimization is deliberate, not inconsistent with original serving grants. |
| `packages/database/migrations/0004_execution_acceptance.sql` | KEEP historical vocabulary | Composite tenant run links, positive sequence, bounded checkpoint/idempotency material and serving grant separation are coherent. No authored-version FK is added prematurely in this pre-authoring checkpoint. |
| `packages/database/migrations/0005_inbox_least_privilege.sql` | KEEP | Five-line correction grants only completion timestamp update; no reason to wrap or combine the immutable migration. |
| `packages/database/migrations/0006_execution_vocabulary.sql` | KEEP bytes; TEST/CONDITIONAL WQ-204 | Explicit canceled/in_progress normalization followed by replacement checks. Data updates run under forced RLS with no applicable historical owner policy, unlike later guarded backfills. Populated prior-head upgrade needs proof. |
| `packages/database/migrations/0007_execution_runtime.sql` | KEEP bytes; TEST/CONDITIONAL WQ-204 | Named lifecycle/lease/wait constraints, single nonterminal attempt index and narrow worker mutation grants make state rules inspectable. run.accepted normalization has the same historical RLS issue. Current-attempt composite FK binds workspace but not node/attempt number; application/forward constraints must be considered before any schema change. |
| `packages/database/migrations/0008_identity_workspace.sql` | KEEP | Platform identity/session records intentionally differ from tenant memberships/audit RLS. Case-insensitive identity/slug uniqueness, owner partial uniqueness and worker-only workspace identity columns match authority design. Later deletion/tombstone migrations replace the initial state rule. |
| `packages/database/migrations/0009_oidc_login_transactions.sql` | KEEP | Digest-only state and sealed verifier/nonce fields with bounded metadata, expiry/consumption order and narrow update grants are appropriate; browser binding arrives separately in 0071. |
| `packages/database/migrations/0010_oidc_transaction_capacity.sql` | KEEP; TEST/CONDITIONAL WQ-205 | Definer trigger has trusted search path and revoked direct execution; advisory lock serializes bounded pruning and active/total capacity checks. admission_time is captured before waiting for the lock; do not assume lock-time freshness. |
| `packages/database/migrations/0011_workspace_creation_idempotency.sql` | KEEP | Actor-scoped RLS is correct before a workspace exists. Unique actor/operation/key and completed-result pairing support replay without granting destructive mutation. Resource FK intentionally keeps creation lineage until later retention rules. |
| `packages/database/migrations/0012_workflow_authoring.sql` | KEEP; TEST authorization contract | Atomic idempotent workflow/draft/audit creation and immutable versions hide meaningful database work. Explicit actor/workspace checks plus membership/lifecycle query are readable. Preserve application locking before this function; direct function authorization race needs separate proof if broad direct callers are introduced. |
| `packages/database/migrations/0013_published_workflow_execution.sql` | KEEP | IS TRUE around legacy/executable alternatives rejects SQL NULL loopholes; worker column/policy projection excludes legacy graph bodies. Executable byte backstop is distinct from authoring JSON limits. |
| `packages/database/migrations/0014_execution_value_persistence.sql` | KEEP | Six widened coarse JSONB backstops deliberately account for whitespace/exponent expansion, not a weakening of application value limits. No legacy-body normalization or extra authority grant. |
| `packages/database/migrations/0015_coordinator_run_store.sql` | KEEP | Owner backfill explicitly brackets NO FORCE/FORCE RLS inside migration transaction, then makes version identity nonnull with composite FK. Fingerprint grant and separate event-storage backstop are focused. |
| `packages/database/migrations/0016_engine_invocation_keys.sql` | KEEP | Explicit legacy-or-canonical URI grammar preserves retained keys without hashing or rewriting. Varchar bounds total size independently of the unbounded regex repetition; do not introduce regex-only length assumptions. |

## WQ-204 — prove populated historical vocabulary upgrades under real owner RLS

P2 TEST/CONDITIONAL compatibility gap, not a current-head outage claim.
0006:4–7/:29–32 updates old status strings; 0007:25 updates run.accepted.
The tables created in 0004 use FORCE ROW LEVEL SECURITY and policies for API/
worker roles, not the migration owner. The runner migrations.ts:324 explicitly
sets owner role, whose provisioning is NOBYPASSRLS/NOINHERIT. These UPDATEs have
no matching owner policy or NO FORCE bracket at those heads. By inspection,
retained legacy rows can be invisible to the rewrite, then violate the new
constraint. Later 0015 demonstrates the intended owner-backfill bracket.
This follows PostgreSQL's documented forced-owner/default-deny behavior, not a
claim that a live upgrade was run. [PostgreSQL row security](https://www.postgresql.org/docs/18/ddl-rowsecurity.html).

First establish the supported upgrade policy for these preproduction heads.
Add isolated exact-head tests populated with canceled-old-spelling runs,
claimed idempotency rows and run.accepted facts across two workspaces. Run with
the real migration role, assert actual transformed rows, preserved unrelated
columns, constraints and restored FORCE RLS. A clean empty bootstrap cannot
prove this path. If such populated historical upgrades are explicitly outside
support, document that boundary and retain bytes. If supported, design an
authorized, narrowly scoped pre-upgrade repair; an ordinary migration appended
after the failing historical migration cannot make that earlier step succeed.
Do not edit checksums/history, grant owner membership to serving roles, set
BYPASSRLS, or silently relax tenant policies to make a test pass.

## WQ-205 — test OIDC capacity lock-time freshness before optimizing it

P3 TEST/CONDITIONAL. 0010 initializes admission_time before pg_advisory_xact_lock.
After a wait, pruning and active counts use that earlier time, so records that
expired while waiting may still count against active capacity. This is a
conservative availability issue, not over-admission or an authentication bypass.
Use two real clients, an observed advisory wait and expiry around the boundary
to establish a reachable result under configured transaction/lock deadlines.
If meaningful, assign the authoritative timestamp immediately after acquisition
in a forward replacement and preserve the short prune/count/insert transaction,
1000-row deletion cap, 10000 active and 20000 total bounds.

Retain the bounded-population counts until a real plan/latency measurement shows
they need improvement. The OR/coalesce cleanup ordering may require sorting,
but arbitrary index additions or changing UUID identity are not justified by a
generic guideline. Add active/full/stale/concurrent insert tests with final
stored counts, and prove transaction rollback at rejection. The production owner,
trusted search path and trigger-only privileges remain unchanged. PostgreSQL
requires deliberate definer privilege and search-path handling;
[CREATE FUNCTION guidance](https://www.postgresql.org/docs/18/sql-createfunction.html)
supports that contract, not a new database provider or schema naming scheme.
