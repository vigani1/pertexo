# Lighter web first load

Reduce eager JavaScript without changing settled UI or the app's state and
request contracts. Keep the existing React/Vite stack and dependencies.

- Measure production chunk modules and cold login, Home and editor downloads.
- Keep synchronous route search validation on focused public entries; import
  page-specific query interfaces only when their loaders run.
- Separate the generic page skeleton from workflow hub presentation, then load
  the latter on workflow navigation. Load selected-step inspector controls on
  selection, inside their existing fixed-size lens with shared skeletons.
- Isolate React, Router and Query's runtime so app changes preserve its cache.
  Leave automatic chunking in charge of all feature code.
- Verify build/typecheck, lint, unit and mocked browser journeys; compare login,
  Home, workflows, selected-step editor, run detail and Settings at phone and
  desktop widths in both themes. Exercise owned live editor journeys when the
  fixture port is available. Record measurements and screenshots in the local
  audit requested for this task.

CodeMirror, Markdown and React Flow already have route/interaction loading
boundaries. Keep synchronous graph commands and validation together where
splitting would change their behavior; do not add workers or dependencies to
chase a chunk target.
