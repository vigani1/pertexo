# Frontend architecture and implementation plan

Status: **stages 1–6 implemented; the staged frontend baseline is available**.
Inspected 2026-09-14 against foundation commit `9b1e28e` (merged to main as
`12aded2`). The current app has browser-safe contracts and transport,
provider-only OIDC entry, workspace selection, workflow discovery/create and a
lazy, conflict-safe graph editor, publishing/run flow and workflow operations.

This is the frontend's implementation reference: ownership, communication,
coding patterns, visual migration and delivery gates. [README.md](README.md)
owns setup/current capabilities; [AGENTS.md](AGENTS.md) owns agent instructions.
Update this document when a decision changes; do not create parallel audit logs.
Existing backend contracts, [domain vocabulary](../../CONTEXT.md) and accepted
ADRs remain authoritative. This plan does not change backend behavior.

Reading guide: start with [architecture](#1-the-architecture-in-one-minute),
[folders](#2-folders-and-dependency-direction), the
[unified implementation standard](#unified-frontend-implementation-standard) and
[state ownership](#3-exactly-who-owns-each-kind-of-state). Implementation
details follow under [contracts](#4-shared-packages-api-contracts-and-types),
[HTTP/auth](#5-http-auth-and-endpoint-ownership),
[queries](#6-router-query-and-mutation-patterns),
[forms](#7-validation-and-forms),
[editor saves](#8-editor-ids-saves-publish-and-run),
[errors](#9-errors-and-recovery-belong-at-the-right-level) and
[streams](#10-runs-sse-and-artifact-transfers). The
[visual migration](#11-reusing-the-old-design-without-importing-the-old-app),
[web concerns](#12-other-web-concerns-we-must-not-leave-implicit),
[tests](#13-tests-and-mechanical-enforcement) and
[delivery sequence](#14-delivery-sequence-and-acceptance-gates) complete the
plan.

The follow-up specifications cover
[function placement and composition](#16-function-placement-and-component-composition),
[skill usage](#17-how-skills-are-applied) and the
[screen-and-journey map](#18-screen-and-journey-map). These extend the same
plan; they do not authorize implementation or claim the screens already exist.

## 1. The architecture in one minute

One browser-only React/Vite application in `apps/web`, talking to the existing
NestJS API. No Next.js server, second backend, frontend database access or
browser workflow executor.

```text
User navigation → Router → feature query options → TanStack Query
                                                    ↓
User command → feature mutation / save coordinator → feature API functions
                                                    ↓
                                            shared HTTP transport
                                                    ↓
                                             Pertexo /v1 API
                                                    ↓
                                  existing database / queue / worker

Editor interaction → scoped Zustand draft → graph adapter → React Flow display
                              ↓
                    save coordinator (above)

Run events → fetch/SSE transport → runs feature → refresh Query snapshots
```

Shared packages supply portable **definitions of data**, not a second network
path. The API supplies live data and enforces authorization and execution rules.
React Flow draws the graph; Zustand owns unsaved edits; neither executes nodes.

### Fixed choices for this plan

| Concern                    | Choice                                                     | Scope                                                                     |
| -------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------- |
| App/build                  | Existing React 19, TypeScript, Vite, pnpm workspace        | Keep pinned foundation versions; no stack migration                       |
| Navigation                 | TanStack Router, code-based routes                         | URL parameters, validated search, loaders, pending/error states           |
| Server state               | TanStack Query                                             | Cached API snapshots, loading, mutations and invalidation                 |
| Client state               | React locally; provider-scoped Zustand for editor          | No global business-data store                                             |
| Canvas                     | React Flow (`@xyflow/react`)                               | Controlled rendering and gestures behind an adapter                       |
| HTTP                       | Native `fetch`, one small shared transport                 | JSON/errors/cookies/cancellation; no Axios or generated SDK initially     |
| Static forms               | Existing controlled React forms + shared Zod schemas       | Keep one owner per form; adopt RHF only through a deliberate replacement  |
| Dynamic node configuration | Catalog-driven, bounded field renderer                     | Advisory client checks; backend semantic validation remains authoritative |
| UI                         | Existing shadcn **Base UI** setup, CVA, Tailwind 4         | Owned primitives and semantic tokens, not mixed Radix/Base recipes        |
| Motion                     | CSS first                                                  | Add a motion library only for a demonstrated interaction requirement      |
| Tests                      | Vitest/Testing Library, MSW at first API slice, Playwright | Model, component/network, and real-browser integration seams              |

React Hook Form is not installed in the delivered frontend. Existing forms keep
their feature-owned controlled state and shared Zod parsing, including on-blur
feedback, submit-time focus and on-change correction after a failed submit. A
future RHF adoption must deliberately replace that ownership across a bounded
form slice; it must not introduce a second form authority inside existing forms.
Dependencies named as future additions are **not installed by this plan**;
verify compatible versions when that slice is implemented.

## 2. Folders and dependency direction

The following is a target map, not a request to create empty directories. Add
files when their behavior exists. Keep a small feature flat until subfolders
make it easier to navigate.

```text
apps/web/
  AGENTS.md / README.md / ARCHITECTURE.md
  src/
    main.tsx                    # create app-lifetime dependencies
    app/
      router.ts                 # inject query client and API dependency
      query-client.ts           # conservative shared cache defaults
      app-providers.tsx          # dependency/context composition, when needed
      session-lifecycle.ts      # scoped cleanup on login/logout/identity change
    routes/
      route-tree.ts             # small code-based route registration
      root-layout.tsx           # public shell + top-level recovery
      workspace-layout.tsx      # workspace navigation and route composition
      workflows-route.tsx       # params/search/loader + feature composition
      workflow-editor-route.tsx # lazy editor entry
      run-route.tsx             # lazy run view entry
    features/
      auth/                     # session query and login/logout behavior
      workspaces/               # discovery, membership and workspace UI
      workflows/
        workflows.api.ts        # exact endpoint requests/response decoders
        workflows.queries.ts    # keys + queryOptions factories
        workflows.mutations.ts  # mutation hooks + cache effects
        workflow-list.tsx       # feature presentation
        create-workflow-form.tsx
        public.ts               # only exports needed outside this feature
      catalog/                  # API catalog queries + selection UI
      connections/              # credential forms, safe metadata and picker
      workflow-editor/
        workflow-editor.tsx     # feature entry/composition
        model/
          editor.store.ts       # factory, selectors, commands; no networking
          editor-provider.tsx   # one store per editor identity
          editor-history.ts     # bounded coherent edit transactions
          graph-adapter.ts      # domain graph ↔ canvas representation
          save-coordinator.ts   # serialized conditional saves and conflicts
        components/             # separate feature-owned visual modules
          canvas/               # node card, handles, edge, controls, selection
          palette/              # palette, category list, node item
          inspector/            # panel layout and sections
          chrome/               # command bar and workflow name field
        forms/                  # catalog field renderer and input scratch state
        public.ts
      runs/                     # run queries, commands, stream lifecycle/view
      artifacts/                # signed transfer workflow, when needed
    components/
      ui/                       # shadcn/Base UI primitives
      patterns/                 # proven domain-independent compositions
    lib/
      api/
        client.ts               # transport factory, no feature imports
        api-error.ts            # normalized transport failure representation
        csrf.ts                 # readable CSRF cookie adapter
        sse.ts                  # bounded SSE decoding, only when runs need it
      utils.ts                  # existing cn helper
    styles/
      globals.css               # semantic tokens, base styles, small utilities
  test/
    lib/                        # HTTP/problem/stream protocol tests
    features/                   # model + component/network behavior
    support/                    # fresh providers, contract-valid fixtures, MSW
  e2e/                          # actual browser journeys
```

Rules:

- `app` and `routes` compose features. Features never import either layer.
- Shared `components` and `lib` never import features. Primitive UI has no API
  calls, workspace logic, auth dependency or query keys.
- Features may consume another feature's deliberately small `public.ts`; never
  its private store/components. Keep that graph acyclic. Initially the editor
  may consume workflows, catalog and connections; those do not import the
  editor. Run views consume workflow version queries, not editor state.
- Expose a feature entry, query factories or a reusable picker only as needed.
  No barrel that re-exports every file; no intra-feature imports through its own
  public entry. Keep heavy UI out of lightweight query export dependency paths.
- Routes own page composition; feature code owns behavior. Feature UI obtains
  the injected API through a small shared context or explicit prop; it must not
  import `app` to access a singleton. Loaders use the router's same dependency.
- No root `services/`, `repositories/`, `types/` or `hooks/` dumping grounds. A
  hook belongs to the feature that gives it meaning. Extract only a genuine
  reusable responsibility, not another pass-through function.
- Backend HTTP **route definitions** remain in `apps/api`. Browser route files
  define pages; feature `*.api.ts` files define outgoing requests. There is no
  Next-style `app/api` folder or client-side server route implementation.

Naming: kebab-case filenames; PascalCase components/types; `useX` for hooks;
`*.api.ts`, `*.queries.ts`, `*.mutations.ts`, `*.schema.ts` and `*.store.ts`
when the distinction is useful. Use named exports and `import type`. Prefer
ordinary TypeScript, explicit props and discriminated unions over clever generic
layers. Comments explain invariants/tradeoffs, not what the next statement says.

### Unified frontend implementation standard

This is the common implementation contract for **every feature**, not just the
editor. The sections below supply the detailed behavior; individual features
must not invent a competing organization, state strategy or styling system. This
standard is a prerequisite for future implementation, not authorization to begin
it or a claim that enforcement is already implemented.

#### One structure, created only as needed

```text
features/<feature>/
  <feature-entry>.tsx          # compose the feature's UI and behavior
  <feature>.api.ts             # requests and response decoding
  <feature>.queries.ts         # scoped keys and query options
  <feature>.mutations.ts       # server commands and cache effects
  components/                 # separate feature-owned visual responsibilities
    <meaningful-name>.tsx
    <sub-area>/               # group a substantial area when needed
  forms/                      # form UI and its input validation schemas
  model/                      # pure rules, transformations, complex local state
  public.ts                   # only what outside callers actually need
  <responsibility>.public.ts # optional loader/command interface kept separate from a lazy page export
```

The template defines placement, not mandatory scaffolding. A small feature may
keep its few files flat, as in the workflows map above. Once grouping helps, use
these responsibility names rather than a different taxonomy per feature. Do not
create empty folders, a store for every feature or a hook for every file. Tests
mirror the owning feature under `test/features/`; shared test setup stays in
`test/support/`.

| Responsibility          | Consistent home and rule                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Page/navigation         | `routes/`: validated params/search, loaders and feature composition; no business implementation                          |
| Feature presentation    | Feature entry composes separate UI modules; substantial cards, panels and toolbars live in its `components/`             |
| Feature behavior        | Named feature-local functions/hooks; pure rules and transformations in `model/` when grouping is useful                  |
| API communication       | Feature `*.api.ts` uses shared `lib/api` transport; no direct fetch calls in UI or stores                                |
| Server synchronization  | `*.queries.ts` and `*.mutations.ts`; no duplicate query keys, request logic or cache rules in components                 |
| Forms and validation    | Feature-owned forms and `*.schema.ts`; import portable shared contracts where applicable, keep UI-only input rules local |
| Types and helpers       | Beside the behavior that owns them; shared wire types come from approved package exports, never backend internals        |
| Reusable presentation   | `components/ui` for primitives, `components/patterns` for genuinely domain-independent compositions                      |
| Reusable infrastructure | Focused `lib/<responsibility>` modules; no generic helpers/services dumping ground                                       |

#### Small modules, meaningful names

- Separate substantial visual responsibilities into named files. A feature entry
  assembles them; it does not define the entire screen's components, request
  logic, validation and state transitions inside one file.
- Keep each module cohesive with a small interface. Split by responsibility and
  independent change, not an arbitrary line limit. Tiny private markup helpers
  can remain local; avoid one file per fragment and pass-through layers.
- Use domain vocabulary and purpose in names. Avoid vague `manager`, `helper`,
  `data` or `common` names that do not reveal what the module does. Apply the
  filename/export conventions above consistently.
- Hooks coordinate one meaningful React lifecycle or interaction. Do not move a
  monolithic component into a monolithic hook. Pure calculations are ordinary
  functions, not hooks; derived values are calculated rather than synchronized.
- Keep `public.ts` small. When a route loader or another feature needs a static
  query/command interface from a feature whose page is lazy, use one focused
  `<responsibility>.public.ts` interface so the static import does not pull the
  page into the eager chunk. This is an intentional interface, not an
  export-everything barrel.
- Prefer explicit props, callbacks and children. Use compound composition or
  context for genuinely coordinated behavior, not as a mandatory wrapper. Keep
  private details private; cross-feature consumers use deliberate exports.

#### One communication and state convention

- Query owns server snapshots; URL owns navigation/shareable filters; forms own
  input state; local React owns transient UI. Scoped Zustand is reserved for
  complex shared client state such as the unsaved editor draft.
- Multiple independent local states are fine. Multiple writable copies of the
  same information are not. Do not mirror query data into stores or add effects
  to keep redundant booleans and derived values synchronized.
- Reads follow feature query options → feature API → shared transport. Server
  commands follow mutation/save coordinator → feature API → shared transport,
  with explicit cache updates/invalidation. UI renders the resulting state.
- Use the common normalized API error contract and one visible feedback owner
  per failure. Forms map field errors inline; page/feature recovery handles
  broader failures. Client validation improves feedback; the server remains
  authoritative. See sections 4–9 for the exact contracts and exceptions.
- Use Tailwind utilities, semantic tokens and shared variants for ordinary UI.
  Global CSS still owns theme/base styles; custom CSS is a small, justified
  exception for effects or vendor integration, not a parallel feature styling
  system. Follow section 11's extraction and styling rules.

#### Before coding and before calling a slice done

Before each approved slice, identify its scope, file ownership, public
interface, state owners, API/shared contracts, error/validation behavior and
observable acceptance tests. Keep this a short task checklist, not another
architecture document. Resolve consequential departures from this standard
before implementing them; do not reopen settled choices for routine work.

Before handoff, check that no giant component/hook, duplicated writable state,
private cross-feature import, speculative abstraction or unnecessary CSS layer
was introduced. Run the applicable tests and import/lint checks from section 13
and meet section 15's definition of done. Mechanical checks support this
standard; they do not replace checking responsibility and readability.

## 3. Exactly who owns each kind of state

| Data                                                           | Owner                                 | Lifetime / reset                                                |
| -------------------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------- |
| Current-user profile                                           | Auth query                            | Revalidated session; remove on identity change                  |
| Workspace ID, workflow/run ID                                  | Validated route params                | Navigation; never trusted for authorization                     |
| Shareable filters, pagination cursor, active run-view tab      | Validated URL search                  | Back/forward/deep link                                          |
| Workflow lists, saved drafts, versions, catalog, run snapshots | Query cache                           | Identity/workspace-scoped keys; explicit invalidation           |
| Unsaved workflow graph and undo history                        | Editor-scoped Zustand                 | One authenticated identity + workspace + workflow               |
| Selection, panels and canvas interaction state                 | Editor scope or local React           | Not serialized into the domain graph                            |
| Form text, touched/errors, incomplete number/JSON input        | Local form                            | Explicit apply/reset; never silently copied from refetch        |
| Popover open, hovered control, temporary disclosure            | Local React state                     | Component lifetime                                              |
| CSRF token                                                     | Readable cookie via transport adapter | Read fresh when sending a mutation; not a Zustand field         |
| Run stream connection/cursor                                   | Runs feature controller               | One run-view subscription; dispose on scope change              |
| Secret input                                                   | Local credential form only            | Clear promptly after submission/unmount; never persistent cache |

The Query saved draft and Zustand working draft intentionally differ: **server
baseline versus unsaved edits**, not two writable copies of the same live state.
Do not mirror query lists into Zustand, use Query as undo history, or save a
React Flow internal object as the backend graph.

Use a vanilla store factory inside a React provider, created once for its keyed
editor instance; subscribe to small stable selectors. This follows Zustand's
[scoped initialization pattern](https://zustand.docs.pmnd.rs/learn/guides/initialize-state-with-props).
Do not create a module-global editor store. React-derived values normally stay
derived rather than being synchronized through effects; effects are for external
systems such as streams, timers and navigation protection.
[React guidance](https://react.dev/learn/you-might-not-need-an-effect).

No persisted Query cache, offline mutation queue, persisted credentials or draft
localStorage in the first release. Harmless UI preferences may be versioned and
persisted later. Crash recovery needs an explicit privacy/storage design; an
unload warning is not durable recovery.

## 4. Shared packages, API contracts and types

| Kind                                                    | Source of truth                                               | Browser usage                                             |
| ------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------- |
| HTTP request/response schemas and inferred types        | `packages/contracts/src/http/*` and public package exports    | Reviewed public schema/type subpaths only                 |
| Problem codes and shapes                                | `@pertexo/contracts/errors` plus endpoint-specific extensions | Parse once at the transport/endpoint boundary             |
| Graph, node, edge, mapping value shapes                 | `@pertexo/workflow-model/graph-contract`                      | Shared portable validation/types, not copied interfaces   |
| Definition identities/config schemas/ports/availability | Authenticated catalog API                                     | Query live release; do not bundle an independent registry |
| UI node appearance, field state, edit commands          | Owning frontend feature                                       | Local types, referring to shared domain types             |
| ORM records, persistence envelopes, use-case types      | Backend/database packages                                     | Never imported by the web app                             |
| Executable node implementations, compile/evaluate logic | Backend runtime packages                                      | Never shipped to the browser                              |

Relevant existing contracts include `/identity-workspace`, `/catalog`,
`/workflow-authoring`, `/workflow-runs`, `/connections`, `/node-testing`,
`/artifacts`, `/webhooks`, `/schedules`, `/transport` and `/errors`. Do not
import the contracts root by habit. Browser-usable workflow-model leaves include
`/graph-contract`, `/lifecycle`, `/json-path` and `/failure-notification` when a
real use requires them. Its root, `/graph`, `/canonical-json`, `/mapping` and
`/expressions` are not browser exports. Do not import node executors or
`@pertexo/node-sdk/server` just to obtain a type.

**Package prerequisite:** several contracts entrypoints currently construct
client/OpenAPI projections at module initialization; see
[catalog.ts](../../packages/contracts/src/catalog.ts) and
[schema-projection.ts](../../packages/contracts/src/schema-projection.ts).
Passing a forbidden-import check is not proof of a lean browser bundle. Before
the first runtime schema import, provide deliberately schema-only public
entrypoints (proposed `@pertexo/contracts/schemas/<domain>`) if a
consumer-bundle test cannot prove projection code is eliminated. Keep existing
exports backward compatible, reuse the same schema definitions and retain
generated artifact checks. Choose and record the final public path in this
document at that gate; do not reach into package source or duplicate schemas as
a shortcut.

**Stage 1 result:** the selected public convention is
`@pertexo/contracts/schemas/<domain>`. Each package export resolves directly to
an existing schema-definition module; current exports remain backward
compatible. Stage 1 publishes catalog, errors and transport schema paths. A real
Vite library-mode consumer imports the catalog and common problem schemas and
verifies that its module graph contains neither `schema-projection` nor
`openapi-primitives`, no Node builtin, and no catalog OpenAPI document. Web
production source initially allows only the exact `schemas/errors` and
`schemas/transport` imports used by `lib/api`; each future feature must review
and publish or allow its own exact schema path when needed.

Then add only needed workspace dependencies, build references and explicit
browser lint allowlist entries. A real Vite consumer build must demonstrate no
Node polyfills, backend code or runtime OpenAPI generation. Type-only imports
still use permitted public boundaries.

Type conventions:

- Infer wire types from the shared schema or import its exported inferred type.
  A form with transforms distinguishes input from parsed output (`z.input` /
  `z.output`); it does not cast raw input to a DTO.
- Parse incoming JSON as `unknown`; no `response.json() as Workflow` assertions.
  Feature response schemas decode domain data; transport owns protocol failures.
- Keep ISO timestamp strings in the wire cache. Format at the view boundary with
  `Intl`; label timezone where it matters. Do not silently reinterpret schedule
  timezones or put nonserializable Dates in query keys.
- UI-only types live beside their owner. A shared type package is justified only
  by real independent consumers, not to avoid a local file.

## 5. HTTP, auth and endpoint ownership

### Transport boundary

`lib/api/client.ts` exposes a small injected client with native fetch
underneath. It owns base-path resolution, same-origin API policy, cookie
credentials, fresh CSRF headers for authenticated mutations,
cancellation/timeouts, status/content type handling and safe errors. It accepts
the endpoint's response decoder; it does not know what a workflow is, decide
query invalidation or show a toast.

Feature `*.api.ts` functions own method/path, path encoding, validated
query/body, success decoder and required concurrency/idempotency headers. Return
typed data and explicitly required metadata, e.g. `{ draft, etag }`, not raw
`Response` through every component. Missing/malformed required ETag is a
protocol error. Handle 204 without JSON parsing. Retain safe request ID and
bounded Retry-After metadata. Restrict raw `fetch` to transport and the separate
signed-transfer adapter; do not add network calls inside components or stores.

Use one error convention: async API functions resolve typed success or throw a
normalized `ApiError`. No mixing `{success:false}`, nullable data and exceptions
for the same operation. User cancellations are recognized separately from
failures. Timeouts/aborted writes may already have committed on the server.

### Auth and deployment decision

Default to **same-origin `/v1`**: a development proxy and production reverse
proxy serve the API under the web origin. Preserve actual `/v1` paths, cookies
and headers. Do not invent an `/api` rewrite that breaks OIDC callback URLs. The
API currently has no CORS setup, so direct cross-origin credentialed requests
are not an implemented alternative. A different topology needs deliberate CORS,
cookie, CSRF and exposed-header configuration and real-browser verification.

Current flow: `GET /v1/auth/oidc/start` sets a binding cookie and returns
`authorizationUrl`; navigate to it. The provider calls the backend callback.
`pertexo_session` is HttpOnly; `pertexo_csrf` is readable and is echoed as
`x-csrf-token` for mutations. Never read a session token into JavaScript or
reuse the old app's token storage. Authenticated fetches use cookie credentials.

The callback redirects to a fixed configured same-origin landing route after it
sets the session cookies. No arbitrary user-supplied redirect target is
accepted. The SPA requests `/v1/users/me` before protected loaders run.

On explicit logout/identity change: stop streams/timers, invalidate the scope
generation, abort reads, dispose editor/form state and remove protected query
and mutation caches. Late results must not repopulate the next user's state.
Workspace changes use the same scope discipline and first resolve dirty edits.
Session expiry freezes writes; same-user recovery may preserve the in-memory
draft only while it is fenced from other identities. Confirm identity before
resuming, refetch server baseline and run the conflict rules. Never silently
resume a pending write under another identity.

A full-page OIDC navigation destroys in-memory editor state. Do not
automatically redirect a dirty editor and claim its edits will survive. First
release must warn before that navigation; recovering in the same open tab after
login in another tab is permissible only after identity verification. Popup
authentication and durable draft recovery are not implicitly supplied by the
session query.

Auth guards are UX, not security. Backend guards remain authoritative. Workspace
discovery must expose enough current membership/permission information to drive
honest controls; do not copy backend policy engines into the frontend.

### Current routes that matter to the first slices

Below `W` means `/v1/workspaces/:workspaceId`; `F` means
`W/workflows/:workflowId`. All mutations below require CSRF. “Key” means a
stable Idempotency-Key for that logical command, not a new key per retry.

| Operation                                  | Actual endpoint                                                                                                 | Important obligation                                                      |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Current user / logout                      | `GET /v1/users/me`; `POST /v1/auth/logout`                                                                      | Logout 204; no key                                                        |
| Create workspace / read members            | `POST /v1/workspaces`; `GET W/members`                                                                          | Create key; member cursor pagination                                      |
| Workflow list / create                     | `GET W/workflows`; `POST W/workflows`                                                                           | Create key; capture returned draft ETag                                   |
| Catalog / integrations                     | `GET /v1/node-definitions`; `GET /v1/integrations`                                                              | Authenticated, globally scoped, currently no arbitrary filters            |
| Read / save draft                          | `GET F/draft`; `PUT F/draft`                                                                                    | Save `{graph}`, opaque If-Match; no key                                   |
| Validate / publish                         | `POST F/validate`; `POST F/publish`                                                                             | Validate saved server draft; publish If-Match + key                       |
| Versions / restore version                 | `GET F/versions`; `POST F/versions/:versionId/restore`                                                          | Restore empty object + If-Match; no key; changes draft only               |
| Archive / unarchive                        | `POST F/archive`; `POST F/restore`                                                                              | Key + expectedLifecycleRevision; not version restore                      |
| Test node                                  | `POST F/draft/nodes/:nodeId/test`                                                                               | expectedRevision; validate vs test_execute; only execution mode needs key |
| Start run                                  | `POST F/runs`                                                                                                   | Key; input/deadline, not an unsaved graph                                 |
| Run list / read / events                   | `GET W/runs`; `GET W/runs/:runId`; `GET W/runs/:runId/events`                                                   | Filtered cursor summaries; snapshot plus resumable SSE                    |
| Cancel / replay                            | `POST W/runs/:runId/cancel`; `POST W/runs/:runId/replay`                                                        | Cancel no key; replay key + explicit version ID/input                     |
| Create / rotate / revoke / test connection | `POST W/connections`; `PUT W/connections/:id/secret`; `DELETE W/connections/:id`; `POST W/connections/:id/test` | Keys except revoke; rotation needs expectedSecretVersionId                |

Source:
[identity controllers](../../apps/api/src/identity-workspace/controllers.ts),
[auth controllers](../../apps/api/src/identity-workspace/auth-controllers.ts),
[authoring controller](../../apps/api/src/workflow-authoring/controllers.ts),
[run controllers](../../apps/api/src/workflow-runs/controllers.ts),
[connection controllers](../../apps/api/src/connections/controllers.ts), and
[public contracts](../../packages/contracts/package.json).

Connection and run-list discovery are implemented through browser-safe shared
contracts and workspace-authorized cursor reads. Do not persist created IDs as a
discovery substitute. Artifact browsing still needs a listing contract if it
becomes a requirement.

## 6. Router, Query and mutation patterns

Use code-based route definitions with explicit lazy boundaries for editor/heavy
views. Proposed browser URLs: `/login`, `/workspaces`,
`/w/$workspaceId/workflows`, `/w/$workspaceId/workflows/$workflowId`,
`/w/$workspaceId/runs`, `/w/$workspaceId/runs/$runId`,
`/w/$workspaceId/connections`. These are browser page URLs; the route inventory
below distinguishes delivered pages from later proposals.

Validate route params/search before fetching. Shared public ID schemas where
available; feature-local schemas for UI search. Unknown/invalid filters receive
a predictable reset or route error. Search/filter controls update URL state; do
not keep a second committed filter copy in Zustand. Only send supported API
query fields; local filtering of one page must not pretend to search all
records.

One query-options factory is used by a loader and its consuming hook. The loader
calls `ensureQueryData`; the component reads the same key. Keep router preload
staleness at zero so Query controls freshness; preload only critical data and
start independent requests concurrently. A first implementation must explicitly
choose whether stale cached content is shown while refreshed or freshness is
required before entry; `ensureQueryData` alone is not a guarantee of freshness.
[Router external-cache integration](https://tanstack.com/router/latest/docs/guide/external-data-loading).

Canonical key hierarchy (ordinary readonly arrays, not a generic key framework):

```ts
// Examples of planned keys; scope is non-secret and changes with identity.
['session', sessionEpoch, 'me'][('user', userId, 'workspaces')][
  ('user', userId, 'workspace', workspaceId, 'workflows', 'list', filters)
][('user', userId, 'workspace', workspaceId, 'workflows', workflowId, 'draft')][
  ('user', userId, 'workspace', workspaceId, 'runs', runId)
][('user', userId, 'catalog', 'definitions')]; // global API, not workspace-filtered
```

`sessionEpoch` is an in-memory generation, never a token. Canonicalize optional
filters/cursors and include every request-dependent variable. Secret input is
never a key. Authentication cleanup/generation checks are required even with
user-keyed caches; user IDs alone do not fence a late response after relogin.

Defaults stay 30-second stale time, no automatic retries for queries or
mutations. Tune by endpoint with evidence: immutable versions may have longer
freshness; active runs refresh from events; discovery has bounded freshness and
release invalidation. No persisted cache. Opt-in read retries may retry bounded
transient network/5xx failures with backoff, but not validation/auth/conflict
errors. Respect bounded Retry-After. Query cancellation passes its `AbortSignal`
all the way to fetch; also explicitly abort identity-scoped work on logout.
[Query cancellation](https://tanstack.com/query/latest/docs/framework/react/guides/query-cancellation).

Use `useQuery` for panels that can show local loading/errors; reserve Suspense
for deliberate route-level loading boundaries. Do not assume every Suspense
query has the same cancellation behavior—test the selected API. When using
query-backed route errors, reset Query's error boundary together with Router
invalidation/retry. The current generic route error component is not sufficient
proof of that integration.

Mutation rules:

1. Feature API function sends the command. Feature mutation hook owns targeted
   cache updates/invalidation. Component owns immediate form/dialog feedback.
2. Generate a key once per logical keyed command; retain the original body,
   preconditions and key for retry after an uncertain response. Do not rotate
   the key until this is genuinely a new command. Do not persist secret bodies
   in a retry journal or offline mutation cache.
3. Disable duplicate submit for the same command, not the whole app. Guard
   handlers as well as button styling. Do not auto-retry writes on reconnect.
4. Prefer confirmed response updates plus targeted invalidation. Start without
   optimistic network writes. Canvas edits are local editing, not optimistic
   server acceptance. Add optimistic server behavior only with rollback/race
   tests and an actual UX need.
5. Await invalidation where the next screen requires refreshed data; otherwise
   refresh in background with stale/error indication. Never invalidate every
   query after every mutation.

The first workflow list/create slice becomes the **working reference pattern**:
`workflows.api.ts` handles the request; `workflows.queries.ts` supplies the same
list options to the loader and list component; `workflows.mutations.ts` handles
creation and invalidation; the form owns field feedback; the route owns
navigation. Its real tests demonstrate the convention. Link to those files when
implemented instead of maintaining a second, uncompiled sample app in this
document.

## 7. Validation and forms

Three different checks must stay distinct:

1. **Input feedback:** local form shape, required fields, bounded values, valid
   JSON text. Static forms reuse shared request schemas when applicable; local
   schemas add only UI needs such as confirmation text.
2. **Wire/graph structure:** shared public schemas before a request and at the
   response boundary. A structurally valid draft can still be unpublishable.
3. **Semantic authority:** backend graph validation, workspace permissions,
   catalog compatibility, connection access and publish/run admission. Frontend
   checks improve feedback but never replace these rules.

Static forms use one feature-local owner, on-blur feedback and submit
validation; after a failed submit revalidate corrected fields on change. Use
shadcn Field, FieldLabel/Description/Error and appropriate Base UI controls.
Link errors with `aria-describedby`, set `aria-invalid`, focus the first invalid
field and keep a form-level error for unknown paths. Map only known safe
contract paths into fields; do not mutate arbitrary object paths from a server
error.

For node inspectors, form scratch values can temporarily be invalid. Use an
explicit **Apply** action for the first editor: validated input becomes one
editor command/undo transaction; Cancel discards scratch values. Switching nodes
or navigating away with unapplied edits asks Apply/Discard/Stay. “Saved” must
not be shown while local form edits remain unapplied. Later auto-apply is a
separate interaction decision, not an effect copying every keystroke into three
stores.

Catalog config/input/output schemas arrive as **JSON Schema documents**, not
executable Zod schemas. Do not cast them to Zod or import server registrations.
First implementation supports an explicit tested field subset (primitive fields,
enums and bounded objects/arrays needed by selected nodes), with readable
unsupported-schema feedback and a deliberate advanced JSON editor where safe.
Never silently drop schema-valid fields that the UI does not model, erase an
unsupported node, resolve arbitrary remote schema references, execute
schema-provided code or claim full semantic validation. Use catalog definition
key/version/configVersion as renderer identity.

The initial renderer provides advisory required/type feedback and preserves
data; the backend validates the saved graph. A full browser JSON Schema
validator is **not required for the first slice**. If later necessary, select it
behind one feature-local adapter after testing the actual emitted schema
dialect, bounds, formats and CSP compatibility. Do not install Ajv plus
`unsafe-eval` merely to avoid defining that boundary. No universal form-builder
framework upfront.

Credential entry remains local and masked. Clear submitted secrets from form and
transient mutation state as soon as feasible; do not pass them to telemetry,
URL/search, general toasts or persistent stores. Query caches contain only safe
connection metadata. Re-entering a secret is preferable to retaining it for an
automatic retry. Do not reuse an old idempotency key with changed re-entered
values: an exact retry is the original command, while edited values require
resolving the previous outcome before issuing a new command.

## 8. Editor, IDs, saves, publish and run

### From selecting a node to saving

1. Query loads the saved draft **with its ETag** and the catalog release.
2. The editor initializes its store once from that baseline. Background data
   changes are not an instruction to reset the store.
3. The user selects an available catalog definition. An editor command assigns a
   fresh graph-instance ID using browser UUID generation accepted by the shared
   ID contract. The node records definition `{key, version}`, configVersion,
   configuration, mappings, connection references and position as required.
4. The graph adapter projects domain nodes/edges into React Flow. Gestures
   return domain commands; selection/measurement/viewport are not serialized.
   Node position is persisted. Deletion removes/repairs dependent graph
   references according to shared structural rules; it is one undoable command.
5. The save coordinator captures `{graph}` and the last acknowledged ETag,
   validates structure and sends `PUT .../draft` with `If-Match`.
6. The accepted response updates the acknowledged baseline/ETag. Edits made
   during the request remain dirty and are saved in the next serialized request.

ID distinctions: workflow ID identifies the saved workflow; node/edge IDs
identify instances inside its graph; definition key + version resolves node
behavior; configVersion identifies the configuration shape; connection IDs
reference workspace credentials; published version ID identifies immutable
runnable graph; run ID identifies one execution; node-run/invocation identity
distinguishes repeated loop/parallel executions of the same graph node. Never
substitute labels, array indexes or the old app's `nodeTypeTid`/`stepId` for
these identities.

The catalog does not yet provide a complete rich UI-metadata contract. Placement
must not pretend every config has valid defaults: use exposed schema defaults
where meaningful, otherwise prompt for required values and show incomplete
configuration. Unsupported definitions remain visible/preserved, with editing or
publish actions restricted as appropriate to backend compatibility.

### Save coordinator invariant

Use a small explicit state machine in the editor feature, not network calls
inside Zustand setters. State distinguishes clean, dirty, saving, conflict,
failed and uncertain outcome. It keeps the acknowledged graph/tag, current edit
generation and in-flight snapshot identity. No independent `isDirty` flags that
drift from graph/history/form state.

- One save in flight per editor. Initially debounce 800 ms after a completed
  edit transaction; coalesce drag updates into one history/save transaction on
  gesture end. Manual Save flushes and awaits acknowledgment. Test with fake
  clocks; tune debounce from interaction evidence, not throughout components.
- Undo/redo changes the working graph, not the last server ETag. Bound history
  (initially 100 coherent transactions) and profile representative large graphs;
  do not clone the entire graph on each pointer movement.
- Track which graph was acknowledged. If edits occur while saving, response A
  must not replace newer graph B or mark B saved. A background refetch may
  update a clean baseline only through the coordinator; never during a
  conflicting or uncertain save. Dirty editors get remote-change information,
  not replacement.
- ETags are opaque and can change with compatibility even when revision does
  not. Never construct one from the numeric revision or silently replace a stale
  tag and resubmit the same local graph.
- On 412, stop autosave, retain local edits, fetch the remote representation and
  offer explicit resolution. First release supports keep-local-for-comparison
  and explicit discard/reload. To continue local work, accept the remote as a
  new baseline and manually reapply chosen edits from the retained local
  comparison; those become new commands against its tag. Do not discard that
  comparison until the user dismisses it. Automated merge and force-overwrite
  are deferred. Do not offer a nonfunctional “overwrite” button.
- On lost/invalid response, treat write outcome as uncertain; reconcile via GET.
  If the server graph matches the attempted snapshot, adopt its acknowledged
  baseline/tag without losing later edits. Otherwise preserve both versions and
  require resolution. No blind write retry with a new precondition.
- Before a normal route/workspace switch, resolve dirty graph **and** unapplied
  form values. Use Router navigation blocking; beforeunload is only a browser
  warning, cannot guarantee a last-second async save, and is not crash recovery.
  [Navigation blocking](https://tanstack.com/router/latest/docs/guide/navigation-blocking).

These obligations implement
[ADR 011](../../docs/adr/011-optimistic-draft-concurrency.md), not a new
concurrency protocol. No CRDT, multiplayer, offline queue or generic
distributed-sync library in this plan.

### Validate, publish, preview and run

Validate and node-preview operations currently inspect the **server draft**.
Apply pending form changes and wait for the intended save before requesting a
report; associate it with the requested local generation/revision and mark it
stale if editing continues. Node preview supplies expectedRevision; whole-draft
validation cannot be presented as proof about unsaved local data.

Publish captures an acknowledged draft tag and a stable idempotency key. Retry
the exact original command after uncertainty; do not silently publish later
edits. Unresolved publish and run attempts belong to the authenticated editor
session rather than a conditionally rendered dialog, so a temporary identity
pause hides their UI without discarding their exact recovery data. Recovery
requires successful fresh verification of the opening user and an explicit
retry. If a command is accepted while verification is paused, retain that
receipt without replaying the command; opening an accepted run is a separate
explicit action after recovery. Actual user/workspace/workflow scope disposal
clears the attempts and retained receipts. The editor may keep editing, but must
show which graph/version was published and whether subsequent changes remain
unpublished. Restore-version first resolves dirty state, then conditionally
changes the draft only.

Run starts the workflow's currently published active version, resolved and
pinned atomically by the backend; the current start body accepts input/deadline,
not a draft or arbitrary version selector. Another publisher can change that
pointer between this tab's publish and run requests. Do not promise to run the
exact version displayed before submission; that guarantee needs an explicit
version selection/precondition contract. Show the actual workflowVersionId from
the accepted run response. Explicit replay has its own version/input contract.
Never represent “Save”, “Publish”, “Run”, “Test execute” or “Cancel run” as
interchangeable actions. Side-effecting preview must be clearly
labeled/confirmed; closing its panel is not execution cancellation.

## 9. Errors and recovery belong at the right level

`ApiError` distinguishes API problem, network failure, timeout and unexpected
protocol/response shape, with safe request ID/status where available. Keep
original diagnostic details internal and redacted. Do not render arbitrary raw
HTML/body, stack traces, credentials or provider response text.

The shared generic problem schema is strict. Specialized workflow revision and
lifecycle conflicts contain extra fields: select the appropriate full decoder
using the endpoint/known code, then validate. A generic-schema-first parse would
reject these useful conflicts. Unknown future codes or malformed shapes become a
safe protocol error; do not cast them into the closed union. Branch on code, not
translated title/detail text.

| Situation                                        | Owner and user behavior                                                      |
| ------------------------------------------------ | ---------------------------------------------------------------------------- |
| Invalid form input / recognized field errors     | Form: inline errors, retain values, focus correction                         |
| `auth.unauthenticated`                           | Auth lifecycle: freeze writes, recover login safely, prevent redirect storms |
| `connection.reauthorization_required` (also 401) | Connection feature: reconnect that credential; **do not log out the user**   |
| Permission denied / missing resource             | Route or feature: explicit forbidden/not-found state, no guessed data        |
| `workflow.revision_conflict` (412)               | Save coordinator: preserve local graph and resolve conflict                  |
| Lifecycle / idempotency conflict (409)           | Command-specific recovery; never a generic automatic retry                   |
| Preconditions missing (428)                      | Treat as client integration failure, not “try harder”                        |
| Semantic validation (422 or validation report)   | Feature: issue list with node/field navigation and stale-report tracking     |
| Rate limit / unavailable service                 | Local feedback, bounded Retry-After; no request storm                        |
| Background refetch failure                       | Keep last good data with stale/retry notice; do not blank the screen         |
| Foreground required-data failure                 | Route/section boundary with a working Query + Router retry                   |
| Canceled read                                    | Silent; it is usually navigation, not an error toast                         |
| Uncertain mutation outcome                       | Preserve intent; reconcile or retry the same keyed command as allowed        |
| Unexpected render failure                        | Nearest suitable error boundary; safe message and diagnostic correlation     |

One visible notification owner per failure. Critical save/auth/conflict problems
stay inline; a transient toast alone is inadequate. Do not toast every autosave
or stream reconnect. Use the Base UI/shadcn toast when actually needed rather
than adding a second toast system. Catch asynchronous handler failures
explicitly; React render boundaries do not catch every promise rejection.

## 10. Runs, SSE and artifact transfers

Keep the run snapshot in Query. The runs feature owns one fetch-stream lifecycle
per viewed run, with a reusable bounded SSE decoder in `lib/api` and domain
event validation in `runs`. Fetch streaming is the selected approach so explicit
`Last-Event-ID` headers, cancellation and HTTP problem handling are available.
Do not create a stream per node or a global event bus.

- Decode incremental UTF-8, partial frames, CRLF, comments and multi-line data;
  bound retained bytes and validate event ID/type/data agreement. Resume from
  the last **processed** sequence, not the last received chunk. Dedupe
  sequences.
- The current run snapshot has no event cursor. Initially use events to append
  bounded timeline entries and coalesce invalidation/refetch of the
  authoritative snapshot, **not** replay old events onto a possibly newer
  snapshot. Subscribe from cursor zero on first mount; reconnect from the
  in-memory cursor. Avoid claiming gap-free snapshot/event merging without a
  cursor-bearing contract.
- Backoff with jitter and a cap on reconnect delay/attempt burst; respect auth,
  forbidden and rate-limit responses. Show reconnecting/degraded state. On
  stream loss use bounded visible-view polling; stop redundant polling once
  healthy.
- Abort on route/workspace/session changes. Reconnect/refetch after visibility
  recovery. On terminal events obtain a final snapshot; do not reconnect forever
  after a verified terminal result. Disconnecting never cancels the server run.
- Bound timeline memory and virtualize when needed. Show truncation; a frontend
  buffer is not complete persisted execution history. Missing/invalid sequence
  means resync/refetch with explicit diagnostics, not silently accept
  corruption.
- A graph node can have several invocations. Do not key all run details only by
  graph node ID or show `outcome_unknown` as success/retryable by default.

For future artifacts, use a separate transfer adapter: API reserve → signed
storage upload → API finalize. Signed URLs are short-lived capabilities; use
`credentials: 'omit'`, no API CSRF/session headers, and exactly the allowed
signed method/header/body semantics. Never log or persist signed URLs. Browser
JavaScript cannot set `Content-Length`; let the browser derive it from exact
bytes and verify signature compatibility and storage CORS in a real upload test.
Do not blindly loop over forbidden headers.
[Browser-controlled headers](https://developer.mozilla.org/en-US/docs/Glossary/Forbidden_request_header).
Show reserve/upload/finalize failures separately; cancellation is not proof the
object or reservation disappeared. Artifact list UI is not assumed available.

## 11. Reusing the old design without importing the old app

Legacy reference: `/Users/vigan/Projects/work/dynamic-process-v3` (read-only).
The table uses paths relative to that checkout. The visual intent is a dark
technical workspace with charcoal layers, cyan/violet accents, directional glass
borders and restrained luminous states. Preserve this identity, not its Next.js
layout/auth/backend code. The first shared visual batch is now adapted: branded
button variants, recessed input/textarea, presentational fields, directional
glass composition and a container-sized CSS aurora border. See the
[implemented visual kit](README.md#shared-visual-kit) for usage and
verification. The table below remains the broader migration inventory. The
workspace shell, dialogs and functional canvas now exist; both the shell and
editor have their legacy-proportioned visual treatment. Remaining design work is
tied to future data-backed feature slices rather than a second editor pass.

| Piece / old source                                                                                             | Decision                            | New owner / adaptation                                                                                      |
| -------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Color/surface/status/typography tokens — `src/app/globals.css`                                                 | Reuse selectively                   | `styles/globals.css`; keep locally bundled Inter/Hanken Grotesk/JetBrains Mono                              |
| Translucent cyan button and variants — `src/components/ui/button-variants.ts`                                  | Adapt early                         | Existing `components/ui/button.tsx`; semantic tokens, focus and disabled states                             |
| Directional glass border and glows — `src/app/globals.css`                                                     | Adapt early                         | One token-based utility, not duplicated per panel                                                           |
| `src/components/patterns/glass-section.tsx`                                                                    | Reuse composition when repeated     | `components/patterns`; no forced wrapper around every screen                                                |
| Gradient/aurora ring — `src/components/patterns/aurora-loading-panel.tsx` plus CSS                             | Adapt for real active/loading state | Small decorative CSS component; static/reduced-motion fallback                                              |
| Recessed inputs/selects/badges — `src/components/ui/*`                                                         | Adapt as needed                     | Generate/review current Base UI primitives, then apply visual language                                      |
| Rail/header/mobile navigation — `src/components/layout/app-shell.tsx`                                          | Rebuild behavior, reuse geometry    | Workspace route shell; TanStack links and current session contract                                          |
| Ambient cyan/violet peripheral lighting — legacy globals                                                       | Adapt once in shell                 | Decorative, bounded, not repeated on every card                                                             |
| Node faces/ports/status/selection — `src/features/workflow-builder/components/canvas/workflow-canvas-node.tsx` | Extract visuals; integrate later    | Separate `workflow-editor/components/canvas` modules, Tailwind-first                                        |
| Luminous edges/transfer marker — sibling `workflow-canvas-edge.tsx`                                            | Adapt for run detail                | `workflow-runs/components/workflow-run-graph.tsx`; exact-version graph and real node-run state drive motion |
| Metric cards / data tables                                                                                     | Defer to actual data view           | Extract shared pattern only if repeated; no fake dashboard                                                  |
| 2D canvas loading wave                                                                                         | Adapt for queued execution          | `workflow-runs/components/workflow-run-loading-wave.tsx`; bounded to a queued run with no node invocation   |
| Orb Wave / Three / React Three Fiber                                                                           | Defer out of baseline               | Optional future lazy visual; not required for the unique design                                             |
| Upload/drop-zone motion                                                                                        | Defer to artifact slice             | Do not install motion/dropzone merely because old app uses them                                             |
| Old auth, API DTOs, stores, Next imports, executor assumptions                                                 | Reject                              | Reimplement against current contracts; no wholesale feature copying                                         |

### Required visual direction and layout migration

The user wants Pertexo to remain recognizably similar to the legacy application,
not merely use its colors. Preserve its layout proportions, surface hierarchy,
icon navigation, card treatment and editor geometry while substituting Pertexo's
branding, supported routes and real data. This is the design target for future
selected slices, not authorization to copy the old application or implement all
items now. Use `frontend-design` when adapting the visual identity and the
relevant composition/accessibility skills when implementing its components.

Old paths in this table are relative to the legacy checkout; destinations are
relative to `apps/web/src`. These are responsibility boundaries, not
instructions to scaffold empty folders or create a component for every small
markup fragment.

| Required piece / verified old source                                                                                             | Keep from the old design                                                                                                    | Pertexo owner and adaptation                                                                                                                                                                                                                                              | Delivery status / timing                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop shell and sidebar — `src/components/layout/app-shell.tsx`                                                                | Rail proportions, dark translucent surface, brand block, icon/label rhythm, active-item highlight and scrollable navigation | Evolve `features/workspaces/workspace-shell.tsx`; extract substantial sidebar/header/account responsibilities under `features/workspaces/components/`. Routes compose this feature, not a duplicate shell. Use TanStack links and route-derived active state.             | Adapted: 280px desktop rail, supported-route navigation and route-derived active state wrap every authenticated workspace page.                    |
| Account card — same shell source                                                                                                 | Compact avatar/initials card, name/email hierarchy and separated footer actions                                             | Workspace-owned account component using the current user/session and workspace selection actions. No hardcoded user, fake version label or dead support link.                                                                                                             | Adapted with current user, workspace role, workspace switching, logout state and bounded labels.                                                   |
| Mobile navigation — same shell source                                                                                            | Left drawer with the same navigation/account content and compact header                                                     | Reuse one navigation composition for desktop/mobile; use an accessible current primitive for focus trap, Escape and focus return. Only drawer-open state is local; route state is not duplicated. Close on completed navigation without bypassing dirty-state protection. | Adapted with the Base UI dialog primitive; focus trap, Escape, focus return, completed-navigation closing and reduced motion are browser-verified. |
| Header and content frame — same shell source and `src/app/globals.css`                                                           | Sticky translucent header, alignment, spacing, restrained peripheral cyan/violet light                                      | Workspace shell accepts explicit page-title/action composition where needed. Keep decorative light in one shell layer. No old header-event bus, pathname heuristics or global header-content store.                                                                       | Adapted with explicit route titles, page/editor frame variants and one bounded ambient-light layer.                                                |
| Focused editor layout — same shell source plus builder chrome                                                                    | Canvas-first space with its own command bar instead of dashboard-width constraints                                          | Explicit editor-route composition with back navigation and current editor commands. Preserve save/conflict/navigation safeguards; do not hide the sidebar for every workflow-prefixed URL. Settings/detail pages keep their intended layout.                              | Adapted with a compact catalog, expansive canvas, inspector dock and feature-owned command bar; existing editor behavior is preserved.             |
| Glass sections — `src/components/patterns/glass-section.tsx`                                                                     | Directional borders, layered surface, header/content spacing                                                                | Existing `components/patterns/glass-section.tsx` and shared tokens. Use for meaningful sections rather than wrapping every fragment in another card.                                                                                                                      | Adapted; reuse and align spacing.                                                                                                                  |
| Metric/summary card — `src/components/patterns/metric-card.tsx`; `src/features/workflows/components/workflows-summary-cards.tsx` | Label/value/detail hierarchy, optional icon, restrained accent border and optional status/trend treatment                   | Adapt a presentational metric card when a real overview summary needs it; feature owns its data/composition. Promote to `components/patterns/metric-card.tsx` when genuinely reused. No old metric names, decorative fake trends or client-computed full-history totals.  | Not adapted; deliver with approved overview data, not as dummy dashboard content.                                                                  |
| Lists, tables and pagination — `src/components/patterns/data-table.tsx`, `data-pagination.tsx`                                   | Header/row density, separators, hover/selection treatment and footer alignment                                              | Style existing `components/ui/table.tsx`; feature owns columns/actions. Adapt presentation only: current APIs use cursor pagination, so do not copy page-number/total-count assumptions.                                                                                  | Existing table primitive; cursor treatment verified in Workflows, Connections and Run history.                                                     |
| Confirmation and structured detail — `src/components/patterns/confirmation-dialog.tsx`, `json-viewer.tsx`                        | Dialog hierarchy, readable structured content and restrained action emphasis                                                | Use existing dialog primitives and feature-owned command/error handling. Adapt JSON presentation only when needed, with bounded data and redaction; no raw secret rendering.                                                                                              | Selectively adapt with relevant command/detail slice; no parallel dialog framework.                                                                |
| Connection card — `src/features/workflow-builder/components/inspector/connections/workflow-connection-card.tsx`                  | Compact provider/connection identity, status and action layout                                                              | `features/connections/components/` owns reusable connection presentation; editor consumes its deliberate public interface if shared. Only show supported auth/status/actions from Pertexo contracts.                                                                      | Management actions are adapted in the connection table; a separate editor card is unnecessary until connection detail/recovery needs it.           |
| Canvas node/ports/edges, palette, inspector and toolbar — detailed checklist below                                               | Legacy geometry, glass node faces, selected-state treatment, icon hierarchy, panel/dock layout and controls                 | Existing `workflow-editor` feature, split by meaningful visual responsibility; retain current graph adapter, IDs, catalog, state and commands. Execution motion remains in `workflow-runs` and reflects actual run state.                                                 | Adapted against the functional editor; fake metrics and editor-side execution motion remain intentionally absent.                                  |

Do not migrate old process/context-definition pages, queue-management cards or
process-runner cards merely because they look useful. Their domain assumptions
do not establish a Pertexo feature. File-drop effects wait for the relevant
artifact interaction; Three/React Three Fiber and decorative 3D remain deferred.

#### Navigation and delivery order

1. Adapt the shell, account card, mobile drawer and page frame around existing
   pages first. Use Workflows now; add Connections, Runs and Workspace settings
   as their real routes ship. Overview follows its data gate. Do not reproduce
   legacy destinations, hardcoded counters or inert navigation buttons.
2. Bring card/table/form treatment into each selected page slice using the same
   tokens and spacing. Styling a supported list does not require waiting for
   summary APIs; unsupported summary cards remain absent.
3. Perform the editor visual pass using the checklist below, preserving tested
   editing and execution behavior. Do not rebuild the editor state or backend
   integration to make the canvas resemble the old one.

#### Visual acceptance, not just component existence

- Capture the old reference and new implementation at comparable desktop/mobile
  sizes. Compare sidebar width and density, header/content alignment,
  typography, card borders/surfaces, selected navigation and canvas/panel
  proportions.
- Review actual page compositions, not just isolated components or token values.
  Record intentional differences for Pertexo routes/data; do not call the visual
  migration complete merely because both apps are dark and cyan.
- Verify long labels, loading/empty/error/denied states, narrow layouts,
  keyboard navigation, drawer focus return, contrast and reduced motion. Never
  introduce decorative status/progress that contradicts the backend.
- Keep Tailwind-first layout/styling, shared semantic tokens and small
  feature-owned modules. Reuse existing primitives; no copied stylesheet of
  legacy layout classes, duplicated server state or new animation dependency
  without need.

### Component extraction checklist — visual work, not a second editor

All unchecked items below are **planned, not delivered**. Extract only an
explicitly approved component batch. This checklist does not authorize building
an editor, demo route, fixture catalog, Zustand store, undo history, save/run
actions or API integration. Those belong to the feature slices in section 14;
where already implemented, preserve them and adapt their presentation in place.
Do not recreate the removed canvas preview.

Old paths below are relative to
`/Users/vigan/Projects/work/dynamic-process-v3/src/features/workflow-builder/components/`,
except the app shell's explicitly named source. New paths are relative to
`apps/web/src/`. Read each source and its dependencies before extraction; these
are visual references, not files to copy wholesale.

| Status | Piece                                | Old source                                                                                                                                                                                           | Planned destination                                                                                                                   | Keep                                                                       | Leave behind / defer                                                                                              |
| ------ | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [x]    | Node card                            | `canvas/workflow-canvas-node.tsx`                                                                                                                                                                    | `features/workflow-editor/components/canvas/workflow-node-card.tsx`                                                                   | Glass face, header/icon, ports area, selected/disabled appearance          | Old graph types, execution hooks, process-run controls, generated metric bars and implied readiness               |
| [x]    | Ports / handles                      | `canvas/workflow-port-handle.tsx`, `canvas/workflow-node-handles.tsx`                                                                                                                                | `features/workflow-editor/components/canvas/workflow-port-handle.tsx` and `workflow-node-handles.tsx`                                 | Handle appearance and readable labels                                      | Legacy port resolution and process-specific port behavior; current catalog/graph adapter comes later              |
| [x]    | Connection edge                      | `canvas/workflow-canvas-edge.tsx`                                                                                                                                                                    | `features/workflow-editor/components/canvas/workflow-edge.tsx`                                                                        | Path treatment and selected highlight                                      | Old execution store, transfer counts and moving execution marker until real run events exist                      |
| [x]    | Palette / categories / item          | `palette/workflow-node-palette.tsx`, `workflow-node-family-list.tsx`, `workflow-node-subtype-list.tsx`, `workflow-node-subtype-item.tsx`, `workflow-node-description-marquee.tsx` in the same folder | `features/workflow-editor/components/palette/` with separate `node-palette.tsx`, `node-category-list.tsx`, `node-palette-item.tsx`    | Layout, category/item presentation, description treatment                  | Hardcoded registry, old family/type IDs and add-node commands; scrolling text only if needed, with reduced motion |
| [x]    | Canvas controls / minimap appearance | Controls and `MiniMap` inside `canvas/workflow-canvas.tsx`                                                                                                                                           | `features/workflow-editor/components/canvas/canvas-controls.tsx`; style the existing React Flow minimap at its later composition site | Zoom/fit/lock control appearance and compact minimap treatment             | Whole canvas container, graph state and old handlers; do not create a minimap wrapper merely to hold classes      |
| [x]    | Selection toolbar                    | `canvas/workflow-canvas-selection-toolbar.tsx`                                                                                                                                                       | `features/workflow-editor/components/canvas/selection-toolbar.tsx`                                                                    | Selected-count and action layout                                           | Selection ownership, deletion commands and history logic                                                          |
| [x]    | Inspector panel                      | `inspector/workflow-inspector.tsx`, `workflow-inspector-dock.tsx`, `workflow-inspector-metadata.tsx` in the same folder                                                                              | Existing `components/workflow-inspector.tsx` form plus meaningful presentation sections under `components/inspector/`                 | Panel/dock geometry, sections and metadata presentation                    | Old configuration/mapping forms, validation, process selectors, credentials and API hooks                         |
| [x]    | Editor command bar                   | `chrome/workflow-builder-command-bar.tsx`, `chrome/workflow-name-field.tsx`                                                                                                                          | `features/workflow-editor/components/chrome/editor-command-bar.tsx`                                                                   | Composition slots for identity, actions and status; compact appearance     | Old save/run/dirty-state behavior; workflow name editing remains gated on a supported rename contract             |
| [x]    | Full app-shell visual adaptation     | Legacy `src/components/layout/app-shell.tsx`                                                                                                                                                         | Existing `features/workspaces/workspace-shell.tsx` with feature-owned components as detailed above                                    | Sidebar/header geometry, account card, mobile drawer and responsive layout | Next navigation, auth, old menu destinations and shell event wiring                                               |

Already adapted: branded button variants, input, textarea, field composition,
glass sections, typography/theme tokens, aurora border and the contract-backed
run execution map. Keep shared primitives in `components/ui` or
`components/patterns`; execution visuals remain owned by `workflow-runs`.

Deferred: change-history panels, run/output panels, specialized configuration
fields, file-drop motion and 3D effects. Their owning feature and real data
requirements must exist before choosing what to reuse. Never port old stores,
API hooks, graph DTOs, node registry, authentication or save/run logic as part
of visual extraction.

### Organization and extraction acceptance

- Keep each substantial visual responsibility in its own named file under the
  feature folders above. Do not define the node, edge, palette, inspector and
  toolbar inside one large `workflow-editor.tsx`; that file will compose them
  when editor implementation is explicitly approved.
- These folders are a destination map, not scaffolding to create now. Add only
  files for the approved pieces. Tiny private markup helpers may stay with their
  owner; no one-file-per-fragment rule or generic component framework.
- Give visual modules small explicit props/callbacks and children where useful.
  Do not invent domain types or import backend code to make extraction compile.
  Use current accessible primitives for tabs/dialogs when actually needed.
- Check each approved piece's relevant visual, keyboard, disabled/selected and
  reduced-motion states in focused tests. A component test fixture is not a
  production registry or permission to add a runnable editor demo.
- Mark a checklist item complete only after that visual piece is adapted and
  checked. Completion does not mean its eventual feature behavior is connected.

### Visual coding rules

- **Tailwind-first:** use utility classes with the existing semantic tokens for
  layout, spacing, typography, colors, borders, radii, focus and responsive
  states. Use CVA for deliberate variants and `cn` for class composition. Do not
  translate those utilities into a parallel feature CSS stylesheet.
- Keep shared theme tokens and genuinely shared effects in the existing global
  stylesheet. Custom CSS is an exception for necessary keyframes, complex
  masks/effects or third-party selectors that cannot reasonably be handled with
  utilities. Keep each exception small and scoped, and explain its purpose. A
  feature CSS file is not a default deliverable; if an actual exception needs
  one later, load it only with the owning feature. The vendor React Flow
  stylesheet is separate from hand-written application styling.

- Extend a small semantic vocabulary: surface tiers, text levels, border levels,
  focus, selected/active state, success/warning/error, glass/glow and motion
  duration. Reuse Tailwind spacing/radius scales; do not copy hundreds of
  aliases.
- Separate visual accent from semantic status. Cyan glow is not by itself
  “success”. Maintain text/icon labels and contrast on actual translucent
  layers.
- Use CVA for deliberate component variants, `cn` for composition, children and
  slots for layout. Avoid boolean combinations such as `isGlass/isGlow/isSmall`.
  A pending button composes a spinner/label and disabled behavior.
- Links stay links, styled with `buttonVariants`; controls stay buttons. Use
  current Base UI composition APIs, not copied Radix `asChild` recipes. Dialogs
  and sheets have accessible titles, focus return and escape behavior.
- First style pass proves button, input, select, dialog/sheet, badge and panel
  states needed by the first real slice. Do not generate the full shadcn
  catalog, create a permanent demo dashboard or add Storybook just for
  extraction.
- All decorative layers are non-interactive and hidden from assistive
  technology. Reduced motion removes continuous rotation/travel/pulsing. Prefer
  short opacity/transform transitions; no generic `transition-all` on complex
  nodes.
- The legacy aurora uses huge `150vmax` layers and blur: preserve the
  appearance, not that unmeasured cost. Bound effects to their container;
  provide static border and opaque glass fallbacks. No animated glow on every
  canvas node.
- Inspect intended states at desktop/narrow widths, keyboard-only and reduced
  motion; compare with old design screenshots. Keep readable prose
  sentence-case, technical mono/uppercase for metadata, and visible non-glow
  focus indicators.

## 12. Other web concerns we must not leave implicit

**Accessibility:** preserve skip link/landmarks, page titles and navigation
focus; labels and described errors; keyboard menus/dialogs; non-color statuses;
announced save state without announcing every pointer move. Provide keyboard
node placement and connection alternatives, not drag-only essential actions.
Protect text input from canvas shortcuts and handle delete/undo intentionally.

**Performance:** lazy-load editor and feature CSS; keep canvas dependencies out
of workflow-list entry code. Use stable node/edge component registrations and
narrow store subscriptions, not subscriptions to the entire graph in each
toolbar. Profile before adding generalized memoization, layout engines or worker
threads. React Flow specifically warns about broad node subscriptions and
expensive styles; its
[performance guidance](https://reactflow.dev/learn/advanced-use/performance)
supports these targeted choices. Measure a representative 100-node edit/run view
and a fixture near the backend's admitted graph limit before calling editor
performance complete. Record build chunk sizes and interaction measurements in
the slice's test evidence; no unsupported “handles huge graphs” claims.

**Security/privacy:** `VITE_*` is public configuration, never secrets. No
backend keys, provider credentials, eval, raw HTML or arbitrary execution in the
browser. Validate external link schemes; previews are inert text unless safely
rendered. Do not place graph contents/credentials in telemetry, session replay,
analytics, console or persistent caches. Review clipboard/export actions before
exposing sensitive configuration. Destructive actions require explicit
confirmation.

**Observability:** use safe code/status/request ID and feature operation name
for support. Distinguish user cancellation, expected validation, conflicts and
genuine faults. Do not add a frontend telemetry vendor or send data externally
in this plan. A later adapter can export sanitized diagnostics to an approved
destination.

**Deployment:** configure production SPA deep-link fallback separately from
`/v1` and static assets, HTTPS/cookie policy, CSP compatible with chosen UI
libraries, security headers, and immutable hashed-asset caching with revalidated
HTML. Exercise a fresh deployment with an old tab: a lazy-chunk load failure
offers a controlled reload and protects dirty state; do not auto-reload an
unsaved editor. Same-origin proxy must support SSE without buffering and
sensible timeouts.

**Responsive support:** navigation, lists, forms and run detail must work on
narrow screens. Editor starts desktop-first with an explicit small-screen
interaction fallback. The delivered fallback keeps palette, canvas and inspector
mounted behind keyboard-reachable panel controls so scratch edits and navigation
guards survive panel changes; mocked Chromium verifies the 390-pixel interaction
and useful canvas dimensions. Do not claim general mobile authoring until touch
alternatives and Firefox/WebKit are tested. Use the project's actual browser
support target, not only local Chrome; add Firefox/WebKit coverage for auth,
layout and CSS masks before broad release.

## 13. Tests and mechanical enforcement

No architecture is uniform just because a document says so. Enforce boundaries
in the same slice that introduces them:

- Extend web ESLint's existing Node/backend import bans with reviewed public
  package allowlists, feature direction/private-import rules and restricted raw
  fetch locations. Test representative allowed/forbidden imports including alias
  and relative paths; do not merely add a comment to AGENTS.
- The existing module-cycle script does not fully model web TSX/`@/` resolution.
  Extend and test it (or the existing architecture checker) before claiming the
  new frontend dependency graph is mechanically checked. The current complexity
  scanner also selects `.ts`, not `.tsx`; add tested TSX coverage before calling
  that a frontend gate. Keep root strict TS, complexity, duplication and
  dependency checks intact. Add `apps/web` Markdown to documentation link
  checking when extending those gates; the current docs command scans root
  README/docs, not every workspace guide.
- Fresh QueryClient/router/editor store for each unit/component test. Test
  through public behavior, not setter call counts or giant snapshots.
- Add MSW when network integration begins so real transport/decoders participate
  in component tests. Fixtures satisfy public schemas; malformed fixtures are
  explicit negative cases. Mocking HTTP does not prove production auth/CORS/SSE.
  [MSW's network-level approach](https://mswjs.io/docs/).
- Keep the authenticated Playwright lane in CI. Stage 2 drives the production
  browser, transport and decoders against a controlled HTTP boundary, while the
  API/database suites prove the real callback and workspace-discovery stack.
  Before deployment, add a live-backend journey with isolated test
  users/workspaces and a controlled OIDC provider fixture; do not put test
  bypasses into production auth.

### Required regression scenarios, introduced with their slice

| Boundary            | Proof                                                                                                                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transport           | Valid success/204, malformed JSON/schema, common and extended problems, missing ETag, abort/timeout, safe fallback, CSRF and credential handling                                       |
| Session/scope       | OIDC return, login/logout, expired session, two identities/workspaces, late response after logout, connection 401 does not log out user                                                |
| Queries/routes      | Loader/component share request/key, cursor filters, back/forward/deep link, empty/forbidden/not-found/stale/error and working retry                                                    |
| Forms               | Required/transformed input, field/path errors, unapplied edits, keyboard/focus, secret values absent from caches/logs                                                                  |
| Graph adapter       | Round-trip schema-valid fields and unsupported definitions without data loss, stable IDs, no canvas-only fields, structural invalidity rejected                                        |
| Save/history        | Coalesced drag, undo/redo, debounce/manual save, edit during in-flight save, 412 without data loss, equal revision/different ETag, lost acknowledgment, navigation guard               |
| Publish/preview/run | Save barrier, stale validation report, exact-key replay, publish while newer edits exist, immutable version identity, preview side-effect warning                                      |
| SSE                 | Split UTF-8/chunks, comments/CRLF, duplicates/gaps, invalid/big event, resume cursor, reconnect/fallback, terminal stop, cleanup on scope change, snapshot never regresses from replay |
| Visual              | Focus/disabled/error/loading states, reduced motion, narrow layout, contrast on glass, bounded node/edge animation                                                                     |
| Deployment          | Real callback/proxy/cookies, deep-link reload, SSE no buffering, lazy-load failure, signed storage CORS/upload when introduced                                                         |

Browser golden path: sign in → choose workspace → create workflow →
add/configure and connect supported nodes → save → reload same graph →
validate/publish → start run → display the version ID accepted by the run
response → observe completion → sign out without state leakage. Also test a
two-tab editing conflict; a happy-path video alone is not enough.

## 14. Delivery sequence and acceptance gates

Stages 1–6 are complete in the working tree. Implement one bounded slice, verify
it, then move on. No requirement to build every future feature before shipping
value. Commit only when separately authorized under root Git instructions.

| Order | Status   | Work / owner                                                                            | Dependencies                                                                             | Acceptance gate                                                                                                                                       |
| ----- | -------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Complete | Browser contract seam + transport, `contracts` and web `lib/api`                        | Existing public schemas                                                                  | Real consumer bundle proof; no forbidden/runtime projection imports; transport regression tests; explicit allowed imports                             |
| 2     | Complete | Authentication + workspace entry + smallest visual kit, API/auth/web                    | Same-origin proxy config, fixed callback return, workspace discovery/permission contract | Real-browser login/select/logout/deep-link; isolation/late-response tests; brand button/panel/shell states; required browser CI lane                  |
| 3     | Complete | Workflow list/create + catalog and connection discovery                                 | Workspace scope; connection list/read contract before picker                             | Real data, pagination/empty/errors; stable create key; no invented endpoints or copied DTOs                                                           |
| 4     | Complete | First editor: selected supported nodes, apply form, connect, undo, save/reload/conflict | Reviewed graph contract + catalog + connection references                                | Adapter and save-state tests; two-tab conflict; no data loss during in-flight save; dirty/unapplied navigation protection; representative performance |
| 5     | Complete | Validate/publish/preview and run detail + SSE                                           | Stable saved graph and existing execution contracts                                      | Exact-version/intent behavior, bounded event handling, final-state refresh, degraded recovery; full browser golden path                               |
| 6     | Complete | Further workflow operations/settings and richer visual polish                           | Actual feature demand and missing discovery contracts                                    | Add schedules/webhooks/lifecycle/notifications/artifacts independently with protocol/UI tests; signed-upload browser proof before uploads             |

### Stage 1 evidence

- Schema-only exports are declared by `packages/contracts/package.json`, retain
  existing package exports and pass the contracts package boundary/dependency
  tests. Built consumer checks cover `schemas/catalog` and `schemas/errors`.
- `src/lib/api/client.ts`, `api-error.ts` and `csrf.ts` implement the shared
  transport without feature knowledge or a production singleton. Tests cover
  JSON and 204 success, malformed media/JSON/schema, common and extended
  problems, required response metadata, safe request IDs, bounded Retry-After,
  fresh CSRF/cookies, same-origin paths, network failure, timeout and explicit
  cancellation.
- The architecture checker now includes `.tsx`, resolves web `@/` aliases,
  checks runtime cycles and cross-workspace traversal, permits only reviewed
  workspace imports and confines raw browser fetch to the transport adapter.
- Verified in the stage working tree with contracts build/tests, web
  build/typecheck/lint/tests, architecture and built-export checks. The Vite
  consumer build bundles the selected schema-only paths without Node polyfills;
  the ordinary production build passes, and stage 1 adds no endpoint call or
  product screen.

### Stage 2 prerequisite evidence

- Successful `GET /v1/auth/oidc/callback` responses now issue the existing
  session/CSRF cookies and return `303` with a configured, validated relative
  landing path. Query input cannot select the redirect target.
- Authenticated `GET /v1/workspaces` returns a bounded UUID-keyset page of only
  the current actor's active memberships, including workspace lifecycle status,
  role and capabilities derived from the backend-owned role policy. Migration
  `0090_workspace_discovery_policy.sql` adds the actor-scoped RLS read without
  relaxing ordinary workspace-scoped access.
- Vite proxies the unchanged `/v1` path to a server-only configured origin. The
  production Nginx template keeps `/v1` outside SPA fallback, preserves proxy
  headers, and disables buffering/cache for SSE. External web-runtime and load
  balancer wiring remain deployment-owned.
- Focused contract, controller/use-case, config, database integration, real API
  callback/discovery, browser bundle and proxy-configuration tests provide the
  prerequisite evidence.

### Stage 2 evidence

- `features/auth` owns OIDC start, the current-user query, provider navigation,
  error recovery and confirmed logout. Logout cancels scoped reads and clears
  Query caches only after the server confirms revocation or reports an already
  unauthenticated session. A loader-free `/logout` route completes the command
  only after the editor's existing navigation blocker permits the transition, so
  confirmation does not depend on current-user or workspace discovery.
- `features/workspaces` validates every discovery page with the shared schema,
  scopes its query key by user ID, detects invalid cursor cycles and renders
  active, unavailable, empty and failure states. Workspace choice is URL-owned;
  protected deep links remain on the requested URL when membership is absent.
- The first product route replaced the temporary foundation preview. The login,
  workspace selector and minimal shell adapt Dynamic Processing V3's visual
  language without its password form, Next.js runtime or backend assumptions.
- MSW component tests exercise the real shared transport and response decoders.
  Chromium covers login, selection, logout, authorized/inaccessible deep links,
  keyboard focus, reduced motion and narrow layout. CI owns the browser lane.

### Stage 3 evidence

- Browser-safe `schemas/workflow-authoring` and `schemas/connections` exports
  expose the existing runtime validators without importing backend projections
  or duplicating response types. The connection contract now includes bounded
  list query/response and read operations; generated OpenAPI and client-schema
  artifacts pass the contract and browser-consumer checks.
- The API and database expose actor-authorized `connection:read` list/read
  seams. Reads recheck authority inside the workspace transaction, select only
  safe metadata, use deterministic status/creation/id keyset pagination, hide
  cross-workspace records and map malformed opaque cursors to the public request
  error contract. Unit, real Nest HTTP-stack and PostgreSQL integration tests
  cover the boundary.
- `features/workflows` owns validated list/create calls, user/workspace query
  keys, cursor paging and feature-local recovery messages. A logical create
  attempt retains one idempotency key across uncertain retries, captures the
  returned draft ETag and invalidates only the matching workflow list after a
  confirmed response.
- The workspace route renders the real workflow index with loading, empty,
  initial/next-page failure recovery, capability-aware create actions and
  lifecycle metadata. Catalog and connection discovery run concurrently under
  their owning feature queries and degrade independently from the workflow list;
  no editor or fake open action was introduced.
- Component tests cover paging, transformed validation, read-only empty state,
  CSRF and stable-key retry. Chromium covers the authenticated index and create
  flow. Contracts, database, API and web builds/typechecks/tests, architecture,
  built exports, dependency analysis and React Doctor pass; the focused
  connection PostgreSQL integration suite passes.

### Stage 4 evidence

- `/w/$workspaceId/workflows/$workflowId` preloads the validated draft, catalog
  and safe connection metadata, then lazy-loads the editor/React Flow
  implementation. The production build keeps React Flow in the deferred editor
  chunk rather than the workflow-index startup chunk.
- One route-scoped vanilla Zustand store owns the unsaved domain graph,
  selection and a 100-transaction undo/redo history. The pure graph adapter
  projects domain nodes/edges to React Flow without writing selection or
  viewport state into the contract; unsupported definitions remain visible and
  retain their full configuration.
- The inspector renders the supported primitive/enum JSON Schema subset,
  preserves advanced JSON, stages label/configuration/connection-slot changes
  until Apply, filters connection references by required auth type and provides
  a keyboard-operable connection alternative. Dirty in-page node selection and
  undo/redo requests explicitly offer Apply, Discard or Stay; accepted graph
  history remounts the form from the selected persisted node without silently
  replacing unapplied scratch values. Read-only members cannot place, move,
  connect, configure or delete nodes.
- The save coordinator debounces for 800 ms, permits one conditional save in
  flight, queues edits made during that save and preserves opaque ETags. Its
  effect-owned lifecycle survives React StrictMode replay, while destroyed
  coordinators ignore late results and stop recursive flushes. A 412 stops
  autosave and retains both graphs; continuing accepts the remote graph and ETag
  as the baseline, retains the stale local graph only for comparison and
  requires chosen edits to be reapplied manually. Lost acknowledgements
  reconcile with GET before choosing a clean or conflict state. Router and
  `beforeunload` protection cover unsaved graph, unapplied inspector state and
  an undismissed retained comparison.
- Fifty-seven web unit/component tests cover graph preservation, bounded
  history, serialized saves, StrictMode save lifecycle, uncertain
  reconciliation, conflict recovery and real transport autosave. Eleven Chromium
  journeys include save/reload, two-tab 412 recovery, in-page and route-level
  staged-form protection, keyboard placement and a mocked-boundary Chromium
  check at a 390-pixel viewport. Measured graph projection was 0.140 ms for 100
  nodes/400 edges and 0.251 ms at the 1,000-node/4,000-edge contract limit on
  the local verification host. Web build/typecheck/lint pass; the full React
  Doctor scan is triaged as a diagnostic rather than treated as a numerical
  delivery gate.

### Stage 5 evidence

- Editor commands cross the save barrier before validation, node preview,
  publish or run start. Validation is associated with the acknowledged draft
  generation/revision and becomes visibly stale after another edit; publish
  requires that exact valid snapshot, sends its opaque ETag and retains one
  idempotency key for an uncertain retry. Backend validation findings remain
  visible with their messages, codes and paths; resolvable node/config paths use
  the editor's existing guarded selection flow to focus the relevant field.
  Validation/publishing and run submission have separate mutation owners; the
  run dialog owns its input and deadline scratch state.
- Node preview has distinct read-only validation and test-execution intents.
  Test execution requires an explicit side-effect acknowledgement, the saved
  draft revision and a stable command key; bounded polling follows accepted
  previews to a terminal result and is aborted when its owner unmounts.
- `/w/$workspaceId/runs/$runId` loads an authoritative run snapshot and shows
  the workflow version returned by run acceptance. It also resolves that exact
  immutable version through the bounded paginated versions contract and renders
  its read-only execution map. Active aggregate node state drives luminous
  incoming edges and transfer markers; multiple invocations remain distinct in
  the detail list and are explicitly counted on the graph. Cancellation is a
  distinct capability-gated command.
- The shared transport now owns same-origin byte streams and validates SSE media
  responses. Its decoder handles incremental UTF-8, CRLF/comments/multiline data
  and bounded partial frames. The run controller validates ID/type/data
  agreement, deduplicates replay, rejects gaps, bounds the timeline to 200,
  coalesces snapshot refreshes, reconnects transient failures with bounded
  jitter, honors bounded rate-limit retry delays and stops with truthful states
  for authentication, authorization and unavailable-resource responses. It polls
  snapshots in degraded mode, performs a final terminal refresh and then stops.
- The web unit/component suite covers the stream boundary, decoder limits, event
  protocol and a save/validate/publish/start route journey. Six focused Chromium
  editor journeys pass, including the full stage path from graph edit through
  acknowledged node execution, exact-ETag publish, accepted run version and
  terminal SSE shutdown.

### Stage 6 evidence

- `/w/$workspaceId/workflows/$workflowId/settings` is a lazy route whose
  lifecycle, versions, schedules, webhooks and notification-destination reads
  fail and recover independently. It does not reuse the editor store or risk an
  unsaved graph; the editor's existing dirty-navigation guard owns that exit.
- Lifecycle commands use the workflow revision found through a bounded scan of
  the existing paginated list and retain a stable idempotency key. Version
  restore captures the selected immutable graph and draft ETag as one
  conditional attempt. After an uncertain response or `412`, it first reconciles
  the current graph; it retries only the original precondition when still safe
  and requires explicit confirmation before replacing a newer draft. The
  endpoint has no idempotency key and the UI does not describe its retry as
  idempotent.
- Schedule enable/disable and webhook provision/rotation use only published
  trigger discovery and existing command routes. Newly issued webhook endpoint
  keys and signing secrets appear in a one-time response dialog that is cleared
  when acknowledged and never persisted in browser storage. Secret-producing
  webhook commands are serialized through that acknowledgement, and the result
  identifies its trigger so another response cannot replace it. An uncertain
  webhook attempt remains independently reachable after refreshed trigger status
  changes: its exact command and idempotency key are retried before any
  conflicting operation is enabled. A replay receipt resolves the uncertainty
  without re-exposing one-time credentials; deliberate rotation is then the path
  to newly issued credentials.
- Failure-notification destinations can be listed, enabled/disabled and chosen
  for set/clear policy commands. A workspace settings route now creates Slack or
  email destinations from existing safe connection references and appends
  concurrency-checked configuration versions. Credentials never enter the
  destination forms or Query cache. Because no policy-read contract exists, the
  workflow UI reports only confirmed commands and does not invent a current
  selection.
- Artifact references from node preview can read safe metadata and prepare an
  expiring download link through the existing same-origin API. Upload UI is
  intentionally absent: the required browser signed-length, CORS, checksum and
  finalize proof does not exist, so the upload gate remains closed.
- Fifty-seven web unit/component tests and 70 contract tests pass. Settings
  tests cover lifecycle revision/idempotency, schedule commands, serialized
  one-time webhook secrets, notification policy, fresh-ETag version restore and
  artifact download preparation. The production build and all nine Chromium
  journeys pass; architecture, built exports, dependency and formatting checks
  pass. React Doctor reports 100/100 and its focused design scan reports no
  findings.

### Run-history slice evidence

- `GET /v1/workspaces/:workspaceId/runs` is a strict, `run:read`-authorized list
  contract. It returns safe run summaries only, uses bounded descending
  `(createdAt, id)` keyset pagination and binds each opaque cursor to its
  workspace, normalized filters and ordering.
- Database pagination carries PostgreSQL's six-digit timestamp text alongside
  the display record instead of round-tripping cursor positions through
  JavaScript `Date`. Migration 0092 adds the workspace/order and
  workspace/workflow/order indexes used by the supported access paths.
- `/w/$workspaceId/runs` owns applied workflow, status and inclusive-start /
  exclusive-end UTC filters in route search. Query owns pages and cancellation;
  the feature owns filter scratch, safe table presentation, capability, empty,
  failure and next-page states. Sidebar and mobile navigation expose the route
  only with `run:read`.
- Contract, API and component regressions cover bounds, authorization,
  filter-bound cursor retry, strict queries, pagination and denied/error states.
  A disposable PostgreSQL regression proves duplicate-free pagination for
  same-status records within one millisecond and workspace isolation. The
  Chromium history journey covers filtering, pagination and navigation into the
  existing exact run detail.
- Current verification: contracts 71/71, API 1,294/1,294, database unit 760/760,
  disposable database integration 530/530, web unit/component 85/85 and Chromium
  15/15. Web build/typecheck/lint, contract artifacts, database schema
  ownership, module boundaries, built exports, formatting and the changed-scope
  React Doctor scan also pass.

### Post-baseline frontend slice evidence

- Connections now cover Slack creation, provider testing, exact-precondition
  secret rotation and generic revocation without exposing stored credentials.
  Run detail exposes an explicit replay dialog that submits the displayed
  immutable version and deliberate input under ADR 031.
- The editor shell, palette, canvas nodes, ports, edges, selection toolbar,
  inspector and command bar adapt the actual Dynamic Processing V3 proportions
  and visual hierarchy while preserving Pertexo's route-scoped graph and save
  behavior. The panel fallback remains active through compact desktop widths,
  the canvas owns its selection toolbar positioning, and permission-aware
  geometry is exercised at 390, 1024, 1280 and 1440 pixels. No legacy stores,
  fake counters or execution event bus were copied.
- Notification-destination resource ownership now lives in
  `features/failure-notifications`. The lazy workspace route supports list,
  create, configuration-version append and status changes using safe connection
  references, while workflow settings reuses its public query/status seam for
  policy selection.
- Current web verification: production build/typecheck and zero-warning lint
  pass; 22 unit/component files with 163 tests and 24 mocked-boundary Chromium
  journeys pass. The editor journeys cover dirty-editor logout ordering, the
  explicit narrow/compact-screen panel fallback, permission-aware read-only
  geometry and canvas-local toolbar bounds. Component coverage also exercises
  exact workflow lifecycle retries, reachable deletion recovery, recoverable
  cached-list refresh failures, nondisclosing connection/run unavailability and
  URL-owned filter clearing. Loader-free logout coverage includes StrictMode,
  failed-command retry and cache preservation until server confirmation. The
  inspector's numeric controls and advanced JSON editor now transfer ownership
  only on explicit input changes, preserving incomplete numeric scratch while
  allowing JSON edits, additions and removals to win without stale overlays.
  Invalid advanced JSON is also retained while ordinary fields keep explicit
  scratch ownership until the JSON is repaired or changes that same field.
  Editor writes and every publish/run dispatch, including an exact uncertain
  retry, revalidate the opening user; they freeze when identity changes or
  cannot be verified, and active draft transport is aborted on scope disposal.
  The preflight cannot atomically bind browser identity to the following server
  write, so backend authorization remains authoritative. Settings command keys
  belong to one unresolved resource attempt: exact uncertain retries reuse the
  key, observed completion releases it, and conflicting operations cannot reuse
  an earlier receipt. Authoritative unavailable settings refreshes remove cached
  rows/actions while transient failures keep stale data with Retry. Slack
  create/rotation and workspace deletion forms validate on initial blur,
  revalidate corrections after a failed submit, focus and describe
  field-specific errors, and do not mark fields invalid for server failures.
  Static deployment verification parses the effective SPA and asset location
  blocks so their cache and security headers coexist despite Nginx `add_header`
  inheritance. Validation presents both structural and catalog-compatibility
  findings with guarded node navigation. Degraded run-event snapshot recovery
  retains bounded server-directed `Retry-After` delays and cancels them on scope
  disposal. Firefox/WebKit and the live-backend/OIDC browser journey remain
  outstanding. Architecture and built-export gates pass. Contract
  build/typecheck and 71 contract tests pass; generated artifacts are current
  and the connections OpenAPI now declares its existing nondisclosing list
  `404`. The latest full React Doctor scan (including untracked files) reports
  zero errors and 51 warnings; warnings are triage input, not proof of a defect
  or correctness. The score is not used as a completion gate. These counts
  describe the current uncommitted working tree, not the historical
  stage-specific counts above.

Order 2's visual kit includes the old colors/type/glass/button language, not
every legacy component. Aurora and canvas details land where their real states
exist. Keep order 4 small but structurally honest: the renderer must preserve
unsupported nodes and report limits. Expand supported node families with focused
fixtures, not a fake all-node form renderer.

### Decisions requiring evidence, not repeated whole-app review

- **Contract package seam (order 1):** demonstrate tree-shaking or add
  schema-only exports without breaking existing artifact/backend consumers.
- **Login/deployment/discovery (order 2):** specify and test callback return,
  same-origin proxy and accessible-workspace/permission response. Current API
  behavior cannot be hand-waved away by a frontend guard.
- **Node field coverage (order 4):** enumerate supported definition/config
  shapes from the actual catalog; keep a tested fallback. Full JSON Schema
  engine, expression-language editor and rich catalog UI metadata are later
  additions only if the selected nodes require them.
- **Signed upload (order 6):** prove browser-generated length, CORS, checksum
  and finalize semantics. A server-side upload test is not browser proof.

Everything else above is the default direction. Reopen a decision only for a
concrete contract mismatch, failed acceptance test, measured cost or new product
requirement—not another generic “best practices” sweep.

## 15. Definition of done for each feature

Before handing off a slice, confirm:

1. Its API contract exists, input/response/error types are not duplicated, and
   authorization/CSRF/idempotency/concurrency rules are correct for each method.
2. Each state has one owner, scope/lifecycle cleanup is explicit, and no refetch
   or late response silently destroys user edits or crosses identities.
3. Loading, empty, forbidden, missing, invalid, stale and failed states are
   designed—not only the happy path. Recovery actions genuinely work.
4. Components follow the existing visual tokens and accessible interaction
   rules; no legacy backend assumptions or unused component-library bulk is
   imported.
5. Relevant model/transport/component/browser tests pass, along with build,
   typecheck, lint and boundary checks. Run wider root gates for shared-contract
   or architecture-tooling changes. Check the rendered result for visual work.
6. Remove the temporary foundation page when the first product route replaces
   it. Update README's actual capabilities and this plan's relevant
   status/evidence; do not mark later stages complete or create separate
   progress/audit documents.

This plan settles recurring conventions and expensive boundaries early. It does
not guarantee bug-free implementation; small slice-level checks and real-browser
evidence remain necessary. They should validate these decisions, not restart the
architecture discussion every time a feature is added.

## 16. Function placement and component composition

### Where does a new function go?

Choose by responsibility and consumers, not merely because it is a function. All
paths below are relative to `apps/web/src` and are planned examples unless they
already exist.

| Function or reusable behavior              | Location                                                   | Example / constraint                                                                                       |
| ------------------------------------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Tiny helper used by one component          | Same component file, private                               | Format a component-specific caption; extract when it obscures rendering                                    |
| Pure workflow/run logic                    | Owning `features/<feature>/model/` or a named feature file | `run-status.ts`, `editor-history.ts`; no React, fetch, toast or navigation                                 |
| Wire-to-view or graph-to-canvas conversion | Named feature adapter                                      | `graph-adapter.ts`; preserve shared contract data and test round trips                                     |
| Outgoing HTTP operation                    | `features/<feature>/<feature>.api.ts`                      | Encode path/body, choose decoder and required headers                                                      |
| Query keys/options                         | `features/<feature>/<feature>.queries.ts`                  | One definition shared by loaders and consuming hooks                                                       |
| Command hook with cache effects            | `features/<feature>/<feature>.mutations.ts`                | `useCreateWorkflow`; delegate actual transport to API function                                             |
| Stateful UI behavior used within a feature | Named feature-local `use-*.ts` file                        | `use-run-events.ts`; explicit dependencies and cleanup                                                     |
| Editor state transition                    | Editor model/store command                                 | `addNode`, `applyNodeConfig`; not a component-specific setter exported everywhere                          |
| Auth-wide cleanup / app lifecycle          | `app/` orchestration                                       | Dispose scopes and dependencies; feature code never imports upward                                         |
| Generic HTTP/CSRF/problem decoding         | `lib/api/`                                                 | No feature imports or visual feedback                                                                      |
| Truly shared pure formatting               | Named `lib/format-*.ts` module                             | `format-duration.ts`; explicit units/locale and missing-value handling                                     |
| Shared browser subscription hook           | Named `lib/use-*.ts`, only after real reuse                | Browser behavior without business meaning; SSR assumptions are irrelevant here but cleanup/testing are not |
| Shared visual composition                  | `components/patterns/`                                     | Repeated panel/error presentation, data passed by props                                                    |
| Primitive control                          | `components/ui/`                                           | Button/field/dialog; no domain branching                                                                   |
| Cross-app domain definition                | Existing appropriate public workspace package              | Shared contract/graph type, not a browser helper moved into contracts                                      |

Keep existing `lib/utils.ts` for `cn`; it is not the destination for every
function. Do not create `helpers.ts`, `common.ts`, `functions.ts`, `use-app.ts`
or a giant `types.ts` to avoid choosing an owner. A feature-owned formatter
stays with that feature even if several of its components use it.

Extraction test: can the function be named precisely, does it hide meaningful
behavior, and do actual callers share the same contract? If so, extract at the
narrowest common owner. Two similar-looking functions with different business
rules need not become one flag-driven generic helper. Do not move React helpers
into backend/shared contracts to manufacture reuse. Check existing public
functions first; extend an existing module when the responsibility truly
matches.

### Functions, hooks and effects

- Prefer pure transformations with explicit inputs/outputs. Keep mutation of
  browser/HTTP state at a deliberate seam. A pure formatter is not `useFormat`.
- A custom hook reuses React behavior, not automatically shared state. Its
  independent calls are independent unless they intentionally access the same
  Query cache or scoped store.
  [React custom-hook guidance](https://react.dev/learn/reusing-logic-with-custom-hooks).
- Use a hook when lifecycle, context or React subscriptions justify it. Do not
  wrap every exported function or `useQuery` call in another hook for symmetry.
  A named domain hook is useful when it hides repeated domain behavior.
- Event handlers express user intent: apply config, request publish, close
  dialog. Effects connect/disconnect external systems; they do not infer a
  command from several booleans or mirror server data into a second store.
- Return a small interface with named data/status/actions. Do not expose
  internal setters, raw store instances or twenty unrelated values. Avoid a
  single `useWorkflowPage` that hides fetching, permissions, editor history and
  all UI.
- Destructure dependencies explicitly. Async behavior owns abort/cleanup and
  stale-result protection. Where nondeterminism matters, inject the clock/ID
  generator/transport at that seam rather than mocking arbitrary internals.
- Use explicit units (`durationMs`, not `time`), meaningful domain names, guard
  clauses and exhaustive discriminated cases. Do not swallow failures, add
  `any`/non-null casts to bypass contracts, or introduce clever generic
  machinery for routine field/response types.

### Component composition: the default and the exception

Default: ordinary props for data and callbacks; `children` for visual structure.
A shared panel need not know whether it contains workflows, connections or runs.
React documents
[children-based composition](https://react.dev/learn/passing-props-to-a-component#passing-jsx-as-children).

Illustrative composition, **not existing components or a scaffold to create
now**:

```tsx
<EditorToolbar>
  <WorkflowTitle name={name} />
  <SaveStatus state={saveState} />
  <ToolbarActions>
    <SaveDraftButton />
    <PublishWorkflowButton />
  </ToolbarActions>
</EditorToolbar>
```

Here feature action components own their hooks; the toolbar only lays out
children. Compare that with a toolbar taking `isEditor`, `isRun`, `canPublish`,
`showSave`, `showReplay` and every endpoint callback: use explicit editor/run
compositions instead. Normal booleans such as `disabled`, `open` and `required`
are fine; the problem is unrelated operating modes multiplying branches.

Use **compound components** when coordinated parts genuinely share behavior,
such as a dialog's trigger/content/close or a tab list and its panels. Prefer
the existing Base UI primitive for those behaviors. If a custom compound module
is justified, its provider owns coordination, its interface is small, and
consumers compose only supported parts. Context is not needed just because a
static panel has a header and footer; named components/slots are enough.

Additional rules:

- Visual variants use CVA; behaviorally different workflows use explicit feature
  compositions. Do not build a generic page/form/dialog factory full of modes.
- Render callbacks are appropriate when passing data back, e.g. a table cell;
  they are not required for every static header/footer slot.
- High-frequency editor data stays in selective Zustand subscriptions. A context
  carrying the entire changing graph to every compound child defeats that
  design.
- Keep one controlled-state owner. Do not mix controlled props with independent
  internal copies or synchronize them through effects. Shared primitives never
  read workspace permissions or run feature queries behind the caller's back.
- Test the composed user interaction and accessibility through its interface,
  not internal context shape. Extract enough for readability, not one file per
  JSX fragment or a prescribed file-length target.

## 17. How skills are applied

Skills guide work; they are not application dependencies and are not all loaded
on every task. Read the applicable SKILL.md before acting, use only relevant
rules/references, announce their use, and keep current contracts/ADRs and
project instructions ahead of generic recommendations. Do not copy skill example
APIs without checking the installed version. Existing Base UI controls are not
Radix, and this app is Vite, not Next.js.

| Work being done                                          | Applicable skill                | Expected effect                                                                      |
| -------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------ |
| New module interface, utility extraction or feature seam | `codebase-design`               | Small meaningful interface, locality, explicit dependencies; no pass-through layer   |
| Reusable component/compound interface                    | `vercel-composition-patterns`   | Children/explicit variants; scoped coordination only when needed                     |
| React rendering, effects and performance                 | `vercel-react-best-practices`   | Correct subscriptions, dependency behavior, loading/bundle choices                   |
| Query keys, cache, mutation effects                      | `tanstack-query-best-practices` | Apply section 6 with endpoint-specific protocol constraints                          |
| Brand/design migration                                   | `frontend-design`               | Preserve the selected legacy identity and intentional hierarchy                      |
| Add/adapt primitives                                     | `shadcn`                        | Inspect current Base UI setup; add only needed controls; accessible composition      |
| Accessibility/UI review                                  | `web-design-guidelines`         | Inspect real interaction/markup and report actionable gaps                           |
| Browser integration verification                         | `webapp-testing`                | Exercise real journeys and failure states, not only screenshots                      |
| Finish React feature/fix or prepare React commit         | `react-doctor`                  | Run relevant diagnostics; investigate findings without claiming proof of correctness |
| New domain terminology or ADR                            | `domain-modeling`               | Preserve consistent vocabulary and authoritative domain definitions                  |
| Genuinely complex type contract                          | `typescript-advanced-types`     | Solve the specific compile-time requirement; otherwise use ordinary TS               |
| Hard unexplained regression                              | `diagnosing-bugs`               | Reproduce, test competing explanations, then fix within authorization                |
| Explicit test-first request                              | `tdd`                           | Implement behavior through the established test seam                                 |
| Review against a commit/branch baseline                  | `code-review`                   | Fixed-point diff review, not a recurring whole-repo audit                            |

Backend prerequisites use `nestjs-best-practices`, `node` or `postgres` only for
the relevant backend work. No Next.js optimization, Prisma, Three.js or other
unrelated stack adoption because a skill exists. If a needed skill is
unavailable, state that and use current primary documentation/project evidence
as fallback.

For each slice, use skills to make the initial design and implementation
decisions, then run the tests/gates in section 13. Do not create a new
checklist/report per skill, run the full skill catalog, or repeatedly reopen
settled architecture.

## 18. Screen-and-journey map

This map separates the implemented working-tree baseline from the next planned
pages and deferred product scope (updated 2026-09-15). Baseline delivery
evidence is in section 14; implementation does not imply all production
verification is complete. Deferred pages are not launch requirements or
permission to implement backend features now.

Browser path abbreviations: `B = /w/$workspaceId`,
`E = B/workflows/$workflowId`. A tab uses validated URL search when it should
survive refresh/back navigation. Backend routes remain separate from these URLs.

### Navigation and first usable release

Root `/` resolves the session and sends the user to workspace selection or
login. After choosing a workspace, land on its workflow list—not a metrics
dashboard without supporting data. The target workspace navigation is Workflows,
Connections, Runs and Workspace settings, plus the workspace switcher. Only show
destinations as their slices become usable and the user is allowed to access
them; Workflows, capability-gated Connections, workspace Run history,
notification destinations, the authorized workspace-member directory and
lifecycle controls are delivered. Other workspace administration remains gated
on its command contracts and product semantics. Account/logout lives in the user
menu. Overview is a later optional destination, not a replacement for the
current workflow-list landing page.

### Current implementation status

#### Reviewed checkpoint — 2026-09-15

The implemented scope below is a working-tree baseline, not a claim that every
planned product feature is delivered or that the changes are committed,
deployed, or verified against a live identity provider.

- Foundation: React 19/Vite, Tailwind/theme tokens, shared UI primitives,
  feature-owned modules, Router/Query integration, browser-safe contracts and
  the same-origin API transport.
- Delivered product surfaces: provider sign-in/logout and workspace selection;
  workflow list/create; bounded canvas/inspector editing with history, saving
  and conflict recovery; validation, preview and publishing; run start/history,
  live detail, cancellation/replay and artifact metadata/download access;
  versions/restore, schedules, webhooks and failure policies; Slack connection
  management, notification destinations, member listing and workspace lifecycle
  controls. The table below records their exact limits.
- The frontend review-fix cycle is closed with no outstanding findings in its
  reviewed scope. It covers incomplete JSON preservation, accessible form
  validation, uncertain settings commands, denied-data handling, webhook
  recovery and static Nginx header configuration.
- Editor recovery uses fresh original-user verification rather than cached
  identity data. Temporary pauses retain exact run/publish attempts; late
  results stay hidden while paused, and accepted runs require an explicit open
  action after recovery. Canceling navigation with **Stay** preserves the run
  receipt. Actual scope disposal clears recovery state and fences late work.
  This does not make browser verification and server writes atomic, or undo a
  command already accepted by the server.
- Latest review verification: 163 web tests in 22 files, 24 mocked-boundary
  Chromium journeys, web build/typecheck, lint, architecture checks and
  `git diff --check` passed. Additional targeted recovery regressions passed.
  This is scoped evidence, not a whole-application bug-free guarantee.

Remaining work is explicitly separate from completed review fixes:

| Remaining scope                               | Gate / next action                                                                                                           |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Existing-member role changes                  | Approved next slice; implement the role-management contract, transaction, UI and acceptance gates below.                     |
| Workspace invitations                         | Recipient-verification and delivery decisions remain gated; separate from the approved role-management slice.                |
| Workspace creation/onboarding UI and renaming | Separate bounded slice and confirmed contracts; neither UI is delivered.                                                     |
| Overview                                      | Agree metrics, time windows, freshness and scoped aggregate APIs before implementation.                                      |
| Browser artifact uploads / asset browser      | Real-browser signing, CORS, checksum and finalization evidence; listing contract for a browser.                              |
| Templates, usage and billing                  | Product scope and contracts; not part of the delivered baseline.                                                             |
| Release integration verification              | Live OIDC/backend browser journey, production proxy/deployment verification, and Firefox/WebKit coverage remain outstanding. |

Next approved implementation slice: existing-member role management, specified
below. The user approved doing roles before invitations and approved the bounded
owner/admin transition policy on 2026-09-15. Implement in the order contract →
API/database → frontend → browser tests. Invitations still require separate
recipient-verification and delivery decisions. Do not reopen completed frontend
architecture or repeat a whole-app audit without a concrete new reason.

| Surface                                                         | Working-tree status                                                                                                             |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Login and workspace selection                                   | Implemented; workspace creation/onboarding UI is not delivered                                                                  |
| Workflow list/create                                            | Implemented                                                                                                                     |
| Editor, conflict handling, validate/publish/preview/run dialogs | Implemented bounded baseline                                                                                                    |
| Run detail                                                      | Implemented status, graph, events, cancellation and explicit exact-version replay                                               |
| Run history                                                     | Implemented safe cursor list with workflow/status/UTC date filters and detail navigation                                        |
| Workflow settings                                               | Implemented versions/restore, lifecycle, schedule toggles, webhook operations and failure-policy commands                       |
| Connections                                                     | Implemented safe cursor list plus Slack bot-token create/test/rotate and generic revocation; additional auth types remain gated |
| Notification destinations                                       | Implemented safe list/create/version/status management using existing Slack or email connection references                      |
| Workspace members                                               | Implemented capability-gated safe member list with cursor pagination; invitations and role mutation are not delivered           |
| Workspace general                                               | Implemented read-only identity plus asynchronous deletion/restore operation tracking; rename is not delivered                   |
| Artifact downloads and route fallbacks                          | Implemented; upload/asset browser deferred                                                                                      |

The tables below describe target capabilities as well as existing ones. Do not
infer that every listed action is already implemented.

| Screen or surface              | Proposed location                                  | Features / actions                                                                                      | API or permission prerequisite / delivery                                                                 |
| ------------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Sign in                        | `/login`                                           | Start provider login, progress/error/retry, safe return                                                 | Existing OIDC start; backend callback return required; order 2                                            |
| Login/session recovery         | Login error state or inline expired-session dialog | Explain failure, retry login, protect dirty edits before navigation                                     | No SPA token handling; section 5 identity verification; order 2                                           |
| Workspace selection/onboarding | `/workspaces`; future create dialog                | List accessible workspaces, enter one; add creation only in a scoped onboarding slice                   | Discovery and permission contracts now used by selection; separately verify creation prerequisites        |
| Workflow list                  | `B/workflows`                                      | Cursor pagination, create dialog, open workflow; only supported filters                                 | Existing list/create; read/create authorization; order 3                                                  |
| Editor                         | `E`                                                | Palette, canvas, inspector, apply form, undo/redo, save state, validation and supported actions         | Draft/catalog; connection discovery before credential picker; read/update/publish permissions; orders 4–5 |
| Conflict resolution            | Editor dialog/panel, not another top-level page    | Local/remote comparison, explicit reload or manual reapply                                              | Conditional-save contract and retained local data; order 4                                                |
| Publish/preview/run input      | Editor dialogs/panels                              | Save barrier, publish confirmation/result, validation issues, side-effect warning, run input/deadline   | Existing endpoint-specific headers/revisions; order 5                                                     |
| Run history                    | `B/runs`                                           | Cursor pagination, supported workflow/status/date filters and links to run detail                       | Delivered workspace run-list contract and `run:read`; URL-owned filters                                   |
| Run detail                     | `B/runs/$runId`                                    | Status, bounded invocation timeline, node detail, live connection state, cancel/replay when authorized  | Existing run read/events/commands; show accepted version; order 5                                         |
| Connections                    | `B/connections`; create/rotate/revoke dialogs      | Safe metadata list, Slack create/test/rotate and generic revoke; never reveal stored plaintext secrets  | Delivered for the supported Slack auth type; verify each additional auth type before enabling its UI      |
| Notification destinations      | `B/settings/notifications`                         | Safe list, create, append configuration version and enable/disable using existing connection references | Delivered with separate workflow-update read and connection-manage mutation gates; no credential material |
| Missing/forbidden/failed page  | Route/section fallback                             | Clear message, safe back/navigation, working retry where appropriate                                    | Common pattern in every delivered route; no fake empty result                                             |

Registration, password reset and MFA are owned by the configured identity
provider unless a separate product requirement changes that arrangement. Do not
design local password/signup forms against nonexistent Pertexo credential
endpoints. Backend OIDC callback is not a React page. A profile summary may use
`/v1/users/me`; editable profile/preferences need their own explicit contract or
local-only scope.

### Further surfaces, attached to their owning feature

| Surface                        | Proposed presentation                                 | Content and scope                                                                           | Gate before enabling                                                                                                |
| ------------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Published versions             | Existing `E/settings` section; optional future detail | List immutable versions, conditionally restore into draft; add inspection when needed       | Existing version list/restore; dirty editor guard; no separate versions page or version-diff feature assumed        |
| Run history                    | `B/runs`; optional workflow-filtered entry            | Cursor history/filtering and links to run details                                           | Delivered with exact-precision, filter-bound pagination and URL-owned filters; no session-local remembered IDs      |
| Workflow triggers              | `E/settings`, schedule/webhook sections               | Published trigger status, enable/disable schedule; provision/rotate webhook endpoint/secret | Existing list/control contracts; derive trigger definitions from published workflow, not invented independent CRUD  |
| Workflow failure notifications | `E/settings` section                                  | Set/clear failure policy and select a configured destination                                | Existing policy/destination contracts; proper permissions and keyed commands                                        |
| Workflow lifecycle             | Workflow action menu + confirmation/status            | Archive/unarchive; show authoritative result                                                | Existing lifecycle revision/idempotency semantics; keep distinct from restoring a version                           |
| Workspace members              | `B/settings/members`                                  | Paginated member listing delivered; later invitations and role/access management            | `member:read` gating and safe projections verified; invitations/role changes remain gated on supported contracts    |
| Notification destinations      | `B/settings/notifications`                            | Delivered list/create/version/status management using safe connection references            | Separate read/manage gates, stable uncertain retries, version preconditions and browser regression coverage         |
| Workspace lifecycle            | `B/settings/general` danger zone / operation status   | Request deletion or recovery where allowed; show operation status                           | Existing lifecycle commands; current authority and server deadlines; no invented workspace rename/settings API      |
| Artifact access                | Run/node output panel first                           | Request download; explicit upload/finalize when a feature needs input files                 | Existing transfer contracts and real-browser signing/CORS proof; artifact browser/list deferred without listing API |
| Appearance/preferences         | User menu or settings section only when needed        | Harmless local presentation preferences                                                     | Explicit local persistence scope; no implied account-sync or theme completeness                                     |

Schedules, webhooks, notifications and versions are workflow/settings surfaces,
not separate competing dashboards. Do not expose Redis/queues, KMS or Grafana as
ordinary end-user administration pages. Infrastructure monitoring stays with
existing operational tooling. Billing, marketplace, collaboration, AI assistant,
template gallery and a dedicated “optimization” page are not in this baseline.
Deferred candidates below do not change that baseline.

### Next-page roadmap

Implement one bounded vertical slice at a time. This sequence follows the
existing section 14 baseline; it does not reopen completed architecture work.

| Order                   | Page                                                                    | Initial scope                                                                                                                                               | Gate / completion evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1 — Delivered           | Connections, `B/connections`                                            | Safe paginated list, Slack bot-token create/test/rotate and generic revocation; confirmed results refresh editor discovery.                                 | Separate read/use/manage capability gates; transient token forms and explicit MutationCache eviction; exact uncertain create/test/rotate retries; expected-secret-version rotation; historical-reference-safe revocation wording; component coverage and Chromium create → picker plus test/rotate/revoke journeys. Additional auth types remain gated.                                                                                                                                                                                          |
| 2 — Delivered           | Run history, `B/runs`                                                   | Workspace run list with supported status/workflow/date filters and links to existing run detail.                                                            | Shared bounded contract, exact-precision filter-bound cursor, workspace RLS, URL-owned filters, capability/empty/error states, component coverage and history → detail Chromium journey. No remembered-ID substitute.                                                                                                                                                                                                                                                                                                                            |
| 3 — Delivered           | Notification destinations, `B/settings/notifications`                   | Workspace destination list/create, configuration-version append and enable/disable against existing Slack or email connections.                             | `workflow:update` read and `connection:manage` mutation gates remain distinct; forms store references rather than credentials; uncertain commands retain exact bodies, preconditions and keys from the opened editing snapshot; component and Chromium coverage pass.                                                                                                                                                                                                                                                                            |
| 4 — Partially delivered | Workspace administration, `B/settings/members` and `B/settings/general` | Member listing and lifecycle controls are delivered. Existing-member role management is the approved next slice below; invitations and rename remain gated. | Member reads are identity/workspace scoped and capability gated. Eligible pending-deletion workspaces route from selection to General recovery without enabling execution. Lifecycle commands retain the exact action, revision and idempotency key across uncertain retries, expose durable operation state in the URL, poll accepted work and refresh discovery only after terminal results. Component and Chromium coverage include denial, pagination, confirmation, recovery and pending/failed states. No rename/profile API was invented. |
| 5 — Planned, data-gated | Overview, `B/overview`                                                  | Recent workflow activity, recent runs and failures needing attention, with links into existing pages.                                                       | Real scoped summary/list data, defined time windows/freshness and authorized visibility. No fabricated metrics, fetching all history to calculate totals, or infrastructure-monitoring dashboard. Keep workflow list as landing page unless separately changed.                                                                                                                                                                                                                                                                                  |

“Planned” identifies direction, not authorization to build all pages in one
turn. If an API prerequisite is missing, establish its contract and obtain the
required scope before backend implementation; do not show a clickable
placeholder.

### Backend requirements for the next-page roadmap

This is the cross-stack delivery checklist for the four slices above, not a
replacement backend architecture plan. Existing endpoints below describe the
current implementation; proposed endpoints and gated commands are not delivered
features or authorization to implement them all at once.

#### Ownership and architecture rules

- Keep HTTP controllers, authorization and application use cases in the existing
  `apps/api/src/connections`, `workflow-runs` and `identity-workspace` modules.
  Keep SQL and persistence adapters in `packages/database`. Controllers do not
  query tables directly; the frontend does not import API or database runtime
  code.
- Put public request, response, pagination and error contracts in
  `packages/contracts`, using its existing browser-safe exports and schema
  generation. Infer frontend transport types from these contracts; keep display
  models, form state and Query keys in the owning frontend feature. Do not
  expose internal database records merely to avoid defining a safe public
  projection.
- For each endpoint, specify validation and bounds, capability, workspace scope,
  safe response fields, error codes and disclosure policy before implementation.
  Commands also specify CSRF, idempotency/replay, concurrency conflicts and any
  rate limits. Reuse existing conventions, not a second frontend-specific API.
- Backend authorization remains authoritative. Preserve explicit tenant context,
  scoped repository signatures and forced RLS under
  [ADR 003](../../docs/adr/003-workspace-tenancy-rls-runtime-roles.md), and
  verified OIDC identity/internal capabilities under
  [ADR 004](../../docs/adr/004-managed-oidc-and-internal-authorization.md).
- PostgreSQL remains the durable authority under
  [ADR 005](../../docs/adr/005-postgresql-authority-bullmq-outbox-engine-gate.md).
  Read-only lists do not need jobs, an outbox or a new service. If a query needs
  an index or schema change, add a reviewed migration with the appropriate
  grants/RLS and compatibility tests; do not edit published migrations.
- A routine endpoint following accepted decisions needs no new ADR. Before
  implementing a new authorization model, invitation lifecycle, durable summary
  model or other consequential architectural decision, review the existing ADRs
  and record a new/superseding ADR if needed. Do not change an accepted decision
  silently or create ADRs for every form, test or refactor.
- Planned backend checkpoints still follow the
  [backend plan](../../docs/workflow-platform-backend-plan.md) and its ADR
  index; update [implementation progress](../../docs/implementation-progress.md)
  when checkpoint claims materially change. For these incremental slices, update
  this roadmap and relevant contracts/docs; do not reopen completed checkpoints
  or mark a slice delivered before its backend and frontend evidence exists.

#### 1. Connections: use existing commands, close integration gaps

Existing base: `/v1/workspaces/:workspaceId/connections`.

| Existing endpoint             | Responsibility                                                                     |
| ----------------------------- | ---------------------------------------------------------------------------------- |
| `GET /`, `GET /:connectionId` | Paginated discovery and safe metadata/detail; never return stored secrets.         |
| `POST /`                      | Create a connection using a supported auth contract.                               |
| `PUT /:connectionId/secret`   | Rotate stored secret material using the existing concurrency/idempotency contract. |
| `DELETE /:connectionId`       | Revoke access; do not present this as erasing all historical references.           |
| `POST /:connectionId/test`    | Bounded provider test with existing use capability and rate limiting.              |

- Start with one actually supported auth type. Verify catalog compatibility and
  create/rotate payload schemas; do not invent OAuth onboarding, connection
  rename or provider discovery endpoints from the old application.
- Preserve separate read/use/manage permissions. Backend encryption and provider
  access stay behind the connections boundary; secrets must not enter workflow
  graphs, list responses, telemetry, browser persistence or Query cache.
- Creation returns the backend connection identity; refresh the workspace-scoped
  list/picker and store only its permitted reference in node configuration. A
  failed provider test is not automatically a revoked connection, and an
  uncertain command response is not proof that creation or rotation failed.
- Evidence: contract/HTTP permission and CSRF tests, secret redaction, cursor
  and workspace isolation, command replay/conflict tests, and browser create →
  select → save/reload. Add test/rotate/revoke coverage as those actions are
  introduced.

#### 2. Run history: delivered bounded workspace read

Existing APIs support start, replay, individual detail, events/SSE and cancel. A
workspace run collection/filter API is still a prerequisite, not an existing
capability. Proposed route: `GET /v1/workspaces/:workspaceId/runs`.

- Define a strict query contract with optional `workflowId`, a supported run
  status filter, `createdAt` time bounds, bounded `limit` and an opaque cursor.
  Use the existing run-status enum, including `waiting`, `timed_out` and
  `outcome_unknown`; do not collapse uncertain outcomes into success/failure.
  Specify UTC boundaries (inclusive start, exclusive end) and reject invalid
  ranges. Agree concrete limits in the contract before building the UI.
- Return a minimal safe summary collection and `nextCursor`, reusing the
  existing run-summary contract where suitable. Include run/workflow/version
  identity, status, trigger type and timestamps needed for navigation; exclude
  raw inputs, outputs, credentials and unbounded event/node collections.
- Use deterministic descending `(createdAt, id)` keyset ordering. Preserve exact
  database timestamp precision in the cursor. Public filter timestamps accept
  zero through six fractional digits and normalize to fixed-width UTC without
  passing the fraction through JavaScript `Date`. Bind the cursor to
  workspace/filter/order context and validate malformed or mismatched cursors.
  Do not use offsets, require a full-history count or load all runs into memory.
- Extend the existing workflow-runs read use case/port and database adapter.
  Enforce `run:read` and existing workspace/lifecycle disclosure rules before
  reading; UUIDs and client filters are not authorization. Verify the query plan
  and add only indexes justified by supported filters.
- Define pagination under concurrent inserts/status changes: this is a live
  retained-history list, not an immutable snapshot. Retention may remove
  entries; handle a subsequently unavailable detail truthfully rather than
  implying a complete lifetime audit. Follow
  [ADR 013](../../docs/adr/013-retention-workspace-deletion-legal-hold.md).
- Evidence: schema bounds, same-timestamp pagination, cursor/filter mismatch,
  combined filters, real-database RLS, retention and unavailable-detail
  behavior, HTTP authentication/permission tests, and browser history → existing
  detail. Keep replay semantics under
  [ADR 031](../../docs/adr/031-authenticated-user-run-replay.md); listing
  history does not add new retry/replay commands.

#### 3. Notification destinations: delivered existing resource contracts

- `/w/$workspaceId/settings/notifications` owns the workspace destination
  collection. Reads remain gated by the API's existing `workflow:update`
  authority; create, configuration-version append and status commands remain
  separately gated by `connection:manage`.
- The form selects an existing active Slack or email connection and submits only
  its ID plus a validated channel ID or recipient address. It never accepts,
  persists, logs or caches credential material. Changing delivery kind requires
  a distinct destination, matching the database's immutable-kind invariant.
- Create, append and status commands retain the exact normalized intent,
  precondition and idempotency key for uncertain retries. Version edits capture
  `expectedVersion` with the form's opening snapshot; background refetches do
  not advance it. Conflicts recover through the resource query rather than
  overwriting a newer configuration. Recoverable background list failures keep
  cached rows and a dirty row-owned dialog mounted, with retry available inside
  the modal; nondisclosing unavailable responses remove protected data and
  management actions.
- The feature owns its API calls, identity/workspace Query key, command
  invalidation and resource components. Workflow settings consumes that public
  query/status seam for policy selection and does not duplicate destination
  transport or cache ownership.
- Evidence: StrictMode component regressions cover exact uncertain create and
  status retries, configuration preconditions, credential-free payloads and
  denied reads. Chromium covers create → version append → disable with real
  route navigation, CSRF, idempotency and authoritative refetches.

#### 4. Workspace administration: separate existing reads from new authority

Existing APIs include workspace discovery, member listing, workspace creation,
deletion request/cancel and lifecycle-operation reads. Invitation and
member-role mutation APIs are not implemented prerequisites to assume away.

- The authorized, paginated member read is delivered using the existing safe
  member projection and role vocabulary. Its query is scoped by authenticated
  identity and workspace, and both route preloading and navigation require
  `member:read`. Component coverage verifies StrictMode pagination, denied
  request suppression and distinct read failure; the browser journey verifies
  navigation, active state and the second cursor page. No owner/admin hierarchy
  or editable profile/rename fields were invented.
- Before invitation implementation, settle invited identity verification,
  acceptance, expiry, revocation, duplicate invitations and delivery failure.
  The verified OIDC `(issuer, subject)` remains the identity authority;
  possession of an arbitrary email string must not grant membership. Specify
  single-use acceptance, hashed token storage if tokens are used,
  transaction/concurrency behavior and safe audit fields. Review this decision
  against ADR 004 and create an ADR where it introduces new architectural
  semantics. Existing email workflow actions are not automatically an
  identity-invitation delivery service.
- The approved role-management slice below specifies the role-transition matrix
  and capability, self-change/last-privileged-member protection where
  applicable, concurrent update handling, audit evidence and when revoked
  privileges take effect on existing sessions/streams. Enforce these atomically
  on the server; hiding a button or keeping a cached role is not enforcement.
  Confirm exact command routes/payloads through the approved slice's
  shared-contract checkpoint.
- Keep workspace lifecycle operations asynchronous under
  [ADR 027](../../docs/adr/027-workspace-lifecycle-command-dispatch.md):
  acceptance returns an operation, not completed deletion/restoration. Poll the
  operation resource and refresh authorized workspace data on completion.
  Restoration returns the workspace to suspended and does not reactivate
  sessions, connections, triggers or runs. Never put control-ledger/maintenance
  authority in the API.
- The lifecycle UI is delivered under `workspace:manage`. General settings show
  authoritative read-only identity, validate deletion reasons with the shared
  request schema, retain an exact body/idempotency key after uncertain command
  responses, and keep the accepted operation ID in validated URL search state.
  Pending/running reads poll the operation resource; terminal results refresh
  workspace discovery and remain visible until explicit dismissal. Component
  coverage exercises StrictMode retry identity, failed-operation recovery,
  permission suppression and restore dispatch; the Chromium journey verifies
  CSRF/idempotency headers, confirmation Escape behavior and accepted-versus-
  completed presentation.
- Evidence: member-list isolation and pagination; for newly authorized commands,
  denied/escalation cases, concurrent privilege changes, invitation
  expiry/reuse, idempotency and CSRF; for lifecycle UI,
  pending/failure/completion and recovery states against the existing operation
  contract.

#### Implementation-ready slice: existing-member role management

**Status:** implemented and locally verified through the controlled full-stack
integration environment on 2026-09-16. Decision:
[ADR 037](../../docs/adr/037-workspace-member-role-management.md), extending
[ADR 004](../../docs/adr/004-managed-oidc-and-internal-authorization.md).

**Delivery evidence (2026-09-16).** The browser-safe schemas and generated
OpenAPI artifacts now include the role revision and command receipt. Migration
`0093_workspace_member_role_management.sql` adds the revision and forced-RLS
receipt storage, runtime grants, readiness/schema ownership and bounded purge
participation. Tenant-access persistence owns the transaction; the identity API
owns its guarded HTTP command; and the existing members feature owns the dialog,
exact-retry mutation and targeted query invalidation.

- Contract tests passed (16 files, 71 tests) and generated artifacts validated.
- API tests passed (98 files, 1,304 tests), including CSRF, strict-body and safe
  error mapping. The controlled opt-in full-stack API suite passed (16 suites,
  64 tests) against disposable PostgreSQL, Redis and runtime database roles. Its
  role-change sequence proves that the target's real session cookie can read an
  authorized run before the transaction, receives `401` afterward, and that an
  already-open HTTP SSE response closes after the same session is revoked. The
  OIDC provider itself is the suite's controlled fake provider, not a live
  managed-provider environment.
- Disposable PostgreSQL identity and RLS suites passed (77 tests), covering the
  complete pure transition matrix, same-revision concurrency, ABA protection,
  manager-demotion and lifecycle lock serialization, exact replay after a later
  role change, duplicate commands, key mismatch, no-op behavior, inactive
  targets, transactional rollback, audit facts and target-session revocation.
- Web unit/component tests passed (22 files, 172 tests); Chromium passed all 25
  journeys, including the owner role-change confirmation at desktop/mobile and
  the authoritative refreshed role. Routed component coverage keeps a retained
  uncertain command bound to its original target, blocks dismissal/retargeting
  through request and reconciliation, fences callbacks after scope disposal,
  handles list and mutation `401` responses as authentication loss, and retains
  conflict reconfirmation and exact-retry behavior.
- Repository build/typecheck, web lint, architecture, schema ownership/readiness
  and `git diff --check` passed. Changed-scope React Doctor ran with scoring and
  uploads disabled and reported 51 warnings; the only new-slice diagnostic was a
  false positive for mutation invalidation, which is deliberately performed
  after `mutateAsync` so the command remains locked through reconciliation. The
  mock Chromium journeys are not live OIDC or cross-browser evidence.

**Existing evidence and ownership.** The canonical policy is
`packages/database/src/tenant-access/workspace-policy.ts`: owner and admin have
`member:manage`, but only owner has `workspace:manage`. The current shared
`WorkspaceMember` response has user identity, role, membership status and
timestamps, but no concurrency revision. Memberships use the composite
workspace/user key and an existing single-owner constraint. The member list
already lives in the identity/workspace API, tenant-access persistence and
`apps/web/src/features/workspaces/components/members/`. There is no current
member-role command to merely wire up. Do not invent a new role hierarchy,
replace the capability policy, or use email as the target identity.

**Approved transition matrix.** Workspace, actor user/membership and target
user/membership must be active. The target must be another existing member.

| Actor                   | Allowed current target role      | Allowed new role                 |
| ----------------------- | -------------------------------- | -------------------------------- |
| Owner                   | admin, builder, operator, viewer | admin, builder, operator, viewer |
| Admin                   | builder, operator, viewer        | builder, operator, viewer        |
| Builder/operator/viewer | none                             | none                             |

Self-change and any owner target/new owner role are rejected. Suspended or
removed members cannot be changed through this command. An already-current role
is a no-op with a durable successful receipt, not another audit/revocation or
revision increment; require the same expected revision for a new no-op request.
No removal, suspension, self-demotion, ownership transfer, invitations, custom
roles or bulk changes. The immutable owner means this slice cannot remove the
last owner; do not add an unrelated admin-count invariant.

**Shared HTTP contract.** Add
`POST /v1/workspaces/{workspaceId}/members/{userId}/role`, authenticated
cookie/CSRF protected and guarded by `member:manage` plus the transition rule.
Request is strict `{ role, expectedRoleRevision }`; require `Idempotency-Key`.
Use a positive safe-integer `roleRevision`, exposed in the existing member
projection and backed by a database column initially 1. Successful response is a
small strict receipt `{ userId, role, roleRevision, changed, replayed }`,
status 200. The receipt represents the accepted command, not necessarily the
latest state on replay. Refresh member data after success. Do not return
emails/session identifiers or secrets in the receipt.

Declare all responses in the shared schemas and generated contract artifacts:
400 malformed input, 401 unauthenticated, 403 forbidden workspace/capability or
transition (consistent with existing member-list disclosure), 404 missing target
only after workspace authorization, 409 stale role revision, inactive target or
idempotency-body mismatch, plus existing 429/5xx conventions. Use distinct safe
problem codes for these conflicts through the existing error registry/decoder;
do not parse human messages. Preserve existing global error conventions where
they already name the equivalent failure.

**Transaction and persistence.** Add one focused role-command persistence seam
under tenant-access, exposed through the existing database public API and
identity/workspace port/adapter. Reuse existing transaction/audit/idempotency
conventions; add a narrowly owned durable command-receipt table if no suitable
existing store supports this actor/workspace/command scope. Do not reuse the
workspace-creation receipt store for a different command. Include new tables in
forced RLS, migration execution/readiness/schema ownership, purge/retention and
runtime grants. Do not edit published migrations.

Within one tenant-scoped transaction: lock the workspace first, then actor and
target users/memberships in stable identifier order consistent with existing
lifecycle writers; revalidate active workspace, current actor capability and
target; claim/check the actor/workspace/key receipt and normalized request hash;
for a new command enforce the transition matrix and expected revision; update
the role/revision; revoke the target user's active platform sessions; append one
safe `workspace.member_role_changed` audit fact; complete the receipt; commit.
Include target ID in the request hash. A key reused with different target/body
is a conflict. Exact completed retries return the original receipt without
rechecking the old revision or mutating/revoking/auditing again, but still
require current workspace access and management authority. Do not permit replay
to reapply an old role after a later role change.

All role writers must use the same revision/locking rule. Fresh checks and locks
must serialize a manager's demotion against their own concurrent commands, and
serialize changes against workspace deletion/suspension. Follow existing lock
order after inspecting interacting writers; prove no unsafe read-then-write
window with real PostgreSQL concurrent transactions. Never call public
session-store methods that open a second transaction from inside this command.
Session revocation is global to the target user: warn in confirmation that they
must sign in again. Test next-request denial and existing SSE revocation bounds;
do not claim already-running business operations are rolled back.

**Frontend placement and behavior.** Extend the existing members page/table; no
new top-level page. Keep a small role-change dialog beside the member table,
feature-local API/query/mutation code and a pure allowed-option helper. Consume
shared schemas/types from the existing browser-safe contracts export. Do not
import backend policy code into React or mirror the member list into Zustand.
The UI helper is only presentation; the backend remains authoritative.

Only eligible rows expose Change role, with the permitted choices from the
matrix. Label current/new role and session-sign-out consequence. Use the
existing field primitives, validation timing, error associations and focus
patterns. No optimistic role updates. A mutation owns invalidation of scoped
member queries; refresh affected workspace discovery/capability snapshots where
relevant. Never treat the receipt's historical replay value as current
authority.

Capture target, role, expected revision and key when submitting. Disable
duplicate submission. On an uncertain result retain the exact attempt and show
explicit Retry; changing inputs or starting a different command must not reuse
its key. A stale-revision conflict requires refreshing and explicit
reconfirmation with a new attempt, not automatic overwrite. Do not silently
discard unresolved attempts on dialog dismissal. Denied responses remove
protected management controls and stale confirmation; transient failures
preserve recoverable input. Dispose/fence identity/workspace-scoped late results
and follow the established session recovery conventions without broadening
editor-specific machinery.

**Implementation checkpoints (no automatic commits).**

1. Shared request/receipt/revision contracts and generated artifacts, migration,
   database transaction and API command. Add the role-specific matrix to the
   existing policy module rather than duplicating authorization decisions.
2. Existing members page integration with explicit exact retry and accessible
   confirmation/recovery states. Keep functions with their feature owner.
3. Real database concurrency/authorization proofs, API HTTP-stack checks and
   routed/browser journeys; update delivered status only after required gates
   pass. Update backend progress only if its existing claims actually change.

**Required tests and completion gates.**

- Table-driven entire actor/current-target/new-role matrix, self/owner
  rejection, suspended/removed/inactive cases, missing target, cross-workspace
  access, CSRF and strict body validation. Preserve the single-owner constraint.
- Concurrent same-revision updates: one change, one conflict; ABA change back
  cannot satisfy an old revision; manager demotion race cannot retain stale
  mutation authority; role mutation versus workspace lifecycle is serialized.
- Exact uncertain retries, mismatched-key reuse, concurrent duplicate requests,
  no-op behavior and rollback on failed audit/session/receipt persistence.
  Exactly one audit/change/revocation for an applied logical command.
- Revoked target sessions fail subsequent requests; active SSE follows ADR 004's
  existing per-event/at-most-five-second idle reauthorization guarantee.
- Real member-page owner/admin/forbidden journeys; no self/owner controls;
  accessible validation; stale snapshot conflict; lost response followed by
  exact retry; denied/transient refresh; scope exit and late response; displayed
  state reconciles with the server rather than a stale replay receipt.
- Run contracts/artifact checks, relevant API/unit and disposable PostgreSQL
  integration suites, web tests/build/typecheck/lint/Chromium, architecture,
  schema ownership/readiness and documentation checks. Run React Doctor as
  diagnostics, not proof. Report unavailable integration checks explicitly; do
  not mark the slice complete with unproven required concurrency gates.

Invitations remain separately planned: recipient verification, acceptance,
expiry/revocation, duplicate behavior, delivery, tokens and audit decisions in
the preceding workspace-administration requirements must be settled before that
slice. Do not add invitation scaffolding during role management.

#### 5. Overview: agree data semantics before adding aggregation

There is no dedicated product overview/aggregate API yet. Start with bounded
authorized workflow and run lists where they satisfy the page; do not create a
new service or durable read model merely to render a dashboard.

- Define each card's source, time window, sorting, refresh policy and
  permission. Distinguish recent workflow updates from execution activity and
  define which statuses mean “needs attention.” Run failure is not workflow
  activation state; preserve
  [ADR 033](../../docs/adr/033-truthful-workflow-activation-projection.md) and
  [ADR 034](../../docs/adr/034-workflow-archive-restore-and-activation.md).
- If cards require aggregates, first agree a workspace-scoped summary contract
  with bounded windows, `asOf`/freshness semantics and safe projections. Compute
  aggregates in scoped database queries, not by downloading history. Label
  retained-window counts accurately; do not imply lifetime totals after
  retention.
- Do not manufacture an audit/activity feed from timestamps if the required
  events are not retained. Defer that card or explicitly scope its event source.
  Do not mix infrastructure metrics, billable usage and user execution
  summaries.
- Evidence: exact range boundaries and status grouping, workspace/permission
  isolation, empty vs unavailable data, bounded query performance and browser
  navigation into source pages. Introduce caching/precomputation only with a
  measured need and explicit invalidation/authorization semantics.

#### Cross-stack completion gate

For each selected slice: confirm the public contract and ADR applicability →
implement any missing backend use case/persistence with focused tests → verify
HTTP validation/authentication/authorization and real-database invariants → wire
the owning frontend API/Query layer → test user behavior and failure recovery.
Keep filters in the URL, server data in Query, and transient UI state local;
mutations invalidate only the affected workspace-scoped queries. Confirm
required migrations/configuration are deployable before marking the page ready.
Mocks and frontend success states alone are not backend completion evidence.

Deferred templates, usage and billing below need their own selected scope and
contracts before backend work; this checklist does not authorize building them.

### Deferred product pages

| Candidate                  | Proposed entry                                                | Purpose                                                                         | Activation gate                                                                                                                                                                |
| -------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Templates                  | `B/templates` or workflow-create chooser                      | Start from curated compatible workflow examples                                 | Concrete onboarding demand; catalog/version compatibility and import/create semantics; never embed credentials or copy another backend's templates.                            |
| Usage                      | `B/settings/usage`                                            | Actual consumption, limits and reporting periods                                | Agreed measurement units, aggregation API, authorization and product limits. Do not equate infrastructure metrics with billable usage.                                         |
| Billing                    | Account/organization settings; route depends on billing owner | Subscription, invoices and payment management if Pertexo is sold as a service   | Explicit commercial model, billing scope/provider and contracts. Not required for a self-hosted/internal release.                                                              |
| Shared resource management | Feature-owned workspace settings sections                     | Notification destinations and any genuinely reusable webhook/artifact resources | Actual independent resource ownership and discovery/management APIs. Keep current workflow-bound triggers in workflow settings; do not invent a Make-style data store product. |

Templates, usage and billing are recorded so they are not forgotten, but remain
deferred rather than required for parity with larger automation products. Editor
usability, supported integrations and reliable execution inspection remain
important even after the navigation inventory is complete.

### How the screens work together

1. **First visit:** login → verified session → workspace selection/create →
   workflow list. Unauthorized workspace deep links show forbidden/not-found; do
   not silently switch the URL to unrelated data.
2. **Authoring:** list → create → editor → select catalog node → configure/apply
   → connect → save/reload. Adding a credential opens a feature-owned dialog;
   successful creation refreshes the picker and commits only its ID reference.
3. **Execution:** editor → save/validate → publish → start run → run detail. Run
   detail shows the version accepted by the backend and permits a link back to
   its workflow; viewing that historical graph must not replace the draft.
4. **Recovery:** inline validation focuses the field/node; connection expiry
   opens connection recovery; draft conflict stays in the editor; lost SSE shows
   reconnecting/degraded status. Session expiry uses the dirty-state safeguards,
   not an unconditional redirect. Each error has one recovery owner.
5. **Updates:** Query handles server refresh, the editor coordinator handles
   save acknowledgment, and the run controller handles SSE. New deployment/chunk
   recovery follows section 12. These are behaviors across screens, not extra
   pages or a second global “updates” store.

Before implementing each screen, specify in the same slice: route/entry point,
actions and permitted roles/capabilities, exact endpoint/query key ownership,
fields and validation, loading/empty/stale/error/forbidden states, dirty-exit
behavior, keyboard/mobile behavior, and one happy-path plus failure-path test.
Treat unsupported backend functionality as blocked/deferred UI, not a clickable
placeholder. This page map does not supersede the detailed protocol rules above.
