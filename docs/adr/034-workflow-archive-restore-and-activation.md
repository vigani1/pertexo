# ADR 034: Workflow archive/restore and activation convergence

- **Status:** accepted
- **Date:** 2026-09-06

The plan distinguishes workflow lifecycle from activation, and requires
archive/restore without rewriting published versions or runs. ADR 033 makes
activation reads truthful; this decision defines the lifecycle command and
reconciliation boundary. Version restoration remains a separate draft command
under ADR 011, not a synonym for restoring an archived workflow.

## Commands and concurrency

`POST /v1/workspaces/:workspaceId/workflows/:workflowId/archive` and the sibling
`restore` route require an authenticated session, CSRF, `workflow:publish` in
an active workspace, and exactly one `Idempotency-Key`. Publication authority
is appropriate because both operations change production admission. They do
not grant run cancellation or replay authority.

The strict body is `{expectedLifecycleRevision}`: a positive safe integer
obtained from the workflow summary. This workflow-owned revision starts at one
and advances once per effective archive/restore transition. It is independent
of draft revision, publication, and background activation updates. Publication
and lifecycle commands serialize on the workflow row; publication still
requires an active workflow. Thus publication-first archives the current
publication, while archive-first prevents a new publication. Neither silently
overwrites a draft.

The command transaction checks current membership/workspace state, claims an
actor-, workspace-, workflow- and operation-scoped idempotency key, locks the
workflow, checks the lifecycle revision, updates lifecycle/activation, and
appends its audit fact and any required reconciliation outbox event. A stale
revision returns a typed conflict with the current lifecycle revision and no
mutation. A current-revision request for an already achieved state is a no-op:
no extra revision, audit or outbox. An exact idempotency retry returns the
original accepted summary before rechecking its historical revision; a key
with different request material conflicts. Durable results expire under the
existing idempotency retention policy, not an in-memory cache.

Both routes return HTTP 202 with `{workflow,replayed}`. The original response
may contain a transitional activation state; clients read the workflow again
for current convergence. Missing or cross-tenant objects follow the existing
not-found disclosure policy.

## Admission and trigger configuration

Archive changes lifecycle to `archived` immediately. Existing lifecycle gates
must deny manual/replay, webhook and schedule admission even before delivery
of the reconciliation outbox event. Existing queued/running/waiting runs are
not canceled, resumed, rewritten or replayed. The published pointer, immutable
versions, draft and provider credentials remain unchanged.

A published workflow moves to `deactivating` and emits the existing strict,
identifier-only reconciliation event. The consumer locks and applies the
current desired lifecycle for the named current published version: delivery
order is not lifecycle authority. Archive reconciliation disables the effective
workflow trigger records and clears schedule leases, then records `inactive`.
It preserves endpoint/schedule configuration availability; workflow lifecycle
and effective trigger status are the admission gates. An unpublished workflow
is immediately `inactive` and needs no trigger event.

Restore moves lifecycle to `active`, retaining the published pointer. With a
publication it enters `activating` and requests reconciliation; without one it
remains `inactive`. Reconciliation can reactivate only still-usable configured
resources. It must not change a disabled schedule to enabled merely because a
workflow was restored or reconciliation was retried, and must never resurrect
a disabled endpoint or revoked credential. Explicit trigger configuration
commands remain the way to enable a disabled resource. Configuration writes
reject an archived workflow and lock workflow authority before trigger rows,
matching the reconciliation lock order.

This intentionally preserves explicit disablement rather than interpreting it
as a transient reconciliation failure. It also avoids maintaining a second
copy of credentials or restoring a stale snapshot of resource state. Workspace
deletion/restoration remains governed by ADR 013 and cannot be undone through
workflow restoration.

## Activation convergence

A successful publication enters `activating` atomically with its pointer and
outbox, graduating ADR 002's Phase 2-only `inactive` publication restriction.
No provider or queue call enters that transaction. A current published manual
workflow with no external triggers becomes `active` after reconciliation.
All active triggers produce `active`; a mixture with usable active triggers
produces `degraded`; pending/configuration-required desired work produces
`activating` when none are yet usable; entirely disabled triggers produce
`inactive`; untrusted failures with no usable trigger produce `error`.

Reconciliation failures must preserve trustworthy per-trigger facts and report
`degraded` if some current triggers remain usable, otherwise `error`.
Archive/deactivation failure cannot pretend convergence succeeded: lifecycle
still blocks admission, but activation reports `error`. Stale version events
cannot rewrite the latest version's activation. Duplicate delivery has no
additional effect. State decision rules belong in the shared lifecycle model;
persistence applies them under the authoritative row lock.

## Required evidence

Real PostgreSQL and authenticated HTTP proofs must cover authorized commands,
CSRF/tenant/capability/workspace-state denial, revision races, exact concurrent
idempotency and mismatched keys, transaction rollback, unpublished and published
workflows, unchanged draft/version/run history, immediate denial of all new
admission paths, and no privilege broadening. Real dispatcher/worker delivery
must prove archive/restore convergence, reordered and duplicate events,
restart recovery, disabled-resource preservation, and partial/global failure
projection. The tracker must keep IWA-16 open until version restoration and
these lifecycle criteria are implemented and verified.
