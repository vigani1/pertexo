# Frontend architecture

How `apps/web` is built: who owns which state, how features talk to the API,
where code goes, the visual system and the tests that hold it together.
[README.md](README.md) covers setup and verification, and [AGENTS.md](AGENTS.md)
covers agent instructions. Backend contracts, the
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

| Concern                    | Choice                                               | Scope                                                                     |
| -------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------- |
| App/build                  | Existing React 19, TypeScript, Vite, pnpm workspace  | Keep pinned foundation versions; no stack migration                       |
| Navigation                 | TanStack Router, code-based routes                   | URL parameters, validated search, loaders, pending/error states           |
| Server state               | TanStack Query                                       | Cached API snapshots, loading, mutations and invalidation                 |
| Client state               | React locally; provider-scoped Zustand for editor    | No global business-data store                                             |
| Canvas                     | React Flow (`@xyflow/react`)                         | Controlled rendering and gestures behind an adapter                       |
| HTTP                       | Native `fetch`, one small shared transport           | JSON/errors/cookies/cancellation; no Axios or generated SDK initially     |
| Static forms               | Existing controlled React forms + shared Zod schemas | Keep one owner per form; adopt RHF only through a deliberate replacement  |
| Dynamic node configuration | Catalog-driven, bounded field renderer               | Advisory client checks; backend semantic validation remains authoritative |
| UI                         | Existing shadcn **Base UI** setup, CVA, Tailwind 4   | Owned primitives and semantic tokens, not mixed Radix/Base recipes        |
| Motion                     | CSS first                                            | Add a motion library only for a demonstrated interaction requirement      |
| Tests                      | Vitest/Testing Library, MSW, Playwright              | Model, component/network, and real-browser integration seams              |

React Hook Form is not installed in the delivered frontend. Existing forms keep
their feature-owned controlled state and shared Zod parsing, with submit-time
messages and focus, and on-change correction of a field showing a message. A
future RHF adoption must deliberately replace that ownership across a bounded
form slice; it must not introduce a second form authority inside existing forms.
Dependencies named as future additions are **not installed by this plan**;
verify compatible versions when that slice is implemented.

## 2. Folders and dependency direction

[Web workspace rules](AGENTS.md#layout) own the folder map, feature entries and
conventions for placing new code. Routes compose feature pages and pass in the
same API and Query dependencies their loaders use. Feature modules never import
the shell to obtain those dependencies.

The always-loaded shell reaches features through their routing and query
entries. Keep views out of those entries so a loader or search parser cannot
pull a page or the editor canvas into the initial bundle. Routes render feature
pages, while endpoint requests and response decoding live in feature data
modules.

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

Query snapshots and unsaved drafts live in memory. Appearance is a
[browser-local preference](../../docs/feature-plans/36-light-theme.md). An
unload warning cannot restore edits after a crash.

## 4. Shared packages, API contracts and types

| Kind                                                    | Source of truth                                                                           | Browser usage                                                |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| HTTP request/response schemas and inferred types        | `@pertexo/contracts` (`packages/contracts/src/schemas/<area>/`)                           | Import from the package root                                 |
| Problem codes and shapes                                | `@pertexo/contracts` (`packages/contracts/src/errors/`) plus endpoint-specific extensions | Parse once at the transport/endpoint boundary                |
| Graph, node, edge, mapping value shapes                 | `@pertexo/workflow-model`                                                                 | Shared portable validation/types, not copied interfaces      |
| Definition identities/config schemas/ports/availability | Authenticated catalog API                                                                 | Query current catalog; do not bundle an independent registry |
| UI node appearance, field state, edit commands          | Owning frontend feature                                                                   | Local types, referring to shared domain types                |
| ORM records, persistence envelopes, use-case types      | Backend/database packages                                                                 | Never imported by the web app                                |
| Executable node implementations, compile/evaluate logic | Backend runtime packages                                                                  | Never shipped to the browser                                 |

`@pertexo/contracts` is browser-safe: request, response and problem schemas
only. `@pertexo/contracts/server` holds the OpenAPI documents and client
contracts, projected when imported; the web never imports it, and the
browser-entry check proves the package root reaches no Node module.
`@pertexo/workflow-model` is browser-safe; `@pertexo/workflow-model/server`
(checksums, expressions, authoring validation) is not. Do not import node
executors or `@pertexo/node-sdk/server` just to obtain a type.
`@pertexo/integrations` was reviewed for the HTTP form editor: its root exposes
browser-safe schemas/types and declarative definitions only. The editor shares
multipart metadata/value bounds from this root; availability still comes from
the authenticated catalog. Its `/server` entry and HTTP encoder/transport stay
forbidden in browser imports. The web import allowlist and project reference
admit only this reviewed root; the production Vite build verifies that boundary.

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

Password sign-in can return a two-factor challenge instead of a session. The
sign-in lens then verifies an authenticator or recovery code using the plugin's
HttpOnly challenge cookie. Account setup draws its QR code locally. Passwords,
keys and recovery codes stay in the mounted form, outside Query and mutation
caches; recovery codes are displayed once and require a saved confirmation.

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
[identity controllers](../../apps/api/src/workspaces/http/workspaces.controller.ts),
[session controller](../../apps/api/src/workspaces/http/session.controller.ts),
[authoring controller](../../apps/api/src/workflow-authoring/http/workflow-authoring.controller.ts),
[run controllers](../../apps/api/src/workflow-runs/http/workflow-runs.controller.ts),
[connection controllers](../../apps/api/src/connections/http/connections.controller.ts),
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
2. Use two command tiers, with one key rule (`useHeldCommandKey`): a send reuses
   the held key while its input is unchanged, so a resend after a lost response
   (network, 5xx or protocol error) replays the server's receipt; a changed
   input gets a new key; success or a refusal that settled the key releases it
   (401, 403 and 429 come before the key lookup and keep it). Changes whose
   resend a revision or absolute state guards (rename, organization, input-case
   updates, member/lifecycle changes and governance settings) use native
   mutations through `useLowEffectMutation`, refresh current reads after every
   outcome and keep inputs editable; past the receipt window they take a new
   key. Creates the server can tell apart only by their key (workflow create,
   duplicate and import, input-case and workspace create) go through
   `useCreateCommand`, which also offers the exact resend and refuses to send
   past the receipt window until the person starts a new attempt. Effectful
   operations (run, publish, tests, task decisions, webhook/federation commands
   and secret/link issuance) retain the original body, preconditions and key
   within their receipt window, with the existing identity fence. Never persist
   secrets in a retry journal or offline mutation cache.
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
   catalog semantics, connection access and publish/run admission. Frontend
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
(`input-mappings/summary.tsx`, words from `model/inspector/mapping-summary.ts`):
the field, the source as a chip (a step › path, the run input, the loop item, a
fixed value or an expression with its code under it) and the value type. The row
is the disclosure button for its editor, which opens in place; rows that need
attention and rows made there start open, and Fix opens the row it names before
focusing its field.

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
`useSchedulePreview` hook in `workflow-testing/public.ts`: debounced by 500 ms,
asked again once the first time passes, with a loading line, one failure line
with Retry (an unschedulable rule, rate limiting or a failed read) and nothing
at all for an unfinished rule. The editor inspector provides the hook's
`SchedulePreviewScope` (API client and workflow) once, so no inspector layer
threads it through; without that scope nothing is shown.

Switch cases, Parallel branches and Validate rules have list builders
(`workflow-editor/components/inspector/builders`, model in
`model/inspector/setup-builders.ts`). Each reads the stored list only when it
can write it back exactly, and otherwise leaves the list on JSON; each applies
live like any other field. A case or branch whose output still has a link can't
be removed from the builder, since publication rejects an edge leaving an
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
   Quick add (a link dropped on empty canvas, or “Add step after” on the step's
   ⋯ menu) is likewise one command that adds the step and its link. A For each
   is projected as a container card around its structured body (ADR 020); the
   projection never changes the stored graph. Its body is edited in place: body
   steps are the container's React Flow children, positioned relative to the
   body's corner, and every command resolves a step or link to its level (the
   workflow or a body, named by the For each steps above it) through
   `model/graph/scopes.ts`, then writes that level back as one undoable graph
   change. Links never cross a body's edge; a body is stored in the layout it is
   shown in before its first change.
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
publish actions restricted as appropriate to current backend contracts.

### Save coordinator invariant

Use a small explicit state machine in the editor feature, not network calls
inside Zustand setters. State distinguishes clean, dirty, saving, conflict,
failed and uncertain outcome. It keeps the acknowledged graph/tag, current edit
generation and in-flight snapshot identity. No independent `isDirty` flags that
drift from graph/history/form state.

- One save in flight per editor. Debounce 1 s after a completed edit transaction
  (live-applied inspector edits land here too, so a busy session stays well
  inside the draft-save limit); coalesce drag updates into one history/save
  transaction on gesture end. Manual Save flushes and awaits acknowledgment.
  Test with fake clocks; tune debounce from interaction evidence, not throughout
  components.
- Undo/redo changes the working graph, not the last server ETag. Bound history
  (initially 100 coherent transactions) and profile representative large graphs;
  do not clone the entire graph on each pointer movement.
- Track which graph was acknowledged. If edits occur while saving, response A
  must not replace newer graph B or mark B saved. A background refetch may
  update a clean baseline only through the coordinator; never during a
  conflicting or uncertain save. Dirty editors get remote-change information,
  not replacement.
- ETags are opaque and can change with representation even when revision does
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
confirmation and capture that version with input/deadline/key. Loaded cases and
previously submitted checked commands cannot downgrade, and frozen recovery
always uses its original intent. A typed `workflow.published_version_conflict`
means no new run started; read and review the current publication deliberately
before confirming a new command. Never automatically rewrite a case's version or
a retained command. Exact uncertain retries keep all original values, block
replacement starts and stop at the original 24-hour recovery window. A
previously accepted command can replay its accepted run even after another
publication; retain its ID if fresh opening identity cannot be confirmed, then
open it explicitly without another POST. Show the actual workflowVersionId from
the accepted response. Legacy omission still means current-at-admission;
explicit replay has its own contract.

Named input cases remain owned by `workflows`, with one shared browser/editor in
the workflow hub and run-input dialog, not a test executor or new route.
Metadata pages alone live in scoped Query caches; opened payloads, detached
loaded copies and conditional command bodies stay in their local owner. Reads
validate the body's opaque representation tag against the response ETag. Owner
disposal, read denial or lost edit authority aborts held reads, fences late
results and evicts scoped metadata. The server authorizes CRUD with
`workflow:update`; case loading uses `workflow:read` independently from
`run:start`. Editing/deleting a saved case never rewrites the already loaded run
intent. Conflict preserves typed edits until an explicit current-case read;
unclear changes refresh metadata and keep edits for a new explicit confirmation
with a fresh key. Synthetic input warnings do not imply automatic redaction.
Only an explicitly confirmed real start executes a workflow. Never represent
“Save”, “Publish”, “Run”, “Test execute” or “Cancel run” as interchangeable
actions. After a step test finishes, the bar under the canvas
(`chrome/test-result-bar.tsx`) sums it up from the preview and the graph only:
its status, the path into the step (`model/test-path.ts`), its duration and, for
a failure, its reason, with View output opening the step's Test tab at the
remembered result. The next edit to the draft puts it away. Side-effecting
preview must be clearly labeled/confirmed; closing its panel is not execution
cancellation.

## 9. Errors and recovery belong at the right level

The application owns one browser session-change connection and one
session-expiry handler. The API client reports every `auth.unauthenticated`
answer, from a query, a mutation or a direct command, through
`onSessionExpired`, and the router (`app/router.ts`, `app/session-pause.ts`) is
its one owner; no command handles it itself. A rendered page outside Build never
unmounts when its session ends: the session pause (`features/auth`, held in
router context) hides the page and every other top-level layer (open dialogs and
menus) behind "Sign in again", keeping them mounted so unsaved input stays in
its components. There is no draft store. Sign-in opens in a new tab and
announces itself; the paused tab then checks who is signed in (also on focus and
on Continue). The same account resumes the page as it was and refetches its
reads; another account clears the cache, remounts the page from scratch and says
the input was discarded. A cross-tab session signal pauses the same way while it
checks. Only while a navigation is loading does a refusal still sign out through
the route guard. The Build editor keeps its own pause, fenced into its save
pipeline. A command that finds an unexpected account calls `reportSessionChange`
instead of handling it locally. Local private-payload owners observe the session
notification to cancel reads and clear payloads; they do not verify session or
membership around writes. Only `auth.unauthenticated` ends the application
session, and it is never access loss: `isAccessLost` excludes it. An action's
403 stays local feedback about that action; it does not establish that readable
data is lost. Authoritative GET denial (403, 404) still hides snapshots through
`readAccessLost`, `shownData`, scoped read disposal and QueryView recovery.
Effectful exact retries keep their identity fences.

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

| Situation                                      | Owner and user behavior                                                                           |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Invalid form input / recognized field errors   | Form: inline errors, retain values, focus correction                                              |
| `auth.unauthenticated`                         | Auth lifecycle: freeze writes, recover login safely, prevent redirect storms                      |
| A connection whose credential needs replacing  | Connection feature: its `reauthorization_required` status; never a logout                         |
| Permission denied / missing resource           | Route or feature: explicit forbidden/not-found state, no guessed data                             |
| `workflow.revision_conflict` (412)             | Save coordinator: preserve local graph and resolve conflict                                       |
| Lifecycle / idempotency conflict (409)         | Command-specific recovery; never a generic automatic retry                                        |
| Preconditions missing (428)                    | Treat as client integration failure, not “try harder”                                             |
| Semantic validation (422 or validation report) | Feature: issue list with node/field navigation and stale-report tracking                          |
| Rate limit / unavailable service               | Local feedback, bounded Retry-After; no request storm                                             |
| Background refetch failure                     | Keep last good data with stale/retry notice; do not blank the screen                              |
| Foreground required-data failure               | Route/section boundary with a working Query + Router retry                                        |
| Canceled read                                  | Silent; it is usually navigation, not an error toast                                              |
| Uncertain mutation outcome                     | Low effect: refresh and review current state; effectful: retain the exact identity-fenced command |
| Unexpected render failure                      | Nearest suitable error boundary; safe message and diagnostic correlation                          |

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
- `lib/api/stream-reconnect.ts` owns the stop rules and backoff for every live
  stream; features word its reasons. Backoff has jitter and a cap on reconnect
  delay/attempt burst, and respects auth, forbidden and rate-limit responses.
  Show reconnecting/degraded state. On stream loss use bounded visible-view
  polling; stop redundant polling once healthy.
- A pending or accepted Workflow Call also refreshes its visible parent snapshot
  every two seconds: acceptance actions update lineage between parent transition
  events. Query owns that snapshot; polling stops for terminal parents and is
  paused in the background. No local lineage mirror or per-child stream is
  added.
- Abort on route/workspace/session changes. Reconnect/refetch after visibility
  recovery. On terminal events obtain a final snapshot; do not reconnect forever
  after a verified terminal result. Disconnecting never cancels the server run.
- Bound timeline memory and virtualize when needed. Show truncation; a frontend
  buffer is not complete persisted execution history. Missing/invalid sequence
  means resync/refetch with explicit diagnostics, not silently accept
  corruption.
- A graph node can have several invocations. Do not key all run details only by
  graph node ID or show `outcome_unknown` as success/retryable by default.

File uploads use the feature-local
[transfer adapter](src/features/artifacts/data/artifact-upload.api.ts). Reserve
through the API, upload to signed storage, then finalize through the API. The
signed PUT omits credentials and referrer, rejects redirects and lets the
browser derive `Content-Length`. File objects and signed URLs stay in the upload
session. Only finalized descriptors enter a draft or run input.

Present reserve, upload and finalize failures separately. Cancellation may leave
a reservation or object behind. Use a real upload test to verify the signature
and storage CORS.

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

- Colour means attention. Ground, ink and hairlines carry everyday content.
  Success uses ink. Cyan signals live work and fills the main action in dark
  mode. Red, violet and amber belong to marks, error codes and soft notice
  tints. Use hairlines up to 1.5 px. Selection lifts the background and keyboard
  focus draws a ring.
- Primitives live in `components/ui/`. Domain-free compositions live in
  `components/patterns/<area>/`. Give each piece one home and keep feature rules
  in its model and formatting in `lib/format/`. Use variants for visual
  differences and `className` for layout.
- Start with one column. Use list and detail where people step through many
  items, drawers for create and edit, and dialogs for irreversible confirms.
  Long lists show five and offer “Show all N”, with search above 20. Put choices
  in fields and filters. Date presets sit beside the calendar and a day takes
  one click to pick. Core threads fade inside its shell.
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
- Looping motion runs only where it means something, because every moving frame
  repaints the window. Status glyphs and the Loom move only while work is live,
  never for a zero count or a legend. The Core is the exception: it always
  drifts, slowly when nothing runs (`CORE_IDLE_ENERGY`), and quickens with live
  work, because a frozen orb reads as a stalled app. Loaders never stand still.
  CSS loops use the `motion-loop` variant and canvases
  `usePrefersReducedMotion`: both hold still only under reduced motion, where
  the loading orb fades in place instead. Canvases draw 30 frames a second and
  pause off-screen and in hidden tabs; a visible window without focus keeps
  moving.
- The ambient glow is bounded to the entry screen and holds still under reduced
  motion. Floating surfaces provide static border and opaque glass fallbacks.
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

| Material  | Meaning                                                                                                            | Rule                                                                                                         | Implementation                                                                                                |
| --------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Thread    | A run moving through time: grows while running, knots on success, stops at a cross on failure, coils while waiting | Every status in the product speaks the thread glyph language                                                 | `components/patterns/status/status-mark.tsx` (`StatusMark`, `StatusTone`)                                     |
| Loom      | Time laid sideways, one lane per workflow                                                                          | Charts come from real run times, never invented metrics                                                      | Runs feature (Home and the Runs "Loom" view); step thread view on run detail                                  |
| Core      | The living particle orb                                                                                            | At most one large animated Core per screen                                                                   | `components/patterns/core/orb.tsx` + `orb-scene.ts` (Canvas 2D, token colours, drifts; live work quickens it) |
| Lens      | Glass                                                                                                              | Only layers that float above the page: spine, bars, inspectors, dialogs, menus, toasts. Page content is flat | `lens` utility in `styles/globals.css`; `components/ui/sheet.tsx`, dialog, popups                             |
| Live edge | The aurora travelling around a border                                                                              | Only while real work is in flight; nothing moves when nothing happens                                        | `live-edge` class (animated `@property` angle, bounded to the element)                                        |

#### Tokens and type

Settings → Account → Appearance offers System, Light and Dark for this browser.
The workspace rail's appearance control, the command palette and the phone More
sheet use the same owner (`components/patterns/appearance/`).
`lib/appearance/bootstrap.ts` is the single owner of persistence, system
changes, tab synchronization and resolved theme. Vite embeds its self-contained
initializer synchronously in the HTML head, before first paint; the React hook
subscribes to the same instance. No account/workspace API or server state is
mirrored. Blocked storage retains a choice in memory and explains that it cannot
survive closing the tab.

Dark and Cyanotype use the same semantic token names in `styles/globals.css`.
The light page sits on blue grid paper. Neutral surface tiers run from well to
ground, card and raised. The three selection layers lift interactions with
different amounts of ink. The live drawing colour and its readable text colour
(`glint`) have separate roles. Waiting, warning and failure each have a mark
colour and a soft tint. Depth comes from raised and sunken shadows, and selected
objects use the selection ring. The light palette uses soft shadows and inset
hairlines.

- Bricolage Grotesque leads the display (60 px), title (40 px) and section
  heading (19 px). Inter is the interface face (14 px body, 13 px small text,
  12.5 px metadata). JetBrains Mono carries tabular values and short IDs at 12
  px and labels at 11 px.
- Radii grow with the surface (6, 8, 10, 12, 14, 18 and 20 px). Quick state
  changes take 150 ms, movement 240 ms and entry 320 ms.
- Lens glass is for floating surfaces. Menus and popovers use a denser mix,
  tooltips a solid surface, and drawers and dialogs sit on a scrim. Reduced
  transparency and browsers without backdrop blur use solid surfaces. The canvas
  uses the weave texture in both themes.

#### Status language

Features map their own enums to a `StatusTone` in their `model/` (for example
`features/workflows/model/state.ts`). Never colour a status ad hoc.

The 20 px mark is decorative alongside a status word. A mark conveying a status
on its own has an accessible name. Running moves when motion is allowed. The
other eight terminals stay still.

| State           | Terminal              |
| --------------- | --------------------- |
| Running         | Live bead on a thread |
| Succeeded       | Solid ink knot        |
| Failed          | Red cross             |
| Waiting         | Violet ring           |
| Queued          | Three ink dots        |
| Needs attention | Amber diamond         |
| Draft           | Ink ring              |
| Skipped         | Ink bar               |
| Off             | Faint thread          |

#### Shared building blocks

Dialog action rows use `DialogFooter` from `components/ui/dialog.tsx`, including
`DialogFooter`, `ActionDialog` and `SheetFooter`. Put Cancel/Close first, then
supporting actions, then the primary action; DOM and visual order agree. Use
`FileDrop` from `components/ui/file-drop.tsx` for native file selection and
drag-and-drop; features retain their own validation, limits and upload status.
Phone controls have 44 px hit targets; small checkbox/switch artwork keeps an
invisible expanded hit area. The Build route preserves the editor’s existing
compact geometry with `--control-min-size`; its portalled dialogs retain the app
minimum.

One implementation per concept; features compose these rather than restyling
their own:

| Concept         | Where                                                                        | Use                                                                                                                                                                                                                                                                                                                               |
| --------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Field           | `components/ui/field.tsx`                                                    | `LabelledField` (label, optional label action, trailing control and live feedback; links hint and message), `FieldControl` holds a control and anything inside its edges                                                                                                                                                          |
| Deadline        | `components/patterns/dates/deadline-field.tsx`, `components/ui/calendar.tsx` | `DeadlineField` for the Run and Replay lenses: None, In 1 hour, In 1 day or Pick a time, where a date (typed, or from a `Calendar` lens with past days disabled) and a 24-hour time are read on the person's clock with their time zone named. Never the browser's native picker; its value is local `datetime-local`-shaped text |
| Date            | `components/patterns/dates/date-input.tsx`                                   | `DateInput` for a calendar day inside a `LabelledField` (form date fields, table date cells): typed `YYYY-MM-DD` or picked from a `Calendar` lens. Never the browser's native picker; the value is the typed text, which callers validate                                                                                         |
| Validation      | `components/ui/use-field-validation.ts`                                      | `useFieldValidation`: the only message timing (on submit, then live until fixed; focus first invalid; server `errors[].path`); `useFieldValues` is the thin values-and-rules layer for plain text forms                                                                                                                           |
| Confirmation    | `components/patterns/actions/confirm-dialog.tsx`                             | `ConfirmDialog`: title, description or consequences, optional inputs, one failure `Notice`, Cancel + `ProgressButton`; `DialogActions` owns Cancel, confirm, pending and error; custom footers remain for other flows                                                                                                             |
| Pending button  | `components/ui/progress-button.tsx`                                          | `ProgressButton`: mini orb + swapped verb while pending, countdown while waiting; never hand-build the orb                                                                                                                                                                                                                        |
| Rename          | `components/patterns/actions/rename/inline.tsx`                              | `InlineRename` (pencil → field → Save/Cancel), `RenameForm` in dialogs; sends the revision the edit started from, conflicts offer “Use theirs / Keep mine”                                                                                                                                                                        |
| Disclosure      | `components/ui/disclosure.tsx`                                               | `Disclosure`: the one "show more": the app's chevron turning as it opens on the native disclosure (find-in-page and keyboard keep working), quiet/strong/link tones, a framed look, and `lazy` for folds that read data. Never a raw `<details>`                                                                                  |
| List and detail | `components/patterns/lists/list-detail.tsx`                                  | `ListDetail` shows the list beside the selected item when space allows. Below about 900 px it shows one view at a time with a back link from the item.                                                                                                                                                                            |
| Rows            | `components/patterns/lists/row.tsx`                                          | `Row` owns the inset hairline, hover and selected lifts. `RowList` aligns the text with its surroundings. The list defines its columns.                                                                                                                                                                                           |
| Copy            | `components/ui/copy-button.tsx`, `components/ui/use-copy-to-clipboard.ts`    | `CopyButton` (icon, or a short value in mono whose name adds it) confirms in place; `useCopyToClipboard` for menu items (toast, same wording). Only `lib/clipboard.ts` touches the clipboard                                                                                                                                      |
| Notice          | `components/patterns/notices/inline-notice.tsx`                              | `Notice`: tones `info`/`success`/`warning`/`destructive` (destructive is an alert), optional thread `glyph`, title and one action. Banners, failed commands and uncertain outcomes                                                                                                                                                |
| Stale data      | `components/patterns/states/stale-line.tsx`                                  | `StaleLine`: the one amber "Couldn’t refresh. Showing results from 14:02" line with Retry                                                                                                                                                                                                                                         |
| Lists           | `components/patterns/lists/load-more.tsx`, `components/ui/skeleton.tsx`      | `LoadMore` (next page, retry, one failure line); `Skeleton` and `SkeletonThread` primitives; `SkeletonRows` and `SkeletonLines` in `components/patterns/states/loading.tsx`                                                                                                                                                       |
| Recent log      | `components/patterns/lists/recent-log.tsx`                                   | `RecentLog` (heading, note, loading rows, one failure owner, empty sentence, "Load older", optional day groups) and `RecentLogEntry` (glyph, words, action, time) for trigger logs, the audit ledger and promotion history                                                                                                        |
| Query states    | `components/patterns/states/query-view.tsx`                                  | `QueryView`: the one owner of a read's states: `loading`, a first-read failure (`error` slot, `FailedReadState` or `InlineFailedRead`), `StaleLine` over kept data, `empty`, and access loss hiding data                                                                                                                          |
| Clock           | `lib/hooks/use-now.ts`, `lib/hooks/use-countdown.ts`, `lib/format/time.ts`   | `useNow(intervalMs, enabled, untilMs?)` ticks only while needed and pauses in hidden tabs; `useCountdown` (cooldowns, `Retry-After`, windows) is built on it; `formatCountdown` renders "0:24"                                                                                                                                    |
| Canvas          | `lib/canvas-scene.ts`, `lib/hooks/use-canvas-renderer.ts`                    | `CanvasScene` (sized, cleared, token colours) for the Core, sign-in threads, Loom and loading wave; the hook owns the loop                                                                                                                                                                                                        |
| Pagination      | `lib/api/pagination.ts`                                                      | `cursorPages`/`collectPages` walk cursors once (repeat or overrun is a protocol failure); `searchParams` builds page queries                                                                                                                                                                                                      |
| Setting         | `components/patterns/settings/row.tsx`                                       | `SettingsGroup` and `SettingRow` keep the value and editor inline. The shared disclosure holds any additional rules.                                                                                                                                                                                                              |
| Settings rail   | `features/workspaces/components/shell/settings-rail.tsx`                     | `SettingsRail`: Settings' own navigation beside every Settings page (a pathless layout keeps it mounted); plain grouped words and a knot for the open page when there is room beside it (a container query), otherwise one button naming the open section that lists them all in a sheet                                          |
| Day range       | `components/patterns/dates/day-range-form.tsx`                               | `DayRangeForm`: presets and a calendar in the person’s time zone, shared by the Runs and Audit log time filters                                                                                                                                                                                                                   |

The Loom uses Canvas for drawing and native SVG links over the plotted runs for
pointer and keyboard navigation. Both share the run geometry. Focus has a
visible outline and exposes the same run preview through the shared Tooltip
primitive, which owns positioning, dismissal, and hover state. The preview
escapes the clipped drawing surface through its portal; the text list remains
available alongside the visualization.

Other primitives (`components/ui`): button (`primary` is the one filled action
per screen; `default` tinted; `outline`, `ghost`, `destructive`, `link`), badge,
input/textarea, select, dropdown-menu, tabs, tooltip, popover, switch, checkbox,
sheet, toggle-group, separator, kbd, toast (`NotificationsProvider`,
`useNotifications` with success/info/error/undo and `track` for progress →
result), loading-orb, dialog (`center`, `top`). Other patterns
(`components/patterns`): `CoreOrb`, `Empty` (title, description and next
action), `PageHeader` (title, mono meta line, actions), `CommandPalette`,
`JsonTree`, `SystemState` (its art — a thread drawing, an icon or the Core —
sits on the page, never in a framed box; in the shell the state reads from the
left, a full screen centres it), thread illustrations. The Core's particles grow
in number with its size and each is capped in size, so a large Core (sign-in)
stays fine-grained. Other libraries (`lib`): `format/time.ts` (all
date/time/duration text — no feature-local `Intl.DateTimeFormat`;
`formatDateTimeInZone` reads a time on a named clock with its zone name;
`formatShortTime` is the locale's time to the minute, “Saved 14:31” and the
stale line, while `formatClock` keeps seconds for logs; durations have one
compact style, `0.12s`, `4.2s`, `1m 12s`, `2h 05m`, and relative times the
narrow one, `3m ago`), `format/bytes.ts` (byte sizes for files and payloads),
`format/initials.ts`, `api/error-copy.ts` (generic read/command failure
sentences, uncertain outcome, forbidden, rate-limit and support reference
helpers), `hooks/use-prefers-reduced-motion.ts`, `hooks/use-online-status.ts`.

Toasts and the Inbox arrival use the same `NoticeTimer` in
`components/patterns/notices/notice-timer.tsx`. The inbox's new-failure notice
uses an anchored Base UI toast manager
(`features/inbox/components/arrivals/listener.tsx`). A thread links the notice
to the Inbox destination. The ring around Close shows time left and pauses while
the notice is hovered or focused. It stays off the Inbox page. Failures arriving
together share one notice, and the first summary a tab loads announces nothing.
Base UI turns swiping off for anchored toasts, so the notice brings its own
(`use-arrival-swipe.ts`): dragging it toward the Inbox, left from the spine or
down into the phone bar, dismisses it like the close button, and it stays
unread.

#### Structure

- `/w/$workspaceId` resolves the person and workspace once (`beforeLoad`); an
  unavailable workspace renders the full-screen unavailable page. The pathless
  `shell` layout renders the spine (Home Core, Workflows, Runs with live count,
  Inbox with unread count, Data tables, Connections, Team, Settings, Help,
  theme, Search, account), the breadcrumb rooted in the workspace switcher,
  banners and the page. Phones get a bottom bar with Home, Workflows, Runs,
  Inbox and a More sheet. ⌘K opens the command palette. The shell route also
  provides `CommandPaletteContext` (`routes/command-palette-context.ts`); a page
  route reads `useOpenCommandPalette()` and hands its feature a plain callback
  (Home's Search), so features never import routes.
- `/w/$workspaceId/workflows/$workflowId` uses the same shell around a workflow
  hub with Build (index), Runs, Triggers, Versions and Settings tabs. Every tab
  renders `WorkflowHubBar` (from `features/workflows/workflows-views.public.ts`)
  with its own right-hand actions; Build embeds the editor.
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
  context's `onSessionExpired`, which pauses the rendered page (section 9). What
  still blocks (the session and workspace check, resource reads, lazy chunks)
  shows the router's pending component after 150 ms (`defaultPendingMs`), fading
  in, for only as long as the load takes (`defaultPendingMinMs` 0: the fade
  already keeps a short one from flashing): `PagePending` inside the shell,
  `WorkflowHubPending` in the hub, `WorkspaceBootPage` (“Opening Northwind
  Ops…”, then “Still connecting…” after 2 s) for a cold workspace, `BootPage`
  for public pages that check the session and `SigningOut` for sign-out. The
  static first frame in `index.html` has the boot screen's layout with an empty
  status line, so the orb screen is the only full-screen loading view.
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
  the editor store with its React contexts; feature hooks (`use-*.ts`) live in
  `hooks/`; server command hooks live in `data/<subject>.mutations.ts` or, once
  there are several, one per file in `data/mutations/`. Other code reaches a
  feature through its four entries (above).

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
node placement and link alternatives, not drag-only essential actions. Protect
text input from canvas shortcuts and handle delete/undo intentionally.

**Performance:** lazy-load editor and feature CSS; keep canvas dependencies out
of workflow-list entry code. Route loaders import their feature query interfaces
when entered; synchronous search parsers use focused public entries. The generic
page skeleton stays independent of the lazy workflow hub skeleton. Selected-step
inspector controls load inside the existing lens, with shared skeletons while
loading. React, Router and Query share one cached runtime chunk; feature chunks
remain automatically split. Use stable node/edge component registrations and
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
unsaved editor. Every lazy piece and route component loads through
`components/patterns/app-update/lazy.ts`, which an import rule enforces: a
missing chunk shows "Pertexo was updated. Reload to continue." where the piece
would be, and nothing reloads by itself
([plan](../../docs/feature-plans/lazy-chunk-recovery.md)). Same-origin proxy
must support SSE without buffering and sensible timeouts.

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

See [web workspace checks](AGENTS.md#what-guards-it) for import and lint rules
and [run and verify](README.md#run-and-verify) for commands.

- Give each component test a fresh Query client, router and editor store as
  applicable. Keep the shared budgets in `test/setup.ts` and `vitest.config.ts`.
- Use MSW to exercise the real transport and decoders with contract-valid
  fixtures. A malformed fixture should test a specific refusal.
- Mocked Playwright journeys exercise the built frontend. The live lane uses
  isolated users and workspaces against the real stack. Vite child processes use
  `NODE_ENV=production` to match the shipped React runtime.

### Required regression scenarios, introduced with their slice

| Boundary            | Proof                                                                                                                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transport           | Valid success/204, malformed JSON/schema, common and extended problems, missing ETag, abort/timeout, safe fallback, CSRF and credential handling                                       |
| Session/scope       | Sign-in return, login/logout, expired session, two identities/workspaces, late response after logout, only `auth.unauthenticated` signs the user out                                   |
| Queries/routes      | Loader/component share request/key, cursor filters, back/forward/deep link, empty/forbidden/not-found/stale/error and working retry                                                    |
| Forms               | Required/transformed input, field/path errors, unapplied edits, keyboard/focus, secret values absent from caches/logs                                                                  |
| Graph adapter       | Round-trip schema-valid fields and unsupported definitions without data loss, stable IDs, no canvas-only fields, structural invalidity rejected                                        |
| Save/history        | Coalesced drag, undo/redo, debounce/manual save, edit during in-flight save, 412 without data loss, equal revision/different ETag, lost acknowledgment, navigation guard               |
| Publish/preview/run | Save barrier, stale validation report, exact-key replay, publish while newer edits exist, immutable version identity, preview side-effect warning                                      |
| SSE                 | Split UTF-8/chunks, comments/CRLF, duplicates/gaps, invalid/big event, resume cursor, reconnect/fallback, terminal stop, cleanup on scope change, snapshot never regresses from replay |
| Visual              | Focus/disabled/error/loading states, reduced motion, narrow layout, contrast on glass, bounded node/edge animation                                                                     |
| Deployment          | Real callback/proxy/cookies, deep-link reload, SSE no buffering, lazy-load failure, signed storage CORS/upload when introduced                                                         |

Browser golden path: sign in → choose workspace → create workflow →
add/configure and link supported nodes → save → reload same graph →
validate/publish → start run → display the version ID accepted by the run
response → observe completion → sign out without state leakage. Also test a
two-tab editing conflict; a happy-path video alone is not enough.

## 14. Definition of done for each feature

Verify the relevant behavior and failure states from section 13. Check that
identity changes dispose scope, edits survive conflicts, and recovery actions
match the server contract. For visual work, check the affected states at narrow
and desktop widths, with keyboard and reduced motion. Update this guide when
ownership or a protocol changes.

## 15. Function placement and component composition

[Web workspace rules](AGENTS.md#where-new-code-goes) own function placement.
Compose feature actions in a shared layout with props and children. Use Base UI
for coordinated parts such as dialog triggers, content and focus return. Use CVA
for visual variants. Keep permissions and queries in the calling feature, and
subscribe to editor state through narrow store selectors.

## 16. How skills are applied

See the [web workspace rules](AGENTS.md#rules) for the skills relevant to this
workspace.

## 17. Screen-and-journey map

Browser path abbreviations: `B = /w/$workspaceId`,
`E = B/workflows/$workflowId`. A tab uses validated URL search when it should
survive refresh/back navigation. Backend routes remain separate from these URLs.

### Navigation and first run

The root route resolves the session and opens workspace Home when a workspace is
selected. The workspace picker handles selection or creation when needed. Home
offers a
[guided example](../../docs/guides/getting-started.md#try-the-guided-example).
Workflows, Runs, Connections, Team and Settings are workspace routes. Their
availability depends on the workspace and its capabilities.

The authoring route keeps unsaved edits in its editor scope. Publishing creates
a version. Starting a run opens its detail page, which shows the version the
server accepted. Historical graphs never replace the current draft. A denied
workspace deep link keeps its requested scope and shows the corresponding
failure.

### Personal automation tokens

The lazy workspace Settings route renders
`features/api-tokens/pages/token-settings.tsx`. The feature owns metadata
queries, expiry/scope forms and revoke cache effects in its `data/` area.
Creation is a direct feature API call because its one-time secret must never
enter the query or mutation cache. Only the mounted creation dialog/receipt
holds it; closing or changing person/workspace clears it. Unknown creation
outcomes refresh metadata and require revoke/replacement. Cookie/CSRF and
recent-sign-in rules remain server-owned.

See [artifact transfers](#10-runs-sse-and-artifact-transfers) for the other
browser flow that handles temporary credentials outside the cache.

### Canonical request identity

`lib/api/commands/use-retained.ts` owns exact command identity across uncertain
responses. Shared utilities may import only `canonicalJson` from the
browser-safe model for this generic JSON rule; ESLint still rejects other model
exports and all backend/feature imports there. Forms and workspace variables
share the same algorithm instead of carrying another sorted-JSON implementation.

The pure `lib/api/commands/contract.ts` owns the shared command retry window
(`newCommandKey`, `canResend`, `RETRY_WINDOW_ENDED`) and uncertain-outcome
classification, and `use-resend-window.ts` re-renders when a held command's
window ends. Hooks that keep a key for an exact retry use them and keep only
their own failure mapping; only commands whose repeat is harmless or bounded
(file uploads, invitation acceptance, token revoke) don't. Neither pure command
consumers nor shared transport depend on React hooks.
`lib/api/workspace-scope.ts` names the authenticated client/user/workspace tuple
used by both file uploads and variable mappings. Generic inspector props call it
`workspaceScope`; file-only body controls keep their upload vocabulary.

Workflow publication owns validation, publication controls and reviews in
`workflow-publish`. Workflow testing owns step previews, samples, workflow
tests, suites and temporary listeners in `workflow-testing`. Their entries
follow the feature entry rule: publication controls and testing controls load
with Build; reviews have their own lazy route. Testing's `public.ts` exposes
query definitions, pure projections and the inspector's hooks without loading
panels, and its `-views` entry keeps step testing, webhook listeners and
schedule previews behind the lazy inspector. Publication readiness reads suite
data through that query entry without importing testing UI. Shared workflow
failure wording lives in `lib/workflows`, outside the eager API transport chunk.

F35’s webhook Test panel lives in workflow-testing and composes into the generic
node test panel through children. Its bounded temporary listener uses the
existing webhook protocols, and the explicit Keep action uses the existing F02
pin command. Listener credentials stay in mounted component memory; Query and
mutation caches retain no generated signing/header credential. Local Vite also
forwards `/hooks`, redacting capability paths in proxy-error logs.

### Canvas documentation (F37)

`workflow-editor/components/canvas/notes/` projects graph notes into
non-connectable React Flow decorations. `model/notes/` owns immutable commands,
edit validation and safe link handling. The scoped editor store owns the draft
and undo; gesture-only positions/sizes are ephemeral projection state. Markdown
is lazily parsed to React elements, without HTML injection or embedded
resources. Numeric geometry controls provide keyboard and phone parity.
`workflow-drafts/model/graph-diff.ts` owns note comparison for conflicts,
publishing and version history. Notes never enter the execution projection or
pinned sample identities. See ADR 089 for publication reuse.
