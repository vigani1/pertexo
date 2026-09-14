# Pertexo web foundation

React 19 + TypeScript + Vite, in the existing pnpm workspace. This is **only a
boilerplate**: one removable foundation page, theme, routing, query provider,
one shadcn/Base UI button, and tests. No API calls, authentication, workflow
editor, persistence, or execution UI are implemented.

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

Development uses `http://127.0.0.1:5173`. Browser tests build the app and own a
preview server on port 4173. Optionally set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to an existing Chromium/Chrome executable.
No backend, Redis, database, or environment file is needed for this foundation.

Root build/typecheck/lint/test commands include this workspace, and the existing
CI services matrix includes its unit tests. Browser tests are a separate
command, not yet an additional CI gate. The production output is `dist/`; a
future host must serve `index.html` for application deep links. Vite's
dev/preview fallback does not configure that production host.

## Small structure, clear ownership

| Location             | Responsibility                                                                        |
| -------------------- | ------------------------------------------------------------------------------------- |
| `src/main.tsx`       | Create one router and query cache for the application lifetime.                       |
| `src/app/`           | Router factory and server-cache defaults.                                             |
| `src/routes/`        | Route definitions, shell, error/not-found recovery and temporary foundation page.     |
| `src/components/ui/` | Owned shadcn primitives built on Base UI. Add only components needed by a real slice. |
| `src/lib/`           | Small domain-independent helpers such as class merging.                               |
| `src/styles/`        | Semantic Tailwind tokens and original visual identity.                                |
| `test/`, `e2e/`      | Component/unit checks and real-browser smoke tests.                                   |

When the first feature is approved, add `src/features/<feature>/` with its UI,
queries and model together. Routes compose features; features depend on shared
UI and reviewed contracts. Do not create every future directory in advance.
Extract a shared pattern only when real repetition demonstrates its interface.

The current router is code-based, so there is no generated route-tree file or
router build plugin. Add routes in `src/routes/route-tree.ts`. Split heavy
editor route code when it actually exists.

## Patterns for the next slices

1. **Server data:** feature-local `queryOptions` definitions shared by route
   loaders (`context.queryClient.ensureQueryData(...)`) and components. Query
   keys include workspace, entity ID and filters. Pass the abort signal through
   the HTTP adapter. The app defaults to 30-second freshness and no automatic
   retries; choose read retry rules per endpoint. Writes never retry blindly.
   Clear protected caches when the authenticated identity changes.
2. **Editing:** React Flow handles canvas rendering. A provider-scoped Zustand
   store will own each editor's unsaved draft/history; selection and drag state
   must not trigger unrelated subscriptions. Keep ephemeral canvas fields out of
   saved domain objects through an explicit graph adapter. Neither package is
   imported into the foundation bundle yet; both are deliberately installed for
   the requested stack and temporarily listed in Knip's dependency exceptions.
3. **Saving:** preserve backend ETag/`If-Match` concurrency. A conflict retains
   local edits; a background refetch must not overwrite an unsaved draft. Run
   actions use published versions, not arbitrary unsaved canvas state.
4. **Composition:** small components accept children and explicit variants. Use
   local state for local interaction, as the foundation page demonstrates. Avoid
   a global app store or generic service/repository hierarchy.
5. **UI:** use semantic Tailwind tokens and the `cn` helper. Keep controls
   keyboard-accessible. Links remain links (use `buttonVariants` for styling),
   not buttons pretending to be links. Use shadcn's CLI and review generated
   code.
6. **Contracts:** no duplicated backend domain models. Add only verified
   browser-safe workspace package subpaths when a real integration needs them;
   extend the import allowlist and TypeScript references together.

The theme selectively carries over the old app's charcoal surfaces, cyan and
violet accents, and Inter/Hanken Grotesk/JetBrains Mono typography. Font files
are bundled locally. No legacy feature CSS, old auth/backend adapters, animation
engine or 3D library was copied. The single glass utility is intentionally
small.

The first feature should replace the temporary foundation page, not preserve it
as a second product interface. Decide that slice before adding more code.
