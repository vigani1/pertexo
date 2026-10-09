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
  - Tables defined once: the raw-SQL tables get Drizzle definitions as their
    areas are ported (tables that step 7 deletes are never typed; the last 27
    are typed in the step 8 database pass); drizzle-kit generates migrations
    once every table is typed (step 9).
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
- [x] **7. Database feature areas** — authoring, workspaces, connections,
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
  - [x] Legal-hold table: nothing places holds any more. It is dropped with
        its last two checks, in replacement-claim reapability and inbox
        thread expiry.
  - [x] Organization commands (folders, tags, placement, batches) run in
        TypeScript (`authoring/organization/`). An advisory lock per workspace
        orders them, and their keys use `idempotency_records` through the
        shared `platform/idempotency.ts`; the organization receipt table goes.
        Every other area moves to the same helper and drops its receipt table
        when it is ported.
  - [x] Favorites are a simple idempotent on/off: a row is a favorite,
        `PUT …/favorite` sets it without an idempotency key, and removing a
        member deletes their favorites. Revisions, signed absence tokens,
        membership generations, receipts, held evidence and the confirm
        dialog are gone, with the organization rollout switch and
        coordination table.
  - [x] Workflow settings: concurrency limits and auto-pause settings and
        resume run in TypeScript on the shared idempotency helper; their two
        receipt tables go. A limit change still takes the run admission lock,
        through one small database function, because admission counters stay
        in the database.
  - [x] Workflow creation: create, duplicate and import write their rows in
        TypeScript, and every workflow command (create, duplicate, import,
        rename, archive and restore, publish) keys through the shared
        idempotency helper. The SQL copies that re-validated imports, the
        database copy of the curated templates (templates live in code) and
        the import rollout switches go.
  - [x] Input cases: commands check authority, limits and revisions once,
        in TypeScript, with keys in `idempotency_records`. The write trigger
        that re-checked them, the case receipt table and the rollout switch
        go, with the checked-start gate that read it; the web no longer has
        an "input cases not enabled" state.
  - [x] Workspaces and access: memberships, invitations (the replacement-claim
        scan and its unused purge mode went with transient retention),
        ownership, identity. The replacement-claim reapability check stays
        in SQL: retention and purge share its recursive lineage walk and the
        advisory locks it takes per binding.
    - [x] Rename, invitation, acceptance, role, removal, departure,
          suspension and ownership commands key through the shared
          idempotency helper; their seven receipt tables go. Profile
          commands belong to a user, not a workspace, and keep theirs.
    - [x] Identity: email proofs, the authentication mail queue, security
          audit facts and the OIDC sign-in capacity check run as plain
          statements in TypeScript; stale sign-in transactions are a
          retention rule. The session-revocation triggers stay because
          Better Auth writes users and sessions too.
  - [x] Connections.
    - [x] History and version tables are append-only through grants alone;
          the eight immutability triggers and the purge "armed" check go.
    - [x] Run-time connection checks (dispatch fence, Slack dispatch binding,
          credential-access audit, health observations and their application,
          notification connection lock) run as statements in TypeScript; the
          health "protocol" marker trigger and the observation cleanup trigger
          go.
  - [x] Triggers: schedules and webhooks. A claimed occurrence's eligibility,
        pause check and completion run as statements in its workspace's
        transaction. The cross-workspace schedule claims, the public webhook
        lookup and the ingress limit stay in SQL. So do the triggers that keep
        an integration from being activated in an inactive workspace: they
        guard eight writers in five areas and races with deletion.
  - [x] Notifications and inbox: the policy and dispatch locks are
        statements in TypeScript, run and intent pins are checked once where
        they are made, inbox reads only move forward in TypeScript, and idle
        inbox threads are a retention rule. The cross-workspace fold and
        notification recovery claims stay in SQL, as does the recipient check
        the inbox row policies use.
  - [x] Consumer-named entry points go: the `api`, `execution`,
        `maintenance` and `operator` barrels are replaced by one entry point
        per area folder (`@pertexo/database/runs`, `/authoring`,
        `/connections`, `/triggers`, `/tenant-access`, `/platform`, …), each
        an `index.ts` in that folder, plus `/testing`.
- [ ] **8. Package-by-package pass** — read every file of every package and app,
      bottom of the dependency graph first, and redo, remove or improve using
      the checklist below. One PR per package (several for the large ones):
  - [x] workflow-model — two doors (`@pertexo/workflow-model` browser-safe,
        `/server` for checksums, expressions and authoring validation) replace
        fifteen subpaths and the runtime server-only guards; ESLint keeps Node
        out of the browser door. Area folders `graph/`, `json/`,
        `portability/`. The invocation key has one format, owned by the
        engine. The "worker runtime helpers" are worker-thread scripts used by
        both the API and the worker, so they stay next to the code that starts
        them. Dead code (retained V1 reader, for-each bounds selection, policy
        schema) and version suffixes go.
  - [x] workflow-engine — one checkpoint format (every run starts on the
        structured shape; the v1 parser, type and creator go) and one
        identity format for loops, joins and completed outputs (the legacy
        fallbacks go). The unused attempt state machine goes, test helpers
        move to `test/support`, files are named by role and version
        suffixes go. The compatibility-release functions stay until the
        node-sdk pass removes release machinery.
  - [x] Release machinery (crosses node-sdk, node-catalog, the engine and
        the database):
    - [x] The API and worker serve one release with every node; successor
          releases, release history and lifecycle transitions go
          ([#189](https://github.com/vigani1/pertexo/pull/189)).
    - [x] Published executables and preview runs no longer pin a release:
          the engine checks a stored executable against the served catalog,
          and migration 0017 drops the epoch and fingerprint columns.
    - [x] The node catalog has no lifecycles, epoch or fingerprint, and
          node manifests have one grammar. `RegistryRelease` becomes
          `NodeCatalog`; the API and worker serve `PLATFORM_NODE_CATALOG`.
          Draft and import compatibility use the definition-list
          fingerprint, and portable manifests no longer carry a selection
          fingerprint.
  - [x] node-sdk — one catalog type (`NodeCatalog`), one manifest grammar,
        no lifecycles, release identity or runtime guard; executors register
        only `{ executor, execute }` and take their metadata from the catalog.
  - [x] nodes-core
    - [x] One version of each node: Schedule, Parallel and Merge keep only
          version 1, with the newest semantics (strict cron and timezone,
          trigger envelope input, unique branch IDs, settled merge ledger).
          `CORE_NODE_CATALOG` holds every core node, and executor manifests
          derive from node manifests (`executorManifestFor`).
  - [x] integrations — manifests and executors follow the node-sdk changes.
  - [x] node-catalog — `catalog.ts` derives `PLATFORM_NODE_CATALOG` from
        the definition registrations; `browser-catalog.ts` projects it for
        HTTP. The registered template setup check stays here because it
        needs the node schemas.
  - [x] templates (new) — the curated templates, their origin schema and
        setup checks live in `@pertexo/templates` (one door, behavior tests);
        the registered setup check stays in node-catalog because it needs the
        node schemas.
  - [x] contracts
    - [x] Two doors: `@pertexo/contracts` (request, response and problem
          schemas, browser-safe) and `@pertexo/contracts/server` (OpenAPI
          documents and client contracts, projected at import). Folders
          `schemas/` (was `http/`), `errors/`, `openapi/`; 28 subpath exports
          and the duplicated root re-exports go.
    - [x] Schemas, OpenAPI documents and tests grouped by area
          (`identity/`, `workflows/`, `execution/`, `triggers/`, `shared/`);
          files drop the prefix their folder names (the `-paths` fragments
          sit beside the document that composes them) and problem files
          drop `-problems`.
    - [x] What nothing reads goes: 62 inferred types, two schemas, the
          artifact transfer client contract export and the
          `provider.rate_limited` problem (never raised). Building blocks
          used only in their own file are no longer exported, and knip
          checks the package's entry exports. Contracts no longer
          re-export workflow-model's portability helpers; their consumers
          import `@pertexo/workflow-model`. `NODE_TEST_LIMITS_V1` loses its
          version.
  - [x] queue
    - [x] No runtime guard; plain export map; structure-only surface tests
          go.
  - [x] artifact-store
    - [x] No runtime guard; files no longer repeat the package name
          (`download.ts`, `errors.ts`, `identity.ts`, `metadata.ts`,
          `request-lifecycle.ts`).
  - [x] observability
    - [x] Two doors instead of nine: `@pertexo/observability/startup`
          (config, process-error classification, telemetry; loaded before
          pino, pg and HTTP so OpenTelemetry can instrument them) and
          `@pertexo/observability`. No runtime guard.
  - [x] rate-limit — one policy table, one Redis script, one runtime. The
        counter "schema version" in Redis keys (a rolling-deploy
        compatibility identity) goes.
  - [x] database
    - [x] Every table typed: the 27 tables that existed only in SQL and the
          JSON registry get Drizzle definitions (columns, keys, checks,
          indexes, foreign keys), checked by generating DDL from them and
          diffing `pg_dump` against the migrated schema. drizzle-orm cannot
          declare two `DEFERRABLE` foreign keys (marked in source) or column
          collations (`textC`). The registry is deleted;
          `database:schema:check` requires every migration table to be typed,
          and the schema-shape test checks owner, primary key, forced row
          security on workspace tables and private grants for every table.
    - [x] Operator commands (outbox redispatch, attempt reconciliation,
          due-work resume, run cancel, unknown-outcome evidence, trigger
          reconciliation, run replay) run in TypeScript under the maintenance
          role, reusing the run cancel, run event and outbox helpers; the
          replay worker settles its own request and command. A command row
          carries its workspace, so it is isolated and purged like other
          workspace rows. Eleven functions and the result trigger go
          (migration 0018), with the operator's own transaction runtime.
    - [x] The SQL that stays is listed with its reason under *Database
          design*. Left for the execution and API passes: the manual-start
          writer fence (an authority check the API already makes), the
          preview artifact retention trigger and the lifecycle time trigger.
    - [x] Repository review.
      - Every area is grouped by sub-area (authoring `workflows/`,
        `portability/`, `publication/`, `settings/`; tenant access
        `invitations/`, `members/`, `users/`; connections `health/`,
        `runtime/`, `connection-tests/`; triggers `schedules/`, `webhooks/`,
        `reconciliation/`; previews `runs/`, `attempts/`, `reconciliation/`;
        `platform/pool/`), and no file repeats its folder.
      - Authoring commands lose their test hooks; tests hold or fail a
        command at one of its writes with a trigger in the disposable test
        database.
      - One stored replay format per command (the connection "legacy
        pointer" and the pre-ADR 041 name-revision default go).
      - One idempotency helper for every workspace command; a claim left in
        any state but completed is refused. Workspace creation (no workspace
        yet) and connection tests (several transactions) keep their own
        claims.
    - [x] One stored executable format: every published version carries
          its executable and an executable checksum (migration 0019). The
          checksum-only "V1" version, its read path, the `not_executable`
          advance outcome and workflow-model's V1 checksum helpers go.
          Authoring reads one `AuthoringCatalogs` value instead of selecting
          catalogs per transaction.
  - [ ] execution
  - [ ] worker
    - [x] Files grouped by the feature they serve: `runs/`, `attempts/`
          (with `artifacts/`), `previews/`, `providers/`, `notifications/`,
          `connections/`, `identity/`, `workflows/` and `operator/`;
          runtime, config, transport and trigger files drop the prefix
          their folder names.
    - [x] One database readiness check: `checkCompatibility` goes from the
          workspace database, the artifact upload store and both Nest
          database modules; the API and worker check readiness at startup.
  - [ ] api
    - [x] Legacy authentication removed: the generic OIDC sign-in, opaque
          sessions and their identities, the legacy-method migration
          journey, the cutover preflight and gate, and the web migration
          page go (migration 0020, ADR 039 amendment). Better Auth is the
          one session authority; tests sign in through it or receive a
          server-issued session for an existing user.
    - [x] Files grouped by feature area, at most about ten per folder:
          `authentication/` (Better Auth, account security, mail),
          `authorization/`, `workspaces/` (members, invitations, request,
          commands, http, persistence), `workflow-authoring/` (commands,
          organization, portability, settings, input cases, http),
          `workflow-runs/` (events, usage, run data, http) and
          `connections/` (failure notifications, use cases, http).
    - [x] Workflow organization is always available: its cursors are
          opaque like every other cursor, so the dedicated signing key, the
          optional organization dependencies and the
          `workflow.organization_unavailable` problem go (ADR 064
          amendment).
    - [x] Workspace deletion and restore complete in the request: they
          answer `200` with the change applied, and the operation read
          route, its contract and the web's polling and `operationId`
          search state go.
  - [ ] web
    - [x] Feature folders by role: only public entry files stay at a
          feature's root; screens go to `pages/`, hooks to `hooks/`, server
          access to `data/` (`*.api.ts`, `*.queries.ts`, `*.mutations.ts`,
          `mutations/`), other logic to `model/` or `components/`. Routes are
          grouped into `root/`, `auth/`, `workspace/` and `workflow/`; shared
          hooks and formatters in `lib/hooks/` and `lib/format/`.
  - [ ] ops
- [ ] **9. Finish** — final re-squash of migrations, `docs/architecture.md`
      map completed, root scripts and README final.
  - [ ] Numbered stored formats go with the re-squash: digest prefixes
        (`wf:v2:sha256:`, `wf-compat:v1:`, `trigger:v1:`, `email:v1:`) lose
        their versions with the check constraints that pin them, and the
        failure-notification `policy_version` (always 1) goes.

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
No consumer-named barrels (`@pertexo/database/api` re-exported 227 names until step 7).
ESLint enforces the doors at build time; the 36 runtime `server-only.ts` throws
and the custom import allowlist script go away.

**Validation.** Input is parsed once where it enters (HTTP request, job
payload, provider response). Inner layers trust typed values.

**Tests.** Test behavior, not structure. Production code contains no test hooks.

## Database design

- **Tables defined once** in Drizzle (all 84 tables are typed; the raw-SQL
  JSON registry is gone). Queries use Drizzle's typed builder or
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
  The functions that remain, and why:
  - *Cross-workspace claims, folds and recovery* (`claim_due_*`, the schedule
    claim defer/fail/release, `fold_*`, `recover_due_*`): they pick work
    across every workspace with `FOR UPDATE SKIP LOCKED` before any one
    workspace is known.
  - *Run admission and capacity* (`reserve`/`arm`/`rebind`/`release` of active
    admissions, the eligibility and capacity checks, the workspace admission
    locks and counter triggers): the counters must change atomically with the
    rows they count, whichever writer touches them.
  - *Artifact capacity and references* (the capacity triggers,
    `lock_execution_artifact_references`): every writer that references or
    removes an artifact keeps the per-workspace byte count and the reference
    locks exact.
  - *Public webhook lookup and ingress limit*: the endpoint is resolved from
    its public key before its workspace is known, and the limit is an atomic
    counter.
  - *Guards over writers outside one code path*: the active-integration
    triggers (eight writers in five areas, racing workspace deletion), the
    session-revocation triggers (Better Auth writes users and sessions too),
    the invitation replacement-claim lineage walk (shared by retention and
    purge) and the inbox recipient check the row policies call.
  - *Row locks on rows the app may not update* (`lock_workflow_run_replay_*`):
    a `FOR SHARE` lock needs update rights the runtime role does not have.
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
