# Frontend quality audit

Date: 2026-09-24. Status: implemented and independently reviewed, with the
nondeterministic Vitest timing caveat recorded below. Scope: the complete
current `apps/web` application, not only the latest diff. This replaces the
completed historical audit at this path; the older report remains recoverable
from Git.

This is a focused closure document, not a second architecture plan. Update the
ledger below while fixing the confirmed items, then remove this file after an
independent final verification. Do not turn advisory-tool output into work
without reproducing or validating it in source.

## Current assessment

The frontend is a strong foundation rather than a cleanup emergency. Feature
ownership, contract reuse, transport isolation, error states, accessibility,
responsive behavior, tests and duplication are generally healthy. The initial
audit concentrated on editor controllers, query/mutation ownership,
authentication synchronization between tabs, startup chunking and small
readability details; the closure evidence below records their disposition.

Evidence captured for this audit:

- 208 TypeScript/TSX source files; 26 unit/component test files and 9 browser
  specification files.
- 243 unit/component tests passed; lint, typecheck and production build passed.
- 51 Chromium browser journeys passed.
- All 19 repository architecture checks passed, including transport isolation,
  public feature boundaries and runtime-cycle checks.
- React Doctor 0.9.14 full scan: 0 errors and 85 advisories in 44 files. The
  confirmed subset is recorded below; label, secret and most pending-state
  advisories were false positives.
- React Doctor design scan: 0 errors and 17 advisories in 9 files.
- Copy/paste scan: one 32-line dialog-footer similarity, only 0.1% duplicated
  lines. It does not justify a generic abstraction.
- Production HTML eagerly preloads about 208 KB gzip of JavaScript. Static
  route-component imports account for a material part of that initial graph.
- Across the source tree there are only 32 `useEffect`, 8 `useMemo` and 20
  `useCallback` calls. Hooks are not being used excessively.

At the initial audit point, the browser suite used controlled HTTP boundaries
and covered Chromium only. That result did not prove live-provider behavior,
production deployment behavior or full Firefox/WebKit compatibility.

## Closure-pass evidence (2026-09-24)

- F1 implemented: a non-secret BroadcastChannel/storage signal now causes other
  tabs to clear Query data and revalidate. A dirty editor pauses without
  dropping original-user scratch or uncertain commands and requires fresh
  original-user verification. The storage fallback unit test and routed two-tab
  logout, identity-switch and dirty-editor regressions passed.
- F2 implemented: each entry/auth/workspace screen now has a focused TanStack
  lazy route module and a narrow feature UI export; loader imports remain
  query-only. The generated initial JavaScript preload graph changed from
  208,068 to 158,109 gzip bytes (49,959 bytes, about 24.0%). This measures only
  the built HTML's script/modulepreload links, not all later route assets. More
  importantly, the previous shared lazy `route-components` module added 44,419
  gzip bytes of static JavaScript for either login or workspace selection; their
  focused route static closures now add 10,560 and 26,442 bytes respectively,
  excluding the initial preload set. The login closure contains no signup,
  reset, account-security or workspace-list UI chunk. Chromium request-level
  assertions also verify that login and workspace entry do not fetch unrelated
  auth-screen chunks.
- F3 implemented by responsibility: session verification, configuration
  scratch/reconciliation, graph-edge controls, schema fields and responsive
  panel layout have focused owners. Atomic Apply, mapping validation,
  save/conflict coordination and command recovery remain at their necessary
  seams. React Doctor still flags the editor and inspector for size and
  complexity; no further split was made solely to alter a heuristic.
- F4 implemented: the parent dirty mirror/callback effect is gone. The editor
  reads the inspector's current committed dirty snapshot at action and
  navigation seams. Selection, delete, undo/redo, Apply/discard and dirty
  navigation regressions passed.
- F5 implemented for the listed mutations: account-session revocation, method
  unlinking, email-change request and workflow creation policy live in feature
  mutation modules; account security has one query-key factory. Dialog/form
  state and exact uncertain create attempts remain local.
- F6 implemented: one keyboard subscription uses a React 19 effect event to read
  current action state. Keyboard, focus and dirty-inspector journeys passed.
- F7/F8 implemented after rechecking moved component paths: mobile control text
  and readable identifiers were raised, validation findings flattened, redundant
  padding and pure-black/diffuse shadows removed, and overview time formatting
  is module-level. The remaining design warning is the intentional, now 12px
  uppercase monospace “Selected node” micro-label.
- F9 implemented: the normal browser command retains full Chromium coverage and
  runs four critical smoke journeys in each of Firefox and WebKit. All eight
  additional journeys passed. Other cross-browser and live-provider flows remain
  unqualified.

Final checks: 244/244 web unit/component tests, production build/typecheck,
lint, 19/19 architecture checks, `git diff --check` and 62/62 browser journeys
passed (54 Chromium, four Firefox, four WebKit). During a later formatting
recheck, two default-parallel Vitest runs each passed 243/244: the editor's
typed-input-mapping test timed out after one second waiting for the lazy-route
canvas, with only an empty root `<div>` in the captured DOM. The same editor
file passed three isolated runs; its focused editor/workflow-list pair passed
33/33; a single-worker full run passed 244/244. Five subsequent unmodified
default-parallel full runs passed 244/244, as did one ten-worker run and one
full run under six concurrent CPU-load processes. A temporary diagnostic probe
did not reproduce the failure and was removed. Vitest uses per-file isolation;
the test setup cleans the DOM and resets MSW handlers after each test. No
deterministic cause or application defect was confirmed, so no speculative test
or product change was made. Pinned React Doctor 0.9.14 full/design scans, with
score/telemetry and supply-chain uploads disabled, reported 82/1 advisories
versus this audit's earlier 85/17. Missing-invalidation on the email-change
request is a false positive: that request only starts verification and does not
change current account data. The repository-wide formatting check passed for
every current modified or untracked `apps/web` source/documentation file. The
repository-wide check still fails on 16 dirty files outside `apps/web`; those
were not reformatted. Browser journeys use controlled HTTP responses, not live
OIDC or a production backend.

## Confirmed work

### F1 — P2: authentication changes are not synchronized across tabs

Session logout and account changes clear the active tab, but the source has no
`BroadcastChannel` or storage-event session signal. A second open tab can keep
rendering cached authenticated data until a focus/refetch or rejected request
discovers the change. This falls short of the architecture's cross-tab logout
requirement.

Implement one small authentication-session synchronization module. Broadcast
only a non-secret event and generation/version; never broadcast credentials or
user data. On logout, completed account change and confirmed identity change,
cancel/clear the appropriate Query cache and force router revalidation or safe
reauthentication in every tab. Provide a storage-event fallback where needed,
avoid a second auth store, and add a multi-page browser regression.

### F2 — P2: the initial route graph eagerly loads unrelated screens

`src/routes/route-components.tsx:10-19` statically imports every authentication
page, workspace selection and workflow list through broad public modules.
`route-tree.ts` then imports that shared route module. The built index preloads
roughly 208 KB gzip of JavaScript before route-specific lazy chunks, including
large auth/API code that many first visits do not need.

Split route components into focused route modules or lazy route components. Keep
loader/query contracts in lightweight modules so navigation data loading does
not reintroduce broad UI imports. Preserve router preloading semantics and
measure the generated `dist/index.html` preload graph before and after; do not
claim improvement from source layout alone.

### F3 — P2 maintainability: workflow editor has two concentrated controllers

`src/features/workflow-editor/components/workflow-inspector.tsx:125` owns a
600-plus-line form containing catalog schema fields, advanced JSON, connection
requirements, input mappings, graph edges, validation, focus, Apply and dirty
coordination. `src/features/workflow-editor/workflow-editor.tsx:127` owns more
than 500 lines of session fencing, save transport, blocking, command
coordination, keyboard actions and responsive panel rendering.

Decompose by behavior and ownership, not arbitrary file size. Preserve the
single atomic Apply operation, editor store authority, save/conflict semantics
and identity fencing. Good seams are inspector draft/validation, graph-edge
editing, session verification, editor action arbitration and presentation
regions. Do not replace either component with one equally large custom hook.

### F4 — P2 maintainability: inspector dirty state is duplicated through an effect

`workflow-inspector.tsx:234-239` pushes live `dirty` state into the parent with
an effect and resets it on cleanup. The parent separately stores `formDirty` at
`workflow-editor.tsx:165`; navigation blocking and action arbitration depend on
that mirrored value. This creates an extra-render synchronization seam and is
the meaningful React Doctor callback/effect finding.

Give one scoped controller/store or parent-owned draft model authority over the
dirty snapshot, or expose a stable current snapshot at the editor action seam.
Do not replace this with another prop-callback effect. Retain regressions for
navigation blocking, selection, delete, undo/redo, Apply and discard.

### F5 — P3: server mutations and query keys are not uniformly feature-owned

The architecture requires API, query and mutation policies to live in feature
data modules, but presentation components directly construct mutations in:

- `src/features/auth/account-security-page.tsx:56-70`
- `src/features/auth/components/account-methods-section.tsx:45-54`
- `src/features/auth/components/account-email-section.tsx:24-27`
- `src/features/workflows/create-workflow-dialog.tsx:44-54`

Account-security invalidation also repeats raw tuples while
`account-security.queries.ts:13-24` has no exported key factory. Move transport,
retry and cache policy into focused feature mutation modules/hooks and export a
single account-security key factory. Keep local form, confirmation and visual
feedback state in components. Do not create a generic application-wide command
framework.

### F6 — P3: the editor keyboard subscription churns with render state

`workflow-editor.tsx:400-424` recreates the global `keydown` subscription when
selection or the action callback changes, and includes unused `store` and
`transact` dependencies. Use React 19's effect-event pattern or a stable event
subscription that reads the authoritative editor snapshot. Preserve editable
target, canvas focus and dirty-inspector guards.

### F7 — P3: a small set of controls and labels are below comfortable mobile text size

Confirmed examples:

- `features/auth/components/link-provider-dialog.tsx:108,131`
- `features/workspaces/components/invite-member-dialog.tsx:83,112`
- `features/workspaces/components/member-role-dialog.tsx:57`
- `features/workflow-editor/components/selection-toolbar.tsx:13`
- `features/workflow-editor/components/inspector/node-inspector-header.tsx:19,31`
- `features/workflow-editor/components/node-palette-item.tsx:28`
- `features/workflow-publish/components/workflow-validation-findings.tsx:45,79`

Raise interactive control text to a mobile-safe size (generally 16px on narrow
screens, with smaller desktop treatment where appropriate) and user-readable
labels to at least 12px. Compact machine identifiers may remain visually
secondary, but not at approximately 10px when users must read them.

### F8 — P3: bounded visual and consistency cleanup

- Flatten the nested card treatment in `workflow-validation-findings.tsx:40-79`.
- Remove redundant axis padding declarations in `node-palette.tsx:26` and
  `node-palette-item.tsx:16`.
- Replace the pure-black toolbar shadow in `selection-toolbar.tsx:8` and avoid
  the combined hairline border/wide shadow at `workflow-editor.tsx:429`.
- Use a module-level `Intl.DateTimeFormat` in
  `features/overview/components/overview-card.tsx:69` instead of constructing
  locale formatting during render.

These are bounded polish tasks, not a redesign of the established visual
language.

### F9 — P3: current cross-browser qualification is narrower than the app surface

The normal browser command passed all 51 journeys in Chromium but did not run
Firefox or WebKit. Add a deliberately small critical smoke matrix for login,
workspace navigation, one modal/form, the editor keyboard/focus flow and narrow
responsive layout. Keep the full suite on Chromium unless runtime evidence
justifies tripling it.

## Findings deliberately rejected

- The 22 loading-flag advisories mostly point to code that already resets in a
  guarded `finally`, or intentionally stays pending through navigation.
- All 11 missing-label advisories inspected use `FieldLabel htmlFor` with a
  matching control ID; the detector does not resolve the custom primitive.
- The six secret advisories are synthetic literals in tests/E2E fixtures, not
  production client secrets.
- The four missing-invalidation advisories inspected either invalidate manually
  after `mutateAsync` or start workflows whose authoritative data must not
  change until later verification.
- Handler-only booleans can sometimes become refs, but the current small-form
  rerenders are cheap. Do not mechanically convert state to refs.
- The existing effects largely own AbortControllers, SSE streams, browser
  subscriptions, canvas animation, focus or store/save lifecycles and should
  remain effects.
- The one duplicated dialog-footer fragment is too small and semantically
  different to warrant a shared abstraction.
- Do not enable React Compiler as a substitute for this work. The confirmed
  problems concern ownership, synchronization and chunk boundaries rather than
  missing memoization.

## Closure order

1. F1 with a multi-tab regression.
2. F3/F4/F6 as one behavior-preserving editor refactor, verified after each
   coherent seam.
3. F5 feature mutation/query-key ownership.
4. F2 route chunking with measured before/after build evidence.
5. F7/F8 visual polish and F9 critical cross-browser smoke coverage.
6. Rerun unit/component tests, lint, typecheck/build, architecture checks, React
   Doctor, design scan, Chromium E2E and the focused Firefox/WebKit matrix.
   Independently inspect the final diff and generated preload graph.

No item is closed merely because a tool score rises. Preserve existing behavior
and security semantics, and update this document with exact tests and measured
evidence for every accepted or rejected item.
