# ADR 061: Version-contextual run-input cases and checked manual starts

- **Status:** accepted — manager-reviewed first F02 slice; planning record only
- **Date:** 2026-10-01
- **Related:** ADR 002, ADR 011, ADR 012, ADR 013, ADR 057, ADR 058, ADR 060

## Decision and scope

A run-input case is a workspace/workflow-owned shared authoring asset containing
a name and bounded, manually entered JSON input, bound to an exact retained
immutable workflow version and checksum. It is not creator-private, draft-bound,
historical replay, preview, mock, assertion or pinned provider output. No recorded
production-data capture or automatic sanitization is included. Loading a case
starts nothing; a separately confirmed manual run uses ordinary production
execution and may perform real external effects.

The product owner selected the version-checked real-start direction, and the
manager accepted the bounded first-slice contract. This ADR records that design,
not implementation completion, production enablement or permission for external
provider calls. Later F02 preview substitution/isolation and regression slices
still require their own decisions.

## Ownership, authority and version context

Keep case commands in the canonical workflow-authoring API/database owners,
HTTP contracts in contracts, and management in the web workflows feature. The
existing workflow-runs command interface consumes loaded JSON and owns real
admission. Do not create a second admission engine or extend node-testing.

Read/load requires current `workflow:read`; create/edit/delete requires current
`workflow:update` (owner/admin/builder). Real start independently requires current
`run:start` (owner/admin/builder/operator); viewer cannot start. Session/CSRF and
ordinary rate limiting precede persistence. Recheck active workspace, actor and
membership under transaction locks through command commit; capability proofs are
specific to their capability. Never borrow authoring authority for execution or
treat a case ID, receipt, version ID or browser cache as authority.

Cases carry direct workspace ownership, composite same-workspace workflow/version
references, forced RLS and least-privilege API access. Workers get ordinary run
input, not case access. Retained versions remain inspectable; a case for a
different publication is stale, never silently rebound. Review changed context
and explicitly create a new case before confirming a run for that context.
Editing a name/input does not change a case's version binding. There is no
workflow-wide run-input schema today: bounded JSON validation is not a promise
that mappings or providers will accept it.

## Checked manual admission and compatible recovery

Add optional `expectedPublishedVersionId` (UUID) to the existing manual-start
body. It asserts the current publication, never selects a historical version.
Omission preserves existing manual-start semantics and exactly the existing
canonical request hash. Include the new field conditionally in checked hashes;
preserve operation `workflow.run.accept` and scope `workflow:<id>:manual`.
Changed expected version, input or deadline with a retained key conflicts.

Serialize every checked and unchecked manual writer by the same workspace,
operation, scope and key hash. After current locked authority, take a fresh
receipt lookup: an accepted exact command returns its original run before any
current publication, compatibility or quota check. The existing early lookup
followed by a later unique claim alone cannot guarantee this for concurrent
duplicates. Use a transaction-scoped, domain-separated key lock; a lock-hash
collision may serialize unrelated commands but must never equate their identity.
Keep trigger and user-requested replay admission unchanged.

For a new command, retain compatibility-release-before-workflow lock order. Read
the authoritative published version under the existing workflow `FOR SHARE` lock
and hold it through commit, conflicting with publication's workflow update. If
publication wins first and IDs differ, return
`409 workflow.published_version_conflict`; if admission wins first, publication
cannot change the accepted version before commit. No checkpoint, run, dispatch
outbox or execution quota charge is created on a stale rejection.

Commit a narrow terminal stale-rejection receipt with the original request hash
and safe expected/observed version identifiers. Return the domain error only
after committing it, not by throwing away its transaction. For 24 hours, exact
retry returns the same rejection even if that version is republished; changed
intent conflicts. Successful execution receipts remain authoritative and must
take precedence over negative receipts. Do not put a rejected result into a
shared decoder that requires an accepted run, redesign trigger receipts, or let
a negative receipt mask success. Prove mutual exclusion and atomic outcomes.

Both case mutation and stale-rejection receipts have a 24-hour replay window;
accepted manual starts retain the existing 24-hour receipt default. Reapers
remove terminal receipts only, respecting legal hold. After removal, key reuse
is a new command, not permanent deduplication. Existing input retention is 30
days, summaries 90 days and audit events 365 days under ADR013. No receipt may
survive required workspace erasure or disclose erased payloads.

## Loaded intent and frontend failure semantics

Loading copies JSON into a local editable form. A subsequent case edit or
deletion does not change or revoke that detached input, nor revoke an accepted
run. Deletion denies future loads; current loss of workspace access or
`run:start` denies submission/recovery. Shared cases survive creator membership
removal; account erasure minimizes creator attribution under existing policy.

Explicit confirmation shows version context and real effects. Freeze input,
deadline, expected version and idempotency key before sending. An uncertain
outcome permits only exact retry, not replacement intent or automatic reconnect
submission; temporary authorization-read failure does not discard uncertainty.
An acknowledged run retains its ID and opens with fresh authorization without
another POST. A definitive publication conflict never auto-rebinds the case or
replaces the expected version: refresh, deliberately review/new case, then issue
a fresh confirmed command/key. After receipt expiry, explain recovery limits and
check existing runs before a deliberate new start; never promise eternal
exactly-once creation. Scope/session changes fence late responses and clear
forbidden cached payloads.

## Bounded storage, deletion and lock-order obligations

Names are trimmed 1–128 characters. JSON is at most 64 KiB canonical UTF-8,
depth 64 and 10,000 members. Defaults are 20 active cases/workflow, 200 active
cases/workspace and 4 MiB **all retained case payload bytes/workspace**. Count
legal-held logically deleted payloads and any retained replaced payloads until
physical erasure; create/delete/edit churn cannot free bytes prematurely. Active
counts decrease on logical deletion; byte charges decrease only atomically with
erasure. Concurrent create/update/delete and cleanup serialize quota changes.
Use canonical byte counts, not `jsonb::text` equivalence. Paginate metadata and
fetch one payload on demand. These caps are not F12 billing or run limits.

Cases persist until deletion/workspace purge, not preview/run TTL expiry.
Archived workflows permit inspection, not case writes/new starts. Under hold,
deletion immediately hides payloads while deferring destruction. Add bounded
cleanup batches (maximum 100 cases or receipts and 1 MiB case payload per
transaction, with existing retention timeout/cancellation budgets), resumable
progress and safe audit facts. Audit retains existing 365-day policy, not
payloads/names; receipts store no JSON/name/raw key. Warn
against pasted secrets/PII; do not claim arbitrary text is redacted. F05 duplicate
does not copy cases.

Before SQL implementation, map and test this order against actual current
functions, not just a local happy path:

| Path | Required relationship |
| --- | --- |
| Manual command | Workspace authority first; actor/membership locks in stable order; manual key lock; fresh success/negative receipt lookup; compatibility release; workflow publication lock; existing acceptance/entitlement/counter/run/outbox order |
| Publication | Current authority and its own receipt; compatibility release before exclusive workflow lock and draft; never acquire the manual key lock from publication |
| Membership removal | Workspace/lifecycle authority before membership mutation; a held current capability either commits first or revocation wins and admission denies; no inverse key-lock acquisition |
| F12/F29 admission | Preserve entitlement-share then workspace-counter-update and existing coordinator/reservation order; case quota accounting must not acquire execution counters or alter tickets/dispatch |
| Case writes | Current authority; case-command receipt; workflow then case-capacity/row locks; quota and payload changes commit together |
| Physical cleanup/purge/hold | Existing legal-hold/destruction advisory lock before workspace lifecycle lock, then bounded case/receipt erasure; never acquire that advisory lock after holding command authority |
| Receipt expiry | Coordinate with manual key serialization and fresh lookup; bounded terminal-row locking must not wait in inverse receipt-to-key order; expiry cannot manufacture acceptance or leave success masked |

Case/version references must not block established deletion order: explicitly
purge cases and their receipts before workflow versions/workflows. Use existing
legal-hold/destruction coordination for physical erasure; normal admission must
not wait for that lock after taking workspace locks. Qualify lock interleavings
against purge, revocation, publication, entitlement changes, expiry and admission
before enablement; fix an incompatible order, not hide it with deadlock retries.

## Rollout, rollback and consequences

Additive schema, grants, readiness and purge/reaper support precede case readers
and writers. Keep case controls and checked commands disabled until every serving
manual writer, including omitted-field requests, uses the shared serialization
and understands negative outcomes. Old strict HTTP parsers reject the added
field, and old writers can bypass serialization: a UI flag alone is not a mixed
deployment compatibility gate. Prove migration-head compatibility and deploy
compatible readers/writers everywhere before enabling either case writes or
checked admission. Existing unchecked manual starts remain usable on compatible
writers; rollback disables new controls/checked admission while retaining
receipt-aware serialized writers for the recovery window, or drains admission.
Never roll back to a writer that ignores live rejection receipts.

The trade-off is explicit durable version context and short-lived negative
outcomes instead of silently using a newer publication. Detached loaded inputs
keep ordinary manual execution independent of mutable case lifecycle. No
historical selector, automatic input retargeting, preview isolation, recorded
sample reuse, arbitrary assertions or production rollout is added. Required
qualification is specified in the F02 first-slice plan; this ADR is not evidence
that any behavior has been implemented or tested.
