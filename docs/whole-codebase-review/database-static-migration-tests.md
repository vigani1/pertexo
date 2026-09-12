# Database static migration tests

Date: 2026-09-12. Primary reviewer fully read all 29 files listed here; their
31 tests passed (510 ms). These are
source-text contract checks; passing them is not SQL execution, authority or
concurrency proof. SQL migration files receive separate individual judgments.

| File | Disposition | Specific judgment |
| --- | --- | --- |
| `packages/database/test/control-ledger-command-lock-migration.test.ts` | KEEP; TEST WQ-203 | Pins three narrow maintenance entry points and absence of direct destructive grants; global FOR UPDATE substring does not prove each function locks correctly. |
| `packages/database/test/durable-wait-migration.test.ts` | KEEP; TEST WQ-203 | Pins delay/admission vocabulary, mutually exclusive dates and narrow deadline-wakeup grant; SQL behavior belongs in the existing wait/claim integrations. |
| `packages/database/test/execution-admission-migration.test.ts` | KEEP; TEST WQ-203 | Explicit entitlement/admission/fairness identities and narrow worker lock grants supplement concurrency tests. Default limit literal intentionally guards a policy value. |
| `packages/database/test/for-each-barrier-migration.test.ts` | KEEP | Distinguishes typed undated barriers from timed waits and disallows a data-rewrite migration. Do not collapse null-condition assertions into only function-name presence. |
| `packages/database/test/legal-hold-destruction-serialization-migration.test.ts` | KEEP; TEST WQ-193/WQ-203 | Ordering regex pins advisory-before-workspace acquisition and seed; it does not model external append/destruction ordering. |
| `packages/database/test/regional-replica-identity-migration.test.ts` | KEEP; TEST WQ-203 | Pins status/cardinality and new signature; exact old-definition string can miss whitespace-equivalent overload retention. Verify overload absence in catalog. |
| `packages/database/test/regional-write-admission-migration.test.ts` | KEEP | Five-minute strict bound, fifteen-second freshness and stable SQLSTATE are deliberate constants, with separate behavior integration. |
| `packages/database/test/replay-lineage-retention-migration.test.ts` | KEEP; TEST WQ-203 | Pins replacement functions and child-link fence; substring existence cannot prove all summary-deletion branches use it. |
| `packages/database/test/replay-read-locks-migration.test.ts` | KEEP; TEST WQ-203 | Function-specific signature and grant/revoke checks plus fixed search path/RLS are useful. Multiline regex can span later unrelated function definitions. |
| `packages/database/test/restore-artifact-inventory-migration.test.ts` | KEEP | Ordered composite paging, available/finalized filter and maintenance-only inventory contract are concise and relevant. |
| `packages/database/test/retention-control-foundation-migration.test.ts` | KEEP historical checkpoint | Correctly describes the initial non-destructive dry-run-only control plane; do not update its historical expectation to later enforcement features. |
| `packages/database/test/retention-schedule-state-rls-migration.test.ts` | KEEP | Explicit ENABLE/FORCE RLS and owner-only policy guard a prior omission; pairs with serving-role denial integration. |
| `packages/database/test/standard-retention-classes-migration.test.ts` | KEEP; TEST WQ-203 | Names all classes, destructive page bound, reference locks and exact anchor checks; global grant regex needs catalog/behavior counterpart. |
| `packages/database/test/standard-retention-dry-run-migration.test.ts` | KEEP; TEST WQ-203 | Typed cursor casts, sentinel page, stage initialization and no tenant mutation are important distinctions. No UNION ALL is an implementation choice, not independent safety proof. |
| `packages/database/test/transient-data-retention-migration.test.ts` | KEEP; TEST WQ-203 | Pins windows, terminal predicates, active holds, bounded skip-locked deletion and role grant; behavioral tests currently cover only part of the table family. |
| `packages/database/test/workflow-run-input-retention-dry-run-migration.test.ts` | KEEP | Simple static bound/cutoff/non-mutation assertion; synchronous source read at module initialization is harmless here and not worth churn. |
| `packages/database/test/workflow-run-input-retention-enforcement-migration.test.ts` | KEEP; TEST WQ-203 | Pins paused hold state, exact two-part anchor and paired input/expiry clearing; FROM/TO role strings alone do not prove complete privilege transition. |
| `packages/database/test/workflow-run-input-retention-migration.test.ts` | KEEP | Small backfill/deadline-pair contract is backed by an exact 0042→0043 migration integration. |
| `packages/database/test/workflow-run-input-retention-scheduling-migration.test.ts` | KEEP | Pins maximum 25, workspace/state skip-lock ownership and noncompleted-batch exclusion; scheduling integration checks duplicate creation. |
| `packages/database/test/workspace-deletion-control-projection-migration.test.ts` | KEEP; TEST WQ-203 | Chronological deletion and hold predicates are valuable historical guarantees. Definer/RLS regex should not satisfy from unrelated later statements. |
| `packages/database/test/workspace-deletion-side-effects-migration.test.ts` | KEEP; TEST WQ-203 | Enumerates access/trigger/connection/run effects and checkpoint flags; lifecycle integration must assert effects, not merely these tokens. |
| `packages/database/test/workspace-lifecycle-api-authority-migration.test.ts` | KEEP | Narrow revocation intentionally preserves updated_at authority; exact historical statement is worth a focused check. |
| `packages/database/test/workspace-lifecycle-command-hardening-migration.test.ts` | KEEP; TEST WQ-203 | Pins live lease, durable append authorization, atomic projection/completion and old-function removal. Integrations cover revoked owner and repair but need WQ-198 failures. |
| `packages/database/test/workspace-lifecycle-command-intents-migration.test.ts` | KEEP; TEST WQ-203 | Distinguishes API intent versus lifecycle execution and hashed idempotency. Exact no-broad-projection-grant string is format-fragile. |
| `packages/database/test/workspace-object-versions-purge-migration.test.ts` | KEEP; TEST WQ-203 | Pins object-before-row order, bounded nonempty progress, hold/anchor and role boundary; important zero-delete completion semantics need live assertion. |
| `packages/database/test/workspace-purge-completion-migration.test.ts` | KEEP; TEST WQ-203 | Pins durable completion intent, canonical milliseconds, fences and tombstone minimization. Global ordering expression does not establish atomicity alone. |
| `packages/database/test/workspace-purge-foundation-migration.test.ts` | KEEP historical checkpoint | Initial purge must remain incomplete and nondeleting until later stages; immutable history should not be rewritten to final behavior. |
| `packages/database/test/workspace-purge-step-release-migration.test.ts` | KEEP | Token/fence/running-state predicates and narrow privilege are the right minimal retry-transition contract. |
| `packages/database/test/workspace-tenant-rows-purge-migration.test.ts` | KEEP; TEST WQ-203 | Pins page maximum, hold/anchor gates, immutable-delete arming and redacted security facts. Residual-row check must be exercised, not only named. |

## WQ-203 — retain historical smoke tests, strengthen semantic evidence

P2 TEST, not a blanket rewrite of these small files. Whole-file toContain and
cross-file-spanning regex assertions can be satisfied by a comment, unrelated
function or an obsolete definition. Examples: replay-read-locks checks SECURITY
DEFINER and row_security globally; command-intents checks absence of one exact
multiline grant; replica-identity rejects one formatting of the old overload.
Do not represent these as effective role/lock proofs in coverage summaries.

For security/transaction changes, extend existing migration integrations with
catalog queries scoped to exact schema/name/signature, owner, prosecdef,
proconfig, effective role privileges including PUBLIC/inherited roles and every
expected row count. Check removed overloads with to_regprocedure. Exercise
positive serving behavior and rejected cross-workspace/direct-mutation behavior,
since a function that rejects every call also passes a denial-only suite.

For text-level smoke tests, keep stable high-signal literals and negative
no-data-rewrite guards on immutable historical migrations. If narrowing the
checks, use bounded function/statement fixtures or a maintained SQL parser;
do not invent a naive semicolon splitter for dollar-quoted PL/pgSQL. No new
parser dependency is required just to replace concise tests with abstraction.
Neither global absence nor a CASE token count proves branch semantics.

Acceptance: deliberate test-only mutations to the correct lock order, page
bound, owner/grant, overload removal, hold predicate and tombstone field are
detected by the appropriate test; unrelated formatting is not mistaken for a
behavior defect. Maintain exact historical-head and current-head tests as
different cohorts. WQ-193 real append/delete ordering, WQ-198 authorization
repair, WQ-202 residual-row/lineage assertions and SQL migration findings own
their behavioral cases; avoid duplicate replacement suites.
