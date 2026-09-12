# API node testing and preview review

Date: 2026-09-12. Scope: 14 frozen inventory files read in full by the primary
reviewer. All 5 unit files / 22 tests passed. ADR-016 was read as the governing
contract; selected database acceptance and worker invocation paths were checked
without counting those whole modules here. Public current-code probes reproduced
the findings below using injected persistence, with no provider/service calls.

## Individual file judgments

| File | Disposition | Specific judgment |
| --- | --- | --- |
| `apps/api/src/node-testing/controller.ts` | REFACTOR/TEST WQ-081 | Validates the explicit validate/execute union, requires execution idempotency and reports 202 only for execution. Existing context projection is wrapped twice and invoked separately from guard projection; use its cohesive result directly. Raw trace header forwarding is separate from audit trace ID. |
| `apps/api/src/node-testing/errors.ts` | KEEP; TEST WQ-081 | Correctly preserves application errors, hides invisible workflows, maps revision metadata and distinguishes preview input/validation from malformed requests. Ordered conditions express real precedence, not a condition-count problem. |
| `apps/api/src/node-testing/guards.ts` | KEEP | Workflow-update authorization and active/not-found policy are explicit. Connection capability is a separate use-case check, not something this guard should silently absorb. |
| `apps/api/src/node-testing/index.ts` | KEEP | Small feature export surface supports composition and tests; do not add an independent preview framework. |
| `apps/api/src/node-testing/module.ts` | KEEP; TEST WQ-081 | Composes supplied persistence, release and expression evaluator rather than opening infrastructure inside use cases. The undefined clock argument selects the existing default; an options object is only worthwhile when changing constructor inputs materially. |
| `apps/api/src/node-testing/ports.ts` | KEEP; WQ-080 | Pick of three real persistence operations keeps preview separate from production runs. Authorization source union redundantly includes its object-port constituent; simplify the type locally when editing, not a new abstraction. Replay lookup needs a deliberate extension owned with database acceptance. |
| `apps/api/src/node-testing/tokens.ts` | KEEP | One stable authorization injection symbol. |
| `apps/api/src/node-testing/use-case.ts` | FIX WQ-080; TEST WQ-079/WQ-081 | Distinct validation and durable execution, actor-bound request hashing, pinned release, expiry/deadline separation and explicit response projection are sound. Reading/validating current draft before persistence replay prevents exact retry after an edit. Large acceptance argument object mainly records required facts; do not hide it in a generic builder. |
| `apps/api/src/node-testing/validation.ts` | FIX WQ-079; TEST WQ-081 | Iterative nested-node search, bounded issue count, explicit connection requirements and deferred prior-preview input are useful. It never compares selected config version with the pinned definition. Graph preflight already excludes reserved mapping keys in real use-case calls, so the plain mapping object is not a demonstrated prototype-injection route. |
| `apps/api/test/node-testing/controller.test.ts` | TEST/REFACTOR WQ-081 | Uses actual use cases for normal paths and checks exact acceptance/status calls. Projection-only fakes return incomplete responses and synthetic guard objects; title should not imply real authorization or HTTP filter execution. Draft fixture duplicates the use-case fixture. |
| `apps/api/test/node-testing/errors.test.ts` | TEST WQ-081 | A few known error codes/revision details are covered, but independent cases for prior-preview input, graph contract, Zod, application-error preservation and unknown failure are absent. Current assertions are grouped by broad categories rather than named causes. |
| `apps/api/test/node-testing/module.test.ts` | KEEP; TEST WQ-081 | Honest metadata inspection of exported use cases and controller. It does not exercise guard resolution, evaluator forwarding or actual execution through registered providers. |
| `apps/api/test/node-testing/use-case.test.ts` | TEST WQ-079/WQ-080/WQ-081 | Real authorization helper proves separate workflow/connection checks, pinned release and deferred prior input. No replay-after-edit case; accepted test does not check five-minute deadline or hash/trace details; status-read use case lacks its own complete behavior matrix. |
| `apps/api/test/node-testing/validation.test.ts` | TEST WQ-079/WQ-081 | Good schema/mapping/disclosure example, but a title claims ambiguity without supplying duplicate nodes. A handful of issues being <=100 does not demonstrate truncation. Split independent invalid causes and exercise the actual upper boundary. |

## WQ-079 — validate selected-node configuration identity

**P2 FIX/TEST; J01/J06/J12.**
`apps/api/src/node-testing/validation.ts` resolves the pinned definition and
runs its config schema but never checks `node.configVersion` against
`definition.manifest.configVersion`. It copies the unchecked version into
`executableNode`. In contrast, production compilation explicitly rejects that
mismatch in `packages/workflow-engine/src/executable-compilation.ts:57`.

A structurally parsed HTTP-node draft with normal valid version-1 config but
`configVersion: 999` produced no issues. The actual
`TestWorkflowNodeUseCase.execute` returned:

```json
{"mode":"validate","valid":true,"revision":3,"nodeId":"http","issues":[]}
```

The response also contained the normal unsafe-provider disclosure. This proves
incorrect validation truth for a draft shape the structural parser accepts,
not a claim that a real provider was contacted. The selected worker invocation
path parses a positive configVersion but passes config to registry execution
without comparing it; coordinate the worker's defensive persisted-input check
in its later ledger rather than assuming it compensates here.

Add a bounded field-addressed issue before treating preparation as executable:

```ts
if (node.configVersion !== definition.manifest.configVersion) {
  addIssue('$.configVersion', 'node.config_version_incompatible',
    'Selected node configuration version is incompatible');
}
```

Keep mismatch handling consistent with invalid configuration: validate reports
`valid:false`, while test_execute rejects before `acceptPreview`. Do not migrate
the draft automatically or silently overwrite its version. Preserve exact
definition/executor/release identity, schema validation and no provider activity
in validate mode. Inspect lifecycle/executor eligibility against the pinned
release as part of the same identity matrix; do not infer that a definition
resolver alone implies runtime eligibility or assert an unproved staged-release
HTTP bypass.

Tests: matching version succeeds, future/old mismatched positive version returns
the exact issue, execute mismatch has zero acceptance calls, and worker rejects
malformed persisted identity without execution. Keep real graph parsing in the
test so it does not depend on an impossible fixture. Verify API/worker typecheck
and preview suites. No new compatibility schema, release epoch or ADR is needed
to enforce the existing identity contract.

## WQ-080 — resolve exact preview replay before mutable-draft admission

**P2 FIX/TEST; J01/J05/J10/J12.**
`TestWorkflowNodeUseCase.execute:103–124` always reads the current draft and
compares revision before `acceptPreview`. The durable implementation already
checks an existing acceptance before new admission in
`packages/database/src/execution/preview-execution-acceptance.ts`, but cannot
be reached when the API revision check rejects first.

Public use-case probe: accept a valid request pinned to revision 3 (one
acceptance call); change the injected current draft to revision 4; retry the
identical actor-scoped key and request. The API throws
`WorkflowRevisionConflictError(currentRevision:4)` without calling persistence
again. ADR-016 specifies that a request retry returns the same preview rather
than starting another provider call. This is failed replay availability, **not
duplicate execution or durable corruption**.

Move authenticated exact-result resolution ahead of mutable draft parsing,
revision/schema validation and release recomposition. Compute request identity
from the validated original command, actor/workspace/workflow/node and the
existing canonical hash domain. Add a narrow authorized replay lookup or a
database-owned accept-or-replay operation that can perform this phase without
requiring a newly prepared draft. Keep final transactional idempotency lookup
and claim for races; an early read alone is not sufficient deduplication.

```text
authorize current caller -> resolve exact actor-scoped replay
                        -> if absent: validate current draft -> atomic admission
```

Replay response must come from retained preview facts, not the edited graph's
new disclosure/node metadata. Decide explicitly whether the acceptance response
is a retained acceptance snapshot or a current status projection: today it can
copy a terminal accepted.status while always returning null output/error/start/
completion. Preserve the existing public response shape and use the dedicated
status resource where required; do not manufacture a mixed snapshot during the
refactor. Keep revoked/inactive caller denial, workspace isolation, expiry and
retention rules, changed-key-content conflict, and no secrets/production events.

Tests: exact retry after draft revision/config/node changes returns the same
preview with no extra attempt/outbox; current metadata changes do not alter the
retained disclosure; changed request with same key conflicts; new key with stale
revision still rejects; revoked/cross-workspace caller cannot resolve another
preview; simultaneous first requests still create one durable acceptance. Add
current-code unit regression first when implementing, then verify in the
existing disposable preview integration lane. Coordinate the application port
and database module as one invariant, not independent agent edits.

## WQ-081 — precise preview tests and small control-flow cleanup

**P2 TEST/REFACTOR; J02/J04/J05/J07/J12.** Preserve the two mode branches and
separate connection capability check. Specific work:

- `validation.test.ts`: separate missing node, duplicate ID across nested
  bodies, unknown definition, invalid config, missing/extra connection slot,
  missing/error mapping, invalid resolved input and deferred prior input. The
  existing missing/ambiguous title never supplies ambiguity. Construct >100
  independent issues and assert exactly the cap and deterministic ordering,
  rather than merely <=100 on a small result. Test issue path/message bounds
  against the public response schema; 100 entries alone does not bound each
  entry. Keep graph/parser preconditions explicit for direct helper calls.
- `use-case.test.ts`: missing/invisible draft, revision error with exact
  representation tag, invalid prepared result, unchanged no-connection lookup
  count, WQ-079/080, idempotency conflict translation and unknown error identity.
  Assert exact release identity, five-minute execution deadline, seven-day
  retention, key/request/provider-key hashes and request/trace forwarding.
  Verify idempotent-with-key provider behavior with an appropriate registered
  definition, not only unsafe HTTP. Validation must not call acceptance,
  credentials, network or dispatch; lack of those dependencies is intentional.
- Add a named `GetPreviewRunUseCase` suite: denied/missing preview, complete
  inline/artifact/null outputs, nullable/present start/completion dates and safe
  error, exact actor/workspace forwarding, and frozen guard-context reuse.
  The controller's one queued status assertion is not complete read evidence.
- `controller.test.ts`: one complete shared HTTP draft fixture; typed minimal
  collaborator ports or valid result fixtures instead of incomplete `as never`
  returns. Test malformed/multiple execution idempotency values, validate ignoring
  irrelevant idempotency, traceparent forwarding and 200/202 behavior at real
  HTTP composition when claiming HTTP status/guard enforcement. Mapping a caught
  error manually and reading the catalog is unit evidence, not a filter test.
- `errors.test.ts`: named rows for all mapping classes and unchanged application
  error identity; check exact bounded issues/revision metadata and secret-free
  serialized response at the global filter seam. Keep WQ-055's unknown-object
  containment centralized.
- `module.test.ts`: exercise the provided expression evaluator through its
  registered use case or a composed Nest module if asserting DI behavior.
  Preserve the existing lightweight registration check for its narrower claim.
- In `controller.ts`, project authenticated context once and reuse actor,
  authorization and request/trace values. Remove private wrappers that only
  call `optionalAuthorizedWorkspace`/the shared projection. Keep meaningful
  missing-idempotency handling and strict-single-header policy visible.
- The duplicated `WorkspaceAuthorizationSource | WorkspaceAuthorizationPort`
  type already contains the latter; remove redundancy when touching ports/use
  cases. Keep ordinary TypeScript, not advanced generic extraction machinery.

Acceptance: every named negative fails for its intended reason, fixture reuse
does not hide mutation/order dependence, exact timestamps/hash bytes are pinned,
and current validation/authorization/persistence behavior stays covered through
public interfaces. Run the five-file unit selection and API typecheck; use
service qualification only for durable/concurrent claims. Implement WQ-079 and
WQ-080 separately with their regressions, then remaining focused WQ-081 cleanup.
