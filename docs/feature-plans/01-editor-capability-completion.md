# F01 — Complete and qualify the existing editor surface

Status: PR verified/merged — three bounded parity fixes implemented and
independently reviewed; real all-five/nested 2×2 execution and cleanup pass.
Real conflict/later-version/workspace-read isolation, read-only layout, schedule
and controlled HTTP composition also pass. PR113/114 and exact natural main
CI/CodeQL close the bounded release gates; external qualification remains open.
User authorized sequential roadmap work on 2026-09-28;
this document alone does not authorize deployment or external services.
Created: 2026-09-28. Parent: [product roadmap](../product-roadmap.md).
Scope: Frontend-led parity, not a rebuild. Relative size: **M**, not a calendar estimate.

## Outcome

Every currently publishable node can be configured, saved, reloaded and understood through a supported UI path; identify only concrete gaps.

## Current implementation and evidence

Nested For Each commands, scoped layout, body UI, undo and editable JSONata/structured-input mappings already exist in current source. Older M1 documentation says these are deferred; that wording is stale. Version compare/restore and trigger settings also exist.

Inspected anchors (paths may move during the concurrent structural cleanup):

- [apps/web/src/features/workflow-editor/model/graph-scopes.ts](../../apps/web/src/features/workflow-editor/model/graph-scopes.ts)
- [apps/web/src/features/workflow-editor/model/graph-commands.ts](../../apps/web/src/features/workflow-editor/model/graph-commands.ts)
- [apps/web/src/features/workflow-editor/components/inspector/input-mappings/mapping-source-editor.tsx](../../apps/web/src/features/workflow-editor/components/inspector/input-mappings/mapping-source-editor.tsx)
- [apps/web/test/features/workflow-editor-for-each.test.tsx](../../apps/web/test/features/workflow-editor-for-each.test.tsx)
- [apps/web/test/features/workflow-editor-body-model.test.ts](../../apps/web/test/features/workflow-editor-body-model.test.ts)
- [apps/web/src/features/workflow-settings/workflow-versions-page.tsx](../../apps/web/src/features/workflow-settings/workflow-versions-page.tsx)

“Not established” means no complete product was found in this targeted inventory,
not proof of absence from every file. Recheck these anchors before implementation.
Code availability is not a fresh end-to-end verification claim.

## Dependencies and planning gate

00; public node and graph contracts remain authoritative.

What validation occurs while typing versus on explicit preview; define sanitized sample data and limits before a new evaluator endpoint. Routine parity needs no new architecture ADR.

Recommendations are not accepted ADRs. Resolve consequential choices before code;
use the next free ADR number when required. Do not create ADRs for routine fixes.

## Ownership and structure

Web workflow-editor and workflow-settings; existing catalog/model admission and node-testing adapters.

Follow the [shared implementation rules](../product-roadmap.md#shared-implementation-rules).
These are responsibility owners, not a mandate to create empty folders/packages.
Reuse the post-cleanup canonical owners; do not restore old duplicated paths.

## Frontend work

Build a catalog-to-control matrix: inputs, outputs, credential slots, constraints and graph scope. Verify nested body navigation, mapping error locations, copy/duplicate ID remapping, undo/redo, save conflicts and unsupported-version preservation. Add expression assistance only where missing; do not replace working controls.

## Backend work

Reuse graph admission, catalog schemas and isolated restricted JSONata evaluation. Add a bounded validation/preview read only if existing preview cannot serve a concrete UI requirement; never run a second unrestricted browser evaluator.

## Delivery slices

1. Inventory catalog fields against current controls and live behavior; reconcile stale plan claims in the implementation slice.
2. Close missing controls and contextual errors through the existing editor-owned state and feature modules.
3. Verify real save→reload→publish→run for loops, branches and all five mapping kinds.

### Reviewed-source inventory (2026-09-28)

Baseline: merged `fcb0c44ca5d9f1a921165207fb33f2802d1688f7` (PRs 99/100).
This is source inspection, not newly executed runtime acceptance. The catalog
projection was inspected through `platformBrowserNodeDefinitionCatalog` at
`validate_activation`: release epoch 38, fingerprint
`node-compat:v1:sha256:208014d9280b598067aa5bee159b92ffe0740d336bfbea60643da058c6e15d41`.
It contains 21 publishable definition versions across 15 keys. API configuration
defaults to cohort `core`; the matrix is the broader qualification ceiling, not
a claim that every environment enables every row. Record the actual cohort in
each integrated result. Retain pinned versions; do not upgrade existing nodes.

All rows retain advanced configuration JSON where applicable. Primitive/enum
fields, specialized builders and JSON are supported editing paths, not a
requirement to replace every schema property with a bespoke control. Schema
validation and executable admission remain backend-authoritative.

| Definition versions | Configuration / constraints and existing control | Execution inputs → outputs / routing | Connection slot and scope |
| --- | --- | --- | --- |
| `core.condition@1` | Strict empty config; Inputs tab | Required boolean `condition` → `selectedPort`; `in` → `true/false` | None; local graph/body |
| `core.foreach@1` | Strict empty config. **Structure**, not config, owns `maxIterations`, `maxConcurrency`, body. Positive integers ≤1000, concurrency ≤iterations; current summary is read-only, defaults 100/1 | Required `items` array ≤1000 → `items`, matching `iterationCount`; `in` → `out`; body receives `item`/`ordinal` | None; recursively owned body, scope-local edges/mappings |
| `core.manual@1` | Empty config; existing trigger preserved. Deprecated, publishable, not available for new palette placement | Dynamic run input → dynamic output; no input port → `out`; no synthetic trigger mappings | None; top-level trigger admission |
| `core.merge@1/2/3` | Local Parallel selector for `parallelNodeId` (identifier 1–128); `policy` via JSON: all/any/count, count 1–16 | Engine ledger and selected branch IDs → same projection; up to 16 branch inputs → `out`. Version 1 ledger admits pending; 2/3 do not | None; paired Parallel must have matching pinned version and local scope |
| `core.parallel@1/2/3` | Branch builder (2–16 branch IDs), integer concurrency 1–16, contextual bound to branch count; JSON fallback | Dynamic input → `branchIds`; `in` → configured branch ports | None; local paired Merge; version-specific engine behavior retained |
| `core.schedule@1/2/3` | Cron/interval builder: cron expression 9–255, timezone 1–255, interval 1–43200 minutes, catch-up-once/skip; server preview checks actual rule semantics | v1 dynamic payload; v2/3 `schemaVersion`, `triggerId`, `nodeId`, `scheduledAt`; no input port → `out` | None; top-level trigger; v1 cron schema pattern differs from 2/3, v3 server parsing remains authoritative |
| `core.set@1` | Empty config; arbitrary top-level mapping keys, not fabricated config fields | Dynamic mapped input → dynamic output; `in` → `out` | None; local graph/body |
| `core.switch@1` | Cases builder, 1–16 stable case IDs; scalar/null equality values, strings ≤1024; JSON fallback | Required scalar/null `value` → `selectedPort`; `in` → case ports/default | None; local branch routing |
| `core.terminate@1` | Empty config; no unnecessary fields | Dynamic input → dynamic output contract; `in` → no outgoing port | None; local terminal behavior |
| `core.validate@1` | Rules builder + lossless JSON fallback: 1–64 rules, ID pattern, path 1–512, required/type, scalar enum 1–32 (strings ≤256), optional numeric/length/item bounds | Dynamic input → `valid`, bounded/sanitized `issues`, `truncated`; `in` → `out` | None; local graph/body; server rule semantics authoritative |
| `core.wait@1` | Integer duration 1–2592000 seconds, unit-aware field | Dynamic input → dynamic output; `in` → `out` | None; local graph/body |
| `core.webhook@1` | Empty node config; endpoint commands in workflow settings, not secrets embedded in graph | Dynamic run input → dynamic output; no input port → `out` | No node connection; transient webhook credentials managed separately; top-level trigger |
| `email.send_notification@1` | Timeout 1–30000 ms, unit-aware field | Required `toEmail` 3–254, `subject` 1–200, `text` 1–50000 → `emailId`; `in` → `out` | `resend_api_key`; active compatible connection selector/add sheet, no secret value in graph |
| `http.request@1` | Method enum, URL ≤2048, bounded headers via JSON, timeout 1–120000 ms, redirects 0–5, response bytes 1–10485760, inline bytes 1–262144 | Optional bounded encoded `body` object → status/headers/inline-or-artifact body/finalOrigin/redirectCount; `in` → `out` | `http_headers`; matching connection selector; server egress/action policy unchanged |
| `slack.send_message@1` | Timeout 1–30000 ms; channel lookup and mapped-input controls | Required `channelId` 2–255 with Slack pattern, `text` 1–4000 → `channelId`, `messageTs`; `in` → `out` | `slack_bot_token`; matching connection and explicit channel assistance |

Catalog owner: `packages/node-catalog/src/definition-resolution.ts`, node schema
owners in `packages/nodes-core` and `packages/integrations`.
Graph bounds: `packages/workflow-model/src/graph-contract.ts` and
`graph-validation.ts`. Existing UI owners:
`apps/web/src/features/workflow-editor/components/inspector/setup-tab.tsx`,
`schema-field.tsx`, `builders/`, `schedule/`, `connection-slot.tsx`,
`about-tab.tsx`, and `loop-body-section.tsx`. About/schema suggestions explain
declared outputs; Test results are evidence of actual data. Do not claim a
top-level schema summary completely visualizes nested output shapes.

### All five mapping kinds: ownership and qualification

| Kind | Existing control and wire ownership | Validation / scope | Missing integrated evidence |
| --- | --- | --- | --- |
| `literal` | Typed JSON row; shared graph-derived union | Preserve null, false, zero, arrays/objects, special top-level keys; invalid scratch cannot autosave | Author → save → reload → immutable publish → observe exact value |
| `run_input` | Path row, insert-data picker; shared JSON-path parser | `$`, dots, indices, quoted keys; missing path omits property, not null/default | Actual run input and absent path behavior after reload |
| `node_output` | Local predecessor selector + path | Direct incoming predecessor only, same body; disconnected reference stays visible with warning | Local and nested executions; copied IDs, reconnect, undo, server issue focus |
| `expression` | JSONata text row, stored policy version retained | Runtime context is **`runInput` and `nodeOutputs`**, not already-resolved step input. Nonempty local check; restricted server validation/evaluation; no browser evaluator | Correct example/context, invalid expression row focus, actual evaluated output after reload |
| `structured_input` | Loop source selector + path; available for body `item`/`ordinal`, or preserved unsupported existing row | No outer/other-body escape; engine scope context; unknown port remains visibly invalid | Nested 2×2 item/ordinal assertions through authored/saved graph |

Canonical owners: `model/input-mappings.ts`,
`components/inspector/input-mappings/`, `inputs-tab.tsx`, `use-live-mappings.ts`;
runtime `packages/workflow-model/src/mapping.ts` and
`expressions/policy.ts` (`ExpressionContextV1`). Do not duplicate types/parsers.

### Confirmed gaps and approved bounded changes

1. **Editable loop bounds:** `LoopBodySection` only prints structure limits.
   Add a cohesive inspector-owned bounds control using existing live-field
   scratch validation and `NodeFormApi`. Extend the existing node update seam
   narrowly to update structure computed from the current node, preserving its
   entire body and ports; no second graph state or config-shaped imitation.
   Check browser-safe graph-limit export/allowlist before importing it; do not
   copy constants or import runtime validators. Never silently clamp a sibling
   limit. Invalid/incomplete integer or concurrency above iterations remains
   scratch and blocks save/leave until explicitly settled. Keep read-only users
   read-only. Tests: 1/1000/zero/negative/partial, relational limits, nested body
   preservation, undo/redo, selection/route guard, autosave/reload, keyboard and
   390/1024/1280/1440 widths. Intended owners: `loop-body-section.tsx`, a meaningful
   bounds component if substantial, `model/graph-commands.ts`/`node-form.ts`,
   existing For Each model/component/browser tests.
2. **Merge reference duplication:** `model/graph-copies.ts:copyStep` remaps
   `node_output.nodeId`, but leaves known `core.merge.config.parallelNodeId`
   attached to the original Parallel. Executable admission requires exactly one
   paired Merge per Parallel and matching pinned versions. Remap this specific
   reference when its local Parallel is copied together (including bodies);
   preserve config, policy, unknown properties and references not in the copied
   group. No speculative recursive string replacement or JSONata AST rewrite.
   Reproduce first through existing `duplicateWorkflowNodes` public model seam;
   cover grouped/root/body copies, merge-only copy, version preservation,
   undo/redo and executable admission of a complete copied branch group.
3. **Truthful expression help:** current placeholder `body.amount > 5000` and
   “over this step’s input” contradict the actual restricted context. Correct to
   a real `runInput` example and explain available `nodeOutputs` without promising
   unrestricted graph access. Preserve input text/policy version, error routing
   and server evaluation. Component assertion plus existing evaluator test seam
   verifies the displayed example; no endpoint/dependency or new evaluator.
4. **Documentation parity:** current architecture M1 still says only three
   mappings can be created and nested authoring is deferred despite present
   controls. Correct current claims after reviewed implementation; keep dated
   historical evidence and outstanding integrated/provider limits distinguishable.

Not defects established by this pass: Merge policy requires JSON but is editable;
complex Validate rules and HTTP headers have supported JSON fallback; top-level
schema summaries are not full previews. Browser-local semantic expression
evaluation, automatic rewriting of arbitrary expression IDs, additional nested
form builders and sample pinning are **not** included in this routine slice.
No new ADR is needed for these existing-contract parity fixes. Stop for review
if implementation would require a new contract or a new persistent capability.

### Evidence plan and sequence

1. Manager reviewed this matrix and approved the three bounded behavior changes. Add
   regressions through existing owners, implement one coherent change at a time,
   run focused model/component tests and web typecheck/lint/build/boundary checks.
2. Extend catalog-realistic Chromium journeys rather than treating the current
   synthetic `core.set` config fixture as catalog-parity proof. Cover all five
   mappings, nested scope/duplicate/undo, invalid scratch, conflict preservation,
   unsupported pinned version, immutable accepted version and layout/keyboard
   behavior. Inspect rendered desktop/mobile controls. These remain mocked HTTP.
3. Close missing **real** qualification using isolated API + PostgreSQL + worker
   fixtures and controlled local providers; map exact source/cohort, run IDs,
   version IDs, node outputs/counts and authorization outcomes. Existing
   `apps/api/test/support/better-auth-real-api.integration.support.ts` boots the
   real API/Better Auth. The approved test-only loopback extension now has the
   initial smoke evidence recorded below/F00; its lifecycle safety corrections
   require independent review and a real-stack rerun before wider qualification.
   Use ordinary authorized local sign-in, not a production auth bypass or legacy
   OIDC assumptions (ADRs 039/043).
   External provider/OIDC production qualification stays gated separately.
4. Preserve existing save serialization/session verification, exact run/publish
   retry receipts, retained conflict comparison, inspector scratch ownership and
   permission handling. Run full web component suite and Chromium journeys,
   import/bundle/architecture checks, React Doctor as diagnostics with uploads
   disabled, and `git diff --check`; run affected model/engine gates when touched.
   Do not call unrun Firefox/WebKit, live mail/providers or deployment passed.

Existing tests inspected (not rerun here): `workflow-editor-mappings.test.tsx`
primarily edits literal/run-input/node-output; expression examples are mostly
seeded display. `workflow-editor-for-each.test.tsx` covers local body authoring;
graph/body tests copy IDs but do not test the Merge config reference. Mocked
`e2e/workflow-editor.spec.ts`, `workflow-editor-for-each.spec.ts`, guards/publish
journeys cover useful paths but do not prove full-stack execution of all five
mappings. Existing worker nested fixture exercises **3×1**, not the required
2×2/four-leaf acceptance. See F00 for the connected real-journey ledger.

Each slice ends in a usable, tested behavior; do not ship enabled placeholder
controls backed by invented responses.

## Acceptance evidence

Nested scope references cannot escape their body; invalid expression reports the correct row; no silent mapping conversion; undo/remap preserves references; running workflow version unaffected by draft edits.

Apply the shared completion checklist: contract/authorization tests, real
persistence and restart/race tests when relevant, real browser/backend flow for
visible behavior, and exact reviewed source/CI evidence. Mocks alone cannot close
the live gate. Record unsupported environments explicitly.

## Non-goals

Subworkflows, arbitrary code, multiplayer and wholesale editor redesign.

## Rollout and rollback

Existing draft/version readers stay compatible; disable only a newly added optional control if required, never rewrite saved graphs.

No production rollout, paid provisioning or real external calls are authorized by
this plan. New persistent behavior requires additive reader/writer rollout and
retention/membership-deletion handling before enablement.

## Competitor context

A strong mapper and understandable structured flow reduce dependence on custom code. This is parity completion against our contracts, not a copied competitor canvas. Sources: [n8n pinning and mocking](https://docs.n8n.io/build/work-with-data/pin-and-mock-data); [Zapier drafts and versions](https://help.zapier.com/hc/en-us/articles/9693520498445-Create-Zap-drafts-and-versions).

Research checked 2026-09-28; product editions and availability can change.
This context informs the outcome, not Pertexo's implementation or billing policy.

## Delivery tracker

- [x] Baseline reconciled against current code and accepted decisions (source inventory and accepted local qualification below; external gates remain open).
- [x] Bounded parity/qualification choices resolved; existing ADRs retained.
- [x] Contracts and failure/security model reviewed for the recorded local scope.
- [x] Backend behavior independently verified in the recorded owned fixtures.
- [x] Frontend parity and local Chromium behavior implemented and independently reviewed.
- [x] Real local integrated acceptance evidence recorded; external gates remain separate.
- [x] Rollout/rollback and limitations documented; no production rollout authorized.
- [x] Scoped PR113/114 merged with required checks; exact natural main CI/CodeQL result independently inspected.

Evidence log (2026-09-28): fetched main and verified `fcb0c44c`; PR99/100 are
merged. Read-only catalog projection and canonical source/test inspection above.
At that initial inventory point, no new runtime tests, UI inspection or behavior
changes had executed; subsequent implementation evidence follows below.
Those initial open gates are closed only within the bounded local/release scope
by the subsequent accepted evidence and release closure below. External gates
remain open; prior green CI alone is not completion evidence.
Planning checks: `pnpm docs:check`
passed 21 tests and validated 320 links across 110 documents; `git diff --check`
passed. The repository's Prettier ignore excludes `docs`, so its earlier
successful command was not a formatting check of these plans. These are
documentation checks, not runtime qualification.

Implementation evidence (2026-09-28, uncommitted on
`feat/editor-capability-baseline`, based on `fcb0c44c`):

- Loop limits now use paired `useLiveField` scratch and current-node functional
  structure updates, preserving body, config and version. Nine added component
  regressions cover StrictMode, compatible 1/1000 limits, invalid/incomplete
  input, no silent clamp/save, Stay/Discard, history and read-only controls.
- Eight copy regressions exercise the actual `duplicateWorkflowNodes` seam
  against built public engine/catalog admission: root/body versions 1/2/3,
  complete group rewiring, undo/redo, whole-loop copy, solo Merge and opaque/
  unknown-version config preservation. Seven reference assertions reproduced
  the old bug before implementation. These are real pure-engine admission,
  **not** PostgreSQL or browser-to-worker execution.
- Expression component test checks the accessible actual-context description,
  example and saved policy/body. Production restricted evaluator test executes
  the displayed `runInput.amount > 5000` example (28 expression tests pass).
- Web typecheck/lint pass. Full web default-config run: 98 files / 688 tests
  passed after heavy concurrent checks stopped. An earlier concurrent run had
  687 passes and one unrelated alert-route loading timeout; focused alert 4/4
  and diagnostic two-worker 688/688 also passed. Runner settings/assertions were
  not changed; no causal resolution of that timeout is claimed.
- Focused mocked-HTTP Chromium: 11/11 For Each journeys pass, including all eight
  editable/read-only 390/1024/1280/1440-width cases, keyboard field focus,
  relational error and autosave/reload/body preservation. Initial full Chromium
  was 69/71 because the two new 390px tests omitted the existing mobile Step
  panel action; corrected tests activate it, with no mobile app rewrite.
  Screenshots at 390 and 1440 were visually inspected. Final full Chromium run
  passed 71/71 (48.8s), including the existing conflict/dirty-logout/run journeys.
  Its unhandled ancillary fixture requests produce expected loopback proxy
  connection-refused logs; no real API was running for that mocked suite.
- Architecture/import check: 19 tests pass; built public exports: 9 tests and
  35 consumer cases pass. Contract artifact check and focused authoring contracts
  3/3 pass; existing identity-workspace OpenAPI missing-2XX warning remains.
  Graph limits are a re-export through the existing browser-safe schema path;
  inspected transitive modules are Zod and pure graph guards, not Node runtimes.
- React Doctor changed scope against origin/main, including untracked files:
  10 files scanned, no diagnostics; telemetry/score and supply-chain uploads
  disabled. This is not correctness or measured performance proof.
  After adding the live harness, the same upload-disabled command scanned 12
  files with no diagnostics. Documentation validation remained 21/21 and 320
  links across 110 documents; architecture checks remained 19/19.
- Live listener composition's initial pure-node stage now passes real API
  integration 1/1 and Chromium 1/1: ordinary signup/local mail verification,
  sign-in, first workspace, browser-created workflow, literal mapping,
  autosave/reload, publication and actual succeeded worker execution, with
  durable workspace/workflow identity assertions. The approved fixture uses
  explicit ownership assertions, a UUID database and exclusive Redis DB11;
  actual discovery modules and the selected catalog cohort are prerequisites.
  Existing Better Auth helper consumers also pass: three real API/PostgreSQL
  integration files, five tests, including membership and self-service behavior.
  This is not social-provider/OIDC proof or production qualification. Connected
  all-five/2×2/conflict/version were open at this initial snapshot; subsequent
  connected results below close those cases, not controlled-action/schedule gates;
  see F00's owner/lifecycle and executed-evidence details.
  Subsequent safety-review corrections have 28 focused API/process/ownership/
  disposal/actual negative Chromium reporter probes and 11 worker cleanup/namespace unit
  tests passing. Independent review subsequently approved the narrow live rerun.
  Actual owned Redis verified atomic cleanup and wrong-token preservation, but
  two real literal scenarios' successful browser execution was followed by
  failed worker cleanup proof. Their UUID databases were retained. One final
  approved diagnostic rerun passed API/Chromium and teardown, but does not prove
  the intermittent failures resolved. See F00 for exact results and identifiers.

Next bounded real authoring case, approved for test-only implementation using
the same composition (diff review required before execution): author a Set →
outer For Each → inner For Each → leaf Set graph
through the palette, inputs controls and body picker. Give the outer loop two
arrays, each containing two distinguishable values, and set both paired bounds
to two. Root fields exercise literal, run-input, expression and omitted missing
paths; the root-to-loop edge exercises node-output; leaf item/ordinal mappings
exercise structured-input. Save/reload must preserve exact mappings/bounds;
publish/run must yield four distinct scoped leaf outputs with ordinals 0/1 in
each inner scope, not the existing 3×1 fixture's count. Inspect actual immutable
version ID, node inputs/outputs and durable run counts. Then use two browser
contexts of the same authorized identity for ETag conflict/retained comparison
and later-draft-edit versus accepted-version checks; separate identities cover
other-workspace denial. These add browser scenarios, not direct SQL graph seeds,
alternate auth guards, external effects or a second setup framework.

Bounded scenario implementation and executed evidence: the existing live journey
now authors all five sources and this 2×2 graph through actual UI controls. It
checks full saved/reloaded graph and immutable version equality, root literal /
run-input / JSONata result plus missing-path omission, four unique leaf values
with ordinals and stored inputs/outputs, eight successful node invocations, and
the four exact two-level iteration paths in durable storage. API/web typecheck,
lint and test discovery pass. The first live attempt stopped at a test expectation
that omitted required expression `language`/`policyVersion`; the canonical shared
shape was corrected without weakening equality. The corrected browser scenario
passed **1/1** (21.0s), including those actual execution/storage assertions.
However, its API suite **failed teardown** (30.90s): successful worker acknowledgment
was followed by signal-zero group polling `EPERM` before exit observation. The
owned UUID database was preserved; Redis was empty and its lease absent. Thus
connected execution was evidenced, but that attempt's complete gate was not green.
The narrow process-poll correction then passed independent review and a final
approved rerun: **1/1 API integration and 1/1 Chromium**, 30.82s (browser 21.1s),
including teardown. Run `01a0e646-734c-720b-bec5-c7978bf4f2f1` used immutable
version `01a0e646-6b82-746c-94f2-08ee5336f24d`; four distinct leaf values and exact
two-level scopes passed. Read-only inspection confirmed the latest UUID database
was removed, DB11 empty/lease absent and three prior preserved databases untouched.
F00 records complete result IDs/log path and the older unattributed failures.
This closes this connected all-five/nested scenario, not all F01 gates. The
independently reviewed two-context extension subsequently passed **1/1 API and
1/1 Chromium**, 42.37s (browser 32.3s), including teardown. Two ordinary same-owner
sessions produced a real stale-ETag 412 (held dispatch, no fabricated response),
preserved both copies, explicitly accepted the remote baseline and reapplied a
chosen step with its new ETag. A later unpublished literal edit left the immutable
version and accepted output unchanged. A distinct ordinarily verified user created
their own workspace and received actual nondisclosing 404 responses/UI for the
other workspace's draft/version/run resources. Durable assertions checked final
draft revision 10, one immutable version and one run. Run
`01a0e654-45aa-71ba-bb91-8434c2e93732` used version
`01a0e654-3dd1-742e-95c0-4db888c7d268`. The first attempt failed a test's second
sign-in landing expectation: the existing single-workspace owner correctly lands
at their known workspace, not selection. The corrected assertion uses that exact
route; no product routing or equality assertion was weakened. Log:
`/tmp/pertexo-f01-nested.KW84Ea/editor-conflict-version-isolation-corrected-landing.log`.
Post-run checks confirmed normal UUID database deletion, empty DB11/no lease and
three older diagnostic databases preserved. API/web typecheck and lint pass.
Cached React Doctor 0.9.14 scanned 19 changed/untracked files with no diagnostics;
telemetry, score and supply-chain uploads were disabled. This is not provider/OIDC,
failure/replay/cancel, schedule, controlled-action or cross-browser qualification.
No production behavior changed in this test extension.

The independently reviewed three production parity fixes and their direct tests
were committed separately as `494fb9cc2f958d863b44386e5e302055bdcd1364`
(`fix(web): complete bounded editor capability controls`): 14 files, 634 additions
and 21 deletions. Current focused frontend checks pass 31/31, restricted expression
checks 28/28, authoring contracts 3/3 and generated artifacts unchanged (existing
missing-2XX warning remains); web build/typecheck/lint and architecture checks pass.
The integration harness, roadmap evidence and unrelated edits remain uncommitted.
No push has occurred, and this commit does not declare F00/F01 complete.

Remaining expression-report prerequisite found during source inspection:
`ValidateWorkflowDraftUseCase` invokes structural `validateWorkflowGraph`;
expression mappings are strings, and executable compilation checks only pinned
policy versions. The restricted `validateExpression` parser currently runs in
the runtime evaluator, not the authoring report. A nonempty malformed expression
therefore cannot honestly be used to test a real syntax finding's row focus yet.
Any tightening needs one canonical server-owned validation seam shared by checks
and new publication, bounded parser work, truthful shared issue codes/copy, and
explicit preservation of retained immutable-version/replay compatibility. No
backend/parser change or fabricated validation report has been introduced.

Design-only follow-up: [proposed ADR 053](../adr/053-authoring-expression-validation.md)
separates named server authoring/new-publication admission from retained-version
validation, instead of broadening the shared structural validator or adding a
mode flag. Delivery sequence is resource-budget approval → shared findings and
canonical module → explicit draft/new-publication adapters → compatibility and
real editor finding tests. The current synchronous parser's aggregate work is
an explicit prerequisite: per-expression AST limits and runtime deadlines do
not prove bounded preparse cost. Aggregate limits/isolation need measurements
and approval; the proposed ADR does not silently accept new restrictions or
authorize production implementation. Completed publication reconciliation,
historical checksums/replay and browser-safe imports are required regressions.

ADR 053 now records the exact policy/caller matrix and proposed narrow interfaces.
Authority is selected `nodeRelease.definitions[].policyReferences`; API
`platform/workflow/workflow-compatibility.ts` currently drops that metadata while
database `selectLocked` chooses the durable release. Proposed explicit validation
reads snapshot and aligned variant together; new publication reuses that variant's
admission only after original receipt/ETag handling. Historical callers are excluded.

Bounded local pure-parser measurements used Node 24.15.0 / JSONata 2.2.2 on Apple
M4, 2,000ms experimental child deadlines, 64 MiB heaps and 1,024 KiB stacks.
Eleven fixtures ×20 typed assertions and four admitted aggregate fixtures ×2
rounds passed. A valid 866,634-byte graph with 200 distinct AST-limit expressions
took 202.037 / 106.907ms parser-only; one node with 5,000 mappings is structurally
valid. Node/per-expression caps therefore do not prove negligible synchronous
cost or a mapping-count budget. Experimental isolation is not API isolation.
ADR 053 records all measurements and retained scripts/results/checksums under
`/tmp/pertexo-expression-admission.zRMvqa`; results transcribe captured stdout
without a second run. The off-thread-versus-stricter-budget comparison remains
design-only: no numeric budget, pool, persistence seam or error contract is approved.

The next design amendment proposes one runtime-owned authoring validator, not
workers created by database adapters or publication variants. Suggested operational
defaults are at most two active batches, four queued / 4 MiB queued bytes,
2 MiB serialized envelopes, 500ms queue and startup bounds, 1,000ms parsing,
250ms termination observation and bounded reports. ADR 053 marks these as
unapproved reversible operating defaults, not new syntax/graph constraints, and
compares a small separate bounded owner with inappropriate generic/evaluation reuse.
It traces current tenant transactions and release/draft locks: the proposed
maximum added parser-phase wait is 2,250ms before rollback is requested, not a
claim that all SQL/rollback/network work completes then. Original receipt replay
precedes admission; draft reports use the same selected release/snapshot. Typed
503 recovery, cancellation propagation and failed-termination quarantine remain
contract/lifecycle review gates. No implementation or repeated measurement/live
run accompanies this amendment.

Independent review subsequently accepted ADR 053's bounded off-thread direction
and operational defaults. Stage 1 was initially authorized alone and its
corrected model/worker interface is now independently approved. Backend stage 2
is authorized below; frontend and connected qualification remain held. The
authoring wrapper must forward `signal` explicitly rather than claiming an
existing end-to-end cancellation path. Failed exit
retains its slot; custom smaller database budgets fail closed without config
increases. No new syntax limits or external/live work are authorized. Stage-1
implementation now has focused evidence and independent approval below;
later adapters and F01 delivery are not complete.

Stage-1 model evidence (2026-09-28): the new server-only
`@pertexo/workflow-model/authoring-validation` owns parse-only compiled workers,
bounded queue/byte/deadline admission, cancellation/shutdown and confirmed-exit
capacity. It composes existing structural validation and the canonical restricted
policy without changing retained-version callers or graph/language limits.
Findings preserve nested mapping paths and sanitize raw parser errors. Exact
definition pins, invocation-local cache, report budgets and operational failure
are covered; no browser evaluator or AST export was added.

`pnpm --filter @pertexo/workflow-model test` (including its build) passes
**13 files / 160 tests**. Real compiled workers exercise parsing; injected
workers/fake clocks exercise FIFO/count/byte admission, expired queued dispatch,
abort/start/parse/termination failures, quarantined slots, late messages and
shutdown. Existing graph/retained/expression suites pass unchanged. Model
typecheck and focused ESLint pass using the repository's established 8 GiB heap
(the initial default 4 GiB lint attempt exhausted its heap). Focused built export
and explicit browser-condition rejection pass; import checks pass 13 tests and
the repository scan; model complexity inventory has no new hotspots. This is
model evidence, not API/publication/editor or production-load proof. No live
gates were repeated. Shared wire/problem artifacts, release-aligned
adapters/cancellation and stage-3 connected qualification remain required.
The independently approved model/ADR-only checkpoint was committed as
`45644ec9` (`feat(model): add bounded authoring expression validation`),
12 files, 2,079 insertions / 16 deletions. Nothing has been pushed.

Focused Knip check also passes after registering the actual dynamically launched
compiled authoring worker beside the existing expression worker entrypoint. Its
initial unused-file report was an entry-discovery limitation, not a reason to
remove the worker or suppress unused-code rules.

Stage-1 independent review caught provisional-result cancellation and structural
report amplification. Both were reproduced before fixing: **2 red lifecycle
tests** and **1 red incremental-allocation test** (~0.8 MiB bounded fixture).
Abort/shutdown now remain authoritative during termination and after exit until
settlement, without rewriting an already settled result. Structural findings
pass byte/message admission before canonical collection; exhaustion propagates
as operational `report_limit` rather than `invalid_graph`. Historical count-only
reports retain 100 complete identifiers, and unrelated structural failures remain
structural. The real compiled-worker 500 KiB-ID/100-mapping regression also passes.
Focused owner/package regressions pass **2 files / 46 tests**; the model's final
full suite is the 160 tests above. Independent re-review approved the corrected
model stage (both review axes clear; independent **46/46**, 858ms). The initial
adapter hold was subsequently lifted for the bounded backend work below.
No API/database/frontend wiring, live rerun or push
accompanies these corrections.

### Stage 2 adapter plan — backend approved; delivery not complete

Bounded purpose: connect the approved model owner to server-draft validation
and **new** publication admission under the database-selected durable release.
Do not change retained-version checksum/read/replay semantics, graph limits,
runtime evaluation, authentication policy or editor ownership. No migration,
new persistent state, browser parser or dependency is proposed.

1. **Release projection and lifecycle — API platform owner.** In
   `apps/api/src/platform/workflow/workflow-compatibility.ts`, derive the narrow
   immutable authoring-policy snapshot from the same `nodeRelease` and
   fingerprint as each executable variant. Keep browser catalog projection free
   of policy/evaluator internals. `createCoreAuthoringOptions` supplies each
   variant's callback, closed over that snapshot and one shared validator.
   `workflow-runtime.module.ts` owns that validator, not the database or each
   request/variant. Register failed-construction cleanup as well as memoized
   shutdown; drain the validator before releasing authoring resources and
   surface unconfirmed worker disposal. The standalone
   `createCoreWorkflowAuthoringDatabase` helper must likewise own one validator
   with composite memoized close/failure cleanup, or consume an explicit
   externally owned validator; it must not leak a hidden instance. Prefer the
   helper-owned composite close to preserve existing caller lifetime semantics.
   Do not create an unused owner for an injected authoring database.
2. **Selected callback and snapshot — database owner.** Add the focused
   asynchronous `validateAuthoringGraph(graph, { signal? })` callback to
   `authoring/workflow-authoring-types.ts`. Carry it through singular and
   multi-variant normalization in `workflow-authoring-compatibility.ts` and
   `selectLocked`; compiler, catalog and policies must belong to the same
   selected release, including retained releases. Add `validateDraft` to the
   authoring read store/public persistence interface. In one tenant transaction,
   authorize the reader, select the release, read/map the draft and validate
   that snapshot; return `{ draft, validation }`. Do not read with `getDraft`
   and then use latest in-memory policies. No new draft write lock is needed.
   Inventory every singular/variant production, test and helper caller. Missing
   admission wiring fails closed for validation/new publication, not with a
   structural-only success; retained reads/save/restore/lifecycle remain usable.
3. **Publication ordering — existing transaction.** In
   `workflow-publication.ts`, keep current authorization and exact completed
   receipt replay before parser admission. For a new command: select the
   release, acquire existing workflow/draft locks, check the original strong
   ETag, run selected admission, then compile/persist. Invalid findings retain
   `workflow.invalid` behavior; operational admission failure rolls back the
   new receipt/version/audit and returns unavailable. An exact receipt replay
   must work with an invalid newer draft or unavailable parser. Do not globally
   tighten `parseWorkflowGraphForPublish` or the historical structural helper.
4. **Cancellation and effective budgets.** Use existing
   `platform/http/request-operation-signal.ts` in validate/publish controllers;
   add only the needed request raw/signal types and thread the signal through
   use cases, persistence and `withAuthorTransaction` into the existing tenant
   transaction and model owner. The prior authoring wrapper dropped signals.
   Test aborted requests/socket disposal, normal keepalive completion, listener
   cleanup and shutdown during queued/active work. Cancellation after commit
   cannot undo a durable receipt. Before enabling admission, fail closed when
   effective connected idle-transaction deadline is too small for the
   scheduling-qualified 2,250 ms added parser-phase wait; do not raise them.
   Qualification uses the actual connected `pg_settings` idle-transaction
   setting/unit before every admission. Known finite values must exceed that
   wait; zero/unlimited, unknown units/settings and insufficient values fail
   closed. Query timeout applies to individual SQL calls, not the intervening
   off-thread JavaScript wait; existing per-query pool policy is unchanged.
   `DatabaseConfig.idleTimeoutMillis` retires
   pooled connections and is **not** the transaction deadline. This guard is
   not a promise that the entire SQL transaction/rollback finishes in 2,250 ms.
5. **Wire failures and representability — shared contracts/API.** Preserve the
   existing open string issue-code schema (it already admits
   `invalid_expression`); add semantic examples/tests, not a duplicate/narrower
   code enum. Add `workflow.validation_unavailable`, safe 503 problem and
   `Retry-After: 1` to the error manifest/filter and validate/publish OpenAPI;
   regenerate using `pnpm --filter @pertexo/contracts contracts:generate`.
   Map the typed operational error before generic request/Zod handling. Actual
   shared issue bounds are path 1,024 characters and message 500 characters;
   model report-byte limits alone do not guarantee them. Guard server-produced
   reports/new-admission problem issues against the real shared schema before
   serialization/legacy truncation: unrepresentable output is safe operational
   `report_limit`/503, not truncated node IDs, request 400 or fake validity.
   Do not retain/log raw parser source or Zod inputs.
6. **Approved protocol, recorded in ADR 053: checked snapshot ETag.** The
   existing validation response contains no checked draft identity; publication
   currently stamps it with the earlier locally captured save revision. Another
   tab can update the server draft between save and validation. Add a required
   strong `ETag` response header derived from the **same** returned draft
   snapshot/release, using the existing read serializer/controller pattern;
   keep the JSON report body unchanged and document the header in OpenAPI.
   `workflow-publish.api.ts` can decode `{ report, etag }` using the existing
   `ApiResponseMetadata.header` interface; no transport framework change.
   Freshness/reuse requires matching saved ETag plus current scope/local
   generation/revision. A mismatch remains readable but stale and cannot admit
   publication as a fresh report. Missing/malformed header is a protocol error.
   Update all validation consumers/fixtures rather than treating absent tags as
   success. Matching the tag never replaces atomic publication If-Match and
   new-command admission. Backend implementation and the targeted PostgreSQL
   cohort are reviewed/verified; frontend metadata adoption is implemented below
   and awaits its independent review and connected browser gate.
7. **Frontend recovery remains feature-owned.** Keep the existing publication
   owner, temporary-session-pause retention, explicit exact retry and original
   key/ETag untouched. Integrate unavailable feedback and existing bounded
   validation cooldown; no automatic publish/run replay. Preserve structural
   plus compatibility findings, nested mapping navigation and dirty-inspector
   guards. Do not put reports in a duplicate global cache or import server-only
   model/parser code into the browser.

Acceptance cases, to execute only after stage-2 approval:

- Selected older versus newer release/policy projection; missing callback fails
  closed; both configuration forms, standalone helper and injected runtime
  ownership; shutdown/failure cleanup, narrower effective budgets and canceled
  validation release resources without successful late results.
- Same-snapshot validation metadata; nested expression findings; normal semantic
  invalidity versus overload/report-limit 503/Retry-After; long IDs do not become
  request errors or truncated targets; actual contract artifacts/guards.
- Database publication/atomicity/coordination: malformed new expressions create
  no version/audit/receipt; 412 wins against stale precondition; exact completed
  replay after newer invalid edits or parser outage returns original receipt;
  changed command/key conflicts and release races preserve durable state.
- Frontend same/mismatched checked tag, unavailable cooldown, exact uncertain
  publication retry, paused identity recovery, nested target navigation with
  scratch Apply/Discard/Stay and actual scope disposal remain correct.
- Affected model/contracts/database/API/web tests, build/typecheck/lint, generated
  artifact/import/browser bundle checks and diagnostics. Real PostgreSQL and
  connected Chromium expression-admission cases require separately authorized
  owned disposable services; existing baseline green evidence is not proof of
  these unimplemented adapters. No provider/cross-browser claim is implied.

Status: model checkpoint committed and reviewed; **backend stage 2 independently
approved with targeted PostgreSQL evidence; frontend adapters authorized and
implemented pending independent review**, uncommitted. New connected browser
runs, push and broader gates remain held. Checked-snapshot ETag, effective connection-budget rules
and cleanup-after-disposal-failure were recorded in ADR 053 before wire changes.
Focused no-service evidence is recorded after the final checks below; it must not
be presented as real PostgreSQL or connected editor qualification.

Backend stage-2 fixed point (2026-09-28), **uncommitted and independently
approved** (standards: no findings; specification: no findings; independent
manager verification: 39 focused tests passed): production and standalone API
composition now supply one owned parser
and release-specific policy callbacks. Database validation returns its selected
snapshot/report together; new publication checks original ETag before admission,
while exact completed receipt replay precedes policies/current-draft parsing.
Request signals cross the authoring transaction wrapper. Effective idle budget
is read from the actual connection on every admission, and authoring close waits
for transaction rollback/context release even with a shared pool lease. Parser
disposal failure is surfaced without skipping independent resource cleanup.
Shared safe unavailable problems, required checked-snapshot ETag and generated
artifacts are implemented; browser consumption is intentionally not changed yet.

Executed focused evidence:

- Database: **6 files / 82 tests**, 1.83 s. This includes explicit timeout-unit,
  finite/unlimited/unknown/insufficient settings, per-connection recheck,
  pre-checkout signal forwarding, shared-lease rollback wait, selected snapshot,
  receipt-before-parser/key mismatch, ETag-before-admission and no compile after
  invalid/unavailable admission. Persistence queries are controlled doubles;
  these are not PostgreSQL integration results.
- API: **14 files / 292 tests**, 4.29 s. Production release projection exercises
  the actual compiled parser; in-process Nest/Fastify requests exercise real
  session/CSRF/authorization guards and safe 503/Retry-After/header serialization
  with controlled identity/persistence. Runtime tests cover one owner,
  construction failure, injected database, memoized disposal and failed drain
  followed by independent cleanup. This is not a live identity/database journey.
- Contracts: **19 files / 96 tests**, 639 ms. Repository artifact generation and
  `contracts:check` pass; Redocly retains its existing identity endpoint advisory
  about no 2xx response. Model owner/package regressions: **2 files / 46 tests**,
  865 ms; the full earlier model suite was not repeated.
- Database/contracts/API builds and test typechecks pass; model test typecheck
  passes. Focused ESLint passes after correcting test-only typing/import issues,
  with no suppression. Scoped Knip (`packages/database`, `apps/api`), 13 import
  checker tests plus source scan, selected Prettier and diff checks pass. Docs
  checks pass **21 tests / 322 links / 111 files**.

Caller inventory found legacy database integration writers without explicit
admission wiring. Their shared synthetic fixture and two standalone reader/trigger
fixtures now own a real compiled parser with explicit selected synthetic catalog
and restricted-policy pins; no production structural-only fallback was added.
The connected publication regression passed against PostgreSQL: malformed new
admission leaves one original version/audit/receipt, original replay works without
a configured parser, changed exact-key body conflicts and stale ETag wins first.
One authorized serial cohort passed **4 files / 23 tests**, 6.85 s:
`workflow-authoring-publication`, `workflow-authoring-coordination`,
`workflow-authoring-atomicity` and `tenant-context-hygiene` integration tests.
This also exercises selected-release/lock coordination, publication rollback and
wire-level cancellation/context hygiene. The target was the verified owned
`pertexo-structure-verify-20260928` PostgreSQL container on `127.0.0.1:55436`,
with all eight explicit database URLs and both Q11 fixture overrides unset.
Fixtures created and non-force-dropped their own UUID databases; afterward there
were **0 authoring/hygiene databases and 0 corresponding clients**. The three
pre-existing diagnostic database names and OIDs were unchanged. Sanitized log:
`/tmp/pertexo-authoring-stage2.aYe6iB/postgres-cohort.log`; cleanup evidence:
`/tmp/pertexo-authoring-stage2.aYe6iB/database-after.txt`. The during-run sample
did not capture ephemeral UUID names; no exact UUID inventory is claimed.
Other affected legacy writer/RLS integration files were not run in this cohort.
No frontend changes, new Chromium/provider tests, service restart, broader CI
gates, new commit or push accompany this backend fixed point. F01 remains
incomplete pending adapter review and authorized connected verification.

Frontend stage-2 fixed point (2026-09-28), **uncommitted, independently approved
after the cooldown correction below**:

- The feature API decodes the shared report plus required strong checked ETag
  using existing transport metadata; missing, malformed and weak tags are
  protocol failures. The report owner retains the requested and checked tags,
  local generation/revision and its lifecycle fence. Another-tab mismatch stays
  readable/stale but never authorizes publication. The editor provides a focused
  current-draft predicate against its existing store (including scratch, save and
  identity-pause state); local edits during admission also block a new command.
- Unavailable validation/publication honors Retry-After with a minimum
  five-second wait, using the existing visibility-aware clock. A publication
  waiting on a failed manual check receives that same failure rather than
  immediately repeating validation; concurrent waits never shorten a retained
  cooldown. There is no automatic command replay. Exact uncertain commands retain
  their original key/tag and bypass new-draft preparation only after original-user
  verification. Existing temporary-pause recovery and actual scope disposal stay
  intact. No parser imports, second cache or generic command abstraction was added.
- All production validation consumers and controlled component/Chromium fixtures
  were updated for metadata. Nested expression findings use the existing target
  navigation and scratch Stay/Discard guard. Lasting web guidance documents the
  checked-snapshot contract, rather than claiming local revision alone proves
  server identity.
- Scoped web regression cohort: **12 files / 95 tests**, 13.78 s. After the final
  shared-check/cooldown correction, its publication/transport/recovery cohort
  passed **3 files / 28 tests**, 826 ms. These are controlled transport/component
  tests, including real feature decoding, routed StrictMode composition, nested
  target focus, mismatched server tags, local-edit races, late scope results,
  metadata failures, explicit cooldown and exact uncertain retry retention.
  Existing save/conflict/scratch/undo and browser-bundle boundaries passed in the
  scoped cohort; no new full-app test count is claimed.
- Web build (including application/test typechecks), full web lint and final
  focused lint pass. Initial root-context ESLint used the wrong test project;
  rerunning from the web workspace corrected that invocation. Event-clock purity
  diagnostics were addressed using the established clock, not suppressed.
  Import checks pass **13 tests plus source scan**; diff checks pass. React Doctor
  cached 0.9.14 scans **29 changed/untracked files**, no diagnostics, with scoring,
  telemetry and supply-chain uploads disabled. Scoped Knip reports 13 previously
  untracked live-harness/config files outside its configured entrypoints; no
  production adapter redundancy was reported, and no config suppression was added.
- No new Chromium/live-API expression journey, provider/OIDC or cross-browser
  test has run for these adapters. Those gates require subsequent authorization
  after independent review. No commit or push accompanies this fixed point.

Independent standards review then confirmed a cooldown race across pending
identity/save verification: an older callback captured the pre-failure rendering
clock/deadline and could dispatch a second validation after a concurrent 503 had
settled. Two new fake-clock regressions failed on that fixed point (**expected one
request, received three**). The bounded correction records an authoritative
deadline synchronously in the existing lifecycle owner, resets it on scope
disposal, and checks it immediately before every new validation dispatch, after
shared-flight/identity waits and before new publication dispatch. The rendering
clock is not dispatch authority. Both cases now pass, including explicit
publication only after expiry; a separate regression proves an exact uncertain
publish still retries the original body/key/ETag during a later check cooldown
without a new save barrier. Final focused publication/transport/recovery/model
verification: **3 files / 31 tests**, 807 ms; web typecheck passes. Review of the
corrected fixed point passed both review axes (standards: no findings;
specification: no findings), with independent manager verification **3 files /
31 tests**, 796 ms. New connected browser evidence remains pending; approval is
not a claim that this gate has run.

The authorized connected expression gate passed after a confirmed guarded-tab
navigation correction; its first approved live invocation failed, as retained
below. This qualifies this bounded expression case, not all F01 delivery gates:
`e2e-live/editor-expression-admission.spec.ts` authors one For each and one Set
leaf through normal controls. It subscribes to exact scoped POST requests before
explicit checks/publication/run and pairs each with its actual response. Existing
automatic validation is observed by the real checked ETag before the explicit
check, not assumed from a sleep or replaced with a fabricated response. It tests
real nested `invalid_expression` findings, matching strong tags, blocked
publication, keyboard mapping focus, scratch Stay/Discard and the inspector's
actual live-apply correction, followed by corrected validation and one immutable
version/run with exact leaf input/output. Stale-duration timing is not forced if
automatic validation already refreshed; actual revision/tag transitions are
asserted. The existing owned API harness has a focused expression evidence
branch checking durable graph/version/run/node rows, exact receipt hashes and
single publication/start audits; its ownership/cleanup protocols are unchanged.
Web/API test typechecks and scoped lint pass; Playwright `--list` discovers
**1 test / 1 file** without launching a browser. These are preparation/static
checks, not real API/PostgreSQL/Chromium execution evidence.

The separately approved single live invocation ran on 2026-09-28: **1 API
integration test failed / 1 Chromium journey failed**, 70.23s overall, with the
browser reaching its existing 60s timeout. Actual nested expression validation,
checked strong ETag, blocked publication, scratch Stay preservation and Discard
navigation assertions passed before the failure. At spec line 186, after the
second Stay, `Maximum items` still held `-` but was hidden: the rendered inspector
had the root selected and its Inputs tab active. The test attempted to fill the
Setup field; subsequent source inspection and a routed regression confirmed
that Fix changed the tab before its guarded selection was accepted. Corrected
validation, publication, run execution and the final durable evidence verifier
were **not reached**. Full sanitized log:
`/tmp/pertexo-expression-admission.svwJhv/expression-admission.log`; rendered
failure context is in the existing Playwright test-results directory.

Normal teardown and immediate read-only resource checks confirmed removal of
the invocation's UUID database
`pertexo_test_ba_editor_browser_c001afefe6e64271b1a5152939bee9aa` (OID 239441), no
remaining editor-browser database clients, Redis DB11 empty/control lease absent,
and no listener on port 4174. The three older diagnostic database names/OIDs
172428, 186635 and 175980 were preserved; Redis DB12 and older services were not
touched. No automatic rerun, timeout increase or manual cleanup followed the
failure. This was local API/PostgreSQL/Redis/Chromium
execution, not external OIDC/provider, production-load or cross-browser proof.

A separately authorized no-service correction keeps inspector navigation in
the existing accepted-action owner: Fix and View output request a selection;
only its accepted execution commits the tab/panel/focus change. Stay retains
the current step, visible tab and unfinished scratch. Pending Discard also
rechecks the session pause before clearing scratch or navigating. Ordinary tab
controls and intentional same-step focus remain available; no second guard,
effect synchronization or generic callback framework was added. The live spec
is unchanged (no explicit-Setup workaround).

The cross-tab routed StrictMode regression first failed while the confirmation
was still open: expected Setup selected, received false. After correction the
config and mapping cases pass, including Stay and Discard. Routed View output
coverage also checks Stay/Discard, same-step focus, and identity pause during
confirmation with original-user recovery. Final focused verification: **6 files
/ 55 tests passed**, 12.08s; web build (including application/test typechecks),
full web lint, architecture checks (**19 tests**, project graph and import scan)
and diff checks passed. React Doctor scanned **35 changed/untracked files**
with no diagnostics; scoring, telemetry and supply-chain uploads were disabled.
These are no-service component/build/static checks. Independent standards and
specification review both approved the navigation correction with no findings;
the manager separately reran the two routed files (**22 tests passed**, 5.22s).

The separately approved corrected invocation ran the **unchanged** live spec:
**1/1 real API integration and 1/1 Chromium passed**, 29.46s overall (browser
19.5s, Playwright 20.0s). It observed real nested `invalid_expression` findings,
the checked snapshot's strong tag, blocked publication, keyboard mapping focus,
Stay preserving visible scratch and Discard accepting navigation, live-applied
correction and checked-tag transitions. Publication used the corrected ETag and
returned its immutable graph; run acceptance referenced that exact version.
The local worker succeeded with the leaf input/output
`{item: "north", expressionProof: true}`. The final real PostgreSQL verifier
found one version, one succeeded run, two succeeded node rows, exactly one
completed publication/start receipt each with the observed key hashes, and one
publication/start audit each. Invalid revision 4 advanced to corrected revision
6. Version `01a0e746-dd14-77bb-8eef-09c4d267576c` and run
`01a0e746-e55a-7555-8450-71be12aa87d5` are captured in the sanitized full log:
`/tmp/pertexo-expression-corrected.gcoFeb/expression-admission.log`.

Immediate exact-owned preflight confirmed healthy Postgres/Redis services on
55436/56380, all eight explicit local database URLs, Q11 overrides unset, Redis
DB11 empty/control lease absent and port 4174 unowned. Normal teardown removed
`pertexo_test_ba_editor_browser_a2a76987776649ba88d7e1eb6a2d56bc` (OID 242993);
the post-run catalog has no editor-browser clients, preserves the older three
names/OIDs, and Redis DB11/control lease and port 4174 are clear. Before/after
catalog evidence is beside the log. No older service or Redis DB12 was touched.
No other live journey was repeated, no timeout was increased, and no commit or
push was made. This evidence uses local verified email/password, real local
API/PostgreSQL/Redis/worker and Chromium; it is not external OIDC/provider,
production-load or Firefox/WebKit qualification.

The separately reviewed receipt-recovery case passed **1/1 real API integration
and 1/1 Chromium**, 21.70s (browser 11.6s), including normal teardown. The browser
lost actual committed publish/run responses, changed draft/form inputs, then
explicitly retried the original commands. Assertions checked the original body,
publish ETag, idempotency keys and run deadline; durable inspection found exactly
one version, one succeeded run, one node attempt, two completed command receipts
and one audit for each command. Run `01a0e67f-d19e-7278-bf78-bcb4222cd226` used
version `01a0e67f-bfb8-75d5-adff-6b3e0a398383`. Log:
`/tmp/pertexo-f01-nested.KW84Ea/editor-receipts.log`. Post-run ownership checks
confirmed normal UUID database removal, empty DB11/no lease and preservation of
the three older diagnostic databases. This is local email/password verification,
not provider/OIDC or production qualification.

The first separate failure/replay/cancel attempt failed **1/1 API / 1/1
Chromium**, 69.87s total, at mobile step focus. Actual failed Condition status,
stored input, safe error and absent output had passed; replay/cancel had not run.
The captured page and current components confirmed a test-selector mismatch:
desktop's accessible label includes a comma/duration, while mobile's exact label
is `Replay gate: Failed`. The independently approved test-only correction uses
that exact mobile label and checks visibility before focus, preserving keyboard,
sheet, Escape/focus, replay/cancel assertions and the 60s timeout. Scoped web
typecheck, lint from the web workspace and formatting pass. An initial root-cwd
ESLint invocation failed to resolve this file's test tsconfig; the correct scoped
invocation passed without changing lint configuration. Log of the failed attempt:
`/tmp/pertexo-f01-nested.KW84Ea/editor-run-recovery.log`. Teardown and ownership
checks passed. Only one corrected recovery run is authorized; no already-covered
receipt or combined journey is being repeated. That corrected run failed
**1/1 API / 1/1 Chromium**, 69.80s total: mobile sheet/focus and actual replay with
corrected input passed, but the separate Wait authoring selector required exact
`Wait for` instead of the rendered `Wait for (in seconds)`. Cancellation and the
final durable gate remain unverified. Log:
`/tmp/pertexo-f01-nested.KW84Ea/editor-run-recovery-exact-mobile-label.log`.
Normal teardown and immediate owned-resource checks passed; no further live run
was started without review of this second test-only mismatch.

After source-backed review of the remaining dialog role/title/buttons, one
exact-field-label run failed **1/1 API / 1/1 Chromium**, 26.80s total (browser
16.7s). Actual Wait duration 600, waiting state and “Keep running” preserving
`cancelRequestedAt: null` passed. Immediate reopening used a global `Cancel run`
button while the closing dialog's submit button was still present; Playwright
correctly rejected the two matches. The rendered mobile `Run actions` group
provides a precise owner for the opener, and dialog disappearance must be awaited
before reopening. No product fix, sleep or timeout increase is justified by this
artifact. Final confirmed cancellation and durable assertions remain open.
Log: `/tmp/pertexo-f01-nested.KW84Ea/editor-run-recovery-exact-field-labels.log`.
Teardown and exact owned-resource checks passed; no automatic retry was made.
Current default frontend tests also pass **98 files / 688 tests**, 28.81s. The
invocation's script delimiter ran the full suite, not the intended focused filter.

The reviewed dialog-lifecycle correction (scoped opener, awaited close before
reopening and final absence assertion) then passed **1/1 Chromium**, 17.7s
(browser suite 18.3s). Real failed-node inspection, replay, 600-second Wait,
non-canceling dismissal and terminal cancellation all passed. The API integration
still **failed**, 27.67s total: its event query orders by `type`, returning
`run.canceled` then `run.cancel_requested`, each with count one; the exact expected
array incorrectly listed them in reverse order. Earlier durable version/run/node
assertions passed, but the subsequent singular cancellation audit assertion has
not run. Log:
`/tmp/pertexo-f01-nested.KW84Ea/editor-run-recovery-scoped-dialog-lifecycle.log`.
Normal teardown and immediate owned checks passed. This is partial connected
proof, not a green final gate; the bounded expected-order correction requires
review before another live run.

The explicit `COLLATE "C"` attempt also passed **1/1 Chromium**, 16.3s (suite
16.8s), but its API integration failed (26.51s) because the expected array had
been swapped to the previous default-locale order rather than C byte order.
Both event types again occurred exactly once. This was a verifier correction
error, not a product defect; no automatic run followed. Log:
`/tmp/pertexo-f01-nested.KW84Ea/editor-run-recovery-deterministic-events.log`.
Normal teardown/owned checks passed. A subsequent no-stack exact byte-order
assertion passed: `_` (95) precedes `e` (101), so C order is
`run.cancel_requested`, then `run.canceled`. The expected rows now use that
proven order with `COLLATE "C"` retained and exact counts/equality unchanged.
Final audit verification remains pending one reviewed final gate.

The reviewed final gate passed **1/1 real API integration and 1/1 Chromium**,
27.39s total (browser 17.7s; suite 18.2s), including normal teardown. Log:
`/tmp/pertexo-f01-nested.KW84Ea/editor-run-recovery-proven-c-order.log`.
Actual failed Condition input/safe error/absent output, phone sheet Enter/Escape
and focus restoration, corrected-input replay against the same immutable version,
600-second Wait, “Keep running” without cancellation and explicit terminal
cancellation passed. Final durable inspection found exactly three runs and node
attempts (failed/succeeded/canceled), two immutable versions, the exact replay
source, both cancellation events once and **one cancellation audit**. C collation
and the microchecked expected order retain exact event equality across locales.

Result IDs: workspace `01a0e68e-1156-76bf-a900-57a26275e0b1`; Condition workflow
`01a0e68e-1355-7760-a378-52fda545190d`, version
`01a0e68e-25cd-7681-8b8b-2f9238740330`, failed run
`01a0e68e-2e16-742d-ae34-d8a494a715b5`, replay run
`01a0e68e-316a-769f-a8b3-c8261e054677`; Wait workflow
`01a0e68e-346a-757d-a18e-d19427036699`, version
`01a0e68e-45be-75b5-acfd-9a05029d1c4c`, canceled run
`01a0e68e-4d8e-77d9-bdd0-d45cc255bb1c`. Immediate approved-resource checks
confirmed normal UUID database deletion, empty DB11/no lease and three older
diagnostic databases preserved. This recovery case closes only its bounded local
gate; the later expression qualification is recorded above, separately from
schedule/controlled-action, read-only browser identity, external provider/production
and cross-browser qualification. No product behavior
changed in these test corrections and no push occurred.

### Real read-only editor qualification (2026-09-28)

The independently reviewed test-only `readonly` scenario passed **1/1 real API
integration and 1/1 Chromium** in 22.40s total (integration test 20.26s; browser
12.2s, suite 12.8s), with the existing 60s browser budget and zero retries.
Log: `/tmp/pertexo-readonly-live.5nUQ7j/readonly-live.log`.
Workspace `01a0e76d-ecec-735e-8e3a-16d66ec6d09b`; workflow
`01a0e76d-ee5d-76c2-86cb-9570771dc8cf`; viewer
`7619e291-081b-41ba-aae2-71846d1395eb`.

Both accounts registered, verified their locally captured mail and signed in
through the ordinary UI. A scenario-only loopback fixture handler transactionally
added the verified viewer to the owned active workspace after checking its
owner/creator. This is explicitly **fixture-admin membership setup**, not an
invitation or role-management journey and not external OIDC/provider proof.
The owner authored, published and executed a Set fields workflow normally.
The viewer's profile, discovery, workflow, draft/ETag, immutable versions and
run history were read through real cookie authorization and shared decoders.
Deliberate draft-save/publish/run-start probes sent ordinary session CSRF and
the original draft precondition; all returned the real nondisclosing
404 `resource.not_found`. UI-generated writes were separately asserted absent.

At 390/1024/1280/1440, keyboard node selection, read-only Setup/Inputs, disabled
history, inspector access/closing and fit/zoom passed. Measurements required at
least 300×300 uncovered canvas after closing the inspector and 500px uncovered
width with the desktop inspector open. Zoom/fit controls in canvas mode and
mobile panel controls with the inspector open/closed were viewport-bounded and
hit-tested against actual DOM covers, separately from keyboard focus. All eight
UI-only screenshots `/tmp/pertexo-live-readonly-{390,1024,1280,1440}-{inspector,canvas}.png`
were inspected; no additional visual blocker was found. Owner-side HTTP
draft/ETag remained identical. Scoped PostgreSQL comparison proved identical
draft revision/graph, workflow/version/run facts, node count, receipts and
audits; the membership remained active viewer with a live ordinary session.
The sanitized receipt records workspace/workflow/viewer IDs, not the baseline
run/version IDs; those were checked in-process against the durable baseline.

Immediate ownership preflight checked the exact approved healthy 55436/56380
containers, all eight explicit database URLs, empty Redis DB11, absent lease in
the **actual DB10 ownership-control namespace** and an unowned port 4174.
Normal fixture teardown passed. The catalog sample occurred only **after**
teardown, so no ephemeral database name/OID was captured. The post-run catalog
`/tmp/pertexo-readonly-live.5nUQ7j/database-after.json` proved no new fixture
database remained and preserved the three older diagnostic OIDs
172428/175980/186635; fixture clients were zero, DB11 was empty, its DB10 lease
was released and 4174 had no listener. No shared service or older database was
stopped/deleted.

No-service checks passed: API/web test typechecks, focused lint, API/web Knip,
architecture/import checks (19 tests), Playwright discovery (one scenario),
ownership/process/disposable regression tests (32 tests), and diff checks.
This closes the bounded local read-only identity/layout gate, not F00/F01 as a
whole. At that checkpoint schedule/controlled-action composition, external
providers/production and cross-browser verification remained open. No production
behavior changed or push occurred.

### Bounded local scheduled authoring qualification (2026-09-28)

The reviewed schedule browser/API/worker fixture now passes **1 API / 1 Chromium
test**, 87.59s total, with final scoped SQL verification. F00 records the earlier
composition, timestamp-representation and fingerprint-verifier failures, their
focused regressions, exact verified identities and normal cleanup evidence:
`/tmp/pertexo-schedule-projections.fneKoY/schedule-live.log` and `cleanup.json`.
Browser-authored one-minute schedule plus saved/reloaded 2×2 nested items survived
an owned runtime restart before natural due; eight nodes/four scoped leaf outputs,
the exact immutable version, explicit disable, durable receipts/events/audits and
one occurrence/run/checkpoint passed. No manual run, SQL rescheduling or fake
clock substituted for scanner admission. Catalog and executable fingerprints
are verified independently against their actual same-cohort projections;
original three-digit due and raw six-digit history preserve exact receipt bytes.

This closes the local schedule composition gate, not all F01 criteria. Runtime
restart is not OS-process crash proof, and two scanners are not deterministic
contention proof. Controlled external-action composition, provider/OIDC,
production infrastructure and cross-browser evidence remain outstanding. No
production behavior changed or push occurred during this qualification.

### Controlled HTTP editor composition accepted (2026-09-28)

The reviewed v6 real browser/API/worker journey passed **1/1 API / 1/1 Chromium**
in 33.99s total (browser 23.3s), with unchanged budgets and zero retries. Ordinary
UI created the credential connection, authored all five nodes/four edges,
saved/reloaded, published and provisioned the webhook, then inspected both runs
of immutable version `01a0e8e2-2dd8-76d2-ad02-3a754b73531a`.
Exact ingress retry after lost acknowledgement recovered true run
`01a0e8e2-3587-723a-9e90-1320452c7c7e`; distinct false input produced run
`01a0e8e2-3941-722b-b17c-56a757a271ef`. Final durable assertions and one actual
controlled HTTP request/effect passed. Full identities, verifier scope, focused
regressions and owned cleanup are recorded in
[F00](00-release-baseline.md#controlled-http-connected-qualification-accepted-2026-09-28).
Log: `/tmp/pertexo-controlled-http-live-v6.I5KkDn/live.log`; postflight:
`/tmp/pertexo-controlled-http-live-v6.I5KkDn/cleanup.json`.

This closes the remaining bounded local composition gate. It is not external
provider/DNS/TLS/OIDC, unsafe-provider-response-loss, OS-crash, deterministic
scanner contention, production or Firefox/WebKit proof. Reviewed coherent
commits, selective integration-only push, scoped PR checks/merge and natural
postmerge CI are now recorded in the release closure below.

### Bounded release closure (2026-09-28)

The reviewed integration delivery merged through
[PR113](https://github.com/vigani1/pertexo/pull/113); safe fixture-cleanup
diagnostics followed in [PR114](https://github.com/vigani1/pertexo/pull/114).
Exact main is `65a7c58bc02a47df660c49106bd4d9e0c5f69456`, whose one natural
[main CI run](https://github.com/vigani1/pertexo/actions/runs/36481275342) and
[CodeQL run](https://github.com/vigani1/pertexo/actions/runs/36481275347) completed
successfully and were independently inspected. No accepted live journey was
repeated for this status reconciliation. F00 records the complete release and
qualification limits.

The bounded local/release gate is closed, not production qualification. PR114's
diagnostics do not establish the earlier intermittent cleanup failure's root
cause; the older zero-success account-link observation is separately unresolved.
External providers/OIDC, real DNS/TLS, unsafe provider response loss, production,
OS-process crash, deterministic scanner contention and Firefox/WebKit remain
unverified. Earlier pending entries in this chronological ledger are historical,
not new authority to rerun or reopen completed editor work.
