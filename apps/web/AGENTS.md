# Web frontend instructions

This is a browser-only React/Vite application, not Next.js. Root instructions
still apply. Read [README.md](README.md) for the structure and current scope.

## Boundaries

- Build one requested vertical slice at a time. No speculative feature folders,
  repositories, service layers, global stores, or new packages.
- Routes compose features; features own their UI, queries, and local model.
  Shared components/utilities cannot import features or app orchestration.
- Use existing browser-safe public contracts when integrating the API. Review
  each subpath before allowing it in the browser import rule. Never import
  backend runtimes, database clients, worker executors, or Node builtins.
- TanStack Query owns server snapshots; URL state belongs to the router;
  component state stays local. A future editor owns its unsaved draft and scoped
  Zustand store. Never mirror that draft into multiple authoritative stores.
- Keep credentials and secrets out of browser code and `VITE_*` variables.
  Implement the existing OIDC/cookie/CSRF contract, not the old app's auth code.
- Keep semantic theme tokens and locally served fonts. Reuse old design only;
  do not copy its backend assumptions or entire feature modules.

## Skills, when relevant

- `frontend-design` for new visual work; `shadcn` for primitives.
- `vercel-composition-patterns` for reusable component interfaces;
  `vercel-react-best-practices` for React implementation/performance.
- `tanstack-query-best-practices` for server caching and mutations.
- `codebase-design` for consequential module seams; `domain-modeling` for domain
  terminology. Use advanced TypeScript skills only for genuinely complex types.
- `web-design-guidelines` for UI review; `webapp-testing` for browser behavior;
  `react-doctor` after React changes. Diagnostics are not proof of correctness.
- Use `diagnosing-bugs` for hard failures, `code-review` for fixed-point reviews,
  and `tdd` only when test-first development is explicitly requested.
- Do not load Next.js/server-cache skills for this Vite app or all skills at once.

## Verification

Run app build, lint and unit tests after changes. For visible/routing changes,
also run `test:e2e` and inspect the rendered result. Test user-visible behavior,
not snapshots of implementation details. Keep import rules enabled, preserve
root strict TypeScript checks, and document limitations honestly.
