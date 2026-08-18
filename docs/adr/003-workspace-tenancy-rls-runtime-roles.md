# ADR 003: Workspace tenancy, RLS, runtime roles, and Drizzle transaction context

- **Status:** accepted
- **Date:** 2026-08-18

## Context

The workspace is the tenant and authorization boundary for workflows,
connections, runs, artifacts, limits, and memberships. The backend has two
serving process roles: the API and the worker. Both use a PostgreSQL connection
pool, and both must be able to persist tenant-owned state without obtaining a
privileged connection. A repository predicate or an API authorization check is
not sufficient protection against a missed predicate, an accidentally reused
connection, or a future code path that bypasses a repository.

The authoritative backend plan therefore requires all tenant-owned rows to be
scoped by `workspace_id`, every tenant query to carry workspace scope,
PostgreSQL row-level security (RLS) with `FORCE ROW LEVEL SECURITY`, and
transaction-local context set with `SET LOCAL`/`set_config`. It also requires
schema ownership and serving access to be separated. Drizzle schema
definitions and reviewed SQL migrations are the source of truth; production
must not use schema push or synchronization.

This decision is needed before the first tenant repository so that repository
signatures, migrations, role grants, and the Phase 0B executable RLS proof all
share one failure model.

## Decision

### Workspace scope is explicit in the model and repository API

Every tenant-owned table has a non-null `workspace_id` column. The column is
present even when a row could be scoped indirectly through a workflow, run, or
another tenant-owned parent. Foreign keys, unique constraints, and indexes use
the workspace scope where it is part of the invariant.

Repositories require workspace scope in their method signatures. A globally
unique UUID does not make a tenant predicate optional. Domain and application
code passes an explicit, authenticated workspace context; it does not infer a
workspace from an arbitrary request body or from a process-global variable.

Global/platform tables that are intentionally not tenant-owned are documented
as such in their migration and do not receive a tenant policy by accident.
Creating a new tenant-owned table requires the same migration to add its RLS
configuration and policies.

### Runtime transactions establish a local workspace context

API and worker database work uses a transaction helper with this shape:

```ts
withWorkspaceTransaction(workspaceId, async (tx) => {
  // All tenant queries and writes use tx.
});
```

The helper validates a canonical workspace ID, begins the transaction, and
sets the context before any tenant statement. The SQL is equivalent to:

```sql
SELECT set_config('app.workspace_id', $1, true);
```

where the third argument makes the setting transaction-local. `SET LOCAL` may
be used by reviewed SQL helpers when parameter binding is handled safely. The
transaction-local setting is reset automatically on commit or rollback. The
helper returns only after the transaction has completed, and a pooled client
is never released while a session-level workspace setting remains active.

The transaction object, not the pool or process, carries the scope. Nested
operations use the same transaction (or savepoints) and cannot silently fall
back to an unscoped pool query. A runtime path that needs no workspace, such as
a health check, uses an explicitly separate non-tenant query and cannot call a
tenant repository. Cross-workspace maintenance is an explicit maintenance
operation with its own authorization and audit behavior; it is not implemented
by omitting the workspace argument from a serving repository.

Actor authorization happens before the transaction is opened. The API derives
the selected workspace from its immutable actor context and verifies
membership/capability. A worker validates the workspace on a job against the
referenced run before using the transaction helper. RLS is a database defense
in depth boundary, not a replacement for actor authorization: a serving
process must not accept an arbitrary client-provided workspace ID as proof of
access.

### Tenant tables use RLS and `FORCE ROW LEVEL SECURITY`

Each tenant table migration must:

1. declare `workspace_id NOT NULL`;
2. enable RLS;
3. force RLS, including for the table owner; and
4. add policies whose `USING` and `WITH CHECK` expressions compare the row's
   workspace to the transaction-local setting.

The policy expression uses the missing-setting-safe form of
`current_setting`, for example:

```sql
ALTER TABLE workflow_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_runs FORCE ROW LEVEL SECURITY;

CREATE POLICY workflow_runs_workspace_isolation
  ON workflow_runs
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);
```

When the setting is absent, `current_setting(..., true)` returns `NULL`; the
comparison is not true for any row. Reads therefore return no tenant rows, and
updates/deletes affect no tenant rows. Inserts and attempted moves to another
workspace fail the `WITH CHECK` policy (and `workspace_id` remains non-null).
Application code still rejects an absent scope early with a typed error so a
missing scope is visible in logs and tests rather than being mistaken for an
empty business result.

Policies are reviewed SQL, not an ORM convention. Drizzle definitions express
columns, keys, and indexes; migration SQL expresses RLS, policies, role grants,
and other PostgreSQL-specific protections. No serving code uses a privileged
connection to make a tenant repository work.

### Database roles are separated by authority

The database has distinct role classes:

- The **owner** role is a non-serving schema owner for tenant tables and
  policies. It is not used by API or worker connections.
- The **migration** role is used only by the controlled migration command. It
  has the DDL capability needed to apply reviewed migrations (or an explicit,
  audited membership to assume the owner role); it is not a serving role.
- The **maintenance** role is used only by explicitly authorized retention,
  repair, and operational jobs. Its grants are narrow and its operations are
  audited. It is not a substitute for the runtime roles or a connection handed
  to a request handler.
- Separate **API runtime** and **worker runtime** roles are used for serving
  connections. They receive only the table/schema privileges needed by their
  process role, do not own tenant tables, cannot assume owner/migration/
  maintenance roles, and do not have `BYPASSRLS`.

The exact role names and password/secret delivery are environment
configuration, but the ownership and role attributes are tested in PostgreSQL
migrations and integration fixtures. Runtime roles must not be granted
`CREATE` on the application schema or any indirect path to a role that owns
tables or bypasses RLS. Maintenance access that genuinely requires a
cross-workspace operation remains outside serving repositories and requires a
separate reviewed decision if it needs stronger database privileges.

### Drizzle is used behind the transaction boundary

The database package exposes the typed transaction/context helper and
repository adapters. Controllers, queue consumers, and workers do not issue
Drizzle queries directly. A repository query must use the transaction passed
by the application use case and include its explicit workspace scope; RLS
remains effective if a future query accidentally omits the predicate.

Migrations are generated or authored for the Drizzle schema, committed, and
reviewed as SQL. They are applied by the migration role. Runtime startup does
not mutate schema, and no code uses Drizzle `push`/synchronization in
production.

## Failure behavior and operational rules

- **No workspace context:** tenant reads see zero rows and tenant writes are
  rejected by RLS. The transaction helper should fail fast before issuing the
  query when its argument is missing or malformed.
- **Wrong workspace context:** a query cannot read, update, delete, or insert
  rows whose `workspace_id` differs from the active transaction context. A
  normal application response may map an invisible row to not-found to avoid
  disclosure; tests assert the database behavior directly.
- **Pool reuse:** context is set only with transaction-local semantics. A
  rollback, commit, or connection error clears it before the client is reused.
  Session-level `SET`, `set_config(..., false)`, and mutable process-global
  context are prohibited for serving tenant scope.
- **Database failure:** the transaction is treated as failed; callers do not
  continue with a queue payload or in-memory assumption of success. The
  PostgreSQL readiness check and normal retry behavior remain separate from
  authorization scope.
- **Migration drift:** a migration that creates a tenant table without
  `NOT NULL` workspace scope, forced RLS, policies, and runtime grants fails
  review and the Phase 0B gate. Serving processes must fail readiness on an
  incompatible schema rather than use a privileged fallback.

## Phase 0B proof obligations

The executable fixture uses real PostgreSQL, the real Drizzle pool, and the
API/worker runtime roles. It includes at least two workspaces and tenant rows
owned by each. Automated tests must prove:

- a scoped runtime transaction reads and writes only its workspace;
- cross-workspace reads are invisible and cross-workspace writes/inserts are
  rejected;
- absent context cannot read or write tenant rows;
- committing or rolling back a transaction leaves no workspace context on a
  subsequently checked-out pooled connection;
- concurrent transactions on the same pool cannot observe one another's
  context;
- runtime roles do not own protected tables, cannot bypass RLS, and cannot
  assume the owner/migration/maintenance roles; and
- the migration/readiness checks detect a missing policy, missing forced RLS,
  incompatible schema, or incompatible grants.

The fixture records its command, PostgreSQL version/configuration, migration
revision, test result, and measured pool behavior. The Phase 0B checkpoint is
not complete from a prose review alone; the measured result and any required
follow-up ADR update must be recorded in the implementation progress tracker.

### Phase 0B executable result

Phase 0B passed on 2026-08-18 against PostgreSQL 18.6 using the `postgres:18`
image, reviewed migration `0000_rls_probe.sql`, and distinct owner, migration,
maintenance, API runtime, and worker runtime roles. The executable fixture is
`app.rls_probe_records`; it contains a direct non-null UUID `workspace_id`, a
workspace index, forced RLS, a transaction-context policy, and restricted
runtime grants.

`pnpm test:integration` ran 31 PostgreSQL assertions in 424 ms. A pool limited
to one client retained no tenant value after either commit or rollback, and
two overlapping transactions on a shared two-client pool observed only their
own workspace. Both serving roles failed closed without context and could not
disable RLS, alter policies, truncate the table, or assume the owner,
migration, or maintenance roles. Readiness failure exercises covered a missing
policy, removed forced RLS, an incompatible migration head, and an incompatible
runtime grant.

An independent review identified and removed session-level empty-value cleanup
and hard-coded migration role names. The final helper only inspects for leaked
session context and destroys a contaminated client; role identifiers are
validated environment configuration rendered as quoted SQL identifiers. The
schema-compatibility check also verifies the workspace column type/nullability,
workspace indexing, policy expressions, grants, ownership, forced RLS, runtime
attributes, PostgreSQL major version, and migration head.

## Consequences

Positive consequences:

- A missed repository predicate cannot expose another workspace through a
  normal serving role.
- Transaction-local context is safe with connection pooling and makes scope
  lifetime explicit at the application boundary.
- Direct workspace columns make authorization, indexes, composite constraints,
  and operational queries inspectable without relying on deep joins.
- Separate roles reduce the blast radius of a serving credential and make
  ownership/bypass mistakes testable.
- PostgreSQL remains authoritative while Drizzle retains typed schema and query
  ergonomics.

Costs and obligations:

- Every tenant use case and repository signature carries workspace scope, and
  every transaction must use the helper correctly.
- RLS policies, grants, role attributes, and migration compatibility require
  integration tests against PostgreSQL; SQLite-only tests are insufficient.
- Maintenance and migration workflows need separate credentials, deployment
  paths, audit records, and readiness checks.
- Some cross-workspace operational queries require a dedicated maintenance
  path rather than reusing ordinary repositories.
- Connection-pool, transaction, and migration behavior must be documented for
  local development, CI, and production.

## Rejected alternatives

### Application predicates without RLS

Rejected. A single omitted `workspace_id` predicate, join, or future code path
would turn an application bug into a cross-tenant read or write. Application
authorization and explicit repository scope remain required, but PostgreSQL
RLS is the second boundary.

### Session-level workspace settings on pooled connections

Rejected. `SET` or `set_config(..., false)` can survive a request and leak one
tenant's context to the next checkout. Transaction-local context is the only
serving pattern approved here.

### Privileged runtime role or table-owner connections

Rejected. A role that owns tables or has `BYPASSRLS` defeats the protection
this ADR is intended to prove. Schema changes and exceptional maintenance are
separated from API and worker serving access.

### Database/schema per workspace

Rejected for V1. It would multiply migrations, connections, operational
discovery, and backup/retention work before the product's scale or isolation
requirements justify it. A later sharding or per-tenant database decision
requires a new ADR and migration strategy.

### ORM-only schema synchronization

Rejected. PostgreSQL policies, forced RLS, grants, role attributes, and
compatibility checks need reviewed, committed migrations. Production schema
push would make the durable boundary implicit and difficult to audit.

## Supersession criteria

Supersede or extend this ADR before implementation if PostgreSQL is replaced,
tenant data is sharded across databases, a per-workspace database/schema model
is introduced, serving credentials can be used by untrusted callers, or a new
trusted mechanism for binding actor scope to database scope is adopted. A
follow-up ADR is also required if maintenance operations need runtime
`BYPASSRLS`, if custom roles alter the authorization boundary, or if a process
role needs privileges beyond the API/worker separation established here.
