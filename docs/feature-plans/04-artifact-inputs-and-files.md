# F04 — File inputs and artifact lifecycle

Status: proposed plan; not implementation-authorized by this document.
Created: 2026-09-28. Parent: [product roadmap](../product-roadmap.md).
Scope: Backend foundation exists; consumer contract + frontend missing. Relative size: **L**, not a calendar estimate.

## Outcome

A user can upload a supported file and use its finalized reference in an executable workflow, not merely store an unusable attachment.

## Current implementation and evidence

Upload/finalize/download metadata and object-storage infrastructure exist; web artifacts module exposes metadata/download only. HTTP Request emits artifact output, but its current input body is inline utf8/base64—not an artifact consumer.

Inspected anchors (paths may move during the concurrent structural cleanup):

- [apps/web/src/features/artifacts/artifacts.api.ts](../../apps/web/src/features/artifacts/artifacts.api.ts)
- [apps/api/src/artifacts/service.ts](../../apps/api/src/artifacts/service.ts)
- [packages/integrations/src/http-request/validation.ts](../../packages/integrations/src/http-request/validation.ts)
- [packages/integrations/src/http-request/definition.ts](../../packages/integrations/src/http-request/definition.ts)

“Not established” means no complete product was found in this targeted inventory,
not proof of absence from every file. Recheck these anchors before implementation.
Code availability is not a fresh end-to-end verification claim.

## Dependencies and planning gate

01; choose a real artifact-consuming node before upload UI.

Streaming/hash strategy, allowed types and active-content policy; browser memory ceiling separate from server upload ceiling; retention/reference ownership and malicious-file handling.

Recommendations are not accepted ADRs. Resolve consequential choices before code;
use the next free ADR number when required. Do not create ADRs for routine fixes.

## Ownership and structure

Web artifacts and consuming editor controls; application artifacts; database artifact metadata/admission; artifact-store bytes; SDK capability and versioned consuming integration/node.

Follow the [shared implementation rules](../product-roadmap.md#shared-implementation-rules).
These are responsibility owners, not a mandate to create empty folders/packages.
Reuse the post-cleanup canonical owners; do not restore old duplicated paths.

## Frontend work

Input-local select/hash/upload/finalize/attach with progress, cancel and uncertain-finalization recovery. Persist only finalized references, never File/signed URLs in graph or Query. Optional asset library is a later slice.

## Backend work

Recommended first consumer: versioned bounded HTTP artifact-body capability or a bounded file-reading transform, selected before coding. Add authenticated worker artifact read with size/type/digest limits and pinned node version; reuse upload reservations/finalization. Do not mutate HTTP v1 semantics.

## Delivery slices

1. Choose consumer, file/privacy/scan policy and memory/size budget; ADR if introducing a new worker capability.
2. Implement consumer and real storage execution first, then input-local upload and finalization UI.
3. Add bounded asset discovery only after reference usability; later CSV/JSON parsing/creation as separately versioned nodes.

Each slice ends in a usable, tested behavior; do not ship enabled placeholder
controls backed by invented responses.

## Acceptance evidence

Real browser/object-store CORS/signatures, checksum/expiry, unauthorized reference, oversize/decompression bounds, finalization retry, abandoned uploads, exact bytes consumed by a controlled local endpoint.

Apply the shared completion checklist: contract/authorization tests, real
persistence and restart/race tests when relevant, real browser/backend flow for
visible behavior, and exact reviewed source/CI evidence. Mocks alone cannot close
the live gate. Record unsupported environments explicitly.

## Non-goals

Unlimited file manager, arbitrary filesystem access, claiming PUT alone means available, automatic base64 of unbounded files.

## Rollout and rollback

Disable new upload/consumer admission while retaining existing downloads/readers and cleanup of accepted reservations.

No production rollout, paid provisioning or real external calls are authorized by
this plan. New persistent behavior requires additive reader/writer rollout and
retention/membership-deletion handling before enablement.

## Competitor context

n8n supports file/binary workflow data. Pertexo should offer an end-to-end usable file path while retaining artifact authority. Sources: [n8n file and binary data](https://docs.n8n.io/build/work-with-data/handle-special-data-types/work-with-files-and-images).

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
