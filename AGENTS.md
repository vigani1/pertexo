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

## Where code lives

Before changing files in a package or app, read its `AGENTS.md`. A package's
`AGENTS.md` adds to these rules or names exceptions with reasons; it never
restates or contradicts them.

| Kind of code | Lives in | Never |
|---|---|---|
| Defaults and limits (timeouts, sizes, retention, batch sizes) | One named constant at its owner, beside the concept it limits; browser-safe ones in `contracts` or `workflow-model` | A bare number or duration string in logic or copy |
| Configuration (environment) | Read and validated once in a config module (`config.ts`, `<subject>-config.ts`, or an app's `config/` folder), then passed inward typed | `process.env` anywhere else |
| Decisions | Pure functions with no I/O (`variables/replacement.ts`) | Mixed into database or HTTP code |
| Database access | `.repository.ts`, or `.store.ts` as a flow's facade | Inline in an operation |
| Live connections | `.runtime.ts` | Created ad hoc |
| Operations | One verb-named file per operation, reading as the happy path, helpers below | Rules buried in a controller or hook |
| Errors | One `.errors.ts` per subject; safe messages made once, at the boundary | A generic `throw new Error` in domain code |
| Helpers | With their one owner; shared only when two or more owners use them and they name a real concept | `utils`, `helpers` or `common` |
| Shared jobs | The one named way, listed below | A second hand-rolled version |
| User-facing text | The web app, with numbers taken from their owners | Text in backend logic |

The one named way for each shared job:

- **Persisted ids:** `generatePersistedId` (`@pertexo/database/platform`).
- **Time:** stored facts take `statement_timestamp()` in SQL; process code that
  decides by time takes an injected `now` (default `Date.now`).
- **Audit:** `appendAuditFact`/`appendAuditFacts` (`core/governance/audit/facts.ts`).
- **Idempotent commands:** `claimCommand`/`completeCommand` (database
  `/primitives`), keyed by `commandKeyHash`/`commandRequestHash`
  (`core/shared/command-fingerprints.ts`), with receipts read by
  `core/shared/receipts.ts`.
- **Logging:** `createStructuredLogger` and `redactCredentialFields`
  (`@pertexo/observability/server`).
- **Retries:** step retries `decideRetry` (`workflow-engine/attempt/retries.ts`);
  transport redelivery in the queue's job defaults (`queue/jobs/defaults.ts`);
  provider `Retry-After` through `parseRetryAfterMillis` (`integrations/http/retry-after.ts`).
- **Outbound HTTP:** the secure client in `@pertexo/secrets/server`.

**Crowding:**

- A file has one reason to change.
- A package's `src` root holds only its entry files and at most a few named
  core concepts, each listed with a reason in the package's `AGENTS.md` (a
  check enforces it).
- A folder with about ten files is a prompt to look for a sub-area.
- Long functions are split by step.

## Code conventions

- Dependencies run `apps -> core -> secrets -> database`, and
  `core -> database, workflow-engine, workflow-model, policy`; only applications depend on
  `core`, and only applications and `core` on `secrets`
  ([ADR 091](docs/adr/091-core-layer.md)).
- A core flow opens its transaction through `withWorkspaceAccess`
  (`core/src/shared/`), which checks authority inside it and hands the flow the
  role it found. Keep a flow's lock order; if a flow doesn't fit the helper, stop
  and report.
- Workspace status lists are the named constants in `policy` (`ACTIVE_`,
  `BROWSABLE_`, `UNPURGED_`, `ALL_WORKSPACE_STATUSES`), and a flow names its list
  once, at that helper. Replace a literal only with a constant holding the same
  values.
- From the one-shot move on, a core area imports the files another area's
  `index.ts` names, directly, never through that `index.ts`, so no barrel edges
  appear. Until
  the areas' strongly connected group is broken up, an area's entry point doesn't
  narrow what a process loads.
- Packages use at most two entry points: `@pertexo/<name>` (safe anywhere,
  including the browser) and `@pertexo/<name>/server` (Node only). The accepted
  exceptions, all Node only:
  - `core` has one entry point per area (`@pertexo/core/<area>`) and `/testing`;
    it has no root and no `/server`.
  - The database has `/schema` and `/primitives` for `core` and `secrets` alone,
    `/platform` for pools and startup, and `/testing` for fixtures. Applications may
    import only `/platform`, plus `/testing` from tests (a check enforces it).
  - `@pertexo/observability/startup`: instrumentation must load before the
    dependencies it instruments.

  `/testing` is for tests and never loads from a `src`. Do not add consumer-named
  barrels or expose database or core entry points to the browser.
- Name and place files by [Naming and layout](#naming-and-layout) below.
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

## Naming and layout

[docs/naming.md](docs/naming.md) explains these rules with examples; the rules
live here.

- **Words:** lowercase kebab-case for directories and the words of a filename;
  dots separate a subject from a role (`workspace-variables.store.ts`). Use
  `.tsx` only for JSX. Exported names keep TypeScript conventions.
- **Subjects:** an operation is a complete verb and object (`start-run.ts`);
  a clear owning path may supply the object for a short private operation
  (`variables/replace.ts`). A concept is a concrete noun (`command-retry.ts`).
  Choose the shortest subject that identifies the file with its path; repeat
  the directory's subject when it helps, never the whole ancestor chain. Never
  shorten a name by truncating words, acronyms or a sentence.
- **Banned names:** `contract.ts`, `types.ts`, `utils.ts`, `helpers.ts`,
  `common.ts`, or any name that avoids choosing a responsibility. Keep types
  and the small values that change with them together under the concept's name;
  never split a coherent module just to earn a `.types.ts` or `.schemas.ts`.
- **Roles** are optional suffixes that say how a module takes part; they are not
  layers or mandatory files, and renaming one moves no authority. Only these
  exist (a check enforces it):

  | Role | Meaning |
  |---|---|
  | `.repository.ts` | Database reads and writes, locks, row projections and persistence orchestration |
  | `.store.ts` | A bound interface to state that assembles operations and owns their context (core flow facade; browser local state) |
  | `.service.ts` | API operations that adapt requests and coordinate dependencies (one role for the API's service and use-case modules) |
  | `.controller.ts` / `.module.ts` | Framework transport handlers / framework composition |
  | `.guard.ts` / `.filter.ts` / `.tokens.ts` | NestJS guards / exception filters / injection tokens |
  | `.definition.ts` / `.executor.ts` | A step's identity, manifest and registration / its execution |
  | `.errors.ts` | An error family and its boundary translation |
  | `.runtime.ts` | Construction and lifetime of live resources (a time helper is an operation, not a runtime) |
  | `.schemas.ts` | Runtime schemas and their parsing support |
  | `.validation.ts` | Semantic validation and inspection functions |
  | `.types.ts` | Only erased declarations and type-only re-exports |
  | `.openapi.ts` | An area's OpenAPI description (`contracts`) |
  | `.queries.ts` / `.api.ts` / `.mutations.ts` / `.public.ts` | Browser only: query cache reads / endpoint calls / mutations / a feature's interface |

- **Entry files:** `index.ts` only re-exports. Keep `server.ts`, `main.ts`,
  `testing.ts`, `startup.ts`, `public.ts`, the database's `schema.ts`,
  `primitives.ts` and `platform.ts`, and tool-defined filenames in their roles.
  Do not add entry points to make names uniform.
- **Directories:** start with a real area, then a sub-area with its own
  responsibility, then a role directory only inside it; keep the web app's
  `pages`, `components`, `hooks`, `data`, `forms`, `model` layout. No top-level
  collections of all repositories or controllers. A single-file directory needs
  an area, a deliberate interface or a role slot shared with peers; no empty
  slots. About ten direct files prompts a review, not a forced split: eleven to
  fifteen related files stay together when splitting adds navigation without
  separating a responsibility, and a deliberate catalog of named peers (UI
  primitives) can be larger. Prefer at most four directories below `src`;
  review five or more. Neither number justifies a move without a better
  grouping.
- **Tests:** in the workspace `test/` tree (browser `e2e/`, `e2e-live/`),
  mirroring the owning area, named by topic or a finished behavioural sentence.
  `.test.ts` is discovered, `.integration.test.ts` is the integration lane,
  `.spec.ts` is Playwright, and `.cases.ts` registers cases for one discovered
  suite and is never discovered itself. Fixtures and support stay beside the
  tests they serve; tests sharing one fixture lifecycle stay under their owner,
  not one test file per source helper. Full sentences go in `it` descriptions.

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
