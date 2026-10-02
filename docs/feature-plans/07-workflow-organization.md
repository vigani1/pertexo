# F07 — Folders, tags, favorites and workspace discovery

Status: ADR064/contract and qualified F06 handoff accepted; persistent continuation
authorized on allocated exact integration base; implementation/qualification open.
Created: 2026-09-28. Parent: [product roadmap](../product-roadmap.md).
Scope: Metadata backend + frontend. Relative size: **M**, not a calendar estimate.

## Outcome

Teams can find and organize many workflows without mistaking folder placement for authorization.

## Current implementation and evidence

Workspace workflow lists and search, archive/restore and activation exist. No complete tags/folders/favorites product was established by this inventory.

Inspected anchors (paths may move during the concurrent structural cleanup):

- [apps/web/src/features/workflows](../../apps/web/src/features/workflows)
- [apps/api/src/workflow-authoring](../../apps/api/src/workflow-authoring)
- [docs/adr/034-workflow-archive-restore-and-activation.md](../../docs/adr/034-workflow-archive-restore-and-activation.md)

“Not established” means no complete product was found in this targeted inventory,
not proof of absence from every file. Recheck these anchors before implementation.
Code availability is not a fresh end-to-end verification claim.

## Dependencies and planning gate

01; implement only organization actions not already present.

Folders are organization only in V1, not permission inheritance. Decide tag normalization and deletion behavior.

The primary accepted [ADR064](../adr/064-workflow-organization-metadata.md) and
the [concrete organization contract](07-organization-contract-proposal.md) after
full exact-source review at `a0508cd0` on 2026-10-02. It specifies tags/private
favorites first, authoritative bounded discovery, revision/replay/privacy,
hold-aware departure, bounded tag deletion and archived cleanup, shared lock
order, signed cursor integrity and compatible reader/writer rollback. Folders
and general bulk are required later slices, not omitted from F07 completion.
Folder name/sibling uniqueness and command schemas need a reviewed follow-on.
Migration 0134 is now allocated exclusively to F07 against release-owner verified
base `936612f26567f760c83e41c13e4c7fc7b620e69f`; no schema or writer is installed
or enabled yet. Its tree is identical to accepted F06 `eed68cd6`.

Continuation authorized by primary final source review on 2026-10-02: F06
candidate `eed68cd67b45280db3951981da7e29b3726e06c7` is accepted and its release
handoff is owned by the release chat. That reviewed foundation is integrated
additively in this isolated F07 worktree, preserving accepted planning commit
`342239d8` and all F06 features/fixes. No history rewrite or mutation of the F06
checkout. Contracts/model/frontend preparation can proceed; persistent SQL must
use the release owner's subsequently verified exact locally qualified integration
base and migration allocation, not stale inventory `1433780b`. That reconciliation
is complete and integrated additively by normal merge. Hosted CI is not a
prerequisite to that local base decision. Folders and general bulk remain required
F07 acceptance scope; tags/favorites slice 1 is not completion of the feature.

Recommendations are not accepted ADRs. Resolve consequential choices before code;
use the next free ADR number when required. Do not create ADRs for routine fixes.

## Ownership and structure

Workflow-authoring metadata/persistence/contracts and web workflows; favorites have user ownership.

Follow the [shared implementation rules](../product-roadmap.md#shared-implementation-rules).
These are responsibility owners, not a mandate to create empty folders/packages.
Reuse the post-cleanup canonical owners; do not restore old duplicated paths.

Preparation inventory identifies two integration constraints: owner/admin tag
vocabulary uses an organization-specific role check, not a global broadening of
the existing owner-only `workspace:manage` capability. Organization cache keys
use a sibling feature prefix beneath the existing identity/workspace scope, not
legacy summary-list keys or the F06 portability lifetime prefix. This preserves
strict cached summary decoding and prevents organization-specific denials from
discarding unrelated portability recovery. Targeted rename/archive/organization
invalidation must include organized lists; root identity/workspace cancellation
and genuine authority loss remain fenced. Unsupported readers return sanitized
unavailable, never fabricated empty metadata.

## Frontend work

Bounded search/filter URL state, tags and favorites first; folder navigation later if needed, keyboard actions and explicit bulk outcomes.

## Backend work

Workspace-owned metadata and indexes, user-specific favorites, bounded folder depth and move-cycle checks. Reuse existing list/search owner; no external search cluster without measured need.

## Delivery slices

1. Select tags/favorites semantics and add metadata commands/read projections.
2. Deliver filters and consistent list/card navigation.
3. Add folder moves and bounded bulk actions; test concurrent rename/move/archive.

Each slice ends in a usable, tested behavior; do not ship enabled placeholder
controls backed by invented responses.

## Acceptance evidence

No cross-workspace moves, no folder cycles, query bounds, favorite privacy, stale move conflicts, accessible navigation and preserved filters.

Apply the shared completion checklist: contract/authorization tests, real
persistence and restart/race tests when relevant, real browser/backend flow for
visible behavior, and exact reviewed source/CI evidence. Mocks alone cannot close
the live gate. Record unsupported environments explicitly.

## Non-goals

A second workspace permission model, unbounded recursive folders or replacing existing search.

## Rollout and rollback

Hide new organization controls without losing workflow identities or archive states; additive metadata stays readable.

No production rollout, paid provisioning or real external calls are authorized by
this plan. New persistent behavior requires additive reader/writer rollout and
retention/membership-deletion handling before enablement.

## Competitor context

n8n documents workflow tags/favorites; Make documents scenario organization. Exact UX need not match either. Sources: [n8n current documentation index](https://docs.n8n.io/sitemap.md); [Make scenario capabilities](https://help.make.com/scenarios).

Research checked 2026-09-28; product editions and availability can change.
This context informs the outcome, not Pertexo's implementation or billing policy.

## Delivery tracker

- [x] Baseline reconciled against current code and accepted decisions.
- [x] Slice-1 product choices resolved; necessary ADR accepted. Folder-specific
      name/uniqueness/command decisions remain required before its later slice.
- [x] Slice-1 contracts and failure/security model reviewed; concrete folder/bulk
      implementation reviews and all execution evidence remain open.
- [ ] Backend behavior implemented and independently verified where needed.
- [ ] Frontend behavior implemented and independently verified where needed.
- [ ] Real integrated acceptance evidence recorded.
- [ ] Rollout/rollback and limitations documented.
- [ ] Scoped PR merged with required checks; natural postmerge result inspected.

Evidence log: source inventory `1433780b`, proposed contract `dbe5a0a6`, concrete
ADR/contract `a0508cd0` accepted by primary exact-source review. Documentation
checks pass (21 tests/451 links at that draft). This is design evidence only:
no F07 persistent behavior, live journey, independent implementation review or
release is complete. Existing foundations are not completion of this increment.

Implementation foundation `5d6df9b4`: strict browser-safe organization command,
metadata and explicit projection schemas; canonical ASCII/U+0020 tag keys,
ordered bounded cleanup and literal UTF-8 query bounds. Contracts build/typecheck,
203 tests, unchanged generated transport artifacts and architecture/complexity/
duplication checks pass. These are primitives, not registered organization HTTP
commands or installed database behavior.

Implementation foundation `71a7676c`: signed organization cursor helper and
dedicated optional API key parser; version-1 fixed-order bounded payload,
HMAC-SHA256, 15-minute
expiry, exact timestamp/UUID position and scope/filter/order binding. Stable
canonical 32-byte base64 configuration rejects direct/previous identity key reuse;
there is no fallback or reader/writer enablement. Runtime wiring remains open.
The API dependency build, API strict typecheck/build, 1,982 API unit tests
(including 52 cursor and 18 key-configuration cases), narrow lint/format checks,
19 architecture tests, complexity ratchet and eight duplication-policy tests
pass; no quality baseline changed. Documentation checks pass (21 tests/456 links).
The [persistence implementation constraints](07-organization-persistence-design.md)
record the primary-accepted membership-generation and private held-evidence
approach before SQL, including explicit hold/lock/purge proof obligations.

The primary accepted a pre-favorite-helper correction: an absence expectation is
a bounded authenticated generation-bound `absent.v1` read token, not a timeless
`absent` literal. A command never delivered before departure has no receipt;
the token must still reject that old request after rejoin. ADR064 and the concrete
contract now specify the opaque HMAC wire, 24-hour TTL, five-second issuance clock
skew and mandatory receipt-first recovery before expiry/rotation verification.
The corrected browser-safe schemas pass 204 contract tests, build/typecheck and
narrow lint; real authentication, first-delivery/replay and database races remain
unimplemented/unqualified. The SQL migration draft is not installed or committed.
