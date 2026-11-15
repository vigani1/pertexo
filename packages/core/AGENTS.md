# @pertexo/core

Follow the [root rules](../../AGENTS.md); this file only adds to them.

## Purpose and boundary

The application's flows: every product rule that needs the database, from
authoring and runs to identity, inbox and retention. Applications call it;
it calls `database` (`/schema`, `/primitives`, `/platform`), `secrets`,
`workflow-engine`, `workflow-model` and `policy` ([ADR 091](../../docs/adr/091-core-layer.md)).
Node only. It uses contract types but never their runtime schemas, never
reads the environment (applications pass typed config) and never writes
user-facing copy beyond the safe messages of its errors.

## Layout

- Entries: one per area, `@pertexo/core/<area>` (`src/<area>/index.ts`, which
  only re-exports), and `@pertexo/core/testing` (`src/testing.ts`) for flows
  that exist only for tests. There is no root and no `/server`.
- Eighteen areas: `artifacts`, `attempts`, `authoring`, `connections`,
  `data-tables`, `governance`, `identity`, `inbox`, `lifecycle`,
  `notifications`, `operator`, `outbox`, `previews`, `runs`, `shared`,
  `tenant-access`, `triggers`, `variables`.
- An area's root holds its entry, its facade (`<subject>.store.ts`), its
  error family (`<subject>.errors.ts`), its inputs and results
  (`<subject>.types.ts`), and the few files every sub-area shares. `variables`
  is the small model: its store (`workspace-variables.store.ts`), types and
  errors; its operations `replace.ts`, `scan-usage.ts` and `walk-usage.ts`;
  one decision (`replacement.ts`), one stored-value decoder
  (`stored-variable-set.ts`) and a repository per table.
- A sub-area is one flow or one stored subject (`attempts/leases/`,
  `inbox/mail/`, `identity/federation/sessions/`). It holds the same kinds of
  file: operations, the repositories they call, pure decisions, and its own
  `.errors.ts` or `.types.ts` when it has a family of its own.

## Where new code goes

- An operation: a verb-named file (`leases/claim.ts`, `settings/configure.ts`,
  `completion/apply-completion.ts`) that reads as the happy path and calls
  repositories for every query. A flow that is one statement may be just its
  repository, with no operation file around it (outbox's batch claim,
  `dispatcher/claim.repository.ts`). Several commands on one table share
  repositories by what they write, not one per command
  (`authoring/workflows/commands/new-workflow.repository.ts`,
  `draft-revisions.repository.ts`, `workflow-revisions.repository.ts`).
- The goal: a repository function returns a row, a boolean or `undefined`,
  and the operation decides and throws (`runs/run-access.repository.ts`
  beside `runs/access.ts`). Many repositories don't do this yet, most of them
  in `runs`, `authoring` and `triggers`, where they still make decisions and
  throw domain errors. Batch L4e moves those decisions into their operations;
  new code follows the goal.
- A query, lock or SQL fragment (`clock_timestamp()`, an increment, an
  interval): the `<subject>.repository.ts` beside the operation, or the
  flow's `.store.ts` when that file is its facade.
- A decision: a pure function in a concept file (`variables/replacement.ts`,
  `connections/health/rules.ts`), with no I/O. Retry, timing and health
  choices count: `triggers/coordination/release-timing.ts`,
  `triggers/schedules/retirement-plan.ts`.
- A SQL fragment several areas read stays in its owning area's repository;
  one that areas below the owner read too goes to `shared/`
  (`shared/run-retention.repository.ts` for run retention windows), and a
  statement two areas write the same way gets one function beside the lock
  it follows (`enterRunAdmissionProtocol` in
  `shared/workspace-fence.repository.ts`). A run admitted in a savepoint goes
  through `admitInSavepoint` (`triggers/admission-savepoint.repository.ts`).
- An error: the area's or sub-area's `.errors.ts`; the API maps it to a
  problem.
- A limit: a named constant at the top of the file that enforces it, named
  subject first, then `MAX`, then any unit (`PENDING_REVIEWS_MAX`,
  `RUN_EVENT_PAYLOAD_MAX_BYTES`); a list's page size is its `…_PAGE_LIMIT`
  (`shared/page-limits.ts`). Or it is the
  browser-safe owner's (`workflow-model`, `node-sdk`, `policy`) when the
  browser or another package shows it (`WORKFLOW_ORGANIZATION_LIMITS`,
  `WORKFLOW_INPUT_CASE_LIMITS`, `USAGE_TREND_PERIOD_DAYS`). A message reads
  the number from that owner, never writes it as a word. Two caps that must
  agree are one constant (the suite case cap is the per-workflow input-case
  cap). A duration in SQL is a count times a unit from
  `shared/sql-intervals.repository.ts` (`${DAYS}*${DAY_INTERVAL}`), never a
  literal `interval '30 days'` or `make_interval(…)`.

## Defaults and config

- No environment. Pools and timeouts arrive as `DatabaseConfig` and typed
  options from the applications.
- Limits: beside the code that enforces them, as above. Retention days:
  `DATA_RETENTION_DAYS` (`workflow-model`).

## Rules

- A flow a member starts opens its transaction through `withWorkspaceAccess`
  (`shared/workspace-access.ts`). It names its workspace status list once
  there, checks authority inside the transaction and uses the role it gets.
- Keep each flow's lock order. The shared order is workspace first, then
  users in a fixed order, then memberships, then the feature's own rows
  ([ADR 054](../../docs/adr/054-durable-workspace-inbox.md)); retention takes
  its advisory lock before the workspace row ([ADR 013](../../docs/adr/013-retention-workspace-deletion-legal-hold.md)).
  A query moved into a repository stays on the same client, in the same
  order, inside the same transaction.
- Queries live only in `.repository.ts` and `.store.ts` files
  (`validate-core-queries.mjs`), in every area. A `.store.ts` is a flow's
  facade: it exports a `create…` factory, and an area entry, a testing entry
  or another store imports that factory as a value; the check refuses any
  other.
- The database's time is read once, by `readDatabaseClock`
  (`shared/database-clock.repository.ts`), after a flow's lock waits; a flow
  that writes the reading back into a timestamp column takes
  `readDatabaseClockText`, which keeps its microseconds.
- An area imports the files another area's `index.ts` names directly, never
  through that `index.ts` (ADR 091).
- Areas depend one way. From the bottom: `shared`; `governance` and `outbox`;
  `variables` and `connections`; `notifications`; `artifacts`; `attempts`;
  `data-tables`; `runs`; `triggers`; `authoring`; `inbox`, `previews`; then
  `lifecycle` and `operator` on top. `identity` and `tenant-access`, the one
  kept pair, sit above `outbox` and below `authoring` and `lifecycle`. When a lower area needs a higher one's fact, the
  writer moves down to the producer (the run transition writes the inbox's
  intake), or the shared piece moves to `shared/` (`run-events.repository.ts`,
  `execution-source.repository.ts`). `validate-core-area-cycles.mjs` refuses
  a new runtime cycle; type-only imports follow the same order.
- A sealed application secret is checked with `applicationSealedSecretSchema`
  from `secrets`, never a local copy.

## Exceptions

- Flows nobody acts in stay off `withWorkspaceAccess` and open a tenant
  scope themselves: workers and scanners (`withTenantScopedClient`),
  connection use and token refresh (`connections/transaction.ts`), and the
  operator (`operator/run-command.ts`).
- Generic throws that stay are storage integrity assertions: a write that
  returned no row, a locked row that disappeared, a stored pointer or receipt
  that is corrupt.
- `connections/testing.ts`, `lifecycle/testing.ts` and
  `tenant-access/testing.ts` collect an area's test flows for `src/testing.ts`.
- `shared/stored-execution.ts` writes JSON text lengths, listed as not limits.

## What guards it

- `pnpm --filter @pertexo/core test`: decisions, parsers and stores against
  mocked clients.
- `pnpm --filter @pertexo/core test:integration` needs PostgreSQL and Redis
  from a test stack (`DATABASE_*_URL`, `REDIS_URL`): every flow against real
  row security, locks and receipts.
- `pnpm check`: the query, backend-limits, workspace-status-list, module
  import, package structure and naming checks.
