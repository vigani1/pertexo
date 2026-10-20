# Lazy chunk recovery after a deployment

Status: implemented and locally verified 2026-10-19. Implements the Deployment
paragraph of
[web architecture §12](../../apps/web/ARCHITECTURE.md#12-other-web-concerns-we-must-not-leave-implicit):
"a lazy-chunk load failure offers a controlled reload and protects dirty state;
do not auto-reload an unsaved editor."

## Today

- Route components use TanStack's `lazyRouteComponent`. When a module is
  missing it calls `window.location.reload()` once, during render. With the
  editor's leave guard active the browser asks first, and if the person stays,
  the component suspends on a promise that never settles: the page hangs on its
  loading state. Its check also misses Vite's "Unable to preload CSS" error,
  which reaches the root error page.
- In-page `React.lazy` pieces (the Code step's setup, the run graph, and the
  workflow bar's Export, Duplicate and Input cases) have no handling. A failed
  import reaches the root `RouteError`, which replaces the whole app and
  unmounts the editor with its unsaved in-memory draft.
- The Code field catches a failed CodeMirror import and says "Couldn't load the
  JavaScript editor."

## Outcome

One rule and one message. When a chunk can't load, the piece that needed it
shows "Pertexo was updated. Reload to continue." with a Reload button, where it
would have been: inline for an in-page piece, as a small dialog for the
workflow bar's dialogs, and as the page for a route. Everything else on screen
stays mounted, so the editor keeps its draft and its autosave. Nothing reloads
by itself.

## Decisions

- **Route chunks stop auto-reloading, dirty or not.** The architecture asks for
  a controlled reload. Knowing that nothing is dirty would need TanStack's
  internal blocker list or a second dirty registry beside the editor's save
  state, which the architecture forbids. TanStack's reload can hang the page as
  described above. The cost is one click on a calm page, once per stale tab per
  deployment.
- **Reload is `window.location.reload()` from the button.** The editor's leave
  guard and the import recovery guard already register `beforeunload`, so the
  browser confirms before unsaved work is dropped. No new dirty-state signal.
- **One detector.** A chunk failure is recognised by message in one function:
  the browsers' failed module import messages (Chromium, Firefox, Safari) and
  Vite's CSS preload error. Any other error propagates as before.
- **Two helpers, one module.** `components/patterns/app-update/lazy.ts` holds
  `lazyPiece(load, Updated?)` for in-page pieces (React `lazy`) and
  `lazyRoute(importer, exportName)` for route components (built on
  `lazyRouteComponent`, so intent preloading keeps working). A failed import
  resolves to the update notice instead of rejecting, so React and the router
  render it like any component. An ESLint `no-restricted-imports` rule keeps
  `lazy` and `lazyRouteComponent` out of every other file.
- The Code field shows the same inline notice when its CodeMirror import
  fails; other failures keep its current message.

## Steps

- [x] 1. Detector, helpers and the notice in its three frames (inline, dialog,
  page) in `components/patterns/app-update/`, with the lint rule.
- [x] 2. Every route uses `lazyRoute`; the five in-page pieces use `lazyPiece`;
  the Code field uses the detector.
- [x] 3. Unit tests that simulate a failed dynamic import: an in-page piece
  shows the notice in place beside its siblings, doesn't reload, and reloads
  from the button; an ordinary error still reaches the error boundary; a route
  chunk that fails under a dirty editor shows the notice where the page goes,
  keeps the editor and its unsaved text, and doesn't reload by itself.
- [x] 4. Point the architecture's Deployment paragraph at the helpers.

Verification: web lint, TypeScript, unit tests and build. A mocked browser test
(`e2e/workflow-editor/publishing/app-update.spec.ts`) answers every asset with 404 after
the editor loads, as a deployment would: the Code step's setup shows the notice
beside an unsaved edit, Reload raises the browser's leave prompt, and a link to
an unloaded route shows the update page without reloading. It passed in
Chromium, Firefox and WebKit, so each browser's real message matches. The
fallback has to ship with the first load (a lazy fallback would hit the same
missing chunk), which adds about 1.3 kB gzip. A live check with an old tab
against a new build is not part of this slice.

Out of scope: announcing an update before a chunk fails (version polling, a
service worker) and retrying a failed import.
