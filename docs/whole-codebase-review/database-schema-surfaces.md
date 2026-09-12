# Database schema, package surfaces and their evidence

Date: 2026-09-12. Primary reviewer fully read these 30 files. The static schema
ownership check and its one test passed. A source import confirmed 48 tables in
databaseSchema versus 49 typed definitions, with artifact_links omitted. No
database was contacted. The package-contract runtime-factory test and live
schema-shape suite were inspected, not executed.

## Individual file judgments

| File | Disposition | Specific judgment |
| --- | --- | --- |
| `packages/database/package.json` | KEEP; TEST WQ-138 | Explicit role subpaths, no root export, compiled JS/declaration pairs and separate integration scripts are coherent. Test the built resolution contract, not only these strings. |
| `packages/database/tsconfig.json` | KEEP | Preserves composite declarations, source-only output and actual model/core references. No buildless conversion. |
| `packages/database/tsconfig.test.json` | KEEP | Extends the build configuration while including tests/config without emission; clear ownership of test typechecking. |
| `packages/database/vitest.config.ts` | KEEP; TEST WQ-138 | Unit/integration filename separation is explicit, but filename classification alone does not prevent a unit factory from opening a monitor connection. |
| `packages/database/vitest.coverage.config.ts` | KEEP | Explicit narrow transaction/authorization unit baseline, with honest comment that SQL evidence belongs to integration. Do not describe this as whole-database coverage. |
| `packages/database/vitest.integration.config.ts` | KEEP | Serial files/fork isolation support schema-mutating suites. This does not serialize independent commands/processes against a shared database; retain WQ-133 isolation work. |
| `packages/database/vitest.integration-coverage.config.ts` | KEEP | Same serial integration selection and broader source coverage are appropriate. Keep paired selection in sync without inventing a generic configuration framework. |
| `packages/database/test/package-contract.test.ts` | KEEP; FIX/TEST WQ-138 | Useful exact capability projection assertions. Source imports do not verify compiled exports, substring exclusions miss transitive exports, and real factories start default lock-wait monitoring. |
| `packages/database/src/api.ts` | KEEP | Explicit named API capabilities and types expose application authority without broad testing exports. Length reflects the supported domain surface, not conditional complexity. |
| `packages/database/src/execution.ts` | KEEP | Worker/coordinator/dispatcher capabilities are explicit. Keep acquireDatabasePool while the worker adapter legitimately needs it; do not remove exports solely because an internal comment exists. |
| `packages/database/src/lifecycle.ts` | KEEP | Four-line lifecycle-command surface makes its authority conspicuous. Merging with maintenance would hide an important role distinction. |
| `packages/database/src/maintenance.ts` | KEEP | Retention/purge capabilities belong together; type exports avoid implementation imports for consumers. |
| `packages/database/src/operator.ts` | KEEP | Narrow command interface and result types preserve function-only operator access. |
| `packages/database/src/recovery.ts` | KEEP | Recovery exposes the control-ledger coordinator plus maintenance configuration, not arbitrary lifecycle commands. |
| `packages/database/src/testing.ts` | KEEP; TEST WQ-138 | Broad fixture barrel is intentional and labeled; production dependency enforcement should test the transitive/built surface separately. Do not shrink it indiscriminately. |
| `packages/database/src/schema.ts` | FIX/TEST WQ-139 | Domain imports/re-exports are readable, but databaseSchema omits artifactLinks despite exporting it. The live all-typed-table test iterates this narrower object. |
| `packages/database/raw-sql-table-registry.json` | DATA; KEEP; TEST WQ-139 | All 19 entries describe table owner, allowed role categories, RLS applicability and a concrete SQL-owned invariant. Validate role values and actual privilege shapes, not only nonempty arrays. |
| `packages/database/src/schema/app-schema.ts` | KEEP | Single shared app schema declaration avoids namespace drift; no extra wrapper needed. |
| `packages/database/src/schema/foundation.ts` | KEEP | Typed identity/session/workspace/audit/usage columns have recognizable domains, timestamp modes and explicit IDs. SQL owns RLS/check constraints; absent ORM copies are not automatically absent database guarantees. |
| `packages/database/src/schema/authoring.ts` | KEEP | Lifecycle versus activation remains distinct; version/checksum and workspace-qualified references express stable authoring identities. Keep SQL-authoritative immutable-version rules. |
| `packages/database/src/schema/connections.ts` | KEEP | Connection metadata, immutable secret versions and audit events are separated; composite tenant identities and nonrevoked name uniqueness are explicit. Encryption fields are typed storage, not plaintext handling. |
| `packages/database/src/schema/transport.ts` | KEEP; TEST WQ-139 | Artifact capacity, outbox leases and inbox dedupe are easy to locate. Full migrated key/constraint equivalence is not established by name/nullability-only shape tests. |
| `packages/database/src/schema/execution.ts` | KEEP | Runs, checkpoints, nodes, attempts and previews are cohesive declarative groups. Nullable attempt/error/pin fields reflect persisted phases; converting database row storage to one TypeScript union would not enforce SQL transitions. |
| `packages/database/src/schema/execution-support.ts` | KEEP; TEST WQ-139 | Artifact links have explicit tenant/preview ownership; idempotency tables separate workspace versus workspace-creation scopes. Include artifactLinks in the inspected schema inventory. |
| `packages/database/src/schema/triggers.ts` | KEEP | Endpoint secret overlap, ingress limits, replay records and schedule occurrences have distinct identities. Avoid consolidating these into generic key/value rows merely to reduce declarations. |
| `packages/database/src/schema/compatibility.ts` | KEEP | Release, preactivation, approval, current pointer and activation history correctly remain separate authority/evidence records with explicit release references. |
| `packages/database/src/schema/retention.ts` | KEEP | Ledger projections, legal holds, audit linkage, batch fencing and scheduling are recognizable. Repeated timestamp/identity declarations are clearer than hidden generic table factories. |
| `packages/database/test/schema-shape.integration.test.ts` | KEEP; FIX/TEST WQ-139 | Disposable-database ownership and real catalog checks are valuable. Typed inventory omission and weak index/grant assertions limit its stated scope; owner close failure skips fixture drop. |
| `infrastructure/validate-database-schema.mjs` | KEEP; TEST WQ-139 | Useful static ownership inventory, explicit UUID-generation rule and duplicate/raw-vs-typed checks. Historical regex presence is not current schema/RLS proof; strengthen registry validation and test invalid cases. |
| `infrastructure/validate-database-schema.test.mjs` | KEEP; TEST WQ-139 | Independently pinned counts detect unreviewed inventory growth. One happy-path count does not exercise the validator's negative branches. |

## WQ-138 — make package-contract tests genuinely offline and test the build

P2 FIX/TEST. At `test/package-contract.test.ts:105–143`, both connection factories
are constructed before try, using a localhost connection string and no injected
runtime. `connections.ts:createConnectionDatabase` acquires a default pool;
`postgres-telemetry.ts:480–482` installs a timer and immediately calls sample,
which executes a pg_stat_activity query. This unit test therefore attempts real
network access even though it calls no repository method. It can appear green
because monitor failures are swallowed, not because no connection occurred.
This is source-traced behavior; this audit deliberately did not execute it.

Use the existing createDatabaseRuntime(config, { monitorLockWaits: false }) seam
and inject the same matching-authority runtime into both projections. Register
ownership before constructing the second factory, close borrowed repositories,
then close the runtime even after assertion/construction failure. For projection
tests assert no checkout/query occurs using a deterministic source-local spy or
existing injected pool seam; do not introduce a public fake-runtime constructor.

Keep exact Object.keys capability assertions. Add built-package imports for all
seven supported subpaths after build and verify expected values/forbidden broad
capabilities. Include a negative root/private path resolution check using the
actual package resolver. Verify declaration resolution with the existing test
typecheck seam. A textual `not.toContain("from './testing.js'")` is a useful
cheap guard, but cannot establish no transitive re-export; use the existing
dependency-boundary infrastructure for that stronger claim. No new bundler.

Acceptance: unit tests run with database/Redis unavailable and record zero
connection attempts; partial construction/failed assertions leave no owner;
built JS and declarations resolve all permitted role subpaths and reject private
ones. Retain role-specific runtime projections and intentional testing surface.

## WQ-139 — align schema inventories and narrow or strengthen catalog claims

P2 FIX/TEST. `schema.ts:118–167` defines databaseSchema without artifactLinks;
`schema-shape.integration.test.ts:101` loops Object.values(databaseSchema).
Static validator finds 49 typed table declarations while the actual source
schema object contains 48. Probe confirmed artifactLinks is absent. Add the
missing table to the schema/test inventory and an exact name-set consistency
assertion so future additions cannot silently bypass the supposedly complete
shape comparison. Do not claim missing artifact_links runtime queries: code can
and does use explicitly imported table objects; the evidenced defect is coverage.

Keep current name/nullability assertions, then make additional guarantees precise:

- Raw-table `has_index` is merely any index; a primary key already supplies one.
  It does not prove dispatch/retention/lookup indexes. Specify required index
  identity, ordered columns/predicate and validity for risk-bearing contracts,
  or rename this assertion to the narrower guarantee actually checked.
- ACL test validates direct table grantee membership in an allowed set, not
  privilege kinds, required grants, column grants, inherited effective access,
  ownership or function-only entrypoints. A permitted role receiving too much
  authority can pass. Derive precise allow/deny cases from existing readiness
  and role contracts; don't assume every accessRoles entry must get table access
  because some entries explicitly describe function-only use. Preserve PUBLIC
  visibility regression. Add disposable drift tests for excess privilege types,
  column grants, wrong owner and unexpected inherited privilege where relevant.
- The static script searches all historical SQL for CREATE and ENABLE/FORCE
  phrases. It does not apply DROP/ALTER history or prove current enforcement.
  Keep it a source ownership check; use the live migrated catalog for current
  state. Validate registry names/role enum values/duplicates and nonblank reason;
  interpolate only validated names in regex checks. Add synthetic-input tests
  for unknown/duplicate/unowned tables, invalid RLS/roles and forbidden UUID
  defaults. A small private pure validation function is enough if needed.
- Type, defaults, checks, foreign keys and indexes are outside the current typed
  shape assertion. Prioritize exact domain-critical compatibility checks rather
  than pretending this test is complete ORM-to-database equivalence. PostgreSQL
  migrations remain authoritative; never run schema synchronization to repair
  differences. Numeric bigint projections require safe-range guarantees at
  their consuming seams, not an indiscriminate bigint API rewrite.
- afterAll must attempt fixture.drop even if owner.end fails and preserve both
  failures. Keep exact disposable database ownership; no broad shared cleanup.

Order: offline package fixture first; inventory completeness next; negative
validator and targeted catalog-drift evidence alongside WQ-132/WQ-133. Schema
declarations otherwise stay declarative and domain-grouped. No migration rewrite,
service call, implementation change, commit or push occurred.
