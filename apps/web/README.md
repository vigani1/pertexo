# Pertexo web

React 19 + TypeScript + Vite, in the existing pnpm workspace. Implemented:
browser-safe contracts and transport, Better Auth sign-in (email and password,
social providers) with account security, session recovery/logout, workspace
entry, workflow list/create and discovery, workspace creation/display-name
editing, a Home with exact run statistics and the Loom, bounded recent-activity
Overview, the bounded workflow editor with conflict-safe draft persistence,
validation, node preview, typed visual input mappings, exact-version publishing,
run start, live run detail and contract-backed workflow settings/operations,
including automatic trigger-pause rules, owner-managed workspace defaults and
explicit Resume controls. The first read-only Usage slice separates current
execution/artifact capacity from ADR 044 retained run activity, with independent
snapshots and exact server-window drilldowns (ADR 057). It does not introduce
billing, an operation meter, warnings, quota editing or calendar reporting.

ADR 058's first workflow concurrency slice adds a current queue-only cap to
workflow Settings and timestamped queued-run blocker explanations. It preserves
workspace limits and explains grandfathered active/reserved runs. Skip overflow,
per-trigger defaults and independent workflow queue limits remain deferred.

Named synthetic JSON input cases live in the workflow hub and Run with input
dialog. They retain their published-version context; loading makes a detached
copy. Edits require `workflow:update`, loading requires `workflow:read`, and
starting requires `run:start` plus confirmation of real effects. Checked starts
carry the expected publication; conflicts require explicit review. Uncertain
commands retain their exact input, deadline, version and key for the original
24-hour recovery window. Input cases are always available.

Read [Frontend architecture](ARCHITECTURE.md) for folder ownership, shared
contracts, state, forms, saving conflicts, auth, SSE, Weft and verification.
[The repository architecture map](../../docs/architecture.md) describes backend
ownership. Upcoming product work is in `docs/feature-plans/`.

## Run and verify

From the repository root (Node 24 and the pinned pnpm version):

```sh
pnpm install
pnpm dev:web
pnpm --filter @pertexo/web build
pnpm --filter @pertexo/web lint
pnpm --filter @pertexo/web test
pnpm --filter @pertexo/web exec playwright install chromium
pnpm --filter @pertexo/web test:e2e
```

Development uses `http://127.0.0.1:5173` and proxies unchanged `/v1` requests to
`http://127.0.0.1:3000`. Set the server-only `PERTEXO_API_PROXY_TARGET` to a
different HTTP(S) origin when needed; do not use a `VITE_*` value for this.
Browser tests build the app, own a preview server on port 4173 and control the
identity/workspace HTTP boundary. Optionally set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to an existing Chromium/Chrome executable.
The tests do not require a live identity provider, backend, Redis or database;
the API/database suites separately exercise the real callback and discovery
stack.

The supported `test:e2e` script first builds the node catalog and workflow
engine's combined six-package dependency closure. The complete webhook/HTTP
authoring regression reads real catalog pins, and the editor duplication unit
test included by test typechecking reads the engine's admission interface, in
the Node test process, not the browser bundle. This prerequisite is owned by the
same local and CI command; it does not depend on another CI job's build output.
Use the script rather than a direct Playwright invocation when those package
artifacts have not been built.

CI runs mocked browser journeys and the existing owned browser/application
fixtures. Live fixtures are declared in `apps/api/test/owned/` and run by the
API owned-fixture command with isolated PostgreSQL/Redis/service configuration.
Use the fixture's ownership requirements; mocked journeys do not qualify live
provider credentials or production deployment.

Root build/typecheck/lint/test commands include this workspace. CI runs both its
unit tests and the authenticated Chromium journeys. The production output is
`dist/`; the production reverse-proxy template is
`deployment/nginx.conf.template`. A web runtime must render
`PERTEXO_API_UPSTREAM` as an internal HTTP(S) origin without a trailing path,
serve `dist/` from `/usr/share/nginx/html`, and retain the template's distinct
`/v1`, hashed-asset, and SPA-fallback locations. The hosting/load-balancer
wiring remains deployment-owned.

## Small structure, clear ownership

| Location                              | Responsibility                                                                                                                    |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `src/main.tsx`                        | Create one router, query cache and browser API client for the application lifetime.                                               |
| `src/app/`                            | Router factory and server-cache defaults.                                                                                         |
| `src/routes/`                         | Session-aware routes, workspace shell composition and route recovery.                                                             |
| `src/features/auth/`                  | Email/password and configured social entry, current session, account security and logout cleanup.                                 |
| `src/features/workspaces/`            | Workspace discovery, member reads, lifecycle controls, selection and the shared shell.                                            |
| `src/features/workspace-invitations/` | Invitee acceptance and account-entry journey; distinct from administrator invitations.                                            |
| `src/features/overview/`              | Capability-scoped bounded workflow/run recency cards and independent recovery.                                                    |
| `src/features/workflows/`             | Workflow list/create/rename transport, cache ownership, recovery and presentation.                                                |
| `src/features/catalog/`               | Browser catalog discovery and identity-scoped query ownership.                                                                    |
| `src/features/connections/`           | Safe metadata discovery plus bounded Slack create/test/rotate and revocation flows.                                               |
| `src/features/failure-notifications/` | Workspace destination list/create/version/status ownership with safe connection references.                                       |
| `src/features/inbox/`                 | Failing-workflow notices with private read state, the shell's one live hint stream per tab (ADR 055) and its new-failure notice.  |
| `src/features/workflow-editor/`       | Route-scoped graph/config/input-mapping editing, loop bounds/body authoring, history, saving and conflict recovery.               |
| `src/features/workflow-drafts/`       | Shared browser-owned draft snapshot and ETag decoding interface.                                                                  |
| `src/features/workflow-publish/`      | Checked-snapshot ETag validation, preview and exact-ETag publish actions.                                                         |
| `src/features/workflow-versions/`     | Paged immutable-version reads, exact lookup and restore transport.                                                                |
| `src/features/workflow-runs/`         | Workspace history, run commands, authoritative detail and bounded live-event recovery.                                            |
| `src/features/workflow-settings/`     | Versions and compare, lifecycle, published triggers and the current failure-alert choice.                                         |
| `src/features/artifacts/`             | Safe artifact metadata and expiring download-link preparation; no upload UI.                                                      |
| `src/features/usage/`                 | Read-only current capacity and separate bounded retained activity; no billing or quota editor.                                    |
| `src/components/ui/`                  | Weft primitives on Base UI: field and validation timing, notice, status, copy, progress button.                                   |
| `src/components/patterns/`            | Shared compositions: confirm dialog, inline rename, stale line, load more, Core orb, page header, settings section, how it works. |
| `src/lib/api/`                        | Injected same-origin JSON transport, normalized errors, CSRF cookie adapter and cursor paging.                                    |
| `src/lib/`                            | Clock and countdown, time formatting, clipboard, Canvas scene and browser subscriptions.                                          |
| `src/lib/utils.ts`                    | Domain-independent Tailwind class merging only.                                                                                   |
| `src/styles/`                         | Semantic Tailwind tokens and original visual identity.                                                                            |
| `test/`, `e2e/`                       | Component/unit checks and real-browser smoke tests.                                                                               |

Routes compose features; features keep their API calls, queries and UI together
and depend only on shared UI and reviewed contracts. Do not create every future
directory in advance. Extract a shared pattern only when real repetition
demonstrates its interface.

UI-local hooks live beside their consumers: connection testing and credential
forms under their component areas, administrator invitation batching under
workspace invitation components, and inbox arrivals/swipes under
`features/inbox/components/arrivals/`. Inbox live synchronization remains at the
feature root. Public entry files keep these private placements out of callers.

The editor groups pure rules under `model/graph/`, `model/persistence/` and
`model/inspector/`; its store/provider and shared field-unit rules retain their
common model owner. Canvas/add-step and inspector draft hooks sit beside those
UI areas. Runs group models under `model/list/`, `model/timeline/`,
`model/step-inspection/` and `model/loom/`; the Loom renderer shares the
geometry owner, while React keeps interaction/lifecycle. Editor/run tests mirror
their feature ownership under `test/features/`.

Account presentation helpers live under `auth/model/account/`, separately from
the current browser's identity/lifecycle helpers under `auth/model/session/`.
The display-name command lives beside its sole account form; security mutations
remain at their common feature owner. Publishing UI groups validation,
publication, run submission and node preview; its shared command-session and
independently consumable schedule-preview interface remain at the root. Settings
models group versions and triggers. Workflow list and creation UI have their own
component areas, with visibility/ticking beside the list. Workspace member and
lifecycle commands have mutation clusters; creation, rename and invitation
command recovery retain their coordinated owners. Affected tests use the same
feature groups, with scenario names and assertions unchanged.

The current router is code-based, so there is no generated route-tree file or
router build plugin. Define a route in its area module
(`src/routes/root/public-routes.ts`, `workspace/routes.ts` or
`workflow/hub-routes.ts`), using the shared session and workspace loaders in
`root/route-context.ts`, and register it in `src/routes/root/route-tree.ts`.
Editor, settings and run pages use explicit lazy route modules; loader/query
public interfaces remain separate so static loader imports do not collapse those
chunks.

## Browser contract and transport foundation

Stage 1 of the frontend delivery plan is complete. Browser code consumes runtime
validators through schema-only `@pertexo/contracts/schemas/<domain>` package
exports. These exports point directly to the existing schema definitions and do
not initialize client/OpenAPI projection code. Stage 1 publishes catalog,
errors, identity/workspace and transport schema paths; stage 3 adds the reviewed
workflow-authoring and connection schema paths; later delivered slices add the
reviewed run, trigger, notification and artifact schema paths. The web allowlist
permits only those browser-safe paths; future slices must review and allow their
exact contract paths when needed.

`src/lib/api/client.ts` exposes one injected request interface. It owns
same-origin `/v1` paths, cookie credentials, fresh CSRF headers for mutations,
JSON serialization/decoding, bounded byte streams, cancellation/timeouts, safe
problem fallback and bounded response metadata. Endpoint modules will continue
to own paths, request/response schemas, concurrency/idempotency headers and
endpoint-specific problem decoders. Feature endpoint modules for auth,
workspaces, workflows, catalog, connections, publishing, runs, settings and
artifacts are the current production callers.

## Current scope and upcoming work

The connection lens presents Unknown, Healthy, Needs reauthorization and
Revoked, with explicit-test, run-observation and transition timestamps.
Automatic run health applies to supported provider observations without a
rollout switch. The Used by section pages through retained published versions,
including archived references, using the authorized usage endpoint. Reads and
credential commands retain their scope and late-response fences.

The editor, workflow operations, versions, run history, replay, members,
invitations, workspace lifecycle, inbox, read-only capacity/activity and curated
templates use current API contracts. Subworkflows remain a plan awaiting review.
Artifact upload UI needs its supported input contract and real signing/CORS/
checksum/finalize proof. Payments and billing remain future product work. Follow
the [definition of done](ARCHITECTURE.md#14-definition-of-done-for-each-feature)
and feature plans when adding a surface.

## Weft design system

Every page uses the Weft design system; the binding summary, the status language
and the table of shared building blocks are in
[ARCHITECTURE.md](ARCHITECTURE.md#weft-design-system). In short: one
implementation per concept — `LabelledField` with `useFieldValidation` for every
form, `ConfirmDialog` for every confirmation, `ProgressButton` for every pending
command, `CopyButton` (and `useCopyToClipboard` in menus) for every copy,
`Notice` and `StaleLine` for inline messages, `DeadlineField` for every run
deadline, `font-display` for every condensed title, and `useNow`/`useCountdown`
for anything that ticks. Motion uses CSS, Canvas 2D (`CanvasScene`) and SVG
only, stops off-screen and in hidden tabs, and renders still frames under
reduced motion. No Motion, dropzone or 3D dependency is installed.

Verification covers transport failures, browser bundle composition,
unauthenticated redirects, sign-in errors, workspace empty/error/deep-link
states, confirmed logout cleanup, late-response cancellation, keyboard focus,
narrow layout and reduced motion. Mocked-boundary Chromium journeys inspect the
desktop shell and the 390-pixel editor fallback, including keyboard panel
switching, useful canvas dimensions and retained inspector scratch state.
Firefox and WebKit run the critical smoke journeys; browser journeys against the
real stack run from the API integration suite.

React Compiler was evaluated with the documented Babel/Vite integration and was
not adopted: the controlled trial increased build work and emitted bundle size
without establishing a repeatable editor interaction improvement. Existing
purposeful memoization remains in place; revisit only with representative
runtime measurements.
