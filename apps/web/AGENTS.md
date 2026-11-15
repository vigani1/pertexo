# @pertexo/web

Follow the [root rules](../../AGENTS.md); this file only adds to them.
[README.md](README.md) lists what is built and
[ARCHITECTURE.md](ARCHITECTURE.md) explains the patterns, the visual system and
the tests in depth.

## Purpose and boundary

The browser app: a React/Vite single-page app (not Next.js) that talks to the
API through browser-safe contracts. It owns screens, the server-snapshot cache,
URL state, local drafts and all user-facing text.

It never imports backend runtimes, database clients, worker executors or Node
builtins, never holds credentials or secrets (no secret `VITE_*` variables),
and never decides a rule the server owns: it states the server's limits from
their owners and lets the server refuse.

## Layout

- `src/main.tsx`: the entry; `app/`: the query client, router and session
  wiring.
- `routes/`: thin route modules grouped like the app (`root`, `auth`,
  `workspace`, `workflow`, `forms`, `notifications`). A route composes features
  and imports the page it renders from the feature's `pages/`.
- `features/<feature>/`: one product area. Only its entries sit at its root;
  everything else is in a role folder: `pages/`, `components/`, `hooks/`,
  `data/` (`*.api.ts`, `*.queries.ts`, `*.mutations.ts`, `mutations/`),
  `forms/`, `model/`. A sub-area folder inside a role folder needs a second
  file or a peer under another role.
- A feature's entries, at most four, each name in one of them:
  - `public.ts`: rules, hooks and data other code uses; never a component;
  - `<feature>-views.public.ts`: components other features or routes render;
  - `<feature>-queries.public.ts`: what route loaders import, and the
    endpoint functions other features' `data/` modules use;
  - `<feature>-routing.public.ts`: only what the always-loaded shell
    imports (search parsers, guards, pending and stage pieces); never a
    page, and nothing the shell doesn't use.
- `components/ui/`: shadcn/Base UI primitives, flat; `components/patterns/`:
  proven domain-free compositions by area.
- `lib/`: named shared modules (`api/` transport and command helpers,
  `format/`, `appearance/`, `hooks/`, …). `lib/class-names.ts` holds only `cn`.
- `styles/globals.css`: the semantic theme tokens.

## Where new code goes

- A screen: `features/<feature>/pages/`, rendered by a route module that
  imports it directly.
- Only `data/` talks to the server. An endpoint call:
  `data/<subject>.api.ts`, imported only by `data/` modules and the feature's
  `-queries.public.ts`; a stream, download, lease or multi-step journey: a
  named function or hook beside it (`tables-export.ts`, `presence-lease.ts`,
  `native-auth-flows.ts`), which pages and components call; its cache keys
  and options:
  `data/<subject>.queries.ts`; a server command hook and its cache effects:
  `data/<subject>.mutations.ts` (or one per file in `data/mutations/`). Only
  there may code call the command builders (`useMutation`,
  `useRetainedCommand`, `useLowEffectMutation`, `useCreateCommand`,
  `useLatestCommand`, `useLatestRequest`, `useNativeDownload`,
  `useSharingEditor`), change the query cache (`invalidateQueries`,
  `setQueryData`, `removeQueries`, …) or mint an idempotency key; a
  component takes the screen's own reaction as an `onAccepted` callback and
  reads `pending` and `failure` from the hook. A command whose late answer
  must be ignored once a newer one starts uses `useLatestCommand`.
- A rule or calculation: a plain function in `model/`, not a hook, with a
  unit test of the function. A page or component reads as layout; a hook
  holding a page's state goes in `hooks/`.
- Something another feature needs: the entry for its kind (above). A new
  entry kind needs a reason the four don't cover; stop and ask.
- A theme colour: a token for light and dark in `styles/globals.css`, picked
  by role, not by how it looks.

## Defaults and config

- `src` reads no environment. Build and test tooling read theirs in
  `vite.config.ts` (proxy target, origin, output folder) and the Playwright
  configs (ports, browser path).
- Limits the browser states (sizes, lengths, counts, retention) come from the
  package that enforces them (`@pertexo/contracts`, `node-sdk`,
  `workflow-model`, `integrations`, `nodes-core`, `policy`), written with
  `formatByteSize` (node-sdk) for a limit, `formatByteLength` for a measured
  size, `formatCount` and `formatTimeSpan` (`lib/format/`).
- Query timings come from `lib/api/query-timings.ts`: `QUERY_FRESHNESS`
  (`staleTime`), `QUERY_RETENTION` (`gcTime`), `QUERY_POLLING`
  (`refetchInterval`) and `QUERY_RETRIES`. Pick the tier by what the data is,
  not by the number. A timing that is truly a feature's own is a named
  constant beside its query (the recording backoff, the schedule margin);
  app-wide defaults sit in `app/query-client.ts`. A clock's tick comes from
  `CLOCK_TICK` (`lib/hooks/use-now.ts`).
- Who may act is named by the role policy (`whoCan`, `ADMINISTRATORS`,
  `ANY_ADMINISTRATOR` from `workspaces/public.ts`), never a written list.

## Rules

- TanStack Query owns server snapshots, the router owns URL state, forms own
  input, and component state stays local. Scoped Zustand holds only the
  editor's unsaved draft; never mirror it into a second writable store.
- Endpoint calls go through the injected API client (`lib/api`); no `fetch`
  outside the reviewed transport adapters. Await `mutateAsync()` and act after
  it, or put the effect in the mutation hook.
- Preserve opaque ETags, serialized draft saves and stable idempotency keys
  where the endpoint needs them; keep local edits on a conflict or an
  uncertain outcome. Only `auth.unauthenticated` ends the session, and each
  failure has one visible feedback owner.
- Shared `components` and `lib` never import features, `app` or `routes`.
  Views may use another feature's `public.ts`; `public.ts` never re-exports a
  component, which keeps the feature graph acyclic. No intra-feature import
  goes through the feature's own entry.
- Lazy code loads through `lazyPiece`/`lazyRoute`
  (`components/patterns/app-update/lazy.ts`), so a removed chunk shows the
  update notice.
- Keep helpers with their owner; a `lib` module is for genuine cross-feature
  reuse. Prefer props and children; use compound components only for
  coordinated parts, and the existing Base UI primitives for accessibility and
  state.
- Treat a missing API contract as a prerequisite to ask for, not permission to
  invent an endpoint or copy legacy types.
- Skills, when the task matches: `frontend-design` and `shadcn` for visual work;
  `vercel-composition-patterns` and `vercel-react-best-practices` for
  components; `tanstack-query-best-practices` for caching and mutations;
  `web-design-guidelines` for UI review; `webapp-testing` for browser behaviour.
  Not the Next.js or server-cache skills.

## Exceptions

- Ten features expose no `public.ts` (only views, queries or routing), and
  three expose nothing: their pages are reached only from routes.
- The form routes (`routes/forms/routes.ts`, `routes/forms/member.tsx`) read
  `publicFormScope` and `memberFormScope` through `forms-queries.public.ts`:
  the route builds the form's API scope for its loader and page, which makes
  no request.
- `lib/resource-sharing/` keeps its own `principals.api.ts` and
  `principals.queries.ts`: it is the shared sharing editor both connections
  and folders use, so its data modules live with it.
- `app/` and `routes/root/route-context.ts` change the query cache outside
  `data/`: the app shell owns the whole cache's life across sign-in and
  sign-out.

## What guards it

- `pnpm --filter @pertexo/web test`: unit and component behaviour, the
  limits-in-copy and role-lists-in-copy checks, and the query-timings check
  (`test/lib/query-timings.test.ts`, no number in a query's timing options or
  a clock's tick).
- `pnpm --filter @pertexo/web test:e2e`: the mocked browser suite; `e2e-live/`
  runs against a real stack (`playwright.live.config.ts`).
- `pnpm check`: the web lint rules (browser-only imports, lazy loading, no raw
  `fetch`, no fire-and-forget `mutate`), and in `validate-module-imports` the
  feature entry rules (`infrastructure/checks/web-feature-entries.mjs`): entry
  names, kinds and placement, re-exports only, cross-feature imports, and the
  shell reaching features only through `-routing` and `-queries` entries;
  and the data rules (`infrastructure/checks/web-command-hooks.mjs`): the
  command builders are called, the cache changed, command keys minted and
  endpoint modules imported (statically, by namespace or dynamically) only
  in a feature's `data/` (endpoints also in its `-queries.public.ts`) and the
  shared `lib` data modules.
- The production build treats entries as side-effect free
  (`vite.config.ts`), which the re-export rule makes safe.
