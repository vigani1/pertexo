# Integrated frontend/backend audit — N1–N3 and M1

Date: 2026-09-21. Status: corrective pass complete for the bounded findings; the
disposable database/API qualification gate is green. The original findings and
their evidence remain below, followed by the closure ledger.

## Scope and baseline

Baseline: `2a2e2b42`; branch: `feat/web-foundation-and-overview`. Includes
tracked and untracked implementation of workspace creation (N1), display-name
editing (N2), bounded Overview (N3), visual input mapping (M1), and the shared
contracts/routes/query/save/model/API/database seams they changed. Source of
truth: [ARCHITECTURE.md](ARCHITECTURE.md), root/web agent rules, existing
contracts and applicable ADRs.

The earlier invitation implementation is not claimed as fully re-audited here.
Its current cross-cutting qualification failure is nevertheless reported. This
is not a whole-repository security certification or production signoff.

## Corrective-pass closure ledger

### Independent rerun of the corrective pass — 2026-09-21

The reviewing task independently reran the following, rather than relying only
on the implementing task's results:

- Web: 220 tests; lint, typecheck and production build passed.
- Shared workflow model: 112 tests; workflow engine: 376 tests passed.
- Browser: all 38 Chromium journeys plus four focused cases in each of Firefox
  and WebKit passed (46 total). The focused cases cover narrow workspace choice,
  long-name bounds, table keyboard scrolling and responsive editor controls.
  Rendered screenshots were inspected, including the corrected zoom buttons,
  fully readable workspace names and the focused/scrolled mobile member table.
- Disposable quality lane: 563 PostgreSQL integration tests, 768 database unit
  tests, and 66 real API integration tests passed. The previously failing unit
  gate now reports functions 100% and branches 99.04%; thresholds were not
  lowered.
- Architecture/import, typed-schema ownership, contract generation/OpenAPI,
  documentation and diff checks passed. The existing OpenAPI warning remains.

Independent machine evidence:
`coverage/local-quality/pertexo-local-quality-2026-09-21t18-56-56-329z-47729-f6468f84/`;
screenshots: `/tmp/pertexo-independent-closure-browser/`. The owned Compose
containers/volumes were confirmed removed. Temporary browser configuration was
removed. No application code, commit or push was made by this verification.
These browser tests use HTTP fixtures; API integration uses the real disposable
services, not a newly executed browser-to-live-provider journey.

Independent frontend source review found no new S1/S2/U3 regression and accepted
the S3/S4 no-extraction rationale. U5's bounded authorized contract has since
been implemented: run read summaries carry the current workflow name when
authorized, the editor uses an exact metadata query, and PostgreSQL applies a
literal name-prefix predicate before keyset pagination without per-row requests.

Independent shared-model/database review also validated B1, B3, B4 and V1. The
reported nested JSON wire-value loss is fixed; browser save/reload and engine
tests pass. An extra own named property attached to a JavaScript array is
outside JSON wire representation and is not preserved by array admission; that
existing in-process boundary was not treated as a regression or as a failure of
the reported JSON-literal fix. No new blocking defect was confirmed in this
corrective-pass verification. U5 implementation and its required local delivery
gates are now complete: the extended disposable real-HTTP API lane passed, and
focused Firefox/WebKit runs were executed through a temporary local Playwright
configuration.

| Item       | Resolution and regression evidence                                                                                                                                                                                                                                                                                                                                           |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1         | Fixed. Rename attempts are canonicalized before capture, retain the accepted receipt and reconcile discovery by workspace identity plus a revision at least as new as the receipt. Component coverage includes whitespace canonicalization, exact uncertain retry and a newer concurrent rename.                                                                             |
| S2         | Fixed. Replay invalidates the identity/workspace run scope after acceptance; archive/restore invalidates both settings and workflow-list scopes. Routed tests require fresh Overview requests after replay and lifecycle changes.                                                                                                                                            |
| S3         | No structural change. The inspector remains the atomic owner of configuration, mapping scratch, dirty state and Apply. Its mapping UI and pure conversion seams are already extracted; another hook would split one form authority without removing behavior or dependencies.                                                                                                |
| S4         | No generic extraction. Creation and rename share transport conventions but have materially different accepted/reconciliation outcomes. Their separate, feature-owned hooks remain the smaller interface.                                                                                                                                                                     |
| B1         | Fixed in the shared workflow-model admission boundary. Own `__proto__` keys and escape-prefix collisions survive nested config and literal JSON, arrays, save/reload and engine execution without prototype pollution. Model, engine and Chromium regressions cover the wire value.                                                                                          |
| B2         | Fixed. Unbroken 128-character names wrap within both the editable name card and read-only identity card; workspace-picker names/slugs reflow at 320px. Bounds are asserted in Chromium, Firefox and WebKit.                                                                                                                                                                  |
| B3         | Resolved as metadata-only semantics. Overview now says “Recently managed workflows” and explicitly excludes draft-only edits; the architecture contract records lifecycle/publication metadata ordering rather than implying every draft save.                                                                                                                               |
| B4         | Fixed. The typed Drizzle schema now declares `workflows_workspace_updated_idx`, matching migration `0099` and readiness ownership. Schema checks report 76 migration tables: 57 typed and 19 raw SQL.                                                                                                                                                                        |
| V1         | Fixed. `canInviteWorkspaceRole` has the exhaustive actor/target-role matrix required by ADR 038. Database unit coverage now passes; the disposable qualification run passed 563 PostgreSQL tests, 768 database unit tests and 66 real API integration tests.                                                                                                                 |
| U1         | Fixed. React Flow child controls use the app surface/foreground variables and an explicit cross-browser focus ring. Responsive browser checks assert computed contrast and focus behavior.                                                                                                                                                                                   |
| U2         | Fixed. Mobile workspace choices show full distinguishing names and slugs with bounded wrapping; two similar long names are covered at 320px.                                                                                                                                                                                                                                 |
| U3         | Fixed. Workflow settings no longer exposes workspace-wide destination enable/disable commands. Authorized managers get a link to workspace destination management; workflow-local Set/Clear remains distinct.                                                                                                                                                                |
| U4         | Fixed with a visible mobile scroll hint, labelled focusable region and explicit Arrow/Home/End horizontal scrolling. Chromium, Firefox and WebKit exercise the member table.                                                                                                                                                                                                 |
| U5         | Fixed with an authorized read projection. History, detail, Overview and editor show the current workflow name with IDs secondary; run history owns a URL-backed literal prefix filter while exact ID filtering remains available. Command receipts remain unchanged. Contracts/API/database/web regressions, disposable real HTTP, Chromium and focused Firefox/WebKit pass. |
| U6         | Fixed in the touched settings/workspace copy. User-facing text describes available behavior and consequences rather than API, revision or ownership implementation details.                                                                                                                                                                                                  |
| U7         | Fixed as a bounded refinement. The mobile editor has compact chrome and hides the minimap, while workflow settings provides section navigation and places lifecycle last in a separated destructive area. Responsive editor bounds remain covered at 390, 1024, 1280 and 1440px.                                                                                             |
| Navigation | Fixed. Workflow and run destinations use TanStack Router links, preserving native new-tab/link behavior. Component and Chromium journeys follow those links.                                                                                                                                                                                                                 |

Final executed evidence: web 25 files / 221 tests, production build/typecheck
and lint; workflow-model 9 / 112; workflow-engine 32 / 376; database unit 113 /
768; disposable PostgreSQL 172 files / 565 tests; real API integration 16 / 66;
full mocked-boundary Chromium 40 / 40; focused U5 Firefox 15 / 15 and WebKit 15
/ 15; contracts, OpenAPI generation, schema, architecture, documentation and
diff checks passed. The existing identity-workspace OpenAPI operation retains
one warning.

U5 additionally passed 2 focused disposable PostgreSQL files / 23 tests. The
normal planner was exercised over 10,000 run rows for absent, selective, common,
no-match and combined prefixes plus a deep cursor. Evidence records emitted and
rejected row instances, summed plan-node work and root shared-buffer touches;
the no-match case emits zero rows but records 42 rejected rows and one shared
buffer touch rather than being misreported as zero work. On this fixture the
normal planner used a sequential run scan without a prefix and nested-loop plus
bitmap scans for prefix cases; this scoped evidence did not justify adding an
index and is not a production-wide performance guarantee. The final disposable
real-HTTP lane passed 16 suites / 66 tests against PostgreSQL and Redis,
including current-name projection, archived exact metadata and literal-prefix
filtering.

React Doctor scanned 231 changed and untracked files with scoring, telemetry and
supply-chain uploads disabled. Its 70 advisory warnings were triaged as existing
complexity/lifecycle heuristics, test-only secret literals, or label false
positives where rendered controls have matching labels. No warning established a
new defect in this pass; no rule was suppressed to change a score.

Visual inspection used rendered screenshots at 320, 390, 1024 and 1440 CSS
pixels in addition to bounds assertions. Browser journeys use controlled HTTP
mocks. The qualification API tests use disposable PostgreSQL/Redis and
controlled OIDC through Fastify injection; no deployed provider/worker or
physical-device claim is made.

This file replaces the completed 2026-09-15 audit at the same tracked path. The
historical report, including its React Compiler experiment, is recoverable from
Git. Old scores/test counts are not current evidence. No ADR, active plan,
application code, commit or branch history was removed or rewritten.

## Standards

### S1 — P2: successful rename can get stuck in refresh recovery

Locations:

- `src/features/workspaces/components/settings/workspace-name-section.tsx:64`
- `src/features/workspaces/workspaces.api.ts:62`
- `src/features/workspaces/mutations/use-workspace-rename.ts:120`

The form retains the raw name, transport validation trims it, and refresh then
requires discovered name equality with the raw attempt. Entering
`  Incident Operations  ` sends a valid trimmed PATCH; the server accepts it,
but the editor stays in accepted/error recovery. Repeated refresh cannot match.
The same equality rejects a legitimate newer name after a concurrent rename.

Evidence: independently reproduced through the rendered Chromium form and
contract-shaped PATCH/discovery mocks, including assertion of the trimmed
outgoing body. Source confirms the successful command result is discarded.
Reload is a workaround; this is P2, not an app-wide P1 outage.

Fix: canonicalize before capturing the attempt. Retain the authoritative receipt
and reconcile authorized discovery by workspace identity/revision, allowing
newer revisions rather than requiring an older name forever. Regression cases:
whitespace, exact uncertain retry, a subsequent concurrent rename, and refresh
recovery without issuing another PATCH.

### S2 — P2: Overview cache misses existing mutation completion paths

Locations:

- `src/features/workflow-runs/mutations/use-run-replay.ts:67`
- `src/routes/run-detail-route.tsx:35`
- `src/features/workflow-settings/mutations/use-workflow-settings-commands.ts:58`

Replay success only navigates; it does not invalidate the run scope used by
recent cards. Archive/restore invalidates its settings summary, not the
workflow-list scope. Visiting Overview, performing either command, then
returning within the 30-second fresh window can display the old list/badge.

Evidence: traced successful callbacks, distinct Query prefixes, 30-second stale
times and loader cache reuse. This is source-confirmed missing invalidation, not
an independently reproduced cross-page browser failure. Publication and initial
run submission already implement the relevant scope invalidation.

Fix: use the owning feature's public query-scope interface for all affected
command completions. Add Overview → replay/archive/restore → immediate return
tests. Do not clear the whole cache or add polling as a workaround.

### S3 — maintainability observation: inspector remains concentrated

`workflow-inspector.tsx` is 885 lines: 154 added/12 removed versus baseline.
Mapping presentation and pure conversion were extracted, but configuration,
mapping scratch, connections, focus, validation, graph updates and dirty
notification remain coordinated in one large form.

This is a change-locality judgement, not a line-count violation. Consider a
small mapping-local behavioral seam after correctness fixes, preserving atomic
Apply and the single draft/history/save authority. Do not split files or invent
hooks just to lower a diagnostic score.

### S4 — maintainability observation: repeated command recovery logic

Creation and rename hooks separately implement identity fencing, exact uncertain
attempts, discovery recovery and cache cleanup. Their outcomes differ, so a
generic command framework is not justified. Compare both during S1's fix;
extract only demonstrably identical behavior and retain separate domain states.

## Spec and behavior

### B1 — P2: literal JSON silently loses a property during save

Locations:

- `packages/workflow-model/src/graph-contract.ts:92`
- `packages/workflow-model/src/graph/input-mapping-keys.ts:72`
- `apps/web/src/features/workflow-editor/workflow-editor.api.ts:49`

M1 accepts JSON literals and promises faithful save/reload. A value such as
`{"__proto__":{"x":1},"normal":2}` passes Apply, but structural parsing via
`z.json()` removes its own `__proto__` property. The outgoing saved graph
contains only `{"normal":2}` and the UI reports Saved. The new escape shim
protects destination mapping keys, not nested literal data.

Evidence: direct execution of the built shared schema AND rendered-browser
entry/save with an assertion on the outgoing graph. Both lose the same property.
This is an inherited codec limitation exposed by the new M1 UI, not a confirmed
prototype-pollution exploit.

Fix: safely preserve admitted own JSON data, or explicitly reject unsupported
values before Apply. Never silently sanitize a successful save. Cover objects,
arrays of objects, escape-prefix collisions, prototype safety, draft/compiled
parsing and actual save/reload without relaxing admission limits.

### B2 — P2: valid long workspace names are clipped on mobile

Location:
`apps/web/src/features/workspaces/components/settings/workspace-name-section.tsx:218`.

The flex child has `break-words` but no effective min-content constraint. A
valid 128-character unbroken name extends beyond the card/screen and is clipped.
Outer overflow hiding means the document-width check still passes.

Evidence: real Chromium rename at 320×640 with 128 `A` characters. Inspected
screenshot visibly clips the name; its element's right edge measured 1341.28125
CSS pixels in a 320-pixel viewport.

Fix: constrain the flex child and use wrapping that affects intrinsic sizing.
Assert content bounds inside the card, not just absence of scrollbars. Test
long/unbroken and normal names across widths.

### B3 — product semantics clarification: what counts as “updated”?

The Overview says “The five workflows changed most recently,” but its query
sorts `workflows.updated_at`. Ordinary draft saves update
`workflow_drafts.updated_at`, not that parent timestamp
(`packages/database/src/authoring/workflow-authoring-drafts.ts:180`). The
recent-order test manually updates the parent timestamp.

This is not a proven query bug: the metadata ordering implementation works.
Decide whether the card means publication/lifecycle metadata changes or all
authoring changes. Narrow the copy/plan if metadata-only is intentional;
otherwise explicitly design atomic timestamp maintenance and invalidation. Do
not silently change backend write semantics during a UI cleanup.

### B4 — schema representation observation

Migration `0099_workflow_recent_list.sql` creates
`workflows_workspace_updated_idx` and readiness checks require it, but
`packages/database/src/schema/authoring.ts:39` does not declare that index.

The actual database index exists and runtime verification passed. This is
schema-description drift, not evidence of a missing production index. Align the
typed representation or document the migration-only ownership decision.

## Qualification and tests

### V1 — P2 release gate: database unit coverage fails

Command: `pnpm quality:local -- --partial integration-api,integration-database`.

The runner provisioned and cleaned its own uniquely named disposable Compose
project. It did not reuse or modify the normal development stack. All 563 real
PostgreSQL tests and all 767 database unit tests passed. The subsequent unit
coverage gate FAILED:

- Functions: 96.29%, required 100%.
- Branches: 93.33%, required 95.3%.
- The uncovered `canInviteWorkspaceRole` function is at
  `packages/database/src/tenant-access/workspace-policy.ts:139`.

That function belongs to the earlier invitation changes, but blocks current-tree
qualification. The combined command stopped before API integration/coverage
merge and must not be called green. Add role-policy matrix tests; do not lower
thresholds. This is a verification failure, not proof the policy is incorrect.

### Independently executed checks

| Check                                   | Result and boundary                                                                                               |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Web unit/component/routed               | 25 files, 218 passed                                                                                              |
| Web typecheck/lint/production build     | Passed                                                                                                            |
| Contracts unit                          | 16 files, 73 passed                                                                                               |
| Contract generation/OpenAPI lint        | Passed; one existing invitation 2xx-response warning                                                              |
| API unit/integration-shaped             | 99 files, 1,321 passed; not live network evidence                                                                 |
| Workflow model                          | 9 files, 112 passed                                                                                               |
| Workflow engine                         | 32 files, 376 passed; actual mapping resolution, not deployed workers                                             |
| Database unit                           | 113 files, 767 passed                                                                                             |
| Disposable PostgreSQL                   | 563 passed; later coverage gate failed (V1)                                                                       |
| Existing real API integration           | 66 passed with disposable PostgreSQL/Redis                                                                        |
| Additional listening-browser experiment | N1/N2 and N3 list requests succeeded; aggregate test failed on an unconfigured connections route (boundary below) |
| Architecture/import/schema ownership    | Passed; 76 migration-owned tables                                                                                 |
| Existing Chromium suite                 | 36 passed; intercepted HTTP                                                                                       |
| Adaptive Chromium audit                 | 16 passed: N1/N2/N3/M1 at 1440×900, 768×1024, 390×844, 320×640                                                    |
| Focused Firefox/WebKit                  | 8 passed: four flows at Firefox 1440×900 and WebKit 390×844                                                       |
| Negative reproductions                  | S1, B1, B2 independently reproduced                                                                               |
| React Doctor                            | 75 changed/untracked files scanned, 44 warnings; scoring/uploads disabled                                         |

React Doctor warnings were treated as hypotheses. Matching label/control IDs and
successful rendered `getByLabel` interactions refute the new native-select label
warnings. Test secret literals are not production credentials. Identity fences,
scratch state and dirty notification effects are not redundant simply because a
static heuristic flags them. The concentrated inspector is a valid
maintainability concern. No numerical codebase score is inferred.

## Actual browser/UI verification

Rendered forms were submitted, mappings applied/saved/reloaded, navigation and
narrow Inspector panels opened, and screenshots inspected. This was not only a
static screenshot resize. Ordinary content fits tested widths. The 320×640
editor leaves a small input viewport because of its command/header stack: usable
in the tests, but a future compact toolbar could improve it.

Three original test assumptions required audit-only adaptations:

- Mapping tests needed to open the narrow Inspector tab.
- Rename assertions selected a hidden desktop-sidebar label.
- Overview expected a mobile navigation button even on desktop.

Those are test-harness limitations, not product bugs. Adapted copies retained
original HTTP mocks and assertions and added content measurements/screenshots.
B2 demonstrates why document scroll width alone is insufficient.

Keyboard validation/focus, mobile navigation and reduced-motion paths were
exercised. This is not full screen-reader/WCAG certification, physical-device
testing, every Safari/iOS version, or a CPU/interaction performance benchmark.
Diagnostics live under `/tmp/pertexo-audit-*` and contain controlled test data.
Temporary audit test copies/configs are removed after verification.

Evidence directories on this audit machine:

- `/tmp/pertexo-audit-adaptive-browser/`: successful four-width runs.
- `/tmp/pertexo-audit-crossbrowser/`: Firefox/WebKit runs.
- `/tmp/pertexo-audit-rename-repro/`: S1 failing regression and trace.
- `/tmp/pertexo-audit-mapping-repro/`: B1 outgoing JSON assertion and trace.
- `/tmp/pertexo-audit-long-name-confirmed/`: B2 screenshot/bounds assertion.
- `/tmp/pertexo-audit-doctor/`: static diagnostics, manually triaged above.

These are local, temporary evidence, not committed CI artifacts. Reproductions
and regression expectations are described above so fixes need not depend on the
continued availability of `/tmp`.

## Live integration boundary

All 66 existing real API integration tests passed using Fastify injection with
disposable PostgreSQL/Redis and controlled OIDC.

An additional temporary Chromium experiment used the built web app, a Vite proxy
and a listening API backed by that disposable database. No `/v1` requests were
intercepted. It reached these assertions successfully:

- Browser SSO callback/session via a controlled test identity provider.
- Workspace creation through the form: POST returned 201 and an actual ID.
- Workspace rename through the form: PATCH returned 200 and the updated name was
  found in the rendered page.
- Overview's recent workflows, recent runs and failed runs: GETs returned 200
  with empty `items` lists for this newly created workspace.

The aggregate experiment FAILED its final all-workspace-GETs assertion: the
minimal API configuration omitted `connections`, so
`/v1/workspaces/:id/connections?limit=100` returned 404. Connection routes are
conditionally registered (`apps/api/src/app.ts:237` and
`apps/api/src/app.module.ts:226`). This is an identified harness configuration
gap, not a demonstrated regression in the configured connection feature. It does
mean the experiment must not be described as an all-green E2E suite. Its first
attempt also failed during test OIDC setup; the retry corrected the test email
and same-origin callback routing, without production code changes.

Live-run evidence is recorded in
`coverage/local-quality/pertexo-local-quality-2026-09-21t17-16-31-027z-24248-d373e7c6/reports/integration-api.json`.
The earlier database gate report is under
`coverage/local-quality/pertexo-local-quality-2026-09-21t17-00-03-471z-21636-0d5d8de0/`.
Both owned disposable stacks were cleaned. No normal development stack was
modified. No production auth bypass, external email or real user identity was
part of this audit.

Remaining integration limits: no live populated Overview ordering walkthrough,
no browser-to-deployed-worker M1 execution, and no full configured production
OIDC/connections deployment. Engine mapping tests and injected API/database
tests provide separate evidence; they do not erase those boundaries.

## Fix and closure order

The subsequent app-wide UI review below adds U1–U3 to the correctness/usability
fix list; U4–U7 are design improvements, not newly discovered backend failures.

1. Fix S1 reconciliation and B1 silent JSON loss with regressions.
2. Complete S2 scoped invalidation and B2 intrinsic-width handling.
3. Restore V1 policy coverage without reducing thresholds.
4. Resolve B3 semantics; align/document B4's schema representation.
5. Address S3/S4 only with small behavior-preserving seams where useful.
6. Rerun affected tests, targeted reproductions and the qualification gate.
   Distinguish intercepted browsers, injected API, network API and live workers.
7. Request commit/merge authority separately. Audit completion does not
   authorize committing, pushing, merging, or claiming production readiness.

## Follow-up: app-wide visual design and usability review

This extends the original new-slice scope to the existing frontend's rendered
pages. It does not retroactively claim a full backend audit of older features.
Used web-design-guidelines and webapp-testing, with a read-only source review
delegated through delegate-native-work. Guidelines reference:
[Web Interface Guidelines](https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md).

### Coverage and evidence

Executed copies of all 36 existing Chromium browser journeys, capturing entry
views and final layouts at 1440, 768, 390 and 320 CSS pixels. The first run was
35/36: the copied SSO test still pointed to the original preview port.
Correcting only that diagnostic fixture and rerunning its seven auth journeys
passed all seven. A separate populated workflow-settings browser inspection also
passed. Three further measurement runs passed for editor controls, member tables
and workflow settings. This is 36 existing journeys passing across runs plus one
additional settings inspection, not 36 independently executed flows at every
width. Resizing final states proves less than replaying every interaction there.

Rendered views inspected: login; workspace selection/creation; workflow index
and create; Overview; editable/read-only editor and input mappings; run history,
replay and detail; connections; workspace general/lifecycle; members/roles and
invitations; invitation acceptance/recovery; notification destinations; workflow
settings with lifecycle, versions, schedules, webhooks and notifications.
Covered normal, empty, denied/recovery and selected failure states—not every
possible server error, role combination or dataset size. Existing fixtures
control HTTP. An invitation-list error in the role test comes from its missing
mock, not a claim that production invitations fail.

Screenshots are under `/tmp/pertexo-ux-audit/`, `/tmp/pertexo-ux-audit-extra/`,
and `/tmp/pertexo-ux-audit-measured/`. The extra settings walkthrough verified
rendering, not every settings mutation. No fresh live backend or physical-device
claim is made for this follow-up.

### Overall design judgement

The visual identity is coherent: dark surfaces, cyan primary actions, consistent
type, restrained glow, clear sidebar active state and repeated section patterns.
Login and first-workflow empty states provide clear actions. Member/settings
navigation is logically grouped. Forms and recovery feedback are generally
readable. There is no evidence that a visual rewrite or another UI framework is
needed. The principal weaknesses are identification, mobile information density,
action scope and implementation-oriented copy. This is an expert inspection, not
evidence from novice-user research or full WCAG certification.

### U1 — P2: editor zoom-control icons lack contrast

`apps/web/src/features/workflow-editor/components/workflow-canvas.tsx:111` —
Controls styles affect the wrapper, but child buttons retain a nearly white
background while inheriting the app's light icon color. Browser computed values
at all four widths: icon/fill `rgb(226,226,230)`, background `rgb(254,254,254)`.
Screenshots show the plus/minus/fit icons barely visible. Set the React Flow
control theme/variables coherently, including hover and keyboard focus states;
verify the actual child buttons, not just the wrapper.

### U2 — P2: mobile workspace picker hides ordinary workspace names

`apps/web/src/features/workspaces/workspace-selection-page.tsx:146` — the fixed
avatar/status alongside a truncating name squeezes “Control Operations” to “Co…”
at 320px. This is the identity the user must choose, not incidental metadata.
Reflow status/avatar or allow name wrapping on narrow cards. Test multiple
similar names and long slugs; do not rely on a hover-only tooltip.

### U3 — P2: workflow settings exposes a workspace-wide Disable action

`apps/web/src/features/workflow-settings/components/workflow-notifications-section.tsx:96`
and
`apps/web/src/features/failure-notifications/components/destination-status-button.tsx:58`
— a plain “Disable” beside a destination inside one workflow's settings changes
the shared workspace destination, not just this workflow's notification policy.
The command's workspace-wide endpoint is confirmed in
`apps/web/src/features/failure-notifications/failure-notifications.api.ts:89`.
The rendered page does not explain this broader effect, and the button submits
immediately. Move shared destination management to workspace settings or label
and confirm the workspace-wide impact. Keep workflow policy removal distinct.
This is action-scope ambiguity, not an authorization bypass.

### U4 — usability: mobile tables conceal important information

`apps/web/src/components/ui/table.tsx:7` — shared 704px minimum width is
retained inside 280px/350px viewports. Connections initially shows name/provider
but not status/actions; members initially shows names but not roles. Horizontal
scrolling exists, so these controls are not proven unreachable. Provide an
obvious scroll affordance and keyboard-accessible region, or responsive rows
keeping key status and actions visible. Verify scrolling/focus in Firefox/WebKit
before claiming keyboard parity; no full cross-browser table interaction was run
here.

### U5 — usability: IDs dominate identification and filtering

Resolved. Run history, run detail and Overview consume the authorized current
name from the run read projection, while the editor uses an exact workflow
metadata endpoint. IDs and immutable version identity remain visible. The
URL-owned “Workflow name starts with” filter runs before the page limit with
literal wildcard escaping and cursor binding; command response schemas were not
widened.

### U6 — usability: frontend copy exposes implementation internals

`apps/web/src/features/workflow-settings/components/workflow-notifications-section.tsx:45`
— “The API does not expose a policy read” and “does not pretend to know”
describe implementation constraints rather than helping the user. Clearly label
the current policy as unavailable and explain what Set/Clear changes; keep the
contract limitation in documentation. Similar terms such as “authoritative”,
“recipient-bound”, and “immutable” should be reserved for details/help unless
essential to the user's next action. Preserve warnings about real limitations.

### U7 — design refinement: prioritize work over chrome

The mobile editor's repeated page identity, command rows and settings icon use
substantial vertical space; its minimap further overlaps the small canvas. Keep
save/state feedback prominent but group secondary commands and consider a
collapsible minimap. Workflow settings puts Archive near the top before routine
schedule/notification tasks; consider a clearly separated lifecycle/danger area
and section navigation for the long mobile page. These are prioritization
recommendations, not evidence that the tested actions fail.

### Follow-up boundaries

Additional navigation consistency finding:
`apps/web/src/features/workflows/workflow-list-page.tsx:160` and
`apps/web/src/features/workflow-runs/components/run-history-table.tsx:79` use
buttons for opening route destinations. Normal activation works, but users lose
native link actions such as opening a workflow/run in a new tab. Prefer Router
Links for direct navigation; preserve unsaved-change guards where relevant. This
was source-confirmed, not a separately executed modifier-click test.

Temporary instrumentation and copied tests were removed. Only this report was
changed permanently. Existing code and uncommitted work were preserved; no
commit, push or application redesign was performed. Address concrete U1–U3
alongside S1/S2/B1/B2/V1, then make a bounded UX pass for U4–U7 instead of
opening another whole-app rewrite.
