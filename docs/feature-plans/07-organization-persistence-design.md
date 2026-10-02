# F07 — Slice-1 persistence implementation constraints

Status: implementation design, not installed or qualified behavior. The primary
accepted the generation/private-held-evidence approach on 2026-10-02 before SQL.
The [accepted contract](07-organization-contract-proposal.md) and
[ADR064](../adr/064-workflow-organization-metadata.md) remain authoritative.
Migration 0134 belongs exclusively to F07 on the allocated `936612f2` base.

## Private membership lifetime

Use an owner-controlled membership-generation child keyed by workspace/person.
Create its initial generation atomically under workspace, actor and membership
authority locks. A confined membership trigger advances it only on a genuine
transition into `removed`. Suspension, reactivation, ordinary role changes and
invitation acceptance do not advance it. Removing a person who has never used
favorites must still establish the departure fence. No API generation write or
caller-selected generation is allowed.

The generation survives a removed membership. Do not reset it if a membership
row is recreated; parent removal must not cascade through it. Membership, user
and workspace physical deletion use the existing hold-aware lifecycle/purge
owner, explicitly removing children first when deletion is permitted. Foreign
keys must reject unchecked parent deletion, not silently discard held evidence.
This fence is separate from `role_revision`, which already changes for suspension
and unrelated membership commands.

Keep one favorite state/tombstone keyed by workspace/person/workflow, carrying
the membership generation. Current reads and actor-scoped RLS require current
active authority and matching generation. Removal immediately makes old state
inaccessible; rejoining reads an absent state, never the old bookmark. Matching
private receipt replay also requires the current generation: a same-person
rejoin must not replay a pre-departure command.

A new favorite command encountering a prior-generation state preserves it in a
separate private held-evidence relation before replacing the current row when a
hold applies. That relation is not an API-readable bookmark or per-toggle history.
Only retired-generation evidence needs this relocation; ordinary current-state
commands retain the accepted one-row state/tombstone protocol. The preservation
and replacement are atomic, and retained evidence never restores current state.
Private receipts/results have their own generation-bound, actor-only boundary;
do not store them in workspace-readable generic idempotency results, shared audit
metadata or logs.

## Lock and hold composition

Current authority is locked workspace first, then actor and membership. Generation
initialization/locking belongs to that authority phase, before the private receipt.
After the receipt, acquire the workspace organization coordinator, then any tag
rows in UUID order, workflow rows in UUID order, then assignment/private state.
Shared organization writes use coordinator UPDATE; favorites and lifecycle
archive/restore use SHARE before locking a workflow. Completed replay checks
current visibility, skips current selection/writer policy and does not lock
coordinator/tag rows after a workflow lock.

Hold checks must occur after locked workspace admission, in the same transaction
as evidence replacement. Existing hold projection takes workspace UPDATE; a
favorite command's workspace SHARE must remain held through preservation and
commit. Verify this concrete exclusion with two-connection hold/replace races.
Do not take a destructive advisory lock after locking the workspace: hold/purge
owners already take that advisory lock before workspace UPDATE. Any maintenance
or purge path needing destructive admission follows that existing order first.
No external physical I/O is part of a favorite command.

Use the common coordinator for tag count/assignment validation. Tag deletion
reads at most 51 assignments before workflow locks: overflow changes nothing;
at most 50 detach atomically, each independent organization revision advances
once, then the tag is removed. Archived cleanup remains an explicit bounded
per-item command, not restore or an unbounded cleanup job.

## Retention, grants and qualification

False favorite state and private terminal receipts retain the existing 24-hour
retry horizon; replay does not renew it. No indefinite deduplication or stale-token
promise follows from a held row. Bounded indexed maintenance reaps expired false
state, retired private state/evidence and receipts only after current hold and
generation checks under the existing destructive/workspace admission order.
Maintenance budgets bound total row work, not each category independently.

Tenant purge removes new children explicitly in bounded pages before workflows,
memberships, users or workspace parents; a cascade is not a purge budget or hold
check. Held evidence is inaccessible until authorized destruction, not exposed
through maintenance/operator/API grants. Worker/dispatcher roles gain no favorite
access. Shared metadata survives the author's departure.

The additive migration installs its writer gate off. Exact serving readiness must
pin schema head, relation columns/keys/indexes, forced RLS policies, ownership,
least privileges, confined helper bodies and purge/maintenance integration.
Existing old-head bootstrap denies the new head before listening. Compatible
off readers retain metadata; writer disablement precedes rollback. Real owned
PostgreSQL authority/RLS/ABA/departure/suspension/rejoin/replay/hold/reap/purge and
archive/delete races, independent review and compiled cutover remain required.
No mock, schema primitive or design acceptance closes those gates.
