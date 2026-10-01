# F05 — Workflow duplicate, safe import and export

Status: same-workspace duplication first slice implemented and locally qualified
under ADR060; independent review and release qualification pending.
Import/export remain proposed.
Created: 2026-09-28. Parent: [product roadmap](../product-roadmap.md).
Scope: New cross-stack authoring slice. Relative size: **M–L**, not a calendar estimate.

## Outcome

Move or reuse workflow structure safely, without copying secrets, workspace IDs or historical executions.

## Current implementation and evidence

Whole-workflow duplication now copies an authoritative saved draft or explicitly
chosen immutable version into an independent unpublished revision-1 draft.
Canvas node duplication remains a separate operation. Portable import/export is
not implemented by this slice.

Implementation and verification anchors:

- [apps/api/src/workflow-authoring](../../apps/api/src/workflow-authoring)
- [packages/database/src/authoring/workflow-authoring-duplication.ts](../../packages/database/src/authoring/workflow-authoring-duplication.ts)
- [apps/web/src/features/workflows/components/workflow-duplicate-dialog.tsx](../../apps/web/src/features/workflows/components/workflow-duplicate-dialog.tsx)
- [apps/web/e2e-live/workflow-duplication.spec.ts](../../apps/web/e2e-live/workflow-duplication.spec.ts)
- [apps/web/test/features/workflow-editor/workflow-editor-body-model.test.ts](../../apps/web/test/features/workflow-editor/workflow-editor-body-model.test.ts)
- [packages/workflow-model/src/graph-contract.ts](../../packages/workflow-model/src/graph-contract.ts)

Local acceptance uses enabled real PostgreSQL, authenticated HTTP and the
browser/API/worker journey; source availability alone is not verification.
Independent review and hosted exact-head/natural-main checks remain release gates.

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

1. Deliver same-workspace **Duplicate workflow** first: copy the saved current
   draft or an explicitly chosen version into a new workflow's revision-1 draft.
   Per accepted [ADR060](../adr/060-workflow-duplication-identity.md), generate
   a new workflow identity while preserving graph-local node/edge IDs and all
   references, including dynamic expressions. Keep same-workspace connection
   references, not secret bytes. It needs no manifest and can ship independently.
2. Define manifest and exported source (draft versus immutable version), validate size/depth and secret handling;
   then export/import with dry-run compatibility and credential slots. Resolve
   destination reference/identity rules separately; do not assume whole-workflow
   duplication introduced a remapper.
3. Test nested graphs, multiple versions and idempotent import; add dependency bundles only after subworkflows exist.

Each slice ends in a usable, tested behavior; do not ship enabled placeholder
controls backed by invented responses.

## Acceptance evidence

Whole-workflow duplication preserves every nested graph reference and creates an
independent workflow; unknown/non-placeable definitions and cross-tenant
references are rejected before writes. Exact command retries create one draft;
publish/run remain explicit. Later import/export requires a separately resolved
manifest, secret handling and destination-reference contract.

## First-slice implementation contract

ADR060 is authoritative for identity, source selection, admission, transaction
ordering, replay and operational defaults. Current baseline is merged main
`0f54e31dcbb18abaf3cbe88b27edfaa3e877e8b1`. Existing owners include
`workflow-authoring-drafts.ts`, `workflow-authoring-version-restore.ts`, the
workflow-model graph/parser and the web workflows/editor features. Existing
canvas `duplicateWorkflowNodes` is a different operation and is not changed or
used as a whole-workflow cloning implementation.

Implementation sequence:

1. Add strict shared command/result/problems/OpenAPI and the atomic persistence
   method, including an additive migration only where creation grants/receipt
   authority require it. Prove source/destination scoping, new defaults, replay,
   all-or-nothing writes and races through real runtime-role integration tests.
2. Wire one authenticated authoring use case/controller, existing authorization,
   safe telemetry and request lifetime. Prove draft/version selection, stale
   source tags, denied access and lost responses through actual HTTP persistence.
3. Add Duplicate actions to the workflow list/detail and an explicit selected
   version action in version history using existing accessible menu/dialog
   patterns. Default the editable name to a bounded copy of the source name.
   Show which saved source is selected; never imply unsaved edits are copied.
   Dirty/in-flight/conflicted editor state must be resolved explicitly before
   draft duplication. Navigate only after a confirmed destination result.
4. Retain the exact name/source/tag/key after an uncertain result for explicit
   retry. A stale draft requires refetch and explicit confirmation of a new
   command, not automatic rebasing. Cancel/fence in-flight authorized reads and
   discard sensitive command/cache state on session/workspace/access loss, while
   ordinary conflicts preserve recoverable user intent. Do not persist graph or
   command payloads in local storage or run automatic mutations on reconnect.
5. Qualify nested For Each, Parallel/Merge, typed mappings and dynamic JSONata;
   prove source and copy can be edited/published/executed independently with the
   same internal IDs and without old run outputs/state leaking. Use owned local
   providers only; no real external effect or production activation.
6. Run relevant checks, source-bound coverage and enabled live browser/backend
   evidence; ensure new integration tests have an explicit ordinary CI owner and
   strict zero-skip reports. Obtain independent spec/standards reviews, repair
   findings, then green exact-head and natural-main checks before completion.

This is not import/export, templates, cross-workspace copy, new expression
syntax, a new execution identity model or automatic activation. Keep the slice
cohesive and reuse current owners. Preserve unrelated work and services.

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

For this first slice, apply additive migration 0129 before admitting serving and
restore images qualified against that exact head. Existing 0128 images fail the
startup boundary, so hold traffic closed during this migration-head cutover;
there is no claimed mixed-head overlap. See the [function readiness
inventory](../operations/database-function-readiness.md). Disable the duplication
writer to roll back product exposure without deleting copies or rewriting graph
IDs. An application rollback image must still accept 0129. Copies never publish
or activate automatically. Exact replay depends on current authority and retained
source/destination visibility; the existing 24-hour receipt reaper (subject to
legal hold) is not a forever-deduplication guarantee. Real tests prove expiry,
membership fencing and bounded workspace erasure of source-scoped receipts.

## Competitor context

Make blueprints export workflow structure and require users to reconnect accounts after import. Adopt safe rebinding rather than provider-credential copying. Sources: [Make blueprints](https://help.make.com/blueprints).

Research checked 2026-09-28; product editions and availability can change.
This context informs the outcome, not Pertexo's implementation or billing policy.

## Delivery tracker

- [x] First-slice baseline reconciled against current authoring/model owners.
- [x] First-slice identity and command decisions accepted in ADR060; broader portability deferred.
- [ ] Contracts and failure/security model reviewed.
- [ ] Backend behavior implemented and independently verified where needed.
- [ ] Frontend behavior implemented and independently verified where needed.
- [x] Real integrated acceptance evidence recorded.
- [x] Rollout/rollback and limitations documented.
- [ ] Scoped PR merged with required checks; natural postmerge result inspected.

Evidence log: 2026-10-01 user approved preserving graph-local IDs in whole-workflow
copies. Manager confirmed policy-v1 accepts dynamic `nodeOutputs` lookup and
recorded ADR060 before implementation. The owned slice now implements strict
contracts/API, atomic source-scoped persistence and rendered duplication actions.
Focused enabled PostgreSQL (25 cases) and all ordinary API integration (113
cases) checks pass. The enabled live browser/API/database/worker journey passes:
saved-draft and chosen-version copies preserve the nested graph and dynamic
expressions, three independent workflow/version/run identities produce their own
outputs, and a copy-only edit leaves its source and sibling unchanged. Normal
fixture teardown and strict zero-skip reports pass. Local qualification includes
the full repository check, 90 browser journeys, 831 web tests, all 821 PostgreSQL
integration tests across 109 files, and 24 source-bound coverage cohorts with zero
unreviewed risk branches. Independent review and hosted release checks remain
pending; this does not complete import/export or authorize production activation.
