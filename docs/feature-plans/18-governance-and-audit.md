# F18 — Audit log and publishing approval

Status: complete; audit and publication review merged. Updated: 2026-10-18.
Parent: [roadmap](../product-roadmap.md). Decision: [ADR 085](../adr/085-audit-and-publication-review.md).

## Current code

`app.audit_events` is the canonical append-only metadata ledger. Membership,
invitations, workflow authoring/publication/restore, tokens, variables, form
access, schedules and operator commands already append facts. The coverage pass
found gaps in webhook credential/authentication commands, connection revocation
and credential use/rotation, and data-table creation/deletion/quotas/row writes.
Connection-specific events remain useful operational history; they do not replace
the canonical audit fact. No historical facts will be invented.

The publisher already locks the draft, checks its opaque representation tag,
validates and compiles it, persists/reuses the immutable version, projects triggers,
and records the command receipt in one transaction. Reviews must use this owner.
The inbox has one TypeScript audience policy and F27 delivery/preferences. Reuse
those rather than adding another task engine or mail path.

## Decisions and rules

- Owners and admins read/export the audit log and change governance settings.
  Existing workspace roles remain unchanged. Add explicit capabilities to the
  existing policy owner; recheck active membership in each database transaction.
- Audit entries contain actor, action, target, time and bounded metadata only.
  Never include credentials, tokens, URLs containing endpoint keys, provider
  messages, run inputs/outputs, variable values, table rows or review notes.
  The reader uses a safe projection for older metadata too. Variable changes
  summarize at most 100 names with a total count/truncation marker, so replacing
  two full sets cannot exceed the existing 8 KB audit-record budget.
- Filters: person, action, target type/ID and inclusive/exclusive UTC date range.
  Stable keyset pagination uses time and ID. Page size is at most 100.
- Audit retention defaults to 365 days, adjustable from 30 through 2,555 days.
  The existing retention runner owns deletion; this does not change run retention
  or introduce legal holds. Reducing retention can permanently remove old facts.
- CSV uses the existing data-table transport, extracted into the API HTTP area
  in a move-only commit before logic changes. Both consumers share one workspace
  export slot and two instance slots through existing Redis admission. Each batch
  checks authority, reads briefly, releases the connection, then writes. No snapshot
  guarantee; concurrent changes may be absent. Keep 60-second write-idle timeout,
  five-minute maximum, byte-bounded batches and aborted downloads on failure.
  Audit exports accept at most 100,000 matching events; larger requests fail before
  sending CSV and ask for a narrower date range. Escape spreadsheet formulas.
- `Require approval to publish` defaults off. When on, every publisher requests
  review, including owners/admins. A different current owner/admin approves or
  rejects. A sole owner must add a reviewer or explicitly turn the audited policy
  off; no hidden emergency bypass. Ordinary publish/API/CLI commands cannot bypass it.
- A request binds the exact draft revision and representation tag, not a second
  copy of the graph. Any later draft edit or incompatible catalog change makes it
  stale. Approval rechecks requester/reviewer authority, policy and freshness and
  publishes through the existing publisher in the same transaction. One decision
  wins; exact idempotency replays return the original result.
  Separation applies to the requester and decider, rather than every person who
  previously edited the draft. Reuse `governance:manage` for the decision; no new
  capability or role. Changing the policy invalidates pending requests so toggling
  it off and back on cannot resurrect an earlier authorization.
- Notes/comments are plain text, at most 1,000 characters, stored on the request
  rather than in audit metadata. At most 100 pending requests per workspace;
  requests expire after seven days. Terminal requests retain 30 days; audit facts
  follow audit retention. Workflow/workspace deletion removes request content.
- Pending reviews appear in the existing inbox for eligible reviewers. Notices
  and email contain safe identities/names only and honor F27. Stale, expired or
  decided requests are no longer actionable. UI shows the reviewed draft and
  revision, policy, requester, note and explicit approve/reject outcomes.
  The existing attention observer discovers requests; there is no second notice
  producer. Reads and inbox eligibility share one request-state rule. A stale
  request never displays a newer graph as the reviewed candidate. The publisher
  keeps one transaction core, with separate normal-publish and decision receipts.

## Ownership and slices

1. **Audit log:** close coverage gaps in the existing command transactions;
   `database/src/governance/{audit,settings}` owns read/export/settings commands;
   the existing lifecycle owner applies retention. API `governance` owns guarded
   routes; contracts own boundary schemas; web `features/governance` owns the lazy
   settings page. Extend the database's accepted per-area Node entry points.
   Additive migration, RLS/grants, schema registration and readiness move together.
2. **Publishing approval:** authoring owns review commands and the publication
   transaction; schema stores request identity/state only. Governance settings,
   inbox eligibility, authoring contracts and publish UI compose those commands.
   No new queue, service, role, runtime dependency or CI job.

Each slice is its own PR. Moves are separate commits from logic. Verify lint,
types, unit and integration tests, mocked browser journeys and the real UI at
phone/desktop widths. Merge only after required checks are green.

## Acceptance

- Audit coverage for every listed sensitive command, exact idempotent replay,
  same-transaction rollback, workspace isolation and removal/role-change fences.
- Filters, cursor ties, CSV formula protection, bounds, retention boundaries,
  slow/disconnected export and a responsive pool while the client is blocked.
- Review off/on, owner-authored review, self-approval refusal, draft/catalog change,
  role loss, racing decisions, exact version published, API/CLI refusal, inbox
  audience/preferences, purge and retention.
- Browser: audit filters/export/settings; builder request; another owner/admin
  reviews the exact revision; stale request cannot publish. Accessible controls,
  keyboard navigation, reduced motion and the existing Weft language.

## Enablement and retention follow-up (2026-10-18)

- Before changing approval from off to on, the existing governance command must
  find another active person with an active membership and `governance:manage` in
  this workspace. Exclude the actor; derive roles from the shared TypeScript
  capability owner. Check after receipt replay/current revision, under the existing
  workspace lock. Refuse with “Add another active owner or admin before requiring
  approval to publish.” A refusal rolls back the receipt, revision and audit fact.
  The policy form shows this safe validation reason through its existing Notice,
  retaining the choice and normal uncertain-command recovery. Another workspace's
  owner, a builder, a suspended/removed membership or an inactive account does not qualify. No new setting, role, route or service.
- This is an enablement check, not a permanent membership constraint. Later loss
  of reviewers does not silently change policy. Existing policies, retention-only
  changes, exact receipt retries and audited disabling keep their current behavior.
- Keep audit cleanup in the existing retention rule. Use one statement timestamp
  and a constant cutoff from the contract's existing 30-day minimum so PostgreSQL
  can estimate the eligible range, then each workspace's exact cutoff. The existing
  `(workspace_id,occurred_at,id)` index serves both predicates. A stable timestamp
  alone still allowed a full scan in qualification; the shared minimum cutoff
  supplies the missing estimate. No additional index or migration is needed.
  Claim only the bounded audit page with `FOR UPDATE OF audit SKIP LOCKED`;
  do not lock workspaces. Existing maintenance
  column-update privileges already permit row locking; add no grant or RLS policy.
- Qualify role/member/account states, refusal rollback and retry, racing enables,
  replay/retention changes/disable after reviewer loss; exercise the ordinary
  publishing browser journey with another eligible reviewer at enablement. Prove
  cleanup skips an independently locked expired row, remains page-bounded, keeps
  fresh/custom-retention rows and uses the workspace/time index on a populated ledger.

- [x] Enablement guard and transactional/browser regressions qualified.
- [x] Indexed, skip-locked retention and populated-database upgrades qualified.

Qualification: 41 governance/retention PostgreSQL cases plus four upgrade and
retention-cancellation cases pass. The 20,000-event ledger uses the existing
workspace/time index without planner overrides; a locked expired row is skipped,
a later pass removes it, and workspace settings remain writable. Three actual
browser journeys cover audit/CSV at 1280/375 pixels and the refusal, enablement,
builder request and owner review. All 215 mocked browser journeys, 571 database,
313 contracts and 1,292 web unit tests, strict types, lint and web build pass.
React Doctor reports 100/100 for the changed React code.

## Later

Folder-level workflow access lists, custom roles, workspace run-retention controls,
external secret stores and compliance claims. SSO/provisioning is F28; promotion
is F17. No unrelated authorization rewrite.

## Tracker

- [x] Current-code coverage and decisions reconciled; ADR accepted.
- [x] Audit coverage, settings, API and page implemented.
- [x] Audit integration/browser evidence and green PR merged: [#342](https://github.com/vigani1/pertexo/pull/342).
- [x] Exact publication review, policy and inbox implemented.
- [x] Review integration/browser evidence and green PR merged: [#343](https://github.com/vigani1/pertexo/pull/343).

Audit evidence (2026-10-17): ten real PostgreSQL governance cases cover
microsecond cursor ties, safe legacy metadata, 100,000-event export refusal,
formula protection, exact settings retries/conflicts, retention, full variable-set replacement, cross-workspace
access, builder refusal, mid-export demotion and a stalled one-client pool.
Existing data-table/connection integration journeys pass (88 tests); real API
export tests prove table/audit downloads share admission while ordinary requests
stay responsive. Real browser journeys pass at 1280 and 375 pixels, including
native CSV, filters and retention after reload. The journey joins the existing
live-3 browser shard, with no new CI job. Publishing review is not delivered
by the audit slice; remaining gates and merge evidence will be recorded below.

Review evidence (2026-10-18): eleven real PostgreSQL cases cover exact publication,
owner/self-review, racing decisions, policy toggles, saved edits and catalog drift,
requester/reviewer demotion, cross-workspace reads, compilation rollback, retention,
the 100-pending-request bound and freeing a slot, and maintenance purge. The existing
observer/inbox/personal-mail path is exercised without including notes in mail.
Populated-database upgrade suites pass. Seven API application cases cover audience,
strict bounded inputs, command attribution and explicit conflicts. The editor's
uncertain request test proves retries preserve the original note, ETag and key.
Real browser qualification covers a builder requesting on a 375-pixel phone, an
owner publishing revision 2 exactly at 1280 pixels, and a later edit hiding the
stale candidate and decision controls. React Doctor reports 100/100 on the changed
frontend files after separating publication controls, settings and view-state copy.
Full checks, all 214 mocked browser journeys, all real-browser CI groups, database/service/worker integration, security and CodeQL passed on the exact source head before #343 merged.
