# Backend structure audit delivery

Source: the 28 September 2026 non-database backend audit, reviewed snapshot
`e650ae31d3473bc189fec012061daf16bac44b1b`. This implementation follows the
approved full scope, including the report's optional organization findings.
It does not certify live providers, deployments, or the unresolved intermittent
account-link finding. Unrelated `CONTEXT.md` and workspace-notifications plan
changes are excluded.

## Scope and module ownership

| Module | Baseline TS files | Canonical responsibility | Audit disposition |
| --- | ---: | --- | --- |
| packages/workflow-engine | 53 | Persistence/framework-independent execution transitions | EX1, EX3, EX4 |
| packages/workflow-model | 28 | Graph, expressions, executable identity | Inspect; preserve |
| packages/node-sdk | 12 | Execution and compatibility interfaces; release binding | EX2 canonical owner |
| packages/node-catalog | 5 | Platform release policy and provider composition | EX2 consumer |
| packages/nodes-core | 57 | Versioned core node implementations and cohorts | EX2 consumer |
| packages/integrations | 36 | Provider adapters and credential contracts | Inspect; preserve |
| packages/artifact-store | 21 | Byte storage, download signing and storage configuration | AS1, AS2, W3 |
| packages/contracts | 33 | Shared wire schemas, projections and generated artifacts | Inspect; preserve |
| packages/queue | 12 | Transport and consumer lifecycle | Inspect; preserve |
| packages/rate-limit | 4 | Policy, atomic limiting and Redis lifecycle | Inspect; preserve |
| packages/observability | 12 | Logs, metrics and traces; no implicit cancellation policy | W4 |
| apps/api | 192 | Feature HTTP/application composition and authorization | API1, API2 |
| apps/worker | 76 | Durable execution adapters, feature runtimes and transport | W1, W2, W4 |
| apps/lifecycle-command | 4 | Privileged workspace lifecycle executable | Inspect; preserve |
| apps/operator-command | 3 | Operator command union and lifecycle | Inspect; preserve |
| apps/recovery | 3 | Restricted restore executable | W3 consumer |
| apps/retention | 5 | Restricted maintenance executable | W3 consumer |

## Findings and canonical owners

All statuses below are pending until implementation and verification evidence
is recorded. Recommendation strength is not permission to omit an item.

| ID | Finding | Before | Intended canonical owner / after | Status |
| --- | --- | --- | --- | --- |
| W1 | Mail diagnostic exceptions can reject unobserved background work and skip owned cleanup | authentication-mail-runtime directly calls diagnostics and awaits activity before closing store | Authentication-mail runtime isolates diagnostics, observes activity and always attempts owned close | Implemented; focused verification passed |
| EX1 | Test-only durable-wait/cancellation policies shadow production | engine runtime.ts and testing exports | Production engine transition interface; migrate unique assertions, remove shadow models/exports | Implemented; package tests/typecheck/coverage passed |
| AS1 | Injected primary may lack advertised download signing | dual-region accepts partial primary, fails late | Dual-region construction requires its advertised primary download capability; recovery remains unsigned | Implemented; storage suite passed |
| W2 | Preview-named composition owns unrelated maintenance features | preview-maintenance runtime/provider mixes preview, reconciliation, replay, failure alerts and invitations | Explicit maintenance transport composition with feature-owned dependency factories and explicit routing | Pending |
| API1 | Decorated controllers act as sibling helper modules | identity-workspace/controllers and workflow-runs/controllers export request helpers | Feature-owned request-context modules; no sibling controller imports | Implemented; focused API tests passed |
| API2 | Legacy OIDC browser-binding cookie policy duplicated | auth and invitation controllers each serialize same cookie | One legacy OIDC binding-cookie owner; invitation/session/Better Auth cookies remain distinct | Implemented; focused API tests passed |
| W3 | Storage principal/bucket isolation duplicated | recovery and retention reconstruct region-pair invariant | Artifact-store configuration invariant, consumed by distinct executable parsers | Implemented; both executable suites passed |
| AS2 | Artifact identity and durable key formatting duplicated | store.ts and artifact-download.ts | Private artifact identity/key module; byte format unchanged; ledger keys remain separate | Implemented; storage suite passed |
| EX2 | Release-to-registration binding algorithm duplicated | core and catalog indexing, selection and facade assembly | Existing node SDK binds releases; callers retain cohort/provider policy | Implemented; SDK/core/catalog suites passed |
| W4 | Same wait name hides resolve-on-stop versus reject-on-cancel | observability/runtime and worker/runtime/abortable-delay | Explicit semantic contracts and proportionate feature/runtime placement | Implemented; runtime/consumer suites passed |
| EX3 | Structured-node flatten/find repeated in transition admission | transition state/plan/decisions each search | One immutable transition-local node lookup; no global cache or draft-validation conflation | Pending |
| EX4 | Engine families flat despite established prefixes | 53 flat source files | compilation, checkpoint, observation, transition and attempt families; stable public entries | Pending |

## Delivery sequence

1. Lifecycle/test-trust defects: W1, then EX1.
2. Canonical ownership and duplication: AS1, AS2, API1, API2, W3, EX2, W4.
3. Composition and mechanical organization: W2, EX3, EX4; inspect all 17
   modules and neighboring counterparts for concrete related responsibility
   mixing. Do not manufacture symmetry or a generic framework.
4. Whole-scope verification and independent review before final push/merge.

## Contracts deliberately kept distinct

- Lifecycle/operator/recovery/retention apps and credentials remain separate
  (ADRs 027–029, 013 and 015).
- Coordinator advancement and effectful attempts remain distinct; the engine
  does not acquire framework, persistence, transport or provider ownership.
- Node versions, immutable fingerprints, cohort/release history and old readers
  remain intact. Browser projections contain no executors.
- Provider retry/outcome semantics, draft indexes, cursor/filter contracts,
  feature guards and transactional authorization checks are not homogenized.
- Better Auth adapter SQL retains its intentional atomic lifecycle seam.
- Artifact replication and append-only control-ledger integrity/recovery
  contracts are not collapsed into a replicated-store abstraction.
- Cancellation rejection and orderly stop resolution remain different outcomes.

## Verification and evidence

Baseline audit evidence: architecture checks 19/19; narrow SDK/core/catalog/model
contract tests 18/18. That audit did not run a full application regression suite,
live workflows, external providers or scheduler benchmarks.

Implementation evidence will record exact focused and broader checks at each
stage. Coverage paths, import/export maps and test inventories must follow moves;
thresholds and meaningful assertions must not be weakened. Performance claims
require measurement; EX3 initially claims locality only.

### W1 lifecycle evidence

`apps/worker/src/execution/authentication-mail-runtime.ts` remains the lifecycle
owner. Diagnostic exceptions are isolated; timer-started activity has an
explicit rejection observer, including synchronous handler failure. Shutdown
drains activity and always attempts the owned store close, collecting failures
without skipping cleanup. Close remains idempotent and abort stops rescheduling.

The new overlapping shutdown/diagnostic regression failed on the original code
(`diagnostic unavailable` rejected shutdown and the store was not closed). The
original background diagnostic case also produced an unhandled rejection.
After the fix, authentication-mail runtime/delivery and coordinator/trigger
runtime tests passed 57/57; worker typecheck passed. Additional synchronous
handler and close-failure regressions are part of the focused suite. Whole-scope
verification is still pending.

### EX1 production-policy evidence

Removed the unused `runtime.ts` wait/cancellation models and their testing-only
exports. Unique assertions now use the production `advanceWorkflow` interface:
invalid wait observations are rejected, durable waits admit no worker attempt,
running cancellation awaits reconciliation, and unsafe dispatched cancellation
preserves `outcome_unknown` across subsequent advancement. Existing production
tests cover due-time boundaries, waiting cancellation, empty graphs and deadlines.
The surviving retry-policy tests have a responsibility-based name; public-export
tests explicitly reject the retired shadow helpers.

Engine tests passed 402/402 across 36 files; typecheck and coverage passed.
Coverage was 94.47% statements, 90.71% branches, 97.42% functions and 95.22%
lines. Coverage inventory removed only the deleted source, with thresholds
unchanged. Production transition/checkpoint behavior was not changed.

### Storage ownership evidence: AS1, AS2, W3

Dual-region construction now requires the primary's download capability in its
TypeScript interface and checks it before exposing the facade. Recovery storage
does not need signing. Tests cover construction rejection without closing borrowed
stores, unsigned recovery, primary-only signing and owned/borrowed close behavior.
The private `artifact-identity.ts` owns identity validation and unchanged
`workspaces/{workspaceId}/artifacts/{artifactId}` formatting for uploads, reads,
deletes and download signing; the existing public identity type remains exported.
Ledger formats remain separate.

`assertTenantStorageIsolation` in artifact-store configuration now owns the
Cartesian artifact/ledger principal and bucket invariant. Recovery and retention
keep distinct parsers, credentials, timeout policies and startup roles. Existing
exhaustive executable configuration tests still exercise every regional pairing.

Artifact-store unit tests and coverage passed 334/334, with 97.10% statements,
95.45% branches, 95.79% functions and 97.21% lines; thresholds unchanged.
Recovery tests passed 43/43 and retention tests 100/100. All three typechecks,
artifact-store build and scoped ESLint passed. These are adapter/unit tests,
not live S3, IAM or disaster-recovery evidence.

### API request/cookie ownership evidence: API1, API2

`identity-workspace/request-command-context.ts` owns member/self command
projection and feature idempotency-header parsing. Run request shape and actor
projection live in `workflow-runs/request-context.ts`. Sibling controllers no
longer import decorated controllers for these helpers. Existing authenticated
context/error mappings and raw SSE lifecycle contracts are unchanged.

`legacy-oidc-binding-cookie.ts` owns both issuance and clearing of the legacy
callback-only, HttpOnly, SameSite=Lax cookie. Authentication and invitation
controllers share issuance; ordinary session, invitation binding/CSRF and Better
Auth policies stay distinct.

Focused controller, membership, invitation, authentication, module-composition,
run HTTP-stack and response-contract tests passed 94/94 in 10 files. API typecheck,
scoped ESLint and architecture checks (19/19; no static import cycles) passed.
This stage has not yet rerun full-stack PostgreSQL/OIDC integration.

### SDK binding and timer semantics evidence: EX2, W4

The server-only SDK `bindRegistryRelease` owns exact registration lookup and
release-manifest binding, preserving local Zod schemas and executor functions.
Core retains its successor policy; catalog retains release/cohort validation and
lazy provider construction. Their small named execution-only facades remain
deliberate caller interfaces rather than adding a generic facade factory.
Missing implementations report the exact definition/executor identity. Browser
entry tests reject the new server helper. SDK tests passed 54/54 (including
binding, missing identities and schema/executor preservation), core 109/109 and
catalog 77/77; all three typechecks passed. SDK coverage passed unchanged
thresholds at 91.68% statements, 82.80% branches, 97.70% functions and 92.08%
lines. The initial new fixture incorrectly used an executor-only lifecycle;
typecheck caught it and the corrected definition lifecycle passed.

Orderly-stop waits are now named `waitForDelayOrStop`; attempt cancellation
waits are `waitForCancelableDelay`. Supervisor waits retain their explicit
resolve-on-stop policy. The existing observability `/runtime` subpath remains
the small shared executable-runtime seam: moving it would require a new package
or application-to-application imports without additional ownership benefit.
Operational waits remain worker-local. No cancellation behavior was homogenized.
Observability tests passed 112/112, worker delay/attempt/coordinator/trigger
tests 69/69, retention 100/100 and lifecycle-command 27/27. Consumer builds and
all four typechecks passed; ESLint and formatting passed. The first compiled
lifecycle test run used stale dist imports; rebuilding its consumer resolved
that artifact mismatch, and the full process-lifecycle suite then passed.

## Remaining work

W1, EX1, EX2, AS1, AS2, API1, API2, W3 and W4 are implemented; EX3–EX4, W2 and the complete
17-module counterpart review remain open.
No structural stage is declared complete yet.
