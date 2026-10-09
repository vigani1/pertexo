# Frontend architecture

How `apps/web` is built: who owns which state, how features talk to the API,
where code goes, the visual system and the tests that hold it together.
[README.md](README.md) covers setup and current capabilities, and
[AGENTS.md](AGENTS.md) covers agent instructions. Backend contracts, the
[domain vocabulary](../../CONTEXT.md) and accepted ADRs stay authoritative;
update this guide when a decision changes, not with progress notes.

Start with [the architecture in one minute](#1-the-architecture-in-one-minute),
[folders](#2-folders-and-dependency-direction) and
[state ownership](#3-exactly-who-owns-each-kind-of-state); the later sections
cover contracts, HTTP and auth, queries, forms, the editor, errors, streams,
visual design, tests, placement and the screen map.

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

### Fixed choices

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
their feature-owned controlled state and shared Zod parsing, with submit-time
messages and focus, and on-change correction of a field showing a message. A
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
      root/                     # route tree, root layout, pending/not-found pages
      auth/                     # login, sign-up, password, invitation routes
      workspace/                # workspace shell and its section routes
      workflow/                 # workflow hub, build, runs, settings routes
    features/
      auth/                     # session query and login/logout behavior
      workspaces/               # discovery, membership and workspace UI
      workflows/
        data/                   # workflows.api.ts (requests and decoders),
                                # workflows.queries.ts, *.mutations.ts
        pages/                  # workflow-list.tsx and other screens
        components/             # feature presentation
        hooks/                  # feature hooks
        model/                  # pure rules
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

Grouping within a feature:

- Keep the `pages`, `components`, `model`, `data`, `forms` and `mutations`
  vocabulary; inside them, group a real cluster of files by what it serves
  (`components/list/`, `model/graph/`). A folder holds at most about ten files;
  no one-file folders for symmetry.
- A hook used by one UI area sits beside that area; a hook shared by several
  sits at their narrowest common owner. Pure rules are named functions in
  `model/`, never inside UI.
- Name a file for what it exports, with a domain qualifier where `data`,
  `state`, `thread` or `command` would be ambiguous. Tests mirror the source
  layout under `test/features/`.

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
  public.ts                   # only what outside callers actually need
  <responsibility>.public.ts # optional loader/command interface kept separate from a lazy page export
  pages/                      # screens a route renders (lazy-loaded)
  components/                 # separate feature-owned visual responsibilities
    <meaningful-name>.tsx
    <sub-area>/               # group a substantial area when needed
  hooks/                      # use-* hooks that give the feature behavior
  data/                       # server access
    <subject>.api.ts          # requests and response decoding
    <subject>.queries.ts      # scoped keys and query options
    <subject>.mutations.ts    # server commands and cache effects
    mutations/                # one command hook per file when there are several
  forms/                      # form UI and its input validation schemas
  model/                      # pure rules, transformations, complex local state
```

Only the public entry files sit at a feature's root; everything else lives in
the folder for its role. Create a folder only when the feature has such files.
Do not create empty folders, a store for every feature or a hook for every file.
Tests mirror the owning feature under `test/features/`; shared test setup stays
in `test/support/`.

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
  system. Follow section 11's visual rules.

#### Before coding and before calling a slice done

Before each approved slice, identify its scope, file ownership, public
interface, state owners, API/shared contracts, error/validation behavior and
observable acceptance tests. Keep this a short task checklist, not another
architecture document. Resolve consequential departures from this standard
before implementing them; do not reopen settled choices for routine work.

Before handoff, check that no giant component/hook, duplicated writable state,
private cross-feature import, speculative abstraction or unnecessary CSS layer
was introduced. Run the applicable tests and import/lint checks from section 13
and meet section 14's definition of done. Mechanical checks support this
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

| Kind                                                    | Source of truth                                                                           | Browser usage                                             |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| HTTP request/response schemas and inferred types        | `@pertexo/contracts` (`packages/contracts/src/schemas/<area>/`)                           | Import from the package root                              |
| Problem codes and shapes                                | `@pertexo/contracts` (`packages/contracts/src/errors/`) plus endpoint-specific extensions | Parse once at the transport/endpoint boundary             |
| Graph, node, edge, mapping value shapes                 | `@pertexo/workflow-model`                                                                 | Shared portable validation/types, not copied interfaces   |
| Definition identities/config schemas/ports/availability | Authenticated catalog API                                                                 | Query live release; do not bundle an independent registry |
| UI node appearance, field state, edit commands          | Owning frontend feature                                                                   | Local types, referring to shared domain types             |
| ORM records, persistence envelopes, use-case types      | Backend/database packages                                                                 | Never imported by the web app                             |
| Executable node implementations, compile/evaluate logic | Backend runtime packages                                                                  | Never shipped to the browser                              |

`@pertexo/contracts` is browser-safe: request, response and problem schemas
only. `@pertexo/contracts/server` holds the OpenAPI documents and client
contracts, projected when imported; the web never imports it, and the
browser-entry check proves the package root reaches no Node module.
`@pertexo/workflow-model` is browser-safe; `@pertexo/workflow-model/server`
(checksums, expressions, authoring validation) is not. Do not import node
executors or `@pertexo/node-sdk/server` just to obtain a type.

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

### Auth and deployment

Default to **same-origin `/v1`**: a development proxy and production reverse
proxy serve the API under the web origin. Preserve actual `/v1` paths, cookies
and headers; do not invent an `/api` rewrite. The API has no CORS setup, so
direct cross-origin credentialed requests are not an implemented alternative. A
different topology needs deliberate CORS, cookie, CSRF and exposed-header
configuration and real-browser verification.

Better Auth is the only session authority (ADR 039). The web signs in through
`/v1/auth/sign-in/email`, `/v1/auth/sign-up/email` and
`/v1/auth/sign-in/social`, each with a fixed same-origin `callbackURL`; account
security lives under `/v1/auth/account-security`. `pertexo_session` is HttpOnly;
`pertexo_csrf` is readable and is echoed as `x-csrf-token` for mutations. Never
read a session token into JavaScript. Authenticated fetches use cookie
credentials, and the SPA requests `/v1/users/me` before protected loaders run.

On explicit logout/identity change: stop streams/timers, invalidate the scope
generation, abort reads, dispose editor/form state and remove protected query
and mutation caches. Late results must not repopulate the next user's state.
Workspace changes use the same scope discipline and first resolve dirty edits.
Session expiry freezes writes; same-user recovery may preserve the in-memory
draft only while it is fenced from other identities. Confirm identity before
resuming, refetch server baseline and run the conflict rules. Never silently
resume a pending write under another identity.

A full-page social sign-in destroys in-memory editor state. Do not automatically
redirect a dirty editor and claim its edits will survive; warn before that
navigation. Recovering in the same open tab after signing in from another tab is
permissible only after identity verification.

Auth guards are UX, not security. Backend guards remain authoritative. Workspace
discovery must expose enough current membership/permission information to drive
honest controls; do not copy backend policy engines into the frontend.

### Routes with protocol obligations

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
[identity controllers](../../apps/api/src/workspaces/http/controllers.ts),
[session controller](../../apps/api/src/workspaces/http/session-controller.ts),
[authoring controller](../../apps/api/src/workflow-authoring/http/controllers.ts),
[run controllers](../../apps/api/src/workflow-runs/http/controllers.ts),
[connection controllers](../../apps/api/src/connections/http/controllers.ts),
and [public contracts](../../packages/contracts/package.json).

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
`useFieldValidation` (`components/ui/use-field-validation.ts`): messages appear
on submit (or an explicit action such as adding an email chip, `report`), never
while people type or move between fields, so the form doesn't shift under them;
a field that showed a message since the last submit is re-checked as people
type, so it updates and clears once fixed; submit focuses the first invalid
control in document order; and server field errors (`errors[].path`, mapped by
the feature to known fields only — never arbitrary object paths) land on the
same fields through `showErrors`. Plain text forms may use the thin
`useFieldValues(rules, initial)` layer over it. Render every labelled control
with `LabelledField` (`components/ui/field.tsx`, optional label action, trailing
control and live-feedback slots), which links `aria-describedby` and sets
`aria-invalid`; an invalid control draws its border in the error colour and the
message sits below it — no line or glyph under the control. Keep a form-level
`Notice` for failures without a known path. The editor's step panel has no
submit (it applies valid values as people type), so its fields
(`useInspectorDraftField`, `useInputMappingDraft`) show a problem once people
leave the field or input row, then follow their typing until it's fixed.

Node inspectors use **live apply**, not an Apply button. Each field keeps its
own text (`components/inspector/use-inspector-draft-field.ts`): a value that
parses is committed straight into the editor store as an undoable step —
consecutive edits of the same field within two seconds coalesce into one step —
and the save coordinator writes the draft after a one-second pause, serialized
with the draft's ETag. Text that doesn't parse stays in the field as an
unfinished local edit with its message; the store's `inspectorScratch` flag then
keeps the save state from reading “Saved”, pauses automatic checks, blocks
publish and runs (“Finish or discard the unfinished edit…”), asks Stay/Discard
before a command would replace the inspected step (another step, undo/redo,
deleting it) and asks before leaving the editor. No effect copies keystrokes
between stores.

The Inputs tab lists each mapping as a compact `field ← source` row
(`input-mappings/mapping-summary.tsx`, words from
`model/inspector/mapping-summary.ts`): the field, the source as a chip (a step ›
path, the run input, the loop item, a fixed value or an expression with its code
under it) and the value type. The row is the disclosure button for its editor,
which opens in place; rows that need attention and rows made there start open,
and Fix opens the row it names before focusing its field.

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

Switch cases, Parallel branches and Validate rules have list builders
(`workflow-editor/components/inspector/builders`, model in
`model/inspector/setup-builders.ts`). Each reads the stored list only when it
can write it back exactly, and otherwise leaves the list on JSON; each applies
live like any other field. A case or branch whose output still has a connection
can't be removed from the builder, since publication rejects an edge leaving an
unconfigured port (ADR 018, ADR 019). New steps start from
`model/graph/starting-config.ts`: a schema-valid setup the editor chooses (two
branches, one case, bounded HTTP limits, a Merge joining the only Parallel on
its level), because the catalog publishes no defaults and a definition's schema
can't change in place (ADR 010).

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
3. The user selects an available catalog definition (the add-step lens groups
   steps under the blueprint's headings and, while browsing, folds Switch,
   Parallel and Merge into one row that opens in place; a search lists each on
   its own). An editor command assigns a fresh graph-instance ID using browser
   UUID generation accepted by the shared ID contract. The node records
   definition `{key, version}`, configVersion, configuration, mappings,
   connection references and position as required.
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
   above it) through `model/graph/graph-scopes.ts`, then writes that level back
   as one undoable graph change. Connections never cross a body's edge; a body
   is stored in the layout it is shown in before its first change.
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
report. Whole-draft validation returns the required strong ETag of the exact
checked server snapshot (ADR 053); the feature API decodes `{ report, etag }`,
rejecting missing or malformed metadata as a protocol failure. Associate it with
the requested saved ETag/local generation/revision. A different checked tag
stays readable but stale and cannot authorize publication; local edits during
the check also block a new publication. Reuse requires matching tags,
generation/revision and the current authenticated editor scope. Mark it stale if
editing continues. Unavailable checks honor Retry-After with a minimum
five-second cooldown for manual/automatic validation and new publication
preparation; no command is automatically replayed. Node preview supplies
expectedRevision; whole-draft validation cannot be presented as proof about
unsaved local data.

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
pinned atomically by the backend. ADR 061 adds optional
`expectedPublishedVersionId` as a checked-publication precondition, not an
arbitrary version selector. The editor's Run actions open explicit real-effect
confirmation and capture that version with input/deadline/key. A typed case-list
rollout-unavailable response instead allows deliberately confirmed ordinary
unchecked starts; pending or other failed reads cannot imply that availability.
Loaded cases and previously submitted checked commands cannot downgrade, and
frozen recovery always uses its original intent. A typed
`workflow.published_version_conflict` means no new run started; read and review
the current publication deliberately before confirming a new command. Never
automatically rewrite a case's version or a retained command. Exact uncertain
retries keep all original values, block replacement starts and stop at the
original 24-hour recovery window. A previously accepted command can replay its
accepted run even after another publication; retain its ID if fresh opening
identity cannot be confirmed, then open it explicitly without another POST. Show
the actual workflowVersionId from the accepted response. Legacy omission still
means current-at-admission; explicit replay has its own contract.

Named input cases remain owned by `workflows`, with one shared browser/editor in
the workflow hub and run-input dialog, not a test executor or new route.
Metadata pages alone live in scoped Query caches; opened payloads, detached
loaded copies and conditional command bodies stay in their local owner. Reads
validate the body's opaque representation tag against the response ETag. Owner
disposal, read denial or lost edit authority aborts held reads, fences late
results and evicts scoped metadata. CRUD requires fresh identity and
`workflow:update`; case loading uses `workflow:read` independently from
`run:start`. Editing/deleting a saved case never rewrites the already loaded run
intent. Conflict preserves typed edits until an explicit current-case read;
uncertain changes retain original body/tag/key and block replacement. The
default-off compatible-writer gate returns a truthful unavailable state; command
unavailability retains recovery identity because it cannot prove a previous
command was not accepted. Synthetic input warnings do not imply automatic
redaction. Only an explicitly confirmed real start executes a workflow. Never
represent “Save”, “Publish”, “Run”, “Test execute” or “Cancel run” as
interchangeable actions. After a step test finishes, the bar under the canvas
(`chrome/test-result-bar.tsx`) sums it up from the preview and the graph only:
its status, the path into the step (`model/test-path.ts`), its duration and, for
a failure, its reason, with View output opening the step's Test tab at the
remembered result. The next edit to the draft puts it away. Side-effecting
preview must be clearly labeled/confirmed; closing its panel is not execution
cancellation.

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

## 11. Visual design

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

### Weft design system

Status: **applied to every page** (Home, Runs and run detail; Workflows and the
hub; the editor, publish and catalog; connections, alerts and workspace
administration; sign-in, invitations and workspace entry). A uniformity pass
then folded each area's own copies of shared concepts into one implementation
each (listed under “Shared building blocks”); new work reuses those instead of
adding variants. The visual reference is the Weft blueprint
([`docs/design/weft-blueprint.html`](../../docs/design/weft-blueprint.html),
open it in a browser); this section is the binding summary for code. The
palette, the particle orb, the aurora edge and glass stay — each with one job.

#### Five materials, one rule each

| Material  | Meaning                                                                                                            | Rule                                                                                                         | Implementation                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Thread    | A run moving through time: grows while running, knots on success, stops at a cross on failure, coils while waiting | Every status in the product speaks the thread glyph language                                                 | `components/ui/status.tsx` (`Status`, `StatusGlyph`, `StatusTone`)                                     |
| Loom      | Time laid sideways, one lane per workflow                                                                          | Charts come from real run times, never invented metrics                                                      | Runs feature (Home and the Runs "Loom" view); step thread view on run detail                           |
| Core      | The living particle orb                                                                                            | At most one large animated Core per screen                                                                   | `components/patterns/core-orb.tsx` + `core-orb-scene.ts` (Canvas 2D, token colours, paused off-screen) |
| Lens      | Glass                                                                                                              | Only layers that float above the page: spine, bars, inspectors, dialogs, menus, toasts. Page content is flat | `lens` utility in `styles/globals.css`; `components/ui/sheet.tsx`, dialog, popups                      |
| Live edge | The aurora travelling around a border                                                                              | Only while real work is in flight; nothing moves when nothing happens                                        | `live-edge` class (animated `@property` angle, bounded to the element)                                 |

#### Tokens and type

- Keep every existing colour token. Added: `success` #8fe3c0, `warning` #f3c677,
  `raised` #212428, `subtle-foreground` #7f8b8e, `border-strong`. Cyan means
  brand, focus and _live work_ — never success.
- Things people press are calmer than live work: `action` (a softer cyan,
  `oklch(0.82 0.11 205)`, with `action-hover` and `action-foreground`) fills
  primary buttons, checked controls, the current tab and the calendar day, and
  is the focus `ring`; it never glows. The full `primary` cyan stays for live
  edges, selection on the canvas, running counts and the Core. Inputs have a
  neutral border (`control-border`); focus draws a soft ring, not a glow.
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
- Glass: everything that floats is one material in three weights. Chrome (spine,
  bars, inspectors, dialogs, sheets, ⌘K) uses `lens` (`--glass-background`,
  62%). Popups that open over rows (menus, selects, popovers, toasts and the
  new-failure notice) use `popup-lens` (`--glass-popup`, 70%) with a harder
  blur, so the page shows through as colour and light, never as text. Tooltips
  stay nearly solid. Dialogs and sheets sit on a `scrim` that dims and blurs the
  page instead of blacking it out. With `prefers-reduced-transparency` or no
  backdrop blur, every weight falls back to a solid surface.
- Textures: `warp` (page background threads), `weave` (canvas and run maps),
  `ambient` (two slow aurora blobs in the shell). All decorative layers are
  `aria-hidden` and motion stops under `prefers-reduced-motion`.

#### Status language

Features map their own enums to a `StatusTone` in their `model/` (for example
`features/workflows/model/workflow-state.ts`). Never colour a status ad hoc.

| Tone        | Glyph (motion)                | Used for                                                             |
| ----------- | ----------------------------- | -------------------------------------------------------------------- |
| `live`      | light travels along a thread  | running runs/steps/previews, starting activation, info notifications |
| `queued`    | three beads brighten in turn  | queued runs, pending/ready steps                                     |
| `waiting`   | a slowly turning coil         | waiting runs/steps, scheduled retries, stopping                      |
| `success`   | knot                          | succeeded, healthy, enabled, live workflows                          |
| `failure`   | cross (the thread stops at ×) | failed, error, unhealthy, revoked-by-failure                         |
| `timeout`   | thread stopped by a bar       | timed out                                                            |
| `attention` | dotted gap, slow blink        | outcome unknown, degraded, reauthorization required                  |
| `canceled`  | cut thread                    | canceled, revoked, archived                                          |
| `skipped`   | dashed thread                 | skipped branches                                                     |
| `neutral`   | hollow bead                   | drafts and states without meaning                                    |

#### Shared building blocks

One implementation per concept; features compose these rather than restyling
their own:

| Concept        | Where                                                                     | Use                                                                                                                                                                                                                                                                                                                               |
| -------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Field          | `components/ui/field.tsx`                                                 | `LabelledField` (label, optional label action, trailing control and live feedback; links hint and message), `FieldControl` holds a control and anything inside its edges                                                                                                                                                          |
| Deadline       | `components/ui/deadline-field.tsx`, `components/ui/calendar.tsx`          | `DeadlineField` for the Run and Replay lenses: None, In 1 hour, In 1 day or Pick a time, where a date (typed, or from a `Calendar` lens with past days disabled) and a 24-hour time are read on the person's clock with their time zone named. Never the browser's native picker; its value is local `datetime-local`-shaped text |
| Validation     | `components/ui/use-field-validation.ts`                                   | `useFieldValidation`: the only message timing (on submit, then live until fixed; focus first invalid; server `errors[].path`); `useFieldValues` is the thin values-and-rules layer for plain text forms                                                                                                                           |
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
line, actions), `CommandPalette`, `JsonTree`, `SystemState` (its art — a thread
drawing, an icon or the Core — sits on the page, never in a framed box; in the
shell the state reads from the left, a full screen centres it), thread
illustrations. The Core's particles grow in number with its size and each is
capped in size, so a large Core (sign-in) stays fine-grained. Other libraries
(`lib`): `format-time.ts` (all date/time/duration text — no feature-local
`Intl.DateTimeFormat`; `formatDateTimeInZone` reads a time on a named clock with
its zone name; `formatShortTime` is the locale's time to the minute, “Saved
14:31” and the stale line, while `formatClock` keeps seconds for logs; durations
have one compact style, `0.12s`, `4.2s`, `1m 12s`, `2h 05m`, and relative times
the narrow one, `3m ago`), `format-bytes.ts` (byte sizes for files and
payloads), `format-initials.ts`, `api/api-error-copy.ts` (generic read/command
failure sentences, uncertain outcome, forbidden, rate-limit and support
reference helpers), `use-prefers-reduced-motion.ts`, `use-online-status.ts`.

The inbox's new-failure notice is the one anchored toast. It uses its own Base
UI toast manager (`features/inbox/components/arrivals/inbox-arrivals.tsx`), not
a second toast system: a thread leaves the Inbox destination and stops at the
failure glyph where the notice opens. It never shows on the inbox page, failures
arriving together share one notice, and the first summary a tab loads announces
nothing. Base UI turns swiping off for anchored toasts, so the notice brings its
own (`use-arrival-swipe.ts`): dragging it toward the Inbox, left from the spine
or down into the phone bar, dismisses it like the close button, and it stays
unread.

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
  150 ms (`defaultPendingMs`), fading in, for only as long as the load takes
  (`defaultPendingMinMs` 0: the fade already keeps a short one from flashing):
  `PagePending` inside the shell, `WorkflowHubPending` in the hub,
  `WorkspaceBootPage` (“Opening Northwind Ops…”, then “Still connecting…” after
  2 s) for a cold workspace and `BootPage`/`OpeningPage` for public pages.
  `Skeleton` and `SkeletonThread` stay invisible for their first 150 ms and then
  fade in over 250 ms, so an in-page skeleton never flashes either. A page
  change that waits on the scope's session check (it runs again on every
  navigation) keeps the current page on screen, and `NavigationProgress`
  (`routes/navigation-progress.tsx`, in the root layout) draws a slim spooling
  thread along the top from the router's pending state after the same 150 ms; it
  holds still under reduced motion and never shows on a cold start, which has
  the boot page.
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

- ESLint keeps Node and backend imports out of `src`, allows only the
  browser-safe `@pertexo/contracts`, `@pertexo/workflow-model` and
  `@pertexo/templates` doors, restricts raw `fetch` to the transport adapters,
  and keeps `components/` and `lib/` from importing features, routes or `app/`.
  Extend those rules in the slice that introduces a new boundary, with
  representative allowed and forbidden imports.
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
- Keep both Playwright lanes in CI: journeys against the mocked API drive the
  production browser, transport and decoders, and browser journeys against the
  real stack run from the API integration suite with isolated users and
  workspaces. Do not put test bypasses into production auth.

### Required regression scenarios, introduced with their slice

| Boundary            | Proof                                                                                                                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transport           | Valid success/204, malformed JSON/schema, common and extended problems, missing ETag, abort/timeout, safe fallback, CSRF and credential handling                                       |
| Session/scope       | Sign-in return, login/logout, expired session, two identities/workspaces, late response after logout, connection 401 does not log out user                                             |
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

## 14. Definition of done for each feature

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
6. README's capabilities and this guide follow the change; no separate progress
   or audit documents.

This guide settles recurring conventions and expensive boundaries early. It does
not guarantee bug-free implementation; small slice-level checks and real-browser
evidence remain necessary. They should validate these decisions, not restart the
architecture discussion every time a feature is added.

## 15. Function placement and component composition

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

## 16. How skills are applied

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

## 17. Screen-and-journey map

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
