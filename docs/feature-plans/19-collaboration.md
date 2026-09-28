# F19 — Comments and editing presence, then multiplayer

Status: proposed plan; not implementation-authorized by this document.
Created: 2026-09-28. Parent: [product roadmap](../product-roadmap.md).
Scope: New frontend + coordination backend. Relative size: **XL**, not a calendar estimate.

## Outcome

Teams discuss changes and avoid overwrites; concurrent editing becomes a deliberate protocol only if needed.

## Current implementation and evidence

Optimistic revision/conflict handling exists (ADR011). It is not real-time collaborative editing.

Inspected anchors (paths may move during the concurrent structural cleanup):

- [docs/adr/011-optimistic-draft-concurrency.md](../../docs/adr/011-optimistic-draft-concurrency.md)
- [apps/web/src/features/workflow-editor](../../apps/web/src/features/workflow-editor)

“Not established” means no complete product was found in this targeted inventory,
not proof of absence from every file. Recheck these anchors before implementation.
Code availability is not a fresh end-to-end verification claim.

## Dependencies and planning gate

01 and 18; multiplayer decision after evidence of contention.

Comment retention/mentions, presence privacy and publishing authority. SSE suffices for one-way hints; WebSockets only when bidirectional edit protocol needs them.

Recommendations are not accepted ADRs. Resolve consequential choices before code;
use the next free ADR number when required. Do not create ADRs for routine fixes.

## Ownership and structure

Workflow discussion/presence application and persistence; web editor collaboration. Protocol ownership decided before multiplayer infrastructure.

Follow the [shared implementation rules](../product-roadmap.md#shared-implementation-rules).
These are responsibility owners, not a mandate to create empty folders/packages.
Reuse the post-cleanup canonical owners; do not restore old duplicated paths.

## Frontend work

First: workflow/node comments and presence with visible edit ownership. Later: multi-cursor shared operations, local undo semantics and conflict resolution.

## Backend work

Comments persisted and authorized; presence ephemeral with bounded expiry. If multiplayer approved, ADR compares CRDT/OT/serialized operations and migration from revision saves; durable graph validation stays authoritative.

## Delivery slices

1. Deliver comments tied to stable workflow/version/node identity; presence is optional.
2. Measure actual concurrent-edit conflicts and select protocol with offline/migration proof.
3. Implement multiuser editing as a separate milestone, not an incidental WebSocket hook.

Each slice ends in a usable, tested behavior; do not ship enabled placeholder
controls backed by invented responses.

## Acceptance evidence

Role loss midstream, deleted nodes, stale comments, two editors/offline reconnect, duplicate/out-of-order ops, schema version conflict and per-user undo.

Apply the shared completion checklist: contract/authorization tests, real
persistence and restart/race tests when relevant, real browser/backend flow for
visible behavior, and exact reviewed source/CI evidence. Mocks alone cannot close
the live gate. Record unsupported environments explicitly.

## Non-goals

Replacing safe optimistic saves before protocol proof; long-lived sockets as source of truth.

## Rollout and rollback

Presence/comments can disable independently; multiplayer must have migration-compatible fallback with no dropped edits.

No production rollout, paid provisioning or real external calls are authorized by
this plan. New persistent behavior requires additive reader/writer rollout and
retention/membership-deletion handling before enablement.

## Competitor context

Mature team workflows include sharing/review. Shared access alone does not prove a competitor's concurrent-edit protocol and is not treated as such. Sources: [n8n current documentation index](https://docs.n8n.io/sitemap.md).

Research checked 2026-09-28; product editions and availability can change.
This context informs the outcome, not Pertexo's implementation or billing policy.

## Delivery tracker

- [ ] Baseline reconciled against current code and accepted decisions.
- [ ] Product choices resolved; necessary ADR accepted.
- [ ] Contracts and failure/security model reviewed.
- [ ] Backend behavior implemented and independently verified where needed.
- [ ] Frontend behavior implemented and independently verified where needed.
- [ ] Real integrated acceptance evidence recorded.
- [ ] Rollout/rollback and limitations documented.
- [ ] Scoped PR merged with required checks; natural postmerge result inspected.

Evidence log: none for this new plan. Existing foundations above are not completion
of the proposed increment. Mark genuinely inapplicable rows with a reason rather
than fabricating work.
