# Repository structure and modularity audit

Date: 2026-09-06. Status: in progress.

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
| apps/api | Reviewing capability modules and authentication provider ownership |
| apps/worker | Reviewing runtime, transport, execution and trigger ownership |
| apps/lifecycle-command | Reviewing command, configuration and readiness ownership |
| apps/operator-command | Reviewing operator command composition |
| apps/recovery | Reviewing restore-before-serve composition |
| apps/retention | Reviewing retention process composition |
| packages/artifact-store | Review in progress |
| packages/contracts | Review in progress |
| packages/database | Review in progress |
| packages/integrations | Review in progress |
| packages/node-catalog | Review in progress |
| packages/node-sdk | Review in progress |
| packages/nodes-core | Review in progress |
| packages/observability | Review in progress |
| packages/queue | Review in progress |
| packages/rate-limit | Review in progress |
| packages/workflow-engine | Review in progress |
| packages/workflow-model | Review in progress |
| Root and infrastructure | Correcting TypeScript dependency graph; tooling review in progress |

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
13 documentation tests and 232 local links pass. The broader cleanup remains
in progress.

## Verification and remaining scope

The final audit must record a disposition for every inventory row, coherent
commits, and checks actually run. Existing unresolved product API scope and
external deployment evidence remain tracked in implementation progress; this
cleanup neither resolves nor defers those requirements.
