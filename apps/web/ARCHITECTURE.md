# Frontend architecture and implementation plan

Status: **stages 1–6 implemented; the staged frontend baseline is available**.
Inspected 2026-09-14 against foundation commit `9b1e28e` (merged to main as
`12aded2`). The current app has browser-safe contracts and transport,
provider-only OIDC entry, workspace selection, workflow discovery/create and a
lazy, conflict-safe graph editor, publishing/run flow and workflow operations.
Existing-member role management is also implemented and locally verified.
Workspace invitations are implemented in the current working tree under the
approved ADR 038 policy; their delivery evidence and remaining environment gates
are recorded in section 18.

This is the frontend's implementation reference: ownership, communication,
coding patterns, visual migration and delivery gates. [README.md](README.md)
owns setup/current capabilities; [AGENTS.md](AGENTS.md) owns agent instructions.
Update this document when a decision changes; do not create parallel audit logs.
Existing backend contracts, [domain vocabulary](../../CONTEXT.md) and accepted
ADRs remain authoritative. This plan does not change backend behavior.

Approved next slice (2026-09-22): follow the
[Better Auth authentication and account-linking plan](../../docs/authentication-and-account-linking-plan.md)
for replacing the provider-only login with email/password, social sign-in and
account-security flows. Its A0 ADR/compatibility gate precedes implementation.
Existing OIDC descriptions below describe the current baseline, not the target
authentication stack; all other frontend ownership and quality rules still
apply.

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
warms the query (or, for a resource page, awaits it); the component reads the
same key. Keep router preload staleness at zero so Query controls freshness;
preload only critical data and start independent requests concurrently. A first
implementation must explicitly choose whether stale cached content is shown
while refreshed or freshness is required before entry; `ensureQueryData` alone
is not a guarantee of freshness.
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

Static forms own their values in the feature and share one timing engine,
`useFieldValidation` (`components/ui/use-field-validation.ts`): a field is
checked when people leave it, then live while its message shows or after a
failed submit; submit focuses the first invalid control in document order;
server field errors (`errors[].path`, mapped by the feature to known fields only
— never arbitrary object paths) land on the same fields through `showErrors`;
and a field that goes from invalid to valid ties a brief knot. Plain text forms
may use the thin `useFieldValues(rules, initial)` layer over it. Render every
labelled control with `LabelledField` (`components/ui/field.tsx`, optional label
action, trailing control and live-feedback slots), which links
`aria-describedby`, sets `aria-invalid` and draws the `FieldThread`. Keep a
form-level `Notice` for failures without a known path.

Node inspectors use **live apply**, not an Apply button. Each field keeps its
own text (`use-live-field.ts`): a value that parses is committed straight into
the editor store as an undoable step — consecutive edits of the same field
within two seconds coalesce into one step — and the save coordinator writes the
draft after a one-second pause, serialized with the draft's ETag. Text that
doesn't parse stays in the field as an unfinished local edit with its message;
the store's `inspectorScratch` flag then keeps the save state from reading
“Saved”, pauses automatic checks, blocks publish and runs (“Finish or discard
the unfinished edit…”), asks Stay/Discard before a command would replace the
inspected step (another step, undo/redo, deleting it) and asks before leaving
the editor. No effect copies keystrokes between stores.

Catalog config/input/output schemas arrive as **JSON Schema documents**, not
executable Zod schemas. Do not cast them to Zod or import server registrations.
First implementation supports an explicit tested field subset (primitive fields,
enums and bounded objects/arrays needed by selected nodes), with readable
unsupported-schema feedback and a deliberate advanced JSON editor where safe.
Never silently drop schema-valid fields that the UI does not model, erase an
unsupported node, resolve arbitrary remote schema references, execute
schema-provided code or claim full semantic validation. Use catalog definition
key/version/configVersion as renderer identity.

The Schedule step's `oneOf` cron/interval config has one dedicated Setup builder
(`workflow-editor/components/inspector/schedule`). It reads its bounds from that
step's catalog schema, writes the step's own config shape, keeps a stored rule
it can't write back exactly as a custom cron rule, and applies live like any
other field. Its cron checks are advisory; the server parses the rule in its
timezone. The preview sentence, DST and missed-run wording (ADR 014) come from
the catalog feature's `schedule-sentence.ts`, shared with the published trigger
cards. An unrecognised schedule schema falls back to JSON. Under the sentence,
`draft-next-runs.tsx` lists the next three run times the server's scheduler
works out for the unsaved rule (ADR 048), through the public
`useSchedulePreview` hook in `workflow-publish/schedule-preview.public.ts`:
debounced by 500 ms, asked again once the first time passes, with a loading
line, one failure line with Retry (an unschedulable rule, rate limiting or a
failed read) and nothing at all for an unfinished rule. The editor inspector
provides the hook's `SchedulePreviewScope` (API client and workflow) once, so no
inspector layer threads it through; without that scope nothing is shown.

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
   Quick add (a connection dropped on empty canvas, or “Add step after” on the
   step's ⋯ menu) is likewise one command that adds the step and its connection.
   A For each is projected as a container card around its structured body (ADR
   020); the projection never changes the stored graph. Its body is edited in
   place: body steps are the container's React Flow children, positioned
   relative to the body's corner, and every command resolves a step or
   connection to its level (the workflow or a body, named by the For each steps
   above it) through `model/graph-scopes.ts`, then writes that level back as one
   undoable graph change. Connections never cross a body's edge; a body is
   stored in the layout it is shown in before its first change.
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

An empty draft has nothing to check or publish: the issues chip names the first
step to add and Publish stays disabled with that reason. That is client-side
feedback only; once the draft has steps, server validation decides.

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

> Superseded where it conflicts by the Weft design system below: the spine
> replaces the 280px rail, the workflow hub replaces the separate settings page,
> and the Core replaces the deferred orb/3D items.

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
| Glass sections — `src/components/patterns/glass-section.tsx`                                                                     | Directional borders, layered surface, header/content spacing                                                                | Superseded by Weft: page content is flat and only floating layers use the `lens` utility.                                                                                                                                                                                 | Adapted, then removed with the Weft uniformity pass.                                                                                               |
| Metric/summary card — `src/components/patterns/metric-card.tsx`; `src/features/workflows/components/workflows-summary-cards.tsx` | Label/value/detail hierarchy, optional icon, restrained accent border and optional status/trend treatment                   | Adapt a presentational metric card when a real overview summary needs it; feature owns its data/composition. Promote to `components/patterns/metric-card.tsx` when genuinely reused. No old metric names, decorative fake trends or client-computed full-history totals.  | Not adapted; deliver with approved overview data, not as dummy dashboard content.                                                                  |
| Lists, tables and pagination — `src/components/patterns/data-table.tsx`, `data-pagination.tsx`                                   | Header/row density, separators, hover/selection treatment and footer alignment                                              | Weft lists are rows, not tables; feature owns rows/actions and `LoadMore` pages them. Current APIs use cursor pagination, so do not copy page-number/total-count assumptions.                                                                                             | Cursor treatment verified in Workflows, Connections and Run history; the unused table primitive was removed.                                       |
| Confirmation and structured detail — `src/components/patterns/confirmation-dialog.tsx`, `json-viewer.tsx`                        | Dialog hierarchy, readable structured content and restrained action emphasis                                                | `components/patterns/confirm-dialog.tsx` on the dialog primitive; features own commands and error copy. `JsonTree` shows bounded, redacted structured data; no raw secret rendering.                                                                                      | Adapted as the one `ConfirmDialog` and `JsonTree`; no parallel dialog framework.                                                                   |
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
| [x]    | Editor command bar                   | `chrome/workflow-builder-command-bar.tsx`, `chrome/workflow-name-field.tsx`                                                                                                                          | `features/workflow-editor/components/chrome/editor-command-bar.tsx`                                                                   | Composition slots for identity, actions and status; compact appearance     | Old save/run/dirty-state behavior; the name is renamed in place with `InlineRename` (ADR 041)                     |
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

### Weft design system (supersedes the aurora-glass refinement)

Status: **applied to every page** (Home, Runs and run detail; Workflows and the
hub; the editor, publish and catalog; connections, alerts and workspace
administration; sign-in, invitations and workspace entry). A uniformity pass
then folded each area's own copies of shared concepts into one implementation
each (listed under “Shared building blocks”); new work reuses those instead of
adding variants. Weft replaces the earlier "aurora glass and workflow-first
layouts" refinement and the legacy-layout targets above wherever they conflict.
The visual reference is the Weft blueprint
([`docs/design/weft-blueprint.html`](../../docs/design/weft-blueprint.html),
open it in a browser); this section is the binding summary for code. The
palette, the particle orb, the aurora edge and glass stay — each with one job.

#### Five materials, one rule each

| Material  | Meaning                                                                                                 | Rule                                                                                                         | Implementation                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Thread    | A run moving through time: grows while running, knots on success, frays on failure, coils while waiting | Every status in the product speaks the thread glyph language                                                 | `components/ui/status.tsx` (`Status`, `StatusGlyph`, `StatusTone`)                                     |
| Loom      | Time laid sideways, one lane per workflow                                                               | Charts come from real run times, never invented metrics                                                      | Runs feature (Home and the Runs "Loom" view); step thread view on run detail                           |
| Core      | The living particle orb                                                                                 | At most one large animated Core per screen                                                                   | `components/patterns/core-orb.tsx` + `core-orb-scene.ts` (Canvas 2D, token colours, paused off-screen) |
| Lens      | Glass                                                                                                   | Only layers that float above the page: spine, bars, inspectors, dialogs, menus, toasts. Page content is flat | `lens` utility in `styles/globals.css`; `components/ui/sheet.tsx`, dialog, popups                      |
| Live edge | The aurora travelling around a border                                                                   | Only while real work is in flight; nothing moves when nothing happens                                        | `live-edge` class (animated `@property` angle, bounded to the element)                                 |

#### Tokens and type

- Keep every existing colour token. Added: `success` #8fe3c0, `warning` #f3c677,
  `raised` #212428, `subtle-foreground` #7f8b8e, `border-strong`. Cyan means
  brand, focus and _live work_ — never success.
- Radii: `sm` 6px, `md` 10px, `lg` 14px, `xl` 18px. Easing: `ease-unspool`.
- Display type: Bricolage Grotesque at a condensed width, self-hosted from
  `@fontsource-variable/bricolage-grotesque/standard.css` (optical size, width
  and weight axes; the `opsz`-only file has no width axis). The one
  `font-display` utility sets it (weight 620, `font-stretch` 76%, `opsz` 72) for
  page titles (`PageHeaderTitle`), the run sentence, the sign-in headline and
  wordmark, day headers, system-state titles, the hub bar name and lens titles
  (`SheetTitle`, `DialogTitle`, `AuthLensTitle`). Smaller titles relax it with
  `--display-width` and `--display-optical-size` (lens titles use 84% and 24)
  instead of adding variants. `font-heading` stays for small section headings.
  Inter for interface text; JetBrains Mono for instruments (times, durations,
  counts, short IDs) with tabular figures.
- Textures: `warp` (page background threads), `weave` (canvas and run maps),
  `ambient` (two slow aurora blobs in the shell). All decorative layers are
  `aria-hidden` and motion stops under `prefers-reduced-motion`.

#### Status language

Features map their own enums to a `StatusTone` in their `model/` (for example
`features/workflows/model/workflow-state.ts`). Never colour a status ad hoc.

| Tone        | Glyph (motion)               | Used for                                                             |
| ----------- | ---------------------------- | -------------------------------------------------------------------- |
| `live`      | light travels along a thread | running runs/steps/previews, starting activation, info notifications |
| `queued`    | three beads brighten in turn | queued runs, pending/ready steps                                     |
| `waiting`   | a slowly turning coil        | waiting runs/steps, scheduled retries, stopping                      |
| `success`   | knot                         | succeeded, healthy, enabled, live workflows                          |
| `failure`   | fray                         | failed, error, unhealthy, revoked-by-failure                         |
| `timeout`   | thread stopped by a bar      | timed out                                                            |
| `attention` | dotted gap, slow blink       | outcome unknown, degraded, reauthorization required                  |
| `canceled`  | cut thread                   | canceled, revoked, archived                                          |
| `skipped`   | dashed thread                | skipped branches                                                     |
| `neutral`   | hollow bead                  | drafts and states without meaning                                    |

#### Shared building blocks

One implementation per concept; features compose these rather than restyling
their own:

| Concept        | Where                                                                     | Use                                                                                                                                                                                                                                                                                                                               |
| -------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Field          | `components/ui/field.tsx`                                                 | `LabelledField` (label, optional label action, trailing control and live feedback; links hint and message), `FieldControl` draws the `FieldThread` (fray/knot)                                                                                                                                                                    |
| Deadline       | `components/ui/deadline-field.tsx`, `components/ui/calendar.tsx`          | `DeadlineField` for the Run and Replay lenses: None, In 1 hour, In 1 day or Pick a time, where a date (typed, or from a `Calendar` lens with past days disabled) and a 24-hour time are read on the person's clock with their time zone named. Never the browser's native picker; its value is local `datetime-local`-shaped text |
| Validation     | `components/ui/use-field-validation.ts`                                   | `useFieldValidation`: the only message timing (blur → live, focus first invalid, server `errors[].path`, knot); `useFieldValues` is the thin values-and-rules layer for plain text forms                                                                                                                                          |
| Confirmation   | `components/patterns/confirm-dialog.tsx`                                  | `ConfirmDialog`: title, description or consequences, optional inputs, one failure `Notice`, Cancel + `ProgressButton`; `unconfirmed` turns confirm into the exact retry and Cancel into Close                                                                                                                                     |
| Pending button | `components/ui/progress-button.tsx`                                       | `ProgressButton`: mini orb + swapped verb while pending, countdown while waiting; never hand-build the orb                                                                                                                                                                                                                        |
| Rename         | `components/patterns/inline-rename.tsx`                                   | `InlineRename` (pencil → field → Save/Cancel), `RenameForm` in dialogs; sends the revision the edit started from, conflicts offer “Use theirs / Keep mine”                                                                                                                                                                        |
| Copy           | `components/ui/copy-button.tsx`, `components/ui/use-copy-to-clipboard.ts` | `CopyButton` (icon, or a short value in mono whose name adds it) confirms in place; `useCopyToClipboard` for menu items (toast, same wording). Only `lib/clipboard.ts` touches the clipboard                                                                                                                                      |
| Notice         | `components/ui/notice.tsx`                                                | `Notice`: tones `info`/`success`/`warning`/`destructive` (destructive is an alert), optional thread `glyph`, title and one action. Banners, failed commands and uncertain outcomes                                                                                                                                                |
| Stale data     | `components/patterns/stale-line.tsx`                                      | `StaleLine`: the one amber "Couldn’t refresh. Showing results from 14:02" line with Retry                                                                                                                                                                                                                                         |
| Lists          | `components/patterns/load-more.tsx`, `components/ui/skeleton.tsx`         | `LoadMore` (next page, retry, one failure line); `Skeleton`, `SkeletonThread`, `SkeletonRows` (a list loading in its row shape)                                                                                                                                                                                                   |
| Recent log     | `components/patterns/recent-log.tsx`                                      | `RecentLog` (heading, note, loading rows, one failure owner, empty sentence, "Load older") and `RecentLogEntry` (glyph, words, action, time) for trigger logs                                                                                                                                                                     |
| Read failure   | `components/patterns/read-failure.tsx`                                    | `ReadFailure`: a read's one failure owner: a `Notice` with Retry, or `StaleLine` while earlier data stays on screen                                                                                                                                                                                                               |
| Clock          | `lib/use-now.ts`, `lib/use-countdown.ts`, `lib/format-time.ts`            | `useNow(intervalMs, enabled, untilMs?)` ticks only while needed and pauses in hidden tabs; `useCountdown` (cooldowns, `Retry-After`, windows) is built on it; `formatCountdown` renders "0:24"                                                                                                                                    |
| Canvas         | `lib/canvas-scene.ts`, `lib/use-canvas-renderer.ts`                       | `CanvasScene` (sized, cleared, token colours) for the Core, sign-in threads, Loom and loading wave; the hook owns the loop                                                                                                                                                                                                        |
| Status colour  | `components/ui/status.tsx`, `components/ui/status-tone.ts`                | `Status`/`StatusGlyph` and `statusToneText`, the one colour per tone                                                                                                                                                                                                                                                              |
| Pagination     | `lib/api/pagination.ts`                                                   | `cursorPages`/`collectPages` walk cursors once (repeat or overrun is a protocol failure); `searchParams` builds page queries                                                                                                                                                                                                      |

Other primitives (`components/ui`): button (`primary` is the one filled action
per screen; `default` tinted; `outline`, `ghost`, `destructive`, `link`), badge,
input/textarea, select, dropdown-menu, tabs, tooltip, popover, switch, checkbox,
sheet, toggle-group, separator, kbd, empty (`Empty`, `EmptyMedia`, `EmptyTitle`,
`EmptyDescription`, `EmptyActions` — every empty state names its next action),
toast (`NotificationsProvider`, `useNotifications` with success/info/error/undo
and `track` for progress → result), loading-orb, dialog (`center`, `top`). Other
patterns (`components/patterns`): `CoreOrb`, `PageHeader` (title, mono meta
line, actions), `CommandPalette`, `JsonTree`, `SystemState`, thread
illustrations. Other libraries (`lib`): `format-time.ts` (all date/time/duration
text — no feature-local `Intl.DateTimeFormat`; `formatDateTimeInZone` reads a
time on a named clock with its zone name), `format-bytes.ts` (byte sizes for
files and payloads), `format-initials.ts`, `api/api-error-copy.ts` (generic
read/command failure sentences, uncertain outcome, forbidden, rate-limit and
support reference helpers), `use-prefers-reduced-motion.ts`,
`use-online-status.ts`.

#### Structure

- `/w/$workspaceId` resolves the person and workspace once (`beforeLoad`); an
  unavailable workspace renders the full-screen unavailable page. The pathless
  `shell` layout renders the spine (Home Core, Workflows, Runs with live count,
  Connections · Team, Alerts, Settings · Search, account), the breadcrumb rooted
  in the workspace switcher, banners and the page. Phones get a bottom bar with
  a More sheet. ⌘K opens the command palette. The shell route also provides
  `CommandPaletteContext` (`routes/command-palette-context.ts`); a page route
  reads `useOpenCommandPalette()` and hands its feature a plain callback (Home's
  Search), so features never import routes.
- `/w/$workspaceId/workflows/$workflowId` is the immersive workflow hub (no
  spine) with Build (index), Runs, Triggers, Versions and Settings tabs. Every
  tab renders `WorkflowHubBar` (from `features/workflows/hub.public.ts`) with
  its own right-hand actions; Build embeds the editor.
- Routes are thin compositions (`useWorkspaceScope`, `useWorkflowHubScope`) and
  set document titles with `pageTitle`. Resource pages render `ResourceNotFound`
  inside the frame for missing runs or workflows; their loaders use
  `prefetchResource` (`routes/route-context.ts`), which turns a 404 into
  `{ found: false }`, and the hub asks only whether its workflow exists
  (`probeResource`). Every error page keeps the shell: a missing workflow
  renders `WorkspaceShellFrame` (`routes/workspace-shell-route.tsx`) around its
  not-found state, and any other unmatched address under a workspace hits a
  catch-all child that throws `notFound()`, which the shell route's
  `notFoundComponent` (`ShellNotFound`) renders with Go home and Search.
- Breadcrumbs come from `useShellCrumbs` (`routes/breadcrumbs.tsx`): a page's
  `staticData.crumb`, or for a run the trail “Runs / <workflow> / <short ID>”
  from the run loader's data, each step linking back up. The workspaces
  feature's `ShellBreadcrumb` draws them; below 640 px the steps between the
  workspace and the page fold into “…”, a button that opens them in a small
  lens, so the page's own crumb stays readable.
- Loading: every other loader warms its queries with `warmPrefetches` and
  returns at once, so navigation never waits for list data; each block shows its
  own skeleton. A warmed read that meets an expired session calls the router
  context's `onSessionExpired`, which re-runs the scope's session check in
  `beforeLoad` and signs out. What still blocks (the session and workspace
  check, resource reads, lazy chunks) shows the router's pending component after
  150 ms for at least 300 ms (`defaultPendingMs`/`defaultPendingMinMs`):
  `PagePending` inside the shell, `WorkflowHubPending` in the hub,
  `WorkspaceBootPage` (“Opening Northwind Ops…”, then “Still connecting…” after
  2 s) for a cold workspace and `BootPage`/`OpeningPage` for public pages.
  `Skeleton` and `SkeletonThread` stay invisible for their first 150 ms, so an
  in-page skeleton never flashes either. A page change that waits on the scope's
  session check (it runs again on every navigation) keeps the current page on
  screen, and `NavigationProgress` (`routes/navigation-progress.tsx`, in the
  root layout) draws a slim spooling thread along the top from the router's
  pending state after the same 150 ms; it holds still under reduced motion and
  never shows on a cold start, which has the boot page.
- File placement is the same in every feature: `components/` holds components
  (and the Canvas scene a component owns); `model/` holds pure rules, types and
  the editor store with its React contexts; feature hooks (`use-*.ts`) sit at
  the feature root; server command hooks live in `<feature>.mutations.ts` or,
  once there are several, one per file in `mutations/`. Query options other
  features or loaders need come from one `queries.public.ts`; lazy pages and
  focused interfaces use `public.ts` or `<responsibility>.public.ts`.

#### Copy and feedback rules

- Names over IDs: never show a full UUID in a list or header; short IDs live in
  mono with copy in a Details area. No enum values, protocol language
  ("precondition", "command key", "bounded") or bare error codes in prose.
- Errors say what went wrong and how to fix it. Uncertain outcomes say "We
  couldn’t confirm whether … went through" and keep retrying safe.
- Loading: page skeletons (≥150 ms before showing, ≥300 ms once shown); buttons
  keep their width, swap their verb and show `LoadingOrb`; real multi-step work
  lists its actual steps with the live edge; background refetches never blank a
  page — a failed one leaves data visible with one amber "as of" line.
- Notifications: every create/update/revoke/invite confirms with a toast;
  reversible deletes offer Undo; errors persist; progress becomes result in
  place. Lasting states (offline, pending deletion, suspended) are banners.
- Destructive actions confirm or offer Undo. Rate limits count down from
  `Retry-After`.
- Success effects of a command (toast, closing a dialog, navigating) follow an
  awaited `mutateAsync()` or live in the mutation hook. TanStack Query drops
  `mutate(x, { onSuccess })` callbacks once the caller unmounts, which a cache
  update often causes; ESLint rejects `mutate()` with options in `src`.

#### Budgets

One large animated Core per screen; canvases pause off-screen and in hidden
tabs; device pixel ratio capped at 2; no animated layer larger than its element;
reduced motion renders still frames and static glyphs.

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
  through public behavior, not setter call counts or giant snapshots. Page tests
  share one budget set in `test/setup.ts` (testing-library's `asyncUtilTimeout`
  of 3 s) and vitest's 15 s per-test ceiling; don't add per-file overrides.
  Shared primitives have focused tests in `test/components/` and `test/lib/`.
- ESLint rejects `mutate(x, options)` in `src` (callbacks are dropped when the
  caller unmounts); act after an awaited `mutateAsync()` instead.
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

### Run-statistics slice evidence

- `GET /v1/workspaces/:workspaceId/run-statistics?window=1h|6h|24h|7d&breakdown=workflow`
  follows [ADR 044](../../docs/adr/044-bounded-workspace-run-statistics.md). It
  is authorized with `run:read`, uses the `authenticated_read` rate class and
  the run list's non-disclosing workspace statuses. It returns exact current
  queued/running/waiting counts, per-status counts for the fixed window (24
  hours by default) and, on request, at most 50 workflows by window total. All
  of these come from one repeatable-read snapshot stamped `asOf`. Workflow names
  follow `workflow:read`.
- Migration `0113_workflow_run_statistics_index.sql` adds
  `workflow_runs_workspace_created_statistics_idx (workspace_id, created_at) INCLUDE (status, workflow_id)`.
  Current counts use the existing `(workspace_id, status, …)` index. The read
  runs under a 2-second statement timeout. The disposable-database plan budget
  seeds 4,420 runs across two workspaces, 96 of them in the measured one-hour
  window. It records index-only scans for all three statements with zero heap
  fetches, 96 scanned rows for the window and breakdown, no rows removed by a
  filter, and 5–8 shared buffers.
- The web replaces paged status counts with `runStatisticsQueryOptions` (24
  hours, 15-second refresh). The Home and Runs headers and the spine's
  `liveRunCountQueryOptions` share that one query, so a shell page makes one
  request instead of three, "100+" is gone, and the failed-in-24h figure is
  exact. The Home Loom still draws runs from `/runs` (up to 300 in the window,
  plus active runs created before it). `loomStatisticsQueryOptions` supplies its
  caption and lane totals, and a 7-day window is available. Needs attention
  keeps its bounded problem-run pages because it links individual runs.
- Home's header adds Search, which opens the shell palette, and New workflow
  (`workflows?create=true`, `workflow:create` only). First-thread steps link to
  the create lens, the latest workflow's Build tab, `connections?add=any`,
  Alerts and `team?invite=true`. Each page still gates its lens by capability.
- Verification: contracts 76/76; API 1,404/1,404 plus the real-PostgreSQL API
  journey on a throwaway database; database unit 769/769 and the full
  disposable-database integration suite 578/578 in 88 files, including the
  statistics integration and plan budget; web 433/433 in 58 files. Coverage
  thresholds pass, and the risk report records 0 unreviewed and 406 reviewed
  branches. Build, typecheck, lint, format, docs, knip, architecture, schema,
  contracts, complexity and duplication checks pass. Playwright was not run in
  this change; the mocked Chromium journeys were updated to serve the statistics
  read.

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
  pass; 23 unit/component files with 177 tests and 27 mocked-boundary Chromium
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
  disposal. Firefox/WebKit and the broader live-backend browser journey remain
  outstanding; invitation OIDC/session/SSE behavior has controlled API-level
  integration evidence. Architecture and built-export gates pass. Contract
  build/typecheck and 73 contract tests pass; generated artifacts are current
  and the connections OpenAPI now declares its existing nondisclosing list
  `404`. The latest full React Doctor scan (including untracked files) reports
  zero errors and 51 warnings; warnings are triage input, not proof of a defect
  or correctness. The score is not used as a completion gate. These counts
  describe the current uncommitted working tree, not the historical
  stage-specific counts above.
- Triggers, connections and alerts follow-up (2026-09-25). Each webhook card on
  the Triggers tab composes a “Recent deliveries” list
  (`workflow-settings/components/triggers/webhook-deliveries.tsx`) from the ADR
  045 delivery log: outcome words and tones from `model/delivery-outcome.ts`,
  HTTP status and body size, relative and exact times, a link to the admitted
  run, ten rows per page through `LoadMore`, the shared stale line and an honest
  empty state. Alerts rows and the destination lens show `#channel-name` from
  the ADR 046 lookup (`failure-notifications/use-slack-channel-names.ts`, one
  query per connection and group of ten channels through
  `connections/queries.public.ts`, fresh for five minutes) and otherwise the
  channel ID with a short reason from `model/channel-names.ts`; a failed lookup
  never fails the page. The empty Triggers tab uses the shared `Empty` like the
  Versions tab, without a glyph or a divider under the hub bar. Component and
  model tests cover the delivery list, paging, failure and empty states,
  resolved and unresolved channel names and the lookup failure; the web suite
  passes 59 files with 441 tests.
- For each bodies and channel names follow-up (2026-09-25). For each bodies are
  edited on the canvas like the outer workflow. A body's steps are the
  container's children; the container sizes itself around them
  (`model/body-layout.ts`), grows while one is dragged and draws the body's
  `item · ordinal` inputs, its `result`, the bounds, Add step and what the body
  still needs. The nested-graph layer (`model/graph-scopes.ts`) indexes every
  level, and the existing graph commands (`graph-commands.ts`,
  `graph-copies.ts`) act on a step's own level: add (a For each placed from the
  palette starts with an empty body, 100 items one at a time), quick add from a
  body port or “Add step after” (the new step joins its body), connect (React
  Flow's `isValidConnection` refuses a connection across a body's edge), move in
  body coordinates, delete with the Undo toast (restoring into the body, or
  nothing once the body is gone), duplicate (a copied For each gets fresh body
  IDs) and inspector edits. Selection survives in bodies, and deleting a For
  each around the inspected step asks about unfinished edits. Keyboard access
  matches the canvas: body steps focus and open with Enter, ⌫ deletes them, the
  For each inspector lists its body steps as buttons and offers “Add step to
  body”, and a body step's Inputs tab offers only its body siblings to connect
  and map. Inside a body, Insert data offers “This item” (the whole item or its
  position) as `structured_input` mappings, and the “Loop item” source edits
  them. ADR 020's body rules show as issues, never as fixes
  (`model/body-rules.ts`): an empty body, a connection across its edge, more
  than one last step (the one whose output is each item's result, marked “Gives
  the result”) and steps off the way from the body's start to that end. Server
  validation still decides; its findings inside a body now resolve to the body
  step for Fix. The Slack step's Setup tab edits its channel ID and shows
  `#name` beside it, or the ADR 046 reason it can't, once the field is left
  (never per keystroke) and only for people with `connection:use`; a channel
  from another source stays on the Inputs tab. The workflow Settings
  failure-alert label and choices read “#channel-name via Connection” when the
  name resolves. Both use the one lookup through
  `failure-notifications/channel-names.public.ts`. Deliberately left out:
  editing a For each's item and concurrency bounds (new ones start at 100 and
  1), and moving existing steps into or out of a body. Unit tests cover the
  nested-graph commands, body layout and rules, loop-item mappings and
  body-issue targets; component tests cover drawing, keyboard building, mapping,
  deletion with Undo and body issues, the Slack step's channel name and the
  Settings label. The web suite passes 71 files with 530 tests; the For each and
  Slack channel Chromium journeys were updated by reading them and weren't run
  here.
- Schedule runs follow-up (2026-09-25, ADR 048). Each schedule card on the
  Triggers tab shows **Next runs** (`schedule-next-runs.tsx`: the next three
  times from the scheduler, on the schedule's clock with its zone name and in
  local time through the catalog's shared `ScheduleRunTimes`, or "Paused") and
  **Recent runs of this schedule** (`schedule-occurrences.tsx`: Started a run,
  on time or caught up late, with Open run, or Skipped by the missed-run
  setting; ten per page with "Load older run times"). The webhook "Recent
  deliveries" list and this one now share `RecentLog`, `RecentLogEntry`,
  `ReadFailure` and the feature's `RunLink` instead of two copies. Runs held
  back by workspace capacity or a failed start never become a run time, so the
  card explains them from the schedule's health (`model/occurrence-outcome.ts`).
  The editor's Schedule step previews an unsaved rule's next three runs (see
  section 7). Component, hook and model tests cover the lists, DST zone names,
  paging, empty, paused, held-back, failure, debounce, refresh and rate-limit
  states; the web suite passes 70 files with 510 tests.

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

#### Reviewed checkpoint — 2026-09-16

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
  management, notification destinations, member listing, bounded existing-
  member role changes and workspace lifecycle controls. The table below records
  their exact limits.
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
- Existing-member role management verification is recorded in its delivery
  evidence below: 172 web tests in 22 files, 25 mocked-boundary Chromium
  journeys, contract/API/database checks and the controlled full-stack session
  and SSE revocation sequence passed. The identity provider in that sequence was
  controlled, not a live managed provider; Firefox/WebKit and production
  deployment verification remain outstanding. This is scoped evidence, not a
  whole-application bug-free guarantee.

Remaining work is explicitly separate from completed review fixes:

| Remaining scope                             | Gate / next action                                                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Workspace invitations                       | Implemented bounded slice; complete the controlled provider/full-stack and production sender environment gates recorded below. |
| Workspace creation and display-name editing | N1 and N2 implemented; detailed delivery evidence and environment limitations are recorded below.                              |
| Overview                                    | N3 recent lists plus exact ADR 044 run statistics implemented; trends, rates and usage stay excluded.                          |
| Visual node input mapping                   | M1 is implemented; focused delivery evidence and remaining live-integration limits are recorded below.                         |
| Browser artifact uploads / asset browser    | Real-browser signing, CORS, checksum and finalization evidence; listing contract for a browser.                                |
| Templates, usage and billing                | Product scope and contracts; not part of the delivered baseline.                                                               |
| Release integration verification            | Live OIDC/backend browser journey, production proxy/deployment verification, and Firefox/WebKit coverage remain outstanding.   |

Existing-member role management is complete within the evidence and limitations
recorded below. Workspace invitations now follow the bounded design and ADR 038;
do not reopen completed frontend architecture or repeat a whole-app audit
without a concrete new reason.

| Surface                                                         | Working-tree status                                                                                                                                    |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Login and workspace selection                                   | Implemented, including first/additional workspace creation through the existing owner-assignment contract                                              |
| Workflow list/create                                            | Implemented                                                                                                                                            |
| Editor, conflict handling, validate/publish/preview/run dialogs | Implemented bounded baseline, including For each bodies edited in place on the canvas                                                                  |
| Run detail                                                      | Implemented status, graph, events, cancellation and explicit exact-version replay                                                                      |
| Run history                                                     | Implemented safe cursor list with workflow/status/UTC date filters and detail navigation                                                               |
| Workflow settings                                               | Implemented rename, versions/restore/compare, lifecycle, schedules with next and recent runs, webhooks with their delivery log, failure policy         |
| Connections                                                     | Implemented safe cursor list plus Slack bot-token create/test/rotate and generic revocation; additional auth types remain gated                        |
| Notification destinations                                       | Implemented safe list/create/version/status management using existing Slack or email connection references, with Slack channel names when they resolve |
| Workspace members                                               | Implemented capability-gated list, cursor pagination, bounded existing-member role changes and invitation management                                   |
| Workspace general                                               | Implemented conditional display-name editing, read-only slug and asynchronous deletion/restore operation tracking                                      |
| Artifact downloads and route fallbacks                          | Implemented; upload/asset browser deferred                                                                                                             |

The tables below describe target capabilities as well as existing ones. Do not
infer that every listed action is already implemented.

| Screen or surface              | Proposed location                                  | Features / actions                                                                                      | API or permission prerequisite / delivery                                                                 |
| ------------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Sign in                        | `/login`                                           | Start provider login, progress/error/retry, safe return                                                 | Existing OIDC start; backend callback return required; order 2                                            |
| Login/session recovery         | Login error state or inline expired-session dialog | Explain failure, retry login, protect dirty edits before navigation                                     | No SPA token handling; section 5 identity verification; order 2                                           |
| Workspace selection/onboarding | `/workspaces`; feature-owned create dialog         | List accessible workspaces, enter one, or create the first/additional workspace                         | Discovery, session, CSRF, idempotency and server-owned owner-assignment contracts are used directly       |
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
endpoints. Backend OIDC callback is not a React page. The Profile tab reads
`/v1/users/me` and edits the display name through `PATCH /v1/users/me` (ADR
043); other profile preferences need their own explicit contract or local-only
scope.

### Further surfaces, attached to their owning feature

| Surface                        | Proposed presentation                                 | Content and scope                                                                           | Gate before enabling                                                                                                |
| ------------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Published versions             | Versions hub tab with preview and compare side sheets | List immutable versions, preview one, compare any two, restore into draft                   | Existing version list/restore; compare reuses the client version-diff model                                         |
| Run history                    | `B/runs`; optional workflow-filtered entry            | Cursor history/filtering and links to run details                                           | Delivered with exact-precision, filter-bound pagination and URL-owned filters; no session-local remembered IDs      |
| Workflow triggers              | `E/settings`, schedule/webhook sections               | Published trigger status, enable/disable schedule; provision/rotate webhook endpoint/secret | Existing list/control contracts; derive trigger definitions from published workflow, not invented independent CRUD  |
| Workflow failure notifications | `E/settings` section                                  | Show the current choice; set/clear the policy with a configured destination                 | Policy read/set/clear under `workflow:update`; the read reuses the destination projection                           |
| Workflow lifecycle             | Workflow action menu + confirmation/status            | Archive/unarchive and rename; show authoritative result                                     | Separate lifecycle and name revisions (ADR 034/041); distinct from restoring a version                              |
| Workspace members              | `B/settings/members`; `/invitations/accept`           | Paginated members, bounded role changes, invitation management and recipient acceptance     | ADR 037/038 authority, current-database checks, dedicated delivery and browser-bound OIDC acceptance                |
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

| Order                                    | Page                                                                    | Initial scope                                                                                                                   | Gate / completion evidence                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1 — Delivered                            | Connections, `B/connections`                                            | Safe paginated list, Slack bot-token create/test/rotate and generic revocation; confirmed results refresh editor discovery.     | Separate read/use/manage capability gates; transient token forms and explicit MutationCache eviction; exact uncertain create/test/rotate retries; expected-secret-version rotation; historical-reference-safe revocation wording; component coverage and Chromium create → picker plus test/rotate/revoke journeys. Additional auth types remain gated.      |
| 2 — Delivered                            | Run history, `B/runs`                                                   | Workspace run list with supported status/workflow/date filters and links to existing run detail.                                | Shared bounded contract, exact-precision filter-bound cursor, workspace RLS, URL-owned filters, capability/empty/error states, component coverage and history → detail Chromium journey. No remembered-ID substitute.                                                                                                                                        |
| 3 — Delivered                            | Notification destinations, `B/settings/notifications`                   | Workspace destination list/create, configuration-version append and enable/disable against existing Slack or email connections. | `workflow:update` read and `connection:manage` mutation gates remain distinct; forms store references rather than credentials; uncertain commands retain exact bodies, preconditions and keys from the opened editing snapshot; component and Chromium coverage pass.                                                                                        |
| 4 — Partially delivered                  | Workspace administration, `B/settings/members` and `B/settings/general` | Member listing, bounded role changes and removal, invitations and lifecycle controls are delivered; rename remains gated.       | Role and invitation commands are identity/workspace scoped, capability gated and transactionally authorized. Controlled full-stack role-change evidence includes target-session and SSE revocation. Invitation-specific evidence and remaining provider limitations are recorded below. Eligible pending-deletion workspaces route only to General recovery. |
| 5 — Implemented; verification incomplete | Workspace invitations, member page plus `/invitations/accept`           | Manager list/create/resend/revoke and OIDC-bound, single-use recipient acceptance.                                              | ADR 038 is accepted. Contracts, database, API, dedicated system delivery, frontend and mocked Chromium are implemented. Disposable PostgreSQL concurrency/RLS and controlled OIDC session/SSE evidence pass; controlled provider email delivery, production sender/domain, Firefox and WebKit remain completion gates.                                       |
| 6 — Planned, data-gated                  | Overview, `B/overview`                                                  | Recent workflow activity, recent runs and failures needing attention, with links into existing pages.                           | Real scoped summary/list data, defined time windows/freshness and authorized visibility. No fabricated metrics, fetching all history to calculate totals, or infrastructure-monitoring dashboard. Keep workflow list as landing page unless separately changed.                                                                                              |

“Planned” identifies direction, not authorization to build all pages in one
turn. If an API prerequisite is missing, establish its contract and obtain the
required scope before backend implementation; do not show a clickable
placeholder.

### Backend requirements for the next-page roadmap

This is the cross-stack delivery checklist for the roadmap slices above, not a
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

Existing APIs include workspace discovery, member listing, existing-member role
changes and removal (ADR 037, ADR 042), leaving a workspace, suspension,
reactivation and ownership transfer (ADR 047), workspace creation, deletion
request/cancel and lifecycle-operation reads. Invitation management and
recipient-bound acceptance are implemented under ADR 038 and, for deployments
whose only session authority is Better Auth, ADR 043; production provider
evidence remains a separate deployment gate rather than an application-code
prerequisite.

- The authorized, paginated member read is delivered using the existing safe
  member projection and role vocabulary. Its query is scoped by authenticated
  identity and workspace, and both route preloading and navigation require
  `member:read`. Component coverage verifies StrictMode pagination, denied
  request suppression and distinct read failure; the browser journey verifies
  navigation, active state and the second cursor page. No owner/admin hierarchy
  was invented; the display name is edited only by its owner (ADR 043).
- The role-management slice below is delivered. Its transaction remains the
  reference for fresh database authorization, workspace-first lock ordering,
  exact command receipts, audit and session effects; invitations must not route
  acceptance through that command or expand its approved transition scope.
- The implemented invitation slice below specifies recipient verification,
  acceptance, expiry, revocation, duplicate behavior, delivery failure, token
  handling, concurrency and safe audit fields. The verified OIDC
  `(issuer, subject)` remains the identity authority; possession of an arbitrary
  email string does not grant membership. ADR 038 records the approved policy.
  Existing workflow email actions and workspace-owned Resend connections are not
  an identity-invitation delivery service.
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
`WorkspaceMember` response has user identity, role, monotonic role revision,
membership status and timestamps. Memberships use the composite workspace/user
key and the existing single-owner constraint. The guarded command, database
transaction and member UI live in the identity/workspace API, tenant-access
persistence and `apps/web/src/features/workspaces/components/members/`. Do not
invent a new role hierarchy, replace the capability policy, or use email as the
target identity.

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

**Implemented shared HTTP contract.** The slice uses
`POST /v1/workspaces/{workspaceId}/members/{userId}/role`, authenticated
cookie/CSRF protected and guarded by `member:manage` plus the transition rule.
Request is strict `{ role, expectedRoleRevision }`; require `Idempotency-Key`.
Use a positive safe-integer `roleRevision`, exposed in the existing member
projection and backed by a database column initially 1. Successful response is a
small strict receipt `{ userId, role, roleRevision, changed, replayed }`,
status 200. The receipt represents the accepted command, not necessarily the
latest state on replay. Refresh member data after success. Do not return
emails/session identifiers or secrets in the receipt.

Responses are declared in the shared schemas and generated contract artifacts:
400 malformed input, 401 unauthenticated, 403 forbidden workspace/capability or
transition (consistent with existing member-list disclosure), 404 missing target
only after workspace authorization, 409 stale role revision, inactive target or
idempotency-body mismatch, plus existing 429/5xx conventions. Use distinct safe
problem codes for these conflicts through the existing error registry/decoder;
do not parse human messages. Preserve existing global error conventions where
they already name the equivalent failure.

**Implemented transaction and persistence.** One focused role-command
persistence seam under tenant-access, exposed through the existing database
public API and identity/workspace port/adapter. Migration 0093 uses a narrowly
owned durable command-receipt table rather than the workspace-creation receipt
store, and includes it in forced RLS, runtime grants, schema/readiness checks
and workspace purge participation. Published migrations remain immutable.

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

**Frontend placement and behavior.** The existing members page/table is extended
without a new top-level page. A small role-change dialog sits beside the member
table, feature-local API/query/mutation code and a pure allowed-option helper.
Consume shared schemas/types from the existing browser-safe contracts export. Do
not import backend policy code into React or mirror the member list into
Zustand. The UI helper is only presentation; the backend remains authoritative.

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

**Delivered sequence (no automatic commits).**

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

#### Implemented slice: member removal, display names and return paths

**Status:** implemented and locally verified on 2026-09-25 under
[ADR 042](../../docs/adr/042-workspace-member-removal.md) and
[ADR 043](../../docs/adr/043-self-service-profile-and-session-authority-journeys.md).
Playwright journeys were not run for this slice; the component and real-API
suites below are its evidence.

- **Member removal.**
  `POST /v1/workspaces/{workspaceId}/members/{userId}/remove` (`member:manage`,
  `ordinary_mutation`) mirrors the role change: strict
  `{ expectedRoleRevision }`, `Idempotency-Key`, receipt
  `{ userId, roleRevision, replayed }`. Owners remove any non-owner, admins
  remove builders, operators and viewers; nobody removes themselves or the
  owner. The removal, a `workspace.member_removed` audit fact, the receipt and
  revocation of the removed person's sessions commit together (migration
  `0110`). Invitations the person created stay pending; a later invitation may
  reactivate a removed (never a suspended) membership. In the Team page, rows
  the actor may remove get an actions menu; the shared `ConfirmDialog` lists the
  consequences, a toast confirms, and role change and removal share one
  feature-local member-command state machine (`useMemberCommand`) so an
  unconfirmed removal stays on its member and repeats with its exact key. A
  stale revision refreshes the list with row feedback; an already removed member
  refreshes the list and says so.
- **Display name.** `PATCH /v1/users/me` (`actor_mutation`, CSRF,
  `Idempotency-Key`) with `{ displayName, expectedRevision }`; the profile read
  now returns `revision` (migration `0111`). The contract owns the limits:
  trimmed, 1–128 characters, no control characters. The Profile tab edits the
  name in place, keeps an unconfirmed save for an exact retry, and reloads a
  name changed elsewhere (`412 user.profile_revision_conflict`) before saving
  again. Success refreshes the router so the shell and member lists agree.
- **Invitations under Better Auth.** Acceptance routes no longer depend on
  legacy OIDC. In a deployment whose own sign-in is available
  (`/v1/auth/capabilities`), `POST /v1/invitation-acceptance/session` proves the
  recipient from a sign-in issued at most five minutes earlier; the page tries
  it silently after loading the journey, sends people without a session to sign
  in and back, and signs an older session out and in again first.
- **Return paths.** `returnTo` is limited to `/invitations/accept`,
  `/account/security` and `/w/{workspaceId}/account`
  (`authenticationReturnPathSchema`). The sign-in, sign-up and sign-out route
  search schemas validate it and every use site checks it again, because the
  router keeps unvalidated raw keys in route search. Social sign-in uses it as
  the callback, sign-up and verification resends keep it through the
  verification link, and Account & security's "Sign in again" returns to the
  page it came from.
- **Polish.** `RoleSelect` and `RoleSelectWithSummaries` replace the
  `withSummaries` flag; the roles matrix names every role in full and uses whole
  short words on phones, and sits beside the members only from `xl`; Account &
  security starts from the spine like other pages, and the standalone page
  aligns with its wordmark.
- **Evidence.** Contract tests, API unit tests including controllers, use cases,
  error mapping, capabilities and the session proof, database integration suites
  for removal and profile against disposable PostgreSQL, and the Better
  Auth-only real-API suite (sign-up with return path, profile, invitation
  acceptance from a fresh session, removal and rejoining) pass, together with
  the existing OIDC real-API and Better Auth suites. Web component coverage:
  `workspace-member-removal`, `account-profile`, `invitation-session-acceptance`
  and `sign-in-return-path`.
- **Not included:** avatars or other profile fields, and a sign-up name limit
  matching the profile limit. Leaving, suspension and ownership transfer
  followed in the next slice.

#### Implemented slice: leaving, suspension and ownership transfer

**Status:** implemented and locally verified on 2026-09-25 under
[ADR 047](../../docs/adr/047-workspace-membership-lifecycle.md). Playwright
journeys were not run for this slice; the component, database and real-API
suites below are its evidence.

- **Backend.** Four commands reuse the ADR 037/042 member-command path, now one
  shared `executeMemberCommand` runner (workspace-first lock, actor admission
  under lock, receipt replay and completion) that role change and removal also
  use. `POST /v1/workspaces/{workspaceId}/leave` (`workspace:read`, strict empty
  body), `…/members/{userId}/suspend` and `…/reactivate` (`member:manage`,
  `{ expectedRoleRevision }`) and `…/members/{userId}/transfer-ownership`
  (`workspace:manage`, `{ expectedRoleRevision, expectedOwnerRoleRevision }`),
  all `ordinary_mutation` with CSRF and `Idempotency-Key`. Each commits the
  membership change, its revision, one audit fact, a receipt in its own
  forced-RLS table (migrations `0116`–`0118`) and session revocation together.
  Leaving and suspension end the affected person's sessions, reactivation too (a
  privilege change), and a transfer ends both people's sessions after demoting
  the owner to admin before promoting the target, so the single-owner index
  holds throughout. Transfers need a sign-in from the last five minutes
  (`403 auth.session_not_fresh`); a member in the wrong state is
  `409 workspace.member_status_conflict`.
- **Team.** Row actions: Make owner… (owners, to active members), Suspend… or
  Reactivate… (the removal rules) and Remove. Suspended members read as
  suspended at every width. Every command uses `MemberCommandDialog`, the shared
  `ConfirmDialog` bound to the member it is about, with its consequences, a
  success toast and the exact retry of `useMemberCommand`. A transfer that needs
  a fresh sign-in keeps the dialog open with "Sign in again", which comes back
  to Team (`/w/{workspaceId}/team` joins the ADR 043 return allowlist). After a
  transfer the previous owner sees that their session ended.
- **Settings.** The danger zone holds Leave workspace for everyone but the
  owner, who is told to make another member the owner first. Leaving lists its
  consequences, retries exactly, clears the local session view and goes to the
  workspace picker, which asks for a sign-in first because every session of the
  person has ended. A `401` after an unconfirmed leave counts as having left.
- **Copy.** The roles matrix row and role summaries now say the owner renames,
  deletes and hands over the workspace; the matrix still derives from
  `workspace-policy.ts`, and a test pins the new suspension, transfer and leave
  helpers to it.
- **Evidence.** Contract tests; database policy tests and the disposable
  PostgreSQL suite `identity-workspace-membership-lifecycle` (leave, suspend and
  reactivate matrix, blocked access while suspended, status conflicts, exact and
  concurrent retries, rollback, concurrent transfers keeping one owner), with
  the removal and role suites and the full database integration run still
  passing; API unit tests for the controller, freshness, error mapping and
  capabilities; the Better Auth-only real-API suite
  `better-auth-membership-lifecycle` (CSRF, strict bodies, stale revisions,
  replay, freshness, next-request `401`); web component suites
  `workspace-member-lifecycle` and `workspace-leave`.
- **Not included:** a "Leave workspace" item in the account menu. The account
  menu holds person-wide actions (account, sign out) on every page, while
  leaving is a per-workspace destructive command with its own confirmation
  state; Settings is one click away in the spine for every role. Also out of
  scope: suspension with an end date, several owners and bulk commands.

#### Implemented slice: workspace invitations

**Status:** implemented in the current working tree under accepted ADR 038.
Existing-member role management remains unchanged. Required verification is
tracked below; unavailable provider and cross-browser gates are not treated as
passed.

**Existing foundation and confirmed gaps.** Pertexo already has one stable
external identity key, OIDC `(issuer, subject)`, platform-owned users and opaque
sessions, current-database workspace authorization, forced-RLS memberships,
append-only audit facts, durable idempotency patterns, a PostgreSQL outbox and
the role-management transaction described above. The members page already owns
member administration UI and Query scope. The canonical capability policy gives
owner and admin `member:manage`, and ADR 037 defines which non-owner roles each
may manage.

The slice extends that foundation without changing ordinary sign-in. Invitation
acceptance requires a fresh `email_verified` claim through a fixed server-owned
OIDC continuation; internal email remains a recipient check rather than the
durable identity key. Invitation contracts, tables, commands, the standalone
acceptance route and an application-owned sender now form a separate identity
boundary. Customer workflow Resend connections remain excluded from
security-sensitive identity mail, while the generic outbox transport is reused
for identifier-only delivery jobs.

##### Approved product decisions

ADR 038 records the approved first-slice policies in this table.

| Decision                          | Recommended first-slice policy                                                                                                                                                                                                                                                                                                                 | Material alternative / consequence                                                                                                                                                                                                                       |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Invitation authority              | Extend ADR 037 symmetrically: an owner may invite `admin`, `builder`, `operator` or `viewer`; an admin may invite only `builder`, `operator` or `viewer`. Never invite `owner`. Authorize from current locked database state.                                                                                                                  | Owner-only invitations are simpler but make the existing admin `member:manage` capability narrower than role management. Any broader admin policy would contradict ADR 037.                                                                              |
| Recipient proof                   | Require a fresh OIDC result for acceptance and an exact match between the normalized invited email and a provider-verified email claim. Require `email_verified: true`; a provider that omits it needs an explicitly approved trusted-issuer rule. `(issuer, subject)` still resolves the user and email never links two identities.           | Trusting the existing session or an unverified/missing claim is less friction but does not prove control of the invited address with the current model.                                                                                                  |
| Wrong account and existing member | A wrong OIDC account neither consumes nor changes the invitation; show the mismatch and offer an explicit sign-out/use-another-account action. A matching user who is already an active member completes the invitation as an audited no-op and keeps the current role. Suspended/removed membership is a conflict, not implicit reactivation. | Changing an existing member to the invited role would bypass ADR 037 concurrency and session rules. Treating already-member as a terminal error leaves valid links indefinitely unresolved.                                                              |
| Invitation lifecycle              | Seven-day expiry; one pending invitation per workspace plus normalized email; recipient/role are immutable. Resend is explicit, rotates the token, increments the invitation revision and starts a new seven-day window. Revoked or expired invitations allow a new invitation.                                                                | Different expiry/retention requirements affect copy, cleanup, indexes and support procedures. Updating a pending role in place makes uncertain retries and old emailed links ambiguous.                                                                  |
| Delivery                          | Use a dedicated application-owned transactional-email adapter and sender identity, invoked through a durable identity-invitation outbox job. Reusing the current worker deployment is acceptable; reusing workflow nodes, destinations or customer connection credentials is not.                                                              | A copy-link-only release cannot reach new users reliably. A new deployable service adds operational cost without a first-slice need. The actual provider, sending domain, credentials and sandbox must be provisioned before the delivery gate can pass. |
| Session effect on acceptance      | Treat membership creation as a privilege-changing boundary: revoke the accepting user's older sessions and issue/rotate the completing browser session from the same accepted command. Existing SSE streams then stop under ADR 004's bound. Explain this before final acceptance. An already-member no-op does not revoke sessions.           | Letting every existing session gain the new workspace on its next request is simpler, but conflicts with ADR 004's session-rotation rule for privilege changes.                                                                                          |

Terminal invitation recipient data is minimized after 90 days while legally
permitted audit facts retain invitation/user identifiers. Legal holds prevent
minimization. This is platform retention policy, not a frontend preference.

##### Smallest coherent first implementation

Deliver email-address invitations for one workspace and one non-owner role at a
time. Include manager list/create/resend/revoke, dedicated delivery, OIDC-bound
single-use acceptance for new and existing users, and the members-page and
recipient UI needed to recover expected failures. Exclude bulk/domain invites,
owner transfer, custom roles, custom messages, invitation role editing,
removal/suspension, SCIM/group sync, multiple identity providers, provider
logout and a general email framework.

Apply the approved matrix only while the workspace, actor user and actor
membership are active. Creation, resend and acceptance require an active
workspace. Workspace deletion must serialize on the same workspace lock, revoke
pending invitations and cancel undispatched delivery; restore to `suspended`
does not reactivate them. Revocation may be performed only before the lifecycle
transition removes ordinary member administration. Invitation acceptance grants
the stored role once; it never invokes the existing-member role-change command,
changes an active member's role or promotes an owner.

New recipients first become internal users through the existing OIDC mapper,
then receive membership in the acceptance transaction. Existing
`(issuer, subject)` identities reuse their internal user. A fresh claim whose
email is already owned by another internal user must follow the current
identity-conflict path; this slice must not add email-based account linking.
Email comparison uses one documented normalization consistent with the current
case-insensitive user constraint (trim plus Unicode-safe lowercase, with no
provider-specific dot or plus rewriting).

##### Public contracts and API ownership

At the contract checkpoint, add browser-safe schemas and generated OpenAPI for:

- `GET /v1/workspaces/{workspaceId}/invitations` — authorized cursor list of
  safe invitation metadata;
- `POST /v1/workspaces/{workspaceId}/invitations` — strict `{ email, role }`,
  CSRF and `Idempotency-Key`, returning `202` with the accepted invitation and
  queued delivery state;
- `POST /v1/workspaces/{workspaceId}/invitations/{invitationId}/resend` — strict
  `{ expectedRevision }`, CSRF and key, returning the new revision and delivery
  attempt without exposing a token;
- `POST /v1/workspaces/{workspaceId}/invitations/{invitationId}/revoke` — strict
  `{ expectedRevision }`, CSRF and key, returning a small historical command
  receipt; and
- a separate, rate-limited acceptance boundary: resolve a fragment-carried token
  into a short-lived browser-bound acceptance intent, start OIDC with a
  server-owned continuation, read the safe pending state, and explicitly
  complete acceptance. The OIDC callback may redirect only to the fixed
  allowlisted `/invitations/accept` route for that continuation, never an
  arbitrary caller URL.

Invitation projections contain ID, masked or manager-visible recipient email as
appropriate, role, status, revision, expiry, created/updated timestamps and a
truthful delivery state (`queued`, `submitted`, `failed` or `canceled`). A
provider-accepted message is not described as delivered to an inbox. Management
responses never contain the link/token. Acceptance responses expose only the
workspace and membership result the verified recipient is entitled to see.

Use shared, machine-readable problems for invalid input, unauthenticated,
forbidden, unavailable/not-found disclosure, duplicate pending recipient,
already-member/inactive-member, stale revision, expired/revoked/consumed token,
recipient mismatch, delivery unavailable and idempotency-body mismatch. Do not
parse messages in React. Invalid random tokens receive the same safe unavailable
shape; a valid browser-bound recipient flow may distinguish expired, revoked,
wrong-account and already-member states so recovery is actionable.

##### Token, OIDC and database ownership

Email links carry an opaque high-entropy value in the URL fragment, not query or
path data. Capture the fragment in short-lived route-owned memory, remove it
immediately, and send it in a JSON body to the resolver; it is never stored in
local/session storage, Query cache, logs, telemetry or audit metadata. A
versioned token may include a non-secret invitation identifier plus at least 256
random bits. Store only the secret digest on the invitation. Keep the raw value
sealed with a dedicated application encryption adapter only for the bounded
delivery attempt, with invitation/delivery identifiers as associated data; erase
sealed material after terminal delivery, revocation, acceptance or expiry.

Resolving a valid token creates a short-lived, single-use acceptance intent and
an independent HttpOnly browser-binding cookie. The OIDC transaction references
only that intent identifier. The callback records fresh `(issuer, subject)` and
verified-email evidence for the intent, establishes the internal user through
the existing mapper, and returns to the fixed acceptance route. Completion
requires the same browser binding, current session/internal user and fresh
verified-email match. Wrong identity, replay, expiry or cookie mismatch cannot
consume the invitation. Extend the existing OIDC transaction model narrowly; do
not add arbitrary return URLs or put the raw invitation token in OIDC state.

##### Concrete acceptance interface

These contracts and endpoints are implemented. The identity/workspace module
owns the entire command; React does not orchestrate membership creation and
session revocation as separate requests:

| Endpoint                                  | Request and result                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /v1/invitation-acceptance/resolve`  | Strict `{ token }`; `201` establishes an HttpOnly intent-binding cookie and returns safe journey state. Resolution does not consume the invitation or grant access.                                                                                                                                                            |
| `GET /v1/invitation-acceptance`           | Cookie-selected intent; `200` returns a discriminated journey state, expiry and binding-specific CSRF token. Before recipient verification, disclose no recipient address or workspace details. Missing binding returns `unavailable`.                                                                                         |
| `POST /v1/invitation-acceptance/oidc`     | Strict `{}` plus binding-specific CSRF; starts the existing OIDC flow with a server-owned intent continuation and returns the validated provider authorization URL. Also supports explicit account switching and recovery sign-in.                                                                                             |
| `POST /v1/invitation-acceptance/complete` | Strict `{ intentId, expectedRevision }`, authenticated session, binding, ordinary session CSRF, binding-specific invitation CSRF and `Idempotency-Key`; `200` returns an acceptance receipt and sets a replacement session cookie if membership was created. `intentId` is a non-secret concurrency identifier, not authority. |
| `DELETE /v1/invitation-acceptance`        | Binding-specific CSRF; `204` clears the binding and abandons the local journey, without revoking the invitation or undoing acceptance. Repeating with no binding is harmless.                                                                                                                                                  |

All responses are `Cache-Control: no-store`; never persist acceptance responses
or CSRF material in Query caches. Pre-session resolution requires exact allowed
Origin validation, JSON-only requests and a required non-simple header, with
restrictive credentialed CORS. Reject requests that cannot satisfy this browser
origin policy. Subsequent mutations require the intent's synchronizer CSRF token
as well; completion also uses the ordinary authenticated CSRF defense. Bindings
are random, stored as digests, HttpOnly, Secure in deployment and use the
configured OIDC-compatible SameSite policy. Callback continuation is only the
fixed `/invitations/accept` route, never a caller-supplied return URL.

Shared journey variants are `sign_in_required`, `ready`, `wrong_account`,
`completed`, `expired`, `revoked`, `superseded` and `unavailable`. Only a bound,
verified recipient may see detailed lifecycle states. A completed receipt is
visible only to the same authenticated internal user with the bound intent;
current workspace access is separately authorized. Use `401` for completion
without a valid session, `403` for failed binding/CSRF, `409` for lifecycle or
revision conflicts and idempotency-body mismatch, and the existing validation
status for malformed bodies. Preserve the safe-disclosure rules above.

##### Acceptance lifetime, invalidation and recovery

Capture these technical defaults in the follow-up ADR and shared contracts; they
do not approve the product policies above:

- An intent and its binding have an absolute 15-minute lifetime, capped by the
  invitation expiry. OIDC transactions retain their existing shorter lifetime
  where applicable. Verified-email evidence expires five minutes after the
  validated callback. Another OIDC round trip refreshes proof, but retries and
  reauthentication never extend the intent's absolute lifetime. Fresh evidence
  means this bound OIDC transaction, not a claim that the provider forced the
  user to re-enter credentials.
- Store invitation ID and token generation on the intent. Use the monotonic
  invitation revision as generation: only lifecycle commands, not delivery
  status updates, advance it. Completion locks the invitation and rechecks
  pending status, expiry, active workspace/user, matching generation, recipient
  proof and membership state before any grant. Resend invalidates both unopened
  old links and already-resolved old intents. Revoke/expiry/deletion also block
  completion; an in-flight callback cannot restore a stale intent.
- One active journey is selected per browser cookie scope. Replacing a binding
  invalidates the previous binding without revoking the invitation. Completion
  must match both the supplied intent ID and its bound intent, so another tab
  cannot accidentally accept the newly selected invitation. Hash the
  invitation/intent identity into the idempotent request. Serialize requests per
  journey and discard stale UI responses; browser tabs still require server-side
  concurrency checks.
- Replacement lineage is owned by the durable claim graph, not by short-lived
  acceptance-intent rows. Each claim maps one prior binding identity to its
  successor binding identity; traversal follows the next claim even when the
  intermediate intent has already been pruned. A present, unexpired intent in
  `pending`, `verified`, `wrong_account` or `completed` state is live or still
  recoverable and fences every stale ancestor. Abandoned, superseded, expired or
  missing intents are terminal only when no later claim continues their lineage.
  Traversal is bounded to 32 links; a cycle, malformed continuation or
  over-bound chain fails closed rather than authorizing another successor.
- If resolution has an uncertain outcome, first read cookie-selected state. With
  no usable binding, allow an explicit retry using the same token while it
  remains in route-owned memory. A replacement resolution derives repeatable,
  domain-separated intent, binding and CSRF material from the presented token
  and prior HttpOnly binding. The database returns an already-committed exact
  replacement, while its durable claim rejects a different competing target; no
  raw value is persisted. Clear route-owned token memory on confirmed
  resolution, route disposal or terminal failure. After reload without a usable
  binding, ask the user to reopen the original email; reopening the link on an
  already-mounted route starts the same recovery. An abandoned binding returns
  `unavailable` rather than advertising an OIDC action that the API rejects.
  Re-resolving never consumes the invitation. Rate-limit intent creation and
  clean up expired/abandoned rows; do not persist raw tokens to make reload
  recovery seamless.
- Retain the exact completion body/key for uncertain retries in the current
  journey. Reload first reads server state and never automatically submits a new
  command. The intent identifies one acceptance outcome even if a client loses
  its key. Atomically record accepted user, invitation generation and receipt on
  the consumed intent alongside the membership transaction.
- If completion commits but the response or replacement `Set-Cookie` is lost,
  the old session is revoked and the replacement raw token is unrecoverable from
  its digest. Do not persist recoverable session tokens, authenticate by
  receipt, or replay session issuance from the acceptance command. Require
  ordinary OIDC sign-in again. An unexpired bound continuation then reads the
  completed receipt for the same internal user without re-granting membership,
  reapplying a role or revoking sessions again. If the binding expired or was
  cleared, normal sign-in and current workspace discovery provide recovery;
  there is no receipt-based authorization exception.
- If the new cookie arrived but the response body was lost, authenticated state
  read or an exact completion retry returns the receipt without another session
  rotation. Resolve a completed same-user intent before checking fresh proof or
  pending-invitation preconditions: these govern new grants, not historical
  receipts. Expired bindings still require normal sign-in/discovery. Later
  membership or workspace changes never get undone by recovery; distinguish
  historical success from present access.
- Preserve the consumed intent for authenticated reconciliation until its
  original expiry. Single use prohibits another grant, not safe receipt reads.
  Clear the binding on explicit abandonment, reconciled success, expiry or
  invalid binding. Wrong-account recovery explicitly restarts OIDC and clears
  old proof without consuming the invitation; only a still-valid generation may
  continue. Never automatically log out the user or assume local logout ends the
  provider's SSO session.
- The maintenance reaper expires unattended pending invitations, clears sealed
  material and removes bounded expired or abandoned intents. Unknown delivery
  status remains evidence rather than being rewritten as a definite cancel;
  active legal holds retain acceptance evidence, and durable command/audit
  receipts are not deleted by this cleanup.
- A replacement claim is cleanup-eligible only when its entire bounded
  descendant lineage contains no live/recoverable intent, unresolved next link,
  invalid/cyclic tail or active legal hold on the prior or any successor
  workspace. Cleanup takes the same binding-digest fences as resolution,
  rechecks eligibility after locking and deletes at most the configured page
  size. Workspace purge applies this same rule to claims where the purged
  workspace is either the prior or successor side. A cross-workspace claim that
  still fences an unrelated live descendant temporarily survives tenant-row
  purge as minimal UUID/digest security evidence; it contains no raw token,
  recipient address or authorization grant and is removed by later bounded
  cleanup once the lineage becomes terminal. This deliberate exception prevents
  tenant purge from creating a second live successor while still ensuring
  eligible claims are eventually removed.
- Claim cleanup scans use durable keyset progress rather than repeatedly taking
  the oldest rows. Each bounded cycle records an immutable high-water tuple and
  advances after every examined page, including pages retained by legal holds or
  live descendants. Rows arriving after that high water wait for the next cycle;
  completing a cycle starts from the beginning again, so a released hold or a
  newly terminal descendant is reconsidered without letting new arrivals starve
  older work. Transient cleanup owns one maintenance cursor. Tenant-row purge
  owns cursor state per purge job and must finish a bounded claim-scan cycle
  before it may complete while intentionally retained cross-workspace claims
  remain. Cursor updates and claim eligibility checks share the existing
  transaction and binding-digest fences. Migrations `0095` and `0096` remain
  immutable. Forward migration `0097` repairs completed workspace-purge cycle
  restarts by selecting the next high-water boundary before atomically
  persisting both the prior cursor and that boundary. A previously empty cycle
  keeps a null cursor while installing its first non-null boundary; every
  persisted row therefore satisfies the cursor/boundary constraint, and rows
  arriving above a running cycle's fixed high water remain deferred to the
  following bounded cycle.

The UI distinguishes an unknown outcome requiring a state check/sign-in from a
definite rejection. Acceptance stays durable even when the success screen is
lost; recovery changes authentication, not the accepted grant.

The forward migrations add focused identity/workspace-owned tables:

- `workspace_invitations`, forced-RLS and workspace scoped, with normalized
  recipient, non-owner role, monotonic revision, digest, status, expiry,
  creator/acceptor and terminal timestamps;
- invitation command receipts scoped by actor/workspace/operation/key and exact
  request hash, unless the contract checkpoint proves an existing receipt store
  has precisely those semantics;
- bounded invitation delivery attempts with safe provider status/reference and
  separately sealed transient payload material; and
- short-lived platform acceptance intents/bindings with least-privilege API
  access. Any token-to-workspace resolver that must precede tenant scope is a
  narrowly audited database function/policy exception, not a general RLS bypass.

Include indexes for cursor order, digest lookup, expiry cleanup and one pending
recipient per workspace. Because a time expression cannot safely define the
partial uniqueness rule, creation first locks and transitions an expired pending
row, while a status-based unique index arbitrates concurrent creators. Add
runtime grants, forced RLS, migration-history/schema/readiness checks, retention
and workspace purge participation without rewriting published migrations.

All manager commands use the role-command lock order: workspace first, then
involved users/memberships in stable identifier order, then invitation and
receipt rows. Re-read active workspace, actor capability and the approved role
matrix inside the transaction. Acceptance and revoke/resend lock the same
invitation row; acceptance versus acceptance, revoke, resend or deletion has one
winner. Membership insert, invitation consumption, audit, session revocation /
replacement and acceptance receipt commit together. Exact completed retries
return their historical receipt and then refresh current state; they never
recreate membership, rotate another token, resend another message or reapply an
old role after later state changes.

Delivery workers lock invitation before delivery attempt and never acquire a
workspace row after either lock. Lifecycle and retention paths already own or
lock workspace before following invitation -> delivery attempt -> acceptance
intent order, preventing the former attempt/invitation inversion.

Record safe facts such as `workspace.invitation_created`,
`workspace.invitation_resent`, `workspace.invitation_revoked` and
`workspace.invitation_accepted` in the command transaction. Use invitation and
accepted-user identifiers, role, revision and bounded result metadata. Do not
put raw tokens, browser bindings, session identifiers or recipient email in
audit metadata. Delivery attempts and failure classes are operational records /
telemetry, not reconstructed security audit history.

##### Dedicated delivery boundary

Create a small identity-invitation delivery port owned by the identity/workspace
feature and a versioned identifier-only job handled by the existing outbox /
dispatcher / worker machinery. The worker loads the invitation and sealed
delivery material under the job's workspace scope, renders one fixed security
template, and calls an application-owned transactional-email adapter. It must
not load a workflow graph, connection, notification destination or node
definition.

Use the provider's idempotency facility when available. Transport redelivery may
otherwise submit the same still-valid link more than once; that must be reported
truthfully and is rendered harmless by the single-use token, not called
exactly-once email. A definite failure leaves the invitation pending and visible
with an explicit resend action. An unknown provider outcome retains the same
sealed attempt for reconciliation; it must not mint a new token silently. Resend
is a new manager command after the previous attempt is terminal or explicitly
reconciled.

Provider selection, system API credentials, verified sending domain/from
address, templates, rate limits, sandbox and operational alert owner are missing
deployment prerequisites. The existing low-level HTTP/client utilities may be
reused after review, but customer Resend connections and workflow retry policy
remain out of scope.

##### Frontend placement and recovery

Keep management in `features/workspaces`: add an **Invite member** action and a
pending-invitations section to the existing members page, visible only when the
current workspace projection includes `member:manage`. Use a feature-local
dialog, list/table, API functions, scoped Query keys and focused mutations for
create/resend/revoke. The UI may derive permitted options from the current
workspace role for honest presentation; the database remains authoritative. No
optimistic invitation, membership or role updates.

The create dialog owns email/role scratch, validates on initial blur and again
while correcting after submit, associates errors with controls and focuses the
first invalid field. Confirmation explains assigned access, expiry and the
recipient's sign-in/session consequence. Mutations retain exact body, revision
and key across uncertain retries, block conflicting commands until resolution,
and reconcile by refetch. Stale revision, duplicate, access loss and delivery
failure have distinct recovery. Authentication/permission loss removes cached
protected rows and open commands; transient refresh failure keeps stale data and
editing state with retry. Long addresses and roles remain usable on mobile and
with keyboard/screen-reader navigation.

Add `/invitations/accept` outside the authenticated workspace shell and its
workspace discovery loaders. It owns only the transient acceptance journey:
invalid/expired/revoked link, OIDC progress, wrong account, confirmation,
already-member no-op, success into the accepted workspace, and retryable
provider/network failure. It never displays another workspace's member list,
automatically logs out a wrong account, stores the token, or bypasses ordinary
route authorization. After success, clear acceptance cookies/state, refresh
current user/workspace discovery, and navigate only on explicit user action.

##### Delivery sequence

1. Record the approved authorization, recipient-proof, lifecycle, delivery and
   session policies in a follow-up ADR to ADR 004. Confirm provider and
   retention prerequisites; do not create UI scaffolding first.
2. Add shared schemas/error codes/OpenAPI and generated artifacts, including
   verified-email/OIDC-continuation contracts and safe invitation projections.
   Specify the acceptance interface, absolute lifetimes, generation binding and
   lost-response recovery above in the ADR/contracts before frontend callers.
3. Add forward migrations and focused database ports/use cases. Prove lock order
   against role changes and workspace lifecycle, RLS, uniqueness, idempotency,
   single use, audit and session rotation with real PostgreSQL.
4. Add guarded NestJS management and acceptance controllers plus the dedicated
   delivery port/job. Verify strict bodies, CSRF, disclosure, rate limits,
   callback binding and controlled-provider delivery/recovery.
5. Add member-page management and the standalone acceptance route using the
   existing Query/router/error conventions. Preserve role-management behavior.
6. Run the complete acceptance matrix below. Only then mark invitations
   delivered and record concrete evidence here; mocks alone are insufficient.

##### Required tests and completion gates

- Contract/unit: strict schemas, generated artifacts, normalization and role
  options; safe problem decoding; token/parser bounds; template escaping; no
  secret fields in projections, jobs, logs or audit.
- Real PostgreSQL/runtime roles: owner/admin/forbidden matrix from current
  locked state; admin demotion race; cross-workspace RLS; concurrent duplicate
  creation; one pending recipient; exact command replay/mismatched key; resend
  rotation; expiry/reinvite; accept-versus-accept/revoke/resend/deletion;
  rollback around membership, audit, receipt and session writes; purge and PII
  retention. Use the established disposable database only.
- Identity/API: new and existing users; fresh verified claim; missing/false
  verification; wrong account; same address casing; different subject claiming
  an existing address; active/suspended/removed already-member cases; callback
  replay/binding mismatch; token expiry/reuse; CSRF and rate limits; safe
  not-found disclosure. The old session must fail after acceptance, the new
  session must access the granted workspace, and an already-open SSE stream must
  close within ADR 004's bound.
- Delivery: transaction plus outbox atomicity, dispatcher redelivery, provider
  idempotency where supported, definite/unknown failures, sealed-token cleanup,
  revoke/expiry cancellation and explicit resend. Prove a controlled provider
  receives the fixed invitation template without workspace credentials or raw
  secrets in the job payload.
- Acceptance recovery: lose the completion response before and after the
  replacement cookie arrives; retry with the revoked old session and the new
  session; recover through OIDC as the same and a different user; reload with a
  valid, expired and cleared binding. Assert exactly one membership grant,
  acceptance audit and command-driven session rotation, no recoverable raw
  session token, and no repeated role application. Ordinary recovery sign-in may
  issue a session through the existing login flow, not command replay. Cover
  proof expiry before completion, consumed-intent reads after proof expiry, and
  later role/access changes before reconciliation.
- Generation and bootstrap recovery: resolve then resend/revoke/expire/delete,
  including a callback already in flight; old intents must never grant access.
  Lose the resolver response with and without its cookie, retry from memory,
  reload and reopen the email. Cover competing browser tabs/binding replacement,
  mismatched intent IDs, duplicate completion keys and changed bodies. Assert
  resolver calls never consume invitations, delivery updates do not invalidate
  intent generations, and stale responses cannot select another journey.
- Web/component: accessible create/confirm/resend/revoke forms; exact uncertain
  retry; duplicate/stale/access-loss/transient states; cached list pagination;
  wrong-account and already-member recovery; token removal from the URL and
  browser storage; StrictMode/scope disposal with no late cross-user state.
- Browser: owner and admin journeys on desktop/mobile; new-user and existing-
  user OIDC acceptance; wrong account then explicit switch; expired/revoked and
  delivery-failure recovery; refreshed members/invitations display. Run mocked
  Chromium for UI boundaries and a controlled full-stack OIDC/email sandbox
  journey for completion. Report live managed-provider, production sender and
  Firefox/WebKit evidence separately if unavailable.
- Repository gates: contracts generation/check, affected package tests and
  typechecks, API/database integration, web build/lint/tests/Chromium,
  architecture/schema/readiness/purge checks, React Doctor as diagnostics and
  `git diff --check`.

##### Delivery status and evidence

- ADR 038, shared schemas/OpenAPI, migration `0094` plus forward corrective
  migrations `0095`, `0096`, `0097` and `0100`, forced-RLS invitation, receipt,
  delivery and acceptance records, current-state authorization, generation
  fencing, exact command replay, audit and session rotation are implemented.
- The API owns manager commands and browser-bound acceptance. The durable worker
  uses a dedicated application credential, fixed template and provider
  idempotency per delivery attempt; no workflow/customer credential
  participates.
- The members page owns invitation management and the standalone route owns its
  fragment token and acceptance journey without Query cache or browser storage.
- Acceptance recovery now gives an unusable or expired continuation an ordinary
  sign-in/workspace-discovery exit, distinguishes expired recipient proof so a
  still-bound user can verify again, retires exact commands when reconciliation
  selects another intent, and fences workspace-opening cleanup from route
  disposal. A completed bound intent still requires the same authenticated user
  before its receipt is disclosed.
- Browser-binding replacement is one database transaction. A durable consumed-
  replacement claim, scoped by forced RLS to the prior binding's workspace, plus
  a transaction-scoped fence lets only one resolver replace a shared active
  prior binding. The claim carries only opaque successor coordinates, so the
  store can inspect a successor under that successor's own tenant scope without
  exposing its invitation details. Terminal or pruned successor journeys do not
  block a legitimate fresh invitation in another workspace, while an exact
  delayed retry cannot revive an abandoned successor or disturb its newer
  journey. An exact live retry after a committed but lost resolver response
  reproduces the same browser binding and reads its existing intent; a different
  invitation cannot take over that claim. Transaction rollback removes an
  uncommitted claim and preserves the prior binding if creation of the
  replacement fails. Completed acceptance retries validate a reused key's
  original request hash before returning the historical receipt; a new key may
  reconcile that receipt but cannot grant membership, restore a role, write
  another audit fact or rotate a session.
- A failed binding cleanup after acceptance no longer gates workspace access.
  The completed page stops retrying the stale invitation credential and offers
  ordinary workspace navigation/discovery, which remains subject to normal
  authentication and authorization. Cleanup and navigation callbacks remain
  fenced from route disposal, and a replacement journey in another tab is not
  cleared.
- The mounted acceptance route advances explicit journey ownership whenever a
  different invitation token is selected. It cancels abortable bootstrap,
  reconciliation, OIDC and cleanup work, retires the prior exact completion
  command, and ignores every late result from the former journey. An acceptance
  request already received by the server is not treated as undone; only its
  stale browser callback is fenced. Reopening the same token retains its normal
  exact-retry semantics.
- Corrective evidence before the `0097` restart repair: contracts passed 73/73
  with generated artifacts current; database unit tests passed 766/766; the
  disposable PostgreSQL identity suite passes 56/56, including exact committed
  replacement recovery, recovery racing another invitation, resend after the
  claimant becomes terminal, superseded/completed/pruned prior journeys, the
  connected A→B→C delayed-retry lifecycle, lineage traversal after the
  intermediate B intent is physically removed, a terminal successor in another
  workspace, simultaneous cross-workspace replacement, rollback, exact-key
  conflict and durable lock-order assertions. Retention and purge integration
  coverage proves that terminal claim lineages are reaped in bounded pages, live
  descendants survive intermediate-intent cleanup and cross-workspace purge,
  purge selects eligible claims from either the prior or successor side, legal
  holds retain claims, later terminal cleanup removes the surviving opaque
  evidence, and cleanup races real resolution and acceptance without duplicate
  membership or audit effects. Forward migration `0096` adds durable
  keyset/high-water scan progress: real PostgreSQL regressions cover a held
  oldest page, later terminal rows, new arrivals between runs, per-purge cursor
  advancement and reconsideration after hold release or descendant termination
  without unbounded scanning. The focused identity/retention/purge/legal-hold
  run passed 73/73, and the complete disposable PostgreSQL run passed 559/559
  across 85 files. The `0097` restart correction has additional
  disposable-PostgreSQL evidence for a completed non-empty purge scan followed
  by a later page, an empty completed scan followed by its first claim, and an
  arrival above the fixed boundary while the resumed bounded cycle is running.
  Those tests assert the durable cursor/high-water constraint after each
  transition, deferral to the next cycle, and eventual deletion; the existing
  held-page/legal-hold and full tenant-purge regressions remain green. On the
  current tree, the affected real PostgreSQL retention/purge suites pass 17/17
  and the migration repair/execution-mode suites pass 4/4. The complete database
  unit suite passes 767/767; database build/typecheck, schema ownership (5/5),
  architecture and diff checks pass. The 559/559 full disposable PostgreSQL
  result is retained as prior evidence and was not rerun for this narrowly
  scoped repair. The focused API invitation/contract tests pass 13/13 and the
  full API unit suite passes 1,314/1,314. Web component tests pass 190/190,
  including delayed completion and cleanup while a second token becomes current,
  and all 32 mocked-boundary Chromium journeys pass, including reopening the
  same email after response-and-cookie loss, reloading after the cookie arrives
  before an unreadable body, and cleanup rejection followed by ordinary
  workspace discovery without another cleanup request. Web build/typecheck/lint,
  affected backend typecheck, architecture, schema, contract and final diff
  checks pass. Changed-scope React Doctor remains 72/100 with 51 warnings; none
  points to the invitation files, so those unrelated diagnostics were not used
  as correctness evidence.
- The controlled real-API/OIDC suite has prior 9/9 evidence for old-cookie
  rejection and SSE shutdown, and now contains cookie-level exact resolver
  recovery plus same-user completion recovery assertions for response loss
  before and after replacement cookies. Its current rerun skipped all 9 tests
  because `API_IDENTITY_INTEGRATION=true` and an explicitly provisioned
  API/Redis integration environment were unavailable; these updated assertions
  are therefore not claimed as newly executed full-stack evidence.
- The 2026-09-22 invitation-hardening pass verifies the original authenticated
  user before every manager command dispatch, including exact uncertain retries;
  a changed identity cannot submit the retained body/key. Tokenless acceptance
  bootstrap failures now expose a working status-read retry. Parsed provider 5xx
  errors and concurrent-idempotency responses retain the sealed delivery
  attempt, while definite 4xx rejection remains terminal. Forward migration
  `0100` snapshots the workspace display name on each delivery attempt so an
  uncertain provider retry renders the same subject/body under the same provider
  key after a workspace rename. Unexpired completed receipt intents now remain
  live replacement-lineage descendants and fence delayed stale ancestors as
  specified above.
- Executed 2026-09-22 evidence: web component/unit 25 files / 224 tests; worker
  unit 60 files / 752 tests, including the real Resend-client-to-worker
  classification seam and repeat-render equality; database unit 113 files / 768
  tests; disposable PostgreSQL identity/workspace 60/60, including stable
  delivery snapshots and completed-successor fencing; migration execution and
  retained-repair 4/4; transient-retention 8/8, including the snapshotted
  delivery-attempt fixture; mocked-boundary Chromium 41/41, including tokenless
  failure/retry. Web/worker/database typechecks and builds, repository lint,
  schema ownership 5/5, architecture 19/19, contract generation check (with the
  existing identity-workspace OpenAPI 2XX warning) and `git diff --check`
  passed. Changed-scope React Doctor ran with untracked files included and all
  uploads disabled; its 26 advisory findings are pre-existing broad-component or
  heuristic diagnostics, including a false-positive cache-invalidation warning
  where the invitation hook explicitly invalidates after the awaited mutation.
  No finding established a regression in this pass.
- Controlled managed-provider email delivery, production sender/domain
  verification and Firefox/WebKit remain explicit environment gates until run;
  the slice is implemented and locally verified but is not fully
  production-verified before those gates pass.

#### 5. Overview: agree data semantics before adding aggregation

**Delivered (2026-09-25):** exact run counts now come from the bounded workspace
run-statistics read in
[ADR 044](../../docs/adr/044-bounded-workspace-run-statistics.md) (fixed
windows, one `asOf` snapshot, index-only plans). The rules below still govern
any further aggregate.

The original gate read: there is no dedicated product overview/aggregate API
yet. Start with bounded authorized workflow and run lists where they satisfy the
page; do not create a new service or durable read model merely to render a
dashboard.

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

### Remaining non-payment delivery plan

**Delivery update (2026-09-21):** N1, N2 and N3 are implemented in the working
tree with the evidence recorded below. The remaining entries are planned slices,
not delivered features. Billing, payments, subscriptions, invoices, checkout and
payment-provider integration are explicitly outside this work. Implement one
slice at a time; do not create all folders or expand the node runtime while
completing pages. N4 remains gated on a concrete supported artifact-valued
node/input use case. N5 remains gated on approved template examples and import
semantics. N6 remains gated on the product's usage units, purpose, period,
coverage and read policy. N5 and N6 are optional product increments, not release
prerequisites.

#### Common implementation contract

- Use the existing feature-first structure. Routes compose feature pages;
  `components/<responsibility>/` owns presentation, `*.api.ts` owns endpoint
  calls/decoding, `*.queries.ts` owns Query keys/options/invalidation, and a
  `mutations/` hook exists only when command coordination warrants it. Keep pure
  transformations beside their owner, not in catch-all utility files.
- Public schemas and transport types belong to `packages/contracts`; database
  models stay private to `packages/database`. Frontend display/form models stay
  in their feature. Export only deliberate cross-feature interfaces through
  `public.ts` or a focused lazy-safe public module. Do not copy backend DTOs.
- Query owns remote data, Router owns navigation/filter state, forms own input
  scratch. Only the existing route-scoped editor store owns unsaved graph state.
  Derive capability, validity and labels rather than storing duplicate booleans.
  No new global store, synchronization effect or manual memoization by default.
- Validate forms using the shared request schema and validate again at HTTP
  entry. Map validation to fields; use one visible owner for other errors.
  Distinguish unavailable, forbidden, empty, conflict and expired-session
  states. Keep submitted body/key/preconditions for uncertain commands; never
  replay a changed body with the old key. A success toast is not authoritative
  persistence.
- For every slice, use applicable skills from the existing skill-to-task map,
  preserve mechanical import rules, and run affected unit/contract/type/lint
  checks. Add real PostgreSQL coverage for changed persistence/authorization,
  browser behavior for visible flows, and React Doctor after React changes.
  Record executed evidence separately from mocks or unavailable environments.

#### N1. Workspace creation and first-workspace onboarding

**Delivered in the working tree (2026-09-21).** Workspace selection now uses one
feature-owned form for empty and populated discovery states. The command owner
preserves the exact validated body and idempotency key after an uncertain
response, verifies the original session identity before dispatch/retry, and
separates confirmed creation from discovery refresh so refresh recovery never
repeats `POST /v1/workspaces`. Changed identities retire the command and remove
the prior identity's discovery cache before route reconciliation.

Evidence executed for this slice:

- web component/routed suite: 199 tests passed, including nine focused creation
  regressions for first/additional creation, validation/focus/cancel, duplicate
  slug, forbidden access, exact uncertain retry, explicit abandonment, session
  change and discovery-refresh recovery;
- Chromium browser suite: 33 tests passed, including the 390 px reduced-motion
  empty-state journey, dialog focus/Escape restoration, shared transport headers
  and navigation to the authoritative empty workflow list;
- disposable PostgreSQL: the two focused workspace creation concurrency tests
  passed, proving one complete aggregate for duplicate slugs and one owner
  membership/audit fact for concurrent exact-key retries;
- contracts: 73 tests passed and generated artifacts matched; API contract unit
  tests: 3 passed; web production build, typecheck and lint passed; architecture
  and diff checks passed.

The existing real-API PostgreSQL test was inspected and covers CSRF, discovery,
owner capabilities, exact retry, changed-body conflict, duplicate slug and one
owner membership/audit fact, but it was not executed in this pass because its
separately provisioned `API_IDENTITY_INTEGRATION` environment was not used.
Chromium used controlled HTTP mocks; no managed OIDC provider, Firefox or WebKit
claim is made. React Doctor scanned the dirty branch (72/100); it reported only
pre-existing/out-of-scope diagnostics and none in the N1 files.

**Existing foundation:** `POST /v1/workspaces` accepts strict `{ name, slug }`,
requires cookie session, CSRF and an idempotency key, and returns the created
workspace. Reuse the shared name/slug validation and existing server-side
creation/owner policy; do not create a second onboarding endpoint.

- Entry: add Create workspace to workspace selection, including its empty state.
  Use one feature-owned form for first and additional workspaces. Do not force
  users with existing workspaces through an onboarding wizard.
- Form: labelled name and slug, shared constraints, editable slug suggestion
  only until the user edits it, inline validation and explicit submit/cancel. Do
  not silently rewrite a user-selected slug or preflight availability as a
  substitute for the authoritative create result.
- Own the form in `features/workspaces/components/creation/`; add transport and
  Query integration to the existing workspaces modules. No new feature package.
- On confirmed creation, invalidate the current identity's workspace discovery
  and navigate to the created workspace's workflow list. If discovery refresh
  fails, show a recoverable refresh error without submitting creation again. Do
  not fabricate cached memberships/capabilities from the workspace response.
- Handle duplicate slug/conflict, forbidden creation, invalid input,
  CSRF/session expiry and response loss. Disable duplicate concurrent
  submission; retain an exact retry after uncertainty and block changed-body
  resubmission until that attempt is resolved or explicitly abandoned under the
  existing contract.
- Acceptance: empty state → create → authorized empty workflow list; additional
  workspace creation; keyboard/focus/cancel; invalid slug; duplicate slug;
  lost-response retry creates exactly one workspace and owner membership;
  session change does not expose the previous identity's discovery cache. Verify
  existing API/database owner assignment and idempotency coverage before
  claiming reuse.

#### N2. Workspace display-name editing

**Delivered in the working tree (2026-09-21).** The strict conditional rename
command is `PATCH /v1/workspaces/{workspaceId}` with
`{ name, expectedRevision }`, session CSRF and an idempotency key. Workspace
discovery supplies the integer revision. The database command reauthorizes the
current actor and active workspace under locks, changes only the display name
and revision, and records one `workspace.renamed` audit fact. A completed exact
retry returns its historical result without reapplying an old name; a changed
body with the same key is rejected. Stale revisions require an explicit refresh
and user-confirmed reapply with a new command.

General settings now exposes a feature-owned edit section to actors with
`workspace:manage` and a read-only view to other members. The mutation owner
keeps the exact uncertain body, revision and key, verifies session identity
before every dispatch, separates command acceptance from discovery refresh and
fences late completions. Confirmed renames refresh the workspace selector and
shell while stable ID routes remain unchanged. No slug, ownership, membership or
lifecycle behavior was added. This followed the already approved capability and
command conventions and did not require a new architectural decision.

Evidence executed for this slice:

- shared contracts and generated artifacts: 73 tests passed; the existing
  Redocly warning for an invitation operation without a 2xx response remains
  unrelated to rename;
- disposable PostgreSQL: 58 focused identity/workspace tests passed, including
  exact and conflicting retries, concurrent renames, current-role
  reauthorization, inactive workspaces and audit cardinality; 43 RLS/schema and
  20 migration/readiness tests also passed;
- the full database integration run passed 562 of 563 tests while run in
  parallel with the browser suite; one unrelated 64 MiB observation test hit its
  five-second timeout and passed on focused rerun. Database unit tests passed
  767 tests and schema validation passed;
- API unit/integration-shaped suite: 1,320 tests passed and typecheck passed. A
  real HTTP/PostgreSQL rename regression was added, but the separately
  provisioned `API_IDENTITY_INTEGRATION`, database and Redis environment was not
  available for that gate;
- web component/routed suite: 205 tests passed, including authorized/read-only
  rendering, StrictMode submission, validation, exact uncertain retry, conflict
  refresh/reapply, capability loss, identity change and accepted
  command/discovery-refresh recovery;
- web production build/typecheck, lint and architecture checks passed; Chromium
  passed 34 journeys, including keyboard/native validation and the authoritative
  shell/selector refresh. Chromium used controlled HTTP mocks; no managed OIDC
  provider, Firefox or WebKit claim is made;
- React Doctor scanned changed and untracked files with uploads disabled
  (72/100). Its 51 diagnostics were pre-existing/out-of-scope findings; none
  identified an N2 source file.

The implementation below remains the lasting contract for this slice.

- Contract gate before implementation: propose a strict `{ name }` rename
  command under the existing workspace resource, authorized by current database
  `workspace:manage` and active workspace state. Confirm this policy and
  concrete HTTP method/path before publishing schemas. Specify an opaque
  precondition or revision, exact idempotent retry and a safe workspace
  response. Reuse existing command conventions; do not silently allow
  last-write-wins.
- Establish how clients obtain the rename precondition from an authorized read;
  do not use a formatted timestamp as an invented revision. Specify stale
  precondition, duplicate-key/different-body, forbidden and inactive-workspace
  errors in the shared contract. Review ADR applicability before adding policy.
- Backend: existing identity/workspace controller/use case and database adapter;
  transactional current-role/status checks, concurrent rename fencing, and safe
  audit fact with actor/workspace and approved changed fields. Add a
  forward-only migration only if revision/idempotency/audit persistence needs
  it.
- Frontend: General settings name section under
  `workspaces/components/settings/`, read-only without capability. Local edit
  scratch; explicit Save/Cancel; no autosave. Preserve input on conflict and
  offer refresh/reapply against a new revision, never automatic overwrite.
- Refresh workspace discovery and affected shell/general queries after confirmed
  success. Keep stable ID-based routes; renaming must not break deep links.
- Acceptance: authorized rename updates shell and selector; denied and inactive
  cases; two editors conflict safely; lost-response replay has one effect/audit;
  simultaneous role/lifecycle changes are reauthorized; cancel leaves no change.

#### N3. Overview without invented aggregate metrics

**Update (2026-09-25):** Home's header figures, the Loom caption and its lane
totals now use exact ADR 044 run statistics. The "no totals" rule below is
superseded for these run counts only; trends, rates, usage and incident
semantics stay excluded.

**Delivered in the working tree (2026-09-21).** The optional workspace Overview
route composes three independently authorized, cached and recoverable source
queries: five recently managed workflows ordered by parent lifecycle/publication
metadata, five recent runs and five runs whose status is exactly `failed`.
Draft- only saves do not advance the parent workflow timestamp. It exposes no
totals, rates, trends, usage claims or incident semantics. Actors without a
card's source capability do not issue its request. Each card owns loading,
empty, failure, retry and last-successful- refresh presentation; manual refresh
and focus refresh preserve independent query results.

The workflow list contract gained only the optional `updated_desc` order. Its
opaque cursor has a distinct variant and retains PostgreSQL microsecond
precision; migration `0099_workflow_recent_list.sql` adds the matching
`(workspace_id, updated_at DESC, id DESC)` index, and the typed Drizzle schema
declares the same index. Existing created-order callers remain unchanged. Run
cards reuse the existing newest-first run contract and failed-status filter.
Source feature Query interfaces own transport/cache keys, and workflow
creation/publication plus run acceptance/cancellation invalidate the
corresponding source scopes.

Evidence executed for this slice:

- contracts: 73 tests passed, generated artifacts matched and OpenAPI lint
  retained one unrelated invitation warning;
- API: 1,321 tests passed, including order forwarding and cursor-variant
  regressions;
- disposable PostgreSQL: the complete integration suite passed 85 files and 563
  tests. The focused recent-workflow regression paginates updates at `.000100Z`
  and `.000900Z` without duplicates or omissions; database unit tests passed 767
  tests and migration/schema/readiness checks passed;
- web component/routed suite: 209 tests passed, including bounded request
  shapes, independent card recovery, StrictMode and denied-card request
  suppression; production build/typecheck and lint passed;
- Chromium exercised the responsive Overview, source links, mobile drawer,
  explicit refresh and exact query filters; the complete Chromium suite passed
  35 journeys. Chromium used controlled HTTP mocks; no live backend/provider,
  Firefox or WebKit claim is made;
- React Doctor scanned changed and untracked files with uploads disabled
  (72/100, 51 diagnostics). None names an N3 source file; reported items remain
  previously triaged test-secret false positives and pre-existing complexity,
  lifecycle, cache and accessibility hypotheses outside this slice.

The implementation below remains the lasting contract for this slice.

**Initial scope:** an optional `B/overview` destination, not a new landing page.
Version one shows bounded recent lists only: five recently updated workflows,
five recent runs, and five failed runs labelled “Recent failed runs.” A failure
is not an unresolved incident. No totals, trends, success percentages, usage
meters or synthetic event feed in this slice.

- Contract gate: confirm existing list filters, descending ordering and stable
  tie-breakers support each card. Where unsupported, add the smallest scoped
  list-query contract/index; do not fetch all history or sort a single arbitrary
  page and claim it is the most recent. Cards describe retained available data,
  not lifetime history or a fixed reporting window.
- `features/overview/` owns page/card composition. Consume deliberately exported
  workflow/run Query interfaces; existing features retain transport ownership.
  Add no overview service unless an actual missing contract requires one.
- Fetch authorized cards independently. Denied cards make no requests; empty,
  loading and failed cards remain distinct, with per-card retry. One failed card
  must not erase successful cards or turn failure into a zero count.
- Query policy: identity/workspace/filter-scoped keys, 30-second stale time,
  refetch on window focus and an explicit Refresh action; no background polling
  in version one. Show last successful refresh information without suggesting
  the three requests are an atomic snapshot. Existing mutations invalidate the
  corresponding source queries, including these list variants.
- Links open the source workflow/run or appropriately filtered run history. Keep
  graph/draft state out of Overview. Follow existing shell and card design,
  semantic tokens, loading patterns and keyboard-accessible links.
- Acceptance: exact ordering/limit/status semantics; permission and tenant
  isolation; independently failed/empty cards; focus/manual refresh; no
  unbounded reads; browser navigation into existing editor/run pages; no
  invented metrics. Aggregates remain a later separately defined slice under the
  preceding rules.

#### N4. Artifact input upload, then optional asset discovery

**Gate:** select an existing supported node/input contract that accepts an
artifact reference before adding upload UI. Current artifact metadata/download
UI and upload/finalize contracts are foundations, not evidence of browser upload
support. Do not invent artifact-valued inputs for nodes that cannot execute
them.

- First slice is an input-local upload, owned by `features/artifacts` and
  exposed through its public interface to the consuming feature. No
  asset-browser page is necessary for this slice. Persist only the finalized
  artifact reference in workflow input; never a `File`, signed URL, storage key
  or byte buffer.
- Flow: select file → validate supported size/type → compute SHA-256 → request
  upload → PUT exactly the signed bytes/headers → finalize → attach
  authoritative available artifact. Do not report completion after PUT alone.
- Specify a browser-safe size ceiling based on measured hashing/memory cost
  before enabling selection; the API's 5 GiB ceiling is not a browser memory
  budget. Large-file streaming/worker hashing needs its own validated design.
- Keep file/progress/cancellation local to the upload lifecycle; do not retain
  file contents or signed credentials in Query, persisted stores, logs or error
  telemetry. Query may cache safe metadata. Reuse exact command keys where the
  contract requires them; distinguish upload failure from uncertain
  finalization.
- A dedicated artifact transfer adapter is the only exception for signed
  external PUTs; review the existing raw-fetch/import rule rather than bypassing
  it inside a component. Send no session cookies or API CSRF headers to object
  storage.
- Prove real-browser signing, browser-controlled Content-Length, allowed
  origins, preflight, required headers, checksum mismatch and expiry against a
  disposable storage environment. Verify finalization retries, auth loss,
  cancellation, navigation/unmount and abandoned-upload cleanup. Do not claim
  abort deletes an already uploaded object or automatically allocate a second
  artifact on retry.
- Asset discovery is a separate follow-on: define bounded cursor listing, safe
  metadata, supported filters, download/use permissions and expired/pending
  visibility first. No listing endpoint is currently assumed. Delete/retention
  management is excluded unless separately authorized.

#### N5. Optional curated workflow templates

**Proposed bounded scope:** a chooser inside workflow creation, not a
marketplace, public publishing system or separate management console. Confirm
actual template examples before implementation; this is not required to finish
N1–N4.

- Define a versioned safe manifest and catalog compatibility check. A template
  contains supported node types/versions, graph/configuration and presentation,
  never credentials, workspace IDs, historical runs or legacy backend payloads.
- Establish import/create semantics in contracts before exposing a chooser:
  validate through normal authoring rules, allocate new workflow/node identities
  and remap every edge/reference consistently. Required connections remain
  explicitly unconfigured; never copy another workspace's connection IDs.
- Prefer repository-owned reviewed examples initially. Use existing create/save
  commands if they support safe recovery; otherwise define the minimum atomic or
  resumable command rather than leaving silent orphan drafts after partial
  import.
- `features/workflows/components/templates/` owns chooser presentation; the
  owning authoring module owns instantiation/validation. Publish/run remain
  explicit later user actions, not import side effects.
- Acceptance: incompatible/unknown catalog entry rejected clearly; graph and
  references remapped; no secret/cross-tenant leakage; duplicate-click and lost
  response recovery; resulting draft opens, validates and can be configured.

#### N6. Optional non-billing usage reporting

**Decision-gated, not implementation-authorized:** usage is not payment work.
Before building this page, select measurement units and purpose (for example
retained execution counts or storage consumption), period/timezone, retention
coverage, refresh delay and read capability. Do not invent quotas or pricing.

- Specify each counter's authoritative source, treatment of retries/canceled
  runs, period boundaries and unknown/partial retention coverage. If no durable
  source exists, explicitly defer that counter rather than estimating it from
  paginated UI data or relabelling Prometheus infrastructure metrics.
- Define a bounded workspace-scoped read contract with period, measured-through
  time and coverage semantics. Use scoped SQL first; introduce a durable rollup
  only after measured need and an accepted architectural decision, including
  backfill/reconciliation and late-arrival semantics.
- A future `features/usage/` page owns filters and read-only presentation; URL
  owns reporting period, Query owns results. Render stale/unavailable separately
  from zero. No upgrade buttons, invoices, checkout or payment SDKs.
- Acceptance: exact period boundaries, retry counting, retention/late data,
  permission/tenant isolation, bounded query performance and browser period
  navigation. Product choices above must be resolved before a coding prompt.

#### Node editor status and a separate authoring increment

The editor already places catalog definitions, renders nodes/ports/edges, edits
labels and primitive/enum configuration (with advanced JSON fallback), selects
connection references, saves with conflict recovery, validates/previews,
publishes and starts runs. Run detail displays the versioned execution graph and
node statuses. Node execution is backend-owned, not JavaScript executed by the
canvas.

Do not equate this with a complete visual data-mapping experience:

- `inputMappings` are preserved in the graph, but the current inspector does not
  provide controls to edit them. New nodes begin with empty mappings.
- Nested object/array configuration relies on advanced JSON, not specialized
  nested form controls. Catalog credential requirements are not automatically
  equivalent to supported connection selectors.
- Local edge checks are limited; backend graph validation remains authoritative
  for semantic validity. Unknown definitions remain visibly unsupported and
  preserved rather than silently substituted.

#### M1. Visual input mappings

**Status (2026-09-21): implemented with focused mocked-browser and real-engine
evidence; live browser/backend execution remains outstanding.** N1–N3 and M1 are
ready for the planned integrated review. Do not invent an artifact-consuming
node for N4 as part of that review. Payments remain excluded.

##### Existing contracts and execution semantics

- `packages/workflow-model/src/graph-contract.ts` defines
  `inputMappings: Record<string, ValueSource>`. Browser callers already obtain
  the graph through the reviewed workflow-authoring contract. Derive mapping
  types from that contract; do not copy the discriminated union into web code.
- Existing variants are `literal` (`value`), `run_input` (`path`), `node_output`
  (`nodeId`, `path`), `expression` (`language: 'jsonata'`, `expression`,
  `policyVersion`) and `structured_input` (`port`, `path`). M1 offers creation
  and editing of the first three only. Preserve expression/structured mappings
  unchanged as labelled advanced rows; allow explicit removal with confirmation,
  but no implicit conversion or expression evaluation in the browser.
- Mapping keys are top-level keys in the resolved input object, not edge-port
  names and not destination JSON paths. For example key `customer` with source
  `{ kind: 'node_output', nodeId: 'source-id', path: '$.customer' }` produces an
  input property named `customer`. A key containing a dot remains a literal key;
  do not transform it into nested assignment. Literal null is a value; missing
  paths cause omission in the engine, not automatic null/default substitution.
- `graph-validation.ts` allows node-output sources only from a direct local
  predecessor connected by an edge. Never offer arbitrary ancestors, self,
  downstream nodes or nodes inside another structured body. Output paths address
  the source node's output value, not a made-up envelope keyed by output port.
- `workflow-engine/src/operations.ts` resolves these sources into the input
  object; trigger source definitions receive run input directly. Do not imply
  editing mappings changes trigger execution. Match the actual trigger-source
  definition policy before enabling its mapping section; do not infer this only
  from a decorative catalog family label.
- `catalog` exposes `inputSchema`, `outputSchema`, ports and definition version.
  Use schemas for field suggestions/descriptions, not as proof of runtime data.
  Dynamic object schemas need custom top-level keys; bounded support must not
  make `core.set` unusable merely because it lacks enumerated properties.
- Reuse the existing browser-safe `@pertexo/workflow-model/json-path` parser
  after confirming its package export and browser allowlist. Its dialect
  supports `$`, dot properties, numeric array indices and quoted bracket
  properties; no wildcard, filter or JSONata syntax in a path field. Do not
  import server-only mapping/expression modules or implement a second parser.
  Add only a narrowly reviewed schema-only contract export if individual mapping
  validation needs it.

##### UI and ownership

1. Add an Inputs section to the selected ordinary node inspector. Each row has a
   destination key, source-kind selector, source controls, error text and
   Remove. Provide Add input, useful empty-state copy and schema-based key
   suggestions. Clearly distinguish configuration, execution input mappings and
   edge routing.
2. Literal rows accept JSON values without coercing numbers/booleans/null into
   strings; provide clear JSON validation. Run-input rows accept a path. Node-
   output rows choose a directly connected predecessor (label plus stable ID
   disambiguation) and a path, with `$` as the explicit whole-output choice.
   Path suggestions must not claim every field exists or fetch all prior runs.
3. Put presentation under
   `workflow-editor/components/inspector/input-mappings/`, split by cohesive
   responsibility (section, row, source controls) only where useful. Put pure
   row-to-contract conversion, source options and validation under
   `workflow-editor/model/input-mappings.ts` or a small owner-local directory.
   Do not append another large feature to `workflow-inspector.tsx`, add a global
   mapping store or spread new files into shared components/lib folders.
4. Integrate mapping scratch with the existing inspector Apply/Cancel and dirty
   state. The draft graph remains the only persisted authority; Apply updates
   the selected node atomically through the current editor command/history seam,
   and Cancel never changes graph state. A rejected row does not partially apply
   other rows. Node switches, route changes, incoming snapshots and save actions
   must obey existing scratch/dirty-exit behavior rather than silently
   discarding edits. Extend persisted-node comparison to include mappings where
   necessary.
5. Use stable UI row identity independent of the editable destination key;
   reject duplicate keys before conversion to a record. Preserve unknown or
   currently unsupported existing rows, including keys not suggested by schema.
   Use safe own-property/object construction for arbitrary keys such as
   `__proto__`; never mutate prototypes or silently discard valid existing data.
6. Label changes must not rewrite ID references. Removing the last connecting
   edge or a referenced source node leaves the mapping visibly invalid until
   explicitly repaired/removed; do not silently remove it or synthesize edges.
   Reconnecting a valid source can repair the mapping. Undo restores graph and
   mapping validity together. Unsupported definitions remain preserved.
7. Reuse existing permission/read-only behavior, focus/error IDs, keyboard and
   responsive inspector layout. Only current draft editing may mutate mappings;
   historical run graphs remain read-only. Do not add an effect or memo merely
   to derive source choices, validity or serialized state.

##### API, validation and save behavior

- Reuse current draft read/save, validation, preview, publish and run endpoints.
  No mapping-specific persistence table, backend endpoint, node executor or
  migration is expected. If a genuine missing contract prevents this slice,
  document it before expanding scope rather than inventing frontend-only data.
- Apply performs structural/path/duplicate/reference checks and shared contract
  admission. Schema suggestions are not a replacement for backend semantic
  validation, particularly dynamic values, branch outputs and input types.
  Preserve existing save/validation distinction: unsupported or semantically
  invalid drafts must not become silently sanitized valid graphs.
- Use current serialized ETag save and conflict/uncertain-outcome recovery.
  Mapping edits must participate in dirty tracking, undo/redo, snapshot
  comparison and reconciliation exactly like configuration edits; no separate
  autosave. Map authoritative `inputMappings` validation issues to the
  appropriate row or section, with an accessible summary fallback when paths
  cannot be resolved.
- Preview must use the existing explicit sample-input/upstream-output contract;
  saving a mapping does not magically provide execution data for a preview.
  Never silently select a historical run as the mapping's runtime source.
  Runtime values/credentials stay out of persistent editor preferences/logs.

##### Implementation order and acceptance evidence

1. Confirm the current implementation has not already added part of M1.
   Establish the graph update/history and inspector scratch seams; add pure
   model tests for all three editable variants and preservation of the other
   two.
2. Implement the feature-owned UI and graph updates; integrate backend
   validation paths and existing save/conflict handling. Add behavior tests as
   each part is completed, not only at final handoff.
3. Cover add/edit/remove/apply/cancel; typed literals including
   null/arrays/objects; duplicate/special keys; valid/invalid paths;
   direct-predecessor filtering; missing/deleted source and disconnected edge;
   label rename; unsupported mappings/definitions; read-only state;
   selection/route changes; and keyboard focus. Verify unrelated config,
   connections, positions and mappings survive.
4. Cover mapping-only dirty detection, exact save/reload, undo/redo, serialized
   saves, conflict comparison/reapply and lost-response reconciliation. Browser
   tests must edit through rendered controls, not seed the entire mapping into a
   mocked draft and claim creation coverage.
5. Use an existing side-effect-free example: `core.manual` → `core.set` with a
   real edge. Set `customer` from the manual node's `$.customer`, another field
   from run input and a literal field; save/reload, publish/run with explicit
   sample input, and verify the target's actual input/output values. Add a
   missing-path case proving omission rather than null substitution. Use
   existing engine/API integration seams and a disposable environment, never a
   production workflow. Distinguish mocked UI round-trip, real engine resolution
   and a live browser/backend run; if the latter cannot run, report the specific
   gate and do not mark end-to-end verification complete.
6. Run affected web unit/component tests, typecheck, lint, build, browser
   journeys, React Doctor and architecture/import checks; run model/engine/API
   tests if their seams change or provide necessary mapping proof. Update this
   section with files and actually executed evidence, preserving outstanding
   limitations.

##### Delivery evidence (2026-09-21)

- The ordinary-node inspector now owns mapping scratch alongside configuration:
  feature-local section, row and source-control components author literal JSON,
  run-input paths and direct-local-predecessor output paths. Expression and
  structured-input rows remain labelled, unchanged advanced values unless the
  user confirms removal. Apply is atomic through the existing graph history
  seam; Cancel, dirty navigation, undo/redo, conflict comparison and serialized
  saving include `inputMappings`.
- Pure mapping logic derives its wire types from the shared workflow graph,
  validates exact duplicate destinations and the shared JSON-path dialect,
  constructs null-prototype records, filters node-output sources to direct
  predecessors and matches trigger sources by exact definition identity. The
  shared graph parser now preserves own mapping keys including `__proto__`,
  `constructor`, `toString` and escape-prefix collisions without mutating the
  admitted immutable snapshot or changing object prototypes.
- Backend validation findings targeting `inputMappings.<key>` focus the matching
  row when it exists and retain the general accessible fallback otherwise.
  Unknown schema keys and unsupported mapping variants survive unrelated edits.
- Executed web checks: typecheck and lint passed; 25 Vitest files / 218 tests
  passed; production build passed. Mocked-boundary Chromium passed the focused
  editor journey (11/11) and the complete web suite (36/36). The rendered
  journey created literal, run-input and predecessor mappings through the
  controls, autosaved, reloaded and restored them; read-only controls were also
  checked.
- Executed shared checks: workflow-model 9 files / 112 tests and workflow-engine
  32 files / 376 tests passed, including real engine resolution for
  `core.manual` to `core.set`, typed literal/run/upstream sources and
  missing-path omission. Workflow-model and workflow-engine typechecks, the 19
  architecture checks, contract generation/check (with the existing
  identity-workspace OpenAPI 2XX warning) and `git diff --check` passed.
- React Doctor ran against changed and untracked web files with score/telemetry
  and supply-chain uploads disabled. Its 71 advisory warnings include known
  broad-component/command-lifecycle findings and two false-positive
  missing-label reports for the new native selects; both selects have matching
  `htmlFor`/`id` associations. The inspector dirty callback effect is required
  by the existing single dirty-state ownership seam. No M1 diagnostic
  established a regression.
- Not executed: a live API/database browser journey that publishes and runs the
  mapped workflow, or Firefox/WebKit coverage. The engine proof is real runtime
  resolution, while the browser evidence uses controlled HTTP mocks; therefore
  M1 is not claimed as live-provider/backend end-to-end verified.

After M1 implementation, reconcile stale roadmap summaries and prepare one
integrated review of N1–N3 plus M1 against the agreed baseline. Do not
auto-start uploads, templates, usage, JSONata editing, nested loop editing or
credential authoring. Those remain separate decisions, not prerequisites for
completing M1.

#### U5 — workflow identity and name-based run discovery

**Delivery status (2026-09-21): implemented; required local gates pass.** The
reviewing task owns this plan. The implementation task follows it and reports
concrete blockers instead of replacing it with another roadmap. This closes the
remaining U5 gap only; it does not reopen the completed audit slices.

Implementation evidence: shared contracts now expose the optional nullable
read-only `workflowName`, normalized `workflowNamePrefix`, and the exact
workflow-summary route. The database read model uses one workspace-scoped join,
literal LIKE escaping and unchanged microsecond keyset ordering; the exact
authoring read stays under its reader/RLS transaction. The API derives name
visibility from centralized capabilities, leaves command receipts unchanged, and
binds normalized prefixes into cursors. The web renders current names in
history/detail/Overview, keeps IDs secondary, uses an exact metadata Query in
the editor, and owns applied prefix filters in the URL.

Executed evidence: contracts 74/74; API unit 1325/1325; database unit 768/768;
focused disposable PostgreSQL authoring/run reads 23/23, including prefix
escaping, archived metadata, microsecond pagination, exact lookup beyond 100
workflows and normal-planner `EXPLAIN (ANALYZE, BUFFERS)` coverage over 10,000
runs. The measured emitted row instances were 10,100 absent / 851 selective /
15,120 common / 0 no-match / 10,120 combined / 7,120 deep-cursor; rejected-row
work was respectively 0 / 41 / 22 / 42 / 2,522 / 4,022. Their sums are plan-node
work, not unique rows visited. Root shared-buffer touches were 182 / 11 / 189 /
1 / 189 / 189. The normal planner chose a sequential run scan without a prefix
and nested-loop plus bitmap scans for prefix cases. On this representative
fixture, selective and no-match work stayed small while broad prefixes
necessarily touched more rows, so the evidence did not justify a schema change;
it is not a general production-performance guarantee. Web 221/221; production
build/typecheck/lint; Chromium 40/40; focused U5 Firefox 15/15 and WebKit 15/15;
architecture, generated-contract and diff checks. The disposable real-HTTP API
lane passed 16/16 suites and 66/66 tests against PostgreSQL/Redis, including the
U5 projection, archived exact metadata and literal-prefix assertions. Browser
journeys use controlled HTTP fixtures; they are not a deployed
browser-to-provider test. React Doctor changed-scope reported 50
existing/whole-diff warnings and no confirmed U5 regression; its score is not a
completion claim. Coordinated client/API deployment remains required for this
unreleased strict-response change.

**User-visible outcome and scope**

- Run history, run detail and Overview recent-run cards display the workflow's
  **current name**, with workflow/run IDs secondary and available in full for
  copying. Duplicate names remain distinguishable by identity. The editor header
  also displays the current workflow name through an exact metadata lookup.
- Run history gains a field labelled **Workflow name starts with**, so a person
  does not need a UUID to find runs. Keep the exact workflow-ID filter as an
  optional advanced filter. This is literal prefix matching, not fuzzy search,
  substring search, an autocomplete catalog or a scan of downloaded workflows.
- A current name is not the name at execution time. Run inspection and replay
  continue to resolve the immutable `workflowVersionId`; never resolve the
  latest graph instead. Do not add name snapshots, rename commands, execution
  changes, billing, uploads, templates or a general search service.

**1. Shared contracts and compatibility**

- In the workflow-runs HTTP contracts, introduce a read-summary schema extending
  the existing `workflowRunSummarySchema` with optional nullable `workflowName`
  (the existing workflow-name constraints). Use it only in list and get
  responses. The new server emits a string or `null`; a new client treats a
  missing field from an older server as unavailable. Keep start, replay and
  cancel summaries/receipts unchanged, including idempotency replay bytes.
- Add optional `workflowNamePrefix` to the existing list query: trim outer
  whitespace, require 1–128 characters after trimming, reject invalid lengths.
  The UI omits blank input. Match case-insensitively using PostgreSQL `lower` on
  both operands under the database's existing locale; do not promise accent
  folding. Escape `%`, `_` and the escape character as literals before `LIKE`.
  Prefix, exact ID, status and time predicates combine with AND.
- Add `GET /v1/workspaces/:workspaceId/workflows/:workflowId`, returning a
  strict `{ workflow: WorkflowSummary }` response using the existing summary
  schema. This is metadata only, not a draft/graph read. Register the route,
  projections, browser-safe exports and generated contract artifacts through
  existing seams.
- Do not call this universally backward compatible: older strict clients may
  reject enriched responses. Record the coordinated deployment requirement for
  this unreleased app; do not claim rolling mixed-version support without proof.
  New UI must not silently ignore unsupported filtering on an older API.

**2. Authorization and read-model ownership**

- Run reads retain `run:read` and their current workspace lifecycle policy.
  Names additionally require `workflow:read`. Derive that decision through the
  existing centralized capability policy from a freshly validated authorization
  context, not client input or hard-coded role lists. Existing roles currently
  have both capabilities; keep that distinction explicit for future policies.
- A run-readable caller without workflow-read permission receives `null` names
  and may still read runs. A name-filter request without workflow-read
  permission is denied before querying metadata, using the established
  disclosure/error policy; never silently ignore the filter. Do not catch
  arbitrary authorization or database failures and disguise them as a missing
  name.
- An issued context is bound to its capability. Do not reuse a `run:read`
  context as a `workflow:read` authorization proof. The metadata GET uses its
  own normal authoring read authorization and reader check, with the same
  lifecycle allowances/disclosure behavior as the existing authoring list.
- Extend run **read projections**, not worker/runtime run records or command
  persistence contracts. The run feature owns mapping to the HTTP read summary;
  the authoring feature owns exact workflow metadata reads. No generic
  repository framework or cross-feature transport calls are needed.

**3. Database queries and pagination**

- Implement exact metadata lookup through the existing authoring read store:
  explicit workspace and workflow-ID predicates, existing tenant transaction,
  reader checks and forced RLS. Do not search the first page of workflow lists.
- Enrich run list/detail using a workspace-scoped left join on workflow ID and
  workspace ID, or one bounded batch within the same tenant transaction. Never
  issue one lookup per row. Preserve runs without a visible workflow summary;
  their names are `null`, not grounds for dropping the run. Do not exclude
  archived workflow metadata when the existing authorization permits reading it.
- Apply the name predicate in SQL before the page limit. Preserve run ordering
  `created_at DESC, id DESC`, the existing microsecond cursor timestamps and
  `limit + 1` behavior. A join must not duplicate rows. Filtering by current
  name may change membership after a concurrent rename; this is not historical
  snapshot pagination and must not be described as such.
- Bind cursors to the normalized prefix as well as the existing workspace and
  filter tuple. Accept legacy cursors with no prefix only for no-prefix
  requests. Normalize absent legacy prefix to `null` before comparison; reject
  altered filters/workspace and malformed cursors through existing invalid-query
  errors. Emit the existing cursor shape for unfiltered requests where
  practical; do not lower precision by round-tripping cursor timestamps through
  JavaScript Date.
- Inspect `EXPLAIN (ANALYZE, BUFFERS)` on disposable representative data for no
  prefix, selective/common/no-match prefixes, combined filters and deep cursors.
  Existing `(workspace_id, name, id)` does not prove support for `lower(name)`.
  Add a scoped functional prefix index only if the plans justify it; do not add
  an extension or claim LIMIT alone bounds scan cost. If needed, append the next
  migration after the actual current head, keep typed schema/readiness/migration
  bookkeeping consistent, and test fresh and prior-head upgrades. Never rewrite
  the existing 0099 migration or published migration history.

**4. Frontend ownership, state and presentation**

- `features/workflow-runs` owns its query schema use, filter model, API
  parameters, query keys and presentation. Router search parameters own applied
  filters; a form may own only unapplied text. Apply/clear resets pagination.
  Back/Forward restores filters. Include normalized prefix in query identity and
  never show results for an old filter as if they belong to the new one.
- Run pages and Overview consume names from the enriched run read response, not
  per-row queries or a global workflow catalog. Existing loading/error/retry and
  identity/workspace cache fences remain authoritative. Clear sensitive cached
  metadata with existing membership/session invalidation; do not mask permission
  failures with cached names. Keep Overview's independent card recovery.
- `features/workflows` owns exact metadata transport and Query options, keyed by
  user, workspace and workflow ID. Export a narrow query interface for the
  editor through the established public seam. Fetch once for editor identity
  without coupling name loading to draft revision, save ETag or graph state. A
  metadata failure must not erase edits or disable otherwise authorized draft
  editing; show a local fallback/retry. Do not duplicate the name in
  Zustand/local state.
- Prefer existing small components and semantic tokens. Show “Workflow name
  unavailable” for absent metadata, not “deleted”; display the actual ID
  alongside that fallback. Preserve native links, visible focus, full accessible
  labels, copy access and existing run/version identity. Long names may truncate
  visually but must not force viewport overflow or hide the only way to discover
  identity.
- Keep feature-local components separate by responsibility, not one large page
  component or a generic application-wide identity framework. No new effects,
  memoization or state merely to mirror query results. Scope any genuinely
  shared presentational identity component to its existing feature/public
  interface.

**5. Verification and completion gates**

- Contract tests cover old-server missing names, new nullable/string names,
  unchanged command responses, prefix validation and generated route artifacts.
- Database/API tests cover tenant isolation, metadata permission enforcement,
  exact lookup beyond the first 100 workflows, archived/missing metadata,
  duplicate names, literal wildcard/backslash input, non-ASCII names, combined
  filters and empty results. Test a permission-limited policy seam without
  changing production roles or forging issued authorization contexts.
- Prove stable tie/microsecond pagination, no duplicates/skips for unchanged
  data, legacy cursor handling and mismatched-prefix rejection. Demonstrate
  bounded query count as page size grows and record representative query plans.
- Component tests exercise Apply/clear/Back/Forward, pagination reset, query-key
  isolation, name fallbacks, denied/error recovery, editor metadata failure and
  no loss of dirty draft. Regression-test cancellation/replay updates so a
  command summary lacking a name cannot erase or corrupt the read cache.
- Browser verification covers history → name filter → detail, Overview → detail,
  and editor identity at desktop and 320/390px widths with long/duplicate names,
  keyboard use and secondary IDs. Run Chromium plus focused Firefox/WebKit.
  Include a disposable real API/database journey for prefix filtering and name
  projection; distinguish this from mocked UI evidence and deployed-provider
  verification. Exact-version rendering/replay must remain unchanged.
- Run affected contract, database, API and web tests, build/typecheck/lint,
  architecture, generated-contract, schema (if touched) and documentation
  checks. Use relevant React/Query skills during implementation and React Doctor
  after React edits; its score is not a correctness gate. Inspect rendered UI,
  not just test exit codes. Record executed commands, results and skipped gates.

**Execution order and handoff**

Implement contracts → authorized database/API reads and filtering →
feature-owned frontend → integrated verification. Keep changes in the existing
dirty worktree and preserve unrelated work. No commits, pushes or merges are
authorized by this slice. Do not create another planning/audit file or add an
ADR for these routine read-model extensions. If implementation reveals a new
consequential policy or architecture decision, stop and report the evidence to
the reviewing task. Update this section and U5 in `FRONTEND-AUDIT.md` with
actual evidence at completion; until all required gates pass, U5 remains
partial. Do not label blocked or mocked checks as live verification, or mark the
whole application fully verified.

#### Workflow rename, current failure alert and version compare

**Delivered in the working tree (2026-09-25).** ADR 041 gives the workflow name
its own revision, exposed as `nameRevision` in every summary, so a rename never
collides with an archive/restore (ADR 034) or the draft ETag (ADR 011).
`POST …/workflows/:workflowId/rename` takes `{ name, expectedNameRevision }`,
CSRF and one `Idempotency-Key`, needs `workflow:update` on an active workflow,
answers `200 { workflow, replayed }` and reports a stale revision as the typed
`409 workflow.name_conflict` problem.
`GET …/workflows/:workflowId/failure-notification-policy` returns the current
destination in the destination read projection, or `null`.

- The workflow hub bar, the Settings tab's Identity section and the list row
  menu (“Rename…”, a dialog) all rename through `useWorkflowRename` and the
  shared `InlineRename`/`RenameForm` pattern, which the workspace name field now
  uses too. The form sends the revision the edit started from, so a background
  refresh never turns a stale edit into an overwrite; a conflict loads the
  workflow again and asks “Use theirs / Keep mine”. Archived workflows and roles
  without `workflow:update` read the name only.
- Settings → Failure alerts shows the current destination in words (or that
  alerts are off, or that the chosen destination is turned off) and refreshes it
  after every set/clear attempt. The “write-only” note is gone.
- Versions offers “Compare versions” once there are two: any two versions, in
  either order, reusing `diffWorkflowGraphs` through the shared
  `VersionDiffSummary` that the preview sheet also uses.
- The workflow list draws the empty thread for workflows without steps, leaves
  out the run-strip note until the workspace has runs, and `WorkflowListHeader`
  takes an `actions` slot (the page passes `NewWorkflowButton`) instead of a
  `showCreate` flag.

Evidence: contracts 80/80; database unit 769/769 and the full disposable
PostgreSQL integration suite 584/584 (88 files, including rename receipts,
races, rollback, archived read-only, legacy receipt replay and the policy read's
role/tenant matrix); API unit 1,420/1,420; the real HTTP API lane against a
throwaway database ran 42 tests (rename, lifecycle, version restore and
identity) with the artifact, SSE, webhook and rate-limit lanes skipped by their
own gates; web 59 files / 434 tests, production build, typecheck and
zero-warning lint. `pnpm test:coverage` passed and the risk report recorded 0
unreviewed and 406 reviewed branches across 195 selected files. Browser journeys
were not run for this slice; jsdom component tests cover the new flows.

#### Completion and one integrated audit

**Corrective audit update (2026-09-21):** the S1–S4, B1–B4, V1 and U1–U7
findings recorded in `FRONTEND-AUDIT.md` have been worked through. All confirmed
bounded defects are fixed; S3/S4 retain their existing cohesive owners with a
documented no-change rationale. U5 now implements authorized current workflow
names, exact editor metadata and literal name-prefix run filtering, and its
required local gates pass. Final evidence includes web 221/221, workflow-model
112/112, workflow-engine 376/376, database unit 768/768, disposable PostgreSQL
565/565 (including focused U5 PostgreSQL 23/23), real API integration 66/66,
Chromium 40/40 and focused U5 Firefox/WebKit 15/15 each. Browser evidence uses
controlled HTTP mocks; provider/deployed-worker and physical-device verification
remain outside these claims.

For each selected slice record implementation, executed verification and
remaining environment gates separately here. Run focused checks while
implementing; do not postpone permission, data-loss or migration issues to the
final audit. Once the selected slices are complete, perform one fixed-baseline
integrated review of their changes and real journeys: sign in → create/select
workspace → author and save nodes → publish/run → inspect results, plus
applicable invitations, rename and upload paths. Cover state/effect redundancy,
types, feature ownership, error/retry consistency, API/database authorization,
accessibility, responsive layout, cross-browser behavior and
deployment/proxy/session/SSE operation. Use a disposable integration environment
and record skipped checks honestly. Do not reopen settled architecture or
implement deferred product scope merely to obtain a higher audit score.

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
