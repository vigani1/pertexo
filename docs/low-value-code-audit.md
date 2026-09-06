# Low-value code audit

Reviewed 2026-09-06, starting from `8ceb7a06`. Scope: redundant tests, trivial
wrappers, dead abstractions, duplicate helpers, stale comments and unnecessary
ceremony. This is a focused removal audit, not a new correctness certification.
Generated output, dependencies, local environment files and historical SQL
migrations were not deletion targets.

## Changes and safety evidence

| Removal | Why safe | Verification |
| --- | --- | --- |
| Overwritten workflow-model selector in `eslint.config.mjs` | The later model-specific rule already replaces it; the engine selector remains. | Resolved full configurations for model/engine source and tests have identical SHA-256 hashes before/after; lint passes. |
| Unmatched `packages/integrations/*` workspace glob | Integrations is one workspace; no nested package manifests exist. | Same 18 workspace names before/after; frozen-lockfile validation passes with no lockfile change. |
| Local `requestSignal` in the ledger adapter | Its body was byte-for-byte identical to the existing `artifact-request-lifecycle.ts` helper. All four callers now use that same implementation. | 209 artifact-store unit tests and coverage floors pass; the existing cancellation/timeout/client-ownership regression in `test/control-ledger.test.ts` remains intact. |
| Unused private `readyNodeDecision` parameter | `indexes` was never read; the only caller passed a local variable, not an expression with side effects. Index creation and readiness filtering remain unchanged. | 285 engine tests and coverage floors pass, including scheduler projection, branch/join and generated state-machine cases; test typecheck passes. |
| Dummy webhook mock implementation | The mock ignored its argument and always resolved `health`; a typed `mockResolvedValue` preserves that result and recorded calls. | All eight webhook service cases and API test typecheck pass, retaining credential, idempotency and replay assertions. |

The storage coverage review inventory was relocated to the changed source
coordinates. Thirty source-backed fingerprints are unchanged; two existing
V8 locations without executable coordinates were rechecked and fingerprinted
against the updated file. No review classification or coverage floor changed.

## Major-directory inspection

This original pass records directory-level coverage, not an exhaustive
file-by-file certification. A broader tracked-file pass was requested afterward
and is tracked separately in the implementation progress journal.

Source, tests/support, manifests and meaningful import/caller relationships
were inspected in every workspace. A retained row means no safe, worthwhile
removal was established, not that the directory was skipped.

| Directory | Areas inspected / disposition |
| --- | --- |
| `apps/api` | Feature controllers/use cases/guards, identity adapters, platform and bootstrap, tests/support; simplified only the webhook mock. |
| `apps/worker` | Configuration, execution, transport, triggers, runtime, platform, bootstrap and test fixtures; retained lifecycle and dispatch seams. |
| `apps/lifecycle-command` | Configuration, command runner, readiness, main and tests; retained separate authority/process ownership. |
| `apps/operator-command` | Configuration, operator dispatch, main and tests; retained operator credentials and no-listener process. |
| `apps/recovery` | Configuration, restore-before-serve, main and tests; retained recovery ordering. |
| `apps/retention` | Configuration, runner, maintenance loops, main and tests; retained maintenance ownership. |
| `packages/artifact-store` | Store/ledger adapters, lifecycle helpers, encryption, policies and tests; removed exact deadline-helper duplication. |
| `packages/contracts` | Public schemas, HTTP/error/pagination contracts, generated-artifact tooling and tests; retained compatibility aliases and distinct path-parameter semantics. |
| `packages/database` | Persistence domains, platform/config, role-specific exports, schema/migrations, scripts and test/support; retained differing locks, transaction/abort behavior and migration history. |
| `packages/integrations` | HTTP, Slack, email, webhook, credential/crypto modules and tests; retained distinct dispatch/idempotency and provider error policies. |
| `packages/node-catalog` | Release cohorts, registry/server composition and tests; retained historical compatibility evidence and browser-safe identity ownership. |
| `packages/node-sdk` | Contracts, schema documents, registry/runtime, identity/compatibility and tests; retained bounded validation and public exports. |
| `packages/nodes-core` | Node-family definitions/executors/validation, registration and tests; retained family and registration ownership. |
| `packages/observability` | Logging, tracing, metrics, configuration and tests; retained distinct privacy/cardinality/lifecycle contracts. |
| `packages/queue` | Contracts, names/defaults, delivery admission, producer/consumer, Redis helpers and tests; retained differing public error mappings and per-field option documentation. |
| `packages/rate-limit` | Policy, distributed limiter, Redis runtime and tests; retained the post-await state-reading helper after testing its removal. |
| `packages/workflow-engine` | Compilation, checkpoints, scheduling, transitions, testing surface and test families; removed unused private scheduler argument. |
| `packages/workflow-model` | Graph, expressions, mappings, canonical JSON, public facades and tests; retained bounded walkers and package entrypoints. |
| `infrastructure/` | Architecture, runtime, schema, docs, coverage, duplication and image validators and tests; retained independent gate assertions. |
| `infrastructure/ecs` | Rendering, runtime closure, connection budget, release/startup and evidence validation; retained deterministic-render and production-parser checks because they test different properties. |
| `infrastructure/exercises` | Runner, six profiles, validation and tests; retained authentication, response-policy and evidence controls. |
| `infrastructure/observability` | Collector/Prometheus/Grafana configuration and validator; retained configuration ownership. |
| `infrastructure/postgres`, `infrastructure/minio` | Role/bootstrap scripts and storage policies; retained credential and privilege separation. |
| `.github`, `.githooks` | CI/CodeQL/release workflows, dependency policy, ownership and push hook; retained independent runner gates and protected-check names. |
| `docs/`, root files | ADRs, audit/operations indexes, progress, contributor/security guidance, Docker/Compose, manifests and compiler/lint configuration; removed only inactive selectors, preserved historical evidence. |

## Rejected removals

- No test was proven behaviorally redundant, so no tests were deleted. Similar
  fixtures cover different authorization, lifecycle, provider or compatibility
  cases; textual duplication alone is insufficient evidence.
- Inlining Redis `isClosed()` triggers `no-unnecessary-condition` after the
  earlier check narrows the field across `await`. The helper deliberately
  reads asynchronously mutable state; removing it would require a suppression
  or a larger rewrite. The attempted change was reverted; all 29 rate-limit
  tests pass.
- Webhook `throwManagementError` centralizes three throws of the deliberately
  frozen application-error value and one justified lint suppression. Inlining
  it duplicates that exception to the throw rule.
- Public compatibility exports, process adapters, per-field documentation and
  historical release/migration evidence were not treated as dead code merely
  because they are small or repetitive.

## Verification

Focused tests, changed-file lint and API/artifact-store/engine typechecks pass.
All 110 infrastructure tests, 15 architecture tests, Knip, complexity and
duplication gates pass. The selected risk report remains at 22 pre-existing
unreviewed and 465 reviewed uncovered branches. Full pre-push verification is
run before publishing each completed checkpoint. No service-backed integration
suite is required for these behavior-preserving removals; no local services
were started, stopped or reconfigured for this audit.

## File-by-file follow-up: tooling checkpoint

The broader pass starts at `e4feb99d`. Its first completed cleanup removes:

- The `apps/web` ESLint block: no tracked file matches it, and the authoritative
  plan explicitly defers the web client outside this checkout. The resolved
  configurations for all 1,140 tracked TypeScript/MJS files retain the same
  aggregate SHA-256 (`72ad2c60190bfaa4c175966b6550fdc251ede32449f5ef2869a9adbe57d09183`).
- The unused `task` argument of the rendered-startup negative-config helper.
  AST inspection proves zero parameter reads, an unchanged function body and
  one caller with identical remaining arguments. No runtime startup behavior
  changes; the service-backed smoke exercise is not claimed as rerun.
- The second `signal.threshold <= 0` predicate in deployment validation. The
  preceding unconditional signal validation already rejects it. Fifty-two
  before/after cases preserve exact acceptance and error messages, including
  invalid types, non-finite values and boundary values across all four signals.
- The outer `doesNotReject` callback around the schema-count equality assertion.
  The async test still awaits validation and fails on rejection or mismatched
  counts, preserving the same three schema ownership assertions.

Changed-file lint, schema validation and deployment checks verify this checkpoint.
Full review coverage and remaining findings are still in progress.
