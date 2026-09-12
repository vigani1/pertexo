# Database startup/readiness contract review

Date: 2026-09-12. Primary reviewer fully read all 13 files below. Both selected
unit test files passed (7 tests, 216 ms). SQL and integration fixtures were read;
no schema drift was applied and no database/integration command ran.

## Individual file judgments

| File | Disposition | Specific judgment |
| --- | --- | --- |
| `packages/database/src/platform/readiness.ts` | KEEP; TEST/REFACTOR WQ-132/WQ-134 | Full startup, bounded serving and preactivation are correctly separate. Exact migration head and release set checks are intentional. Compatibility authority SQL remains substantial inline knowledge; align its trigger/function checks and document scope. |
| `packages/database/src/platform/readiness-probe.ts` | KEEP; TEST WQ-134 | Named capability failure table and one ordered row assertion clarify a formerly long condition chain. Do not hide role/grant precedence in a generic schema validator. Test every failure field and complete/partial/no CRUD combinations. |
| `packages/database/src/platform/readiness-probe-sql.ts` | KEEP | One composition point preserves one main catalog statement and diagnostic capability columns. Tiny glue is justified; no extra wrapper needed. |
| `packages/database/src/platform/readiness-probe-1.sql.ts` | KEEP; FIX/TEST WQ-132; REFACTOR WQ-134 | Explicit identity/authoring columns, exact authoring policies, grants and immutability contracts. Baseline probe uses substring policy matching and membership checks are weaker; repeated authoring predicates obscure which checks are authoritative. |
| `packages/database/src/platform/readiness-probe-2.sql.ts` | KEEP; TEST WQ-132; REFACTOR WQ-134 | Detailed executable constraints, persisted value limits, role grants and node/run authority distinctions are real contracts. Some constraints are name-only; direct information-schema grantee scans need effective-grant mutation tests. |
| `packages/database/src/platform/readiness-probe-3.sql.ts` | KEEP; FIX/TEST WQ-132; REFACTOR WQ-134 | Connections/preview/usage checks retain tenant and secret-access distinctions. Several immutable/retention triggers are checked only by name, connection policy expressions aren't verified, while preview pin trigger/body check is much stronger. |
| `packages/database/src/platform/readiness-probe-4.sql.ts` | KEEP; FIX/TEST WQ-132; REFACTOR WQ-134 | Trigger, deadline, notification, admission and regional authority checks matter. Name-only trigger checks, broad search-path prefix checks and policy-name-only conditions should have explicit drift tests. Keep tail FROM/head composition visible. |
| `packages/database/src/platform/readiness-artifact-capacity.sql.ts` | KEEP; TEST WQ-132/WQ-134 | Deep capacity contract checks exact columns/defaults, constraints, roles, table/column privileges, functions and trigger shape. This verbosity expresses security policy, not gratuitous conditions. Add policy mode/extra policy/index-state tests where applicable; don't inline it back into numbered SQL. |
| `packages/database/test/readiness-probe.test.ts` | KEEP; TEST WQ-134 | Useful composition uniqueness and named capability failure tests, but only a subset of flags exercised. Local 0081 expected-row fixture is deliberately passed to a parameterized validator, not a stale production-head bug. |
| `packages/database/test/serving-readiness.test.ts` | KEEP; TEST WQ-134 | Explicitly prohibits expensive catalog checks on the recurring path; keep this performance contract. Add metadata failures and exact/set compatibility behavior without changing serving into startup audit. |
| `packages/database/test/artifact-capacity-readiness.integration.test.ts` | KEEP; FIX fixture WQ-133; TEST WQ-132 | Real drift/restore tests cover meaningful RLS, columns, defaults, grants and trigger status. Uses configured shared database and commits each destructive drift; cleanup serialization and disposable ownership are insufficient. |
| `packages/database/test/rls.integration.test.ts` | KEEP; FIX fixture WQ-133; TEST WQ-132/WQ-134 | Strong unfiltered/cross-tenant CRUD, same-client GUC, role-denial and held concurrent workspace proofs. Suite/drift locks are real but other suites don't all participate; barrier failure can block close; seeded rows persist. |
| `docs/operations/database-function-readiness.md` | KEEP; documentation WQ-134 | Correctly treats body hashes as startup compatibility and requires forward-only coordinated rollout/repair. Source inventory link is incomplete after SQL split; explain stored source text rather than PostgreSQL normalization of body formatting. |

## WQ-132 — make startup drift checks match the claimed invariant

P2 FIX/TEST, security/operability defense in depth. Static source evidence, not
an observed production escape or a claimed live mutation reproduction. Runtime
roles cannot ordinarily alter these schema objects; the issue is startup
accepting accidentally weakened migration/admin state. Do not rewrite published
migrations, automatically repair schema on startup or hash every SQL function.

1. **Existing-but-disabled triggers.** `readiness-probe-3.sql.ts:23–35,171–177`
   accepts connection_secret_versions_immutable, connection_events_immutable and
   artifact_link_preview_retention by name/not-internal alone.
   `readiness-probe-4.sql.ts:143–146,173–176,293–296,339–341` does likewise for
   notification run pins, immutable destination versions, webhook secret
   versions and schedule configuration. Disabling such a trigger changes none
   of those predicates. Verify the intended enabled mode, function OID, timing/
   event mask, and any WHEN/column filter that affects enforcement. Follow the
   already-strong preview pin/capacity trigger patterns. PostgreSQL documents
   enabled mode, function and event mask as separate catalog fields.
   [PostgreSQL trigger catalog](https://www.postgresql.org/docs/18/catalog-pg-trigger.html).
2. **Policies must enforce tenant scope, not merely exist.** Baseline
   `readiness-probe-1.sql.ts:17–37` requires only workspace_id/current_setting
   substrings. An expression that retains those strings plus a permissive
   disjunct is not proven equivalent. Identity membership SELECT/ALL policy at
   `:76–87` only needs non-null expressions. Connections `-3.sql.ts:54–99` uses
   workspace policy membership to select the grant profile but doesn't validate
   its predicate; forced RLS alone doesn't validate the predicate either.
   Compare the reviewed expression/command/roles/mode and the full allowed
   applicable policy set, preserving intentional owner/global policies. Reject
   unauthorized additional permissive policies rather than just counting one
   expected name. Policy mode and roles are independent of expression text.
   [PostgreSQL policy catalog](https://www.postgresql.org/docs/18/catalog-pg-policy.html).
3. **Name-only constraints and function attributes.** In `-2.sql.ts` executor
   failure/provider-binding constraints and `-4.sql.ts` wait/failure notification
   constraints often check name alone. Catalog-shape tests should weaken one
   expression under the same name and prove startup rejection before deciding
   how much exact definition pinning is required. Functions checked with
   search_path LIKE 'search_path=pg_catalog%' do not enforce an exact safe list.
   Where the contract is fixed, compare the approved settings rather than a
   textual prefix. Keep intentionally NOT VALID historical constraints such as
   preview UUID-v7 and run-pin FK states; blanket convalidated=true is wrong.
4. **Effective privilege checks.** `-2.sql.ts:261–306` scans
   information_schema.column_privileges for direct grantee=$2. Add a disposable
   mutation case with an inherited unexpected column privilege and compare the
   actual has_column_privilege result. If startup misses it, use effective
   per-column denial checks and role authority validation, following the
   capacity probe. Do not call this a reproduced privilege escalation; accepting
   a normal unprivileged database remains separate from detecting later grant
   drift. Check exact return-column types for PostgreSQL nullable catalog facts.

Plan/acceptance: add targeted mutation tests first against a dedicated migrated
database. For each target, baseline passes; disabled/wrong trigger, weakened or
extra policy, altered constraint or forbidden effective grant fails with the
correct capability message; restore returns to pass. Prove actual runtime
cross-tenant read/write remains denied under supported schema. Expand only the
missing checks demonstrated by those cases. Keep complete SQL statement
assembly, role parameters and immutable expected catalogs; no broad general
schema-diff engine. Coordinate any intentional schema change with migration
head/readiness rollout and existing PF-04 forward migration sequence.

## WQ-133 — isolate destructive readiness fixtures and unblock teardown

P2 FIX/TEST. This is fixture safety, not authorization to run these suites on a
user database.

- `artifact-capacity-readiness.integration.test.ts:beforeAll` migrates configured
  DATABASE_MIGRATION_URL, then each case commits trigger disablement, policy
  weakening, grant changes, column rename or constraint drop. A finally restores
  expected defaults rather than the observed original state, and abrupt process
  termination can't execute finally. Use a generated disposable database for
  each drift suite, with validated owner/role identifiers. All serving pools and
  readiness options must use the same configured owner/API/worker roles; current
  checks use default readiness options despite reading custom role environment
  variables. Never broaden production privileges to satisfy a fixture.
- `rls.integration.test.ts:26–35,85–122` does acquire both suite and drift
  advisory locks, so do not claim no serialization. They protect only cooperating
  callers; artifact capacity drift uses neither. Prefer private databases for
  global schema mutation, sharing expensive migration fixtures only with proven
  isolation. Serial test-file configuration doesn't isolate another invocation.
- RLS seeded probe rows recordA/recordB are never removed. Delete exact fixture
  rows or drop the owned database. Owner helper/client acquisition precedes try;
  protect pool cleanup when checkout fails, ensure one cleanup error can't skip
  remaining pools or advisory-lock release, and retain original scenario error.
- Concurrent workspace test (`rls.integration.test.ts:263–305`) releases the
  barrier only after two arrivals. If one transaction fails before callback,
  Promise.all rejects while the other callback holds its client awaiting the
  barrier; finally waits on pool.close, which waits on that client. Release the
  owned barrier in finally before close, abort/drain both transactions and await
  their observed results. A test timeout alone is not cancellation. Similar
  queryStarted waits need bounded failure-aware ownership.
- capture SQLSTATE through a bounded/cycle-aware cause traversal, not an
  unbounded `while (current instanceof Error)` when adapters can wrap causes.
  This is a test assertion helper improvement, not an alleged hostile SQL input
  vulnerability. Keep explicit SQLSTATE expectations and real role-denied tests.

Acceptance: fail before checkout, before second barrier arrival, during mutation,
during assertion and during restore; all pending work settles and every owner
gets a cleanup attempt. Two drift suites can run independently without modifying
each other's schema. Disabled/non-integration collection starts no service work.
Use test-owned database identity validation before any destructive statements.

## WQ-134 — make readiness code and evidence navigable without weakening it

P2 TEST/REFACTOR; P3 documentation/local formatting.

1. Rename numbered SQL modules to their capability ownership names, or at least
   document the mapping at composition: identity/authoring, execution,
   connections/preview, triggers/admission. `-4` has become several capabilities;
   split only if a change can stay within one named concept. Keep one exported
   main SQL string and its exact output aliases. No file-size quota.
2. `-1.sql.ts` repeats workflow_drafts_workflow_workspace_fk existence checks,
   detailed expected columns followed by individual copies, and policy role
   predicates followed by a stricter values-table check. Consolidate only after
   a row-by-row predicate comparison proves what the stronger check includes
   (nullability/type/constraint action/role semantics). Retain distinct positive
   and negative authority checks. Format long one-line catalog predicates and
   name safe shared expectations privately; don't build a dynamic SQL DSL.
3. Preserve the CAPABILITY_FAILURES table. Extend tests to each capability false
   and null, missing row, owner mismatch, privileged roles, wrong PostgreSQL/head,
   all/no/partial CRUD and forbidden truncate/references/trigger grants. Verify
   each capability alias occurs exactly once, not just the current nine sampled
   aliases. The type-level key constraint prevents wrong names but does not prove
   all future capability fields are in the failure table; add exhaustiveness
   evidence without forcing every unrelated boolean into that table.
4. Serving tests should cover no row, old PostgreSQL, wrong head and expected
   release/set success/failure; full startup tests should prove all authority
   checks occur and preactivation adds its target validation. Assert support
   contract errors occur before SQL. Maintain the lightweight periodic path
   and do not claim it continually verifies grants/functions.
5. Exact function source hashes are a project compatibility control, not a
   cryptographic authorization mechanism. Keep them and the reviewed rollout
   procedure. Operations doc currently calls readiness.ts the executable
   inventory, but preview pin hash is in readiness-probe-3.sql.ts; link both or
   a single explicit source inventory if later introduced. Describe prosrc as
   the stored function source text for these interpreted/string-body functions,
   not normalized formatting; changing its text changes the expected hash.
   [PostgreSQL routine catalog](https://www.postgresql.org/docs/current/catalog-pg-proc.html).
   Keep authoritative hashes obtained from a disposable applied migration,
   never auto-learn accepted hashes from the runtime database.

Order: fixture isolation before live mutation tests, missing drift checks,
row/serving tests, then semantic source naming and deduplicating strictly
equivalent predicates. Keep every distinct compatibility invariant visible.
No source changes, migrations, commits or pushes occurred.
