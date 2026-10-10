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
        through 0137, roles templated) initially replaces 135 migrations;
        step 9 replaces that dump and subsequent reset migrations with the
        final Drizzle-generated baseline. The runner
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
        `workflow-engine/test/checkpoint/capacity.test.ts`; recorded in the
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
        ownership, identity. Retention and purge now share a typed replacement-claim
        lineage check in TypeScript, with sorted advisory locks per binding,
        a re-read after locking, and the same cycle/depth and live-intent rules.
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
- [x] **8. Package-by-package pass** — read every file of every package and app,
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
          declare five `DEFERRABLE` foreign keys or two covering indexes
          with `INCLUDE`; the baseline finishes those declarations. Column
          collations use the raw SQL `textC` type. The registry is deleted;
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
          design*. The manual-start writer fence (an authority check the API
          already makes), the preview artifact retention trigger and the
          lifecycle time trigger are removed by migration 0025 before the
          final re-squash. Their commands own key serialization, expiry checks
          and canonical receipt time.
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
  - [x] execution
    - [x] Attempt inputs are projected, not re-verified: loading an
          attempt's inputs no longer re-checks the upstream scope the worker
          just derived, or the loop item's size, ordinal and checksum, which
          the engine verifies when it runs the attempt. Run start
          (`initialCheckpointFactory`) and `advanceRun` were already the one
          place for their rules.
  - [x] worker
    - [x] Files grouped by the feature they serve: `runs/`, `attempts/`
          (with `artifacts/`), `previews/`, `providers/`, `notifications/`,
          `connections/`, `identity/`, `workflows/` and `operator/`;
          runtime, config, transport and trigger files drop the prefix
          their folder names.
    - [x] One database readiness check: `checkCompatibility` goes from the
          workspace database, the artifact upload store and both Nest
          database modules; the API and worker check readiness at startup.
    - [x] Every feature switch is on, as step 3 intended. The worker
          consumes every job kind: failure notifications once connection
          encryption is configured, invitations once invitation email is,
          authentication mail once its credentials are (deployed workers
          require them). `OUTBOX_DISPATCH_JOB_NAMES`,
          `AUTH_MAIL_DELIVERY_ENABLED`, the dispatch consumer registry and
          the per-handler maintenance switches go. The inbox producer,
          run-timeout notification context, trigger outcomes, auto-pause and
          connection run health always run; their env switches go, and
          migration 0021 drops the stored health mode. Artifact storage and
          retention are required.
    - [x] Tests mirror the source areas (`runs/`, `attempts/`, `previews/`,
          `transport/`, `triggers/`, …) instead of 100 flat files, and test
          support is grouped by what it supports. `transport/` splits into
          `outbox/` and `providers/`, `runtime/` into `health/` and
          `shutdown/`.
    - [x] Validated once: attempt preparation trusts the lease the engine
          admitted (no recomputed branch ancestry, iteration scope,
          invocation key or side-effect pin, and no re-check that the version
          read by workspace and id has that workspace and id). Runtimes,
          handlers and the outbox dispatcher trust the parsed config instead
          of re-checking its bounds; failure-notification delivery limits
          are constants. Values from the worker's own modules are trusted:
          errors are checked with plain `instanceof` (no guards against
          trap-throwing proxies), a resolved connection is not re-matched to
          the workspace and id it was resolved by, failure-notification
          delivery does not re-check the intent's side-effect class, and the
          artifact store's verified upload is not compared with the request
          again.
    - [x] One provider telemetry: HTTP, Slack and email calls share one
          OpenTelemetry measurement, classified by `NodeExecutorFailure`
          (HTTP adds its response storage). The separate HTTP
          implementation, the per-provider classifiers and the guards around
          OpenTelemetry calls, which never throw, go.
    - [x] Two loop shapes: the trigger, coordinator and maintenance runtimes
          share one scanner runtime (a queue consumer plus a polled scan)
          instead of three copied lifecycles, and authentication mail
          delivery uses the polling runtime the inbox, auto-pause and
          retention loops use. The maintenance runtime closes the delivery
          resources it is given, so the owner wrapper and `whenIdle` go.
    - [x] What acceptance settled is trusted: trigger reconciliation no
          longer reads the publication it only re-checked, the preview
          invoker no longer re-checks the node, definition and executor
          acceptance pinned, failure-notification handling no longer
          re-parses its own delivery result, and invitation delivery leaves
          the origin check to config. The outbox deadline reuses the shared
          deadline helper, and process shutdown closes once without guarding
          against its own calls throwing. Guards that stay are deliberate:
          values from node executors (a plugin boundary) and diagnostics
          that must never change durable outcomes.
  - [x] api
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
    - [x] Validated once: authorization trusts the actor built from the
          verified session, the parsed route and the request-id and
          traceparent parsers, and keeps only its rules (actor, matching
          workspace, active membership, allowed lifecycle, capability);
          run start and replay trust the contract's deadline.
    - [x] One way per thing: every list cursor goes through one opaque
          cursor helper (canonical base64url, bounded length) and one header
          reader. Authentication mail is `local` or `durable`; the refusing
          `disabled` mode goes.
    - [x] One Idempotency-Key parser: every command reads the key through
          `requestIdempotencyKey`, and a missing, repeated or malformed key
          answers `400 request.invalid` everywhere, as the IETF
          Idempotency-Key draft specifies. Run start, replay, schedule
          commands and node tests answered `428` for a missing key, and the
          parser had two copies and five ad-hoc variants. `428` stays for a
          missing `If-Match` (ADR 011).
  - [x] web
    - [x] Every web feature is on, as step 3 intended: workflow
          organization (folders, tags, favorites), the curated template
          chooser and template origin no longer sit behind build-time gates
          that only a "qualification" build replaced. The list has one path,
          the organized list, which keeps the first-workflow onboarding for an
          empty, unfiltered workspace and is prefetched by its route so an
          ended session still returns to sign-in. The legacy list, its
          toolbar, client-side filter and no-match state, both qualification
          builds and their gate stand-ins, and the organization browser
          test's default-off role go. A workflow's template origin shows in
          its header only when one is recorded, as one short line.
    - [x] Feature folders by role: only public entry files stay at a
          feature's root; screens go to `pages/`, hooks to `hooks/`, server
          access to `data/` (`*.api.ts`, `*.queries.ts`, `*.mutations.ts`,
          `mutations/`), other logic to `model/` or `components/`. Routes are
          grouped into `root/`, `auth/`, `workspace/` and `workflow/`; shared
          hooks and formatters in `lib/hooks/` and `lib/format/`.
    - [x] Folders over about ten files are grouped: `components/patterns`
          (`states/`, `guidance/`, `core/`), the workflows model
          (`duplicate/`, `organization/`, `templates/`), the editor inspector
          (`tabs/`, `fields/`), the workspace shell routes (`shell/`) and run
          detail (`timeline/`). Tests move into their feature folders,
          mirroring the source, with shared fixtures in `support/fixtures/`.
          `components/ui` stays flat: it holds the shadcn primitives.
    - [x] `ARCHITECTURE.md` is a guide (4,864 lines to 1,468): the
          delivery stages and their evidence, the roadmap and delivery plans,
          the finished structure plan and the legacy-design inventory go (git
          keeps them). Sign-in is described as Better Auth, the custom
          module-cycle, complexity and duplication gates removed in step 2
          are no longer claimed, and the grouping rules join section 2. The
          README and AGENTS lose their OIDC references.
    - [x] Read access ends one way: five features' query-cache watchers
          share `watchWorkspaceReadDenial`. The command hooks were read for
          a shared primitive and keep their own state: each holds a
          different recovery rule (draft ETag reconciliation, member
          revisions and targets, run intents), so a shared hook would only
          hold a ref. The alias `isUncertainCommandError` goes.
  - [x] ops — one operator command runner for one-off tasks: it reads the
        command from the environment, checks database readiness, runs it
        under the maintenance role with a timeout and bounded cleanup, and
        prints the result. Read in full; nothing to cut.
  - [x] Test layout — database, API, workflow-engine and integrations tests
        and the web's browser specs are grouped by the area they test,
        mirroring `src`, instead of flat folders (the database had 143 test
        files in one folder, the API's test support 54). Helpers used by one
        area sit beside its tests; shared ones stay in `test/support`. Names
        no longer repeat their folder, and the database schema, run advance
        and attempt folders split the same way. CI selects the owned-fixture
        and browser suites by folder.
  - [x] Naming and layout follow-up — redundant folder prefixes go, crowded
        areas split by responsibility, and source/test paths mirror each other.
        Artifact storage groups S3 and configuration; observability groups
        telemetry. Stream verification and folder/tag controls have their own
        modules. The HTTP transport and queue consumer keep their cohesive
        cancellation, retry and shutdown lifecycles.
    - [x] Small database doors fold into neighbors: identity into tenant-access,
          inbox into notifications, artifacts and operator into runs. The twelve
          remaining doors are attempts, authoring, connections, lifecycle,
          notifications, outbox, platform, previews, runs, tenant-access,
          triggers and testing. Runtime areas have substantial implementations;
          outbox owns leased dispatch and lifecycle owns retention and purge.
          Testing remains the fixture boundary. Pool telemetry keeps its actual
          measurements and lifecycle, without guards around owned instruments.
    - [x] Authentication persistence is typed database commands, preserving user
          locks and Better Auth behavior. Better Auth retains its pool wiring.
          Read-only admission and invitation checks follow the SQL decisions
          below. The mail test hook goes; tests observe the local sink.
    - [x] Equivalent record, ordinal, UUID and database serializer helpers are
          shared. Distinct digest, stored-value and PostgreSQL payload encodings
          stay distinct. Owned config guards, obsolete catalog names and manual
          promise rejection settlements go; unknown boundary validation stays.
    - [x] Owner post-plan follow-up: database receipts and trigger fingerprints
          import workflow-model's canonical JSON; both duplicate serializers
          go. The live organization test waits for the final authority check,
          with a controlled delay reproducing the old failure and passing after
          the repair. Forty-two remaining redundant filenames go in separate
          move commits, preserving public/module/repository names. Package
          gates and three live role cases pass. The full reset gate is green:
          677 database, 46 database-owned, 47 worker, 117 API, 13 API-owned
          and 90 browser tests; all unit suites pass. Remaining descriptor and
          reflection sites serve unknown JSON/graph/schema boundaries or
          dynamic-key reads; boundary validation remains.
- [x] **9. Finish** — final re-squash of migrations, `docs/architecture.md`
      map completed, root scripts and README final.
  - [x] Current architecture map, root/web setup and ownership docs, script
        references and feature-plan anchors updated. Superseded ADR status lines
        remain historical; ADR 020 clarifies the single checkpoint/catalog.
        Obsolete auth/inbox implementation logs and connection/concurrency
        rollout runbooks are deleted. Applicable operations runbooks remain.
        Final cleanup removed 19 completed reset worktrees, 23 remote heads
        matched exactly to merged PRs, and the three reset scratch databases.
        The final plan-verification scratch database is also removed.
        Local source branches, unrelated/protected worktrees and all 758
        excluded handoff files are preserved in the final review worktree.
        Main and both protected checkouts match their pre-cleanup fingerprints.
  - [x] Final baseline generated from Drizzle: all 80 tables, 800 columns,
        330 checks, 122 foreign keys, 51 unique constraints, 80 primary keys,
        261 indexes and two sequences. `pnpm db:generate` produces no drift.
        Drizzle's legacy config loader is scoped to patched esbuild 0.25.12;
        Better Auth's optional peer otherwise pulls 0.18.20 into the production
        audit. The audit gate remains unchanged.
        The live pre-squash catalog was compared with a fresh baseline for
        columns, indexes, policies, functions, triggers, sequences and grants.
        Five deferred foreign keys and two covering indexes are completed in
        SQL; grants, forced row security and retained functions/triggers stay.
        Six old `NOT VALID` constraints are validated on the empty baseline.
        The artifact workspace identity becomes a unique constraint so its
        foreign-key targets exist before generated indexes. An equivalent
        `chr(59)` regex avoids drizzle-kit's semicolon check serialization bug;
        two array-cast expressions are deparsed equivalently by PostgreSQL.
        The required outbox dispatch cursor seed stays. All 26 reset migration
        files become `0000_baseline.sql`, with tracked generation metadata;
        the runner refuses old history and requires database recreation.
  - [x] SQL fences and leftovers removed before the re-squash (migration
        0025): the manual-start authority function and writer trigger, preview
        artifact retention trigger, lifecycle receipt-time trigger and unused
        checkpoint transition fingerprint. The input-case fences already went
        in 0009. Manual commands and fixtures share one transaction advisory
        key lock; HTTP checks current authority before acceptance or recovery.
        Preview expiry is checked before metadata is inserted, and receipt
        dates are written with millisecond precision in TypeScript. Outbox
        payload checksums stay for integrity, reused delivery identities and
        recovery after an unknown commit.
  - [x] Numbered stored formats removed before the re-squash: digest
        prefixes, hash domains, idempotency namespaces and sealing contexts
        are unversioned. The graph/catalog/executable/checkpoint, expression,
        run-event/queue/outbox, portable and notification shapes no longer
        contain single-format markers. The checkpoint development engine label
        and redundant stored-value version names are gone. The trigger outcome
        fold has one enforcing path.
    - [x] Versioned names go (migration 0022): digests are
          `<kind>:sha256:<hex>` (`wf:`, `wf-compat:`, `trigger:`, `email:`
          and provider dispatch bindings), the draft ETag is
          `"draft.<hash>"`, and hash domains, sealing contexts, provider
          idempotency keys, pub/sub channels, the trigger reconciliation
          consumer and browser storage keys drop their `v1`/`v2`. Key
          versions stay: they name rotated keys, not formats. Rows written
          before this cannot be verified or decrypted, so local databases
          are recreated.


    - [x] Format fields go (migration 0024): graph, catalog, executable,
          checkpoint, expression, queue, event, secret, notification and
          portable shapes have no redundant format marker. Eight columns are
          removed; failure-intent uniqueness and run-pin references retain the
          destination, config, side-effect and secret identities. The trigger
          fold always enforces its outcome. Function grants and row locks stay.
          Checksums and template digests are recomputed from the new shapes.
          Node/config and key versions stay, as do the SDK's genuinely distinct
          executor ABI versions 1 and 2 and third-party format numbers. User
          JSON may still use format-like property names. Migration 0023 was
          already used by the naming follow-up, so this slice is 0024.

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

- [x] **10. Re-plan F08** on the completed reset structure: the
      [proposal](feature-plans/08-subworkflows.md) and
      [accepted ADR 070](adr/070-workflow-call-boundaries.md) record the completed plan and owner
      decisions. Implementation proceeds through the feature plan's slices.
  - [x] Current/reverted sources and Temporal, Hatchet and n8n prior art reviewed;
        ownership, recommended decisions, tested delivery slices and size
        comparison recorded.
  - [x] Finished-loop checkpoint pruning is planned before any measured limit
        increase. The current 200-invocation and checkpoint byte limits stay.
  - [x] Owner accepted the plan/ADR: workspace slot handoff, archive warning
        listing pinned published parents, and all other recommendations.
        Runtime, integrated recovery/history and retention evidence remain open
        in the feature plan; reset follow-up precedes slice 1 pruning.
  - [x] Plan-PR CI repair: sign-in return-path tests await router settlement
        before unmount/fixture teardown, preventing a pending UI timer from
        updating React after JSDOM is disposed. Product behavior is unchanged.

## Target structure: where everything lives

```
apps/
  api/        HTTP only: routes, auth/session, request parsing, calls execution
              for actions and database for reads
  worker/     job loop: runs node attempts, advances runs, triggers, maintenance
              (retention purge, schedule scans)
  web/        React app, grouped by feature and role
  ops/        one operator CLI with subcommands (replaces lifecycle-command,
              operator-command, recovery, retention)
packages/
  workflow-model/   graph, expressions, validation, JSON helpers — browser-safe
  workflow-engine/  pure "what happens next" rules — the only copy
  execution/        run advancement, initial checkpoints, projection verification
                    and attempt input projection
  database/         tables (defined once), migrations, repositories, queries,
                    transactions, workspace isolation, queue claiming, outbox
  contracts/        API request/response shapes (browser-safe) + OpenAPI (server)
  node-sdk/         how a node is written: manifest, schemas, executor contract
  nodes-core/       built-in nodes
  integrations/     provider nodes (HTTP, email, Slack) + safe outbound HTTP
  node-catalog/     the registry that combines built-in and provider nodes
  templates/        curated template content (out of model and catalog)
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

`database` retains `nodes-core` only for the built-in schedule config schema
in recurrence and reconciliation; executor implementation stays outside it.
The implemented run seam is `execution.advanceRun` with a transactional database
store. Start/cancel/replay persistence remains in `database/runs/commands`.

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

- **Tables defined once** in Drizzle (all 80 tables are typed; the raw-SQL
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
    rows they count, whichever writer touches them. Specifically,
    `workflow_run_active_admission_eligible` is used by the reservation/claim
    path, `workflow_run_active_capacity_available` locks the counter and checks
    capacity under that lock, and `workflow_concurrency_admissible` orders the
    same claims. These checks remain in the atomic SQL path. Blocker explanations
    and reserved-slot counts are typed workspace reads; blocker reasons are
    computed in TypeScript from one statement's run, count and ordering facts.
  - *Artifact capacity and references* (the capacity triggers,
    `lock_execution_artifact_references`): every writer that references or
    removes an artifact keeps the per-workspace byte count and the reference
    locks exact.
  - *Delivery integrity*: the outbox payload checksum binds each persisted
    delivery identity to its exact payload. Consumers compare it before
    effects or receipt recovery, including a retry after an unknown commit;
    this is an integrity check, not a stored-format version.
  - *Public webhook lookup and ingress limit*: the endpoint is resolved from
    its public key before its workspace is known, and the limit is an atomic
    counter.
  - *Guards over writers outside one code path*: the active-integration
    triggers (eight writers in five areas, racing workspace deletion), the
    session-revocation triggers (Better Auth writes users and sessions too)
    and the inbox recipient check the row policies call. Invitation replacement
    claims are maintained by TypeScript: retention and purge share the bounded
    lineage read, sorted binding locks, post-lock re-read and live-successor
    check. Frontiers are read for the page together, and unsafe candidates are
    skipped before filling the deletion page.
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
- Root scripts expose the common development commands (`dev`, `build`, `check`,
  `test`, `test:integration`, `test:e2e`, `db:migrate`, `db:generate`). Keep the
  named checks and fixture/ops/observability commands used by hooks, CI and
  applicable runbooks; deleting those would hide required verification.
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
