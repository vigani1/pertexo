# Repository structure and modularity audit

Date: 2026-09-06. Status: complete for the repository modularity cleanup.

This cleanup follows the authoritative backend plan and ADR 001. It improves
developer navigation and responsibility ownership without changing product
scope, database authority, public contracts, or execution guarantees. It is
not a production-readiness certification.

## Review standard

- Organize by capability and runtime ownership, not global technical buckets.
- Keep constants beside their domain owner. A dedicated policy, limits, names,
  or tokens module is appropriate when the concept is independently meaningful
  or shared by actual callers; a repository-wide constants directory is not.
- Extract cohesive policies and transformations from mixed orchestration, but
  keep transaction, lease, and cleanup ordering explicit. Line counts identify
  review candidates, not automatic reasons to split.
- Keep deliberate package entrypoints. Internal helpers do not automatically
  become public exports; browser contracts do not acquire server dependencies.
- Prefer concrete pure functions, narrow interfaces at real seams, and schema
  inference over duplicate transport types. No speculative base classes,
  pass-through facades, or generic utilities.
- Preserve test coverage and behavior. Moving a source owner also requires
  updating its coverage inventory and evidence, never weakening thresholds.

## Inventory

All six applications and twelve packages are in scope. A retained assessment
means the inspected structure is appropriate, not that an area was skipped.

| Workspace | Review and implementation status |
| --- | --- |
| apps/api | Reviewed/refactored: seven feature modules reuse exported session/CSRF guards; retained capability-local controllers, ports and use cases. Real HTTP guard-resolution regression added. |
| apps/worker | Reviewed/refactored: application composition reuses the canonical module dependency type; retained runtime/transport/execution/trigger owners and explicit shutdown ordering. |
| apps/lifecycle-command | Reviewed/retained: config, command runner, readiness marker and entrypoint have distinct responsibilities; no extra layers needed. |
| apps/operator-command | Reviewed/retained: narrow operator command dispatch and credentials stay separate from product processes. |
| apps/recovery | Reviewed/retained: config/main/restore-before-serve composition keeps recovery ordering visible. |
| apps/retention | Reviewed/retained: process runner, maintenance loops and config are separate; database policy remains in the database package. |
| packages/artifact-store | Reviewed/refactored: pure bucket-policy inspection has a named owner and 24 table-driven regression cases; object IO remains in adapters. |
| packages/contracts | Reviewed/retained: versioned wire schemas, HTTP families and generated artifacts have explicit owners; generation drift remains checked. |
| packages/database | Reviewed/refactored: schedule administration/scanning separated; ledger read-side and cancellation/query mechanics extracted without moving transaction ordering. Existing schema/domain/role-specific exports retained. |
| packages/integrations | Reviewed/refactored: Slack/email share the bounded Retry-After parser; provider limits remain local. Existing provider/HTTP/credential owners retained. |
| packages/node-catalog | Reviewed/retained: release ledger and server composition are distinct; historical cohorts remain explicit compatibility evidence. |
| packages/node-sdk | Reviewed/refactored: bounded schema-document policy/projection separated from release lifecycle and fingerprints; browser-safe exports preserved. |
| packages/nodes-core | Reviewed/retained: per-family definitions/executors/validation are cohesive; no generic node superclass added. |
| packages/observability | Reviewed/retained: logging, tracing, configuration and metrics already have named owners; no global constants bucket. |
| packages/queue | Reviewed/refactored: delivery admission separated from consumer lifecycle; public error identity and transport ordering preserved. |
| packages/rate-limit | Reviewed/retained: endpoint policy, distributed admission and Redis runtime are already distinct cohesive modules. |
| packages/workflow-engine | Reviewed/refactored: executable identity and graph rules now have cycle-free owners; deterministic transitions/checkpoint families retained. |
| packages/workflow-model | Reviewed/refactored: graph preflight/validation/identity and expression policy/evaluation now have distinct owners behind stable package entrypoints. |
| Root and infrastructure | Reviewed/refactored: all 18 TypeScript references reflect dependencies; source import gate rejects runtime cycles and cross-workspace relative traversal. Added developer codebase map. |

## Checkpoints

### Dependency-aware TypeScript builds

The root previously listed 17 of 18 workspaces, omitting integrations. Most
consumer projects had no references to their workspace dependencies. Sequential
package builds masked this graph mismatch but did not make TypeScript's own
incremental build graph complete.

The root now references all workspaces, and each production project references
its direct runtime workspace dependencies. The root build uses TypeScript
build mode to order and incrementally rebuild those projects. The architecture
gate rejects omitted workspaces, missing/stale/duplicate references, unknown
workspace dependencies, cycles, and dependencies on deployable applications.

Verification: forced TypeScript build and all 18 workspace test typechecks
pass; six graph regression tests pass; scoped lint and formatting pass; all
13 documentation tests and 232 local links passed at this checkpoint. Final
combined evidence appears below.

### Schedule administration and scanning

Schedule CRUD and worker scanning now have separate named source owners:
`schedule-trigger-database.ts` and `schedule-trigger-scanner.ts`. Public role
entrypoints import their respective owner; the old source module retains an
explicit compatibility export list. Both factory declarations and bodies are
byte-for-byte unchanged, including SQL, lease checks and transaction ordering.
The administrative factory remains a cohesive 217-line object construction
with zero directly counted branches; its existing complexity allowance moved
to the new owner and tightened from 220 lines. No threshold increased.

Verification: database build, test typecheck, scoped lint, all 239 unit tests,
and six real PostgreSQL schedule/upgrade cases pass on the isolated stack.
The root complexity ratchet passes with the reviewed ownership move.

### Domain validation and execution ownership

Workflow-model graph exports remain stable while `graph/` owns validation
contracts, preflight, validation and identity separately. `expressions/` owns
policy and worker-pool evaluation; compiled-worker path resolution remains
covered by real worker tests. Node SDK schema-document admission and projection
now live under `definitions/`, independently of release identity/lifecycle.
Engine identity and graph-rule modules remove the previous three-file static
runtime import cycle. Unused internal re-exports are removed, not promoted to
new package exports. Package export maps are unchanged.

Scoped verification: workflow-model 91, workflow-engine 285 and node-sdk 38
unit cases pass, with build/typecheck/lint and their coverage floors.

### Persistence, transport and provider policy

The ledger coordinator keeps command/reconciliation transaction ordering and
pool ownership. Its read-side owns restore-readiness and artifact inventory;
shared PostgreSQL helpers own cancellation, acquisition and query behavior.
Lifecycle commands reuse the identical acquisition and signal-racing helpers;
their distinct transaction/query semantics remain local.
Bucket-policy inspection is now independently testable without S3 setup.
Queue delivery admission validates identifiers before entering consumer
lifecycle handling. Slack/email reuse one bounded Retry-After parser with
16 table-driven cases; provider-specific maxima remain local.

Scoped verification: database 239, artifact-store 209, queue 55 and integrations
223 unit cases pass, plus typechecks and applicable coverage floors. Database
integration verification passed 386 cases; isolated artifact integration passed
five cases with three AWS-only skips, and queue integration passed its real
Redis case. The final combined integration rerun is recorded below.

### Application composition and architecture ratchets

Seven API modules no longer redeclare the same session/CSRF providers exported
by the identity workspace module. A real Nest/Fastify regression exercises two
features together, unauthenticated rejection and CSRF rejection before any
business operation. Worker composition now has one dependency type owner.
Scoped API verification passed 476 unit cases; worker passed 278.

The architecture gate includes 15 regression cases covering TypeScript project
references and module imports. Static runtime imports/re-exports are cycle
checked; type-only and deferred imports are still checked for workspace
ownership but do not count as static initialization edges. The source graph
has no local static runtime cycle. Complexity allowances only tighten or
disappear, including stale allowances from earlier improvements; no global
budget increased. Selected coverage reviews move with their actual source
fingerprints; newly covered cases are removed from the review inventory.

The [codebase map](./codebase-map.md) records source owners, placement rules and
verification commands. Larger transaction coordinators, bounded JSON walkers,
and explicit historical release cohorts are retained deliberately: splitting
them merely to shorten files would obscure invariants or compatibility data.

## Final verification and remaining scope

`pnpm prepush:check` passes: formatting, documentation, runtime and architecture
invariants, Knip, schema ownership, project build, lint, complexity/duplication
ratchets, generated contracts, test typechecks, unit suites, coverage floors
and the source-fingerprinted risk inventory. The selected inventory reports
22 pre-existing unreviewed uncovered branches and 465 reviewed uncovered
branches across 118 files; passing this gate is not a claim of 100% coverage.
Source duplication is 28 reviewed groups / 563 lines, within unchanged limits.

`pnpm test:integration` passed on isolated PostgreSQL, Redis and S3-compatible
services: artifact store 5, queue 1, database 386, worker 30 and API 32 cases
(454 total). Three AWS-only storage cases and one API environment-specific case
were skipped. After the final identical lifecycle helper deduplication,
database typecheck, all 239 database unit cases and six real PostgreSQL
lifecycle intent cases passed again. Independent final ledger review found
no actionable defects and confirmed SQL, abort, transaction and error identity
semantics were preserved.

An initial integration wrapper omitted the isolated Compose project name;
worker recovery tests consequently reconfigured local PostgreSQL/Redis ports.
The wrapper was corrected before the successful full run. Local services were
restored healthy on ports 5432/6379; no database volumes were deleted.

Existing unresolved product API scope and external deployment evidence remain
tracked in implementation progress; this cleanup neither resolves nor defers
those requirements.
