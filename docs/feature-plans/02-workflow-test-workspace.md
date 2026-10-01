# F02 — Saved test cases, pinned samples and workflow regression runs

Status: first-slice design accepted under ADR061; manager-approved planning commit
`05002263`, first-slice implementation locally qualified at `b555f994`.
Later slices remain proposed; production enablement and release remain open.
Created: 2026-09-28. Parent: [product roadmap](../product-roadmap.md).
Scope: New product over existing previews. Relative size: **L**, not a calendar estimate.

## Outcome

The first slice supplies named manual run-input cases and a separately confirmed,
version-checked real run. It visibly warns about real effects. Later isolated
previews and regression assertions must not silently call production systems.

## Current implementation and evidence

Node previews, test bar, recorded step inputs/outputs and run replay exist. No complete durable saved-case/pinned-sample product was established in inspected feature inventories.

Inspected anchors (paths may move during the concurrent structural cleanup):

- [apps/api/src/node-testing/use-case.ts](../../apps/api/src/node-testing/use-case.ts)
- [apps/web/src/features/workflow-runs/workflow-runs.api.ts](../../apps/web/src/features/workflow-runs/workflow-runs.api.ts)
- [apps/web/test/features/workflow-editor/workflow-editor-test-bar.test.tsx](../../apps/web/test/features/workflow-editor/workflow-editor-test-bar.test.tsx)

“Not established” means no complete product was found in this targeted inventory,
not proof of absence from every file. Recheck these anchors before implementation.
Code availability is not a fresh end-to-end verification claim.

## Dependencies and planning gate

01; pin policy approved before production data reuse.

[ADR061](../adr/061-workflow-input-cases-and-checked-manual-start.md) resolves
ownership, immutable version context, bounds, detached loaded inputs and checked
real admission for slice 1. Preview overrides/effect isolation, recorded-sample
policy and assertion vocabulary remain gates for slices 2–3. Do not label replay
as resume, or real manual execution as a mock/preview.

Recommendations are not accepted ADRs. Resolve consequential choices before code;
use the next free ADR number when required. Do not create ADRs for routine fixes.

## Ownership and structure

Slice 1 uses canonical workflow-authoring API/database owners and contracts,
web workflows for case management, and the existing workflow-runs public command
interface and acceptance owner for real execution. Do not extend node-testing or
create a parallel admission engine. Later preview adapters belong to the isolated
testing slices, not this real-input slice.

Follow the [shared implementation rules](../product-roadmap.md#shared-implementation-rules).
These are responsibility owners, not a mandate to create empty folders/packages.
Reuse the post-cleanup canonical owners; do not restore old duplicated paths.

## Frontend work

Named input fixtures, selected sanitized recorded samples, expected-output assertions, run results and a visible mocked/pinned badge. Preview execution with real effects requires an explicit distinction.

## Backend work

Workspace-authorized, bounded test-case persistence and version references; preview-only substitution policy bound to node/schema/scope, with an explicit adapter seam. Production acceptance rejects test overrides. Start with input fixtures before arbitrary mid-graph pinning.

## Delivery slices

1. Deliver named, version-contextual run-input cases and explicitly confirmed,
   version-checked real manual start under ADR061; no recorded samples.
2. Add node sample substitution with provenance and invalidation on relevant graph/schema change.
3. Add bounded batch regression and assertion results; expose comparisons without changing real run truth.

Each slice ends in a usable, tested behavior; do not ship enabled placeholder
controls backed by invented responses.

## First slice: run-input cases and checked real start

### Accepted contract and inspected seams

The product owner selected version-checked explicit manual execution; the manager
accepted this amended design on 2026-10-01. Baseline inspection is merged main
`5f78e1552c55fede6f04264f8be4197296629e9c`, not fresh executable qualification.
Manager review of planning commit `05002263` separately authorized implementation;
both independent planning reviews had no findings. Production effects remain
unauthorized.

- Cases are shared workspace/workflow authoring assets, bound to an exact retained
  immutable version ID/checksum. Create only against an authorized retained
  published version; no mutable draft, implicit latest-version substitution or
  automatic rebinding. Inspect older context with a stale badge; changed context
  requires deliberate review/new case, then a fresh run confirmation.
- Proposed routes under
  `/v1/workspaces/:workspaceId/workflows/:workflowId/input-cases`: collection
  `GET/POST`, item `GET/PUT/DELETE`. Read/load uses `workflow:read`; writes use
  `workflow:update`, not `run:start`. Creator attribution is not ownership.
- Create requires `Idempotency-Key`; edit/delete require that key and one strong
  opaque `If-Match`. Current locked authority precedes exact retained receipt
  recovery, which precedes revision comparison. Changed intent conflicts; stale
  edits refetch and require new confirmation. Atomically commit payload/quota,
  revision, safe audit and receipt; deletion never resurrects a case.
- Add optional `expectedPublishedVersionId` to
  [workflow-runs HTTP contracts](../../packages/contracts/src/http/workflow-runs.ts).
  Thread it through existing controller, use case, persistence port/adapter and
  [database manual acceptance](../../packages/database/src/execution/runs/workflow-run-api.ts).
  Omission preserves old manual-start semantics and hash bytes; checked requests
  conditionally bind expected version into the existing canonical hash.
- Freeze that field with JSON/deadline/key through `RunIntent`, normalization,
  `startWorkflowRun`, and
  [useWorkflowRunSubmission](../../apps/web/src/features/workflow-publish/mutations/use-workflow-run-submission.ts).
  Case management stays in workflows; no direct import into preview workers.

### Authority, admission and recovery

Real start independently requires current `run:start` in an active workspace
(owner/admin/builder/operator, not viewer), rechecked under actor/membership/
workspace locks through commit. Session/CSRF, ordinary request limits, forced RLS,
composite same-workspace references and API-only case grants remain mandatory.
Capability-specific execution proof must not reuse `workflow:update` authority.

All manual writers, checked or unchecked, serialize the existing
`workflow.run.accept` / `workflow:<id>:manual` key identity. Fresh accepted-receipt
recovery follows current authority but precedes publication/compatibility/quota
checks. Inspection found early replay lookup followed by a later shared unique
claim; inserting a precondition between them alone fails concurrent accepted
duplicate recovery. Keep shared trigger/replay acceptance unchanged.

For a new command, lock compatibility release then authoritative publication.
The workflow `FOR SHARE` lock remains held through commit and conflicts with
publication's exclusive workflow update. Compare expected ID before checkpoint
creation/acceptance: return `409 workflow.published_version_conflict`, never
execute another version. Existing F12 entitlement/counter checks, F29 ticket
assignment, atomic run/checkpoint/outbox/audit and durable dispatch remain owners.

Commit a narrowly isolated terminal stale-rejection receipt for 24 hours, with
request hash and safe expected/observed IDs, not JSON. Exact retry remains rejected
even after republication; changed input/version/deadline with the key conflicts.
Accepted success always takes precedence. Return the rejection after commit;
throwing it inside the transaction must not roll back its receipt. Do not feed
negative results into the shared accepted-run decoder. Map receipt expiry and
purge to existing lifecycle owners; after expiry a key can begin a new command,
so no indefinite exactly-once promise is made.

The ADR's lock-order matrix is required implementation input. Prove actual
workspace-first authority/membership ordering, manual-key-before-receipt locking,
compatibility-before-workflow, existing entitlement-before-counter acceptance,
case quota ordering, destruction-advisory-before-workspace and expiry without
receipt-to-key inversion. Cross-check publication, membership removal, F12/F29
reservation/control, legal hold and workspace purge; resolve inversions before
SQL implementation, not by relying on deadlock retries.

### Loaded input and confirmation

Loading copies JSON into the local editable Run with input form and creates no
run. Editing that form does not edit the case; later case edits/deletion do not
rewrite or revoke detached input or an accepted run. Deleted cases cannot be
loaded again. Current access/role revocation still denies submission/recovery.

Display exact context and explicit real-effect confirmation. Uncertain transport/
protocol outcomes freeze input, deadline, expected version and key; disable new
replacement commands and permit exact retry only. Never refresh and substitute a
new expected version during recovery. Temporary authorization-read failure must
not discard uncertainty. Known acceptance stores the run ID and opens via fresh
authorization, not another POST. Scope/session changes fence late responses and
clear forbidden payload caches. A definitive stale rejection preserves input
for review but cannot auto-rebind the case; new context/new case requires a new
explicit run confirmation/key. Explain finite receipt recovery after expiry.

### Quotas, privacy and lifecycle

Defaults accepted for this slice: trimmed names 1–128 characters, JSON at most
64 KiB canonical UTF-8/depth 64/10,000 members; 20 active cases/workflow,
200 active cases/workspace and 4 MiB **all retained payload bytes/workspace**.
Count legal-held deleted payloads and any retained replaced payloads until
physical erasure. Logical deletion releases active-count slots, never retained
byte charges. Concurrent creates, edits, deletes and physical cleanup must keep
quota authority atomic; churn cannot bypass the storage cap. `jsonb::text` is not
an equivalent canonical-byte definition. Paginate metadata and fetch one payload
on demand. No workflow-wide input schema or F12 billing measure is invented.

Cases persist until deletion/purge; archived workflows are inspect-only. Hold
hides deleted payloads immediately but defers physical erasure. Maximum cleanup
batch is 100 cases/receipts and 1 MiB case payload per transaction, with existing
retention timeout/cancellation budgets and resumable progress. Add explicit
case/receipt purge before versions/workflows so retained references cannot block
existing legal deletion ordering. Receipts
are terminal-only 24-hour retention subject to hold; audit uses existing 365-day
policy. Workspace erasure applies to negative receipts too. Accepted run input
retains existing 30-day policy; summaries retain 90 days. Membership removal
revokes access, not shared case ownership; account erasure minimizes attribution.
F05 duplication does not copy cases.

Only manually entered synthetic input is included. Warn against pasted secrets/
PII. Do not persist payloads/names in logs, traces, audits or receipts, and do not
claim automatic redaction of arbitrary JSON. Recorded inputs/outputs, save-from-run,
mid-graph pins, assertions, batch regressions and preview effects remain deferred.

### Additive rollout and rollback gates

Deploy additive schema/grants/readiness and purge/reaper support before readers
and writers. Case data and checked/negative command receipt compatibility each
need qualification. Every serving manual writer, including legacy omitted-field
requests, must serialize the common key and understand retained negative outcomes
before enabling cases/checked starts. Old strict parsers reject the new field;
old writers bypass serialization. Prove an executable all-writer gate and exact
migration-head compatibility; do not infer safe mixed deployment from a UI flag.
Rollback hides new controls and disables new checked commands, but retains
serialized receipt-aware writers through recovery windows or drains admission.
Never replace them with writers that ignore retained rejections. No production
rollout, provider traffic, paid provisioning or user-service changes are authorized.

### Required first-slice evidence

- Contract/API tests: omitted-field hash byte preservation and legacy behavior;
  checked hash/conflict; safe typed publication conflict; strict bounds and CAS;
  capability matrix, actor/workspace state, tenant/non-disclosing denials.
- Real PostgreSQL: populated migration upgrade, RLS/grants/readiness drift;
  concurrent create/update quotas including held deleted bytes and replacement
  churn; rollback/restart and case CAS/exact receipts; case/version purge order.
- Real admission races: simultaneous same-key accepted duplicate plus publication
  change returns one original run; accepted success defeats stale rejection;
  fresh stale command creates only a committed rejection; exact rejection after
  republication; changed-intent conflict; expiry/key reuse and reaper races;
  current-role revocation, deletion, hold and entitlement/counter interleavings.
- Rendered frontend: detached case edits/deletion, stale/new-context confirmation,
  frozen uncertain commands, known-acceptance reopening, scope/late-response
  fences, loss of authority and finite-window truthful copy.
- Real authenticated browser/API/worker journey using owned fixtures: case CRUD,
  load without execution, pure-node publication and explicitly confirmed real
  run with original input/version; stale publication and accepted recovery.
  No provider effects, mocked-only live gate or skips treated as completion.
- Frozen-source CI/coverage and independent reviews, scoped PR and inspected
  natural-main checks; no completion while applicable gates remain open.

## First-slice delivery tracker

- [x] Reconcile current owners and manual admission against merged `5f78e155`.
- [x] Resolve and record manager-accepted choices in ADR061.
- [x] Review planning commit `05002263` and separately authorize implementation.
- [x] Implement storage/contracts/API and checked/negative manual admission.
- [x] Implement case management and frozen explicit-run frontend.
- [x] Qualify real migration, races, quotas, authority, retention and erasure.
- [x] Qualify real pure-node browser/backend journey and rollout/rollback gates.
- [ ] Complete independent review, CI, merge and natural-main evidence.

Executable focused evidence on 2026-10-01: case PostgreSQL 17/17, checked-start
PostgreSQL 31/31, authenticated case HTTP 4/4 and real browser/API/worker 1/1 pass
without skips. The browser gate owns ordinary signup, case CRUD, detached input,
stale rejection and exact response-loss recovery after distinct republications,
with one successful pure-node run and an actual 390px-wide frozen-command retry.
New case API paths and extracted request hashes have 100% branch coverage in their
focused cohorts. Serialized repository coverage passes 24 TypeScript cohorts
with zero unreviewed risk branches; full PostgreSQL integration coverage passes
850/850 across 110 files without skips. Unsupported names, NULL cleanup bounds,
publication-review display races, stale-case review/clear escapes and implicit
Enter-key real starts have regression proofs. The complete repository check
passes with package concurrency one; web unit tests pass 860/860, browser probes
7/7 and full mock-browser tests 90/90 with one worker and retries disabled.
Implementation commits are `82f3618b` (backend) and `b555f994` (UI/browser).
Manager release review, hosted CI, merge and natural-main evidence remain open.
No production enablement or provider execution is claimed.

## Acceptance evidence

Pinned provider never dispatches; production rejects pins; stale schema cannot silently pass; cross-tenant sample denied; secret fields excluded; cancellation and bounded batch behavior.

Apply the shared completion checklist: contract/authorization tests, real
persistence and restart/race tests when relevant, real browser/backend flow for
visible behavior, and exact reviewed source/CI evidence. Mocks alone cannot close
the live gate. Record unsupported environments explicitly.

## Non-goals

Arbitrary assertion JavaScript, load testing as a feature and automatic production-data capture.

## Rollout and rollback

Disable new test commands; retain existing preview behavior and stored cases, clearly marked incompatible where necessary.

No production rollout, paid provisioning or real external calls are authorized by
this plan. New persistent behavior requires additive reader/writer rollout and
retention/membership-deletion handling before enablement.

## Competitor context

n8n documents development-only pinning/mocking. Pertexo should retain an equally explicit production/test distinction. Sources: [n8n pinning and mocking](https://docs.n8n.io/build/work-with-data/pin-and-mock-data).

Research checked 2026-09-28; product editions and availability can change.
This context informs the outcome, not Pertexo's implementation or billing policy.

## Delivery tracker

- [x] First-slice baseline reconciled against current code and accepted decisions.
- [x] First-slice choices resolved; ADR061 accepted (later slice gates remain open).
- [ ] Contracts and failure/security model reviewed.
- [ ] Backend behavior implemented and independently verified where needed.
- [ ] Frontend behavior implemented and independently verified where needed.
- [ ] Real integrated acceptance evidence recorded.
- [ ] Rollout/rollback and limitations documented.
- [ ] Scoped PR merged with required checks; natural postmerge result inspected.

Evidence log: first-slice implementation and frozen-source local qualification
recorded above; release remains open. Existing foundations
are not completion of this increment.
The first two checked rows apply only to slice 1, not unresolved pins/regression.
Mark genuinely inapplicable rows with a reason rather than fabricating work.
