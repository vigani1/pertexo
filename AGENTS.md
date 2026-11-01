# Project Instructions

## Source of truth

- Use the user's request, `CONTEXT.md` (glossary), the ADRs that are not
  superseded, and the current code. [ADR 069](docs/adr/069-architecture-reset.md)
  overrides older ADRs where they conflict, and [ADR 091](docs/adr/091-core-layer.md)
  overrides it on the `core` layer and entry points.
- The architecture reset is complete. `docs/architecture-reset-plan.md` is its
  history, not a tracker to update.
- Feature work follows a short plan in `docs/feature-plans/`. Update a plan only
  when the work changes what it claims.

## Design rules

- **Two-question test** before building anything "for the future": would adding
  it later be much harder than now, and is it realistically needed within about
  a year? Two "no" answers mean: keep a clean seam, don't build it.
- **One way per thing:** one engine, one place per rule, one table definition,
  one stored format, one validation of each input at the boundary.
- **Lean, not minimal:** complete, correct behavior without speculative
  machinery.
- **Illegal states can't be written:** use tagged unions, not optional fields
  that must agree with each other (a failed result always carries its error).
- **No hidden coupling:** when two places must agree (a path shape, a constant,
  an order), share the definition or let a check or test enforce it.
- **A wrapper earns its place:** it hides a detail, adds a rule or is a
  deliberate seam for an outside service. A wrapper that only forwards or
  renames goes; call the thing directly.
- **One change, one place:** if a product change has to touch many unrelated
  files, move the boundary instead of editing everywhere.
- **One reason to change per file.** The 400-line lint limit is a prompt to
  look, not the rule itself.
- **Keep errors specific:** don't swallow or blur them into a generic failure;
  turn them into safe messages once, at the boundary.
- **Ask before hardening against the unlikely:** before adding complexity for a
  race or security case that is unlikely to happen, explain the concrete
  failure, how likely it is and what it costs, and get the user's agreement.
  Security at real boundaries (sign-in, workspace isolation, input limits) is
  not optional.
- **Rules live in TypeScript; the database stores.** PostgreSQL keeps tables,
  constraints, workspace isolation, transactions, queue claiming, capacity
  counters and the checkpoint version check.
- **Stop rule:** if work seems to need a subsystem, format, role, CI job or ADR
  that the plan does not contain, stop and ask the user instead of building it.
- Write ADRs only for hard-to-reverse decisions.

## Code conventions

- Dependencies run `apps -> core -> database, workflow-engine, workflow-model`;
  only applications depend on `core` ([ADR 091](docs/adr/091-core-layer.md)). The
  `secrets` package it names doesn't exist yet; it's created in a step of its own.
- A core flow opens its transaction through `withWorkspaceAccess`
  (`core/src/shared/`), which checks authority inside it and hands the flow the
  role it found. Keep a flow's lock order; if a flow doesn't fit the helper, stop
  and report.
- Workspace status lists are the named constants in `workflow-model` (`ACTIVE_`,
  `BROWSABLE_`, `UNPURGED_WORKSPACE_STATUSES`), and a flow names its list once, at
  that helper. Replace a literal only with a constant holding the same values.
- From the one-shot move on, a core area imports the files another area's
  `index.ts` names, directly, never through that `index.ts`, so no barrel edges
  appear. Areas not yet passed sit on the check's list, which can only shrink. Until
  the areas' strongly connected group is broken up, an area's entry point doesn't
  narrow what a process loads.
- Packages use at most two entry points: `@pertexo/<name>` (safe anywhere,
  including the browser) and `@pertexo/<name>/server` (Node only). The accepted
  exceptions, all Node only:
  - `core` has one entry point per area (`@pertexo/core/<area>`) and `/testing`;
    it has no root and no `/server`.
  - The database has `/schema` and `/primitives` for `core` alone, `/platform` for
    pools and startup, and `/testing` for fixtures. Applications may import only
    `/platform`, plus `/testing` from tests (a check enforces it).
  - `@pertexo/observability/startup`: instrumentation must load before the
    dependencies it instruments.

  `/testing` is for tests and never loads from a `src`. Do not add consumer-named
  barrels or expose database or core entry points to the browser.
- Group files by directory: sub-area first, then role. A folder holds at most
  ~10 files; no long flat lists.
- The folder names the area and the file names what it is. File names never
  repeat their folder. Actions are verbs (`start-run.ts`); storage is noun plus
  role (`runs.repository.ts`).
- Validate unknown input once, at the boundary that owns it, and pass typed
  values inward. Don't repeat `typeof` or property-existence checks, and don't
  re-check what a schema, constructor or type already guarantees.
- Extract a helper used once only when it names a real concept
  (`requireConfig`, `readMetadata`). The main function reads as the happy
  path, with its helpers below it.
- Tests check behavior, not structure, against the real code: mock only
  outside services, and never copy the code's logic into the test. Production
  code has no test hooks.
- Write a test from the goal, not the code: decide what a caller, user or
  stored row should show (the plan, guide or bug report) before reading the
  implementation. Assert outcomes (returned values, saved rows, HTTP
  responses, what the screen shows), never which internal functions ran.
- A test must fail when the behavior it guards breaks: for every fix, see the
  new test fail without the fix, then pass with it.
- If a test looks wrong, stop and say why. Never edit, skip or delete a test
  just to get a pass; a loosened or removed assertion needs a reason from the
  plan in its commit message.
- Tests and checks never disturb a live session or running service: use
  isolated browser contexts, ports and compose projects.
- `pnpm check` runs the static checks (format, build, lint, typecheck,
  dependency, contract, schema and architecture). Before handoff, run it plus
  the tests for every package you touched.
- Comments explain why, not what.

## Agent skills

- Load a skill only when the task matches it.
- `codebase-design` for module interfaces and seams; `domain-modeling` for
  `CONTEXT.md` terms; `postgres` for schemas, migrations, row security, queue
  queries and concurrency; `nestjs-best-practices` for API modules; `node` for
  runtime behavior (keep the existing TypeScript build — no type stripping);
  `diagnosing-bugs` for hard failures.
- Frontend skills (`frontend-design`, `shadcn`, TanStack, React and web
  guideline skills) apply to `apps/web`; follow `apps/web/AGENTS.md` there.
- `tdd` only when the user asks for test-first work. `code-review` only when the
  user asks for a review. Do not use `grill-with-docs`.
- Do not use subagents unless the user asks. When work is split across
  agents, a different agent writes the tests than the code they check, from
  the plan and without seeing the implementation.

## Git discipline

- Preserve unrelated and uncommitted work. Inspect `git status` and the diff
  before handoff.
- Commit as the repository owner; do not add co-author trailers.
- Use imperative Conventional Commit messages (`feat:`, `fix:`, `refactor:`,
  `test:`, `docs:`, `ci:`, `chore:`, `revert:`); PR titles use the same form.
- Make commits coherent and buildable. Keep renames and moves in separate
  commits from logic changes.
- Never amend, squash, rebase, force-push or otherwise rewrite history unless
  the user asks. Never skip the pre-push hook.
- Never commit secrets, local environment files or generated runtime data.
- Every PR description has a **Moved** table (from → to, why) and a **Removed**
  list (what, why) when it moves or deletes code, and reports lines added and
  removed.
- Push and merge only when the user has authorized it for the current task.
  Merge with a rebase once CI is green.
- At handoff, report commits, pushes, the branch and any uncommitted changes.
