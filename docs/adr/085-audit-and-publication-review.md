# ADR 085 — Workspace audit retention and publication review

Status: accepted. Date: 2026-10-17. Feature: [F18](../feature-plans/18-governance-and-audit.md).

## Context

The owner requested audit visibility/retention and optional publishing approval.
The append-only audit ledger, immutable workflow versions, draft revision fence,
command receipts and notice delivery already exist. Governance must not create a
second publication pipeline or store secrets and run data in the audit log.

## Decision

Keep `app.audit_events` as the single metadata ledger. Append sensitive-action
facts in the same transaction as the action. Owners/admins may read/export it and
set workspace audit retention to 30–2,555 days, default 365. This amends ADR 013's
fixed audit retention only; ADR 069's simplified lifecycle remains authoritative.
Reads use a safe metadata projection; historical unrecorded facts are not invented.
CSV is bounded and uses short database checkouts, shared export admission and
backpressure, without promising a snapshot across batches.

Publishing approval is off by default. When enabled it applies to every publisher.
A different active owner/admin must approve the exact draft revision and opaque
representation tag. A later edit or compatibility change invalidates the request.
The decision, fresh permissions, existing publication pipeline and command receipt
commit atomically. Normal publish endpoints have no bypass. Owners/admins may
explicitly disable the policy in an audited settings command; a single owner is
not silently exempt. This preserves separation of duties without a new role.

Review requests retain bounded notes separately from audit facts. Existing inbox
eligibility and F27 delivery own reviewer notices. Review records are workspace
scoped, expire, follow deletion/purge, and do not duplicate a stored executable.
The short plan owns exact operational bounds and delivery slices.

Implementation clarification, 2026-10-18: the requester and decider must differ;
this does not exclude every person who previously edited the draft. Decisions
reuse `governance:manage`. A policy change invalidates pending requests, so an
off/on toggle cannot revive earlier review authority. One TypeScript request-state
owner supplies authoring and inbox eligibility; the existing attention observer
and F27 delivery discover requests without another notice producer.

Enablement clarification, 2026-10-18: switching approval on requires another
current active owner/admin in the same workspace, excluding the person changing
the setting. The settings command checks under its workspace lock and refuses
without changing state or recording a successful settings fact. This does not
prohibit later member removal or silently disable an existing policy; explicit
audited disabling and exact command retries remain available.

## Consequences

Review requires another eligible person while enabled. A request cannot authorize
future edits or survive loss of authority. Disabling approval is visible in the
audit trail. CSV downloads may omit concurrent changes and fail rather than
silently truncate. Audit retention reduction is irreversible after cleanup; the UI
must explain that consequence. No new service, role, queue or compliance claim.
