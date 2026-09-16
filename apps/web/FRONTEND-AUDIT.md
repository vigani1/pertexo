# Frontend audit and cleanup plan

Date: 2026-09-15. Status: scoped implementation complete; React Compiler
evaluated and not adopted.

## 1. Scope and verdict

This audit covers the current working-tree React application, including
untracked files, not only the committed diff. Baseline HEAD:
`9b1e28e300f44b643e40f4c59c25655dffbcce01`. The repository contains substantial
uncommitted frontend and supporting backend changes. Findings apply to this
snapshot and must be rechecked against subsequent edits.

The preceding source review covered all 101 files in `src/`: routes, app setup,
shared UI/patterns, transport, styles and every feature. This document adds
compiler research, page inventory, delivery-risk assessment and implementation
acceptance criteria. Tests and configuration were inspected selectively; this is
not a new exhaustive backend/security audit or a live production verification.

**Verdict:** keep the React/Vite architecture and feature ownership. Fix
concrete state-lifecycle issues, remove demonstrated redundancy and standardize
existing seams before expanding features. Neither a rewrite nor a generic
application framework is justified. More files, hooks or state fields do not
inherently mean bad code. Complexity must correspond to behavior the application
actually needs.

This is a temporary action register, not a second architecture specification.
[ARCHITECTURE.md](ARCHITECTURE.md) remains the implementation plan and
[AGENTS.md](AGENTS.md) the agent instructions. Resolve findings with evidence,
update lasting guidance where necessary, then retire this audit rather than
accumulating overlapping review documents.

### Evidence and limitations

- Preceding source-review run: 64 tests passed across 15 test files; web
  typecheck, lint and `git diff --check` passed.
- React Doctor full scan: 22 warnings, 67/100. This is a heuristic diagnostic,
  not an unbiased quality score. Label warnings included false positives for
  `FieldLabel` composition; login does not need cache invalidation merely
  because it starts OIDC navigation.
- Eleven Chromium test cases are defined in `e2e/`. They use controlled API
  boundaries. Their existence is not proof of a live IdP/API/worker deployment.
- No new browser, cross-browser, production-load or compiler-on benchmark was
  run for this document. Prior passing checks do not cover every finding below.
- Code/configuration review is evidence of implementation, not a guarantee that
  every shipped behavior is correct. No numerical overall quality score is used.

## 2. What is implemented

“Implemented” below means reachable source exists, not that all acceptance and
release gates have passed. Paths are defined in
[route-tree.ts](src/routes/route-tree.ts).

| Surface                                          | Current contents                                                                                                                                                   | Status / limits                                                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `/`                                              | Session lookup and redirect                                                                                                                                        | Implemented entry route, not a dashboard                                                                              |
| `/login`                                         | Provider-only OIDC start, pending/error feedback                                                                                                                   | Implemented; no local password/signup UI; live-provider journey remains a release gate                                |
| `/workspaces`                                    | Accessible workspace selection, empty/recovery states, logout                                                                                                      | Implemented selection, not workspace administration/onboarding CRUD                                                   |
| `/w/$workspaceId/workflows`                      | Paged workflow list, create dialog, catalog/connection discovery, workspace shell                                                                                  | Implemented baseline; creation pending-state issue F02                                                                |
| `/w/$workspaceId/workflows/$workflowId`          | Palette, canvas, inspector, schema controls plus JSON, connections, history, autosave, conflict comparison, leave protection                                       | Implemented bounded editor, not a complete visual programming IDE; F01/F04/F06/F08 apply                              |
| Editor actions/dialogs                           | Validate, publish, node preview, start run, uncertain-outcome retry                                                                                                | Implemented, not separate pages; preserve revision/ETag/intent semantics                                              |
| `/w/$workspaceId/runs/$runId`                    | Exact-version run detail, node invocation list, execution graph, bounded event timeline, cancellation                                                              | Implemented; no general run-history/search/replay UI                                                                  |
| `/w/$workspaceId/workflows/$workflowId/settings` | Published version list/restore, lifecycle archive/restore, schedule enable/disable, webhook provisioning/rotation, notification destination status/policy commands | Implemented operations subset, not complete creation/editing of every resource; identity and credential issues remain |
| Artifact output panel                            | Metadata check and expiring download preparation                                                                                                                   | Implemented embedded panel; no upload/file-drop/asset-management page                                                 |
| Pending/error/not-found/unavailable screens      | Root loading and recovery routes                                                                                                                                   | Implemented; recovery and small-viewport testing gaps remain                                                          |

Not currently separate delivered pages: dashboard, connections management,
workspace/member/role administration, general run history, dedicated trigger
management, notification-destination creation, account settings, artifact
upload, or operator/admin tooling. These are product backlog choices, not
automatically defects. Do not create empty routes or folders to make the
inventory look complete. Catalog and connections currently provide discovery
data, not full management UI.

## 3. Findings: correctness and lifecycle

Priorities: **P1** = fix before broader feature work/release; **P2** = bounded
correctness or maintainability work; **P3** = measured/optional cleanup. The
original findings are retained below as the review record. Their verified
resolution and evidence are recorded in section 9. “Verification needed” entries
remain questions unless section 9 records a reproduction.

### F01 — P1: scope local state to identity

Evidence:
[workflow-editor.tsx](src/features/workflow-editor/workflow-editor.tsx),
[editor-provider.tsx](src/features/workflow-editor/model/editor-provider.tsx),
[workflow-actions.tsx](src/features/workflow-publish/workflow-actions.tsx),
[workflow-settings-page.tsx](src/features/workflow-settings/workflow-settings-page.tsx).

The provider initializes its Zustand store once and is not keyed by identity.
The router has no `remountDeps` configuration. Param-only navigation can reuse
the editor with a different workflow while retaining its old graph, history,
selection and save metadata. Publish/run attempt refs and settings form state
also have no independent identity reset. Query keys alone do not reset local
state.

Action: key the appropriate feature/session owner by user, workspace and
workflow; fence asynchronous completions to that owner. Do not key by
revision/generation, which would discard scratch edits during ordinary saves.
Preserve explicit navigation protection before abandoning dirty work.

Acceptance: same-route A→B navigation, including cached data, cannot
display/save A's graph under B or retry A's command against B. Test settings
credentials, pending commands and account/workspace changes, including late
responses.

### F02 — P1: create mutation can be reset during submission

Evidence:
[create-workflow-dialog.tsx](src/features/workflows/create-workflow-dialog.tsx).
The name input stays editable and its change handler calls `mutation.reset()`.
TanStack resets observation/pending UI; it does not cancel the network request.
Another submission can become possible and an earlier success can clear new
input.

Action: freeze submitted fields while pending, or maintain explicit submitted
intent ownership without resetting an active mutation. Preserve idempotency
rules. Acceptance: delayed submit plus typing/retry/dismissal produces one
intended creation and no overwritten newer form state.

### F03 — P2: prepared artifact link is not identity-scoped

Evidence: [artifact-download.tsx](src/features/artifacts/artifact-download.tsx),
[node-preview-dialog.tsx](src/features/workflow-publish/components/node-preview-dialog.tsx).
`download` persists if the mounted panel receives a different artifact ID; the
preview caller supplies no artifact identity key. The panel can then label an
old link with a new artifact ID. Late preparation responses have no scope fence.

Action: key the panel or explicitly scope its state/result; abort or ignore
stale responses. Acceptance: prepare A, switch to B, resolve A late; B must not
expose A's URL.

### F04 — P2: keyboard delete bypasses scratch-edit protection

Evidence:
[workflow-editor.tsx](src/features/workflow-editor/workflow-editor.tsx), global
key handler. Delete/Backspace removes a node directly, unlike guarded
selection/history actions. Focus on body or a button is enough to trigger it.

Action: scope deletion to editor/canvas intent and consistently resolve
unapplied edits. Preserve a usable keyboard deletion path and undo. Acceptance:
dirty inspector plus canvas/button focus does not silently bypass the chosen
protection.

### F05 — P2: webhook secret lifecycle and duplicated dialog state

Evidence:
[workflow-webhooks-section.tsx](src/features/workflow-settings/components/workflow-webhooks-section.tsx),
[use-trigger-commands.ts](src/features/workflow-settings/mutations/use-trigger-commands.ts).
Entered endpoint credentials are retained in a map and displayed in an ordinary
text input. `credentialsOpen` is separately synchronized with issued
credentials, and opens only after the command's cache refresh completes.

Action: mask secret entry, clear successfully submitted secrets promptly, keep
issued values only until acknowledgement/unmount, and derive dialog openness
from the issued-credential state. Preserve same-command retry semantics without
persisting plaintext secrets or displaying stale credentials across scopes.
Acceptance: successful issuance is visible even if refresh fails;
acknowledgement clears values/unlocks commands; identity changes clear all
sensitive UI state.

### F06 — P2: render-time external-store reads lack subscriptions

Evidence:
[workflow-actions.tsx](src/features/workflow-publish/workflow-actions.tsx). It
reads selection/generation/revision using `store.getState()` during render,
relying on its parent's subscriptions to cause updates. The parent does not
subscribe to revision. This is a brittle source of stale derived status and is
particularly important before adding compiler memoization.

Action: select the values needed for rendering through the store hook. Keep
`getState()` for event-time latest-state reads. Acceptance: store-only revision
updates refresh validation/publication status without unrelated parent renders.

### F07 — P2: query cancellation and reconnect cleanup are inconsistent

Evidence:
[workflow-settings.queries.ts](src/features/workflow-settings/workflow-settings.queries.ts),
[workflow-settings.api.ts](src/features/workflow-settings/workflow-settings.api.ts),
[use-run-events.ts](src/features/workflow-runs/use-run-events.ts). Four settings
queries omit the query abort signal while summary consumes it. The SSE delay
adds an abort listener per retry but does not remove it after a normal timeout
or check an already-aborted signal first.

Action: forward signals through query and API layers; make delay cleanup
symmetric. Acceptance: navigation/logout cancellation reaches transport;
repeated reconnects do not accumulate listeners and cleanup leaves no pending
backoff timer.

## 4. State, effects and actual redundancy

Inventory at review: 64 `useState`, 17 `useRef`, 6 `useEffect`, 5 `useMemo`, 10
`useCallback`, one `useImperativeHandle`; no `useReducer` calls. These counts
are descriptive, not targets to reduce.

### F08 — P2: remove dead `savedGraph`

[editor.store.ts](src/features/workflow-editor/model/editor.store.ts) writes a
saved graph field that production code never reads. The save coordinator uses
its submitted snapshot and revision/ETag/generation instead. Remove the field,
assignments and unused parameter plumbing, retaining behavioral save/conflict
tests. Do not remove the actual graph, history, conflict snapshots or
idempotency attempts.

### F09 — P2 cleanup: simplify inspector ownership without losing scratch edits

[workflow-inspector.tsx](src/features/workflow-editor/components/workflow-inspector.tsx)
calculates dirty state, reports it through an effect and stores a copy in the
parent. The coordination has a real purpose; it is not a useless effect to
delete in isolation. A local inspector controller shared by its form and guard
can make the ownership explicit. Keep the UI-only scratch draft separate from
committed graph changes and preserve Apply/Discard/Stay behavior.

Extract meaningful inspector sections (configuration, connection selection,
mapping) and pure schema helpers as warranted by responsibility. Likewise,
preview orchestration can move into a feature-local hook/model while dialog
presentation remains in its component. Do not split solely to satisfy line
limits. Parse the same JSON once per render where possible; share the identical
persisted node comparison shape instead of rebuilding it in multiple helpers.

### F10 — P3: preserve useful memoization, remove ceremony selectively

- Keep graph projection memos; both canvases currently create fresh array props
  by spreading those projections in JSX. Return/retain React Flow-compatible
  arrays once per projection rather than copying on unrelated renders.
- Keep stable save transport and coordinator lifecycle behavior until
  deliberately refactored and regression-tested. Memoization must not be the
  sole correctness guarantee for persistence.
- `addNode`'s callback wrapper has no current memoized consumer or subscription
  requiring its identity. It can be an ordinary event handler.
- Inspector schema/baseline memos are not demonstrated performance problems; do
  not manufacture changes merely to remove all memos.
- Keyboard effect, save subscription, preview abort cleanup, SSE and canvas
  animation are legitimate external-system lifecycles. Keep their cleanup.
- A ref used as a synchronous command lock and state used for visible pending
  feedback serve different purposes. Do not remove locks merely because they
  resemble state. Conversely, do not add locks everywhere without a call-path
  need.
- Do not replace all local fields with one giant state object. Use a
  discriminated operation state only where several flags genuinely permit
  invalid combinations.

## 5. Uniform structure and API patterns

### F11 — P2: finish the existing feature conventions

Evidence: [workflows.queries.ts](src/features/workflows/workflows.queries.ts)
mixes read and mutation options;
[run-detail-page.tsx](src/features/workflow-runs/run-detail-page.tsx) owns
cancellation orchestration; routes and sibling features import private
editor/run files despite partial `public.ts` interfaces.

Adopt the following consistently, without creating empty directories:

```text
features/<feature>/
  public.ts                  deliberate consumer exports only
  <feature>-page.tsx         composition and page-level query state
  <feature>.api.ts           paths, contracts, headers, transport calls
  <feature>.queries.ts       keys and read options
  <feature>.mutations.ts     ordinary command hooks/options when small
  components/<area>/         feature-owned presentation when subdivision helps
  model/                     pure logic and genuinely shared local state behavior
  mutations/                 use instead of one large mutation file when needed
```

- Small features may stay flat. Uniform ownership matters more than identical
  trees.
- Routes own navigation/entry; extract repeated workspace/session resolution
  into a focused helper if it removes real duplication, not a generic route
  factory.
- Ordinary server commands use TanStack mutation status/error ownership and
  targeted invalidation. Keep special serialized save and uncertain-retry
  protocols explicit.
- Transport remains `lib/api`; domain calls remain feature-owned. No backend
  imports.
- Shared request/response schemas/types come from reviewed contract exports.
  UI-only form types, React Flow projections and operation state stay in the
  feature.
- Validate incoming responses and outgoing inputs at the API seam; field-level
  validation serves UX and does not replace backend validation/authorization.
- One visible error owner. Distinguish command rejection, uncertain outcome and
  successful command followed by failed refresh. Never automatically replay
  non-idempotent commands just to standardize retries.
- Reuse the run model's terminal-status predicate in the execution graph. Hoist
  date formatters as already done in the workflow list; no formatter hook is
  needed.
- Keep semantic global tokens/base styles/shared effects. Move
  workspace-specific layout CSS into its feature or Tailwind classes; do not
  eliminate CSS altogether.
- Extend existing import enforcement to deliberate feature public interfaces. Do
  not create wrappers whose only purpose is to pass through the same arguments.

## 5A. Follow-up: actual TypeScript and module-interface review

This section records the additional requested code inspection, not merely rules
for future work. It includes a syntax-tree scan of all 100 TS/TSX source files
(the 101st source file is CSS), import-direction inspection, strict compiler
configuration and manual tracing of API adapters, query consumers, command
interfaces and relevant UI state. It does not claim formal verification of every
possible runtime input or an exhaustive audit of shared contract internals.

### Verified strengths: retain these

- No explicit TypeScript `any` annotations, non-null assertion expressions or
  `@ts-ignore` / `@ts-nocheck` / `@ts-expect-error` comments in application
  source.
- All 26 assertion expressions are `as const` or `as unknown`; no
  response-to-DTO assertion bypass was found. `JSON.parse(...) as unknown`
  deliberately requires subsequent narrowing rather than trusting parsed data.
- Root strictness includes `strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, unknown catch variables and no implicit returns.
- API responses are generally decoded using imported runtime contract schemas;
  response DTOs are not broadly copied into independently maintained UI
  interfaces.
- `Awaited<ReturnType<...>>`, indexed-access node/config types and ordinary
  generic API decoders are reasonable here. They are not evidence of
  overengineering.
- React Flow-specific data types belong in the frontend.
  `Record<string, unknown>` satisfies the library's data shape and is not
  equivalent to using `any`.
- `SettingsQuery<Value>` is a small presentation-facing projection, not a clone
  of TanStack's entire result type. Its currently unused `error` member is an
  optional cleanup, not a reason to pass more Query internals into components.
- Distinct validation reports, publication receipts and uncertain command
  attempts represent different facts. Do not merge them just because fields
  overlap.
- Do not introduce a global `types.ts`, generic repository/service layer or
  branded type for every string. Share a type only when it represents one
  genuinely shared concept; retain runtime validation for external IDs and
  opaque ETags.

### F12 — P2: publishing's interface exposes too much editor implementation

Evidence:
[workflow-actions.tsx](src/features/workflow-publish/workflow-actions.tsx),
[use-workflow-save-barrier.ts](src/features/workflow-publish/mutations/use-workflow-save-barrier.ts),
[node-preview-dialog.tsx](src/features/workflow-publish/components/node-preview-dialog.tsx).

Editor imports publishing at runtime; publishing imports the full `EditorStore`
type and knows its save status, graph revision and internal methods. The save
barrier returns the complete store state/actions even though callers need only
saved revision/ETag/generation. Preview separately repeats the flush/clean/dirty
precondition logic. This is a conceptual two-way dependency, **not a
demonstrated runtime circular-import crash**: the reverse imports are type-only.

Action: let the editor own the save precondition and expose a small operation
such as `ensureSaved(): Promise<SavedDraftIdentity>`. Pass explicit reactive
selection and status values needed by presentation. Keep implementation-specific
store access within its owner; use the same precondition for preview, validate,
publish and run. Do not add a service class or adapter framework to accomplish
this.

Acceptance: publishing cannot access history, mutate graph state or depend on
the store constructor type; all commands retain unapplied/conflict/uncertain
guards. Validate the small operation through behavior, including pending
autosaves.

### F13 — P2 cleanup: duplicate draft-result shape

Evidence: `WorkflowDraftSnapshot` in
[workflow-editor.api.ts](src/features/workflow-editor/workflow-editor.api.ts)
and `RestoredDraft` in
[workflow-settings.api.ts](src/features/workflow-settings/workflow-settings.api.ts)
both represent `{ draft: WorkflowDraftResponse; etag: string }` and
independently decode the same body/header pair.

Action: reuse one browser-owned snapshot type at the deliberate workflow draft
interface; consider one decoder if it removes actual repetition without awkward
dependencies. Do not add transport metadata to the shared backend DTO or create
a new workspace package for two consumers. Keep `CreatedWorkflow` separate: its
response/body semantics differ despite also containing an ETag.

Acceptance: get/save/restore agree on the same snapshot contract and reject a
missing or malformed strong ETag. No broad cast should be needed by callers.

### F14 — P2: encode webhook command requirements in the input type

Evidence: `commandWebhook` in
[workflow-settings.api.ts](src/features/workflow-settings/workflow-settings.api.ts)
accepts an independent command union and optional `endpointKey`. TypeScript
therefore accepts `rotate-secret` with no key. Runtime schema parsing rejects
it, so this is a compile-time interface weakness, not a validation bypass.

Action: use a small discriminated union: secret rotation requires `endpointKey`;
provision/endpoint rotation do not. Construct the right variant after validating
the form. Keep runtime schema validation because strings can still be malformed.

Acceptance: a missing key for secret rotation is a type error, valid variants
compile, and malformed external/form values still produce useful validation. No
advanced conditional/generic type machinery is needed.

### F15 — P2: duplicate ownership of workflow-version reads

Evidence:
[workflow-settings.api.ts](src/features/workflow-settings/workflow-settings.api.ts)
implements paged version reads;
[workflow-runs.api.ts](src/features/workflow-runs/workflow-runs.api.ts)
reconstructs the same path, query and response decoding while searching for an
accepted version. `findWorkflowSummary` also reconstructs workflow-list
transport already available in
[workflows.api.ts](src/features/workflows/workflows.api.ts).

Action: reuse owner-exported page readers, leaving caller-specific search and
bounds explicit. Choose ownership based on the workflow resource, not whichever
page first needed it. This complements F11; do not create one universal
paginator with callbacks/configuration more complicated than these operations.

Acceptance: page transport and cancellation are fixed once; exact-version lookup
still cannot silently substitute the newest published version. Bounded-search
failure must not be mislabeled as proof the resource does not exist.

### F16 — P2: paginated data is treated as complete in two consumers

Evidence:
[connections.queries.ts](src/features/connections/connections.queries.ts)
requests one 100-item page, while
[workflow-editor.tsx](src/features/workflow-editor/workflow-editor.tsx) passes
only `connections.data.items` to the inspector. The inspector has no next-page
action.
[workflow-settings.queries.ts](src/features/workflow-settings/workflow-settings.queries.ts)
requests one 25-item version page and
[workflow-versions-section.tsx](src/features/workflow-settings/components/workflow-versions-section.tsx)
does not expose `nextCursor` or a load-more action.

Consequences: a matching connection beyond page one cannot be selected and can
produce a misleading “no active matching connection” message. Older published
versions beyond page one cannot be selected for restore. This is not fixed by
having correctly inferred response types: the consumer discarded pagination.

Action: provide deliberate paged discovery/load-more, or bounded complete
discovery with explicit incomplete/error states. Do not fetch unbounded data
just to make the UI look complete. The workflow-list connection count's `+`
already acknowledges truncation; the editor picker needs its own usable
behavior.

Acceptance: a >100-connection fixture permits selecting a matching item on the
next page; a >25-version fixture permits selecting an older version. Existing
selected connections remain intelligible even when absent from the loaded page.

### F17 — P3: graph no-ops generate unnecessary state/history work

Evidence: `moveWorkflowNode`, `updateWorkflowNode`, `removeWorkflowNode` in
[graph-adapter.ts](src/features/workflow-editor/model/graph-adapter.ts) always
allocate a new graph even when the target is absent or the requested position is
unchanged. `transact` suppresses only reference-identical graph inputs.

Action: preserve the existing reference for cheaply detectable no-ops. Do not
add expensive whole-graph equality checks on every pointer event. Keep
meaningful edits immutable and retain semantically important configuration
changes.

Acceptance: moving to the existing coordinates or deleting an absent ID adds no
history entry, generation increment or save; real edits still record history.

### Type/structure closure additions

- [x] F12: small editor-owned saved-draft operation; no full-store leakage.
- [x] F13–F14: shared snapshot shape and valid command input variants.
- [x] F15–F16: single resource-read ownership and usable pagination consumers.
- [x] F17: cheap no-op graph transitions preserve identity.
- [x] Keep typecheck and regression tests passing without casts/suppressions.
- [x] Review `public.ts` exports as intentional interfaces, not
      export-everything barrels.

## 6. Additional senior-review checks

These are bounded follow-ups, not all proven defects. Do not silently promote
verification questions into implementation requirements.

### UI and interaction findings

- `src/components/ui/dialog.tsx:20` — fixed centered viewport/popup has no
  explicit vertical scroll constraint. Verify long preview/credential content at
  short viewport heights and 200% zoom; ensure all actions remain reachable.
- `src/features/workflow-editor/components/editor-dialogs.tsx:133` — controlled
  leave dialog has no close-state handler; Escape cannot invoke Stay. Check
  unapplied/conflict dialogs too. Define deliberate Escape/outside-click
  behavior rather than silently ignoring close requests or discarding edits.
- `src/routes/route-components.tsx:76` — workspace/workflow navigation is
  expressed as callbacks/buttons; use links for ordinary navigation so browser
  open-in-new-tab and copy-link behavior work. Guarded editor exits still need
  dirty protection.
- `src/features/workflow-editor/workflow-editor.tsx:273` — Apply resolves a
  pending selection but does not execute pending Undo/Redo. Decide whether Apply
  means “apply and stay” or “apply then continue”; immediately undoing an apply
  can itself surprise users. Align copy and add a test before changing this
  semantic.

These checks use the
[Web Interface Guidelines](https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md).
No new rendered accessibility audit was performed; automated label warnings do
not override correctly wired native labels.

### Recovery, security and operational gates

| Area                          | What must be established                                                                                       | Evidence / status                                                                                                                                                              |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Session expiry                | No login redirect loop; no stale privileged data; dirty editor can recover safely                              | Route loaders have inconsistent current-user removal on 401; test expired cached session plus workspace/run failure before prescribing a fix                                   |
| Error boundary retry          | Failed suspense query can recover after API recovery                                                           | Root retry invalidates router then resets; verify Query error reset semantics with a component/browser test                                                                    |
| SSE recovery                  | Distinguish transient disconnect, malformed event/sequence, authorization failure and terminal refresh failure | Catch-all reconnect exists; verify bounded recovery and visible diagnosis, not endless opaque retries                                                                          |
| Command concurrency           | Rapid/programmatic duplicate invocation preserves one intended operation                                       | Some hooks use refs, others only render pending; test actual call paths, especially non-idempotent restore                                                                     |
| Cache coherence               | Archive/restore/publish updates every affected read, without clearing unrelated scopes                         | Review mutation-to-query invalidation matrix; list and settings summary use different keys                                                                                     |
| Pagination/scale              | Large workspace/catalog/version lists and graphs stay usable and bounded                                       | Test realistic data sizes before adding virtualization, indices or memo layers; repeated-cursor defense is useful hardening, not proof the backend currently emits bad cursors |
| Browser contract isolation    | Built app includes schema code, not server/worker/runtime clients                                              | Existing import rules and bundle test are good; preserve and rerun after changes                                                                                               |
| Sensitive data                | No credentials in persisted cache, URLs, telemetry or diagnostic text                                          | Preserve cookie/CSRF design; address F05; inspect failure paths and signature retention                                                                                        |
| Deployment                    | Same-origin `/v1`, SPA deep links, SSE streaming, headers, TLS and cookie behavior hold through real ingress   | Nginx template exists; deployment wiring remains external. Verify forwarded scheme behind TLS termination and effective security headers per location                          |
| Release/update UX             | Stale chunks recover without silently discarding editor work                                                   | Not established by build success; simulate deployment while an editor is open                                                                                                  |
| Accessibility/browser support | Keyboard-only, focus return, reduced motion, zoom, short screens, Firefox/WebKit                               | Chromium tests are not cross-browser proof; Base UI helps but does not validate composition automatically                                                                      |
| Observability                 | Safe request identifiers and actionable browser failures, no secret payload capture                            | Transport captures bounded metadata; production frontend reporting/ownership needs explicit release evidence                                                                   |

Do not add analytics, an error-reporting vendor, new APIs or deployment changes
without a scoped implementation decision. Report missing release evidence
honestly.

## 7. React Compiler recommendation

**Recommend adoption after F01/F02/F06 and lifecycle fixes, as a separate
verified change. It is a good fit to evaluate now, not a cure for structural or
logic bugs.**

Installed: React 19.3.0, Vite 8.3.0, `@vitejs/plugin-react` 6.1.1. Current
config uses `react()` with no compiler integration. React Compiler is opt-in
build tooling, not automatically enabled by React 19. The documented Vite 6+
plugin integration uses `reactCompilerPreset` with `@rolldown/plugin-babel`.
[React installation](https://react.dev/learn/react-compiler/installation).

The installed plugin's README and type declaration also expose
`react({ compiler: true })`, but explicitly mark that native
`oxc-transform-react` path experimental. Prefer the documented Babel route for
this cleanup. It needs compatible pinned `@rolldown/plugin-babel`, `@babel/core`
and `babel-plugin-react-compiler` development dependencies; Babel 7 TypeScript
setup also documents `@types/babel__core`. Recheck peer versions when
implementing. See installed `node_modules/@vitejs/plugin-react/README.md`, React
Compiler section.

Proposed configuration shape only; not applied:

```ts
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import babel from '@rolldown/plugin-babel';

// Preserve existing aliases, API proxy, Tailwind and build settings.
plugins: [react(), babel({ presets: [reactCompilerPreset()] }), tailwindcss()];
```

Expected advantage: automatic memoization can reduce manual optimization work.
Actual benefit for Pertexo remains unmeasured; compiler output may increase
build work and does not fix subscriptions, network latency, state identity or
algorithms. Start with a bounded component/feature trial if whole-app
diagnostics are noisy; React documents directory- or annotation-based
incremental adoption.
[Incremental adoption](https://react.dev/learn/react-compiler/incremental-adoption).

Adoption gates:

1. Fix implicit external-store rendering and mutation/lifecycle bugs first.
2. Inspect the installed hooks ESLint recommended rules and compiler
   diagnostics; do not assume the preset lacks compiler checks or blindly
   replace it.
3. Verify compiled output or DevTools compiler markers. A successful build alone
   does not prove the relevant components were compiled.
4. Run the same unit/browser behavior suite with and without compilation,
   particularly save subscriptions, StrictMode, identity switches and React
   Flow.
5. Measure editor typing/selection/dragging, large graph rendering, live-run
   updates, build time and initial/lazy bundle sizes. Record environment and
   graph size.
6. Keep existing manual memos during initial adoption. Remove proven unnecessary
   ones separately; confirm persistence lifecycles do not depend on cache
   retention.
7. Use narrowly documented opt-outs only if required; do not suppress Rules of
   React violations to obtain a green report. Keep rollback to the prior build
   config easy.

Do not add Next.js, RSC, React Actions, `useOptimistic`, Motion or a new global
store solely because the compiler is adopted. Existing Query/Zustand roles
remain valid.

## 8. Ordered implementation and closure

### A. Correctness before cleanup

- [x] F01: identity-scoped sessions and late-response tests.
- [x] F02: active create mutation cannot reset/re-submit accidentally.
- [x] F03–F05: artifact identity, guarded delete and credential lifecycle.
- [x] F06–F07: explicit subscriptions and cancellation cleanup.
- [x] Resolve the concrete recovery/interaction questions in section 6; record
      whether each reproduced, was already correct or requires a product
      decision.

### B. Small coherent structural cleanup

- [x] Remove dead saved graph state; preserve save/history/conflict semantics.
- [x] Simplify inspector ownership and separate meaningful form/preview
      sections.
- [x] Make mutation/query/public-interface conventions consistent.
- [x] Deduplicate terminal predicates/comparison helpers; fix canvas array
      churn.
- [x] Keep global CSS purposeful; localize feature styling; fix confirmed dialog
      UX.
- [x] Add mechanical checks for the agreed import conventions, not more prose
      alone.

### C. Compiler and measured optimization

- [x] Perform compiler trial using section 7; record diagnostics and benchmark
      results.
- [x] Adopt only with equivalent behavior and acceptable build/runtime
      tradeoffs.
- [x] Remove unnecessary memoization selectively after the trial, not in bulk.

### D. Handoff criteria

- [x] `pnpm --filter @pertexo/web build`
- [x] `pnpm --filter @pertexo/web lint`
- [x] `pnpm --filter @pertexo/web test`
- [x] `pnpm --filter @pertexo/web test:e2e`
- [x] Relevant import/bundle checks and `git diff --check`.
- [x] Real-browser inspection for affected keyboard, dialog and editor behavior.
- [x] Explicit list of remaining live-provider, deployment, scale and
      cross-browser gates.
- [x] Correct stale README claims (future editor wording, lazy-route guidance,
      scan scores and completion language) against verified current
      implementation.
- [x] Update architecture/agent guidance only where decisions actually changed.

For each resolved finding record the changed files, behavioral regression test,
verification result and any deliberate limitation here. Do not mark a phase
complete based only on file presence or a static diagnostic score. No commits,
pushes, dependency changes or implementation work are authorized by this
document itself; follow the user's subsequent scope and root Git discipline.

## 9. Resolution and verification evidence

Implementation date: 2026-09-15.

| Finding | Resolution and evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F01     | Confirmed. Editor and settings local state remount by authenticated user, workspace and workflow. Preview state is additionally keyed by selected node and graph intent. Run submission uses a StrictMode-safe owner token scoped to API client, workspace and workflow: disposal or identity change fences late navigation, and ownership is rechecked after the save barrier before dispatch. The editor revalidates its opening user before every save barrier/write and before every publish/run dispatch, including exact uncertain retries; changed or unverifiable identity blocks dispatch without replacing the original body, precondition, revision or idempotency key. Unresolved run/publish attempts are owned by the authenticated editor session, survive only a temporary pause that hides their UI, and require original-user verification plus an explicit retry; actual editor scope disposal clears them. It observes current-user refreshes, freezes on an identity failure and aborts in-flight draft transport on disposal. The hidden in-memory draft resumes only after an explicit check confirms the original account. Routed regressions cover pre-dispatch autosave/manual/queued-command fencing, publish/run retry rejection for changed and unverifiable identities, preservation across the pause UI unmount, byte-equivalent same-user exact retries, scope disposal, explicit same-user recovery, and an in-flight save aborted after a user switch. This client fence reduces cross-session mistakes but cannot make identity verification and the subsequent write atomic; backend authorization remains authoritative. |
| F02     | Confirmed. The create form freezes its submitted name and cannot reset the active mutation. A delayed-request component test verifies one request and unchanged input.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| F03     | Confirmed. Artifact preparation is keyed by workspace/artifact and aborts on scope disposal. A late-response regression verifies that artifact B never exposes artifact A's link.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| F04     | Confirmed. Delete/Backspace now requires canvas focus and passes through the same Apply/Discard/Stay guard as selection/history. A Chromium journey verifies button focus, Stay and Discard.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| F05     | Confirmed. Endpoint-key entry is masked and cleared after successful submission. Credential-dialog openness derives from the transient credential result; issuance remains visible if cache refresh fails and acknowledgement clears/unlocks it. Existing overlapping-command coverage remains green.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| F06     | Confirmed. Publishing presentation receives reactive selection, generation and revision values; editor internals remain owned by the editor.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| F07     | Confirmed. Every settings query forwards Query's abort signal. Preview/run backoff removes listeners after normal completion and handles an already-aborted signal.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| F08     | Confirmed. Dead `savedGraph` state and save-accept plumbing were removed; save/conflict/StrictMode regressions remain green.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| F09–F10 | Recheck found the inspector dirty notification is necessary coordination, not redundant mirrored authority, so it remains. Pure JSON/schema/persisted-comparison logic moved to `model/inspector-draft.ts`; repeated parsing and canvas projection copies were removed, while lifecycle-critical and projection memos remain.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| F11     | Confirmed. Create and run-cancel mutations have focused owners, terminal run status is shared, resource reads use deliberate public interfaces, and the import checker now rejects private cross-feature imports. Public query/command interfaces are split from lazy page exports so enforcement does not collapse route chunks.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| F12     | Confirmed. The editor now exposes one small `ensureSaved` operation. Publishing and preview no longer receive the editor store or know its actions/history/save implementation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| F13–F14 | Confirmed. Draft body/ETag decoding has one browser-owned snapshot interface. Webhook input is a discriminated union in which secret rotation requires an endpoint key; runtime schema validation remains.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| F15–F16 | Confirmed. Workflow summaries and immutable versions have single page-read owners. Connections and settings versions use bounded, repeated-cursor-defended complete discovery; two-page regressions cover records beyond the former first-page limits.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| F17     | Confirmed. Missing-node and unchanged-position transitions preserve graph identity; a model regression verifies no-op identity.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

Section 6 recheck: short dialogs were a confirmed layout risk and now have a
viewport-relative maximum height plus internal scrolling. Escape maps to Stay
for leave and unapplied-edit dialogs. The existing “Apply” behavior for a
pending Undo/Redo remains “apply and stay”; changing it to immediately undo the
applied edit is a product-copy/interaction decision, not a correctness fix.
Ordinary navigation link semantics, live session-expiry recovery, production
ingress, deployment replacement, cross-browser coverage and production
observability remain release/product verification work; no new routes, vendors
or deployment contracts were introduced by this cleanup.

React Compiler trial: the documented Babel preset compiled successfully and the
output contained compiler memo-cache markers. On the same checkout, Vite's build
step increased from 158 ms to 985 ms; emitted JavaScript increased from 835,633
bytes to 881,161 bytes (gzip totals approximately 261.89 kB to 280.15 kB). No
repeatable editor interaction improvement was established. The acceptable
tradeoff/performance gate therefore did not pass, so the trial dependencies and
configuration were removed. Existing purposeful memos remain.

Final command evidence: web build/typecheck passed (696 modules; editor,
settings and run remained separate chunks); ESLint passed with zero warnings;
Vitest passed 70 tests in 16 files; Playwright passed 12 Chromium journeys,
including the new guarded keyboard-delete path; React Doctor changed-scope
passed 100/100 with no diagnostics; 13 focused import-check tests and the
repository import scan passed; the wider architecture check passed 19 tests;
built-export checks passed 9 tests and 35 consumer cases; `git diff --check`
passed. No live IdP, production ingress, Firefox or WebKit run was performed.
