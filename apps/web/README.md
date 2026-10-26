# Pertexo web

React 19 + TypeScript + Vite, in the existing pnpm workspace. Implemented:
browser-safe contracts and transport, Better Auth sign-in (email and password,
social providers and organization OIDC), authenticator and recovery-code sign-in
with local QR setup and account security, session recovery/logout, workspace
entry, workflow list/create and discovery, workspace creation/display-name
editing, a Home with exact run statistics and the Loom, bounded recent-activity
Overview, the bounded workflow editor with conflict-safe draft persistence,
validation, node preview, typed visual input mappings, exact-version publishing,
run start, live run detail and contract-backed workflow settings/operations,
including personal API token Settings, automatic trigger-pause rules,
owner-managed workspace defaults and explicit Resume controls. Organization
sign-in settings cover DNS verification, provider tests, JIT default roles and
required-SSO recovery; see
[sign-in providers](../../docs/guides/single-sign-on.md). Read-only Usage
separates current execution/artifact capacity from ADR 044 retained run
activity, with independent snapshots and exact server-window drilldowns (ADR
057). F12 adds 80% capacity warnings through F27 and a 30/90-day UTC Trends page
with daily outcomes, elapsed durations and top workflows. See
[Usage](../../docs/guides/usage.md). Billing, an operation meter, quota editing
and reporting timezone settings remain outside this slice.

ADR 058's workflow concurrency settings add a current Queue/Skip cap to workflow
Settings and timestamped queued-run blocker explanations. It preserves workspace
limits and explains grandfathered active/reserved runs. Skip records automatic
trigger events without creating runs and refuses manual starts at the workflow
limit. Per-trigger defaults and independent workflow queue limits remain
deferred.

Named synthetic JSON input cases live in the workflow hub and Run with input
dialog. They retain their published-version context; loading makes a detached
copy. Edits require `workflow:update`, loading requires `workflow:read`, and
starting requires `run:start` plus confirmation of real effects. Checked starts
carry the expected publication; conflicts require explicit review. Uncertain
commands retain their exact input, deadline, version and key for the original
24-hour recovery window. Input cases are always available.

The editor's Contract control declares bounded JSON input and result types for
workflows with one Manual or Webhook entry. Property names, required fields,
array bounds and the result source are edited locally, then applied as one
undoable draft change. Published runs enforce the contract. Call workflow steps
select an exact child version; upgrading is an explicit undoable draft edit.
Calls wait for the child’s validated result, and run detail links both
directions while distinguishing expired child history. Archive confirmation
lists published parents that pin the child before stopping fresh Calls.

On a failed run, **Retry from this step** checks whether saved results can be
reused. It starts a new run of the original version and input: completed steps
and earlier Condition choices are copied; the failed step and its successors run
again with current connections. Reused steps show their source and saved output,
with no execution time or attempt. The copy remains available through the new
run's normal retention window even when source details expire.

A definite failure that reached a service requires an unchecked acknowledgement
before **Retry anyway**. An unknown outcome requires a stronger acknowledgement
because the service may already have applied its effect. Full replay starts from
the beginning and can repeat earlier effects. Initial recovery supports a root
decision tree with Condition and leaf Stop run. It explains refusal for joins,
loops, Wait, Calls, failure links, missing evidence, expired values, stored
files and size limits. Changing the input requires the separate Replay action.

If acceptance cannot be confirmed, **Retry same request** retains the exact
request and key while this run page stays open. It checks the original request
within its 24-hour receipt window. Leaving or reloading loses that in-memory
intent, so check run history first. After the window, the same-request control
stops rather than risk accepting another run.

For bounded collection preparation, UTC date conversion and editable expression
examples, read
[Prepare data in a workflow](../../docs/guides/data-transforms.md).

**Test workflow** runs a saved draft on the worker with live canvas progress,
cancellation and a separate seven-day test history. Draft and single-step tests
can use shared, bounded
[pinned sample output](../../docs/guides/pinned-samples.md). Pins are visibly
separate from real published execution.

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

Development uses `http://127.0.0.1:5173` and proxies unchanged `/v1` and
`/hooks` requests to `http://127.0.0.1:3000`. Set the server-only
`PERTEXO_API_PROXY_TARGET` to a different HTTP(S) origin when needed; do not use
a `VITE_*` value for this. Browser tests build the app, own a preview server on
port 4173 and control the identity/workspace HTTP boundary. Optionally set
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
fixtures. Editor live fixtures run through
`apps/api/test/browser/editor.integration.test.ts`, with
`EDITOR_BROWSER_INTEGRATION`, `EDITOR_BROWSER_CASE` and an explicit owned
PostgreSQL/Redis manifest. The existing CI browser job runs recovery and the
controlled HTTP journey alongside authoring cases. Use the fixture's ownership
requirements; mocked journeys do not qualify live provider credentials or
production deployment.

Live journeys serve the web preview on `PERTEXO_LIVE_WEB_PORT` (default `4174`;
the SAML journey also takes the next port). To run a journey next to another
run, use its own checkout (each build writes that checkout's `dist/`), its own
Compose project and service ports, and a free web port:

```sh
export COMPOSE_PROJECT_NAME=pertexo-live-b POSTGRES_PORT=55520 REDIS_PORT=56520 \
  ARTIFACT_STORE_PORT=59520 PERTEXO_LIVE_WEB_PORT=4184
# Point DATABASE_*_URL, REDIS_URL and ARTIFACT_STORE_ENDPOINT at those ports,
# then start the services, build the ownership manifest and run the journey
# exactly as the "Browser journeys against the real stack" step in ci.yml does.
docker compose up -d --wait postgres redis artifact-store
```

Root build/typecheck/lint/test commands include this workspace. CI runs both its
unit tests and the authenticated Chromium journeys. The production output is
`dist/`; the production reverse-proxy template is
`deployment/nginx.conf.template`. A web runtime must render
`PERTEXO_API_UPSTREAM` as an internal HTTP(S) origin without a trailing path,
serve `dist/` from `/usr/share/nginx/html`, and retain the template's distinct
`/v1`, hashed-asset, and SPA-fallback locations. The hosting/load-balancer
wiring remains deployment-owned.

The root Dockerfile's `web` target supplies that runtime with pinned,
unprivileged nginx. It renders only `PERTEXO_API_UPSTREAM` through the standard
nginx template entrypoint. Expose it behind the trusted TLS front proxy: the
template preserves that proxy's HTTP/HTTPS scheme, with a direct-HTTP fallback.
The image can run with a read-only root and writable `/tmp` and
`/etc/nginx/conf.d` mounts; the single-server stack supplies those mounts.

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
| `src/features/artifacts/`             | Checked input-local uploads, retained file references, metadata and expiring download links.                                      |
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

Browser code imports runtime validators and types from the browser-safe
`@pertexo/contracts` root. Its `/server` entry point is Node-only; the old
`/schemas/<domain>` exports no longer exist. Endpoint modules use the shared
contracts and own their paths and decoding. Review package exports and the
browser import allowlist when adding a contract.

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
templates use current API contracts. Workflow Calls include published-version
pinning, durable parent/child execution and linked run history. File controls
upload and finalize checked files up to 10 MiB, with scoped references reused by
Read file, Create file and HTTP raw/multipart bodies. Larger data travels
through explicit pages; ordinary inline, collection and loop bounds still apply.
Payments and billing remain future product work. Follow the
[definition of done](ARCHITECTURE.md#14-definition-of-done-for-each-feature) and
feature plans when adding a surface.

## Appearance

Account → Profile → Appearance offers System (the default), Light and Dark. The
account menu (More on phones) and command palette → Switch theme offer quick
access to the same choice. The choice is saved for this browser, across
workspaces and sign-in sessions. System follows device changes live. If browser
storage is blocked, the choice still works for the open tab. The boot screen
resolves it before the app loads. Light Weft uses dark teal and violet inks on a
pale cloth ground; the same thread glyphs, floating lenses, Loom and Core retain
their meaning.

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

Failure paths are available on eligible root actions in the editor's Setup tab.
Choose **Follow failure link**, then select or add a separate handler. Its first
step can insert the safe source failure fields. Failure paths support ordinary
Condition decision trees and final Stop run steps; loops, joins, Wait and Call
workflow are outside this release. Unknown outcomes and requested stops never
select a handler. Removing a failure path confirms its owned steps and supports
undo. Run history keeps the original source failed and records whether the
handler completed, including “Finished — 1 failure handled” for a successful
run.

Webhook Setup can opt into bounded replies through a Respond to webhook step.
See [webhook responses](../../docs/guides/webhook-responses.md) for limits, safe
headers, previews, timeout fallback and the admission log.

Code steps choose JavaScript (default) or Python in the lazily loaded editor.
Switching non-empty source asks for confirmation. Shared JavaScript parsing and
the Python editor grammar give local syntax feedback; Python previews use the
real compiler. Both languages share effective instance limits, pinned previews
and private diagnostics. See [Code](../../docs/guides/code.md).

Webhook endpoint settings support Signed (default), Secret URL and Header secret
authentication, with optional exact browser origins for URL/header modes. Mode
or credential-header changes rotate both credentials; origins-only changes keep
them. See [Receive webhooks](../../docs/guides/webhooks.md).

Workflow Comments support workflow/step threads, explicit private mentions,
resolve/reopen and author-only edits/deletion. The shared workflow bar shows
advisory tab presence; unsaved-change warnings retain the draft's existing
revision checks. See [Collaboration](../../docs/guides/collaboration.md).

The Webhook trigger’s Test tab can listen for one real event on a temporary,
authenticated URL and explicitly keep it as a pinned sample. It works before
publishing; see
[webhook tests](../../docs/guides/webhooks.md#listen-for-a-test-event).

The canvas supports bounded Markdown documentation with drag/resize, an
accessible edit form and ordinary undo. Notes stay separate from discussion
threads; see [Canvas notes](../../docs/guides/canvas-notes.md).
