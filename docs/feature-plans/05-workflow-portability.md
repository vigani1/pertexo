# F05 — Workflow duplicate, safe import and export

Status: proposed plan; not implementation-authorized by this document.
Created: 2026-09-28. Parent: [product roadmap](../product-roadmap.md).
Scope: New cross-stack authoring slice. Relative size: **M–L**, not a calendar estimate.

## Outcome

Move or reuse workflow structure safely, without copying secrets, workspace IDs or historical executions.

## Current implementation and evidence

Immutable workflow versions and draft validation exist. Node duplication exists in editor tests; that is not complete workflow-level portable import/export.

Inspected anchors (paths may move during the concurrent structural cleanup):

- [apps/api/src/workflow-authoring](../../apps/api/src/workflow-authoring)
- [apps/web/test/features/workflow-editor-body-model.test.ts](../../apps/web/test/features/workflow-editor-body-model.test.ts)
- [packages/workflow-model/src/graph-contract.ts](../../packages/workflow-model/src/graph-contract.ts)

“Not established” means no complete product was found in this targeted inventory,
not proof of absence from every file. Recheck these anchors before implementation.
Code availability is not a fresh end-to-end verification claim.

## Dependencies and planning gate

01; manifest format chosen before 06. No dependency on file uploads.

ADR only if portable format/compatibility or new atomic command creates consequential contract. Cross-platform n8n/Make import is not assumed.

Recommendations are not accepted ADRs. Resolve consequential choices before code;
use the next free ADR number when required. Do not create ADRs for routine fixes.

## Ownership and structure

Workflow-authoring application and persistence; model graph/identity validation; contracts portable manifest; web workflows/editor.

Follow the [shared implementation rules](../product-roadmap.md#shared-implementation-rules).
These are responsibility owners, not a mandate to create empty folders/packages.
Reuse the post-cleanup canonical owners; do not restore old duplicated paths.

## Frontend work

Duplicate workflow, download portable manifest, import preview and compatibility report, explicit connection rebinding and recovered outcome after lost response.

## Backend work

Versioned bounded portable manifest, normal graph admission, recursive identity/reference remapping, required catalog compatibility and atomic/resumable create semantics. Export only allowed configuration; sanitize credential-like data deliberately.

## Delivery slices

1. Deliver same-workspace **Duplicate workflow** first, as a standalone quick
   win: copy the current draft or a chosen version into a new draft with every
   identity remapped and connection references kept (same workspace, same
   authority). It needs no manifest and can ship ahead of the rest of F05.
2. Define manifest and exported source (draft versus immutable version), validate size/depth and secret handling;
   then export/import with dry-run compatibility and credential slots, reusing the duplicate remapper.
3. Test nested graphs, multiple versions and idempotent import; add dependency bundles only after subworkflows exist.

Each slice ends in a usable, tested behavior; do not ship enabled placeholder
controls backed by invented responses.

## Acceptance evidence

Every nested edge/mapping reference remapped; unknown nodes rejected before writes; no cross-tenant refs/secrets; import retry creates one draft; publish/run always explicit.

Apply the shared completion checklist: contract/authorization tests, real
persistence and restart/race tests when relevant, real browser/backend flow for
visible behavior, and exact reviewed source/CI evidence. Mocks alone cannot close
the live gate. Record unsupported environments explicitly.

## Non-goals

Copying connection secrets, automatic activation or accepting arbitrary competitor graph JSON.

## Rollout and rollback

Keep manifest readers versioned; disable import writers without invalidating existing workflows.

No production rollout, paid provisioning or real external calls are authorized by
this plan. New persistent behavior requires additive reader/writer rollout and
retention/membership-deletion handling before enablement.

## Competitor context

Make blueprints export workflow structure and require users to reconnect accounts after import. Adopt safe rebinding rather than provider-credential copying. Sources: [Make blueprints](https://help.make.com/blueprints).

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
