# Project Instructions

## Source of truth

- During the architecture reset, `docs/architecture-reset-plan.md` is the plan
  and the only progress log. Update its tracker in every reset PR; never mark a
  step done while its work remains.
- Otherwise use the user's request, `CONTEXT.md` (glossary), the ADRs that are
  not superseded, and the current code. [ADR 069](docs/adr/069-architecture-reset.md)
  overrides older ADRs where they conflict.
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
- **Rules live in TypeScript; the database stores.** PostgreSQL keeps tables,
  constraints, workspace isolation, transactions, queue claiming, capacity
  counters and the checkpoint version check.
- **Stop rule:** if work seems to need a subsystem, format, role, CI job or ADR
  that the plan does not contain, stop and ask the user instead of building it.
- Write ADRs only for hard-to-reverse decisions.

## Code conventions

- Each package has at most two entry points: `@pertexo/<name>` (safe anywhere,
  including the browser) and `@pertexo/<name>/server` (Node only).
- Group files by directory: sub-area first, then role. A folder holds at most
  ~10 files; no long flat lists.
- The folder names the area and the file names what it is. File names never
  repeat their folder. Actions are verbs (`start-run.ts`); storage is noun plus
  role (`runs.repository.ts`).
- Validate input once where it enters. Inner layers trust typed values.
- Tests check behavior, not structure. Production code has no test hooks.
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
- Do not use subagents unless the user asks.

## Git discipline

- Preserve unrelated and uncommitted work. Inspect `git status` and the diff
  before handoff.
- Commit as the repository owner; do not add co-author trailers.
- Use imperative Conventional Commit messages (`feat:`, `fix:`, `refactor:`,
  `test:`, `docs:`, `ci:`, `chore:`, `revert:`).
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
