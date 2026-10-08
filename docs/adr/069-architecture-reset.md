# ADR 069: Architecture reset — rules in code, a thin database, one way per thing

- **Status:** accepted
- **Date:** 2026-10-08
- **Plan:** [architecture reset plan](../architecture-reset-plan.md)

## Context

Pertexo has not launched. Its foundation is sound: layered packages without
cycles, a pure engine, a simple node and integration shape, typed API contracts
and feature-organised API and web code. Around it, the project built production
machinery ahead of need:

- business rules inside PostgreSQL (312 functions, 269 with elevated rights,
  64 triggers) plus a second TypeScript copy of the engine's rules that
  re-checks every decision;
- six database logins, a raw-table registry and fingerprint-pinned functions;
- node release cohorts and epochs for mixed-version deploys, numbered formats
  for stored state, two-region object storage, an external audit ledger and
  legal hold;
- per-feature CI jobs and ~33k lines of custom tooling.

Every feature paid for all of it, and the first subworkflow implementation
(reverted in #163) showed the cost compounding.

Established workflow engines keep orchestration in application code and use
the database as the durable, transactional store (Temporal's history service,
Hatchet's engine service over PostgreSQL, n8n's `core` package over its `db`
package).

## Decision

1. **Rules live in TypeScript; the database stores.** PostgreSQL keeps tables,
   constraints, workspace isolation (row security), transactions and the few
   operations that must be atomic in SQL: queue claiming, capacity counters and
   the checkpoint version check. New SQL functions need a reason recorded in the
   PR.
2. **The engine's rules exist once,** in `workflow-engine`. Run actions move to a
   new `execution` package used by the API and the worker. Re-check copies are
   deleted.
3. **Tables are defined once** in Drizzle. Migrations are generated from the
   schema plus small hand-written SQL for policies, grants and remaining
   functions. Because nothing is launched, the migration history is squashed
   into one baseline and existing databases are recreated.
4. **Three database roles:** `owner` (migrations), `app` (API and worker, row
   security forced) and `maintenance` (cross-workspace jobs and operator
   commands).
5. **One version of everything until launch.** No release cohorts or epochs,
   no numbered stored formats, every node available. Versioning returns with
   the first real format change after launch.
6. **Removed until needed, behind existing seams:** two-region storage and
   restore-before-serve, the external control ledger, legal hold, database-stored
   feature switches. Operator commands become one `ops` CLI; retention runs in
   the worker.
7. **Code conventions:** each package has at most two entry points
   (`@pertexo/<name>` and `@pertexo/<name>/server`) enforced by lint; folders are
   grouped by sub-area and role with no long flat lists; file names never
   repeat their folder; input is validated once at the boundary; tests check
   behavior, not structure.
8. **Process:** ADRs only for hard-to-reverse decisions; the reset plan's
   tracker is the only progress log; every PR lists what moved where and what was
   removed, and why.

## Consequences

- The database package shrinks to schema, migrations, repositories, queries,
  transactions and isolation; behavior moves into code that is easier to read,
  test and change.
- Defense in depth against a compromised application server is lower: the app
  role can write tables directly within its workspace. Workspace isolation still
  holds in the database.
- Rolling deploys with mixed versions, two-region recovery and compliance-grade
  audit need explicit work when they are required.
- Structure-only tests are deleted; behavior tests remain the safety net.

## Supersedes

- ADR 010 (node and executor compatibility and retirement) — in full.
- ADR 027 (workspace lifecycle command dispatch) — in full.
- ADR 003 — the six runtime roles; workspace isolation stays.
- ADR 013 — the external control ledger and legal hold; retention and workspace
  deletion stay, in PostgreSQL.
- ADR 015 — the two-region recovery strategy; the SLO targets stay.
- ADR 029 — separate operator-command app; the operator boundary becomes the
  `ops` CLI with the `maintenance` role.
