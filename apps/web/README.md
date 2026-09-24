# Pertexo web

React 19 + TypeScript + Vite, in the existing pnpm workspace. Stages 1–6 are
implemented: browser-safe contracts and transport, provider-only OIDC sign-in,
session recovery/logout, workspace entry, workflow list/create and discovery,
workspace creation/display-name editing, bounded recent-activity Overview, the
bounded workflow editor with conflict-safe draft persistence, validation, node
preview, typed visual input mappings, exact-version publishing, run start, live
run detail and contract-backed workflow settings/operations.

For the proposed implementation direction, read
[Frontend architecture and implementation plan](ARCHITECTURE.md). It covers
folder ownership, API/shared types, Router/Query/Zustand communication, forms,
errors, saving conflicts, auth, SSE, legacy design reuse and delivery gates. It
is a plan, not a list of delivered features. It also specifies function/helper
placement, component composition, skill usage, and the proposed screen/user-flow
map with backend prerequisites and deferred surfaces.

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

Root build/typecheck/lint/test commands include this workspace. CI runs both its
unit tests and the authenticated Chromium journeys. The production output is
`dist/`; the production reverse-proxy template is
`deployment/nginx.conf.template`. A web runtime must render
`PERTEXO_API_UPSTREAM` as an internal HTTP(S) origin without a trailing path,
serve `dist/` from `/usr/share/nginx/html`, and retain the template's distinct
`/v1`, hashed-asset, and SPA-fallback locations. The hosting/load-balancer
wiring remains deployment-owned.

## Small structure, clear ownership

| Location                              | Responsibility                                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `src/main.tsx`                        | Create one router, query cache and browser API client for the application lifetime.               |
| `src/app/`                            | Router factory and server-cache defaults.                                                         |
| `src/routes/`                         | Session-aware routes, workspace shell composition and route recovery.                             |
| `src/features/auth/`                  | Email/password and configured social entry, current session, account security and logout cleanup. |
| `src/features/workspaces/`            | Workspace discovery, member reads, lifecycle controls, selection and the shared shell.            |
| `src/features/overview/`              | Capability-scoped bounded workflow/run recency cards and independent recovery.                    |
| `src/features/workflows/`             | Workflow list/create transport, cache ownership, recovery and presentation.                       |
| `src/features/catalog/`               | Browser catalog discovery and identity-scoped query ownership.                                    |
| `src/features/connections/`           | Safe metadata discovery plus bounded Slack create/test/rotate and revocation flows.               |
| `src/features/failure-notifications/` | Workspace destination list/create/version/status ownership with safe connection references.       |
| `src/features/workflow-editor/`       | Route-scoped graph/config/input-mapping editing, history, saving and conflict recovery.           |
| `src/features/workflow-drafts/`       | Shared browser-owned draft snapshot and ETag decoding interface.                                  |
| `src/features/workflow-publish/`      | Saved-revision validation, preview and exact-ETag publish actions.                                |
| `src/features/workflow-versions/`     | Paged immutable-version reads, exact lookup and restore transport.                                |
| `src/features/workflow-runs/`         | Workspace history, run commands, authoritative detail and bounded live-event recovery.            |
| `src/features/workflow-settings/`     | Versions, lifecycle, published triggers and failure-notification controls.                        |
| `src/features/artifacts/`             | Safe artifact metadata and expiring download-link preparation; no upload UI.                      |
| `src/components/ui/`                  | Weft primitives on Base UI: field and validation timing, notice, status, copy, progress button.   |
| `src/components/patterns/`            | Domain-independent compositions: confirm dialog, stale line, load more, Core orb, page header.    |
| `src/lib/api/`                        | Injected same-origin JSON transport, normalized errors, CSRF cookie adapter and cursor paging.    |
| `src/lib/`                            | Clock and countdown, time formatting, clipboard, Canvas scene and browser subscriptions.          |
| `src/lib/utils.ts`                    | Domain-independent Tailwind class merging only.                                                   |
| `src/styles/`                         | Semantic Tailwind tokens and original visual identity.                                            |
| `test/`, `e2e/`                       | Component/unit checks and real-browser smoke tests.                                               |

Routes compose features; features keep their API calls, queries and UI together
and depend only on shared UI and reviewed contracts. Do not create every future
directory in advance. Extract a shared pattern only when real repetition
demonstrates its interface.

The current router is code-based, so there is no generated route-tree file or
router build plugin. Define a route in its area module
(`src/routes/authentication-routes.ts`, `workspace-routes.ts` or
`workflow-routes.ts`), using the shared session and workspace loaders in
`route-loaders.ts`, and register it in `src/routes/route-tree.ts`. Editor,
settings and run pages use explicit lazy route modules; loader/query public
interfaces remain separate so static loader imports do not collapse those
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

## Next implementation

The staged frontend baseline, connection-management increments, explicit run
replay, workspace run history, notification-destination management, authorized
member list and workspace lifecycle settings slices in the architecture plan are
complete. Existing-member role changes are implemented; invitations are
implemented with remaining provider/full-stack and cross-browser verification
gates recorded in the plan. Workspace creation UI, display-name editing, the
bounded Overview and visual input mappings are implemented. The selected N1–N3
and M1 slices now require their planned integrated review. Artifact input upload
remains gated on a supported artifact-valued node/input contract and its browser
proof; templates and non-billing usage remain optional decision-gated slices.
Payments and billing are outside current scope. Add future surfaces only from
concrete product demand and existing contracts, following the
[delivery gates](ARCHITECTURE.md#14-delivery-sequence-and-acceptance-gates) and
[coding patterns](ARCHITECTURE.md#2-folders-and-dependency-direction). Do not
invent discovery contracts or enable artifact uploads without the required
real-browser signing/CORS/checksum/finalize proof.

## Weft design system

Every page uses the Weft design system; the binding summary, the status language
and the table of shared building blocks are in
[ARCHITECTURE.md](ARCHITECTURE.md#weft-design-system-supersedes-the-aurora-glass-refinement).
In short: one implementation per concept — `LabelledField` with
`useFieldValidation` for every form, `ConfirmDialog` for every confirmation,
`ProgressButton` for every pending command, `CopyButton` (and
`useCopyToClipboard` in menus) for every copy, `Notice` and `StaleLine` for
inline messages, and `useNow`/`useCountdown` for anything that ticks. Motion
uses CSS, Canvas 2D (`CanvasScene`) and SVG only, stops off-screen and in hidden
tabs, and renders still frames under reduced motion. No Motion, dropzone or 3D
dependency is installed.

Verification covers transport failures, browser bundle composition,
unauthenticated redirects, OIDC start/error, workspace empty/error/deep-link
states, confirmed logout cleanup, late-response cancellation, keyboard focus,
narrow layout and reduced motion. Mocked-boundary Chromium journeys inspect the
desktop shell and the 390-pixel editor fallback, including keyboard panel
switching, useful canvas dimensions and retained inspector scratch state. After
the Weft uniformity pass, React Doctor's scan of the changes that pass made
reports no diagnostics. Its scan of the whole Weft branch against `main` keeps
19 reviewed advisories that are not defects: loading flags already reset in
`finally` behind a request-ownership check, a validation message whose name
reads like a token, the inspector's deliberate `flushSync` before focusing a
tab's control, an append-only step story keyed by position, the invitation
journey's token-handover and StrictMode-safe retirement effects, the Loom's
pointer shortcut (each run is also a link in the list beside it), and two
mutations whose cache update the caller supplies or which change nothing cached
yet. The score remains a triage aid rather than a delivery gate. Firefox/WebKit
and a live-backend journey through the controlled OIDC provider remain pending;
the mocked Chromium lane does not prove either integration.

React Compiler was evaluated with the documented Babel/Vite integration and was
not adopted: the controlled trial increased build work and emitted bundle size
without establishing a repeatable editor interaction improvement. Existing
purposeful memoization remains in place; revisit only with representative
runtime measurements.
