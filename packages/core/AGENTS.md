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
  is the small model: a store, its types and errors, one operation
  (`replace.ts`), one decision (`replacement.ts`) and a repository per table.
- A sub-area is one flow or one stored subject (`attempts/leases/`,
  `inbox/mail/`, `identity/federation/sessions/`). It holds the same kinds of
  file: operations, the repositories they call, pure decisions, and its own
  `.errors.ts` or `.types.ts` when it has a family of its own.

## Where new code goes

- An operation: a verb-named file (`leases/claim.ts`, `settings/configure.ts`)
  that reads as the happy path and calls repositories for every query.
- A query, lock or SQL fragment (`clock_timestamp()`, an increment, an
  interval): the `<subject>.repository.ts` beside the operation, or the
  flow's `.store.ts` when that file is its facade.
- A decision: a pure function in a concept file (`variables/replacement.ts`,
  `connections/health/rules.ts`), with no I/O.
- An error: the area's or sub-area's `.errors.ts`; the API maps it to a
  problem.
- A limit: a named constant at the top of the file that enforces it, or the
  browser-safe owner's (`workflow-model`, `node-sdk`, `policy`) when the
  browser or another package shows it. A duration in SQL is a count times a
  unit from `shared/sql-intervals.repository.ts` (`${DAYS}*${DAY_INTERVAL}`),
  never a literal `interval '30 days'`.

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
  (`validate-core-queries.mjs`).
- An area imports the files another area's `index.ts` names directly, never
  through that `index.ts` (ADR 091).
- A sealed application secret is checked with `applicationSealedSecretSchema`
  from `secrets`, never a local copy.

## Exceptions

- Flows nobody acts in stay off `withWorkspaceAccess` and open a tenant
  scope themselves: workers and scanners (`withTenantScopedClient`),
  connection use and token refresh (`connections/transaction.ts`), and the
  operator (`operator/run-command.ts`).
- `authoring` and `runs` still run queries outside
  repositories and aren't in the backend-limits check yet; they are listed in
  `PENDING_AREAS` (`validate-core-queries.mjs`) until their pass.
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
