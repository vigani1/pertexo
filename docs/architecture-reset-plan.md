# Architecture reset plan

Status: **accepted** — 2026-10-08. Decision record: [ADR 069](adr/069-architecture-reset.md).
This file is the single plan and the single progress log for the reset. Every
reset PR updates the tracker below. Nothing else tracks this work.

## Why

Pertexo's foundation is good: clean package layers, a pure engine, an easy
node/integration shape, typed API contracts and feature-organised API/web code.
Around that foundation, the project built production machinery for a product
that has not launched: business rules inside the database, a second copy of the
engine's rules, six database logins, release-compatibility cohorts, two-region
storage, an audit ledger, numbered formats, ~33k lines of custom tooling
scripts, ~33k lines of Markdown docs and ~41k lines of generated inventories. Every feature pays for all of it (folders, tags and
favorites added ~40,800 lines), and F08 showed where that leads.

The reset keeps the foundation and removes what is unnecessary or overbuilt,
now, as one ordered program — not "whenever we touch it".

## Rules for every step

1. **Two-question test** before building anything "for the future":
   *Would adding it later be much harder than now?* *Do we realistically need it
   within about a year?* Two "no" answers mean: don't build it, keep a clean seam.
2. **One way per thing:** one engine, one place per rule, one table definition,
   one format per stored thing, one check per input.
3. **Lean, not minimal:** complete, correct behavior; no speculative machinery.
4. **Rules live in TypeScript; the database stores.** The database keeps tables,
   constraints, workspace isolation, transactions and the few operations that
   must be atomic in SQL (queue claiming, capacity counters).
5. **Stop rule:** anything not in this plan goes to *Parked* below and is not
   built until the user decides.
6. **One step, one PR (or a few), green CI, then merge.** Each PR reports lines
   added vs removed. A cleanup that grows the code is called out.
7. **Renames and moves are separate commits from logic changes.**
8. ADRs only for hard-to-reverse decisions. This reset has one: [ADR 069](adr/069-architecture-reset.md).
9. **Every change is traceable.** Each PR description has a *Moved* table
   (from → to, why) and a *Removed* list (what, why), so it is always clear
   where a rule went and why something disappeared.
10. Work rules: no subagents; commits as the user; the pre-push hook is never
   skipped; history is never rewritten.

## Tracker

- [x] **0. Revert F08 from main** ([#163](https://github.com/vigani1/pertexo/pull/163)) — remove #149, #159, #162 (migrations 0136–0141,
      native value path, ADR065/066). Recreate local databases.
- [x] **1. Plan, ADR 069 and agent rules** — this plan, ADR 069, superseded
      ADRs marked, rewritten `AGENTS.md` and `CONTRIBUTING.md`.
- [x] **2. CI, tooling and docs reset** — six standard jobs, fast pre-push,
      custom gates that enforce the old structure removed; old plans, audits,
      progress logs and generated inventories deleted (git keeps history).
- [x] **3. Remove release machinery** — no cohorts; the API and worker serve one
      catalog with every node; the database no longer stores node releases or
      gates deployments on them; startup readiness is migration head + PostgreSQL
      version; every feature switch is on. Collapsing old node versions, release
      history and numbered formats moves to the node-sdk, nodes-core,
      node-catalog and engine package passes (step 8).
- [x] **4. Storage and ops simplification** — single-region artifact store, no
      control ledger, ops apps merged, deployment definitions cleaned (no
      cohort variable, no recovery store), one-command local setup.
  - [x] One storage region: no recovery store, object-store control ledger,
        regional write admission or recovery app. The worker runs retention,
        workspace purge and deletion commands; the retention and
        lifecycle-command apps are gone. Deployment definitions match, and the
        unexercised deployment validators and E01 evidence packet are removed.
  - [x] `operator-command` becomes `apps/ops`; `pnpm dev` starts the services,
        migrates, seeds a development account and runs the API, worker and web.
- [x] **5. Database foundation** — tables defined once, one baseline migration,
      three database roles, repository layout.
  - [x] One baseline: `0000_baseline.sql` (generated from a database migrated
        through 0137, roles templated) replaces 135 migrations. The runner
        drops the execution plan, data-migration jobs and published checksums,
        and refuses a database built from the old history. Migration structure
        and upgrade-path tests are removed.
  - [x] Three database roles: `owner` (migrations), `app` (API and worker)
        and `maintenance` (outbox dispatch, retention, workspace lifecycle
        commands, ops). Two runtime URLs (`DATABASE_URL`,
        `DATABASE_MAINTENANCE_URL`) replace five. Tests of the old API, worker
        and dispatcher privilege splits are removed; app/maintenance and
        tenant isolation tests stay.
  - Repository layout moves into steps 6 and 7: each area gets its final
    folder (`runs/`, `queue/`, `outbox/`, …) and entry point when it is moved
    or ported, so no file moves twice. The consumer-named entry points
    (`/api`, `/worker`, `/maintenance`, `/lifecycle`) go at the end of step 7.
  - Tables defined once: the 42 raw-SQL tables get Drizzle definitions as their
    areas are ported in step 7 (tables that step 7 deletes are never typed);
    drizzle-kit generates migrations once every table is typed (step 9).
- [x] **6. Execution package** — run actions and the coordinator move out of the
      database package; the engine's rules exist once.
  - [x] Advancing a run: `@pertexo/execution` `advanceRun` locks the run,
        lets the engine decide and saves the transition in one transaction
        (`database/src/runs/advance`). The database's copies of engine rules
        (plan, status and physical-state validation, the rejected For Each
        proof, the transition fingerprint) are removed; a redelivered message
        is recognised by its receipt. `run_checkpoints.last_transition_fingerprint`
        is unused and goes in the step 9 re-squash.
  - [x] One initial checkpoint for every way a run starts (manual, replay,
        webhook, schedule, operator replay): `createInitialCheckpoint` in
        execution replaces the API's and the worker's copies.
  - [x] Run storage lives in `database/src/runs`: `commands/` (acceptance,
        manual start, replay, cancel), `queries/` (list, read, run data,
        statistics, step history, usage capacity) and the run repository.
        Every way a run starts takes one `InitialCheckpointFactory`, which
        execution provides (`initialCheckpointFactory`). Start, replay and
        cancel keep their transaction in the database and get the engine's
        part from execution, the same seam as advancing: moving the
        transactions themselves would make execution a pass-through.
  - [x] Attempt inputs: execution's `loadAttemptInputs` projects a join's
        selection and a For Each item from the checkpoint with the engine's
        types; the database reads rows only (`loadInputs`,
        `readLoopDeclaration`). The database's checkpoint schema copy
        (`compatibility/persisted-workflow-checkpoint*`, ~800 lines) is gone;
        run acceptance keeps only the check that the checkpoint belongs to the
        run row.
  - [x] `database/src/execution` is gone: attempts, previews,
        notifications (with destinations), outbox, inbox, trigger pause and
        artifacts each have their own area. Claim, heartbeat, completion and
        delivery stay storage there.
  - [x] For Each overflow check. It reproduces on ordinary workflows, and the
        cause is total invocations, not concurrency: the checkpoint keeps every
        finished iteration, and each record repeats its node IDs. With editor
        IDs, one For Each overflowed between 400 and 500 items. The authoring
        limits now fit: 200 nodes, invocations and loop items, 64-character
        identifiers, and the same run iteration budget. The engine's executable
        gets its own member limit so 200-node graphs publish. Measured by
        `workflow-engine/test/checkpoint-capacity.test.ts`; recorded in the
        ADR 020 amendment. Raising the limits means dropping finished
        iterations from the checkpoint (step 10).
- [ ] **7. Database feature areas** — authoring, workspaces, connections,
      triggers, notifications, inbox, workspace lifecycle and retention: rules
      to TypeScript, thin repositories, validate once, unused SQL functions
      dropped. Workspace lifecycle and retention drop the database's own
      control record chain (`retention_control_*`, the ledger projection and
      audit facts) and the parked legal-hold tables and checks.
  - [x] Retention runs as TypeScript rules under the maintenance role
        (`lifecycle/retention.ts`): one page per rule per pass, one worker per
        rule. Batches, schedules, dry runs and the ops `retention.rerun` and
        `purge.rerun` commands are gone.
  - [x] Workspace deletion and restore change the workspace in the request's
        transaction, with their side effects in TypeScript
        (`lifecycle/workspace-deletion.ts`); runs are canceled through the run
        cancel path. The leased lifecycle command worker, the control ledger
        projection and audit facts, and the purge jobs, steps and completions
        are gone. The API keeps its response shape; it now always reports a
        completed operation (simplify with the web in step 8).
  - [x] Workspace purge (`lifecycle/workspace-purge.ts`) deletes one page per
        call from a TypeScript step order, scrubs kept audit and usage facts,
        erases objects outside any transaction and leaves a tombstone. A test
        checks every workspace table is purged or kept on purpose.
  - [x] Preview cleanup and run-artifact retention run in TypeScript
        (`lifecycle/preview-retention.ts`, `run-artifact-retention.ts`): row
        locks and the artifact's retry time keep workers apart, so the
        workspace control columns, `lock_workspace_control_ledger`, the
        session-level destruction lock and the preview destruction capability
        rows are gone.
  - [x] Transient data runs as retention rules too: expired receipts and
        idempotency records, sessions and sign-in records, invitation expiry,
        acceptances, replacement claims and recipient addresses, input-case
        leftovers and favorites. The reaper functions, the claim scan cursor
        and the per-fact legal hold are gone.
  - [ ] Legal-hold table: nothing places holds any more. Drop it with the
        last checks of it: the favorite command and its held evidence
        (Authoring), replacement-claim reapability (Workspaces and access) and
        inbox expiry (Notifications and inbox).
  - [x] Organization commands (folders, tags, placement, batches) run in
        TypeScript (`authoring/organization/`). An advisory lock per workspace
        orders them, and their keys use `idempotency_records` through the
        shared `platform/idempotency.ts`; the organization receipt table goes.
        Every other area moves to the same helper and drops its receipt table
        when it is ported.
  - [ ] Favorites: a simple idempotent on/off (no revisions, absence tokens,
        membership generations, receipts or held evidence); then the
        organization rollout flag and coordination table go.
  - [ ] Authoring: drafts, publication, portability, input cases, concurrency
        and auto-pause.
  - [ ] Workspaces and access: memberships, invitations (including the
        replacement-claim scan's unused purge mode), ownership, identity.
  - [ ] Connections.
  - [ ] Triggers: schedules and webhooks.
  - [ ] Notifications and inbox.
  - [ ] Consumer-named entry points (`/api`, `/worker`, `/maintenance`,
        `/lifecycle`).
- [ ] **8. Package-by-package pass** — read every file of every package and app,
      bottom of the dependency graph first, and redo, remove or improve using
      the checklist below. One PR per package (several for the large ones):
  - [ ] workflow-model
  - [ ] workflow-engine
  - [ ] node-sdk
  - [ ] nodes-core
  - [ ] integrations
  - [ ] node-catalog
  - [ ] templates (new)
  - [ ] contracts
  - [ ] queue
  - [ ] artifact-store
  - [ ] observability
  - [ ] rate-limit
  - [ ] database
  - [ ] execution
  - [ ] worker
  - [ ] api
  - [ ] web
  - [ ] ops
- [ ] **9. Finish** — final re-squash of migrations, `docs/architecture.md`
      map completed, root scripts and README final.

**Package pass checklist** (every package, every file):
1. Purpose: the package does one clear job; anything else moves to its owner.
2. Every file earns its place: dead, duplicate, speculative or overbuilt code
   is removed (two-question test).
3. Names follow the conventions; no file repeats its folder; no version
   numbers before launch.
4. Entry points: only the two doors; no oversized re-export files.
5. Code is readable: small functions, plain names, comments explain why.
6. Validation happens once, at the boundary.
7. Tests check behavior; structure-only tests and test hooks are removed.
8. The PR reports lines before/after and what was removed and why.
- [ ] **10. Re-plan F08** on the new structure (separate plan, after the reset).
      Include dropping finished loop iterations from the checkpoint, which is
      what lets the 200-invocation limit grow.

## Target structure: where everything lives

```
apps/
  api/        HTTP only: routes, auth/session, request parsing, calls execution
              for actions and database for reads
  worker/     job loop: runs node attempts, advances runs, triggers, maintenance
              (retention purge, schedule scans)
  web/        React app (unchanged structure)
  ops/        one operator CLI with subcommands (replaces lifecycle-command,
              operator-command, recovery, retention)
packages/
  workflow-model/   graph, expressions, validation, JSON helpers — browser-safe
  workflow-engine/  pure "what happens next" rules — the only copy
  execution/        NEW: actions — start/cancel/replay/advance run, claim and
                    complete attempts, previews, notification decisions
  database/         tables (defined once), migrations, repositories, queries,
                    transactions, workspace isolation, queue claiming, outbox
  contracts/        API request/response shapes (browser-safe) + OpenAPI (server)
  node-sdk/         how a node is written: manifest, schemas, executor contract
  nodes-core/       built-in nodes
  integrations/     provider nodes (HTTP, email, Slack) + safe outbound HTTP
  node-catalog/     the registry that combines built-in and provider nodes
  templates/        NEW: curated template content (out of model and catalog)
  queue/            generic job queue and pub/sub primitives only
  artifact-store/   single-region object storage behind one interface
  observability/    logs, metrics, tracing
  rate-limit/       rate limiting
```

Dependency direction (no cycles, enforced by lint):

```
workflow-model ← workflow-engine ← execution ← api / worker
node-sdk ← nodes-core / integrations ← node-catalog ← execution, worker
database ← execution, api (reads), worker
workflow-engine ← database (plan and checkpoint types only)
contracts ← api, web        web imports only browser-safe entry points
```

`database` no longer depends on `nodes-core`.

## Conventions

**File names.** The folder says the area; the file says what it is.
- Actions are verbs: `execution/src/runs/start-run.ts`, `cancel-run.ts`.
- Storage is noun + role: `database/src/runs/runs.repository.ts`,
  `run-history.queries.ts`.
- No file repeats its folder name (today 195 of 1,659 do, e.g.
  `node-attempts/node-attempt-run-store-claim.ts` → `attempts/claim.ts` style).
- The web keeps its existing pattern (`*.api.ts`, `*.queries.ts`,
  `*.mutations.ts`, `components/`, `model/`, `*.public.ts`).

**Group by directory.** No long flat folders anywhere (today, for example,
`apps/api/src/workflow-authoring/` has ~40 files side by side and several web
features have 10–20 files at their root). A folder holds at most ~10 files;
beyond that, files are grouped into subfolders — by sub-area first
(`workflow-authoring/folders/`, `/tags/`, `/favorites/`), then by role. Web
features use the same role folders everywhere: `components/`, `hooks/`, `api/`
(api + queries + mutations), `model/`, plus one public entry file. The design
itself does not change.

**Entry points.** Every package has at most two doors:
`@pertexo/<name>` (safe anywhere, including the browser) and
`@pertexo/<name>/server` (Node only). Areas get their own subpath only when
they are large (`@pertexo/database/runs`, `@pertexo/contracts/workflow-runs`).
No consumer-named barrels (today `@pertexo/database/api` re-exports 227 names).
ESLint enforces the doors at build time; the 36 runtime `server-only.ts` throws
and the custom import allowlist script go away.

**Validation.** Input is parsed once where it enters (HTTP request, job
payload, provider response). Inner layers trust typed values.

**Tests.** Test behavior, not structure. Production code contains no test hooks.

## Database design

- **Tables defined once** in Drizzle (today 77 tables are typed and 43 exist
  only in raw SQL plus a JSON registry). Queries use Drizzle's typed builder or
  `sql` templates with typed results — no hand-written column lists, row
  mappers or row validation.
- **Migrations** are generated from the schema (drizzle-kit) plus small
  hand-written SQL files for policies, grants and the few SQL functions that
  remain. The 135 historical migrations become one baseline (nothing is
  launched; existing databases are recreated). One final re-squash happens in
  step 9.
- **Three roles:** `owner` (migrations), `app` (API and worker; row security
  forced, workspace set per transaction), `maintenance` (cross-workspace jobs:
  outbox dispatch, retention purge, workspace lifecycle commands, operator
  commands). The outbox dispatcher is maintenance because its policies span
  every workspace. Before step 5 there were six logins and 269
  elevated-rights functions.
- **Workspace isolation stays** as row security policies — limited to
  isolation, never business rules.
- **What stays in SQL:** constraints (unique, foreign key, check), queue claiming
  (`FOR UPDATE SKIP LOCKED`), counters that must be atomic (run capacity),
  the checkpoint version check on save. Everything else moves to TypeScript.
- **Removed:** database-stored feature switches (`*_rollout` tables), function
  definition fingerprint pinning, the raw-table registry, duplicate permission
  checks in SQL (the API authorizes once).
- **How the database is worked through:** known-dead machinery is deleted
  wholesale without a line-by-line read (re-check copies, fingerprint and grant
  tests, the table registry, rollout switches, role boilerplate, compatibility
  tables). Code that carries real business rules (capacity and queue admission,
  idempotency, membership and lifecycle rules, retention) is read once and ported
  to TypeScript, so no behavior is lost. Behavior tests guard both.

## Execution package (new)

Moves out of `database/src/execution` (18.7k lines today):

| Today | Goes to |
|---|---|
| coordinator: load/save run state, events | `database/runs` (repository) |
| coordinator: advancing a run | `execution/runs/advance-run.ts` (calls the engine) |
| coordinator: re-check copies of engine rules (`*-status-validation`, `*-plan-validation`, `*-physical-state`, `rejected-loop-proof`) | deleted — the engine owns these rules |
| runs: start, cancel, replay, manual start | `execution/runs/*` |
| runs: lists, statistics, step history, run data | `database/runs/*.queries.ts` |
| node-attempts: decisions | `execution/attempts/*` |
| node-attempts: claim, heartbeat | `database/queue` |
| previews | `execution/previews` (+ storage in `database`) |
| notifications: policy | `execution/notifications` (+ storage in `database`) |
| transport (outbox) | `database/outbox` |

A finished node then flows: worker → `execution.advanceRun()` → one
transaction → load state → engine decides → save state and events → commit.

During this step, check the loop overflow found during F08: a For Each running
~1,000 items at once exceeded the saved-state size limit. If it reproduces on
ordinary workflows, cap loop concurrency to a measured value that fits.

## Package-by-package changes

| Package | Keep | Change / remove |
|---|---|---|
| workflow-model | graph, expressions, validation | templates → `templates`; worker runtime helpers → worker; `invocation-key-v2` → one key format; trim 17 entry points |
| workflow-engine | pure advance function | one checkpoint format (v1/v2 collapse) |
| node-sdk | manifest, schemas, executor contract | `release.ts` and `compatibility-canonical.ts` release rules removed; old manifest grammar removed |
| nodes-core, integrations | as is (very good) | — |
| node-catalog | registry | cohort/epoch release config removed; template policy → `templates` |
| contracts | shapes and OpenAPI | `schemas/*` vs root pairs renamed to shapes (browser) + `openapi` (server) |
| queue | queue, producer, consumer, pub/sub | inbox and run-event channels move to their features |
| artifact-store | single store behind one interface | dual-region store and control ledger removed |
| observability, rate-limit | as is | — |
| database | see above | see above |

## Apps

- **api:** keeps feature folders and use cases. Favorites become a simple
  idempotent on/off (the signed "absence token", 174 lines, goes). Actions call
  `execution`.
- **worker:** gains retention purge and maintenance loops from `apps/retention`.
- **ops (new):** one CLI replacing `lifecycle-command`, `operator-command`,
  `recovery`, `retention`. `recovery` (restore-before-serve for two-region
  storage) is removed with the ledger.
- **web:** structure unchanged; imports follow the new contract entry points.
  `apps/web/ARCHITECTURE.md` (4,899 lines) is cut to the parts that guide work.

## CI and tooling

| Job | Runs |
|---|---|
| check | format, lint (incl. import doors), typecheck, build, knip |
| unit | unit tests for affected packages |
| integration | real Postgres + Redis behavior tests |
| e2e | Playwright browser tests |
| image | production image build + startup smoke |
| security | CodeQL + dependency review |

- Target: CI under ~10 minutes (today 15–19, with 13 jobs and 133 steps).
- No per-feature CI jobs (today: organization, curated templates, compatibility).
- Removed custom tooling: coverage provenance/witness/risk reviews, mutation
  sensitivity, complexity and duplication baselines (ESLint `complexity`
  instead), CI-file policy validator, upstream IANA comparison on every run,
  docs validator, generated `docs/remaining-work` inventories.
- Root scripts: from 66 to the handful people use (`dev`, `build`, `check`,
  `test`, `test:integration`, `test:e2e`, `db:migrate`, `db:generate`).
- Pre-push hook: format, lint, typecheck and unit tests for changed packages.
  It is never skipped.

## Local setup

`pnpm dev` starts Postgres, Redis and one object store, runs migrations, seeds a
development account and starts api, worker and web. No cohort variables, no
key-service emulator, no ledger services (today compose has 8 services).

## Docs after the reset

- `README.md` — what Pertexo is and how to run it.
- `docs/architecture.md` — the "where everything lives" map (from this plan).
- `CONTEXT.md` — the glossary.
- `docs/adr/` — kept as history; ADRs replaced by 069 get a "Superseded" line.
- `docs/feature-plans/` — short plans for upcoming features.
- `docs/operations/` — only runbooks that still apply.
- Deleted (git keeps them): the backend plan, research, audits, progress logs,
  `docs/remaining-work/*.json`, obsolete operation notes.
- `AGENTS.md` rewritten around these rules. Skills stay, with two changes: no
  interview-driven ADR writing (`grill-with-docs`), and `code-review` only when
  the user asks for it.

## Not changing

Monorepo layout, NestJS/Fastify, React/TanStack/Vite, Postgres + Redis/BullMQ,
the pure engine, the node/integration shape, typed contracts, immutable
published versions, workspace ID on every row, outbox delivery, idempotency
keys, auth (Better Auth/OIDC), the Weft design system.

## Parked (decide later; not built)

- F08 subworkflows — re-planned after step 9.
- Two-region storage — returns when a customer or regulation needs it.
- Release compatibility for rolling mixed-version deploys — returns at launch.
- Audit ledger and legal hold — return for enterprise/compliance work.

## Risks

- Large deletions of structure tests are expected; behavior tests must stay
  green at every step.
- The baseline migration recreates every existing database (local only today).
- Steps 5–7 touch the most code; they are split into several PRs.
