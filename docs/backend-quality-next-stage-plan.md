# Backend quality next-stage implementation plan

Date: 2026-09-10. Status: mandatory local implementation complete; N00–N11
verified locally. E01/Q14 remains unexecuted and requires separate authorization.

Further local-only quality work is specified in the
[code-quality 9/10 plan](backend-code-quality-9-plan.md). That roadmap is planned,
not implemented, and assesses code quality separately from deployment readiness.

## Objective and authority

Improve every assessed area of the existing backend: naming and organization,
control flow and readability, responsibilities and interfaces, runtime/data/error
safety, tests and verification, and performance/operational evidence. This is a
finite implementation handoff, not permission for a whole-repository rewrite or
a claim that every module currently contains a defect.

The [existing quality plan](backend-quality-improvement-plan.md) remains the
current Q01–Q14 status entrypoint. Its Q01–Q13 remediation, including the final
provider retry, historical dispatch uncertainty and subprocess cleanup fixes,
is not an open backlog. This document defines the next stage. Do not redo closed
work or silently reopen an accepted retain-unchanged decision.

The [backend blueprint](workflow-platform-backend-plan.md), [domain vocabulary](../CONTEXT.md),
accepted ADRs, public contracts and `AGENTS.md` remain authoritative. In
particular, preserve PostgreSQL execution authority and RLS, transport-only
BullMQ, immutable node/retry/checkpoint identities, NestJS and the TypeScript
build, and the existing deployment/provider choices. ADR 007 owns execution
truth; ADR 015 owns production objectives. A routine internal refactor or test
does not need a new ADR. A genuine architectural change requires its decision
before implementation and is not implied by this plan.

This planning turn authorizes documentation only. A subsequent request to
implement this plan authorizes its local work, not commits, pushes, deployment,
paid resources, live provider delivery or destructive external drills. Preserve
the existing dirty worktree. Do not update `implementation-progress.md` unless
the work changes its claims or implements a backend-blueprint checkpoint.

The final directly verified `pnpm check` passed 2,463 unit/component tests,
lint, build and type checks. Both final fault reproductions passed. The same
source-stable qualification passed eight local performance scenarios with five
measured rounds each. These candidate-specific local observations are not proof
of deployed reliability. Test counts and the current qualitative 8/10 assessment
are reference observations, not acceptance targets.

## Binding completion rules

1. Account for **every N00–N11 item**, every required scenario, and every area
   in the coverage matrix below. Do not implement only the easiest few items.
2. Classify work honestly: confirmed defect, observed maintenance friction,
   evidence gap, or conditional refactor. The items below are primarily the
   latter three. A newly discovered defect needs a reproduction and regression.
3. Map existing tests before adding another. An existing test satisfies a case
   only if it exercises the stated interface and asserts the stated outcome.
   A mocked completion call does not prove a PostgreSQL transaction; an adapter
   recommendation does not prove the coordinator's retry decision.
4. Mandatory deliverables cannot be waived with “looks good.” A conditional
   refactor may be retained unchanged only after its required characterization,
   concrete alternative comparison and evidence are recorded. This does not
   waive its tests, documentation, or an independently observed defect.
5. Never improve a score by weakening schemas, altering immutable policy
   versions, raising debt ceilings, shrinking coverage includes, adding retries,
   suppressing lint, replacing behavioral tests with source-text checks, or
   splitting files solely to satisfy line counts.
6. Keep SQL transaction/lock order, dispatch markers, resource ownership and
   cleanup ordering explicit. No generic repository, universal lifecycle
   framework, new test framework, dependency migration or blanket rename.
7. Tests may replace redundant predecessor tests only after equivalent or
   stronger observable assertions exist. Record what was removed and which
   surviving test protects it. Retain independent historical golden fixtures.
8. Continue through all local items while safe, in-scope work remains. If an
   item requires new authority or cannot be proved, mark it blocked with the
   exact missing input and continue independent items. Never call the local
   stage complete with a mandatory item blocked or unaccounted for.
9. External execution is E01/Q14, not a hidden prerequisite that may be silently
   skipped or performed without authorization. Local completion and production
   qualification are separate statuses.

## Order and ownership

| Wave | Items | Required exit |
| --- | --- | --- |
| Baseline | N00, then N01 | Source-bound baseline and complete ownership map |
| Behavior proof | N02, N06, N07 | Composed execution cases, branch dispositions and transaction fault proof |
| Focused structure | N03, N04, N05 | Characterized changes; no duplicated predecessor execution path |
| Evidence quality | N08, N09, N10 | Comparable measurements, sensitive gates, external approval packet |
| Closeout | N11 | All local acceptance criteria, independent review and full local qualification |
| Separately authorized | E01, existing Q14 | Retained external evidence and operator approval |

Establish N08's corrected baseline before comparing an optimization. Independent
packages may run in parallel, but one owner must integrate provider/worker/engine
invariants. N03 and N08 share the benchmark files and must not have concurrent
writers. Coverage outputs and `quality:local` are serialized. Commit boundaries,
if later authorized, follow coherent reviewed changes, not this table's row count.

## N00 — Freeze and measure the actual starting candidate

Classification: mandatory evidence baseline.

Targets: root scripts, `infrastructure/run-local-quality.mjs`,
`infrastructure/validate-complexity.mjs`, `infrastructure/report-risk-coverage.mjs`,
and the implementation record at the end of this document.

Required work:

- Record branch, upstream, HEAD, dirty paths and a fingerprint covering tracked
  and untracked non-ignored source. HEAD alone does not identify this candidate.
- Run the unchanged `pnpm quality:local` on owned disposable services. Record
  the manifest, selected coverage scope, test health and legitimate external
  exclusions. Diagnose failures before treating them as the baseline; do not
  remove a lock owned by another run or reuse a developer's database.
- Record current complexity hotspots, supported exports, branch-review debt
  and named-operation populations. Re-inventory current code rather than use
  historical hotspot line counts as present measurements.
- Keep the source-stable baseline and final evidence separate. Identify all
  source changes made between them, including existing dirty work.

Done when: another AI can identify exactly what was measured and reproduce the
same local command. Baseline failures and unavailable external evidence are
visible, not silently counted as passes.

## N01 — Make ownership and names navigable across all areas

Classification: mandatory navigation/terminology review; edits only where useful.

Targets: `docs/codebase-map.md`, `docs/operations/supported-export-surface.md`,
the current quality entrypoint, and the source owners in the area matrix.

Required work:

- Add a concise behavior-to-owner map for manual run/replay, webhook admission,
  scheduled start, provider execution/retry/cancellation, run-event streaming,
  failure notification, artifact transfer, and retention/purge/recovery. Each
  row must name the entrypoint, policy owner, persistence owner, resource owner
  and owning behavioral test. Link to existing files, not parallel prose specs.
- Use the existing distinctions between workflow lifecycle, activation,
  workflow restoration, version restoration and run replay. Preserve stable
  wire/database/versioned identifiers. Load domain-modeling guidance before
  actually changing domain terminology, `CONTEXT.md` or an ADR.
- Document the canonical authenticated request-type ownership addressed by
  N05. Keep transport `Request` types distinct from application `Input` types;
  do not move HTTP fields into use-case interfaces.
- Inventory naming exceptions encountered in these paths. Fix a misleading
  internal name only when it hides ownership or changes meaning. Record why
  an intentional factory/runtime naming exception remains; do not rename all
  `use-cases.ts`, `types.ts`, `module.ts` or barrel files for uniformity.

Done when: every journey and every area has a current owner/test link, renamed
symbols have all callers updated, and documentation/export/architecture checks
pass. No new global `utils`, `services` or `repositories` hierarchy is created.

## N02 — Prove provider outcomes through persistence and coordination

Classification: mandatory composed-test improvement; not a reopening of fixed bugs.

Targets:

- `apps/worker/test/http-node-attempt.integration.test.ts` and its existing
  `test/support/http-node-attempt.*` fixtures;
- `apps/worker/src/execution/node-attempt-handler.ts`,
  `provider-connection-runtime.ts`, and existing runtime composition;
- `packages/integrations/src/{http-request,slack,email}/executor.ts` and
  `src/provider-dispatch-fence.ts`;
- the actual database attempt claim/completion and coordinator observation/commit
  modules under `packages/database/src/execution/`;
- `packages/workflow-engine/src/retries.ts` and its pinned policy consumers.

The current adapter tables and mocked worker completion tests are useful. Extend
the real worker fixture for missing combinations rather than copy those tables
into another mock-only test or use probe-schema outcomes as the sole proof.

| Required case | Observable result to assert |
| --- | --- |
| Transient credential resolution or current-secret fence failure, definitely before dispatch | No provider bytes; persisted retryable provider failure; coordinator schedules exactly the policy-allowed next attempt and continuation |
| Genuine internal failure | Remains non-retryable under the existing pinned policy; do not edit `engine.retry@1` to make a test green |
| Invalid/revoked/rotated credentials without earlier uncertainty | Permanent authentication failure, no provider call and no inappropriate business retry |
| Possible dispatch followed by wire failure | Apply the actual registered side-effect contract: unsafe work remains unknown; eligible keyed retry preserves its original key/binding |
| Earlier possible dispatch followed by a failure before redispatch | The later resolution/fence failure does not erase earlier uncertainty |
| Durable cancellation and deadline before execution and during heartbeat-controlled execution | With and without earlier uncertainty, persist the ADR 007 outcome; exercise both control-entry paths, not one representative path |
| Queue shutdown/abort or lost heartbeat ownership | No unfenced terminal overwrite; recovery uses durable state rather than a fabricated cancellation result |
| Stale completion after reclaim plus exact duplicate delivery | Winning fence remains authoritative; no additional provider effect, intent or completed receipt |
| Logical retry versus replay identity | Retry retains the provider key; replay creates a new run identity/key without rewriting original history |

Use only side-effect classes supported by the real selected registration. Inject
faults at provider/credential seams, but use real attempt persistence and
coordinator advancement for the final verdict. At least one case per distinct
HTTP, Slack and email classification path must compose its real adapter with
the pinned retry policy. The durable multi-attempt cases may share one suitable
keyed-provider fixture instead of duplicating the entire suite per provider.

Assert relevant attempt/node/run rows, retry decision and due time, dispatch
marker, provider identity, inbox receipt, outbox identity and provider-call
count. Do not require a forbidden new attempt after durable cancellation.

Done when: every row has named executed evidence, the original bad classifications
would make it fail, and no new policy version, status vocabulary, migration or
generic provider-test framework was introduced merely for these tests.

## N03 — Give command lifetime one implementation shared by both runners

Classification: observed duplication; mandatory design/characterization, conditional extraction.

Targets: `infrastructure/owned-process-tree.mjs`,
`infrastructure/run-local-quality.mjs` (`capture`, `execute` and termination),
`infrastructure/performance/run-local-benchmark.mjs` (`run` and termination),
and both existing runner test files.

Both runners are currently fixed. However, process ownership is shared while
exit/close ordering, output draining and error aggregation are implemented
separately. This is the concrete change-locality problem to address.

Required work:

- Compare retaining the wrappers against a small infrastructure-local managed
  command module. Prefer one owner for spawn, direct-child exit, descendant
  termination, output close and final command/cleanup failure. Keep live log
  streaming versus buffered benchmark capture as explicit caller-specific
  behavior; do not build a configurable universal process framework.
- Document the interface's result, cancellation and ownership contract. A
  caller must not need to rediscover that child `exit` precedes inherited-pipe
  `close`. Preserve benchmark process-group sampling and nonzero exit status.
- If extracted, migrate both runners and remove their duplicate lifecycle
  algorithm in the same coherent change. Do not retain two fallback algorithms.
- Keep log failures, command failures and cleanup failures observable together;
  keep output tails arriving after exit; do not leave cleanup failure waiting
  forever on a stream held by a descendant.

Required tests, through both real CLI consumers where applicable:

- ordinary success; spawn failure; command exit failure;
- a descendant inheriting stdout/stderr after parent exit;
- SIGINT and SIGTERM during a prerequisite and an active workload;
- failed termination followed by retry, preserving process ownership;
- command plus cleanup failure; output/log failure during final drain;
- an unrelated process stays alive; no owned descendants or lock remain;
- the root qualification can execute its own isolated regression tests.

Done when: tests prove one reusable lifecycle contract, or a reviewed retention
decision precisely identifies which ordering rules cannot be shared and adds a
consumer-parity test for them. Line-count reduction alone is not success.

## N04 — Clarify worker activation and resource ownership

Classification: observed orchestration density; mandatory characterization, conditional refactor.

Targets: `apps/worker/src/execution/node-attempt-runtime.ts`,
`apps/worker/src/transport/node-attempt-runtime-provider.ts`,
`apps/worker/test/node-attempt-runtime.test.ts`, `worker-bootstrap.test.ts`,
and `preview-consumer-delivery.integration.test.ts`.

The provider selects production/preview enablement and constructs preview
resources; the runtime constructs handlers, capabilities and one shared
consumer and performs cleanup. Make that ownership and handoff explicit.

Required work:

- Characterize disabled, production-only, preview-only and both-enabled modes.
  Record which layer creates, transfers and closes each resource, including
  injected test capabilities and resources created before a later factory fails.
  Do not assume injected automatically means borrowed; use the actual contract.
- Compare the existing composition with a private activation descriptor and
  one resource-ownership list. Extract only if it reduces repeated knowledge
  between the provider and runtime. Keep separate production and preview policy;
  do not merge their handlers into a boolean-controlled state machine.
- Prove core preview execution does not acquire production dispatch requirements;
  production HTTP activation still requires the necessary connection/artifact
  capabilities; explicit preview capability overrides and fallback remain intact.
- Exercise failure at each meaningful construction stage, repeated close and
  close failure. Every owned resource is released according to its contract,
  no successful construction escapes a failed startup, and primary failure is
  not hidden by cleanup. Preserve readiness ownership and consumer drain order.

Done when: the four-mode table is executable, the shared consumer is not
duplicated, ownership can be traced in one place, and existing preview
crash/reconciliation and production runtime tests still pass. Retain the
deliberate checkpoint/scheduler/purge state-machine layout recorded previously.

## N05 — Consolidate authenticated request types without changing behavior

Classification: concrete type duplication / naming improvement.

Targets:

- `apps/api/src/identity-workspace/types.ts`;
- `apps/api/src/workflow-authoring/types.ts`;
- `apps/api/src/workflow-runs/controllers.ts`;
- existing connection/artifact request extensions and node-testing consumers;
- `apps/api/test/workflow-authoring/controllers.test.ts`,
  `test/workflow-runs/controllers.test.ts`, `test/response-contract-types.test.ts`,
  and the SSE transport/use-case suites.

Required work:

- Use the existing `IdentityWorkspaceRequest` and `AuthenticatedRequestSession`
  as the owners of shared HTTP/session fields. Replace repeated feature field
  definitions with aliases or narrow `Readonly`/`Pick` projections where needed.
- Preserve exported feature aliases and intentional readonly/optional/narrow
  shapes. The current declarations are similar, not literally identical:
  authoring omits reauthorization; runs adds raw close listeners. Do not widen
  or remove a capability accidentally while claiming a mechanical deduplication.
- Keep feature-specific raw socket capabilities as explicit extensions. Keep
  actor/error/authorization helpers separate unless their behavior is proven
  identical; those functions are not automatically interchangeable.
- Add compile-time compatibility assertions plus existing route/SSE behavior
  evidence. Verify propagation of session, actor, authorized workspace, request
  metadata and reauthorization without recreating public wire schemas.

Done when: shared field definitions have one owner, genuine feature differences
remain visible, public aliases remain compatible and API typecheck/controller/
SSE/architecture checks pass. No generated OpenAPI change is expected.

## N06 — Resolve the entire current uncovered-branch review inventory

Classification: mandatory risk-inventory completion, not a percentage contest.

Targets: fresh `coverage/risk-uncovered-branches.json`,
`infrastructure/risk-coverage-reviews.json`, `report-risk-coverage.mjs` and its
tests, and the owning coverage configurations/test suites.

The observed inventory contains 22 unreviewed branches. Regenerate it at N00;
branch IDs and line locations are not stable across source edits.

| Cohort | Observed count | Exact current source owners |
| --- | ---: | --- |
| artifact-store | 8 | `src/artifact-download.ts`, `src/dual-region-artifact-store.ts`, `src/store.ts` |
| contracts | 1 | `src/openapi-primitives.ts` |
| integrations | 2 | `src/email/executor.ts`, `src/http/address-policy.ts` |
| workflow-engine | 11 | `src/coordinator-observations.ts`, `src/graph-scheduler.ts` |

Required work:

- Give every starting branch and every new branch in touched risk files a
  disposition. Cover reachable decisions with meaningful inputs through the
  owning interface. Prioritize email ambiguity, address rejection and scheduler
  state decisions before incidental fallback plumbing.
- Reuse `advance-workflow-branching.test.ts`, `skipped-parallel-merge.test.ts`
  and `scheduler-projection.test.ts` where they own the scheduler behavior.
  Preserve versioned semantics and independent expected results.
- Inspect V8 line-zero/generated arms using their source fingerprint and actual
  decision span. Line zero is not proof that an arm is generated or unreachable.
  Classify only with exact source reasoning and the existing manifest format.
- Link an integration-only review to an executed, source-matched named test.
  A broad “defensive” label or a test filename without the relevant assertion
  is not evidence. Do not expose private production code just to call an
  impossible branch from a test.
- Preserve strict cohorts at zero unreviewed and never raise the current
  8/1/2/11 ceilings. Ratchet ceilings downward only after stable evidence.
  Review existing exclusions for changed files; do not shrink the denominator.

Done when: no starting branch is left unaccounted for, no reachable selected
decision is waived without evidence, stale reviews fail, and the final report
distinguishes executed coverage from reviewed-but-unexecuted branches. Zero
unreviewed can be a review result; it must never be advertised as 100% execution.

## N07 — Add a real local lost-COMMIT-acknowledgement proof

Classification: a specifically documented evidence gap; not a diagnosed production bug.

Targets: `packages/database/src/tenant-access/workspace.ts`, existing attempt
transaction/completion modules, `packages/database/test/workspace-transaction-engine.test.ts`,
`test/transport.integration.test.ts`, and the owning worker integration fixture
from N02. Add narrowly scoped test support only if existing fixtures cannot
produce the failure.

Required work:

- Reuse owned local PostgreSQL and actual application roles. Build a bounded
  test-only connection/proxy fault that lets PostgreSQL commit but prevents
  the client from receiving the commit acknowledgement. A throw before COMMIT
  or a mocked `query()` rejection alone does not prove this case.
- Synchronize on the server-side commit acknowledgement or independently
  observed durable transaction result before dropping the client response.
  Keep protocol/authentication data out of logs; the proxy is disposable and
  never production code or a connection to a developer/production database.
- Through the real transaction/consumer seam, prove domain change, receipt and
  outbox either committed together or did not commit. Reconnect and inspect
  authority. Redelivery of a committed identity must be inert, not a second
  effect; a genuinely uncommitted control case must remain recoverable.
- Prove the affected connection is not returned as a healthy reusable client,
  all proxy sockets/pools close, and cancellation/stale fencing remain intact.
  Include the normal acknowledged success and pre-commit failure controls.

Done when: the test distinguishes lost acknowledgement from rollback and verifies
the durable duplicate/recovery result. If the selected local runtime cannot
produce the fault deterministically, record the precise limitation and required
test capability as a blocker; do not substitute a mock and mark this item done.
This local proof does not establish managed-service failover or regional recovery.

## N08 — Make performance measurements comparable and interference explicit

Classification: mandatory measurement refinement and comparison tooling;
optimization remains conditional on evidence.

Targets: `infrastructure/performance/{local-benchmark-manifest.json,run-local-benchmark.mjs,run-local-benchmark.test.mjs,postgres-evidence.mjs}`;
`apps/worker/test/schedule-trigger.integration.test.ts`;
`packages/database/test/workflow-authoring-publication.integration.test.ts`;
`packages/database/test/{retention-scheduling,transport}.integration.test.ts`;
their `test/support/{retention.integration.support,transport.integration.support,q11-benchmark}.ts`
owners; `docs/operations/local-performance-evidence.md`.

Required work:

1. Make every marker's start/end contract explicit. The current schedule timer
   includes due-state setup; publication timings include precondition reads.
   Separate setup from measured work, or name both intervals explicitly. For
   schedule processing, prevent the scanner from racing ahead during setup,
   verify the due fixture, then release the real scanner at the defined start
   and observe durable `run.started` at the end. Document observation/poll delay.
2. Strengthen retention/foreground evidence beyond temporal overlap. The
   retention fixture currently creates its own database while the foreground
   transport fixture uses the configured base database. Give the comparison
   participants one runner-owned database and record their database identity,
   actual role, application name, populations and intervals. Prevent either
   participant's reset/cleanup from destroying the other's data.
3. Compare foreground alone against foreground plus retention using the same
   population and database setup. Assert actual overlap and sample the actual
   target database. Do not claim a row-lock conflict merely from overlap or
   require artificial lock waits in the steady-load benchmark. Reuse a separate
   deterministic real-lock test for the legal-hold/fence correctness guarantee.
4. Add a small read-only comparator for two retained evidence files. Reject
   incompatible schema/operation contracts, manifest populations, host/runtime
   or service configuration. Compare operation latency/throughput and available
   process/SQL/pool metrics, not launcher time as application latency. A source
   fingerprint difference is expected between baseline and candidate; identify
   both rather than reject a legitimate candidate comparison.
5. Add negative comparator tests for missing markers, incompatible fixtures,
   absent required measurements and stale/partial evidence. Report variability;
   do not hide it behind a single p95. Keep existing investigation bands separate
   from ADR 015 SLOs and avoid a noisy automatic gate from one sample run.
6. Since marker/database scope changes make the old baseline non-comparable,
   version the measurement contract and create a fresh baseline with the new
   semantics. Retain old artifacts as historical. Use at least the existing
   warmup plus five measured rounds and independent repeated runs to assess
   stability before choosing an automated regression budget.
7. Optimize only a demonstrated bottleneck. Preserve real roles/RLS, query and
   pool ownership, lock order and atomicity. Any justified schema/index change
   uses a forward migration and compatibility evidence. A measured
   retain-unchanged optimization decision is acceptable.

Keep unavailable per-child heap/event-loop measurements explicitly unavailable;
do not substitute orchestrator metrics. If adding workload instrumentation,
measure its overhead and test that it does not leak secrets or alter the workload.

Done when: the corrected baseline and candidate can be compared automatically,
the eight scenarios retain their declared real operations/populations, shared
database interference is described accurately, and any optimization has valid
before/after evidence. This remains local evidence, not production capacity.

## N09 — Prove the new tests and gates are sensitive to the old failures

Classification: mandatory regression sensitivity and verification integration.

Targets: existing worker/provider/engine canaries, both runner test files,
`infrastructure/report-risk-coverage.test.mjs`, the new N07/N08 test owners,
root scripts, `.github/workflows/ci.yml`, and `docs/operations/test-confidence.md`.

Required work:

- In an owned disposable source snapshot, perturb the new composed behavior:
  map a transient provider failure back to `internal`; discard prior dispatch
  uncertainty in each control-entry path; restore close-before-cleanup in each
  CLI; remove the decisive stale-fence/duplicate protection from the selected
  N02/N07 fixture; and accept incompatible N08 evidence. Each relevant owning
  test must fail for the intended reason and pass again on unmodified source.
- Keep the working checkout intact. Do not run mutations against production,
  alter golden outputs to fit a mutation or leave mutated fixtures as evidence.
- Ensure all new unit, process and integration cases are discovered by the
  owning scripts and full local runner. Keep CI and local cohort definitions
  aligned; do not add a test that only runs through a private one-off command.
- Verify missing/failed/skipped/stale required reports fail the gate. Preserve
  legitimate named AWS exclusions and distinguish partial from full runs.
- Update test-confidence documentation with the exact composed cases and
  fault controls added, not a claim that every possible race is tested.

Done when: every selected mutation has recorded red/green evidence, no tests
are retry-masked, and a normal full local qualification executes the new proof.

## N10 — Prepare, but do not execute, external qualification

Classification: mandatory local preparation; execution separately gated as E01/Q14.

Targets: `docs/operations/{external-platform-contract,release-security-gate,regional-recovery,observability-alerts}.md`,
`infrastructure/ecs/{external-platform-contract.json,validate-external-platform-evidence.mjs}`,
and `infrastructure/exercises/README.md` plus its existing profiles.

Required work:

- Reconcile an approval packet with the existing Phase 7/Q14 criteria: AWS
  Object Lock/conditional writes in both regions, IAM/KMS/network/secret
  boundaries, image provenance and migration execution, provider test delivery,
  admitted load and alarms, failover/PITR/restore/cutover and writer fencing.
- For each exercise name its purpose, exact environment/resource selector,
  required access, synthetic data/recipients, expected mutations, cost/time
  cap, stop condition, rollback, cleanup owner, evidence artifact and approver.
  Leave unknown target identifiers and budgets explicitly unresolved; do not
  invent them or reuse customer resources.
- Specify the existing commands and evidence validators, plus the expected
  pass/fail interpretation. Distinguish repository deployment validation from
  an AWS API snapshot and from a successfully executed drill.
- Preserve original SLO/RPO/RTO definitions. A passing Docker/MinIO test or
  rendered ECS task is not external qualification.

Done locally when: the packet is complete enough for the user/operator to fill
the explicit target/approval fields and authorize E01. E01 itself remains
unexecuted until that authorization and is not marked complete by this task.

## N11 — Integrated review, truthful closeout and reassessment

Classification: mandatory final integration gate.

Required work:

- Reconcile every item and every area against its implementation record.
  Include exact tests for retained/no-code-change decisions. No absent scenario
  can disappear into a broad “all tests passed” sentence.
- Review the cumulative change against the N00 candidate, not just HEAD. In a
  dirty checkout, retain a baseline diff/snapshot so pre-existing user work is
  distinguishable. Use independent specification and implementation review
  where available; reviewers must trace final consumers, not only changed files.
- Recheck sibling paths whenever one path changes: early and heartbeat control;
  production and preview activation; buffered and logged commands; both CLI
  entrypoints; real provider classifications and the engine's pinned decision.
- Run unchanged `pnpm quality:local` after the code and checks are complete.
  Required local cohorts must all pass on stable source; no test-gate flags may
  silently skip required service cases. The runner already includes `pnpm check`,
  coverage, performance, integration/resilience/compatibility and deployment/
  image/exercise checks. Do not run overlapping coverage writers in parallel.
- Verify owned containers, volumes, ports, locks, subprocesses and test proxy
  sockets are cleaned up. Preserve unrelated resources and dirty files.
- Record final code identity, manifest/report paths, scope/denominators,
  failures/skips, residual limits and any evidence-only documentation delta
  written after the run. Any later code change requires relevant revalidation;
  report-only edits must not pretend to share the earlier full-source hash.
- Reassess all six areas with evidence. Explain remaining complexity and
  production limits. Do not award 9/10 simply because this checklist is complete.

Done when: N00–N11 have verified dispositions, mandatory deliverables are met,
independent findings are resolved or explicitly block completion, the full
local matrix passes, and external E01/Q14 is reported separately.

## Area coverage matrix

The matrix requires coverage and an explicit disposition, not edits to every
package. All paths are relative to the repository root.

| Assessed section | Required items | Evidence expected |
| --- | --- | --- |
| Naming and organization | N01, N05, N11 | Current ownership routes; one shared request vocabulary; no gratuitous renames |
| Control flow and readability | N03, N04, N11 | Explicit lifecycle/activation ordering and tested failure paths |
| Responsibilities and interfaces | N02–N05, N11 | Shared invariants have one owner; callers do not reconstruct policy |
| Runtime, data and error safety | N02, N03, N04, N07, N09 | Durable outcomes, fenced retries, owned cleanup, lost-ack recovery |
| Tests and verification | N00, N02, N06, N07, N09, N11 | Composed assertions, all branch dispositions, sensitive and executed gates |
| Performance and operations | N08, N10, N11; external E01 | Comparable local evidence; explicit production approval/evidence gap |

| Repository area | Responsible items | Required disposition |
| --- | --- | --- |
| API | N01, N05, N06, N08, N09 | Request contract locality, route/SSE protection, truthful operation markers |
| Worker | N01, N02, N04, N09 | Persisted outcomes and activation/resource ownership |
| Lifecycle command, operator command, recovery, retention apps | N01, N07–N11 | Keep narrow authority; run existing lifecycle/cleanup/recovery tests; external limits explicit |
| Artifact store | N02, N06, N08, N10 | Integrity/streaming/branch evidence; no forced rewrite of object/ledger owners |
| Contracts | N05, N06, N09 | Preserve wire schemas and built/browser exports; classify exact generated branch |
| Database | N02, N04, N07, N08 | Actual-role transaction/fence/duplicate proof and target-DB measurements |
| Integrations | N02, N06, N09 | Provider classifications, security order, ambiguity and redaction protected |
| Node SDK, node catalog, core nodes | N01, N02, N09, N11 | Existing immutable registration/compatibility/export gates remain green; no gratuitous changes |
| Workflow engine and model | N02, N06, N09 | Policy composition, scheduler decisions, identity and historical fixtures preserved |
| Queue, rate limit, observability | N02–N04, N08–N11 | Ownership, admission, abort propagation, diagnostic isolation and bounded metrics remain protected |
| Root, CI and infrastructure | N00, N03, N08–N11 | One discoverable verification path with reliable cleanup and evidence validation |
| Documentation | N00, N01, N10, N11 | One current status entrypoint; this stage's complete record; no rewritten historical conclusions |

## Verification commands

Run focused commands while working, then the complete local command at N11.
Integration commands must use the runner-owned service environment and required
flags; a suite skipped because a flag is absent is not verification.

```sh
pnpm --filter @pertexo/worker test
pnpm --filter @pertexo/integrations test
pnpm --filter @pertexo/workflow-engine test
pnpm --filter @pertexo/api test
pnpm quality:local:check
pnpm architecture:check
pnpm complexity:check
pnpm duplication:check
pnpm contracts:check
pnpm built-exports:check
pnpm coverage:risk-report
pnpm quality:local
git diff --check
```

`coverage:risk-report` requires fresh prerequisite coverage and test reports; it
does not generate their execution evidence by itself. A documentation-only
change needs targeted Prettier, `pnpm docs:check` and `git diff --check`, not a
new full service run. Use build/typecheck before consuming changed built output.

## Implementation record — maintain during execution

### N00 starting candidate

The unchanged qualification command `pnpm quality:local` passed all 20 required
cohorts from `2026-09-10T01:07:01.392Z` through
`2026-09-10T01:18:21.393Z`. Run
`2026-09-10t01-07-01-334z-3026-a7d2171f` recorded `main`, upstream
`origin/main` (ahead 1, behind 0), base
`9a09ccec09fa97215f54ed46a687cb00805dd4f6`, 194 dirty entries and the same
start/end candidate fingerprint
`befed62e477f9377d2820f67a6884c5ffcfa176370dc4b3da7189df91963c1b0`.
The manifest SHA-256 is
`50e83377bae0989c2fb89a3c59f95ef14b16cfb2dd97dd7b1be5bd8655d63d51`.
It is retained at
`coverage/local-quality/2026-09-10t01-07-01-334z-3026-a7d2171f/manifest.json`;
the manifest contains the complete tracked/untracked path inventory and exact
per-cohort results. The reconstructed baseline is retained beside it as
`baseline-source/tracked.patch` plus
`baseline-source/untracked.tar.gz` (SHA-256
`4abad1b324af144586becab354fdc222886c23fc728e90009002639d85b56395`
and
`bf920d97e5307c32513c0214e63dd8ff6cedc5da6a251318d86de69a8480f395`).
Applying both to the recorded HEAD reproduces all 194 dirty entries and the
manifest fingerprint exactly; the archive contains only the 37 non-ignored
untracked files present in that candidate.

The selected risk scope covered 130 files and 5,523 lines and classified 470
reviewed and 22 unreviewed branches. The 22 comprised artifact store 8,
contracts 1, integrations 2 and workflow engine 11. The highest current
function hotspots were workspace purge `processNext` (525 lines/45 branches),
persisted-checkpoint parsing (142/44), node-attempt input loading (264/43),
engine checkpoint matching (168/42) and node-attempt runtime construction
(193/40). Built export validation loaded 14 consumer cases. The unchanged
performance artifact SHA-256 is
`eb89dc1dd866f4dfbe958972e8bf637f85fee34a89a09bdd895278e3a3ce16c6`;
it measured the existing named populations on Apple M4, Node 24.15.0 and pnpm
11.22.0, but its schema-v2 predecessor is not comparable to N08's corrected
schema-v4 contract, so this older-format run is inventory evidence rather than
an optimization comparison.

The only exclusions were the three named AWS control-ledger cases: dual-service
append/replay/conflict/repair and primary/recovery conditional-create policy.
Cleanup passed. N00 is the pre-N-stage candidate; every later source change is
part of the final N11 candidate and will receive a separate source-stable run.

### N11 final candidate and closeout

The unchanged `pnpm quality:local` qualification command passed all 21 required
cohorts from `2026-09-10T10:48:49.348Z` through
`2026-09-10T11:01:56.897Z`. Run
`2026-09-10t10-48-49-281z-78496-16f7e49b` recorded the same HEAD as N00,
250 dirty entries including 41 untracked files, and the same start/end candidate
fingerprint
`4312c2f3c166b44673ad2ed436791f6d90ea4add007d76c55ec62d0ed49680e2`.
Its manifest is retained at
`coverage/local-quality/2026-09-10t10-48-49-281z-78496-16f7e49b/manifest.json`
with SHA-256
`07508491fa11ecb495487e85665f1949fc81ec9ff1bdf760df994a78d6cb4dff`.
The quality cohort passed lint, format, builds, typechecks, contracts, architecture,
complexity, duplication, exports and 2,463 unit/component tests. The ten
report-bearing service cohorts recorded 519 passing assertions out of 522; the
other three are the explicit AWS-only control-ledger exclusions, not local
passes. Coverage classified 476 reviewed and zero unreviewed branches across
the unchanged 130-file / 5,523-line risk scope.

The same run executed all seven diagnostic-bound mutation red/green pairs; its
mutation log SHA-256 is
`c5af5207ac4ab4ac2ed720e04dea9b57a91f84e2777e5bb7bd7d465994b6084c`.
The schema-v4 performance artifact passed eight scenarios with one warmup and
five measured rounds on the recorded Apple M4 / Node 24.15.0 environment. Its
SHA-256 is
`6d07634a52825778e3a163fbbef69b7cd00f2c84cca9262dd0cfb087abc31a68`;
foreground-acceptance p95 was 74.63 ms alone and 83.55 ms with overlapping
retention work, a 1.12× ratio without a claimed row-lock bottleneck. Its
database-OID-scoped workload counters recorded 1,836 calls / 209.58 ms across
25 target samples for the control and 2,544 calls / 439.96 ms across 28 target
samples for contention, while the base-database sampler recorded zero workload
calls in both cases. Deployment, image and exercise contracts passed. Cleanup
passed, and post-run inventory found no runner-named process, container, volume,
network, lock or proxy socket.

This run supersedes the earlier `2026-09-10t10-01-35-774z-86570-bdc54e1b`
schema-v4 closeout and the still earlier
`2026-09-10t06-02-18-838z-20771-9c30b0c4` schema-v3 closeout. Both predate the
final runner and comparator integrity corrections and are not evidence for the
current candidate.

The retained N00 patch/archive reconstructs the 194-entry starting candidate
exactly, while the final manifest inventories the 250-entry final code candidate;
therefore pre-existing work and N-stage changes remain distinguishable despite
sharing HEAD. The N11 record, corresponding implementation-progress update and
corrected local-performance evidence narrative are evidence-only documentation
edits made after the full run. They do not pretend to share its source
fingerprint and receive the targeted documentation and diff checks required for
report-only changes.

| ID | Status | Change or reviewed retention | Tests / candidate / evidence | Remaining blocker |
| --- | --- | --- | --- | --- |
| N00 | verified | Froze the complete dirty candidate and measured its current coverage, complexity, exports, operation populations and exclusions without source edits | Full 20-cohort run and source-stable manifest above | None |
| N01 | verified | Added one behavior-to-owner route map, canonical request-type ownership and explicit retained naming exceptions; no symbols needed renaming and no public export was added | `pnpm docs:check`; `pnpm architecture:check`; `pnpm built-exports:check`; `git diff --check` | None |
| N02 | verified | Extended the existing real worker/PostgreSQL/queue fixture across transient pre-dispatch resolution, internal failure, HTTP/Slack rotation fences, keyed email ambiguity, both durable cancellation/deadline entry points, heartbeat ownership loss, stale completion, exact redelivery, logical retry and operator replay. The composed recovery case exposed a real reclaim inconsistency; forward migration `0086_operator_attempt_reclaim_state.sql` now atomically returns the owning current node to `ready` only for a newly reclaimed attempt, while exact command replay stays inert. No policy version, status vocabulary or generic provider framework was added | Worker and database test typechecks passed; migration/readiness contract tests passed; all 16 composed `http-node-attempt.integration.test.ts` cases passed against disposable PostgreSQL 18 plus the real queue/runtime seam. Assertions cover provider-call counts, durable attempt/node/run truth, dispatch evidence, fences, receipts/outboxes, pinned retry disposition, stable retry keys and distinct replay run/key identity | Source-run terminalization in the replay-identity setup uses the established owner fixture because this two-node scenario deliberately has no external trigger-terminal event; replay admission and both source/replay provider identities still come from the production persistence/coordinator paths |
| N03 | verified | Added the infrastructure-local `runManagedCommand` lifecycle contract beside `OwnedProcessSupervisor`; both the quality runner (buffered prerequisite capture and live logged commands) and benchmark runner now delegate spawn, exit-before-close ordering, descendant release, failed-release pipe escape and combined command/cleanup errors to it. The managed command also owns stdout/stderr error listeners and converts repeated stream errors or consumer-callback throws into the same awaited command failure, so output errors cannot escape as uncaught process events. Caller-specific evidence-log finalization and benchmark process-group sampling remain explicit. The two duplicate lifecycle algorithms and quality-only fallback helpers were removed | Both real runner suites pass (39 tests), including repeated stdout and stderr `error` events, success/nonzero exit, spawn failure in each consumer, inherited-pipe tails, SIGINT and SIGTERM in prerequisite and active quality workloads, standalone benchmark termination isolation, failed termination/retry ownership, combined failures, partial database construction cleanup, database cleanup aggregation and late log failure. With the 17 comparator cases, the focused infrastructure run passes 56 tests; focused ESLint and `git diff --check` pass | Signal dispatch and process-group sampling remain runner orchestration concerns; presentation/log failures remain with the quality consumer, as required by the intentionally small shared contract |
| N04 | verified | Added an executable disabled/production/preview/both activation descriptor and passed `productionEnabled` into the shared runtime. Preview-only mode now constructs only preview policy/resources and the one shared consumer, even under an HTTP-capable cohort. Runtime ownership is centralized in one named list: transferred preview store/invoker and injected production close-capable ports are owned when selected; injected capability factories are borrowed; internally created capabilities/evaluator and the consumer are owned. Final review caught that starting every close concurrently did not actually enforce consumer-first drain. The list now has an explicit drain phase: the shared consumer must settle before all remaining independent owners release concurrently; close stays idempotent, drain/release failures aggregate, and startup preserves the primary failure. Provider ownership transfers once at the runtime boundary and handles the sole pre-transfer invoker-factory failure itself | Worker test typecheck passed; 74 focused runtime/bootstrap/preview tests passed; the real preview-only PostgreSQL/BullMQ delivery and exact duplicate integration passed. The strengthened shutdown test holds consumer close pending and proves the run store cannot begin close, then rejects both and observes the ordered aggregate exactly once; all 24 runtime tests and focused ESLint pass after the final-review correction. Executed cases cover all four modes, disabled/external/injected gates, production HTTP capability fail-closed behavior, preview override/fallback, capability and consumer construction failures, pre-transfer invoker plus store-close failure, repeated close and multiple close failures | Production and preview handlers remain separate policies routed by one consumer. Registry/engine objects expose no close contract; readiness remains owned only by the internally created capability runtime. Existing preview crash/reconciliation state machines were unchanged |
| N05 | verified | `IdentityWorkspaceRequest` now owns every shared authenticated HTTP field and readonly `AuthenticatedRequestSession` owns the session shape. `WorkflowAuthoringRequest` is a readonly `Pick` that deliberately omits reauthorization; `WorkflowRunsRequest` is a readonly `Pick` that retains reauthorization plus its explicit close-listener socket extension. Existing connection/artifact/webhook extensions remain feature-local | API test typecheck passed; compile-time exact-equality assertions plus workflow-authoring controller, workflow-runs controller, SSE transport and run use-case suites passed (55 tests). Architecture checks and focused ESLint passed; generated OpenAPI artifacts were unchanged | The mutable request container remains necessary for guards/interceptors to attach the canonical session, workspace authorization and request identifiers; readonly feature projections preserve controller-side non-mutation without changing that framework seam |
| N06 | verified | Resolved all 22 starting branches: 16 reachable decisions now execute through owning tests (artifact download/error/dual-region symmetry, matching contract metadata, invalid address rejection, email historical ambiguity and scheduler state/scope decisions); six invariant-only arms have exact source-bound unreachable reviews. No denominator or ceiling changed | Artifact store 221, contracts 50, integrations 249 and workflow engine 304 coverage tests passed; `coverage:risk-report` passed 13/13 and records 476 reviewed, 0 unreviewed across the unchanged 130 files/5,523 lines | None; reviewed-but-unexecuted branches remain labeled as such rather than 100% execution |
| N07 | verified | Added a test-only loopback PostgreSQL wire proxy that arms for one simple-query COMMIT, withholds all reply frames, waits for the server ReadyForQuery acknowledgement, then drops only that client. The real API-role inbox transaction proves domain acceptance, completed receipt and outbox commit together; reconnect/redelivery is inert. Normal commit and pre-COMMIT rollback/recovery controls use the same proxy. The broken client is destroyed, a fresh connection is observed, and pool/proxy sockets close | Database test typecheck and focused real-PostgreSQL transport integration passed against an owned disposable PostgreSQL 18 service; existing node-attempt stale-fence/cancellation integration remains the owning execution-state proof and is included in N02/final qualification | Managed failover/regional behavior remains E01; this local protocol fault makes no such claim |
| N08 | verified | Versioned marker/evidence semantics to schema v4 with explicit boundaries and database scopes; moved publication precondition reads and schedule due-state setup outside measured work; gated the real scanner until verified due state; added a same-population foreground-only control; and gave every runner-owned workload a disposable target database with ordered target sampling/teardown and database-OID-scoped SQL/activity evidence. Fixture databases keep the sampler and extension while their application schemas reset before every warmup/measured command, preserving pristine fixture state. The strict comparator validates nonempty identities, the complete host/runtime/service environment, exact raw measured rounds, raw-to-summary derivations, participant intervals and target observations; it requires positive base SQL only for configured-base scenarios, while runner-owned fixture/shared scenarios may have a zero base only with a well-formed, positive target block. Repeated evidence showed interference but no specific schema/index bottleneck, so runtime code is retained and no noisy gate was added | Comparator/runner suites pass 37 tests; the full focused infrastructure set passes 56. Independent one-warmup/five-round schema-v4 runs `2026-09-10t10-40-37-371z-44959-9ab88dfa` and `2026-09-10t10-43-03-584z-60827-22dc963f` share source `64e86fd9…`, manifest `e1d84678…`, passed both self comparisons and cross comparison, and record target calls of webhook 17,700 / 17,700, schedule 20,710 / 20,704, bounded-loop 12,732 / 12,732, foreground 1,836 / 1,836 and contention 2,544 / 2,544 while their base sampler records zero. Configured-base scenarios record positive totals. Earlier 09:53/09:56 schema-v4 and all schema-v3 artifacts are explicitly superseded for comparison | Five-round p95 variability remains too noisy for an automated budget. Evidence is local, not production capacity; ADR 015 and E01 remain external |
| N09 | verified | Added `mutation:check`, an owned exact-candidate snapshot verifier, and made it a required full-run/CI cohort. It applies seven sequential, retry-disabled faults covering transient provider classification, the shared early/heartbeat dispatch-uncertainty decision, both CLI cleanup consumers, a fence-only stale completion, lost-COMMIT inbox replay and benchmark compatibility; every mutated owning command must be red with its named scenario and mutation-specific diagnostic before byte restoration/rebuild and the same command turns green. The original N02 stale case was not decisive when the attempt was also inactive, so a real PostgreSQL canary now changes only `fence_token` and proves no completion mutation | Static mutation-definition tests pass. Stable partial run `2026-09-10t04-44-48-137z-58584-6022c3f9` passed service setup, migration, all seven diagnostic-bound red/green pairs, 43 worker integration tests and cleanup on source fingerprint `37e30b7d…`; manifest `32e595aa…`, mutation log `3d20063a…`. Red durations were 72 ms–5.875 s and restored-green 63 ms–5.299 s. Database test typecheck and focused ESLint pass. The manifest marks all unselected cohorts skipped, so it is evidence for N09/N02 only; N11 reruns it in the required full matrix | None; the proof claims sensitivity for these seven selected faults, not every race |
| N10 | verified locally; external execution not authorized | Added one fillable E01/Q14 approval packet with release-wide identity, synthetic-data, budget/window, owner, evidence and approval fields plus E01-01 through E01-15 dispositions for AWS snapshot/deployment, dual-region Object Lock/conditional writes, IAM/KMS/network/secrets, real controlled provider delivery, admitted load/fairness/autoscaling, five failure exercises, pager routing, migration/rollback, PITR, regional restore/cutover and retention/deletion/purge lifecycle. Every drill now requires the authenticated operator identity and exact versioned command/automation record. Cross-linked release, recovery, observability and exercise runbooks; preserved ADR 015's five-minute RPO/24-hour RTO and the existing contract/validator instead of pretending its AWS read snapshot proves a drill | `docs:check` passed 13 tests and 378 links; `deployment:check` passed 30 tests plus runtime typecheck, executable contract validation and deterministic rendering; `exercise:check` validated all six profiles and passed seven runner-policy tests. The packet names the existing repository commands and distinguishes repository validation, a fresh normalized AWS-API snapshot and successful drill evidence. All account/resource IDs, recipients, external driver commands, spend/repetition caps, people and evidence destination remain explicitly `[UNRESOLVED]` | E01/Q14 remains not run and unauthorized; an operator must fill all applicable fields and obtain the listed approvals before external mutation |
| N11 | verified locally | Reconciled every N00–N10 disposition and all six assessed areas against the retained N00 candidate; traced sibling provider/control, activation, command and CLI paths; completed independent specification and engineering reviews; and ran the unchanged full qualification on a source-stable final code candidate with owned cleanup | Final 21-cohort manifest and hashes above; 2,463 unit/component tests; 519/522 report-bearing service assertions with only three named AWS skips; 476 reviewed/0 unreviewed risk branches; seven mutation pairs; eight five-round performance scenarios; deployment/image/exercise checks; post-run resource inventory; targeted closeout-doc checks | No local blocker. Remaining large but ratcheted complexity, noisy local performance and all production/provider evidence are explicit limits; E01/Q14 remains separate and unauthorized |
| E01 / Q14 | not authorized | External execution only | — | User/operator environment, scope and budget approval |

### Final six-area reassessment

The overall qualitative assessment remains **8/10**. Local evidence is materially
stronger, but finishing this checklist does not erase retained complexity or
turn a disposable local environment into production proof.

| Assessed section | Status | Reassessment and residual limit |
| --- | --- | --- |
| Naming and organization | verified (8/10) | The behavior-to-owner map and shared authenticated-request vocabulary make current seams navigable without compatibility-breaking renames. The repository is still broad, so the map and package boundaries remain necessary orientation aids. |
| Control flow and readability | verified (8/10) | Process termination, activation, drain and release ordering are explicit and failure-tested. Existing ratcheted hotspots remain, led by workspace purge `processNext` at 525 lines / 45 branches and persisted-checkpoint parsing at 142 / 44; neither was rewritten without evidence. |
| Responsibilities and interfaces | verified (8/10) | Provider decisions, request fields, runtime resource ownership and subprocess cleanup each have one narrow owner, with callers no longer rebuilding those policies. Deliberately separate production/preview policies and runner presentation concerns remain separate rather than hidden behind a generic framework. |
| Runtime, data and error safety | verified locally (8/10) | Real PostgreSQL, BullMQ, provider, cancellation/deadline, fence, lost-COMMIT and cleanup cases protect durable truth, including the repaired reclaim transition. AWS Object Lock, real provider delivery, regional failover and deployed IAM/KMS behavior remain E01 rather than inferred safety. |
| Tests and verification | verified locally (9/10) | The stable 21-cohort run, zero-unreviewed risk inventory, exact built exports, seven mutation canaries and independent reviews provide strong local sensitivity. Mutation claims remain limited to the seven selected faults, and three AWS-only assertions remain explicit skips. |
| Performance and operations | verified locally (8/10) | Schema-v4 evidence fixes measured boundaries, population identity, target PostgreSQL observations and foreground/maintenance overlap. Five-round variability remains too noisy for an automated budget, and capacity, autoscaling, pager, RPO/RTO and regional behavior require separately authorized production evidence. |

For each item append: original friction/gap; existing coverage reused; exact
change or justified retention; removed predecessor path; every acceptance case
and its test/result; source identity; metrics/scope changes; rollback impact;
and residual limitations. A retained design can satisfy a conditional extraction,
but cannot satisfy missing mandatory evidence.

At every checkpoint report all assessed sections with `pending`, `in progress`,
`verified` or `blocked`, the completed item IDs, and what remains. At final handoff
include the same complete matrix, local versus external completion, all unresolved
findings, verification results, commits/pushes if separately authorized, branch/
upstream and remaining uncommitted changes. Do not report only the sections that
improved.

## Copyable implementation instruction

> Read `AGENTS.md`, the current quality plan, and this entire next-stage plan.
> Implement all mandatory local work in N00–N11, in dependency order. Maintain
> the implementation record and account for every acceptance case and assessed
> area; do not stop after fixing a subset. Reuse existing evidence only when it
> proves the exact required behavior on the identified candidate. Preserve the
> completed Q01–Q13 fixes and settled architecture. Conditional refactors require
> the stated design/characterization evidence even if retained unchanged. Never
> weaken tests, contracts or thresholds to pass. Continue independent local
> work while possible; explicitly record real blockers rather than mark them
> complete. Run the full source-stable local qualification before closeout.
> Prepare N10's external approval packet, but do not execute E01/Q14, deploy,
> send provider messages, spend money, commit or push without separate explicit
> authorization. Report every section's final disposition, remaining risks and
> the exact verification evidence.
