# Backend quality improvement plan

Date: 2026-09-10. Status: Q01–Q13 complete locally. Q14 remains separate and
unauthorized.

Further improvements are being implemented through the
[next-stage implementation plan](backend-quality-next-stage-plan.md).
That stage does not reopen the closed Q01–Q13
remediation or authorize Q14 execution.

## Purpose and authority

Improve correctness confidence, maintainability, test value and operational
evidence across the existing backend. This is a follow-up to the
[package-by-package audit](package-by-package-coding-audit.md), not a new list
of confirmed defects or a request to rewrite every package.

The original whole-backend assessment was 7/10. The final Q13 reassessment
rates the current local candidate at 8/10 after the follow-up fixes,
source-stable full qualification and two clean independent re-reviews. Local
proof cannot close the Q14 external guarantees.

The reviewed remediation is uncommitted on `main`, based on
`9a09ccec09fa97215f54ed46a687cb00805dd4f6`. Its 21 items—WB-01–10, MC-01–05,
TQ-01–05 and MH-01—are implemented. Do not reopen or implement them again.
The latest recheck passed 2,435 unit/component tests, 491 local integration,
resilience and compatibility tests, coverage gates and deployment checks.
Three AWS-only tests remain unexecuted. These are revision-bound observations,
not promised future test counts or production qualification.

Use the existing [backend blueprint](workflow-platform-backend-plan.md),
[domain vocabulary](../CONTEXT.md), accepted ADRs and public contracts as
authority. This quality plan does not replace feature checkpoints or reopen
PostgreSQL authority, RLS, immutable execution identity, BullMQ transport,
NestJS, the TypeScript build, or the chosen hosting architecture.

Current supporting evidence is organized through the
[local qualification runbook](operations/local-quality-verification.md),
[test-confidence policy](operations/test-confidence.md),
[local performance record](operations/local-performance-evidence.md),
[compatibility retirement inventory](operations/compatibility-retirement-inventory.md),
and the accepted [failure-notification decision](adr/022-run-failure-notification.md).
This plan remains the single current status and disposition entrypoint; those
documents own their narrower operational contracts.

This document is the only new artifact authorized by the planning request.
Implementation, commits, pushes, deployments, paid services and destructive
drills require subsequent authorization. Keep existing dirty work intact.
Update `implementation-progress.md` only if subsequent work changes its claims
or implements an authoritative backend checkpoint. Create or amend an ADR
before a genuinely architectural decision, not for routine tests or refactors.

## Classification and working rules

- **Evidence gap:** a guarantee needs stronger or more reproducible proof; this
  does not mean the implementation is known to be wrong.
- **Observed friction:** current ownership or structure makes changes difficult;
  the proposed extraction still needs a design check.
- **Conditional improvement:** inspect or measure first; make a change only if
  it demonstrates a benefit. A supported “retain unchanged” is a valid outcome.
- **External qualification:** requires an explicitly approved environment and
  cannot be closed by local mocks or configuration validation.

Before adding a test, map existing assertions to the proposed scenario. Extend
the owning suite rather than duplicate a complete matrix. Before extracting a
module, identify what callers no longer need to know and which old path is
removed. Keep atomic operations, lock order and cleanup ownership visible.
Do not introduce generic repositories, generic command frameworks, redundant
validation layers, one-function-per-file rules, blanket renaming or a new test
framework solely to improve a score.

## Execution order

| Wave | Work | Dependency / exit |
| --- | --- | --- |
| 0 | Q01 evidence baseline; Q02 repeatable verification | Stable candidate identity and reliable local evidence |
| 1 | Q03 notification compatibility; Q04 failure-path coverage; Q05 test sensitivity | Q01; Q04/Q05 can proceed independently by package |
| 2 | Q06 API/worker ownership; Q07 connection persistence; Q08 destructive orchestration | Characterization from Wave 1; one owner for cross-package invariants |
| 3 | Q09 execution/model contracts; Q10 transport/provider/diagnostic composition | Q01 and relevant Wave 1 evidence; may overlap independent Wave 2 work |
| 4 | Q11 performance baseline and conditional optimization; Q12 gate calibration and documentation | Measure before structural changes where a baseline comparison is needed; finalize after changes |
| 5 | Q13 independent integrated review | All mandatory local work has a recorded disposition |
| Separate | Q14 AWS/provider/operational qualification | Explicit environment, budget and drill authorization; existing Phase 7 authority |

These are coherent workstreams, not a fixed commit count. When commits are
authorized, use reviewable behavior-plus-tests or behavior-preserving refactor
boundaries. A schema change needs its own forward migration and compatibility
evidence. Never commit a broken intermediate checkpoint.

## Detailed work packages

### Q01 — Establish a truthful post-remediation baseline

Classification: evidence gap / documentation. Priority: first. Size: small.

Targets: this plan, `docs/package-by-package-coding-audit.md`,
`docs/current-implementation-status.md`, `docs/codebase-map.md`, and existing
coverage/report artifacts.

1. Record the exact candidate commit when available. Until then, record HEAD,
   tracked changes and content hashes for relevant untracked files; do not label
   HEAD alone as the reviewed implementation.
2. Keep the historical 7/10 narrative explicitly historical. Add a concise
   post-remediation entry instead of making baseline findings appear current.
3. Reconcile the closeout's 23 unreviewed branches against the latest report's
   22. Determine whether this is run variation or stale evidence; attach the
   run identity rather than blindly overwriting a historical measurement.
4. Map each Q item to an existing finding, remaining evidence limit or explicitly
   conditional proposal. Maintain status and concrete evidence here.

Done when: a reader can identify what is fixed, what remains unverified, the
exact reviewed candidate and why each proposed task exists. Documentation and
link checks pass. No historical measurement is presented as newly executed.

### Q02 — Make the full local verification reproducible and isolated

Classification: observed verification friction. Priority: first. Size: medium.

Targets: root `package.json`, `.github/workflows/ci.yml`, `compose.yaml`, existing
Vitest coverage configurations and `infrastructure/report-risk-coverage.mjs`.

The recent check needed an isolated local service setup to enable all applicable
integration cohorts. Concurrent review runs also collided in `coverage/worker`.
Neither observation is a production-runtime defect.

1. Inventory CI's actual services, environment flags, migration/bootstrap steps
   and specialized suites. Reuse this contract in a documented local entrypoint;
   do not create a second silently divergent environment definition.
2. Use a unique Compose project and validated available ports, with owned
   temporary storage. Cleanup must target only resources created by that run.
3. Either isolate each run's coverage/results directory end to end or reject
   concurrent writers with a clear diagnostic. Select one approach after
   checking all report consumers; no partially isolated output paths.
4. Produce a manifest of expected cohorts and passed/failed/skipped status.
   Missing local service flags must fail a qualification run, not yield a
   misleading green all-skipped suite. Keep exploratory partial runs available
   and visibly labeled.
5. Include specialized SSE resilience, worker transport resilience and
   compatibility rollout; identify AWS-only exclusions by name and reason.

Done when: a documented command runs from a built checkout without relying on
the user's existing services, cleans up after success/failure, and retains
source-bound results. Two concurrent invocations are isolated or explicitly
refused. Negative tests cover missing prerequisites and incomplete results.

### Q03 — Prove notification-context rolling compatibility

Classification: evidence gap. Priority: before deploying the new context.
Size: medium, potentially larger if activation requires a contract change.

Targets: ADR 022, `packages/workflow-model/src/failure-notification.ts`, database
terminal-intent persistence, worker notification loading/delivery,
`apps/api/test/platform/compatibility-rollout.integration.test.ts`, and
`docs/operations/compatibility-retirement-inventory.md`.

The new reader accepts old node-shaped contexts; the predecessor strict V1
reader rejects the new run-shaped context. This is a concrete rollout constraint,
not a claim that a deployed failure has occurred. The existing generic rollout
test passing is not specific evidence for this transition.

1. Pin predecessor and candidate reader fixtures; test old context/new reader,
   new context/new reader and new context/old reader explicitly.
2. Trace the actual producer and consumer fleet roles. Verify how ADR 022's
   readiness-advertised activation prevents an unsupported consumer receiving
   a run-shaped context. Do not assume “deploy workers first” is sufficient if
   workers also produce contexts during the same rolling deployment.
3. If the activation path does not establish this property, document and decide
   the smallest supported additive rollout protocol before implementation.
   Consider reader-first activation using existing release machinery; do not
   casually rename the schema or relax strict parsing.
4. Exercise queued timeout, durable intent/outbox creation, old/new fleet
   overlap, redelivery, restart and rollback with pending contexts. Preserve
   exactly one logical notification intent and independent terminal run truth.

Done when: the supported rollout and rollback sequence has an executable
regression; unsupported combinations fail closed without silently losing work;
retained contexts remain readable. Any deployment restriction is explicit in
the operational inventory. Local proof is not a deployed-drill claim.

### Q04 — Close high-consequence evidence gaps by behavior

Classification: evidence gap. Priority: high. Size: large, split by owner.

Targets: API identity/OIDC/authoring/bootstrap suites; worker attempt/preview
and process lifecycle suites; database integration coverage; operator,
recovery and retention application tests; existing risk-review manifest.

1. Build a behavior-to-test map for authorization loss, aborted external work,
   failed initialization, failed shutdown, exhausted pool, stale lease,
   duplicate delivery, ambiguous dispatch and transaction rollback.
2. Identify which scenarios already have direct, composed, process or real
   PostgreSQL evidence. Record missing combinations, not just missing lines.
3. Expand selected-file instrumentation in small cohorts only where it reveals
   actionable risk. Start with currently unmeasured identity/OIDC/authoring
   orchestration and bootstrap; retain process tests for executable entrypoints.
4. For each remaining reviewed-uncovered branch, choose an executable test,
   verified integration evidence, or a narrow justified exception. Do not turn
   all 468 reviewed branches into a blind test quota.
5. Exercise cancellation at acquisition, in-flight work, pre-dispatch,
   post-dispatch, commit and cleanup as applicable. Assert resource release,
   durable state and safe retry classification—not only a rejected promise.

Done when: selected high-consequence behaviors have fault-detecting evidence;
all newly selected branches satisfy the owning cohort policy; excluded and
unexecuted surfaces remain visible. No global 100% requirement, threshold
reduction, automatic retry masking or duplicate mock-only integration claims.

### Q05 — Verify tests detect policy regressions

Classification: conditional assurance. Priority: after Q04 inventory.
Size: medium.

Targets: existing transition, retry, workspace-capability and dispatch-fence
canaries named in `docs/operations/test-confidence.md`; image/import/evidence
validators; newly added lifecycle and header regressions.

1. Inventory existing mutation canaries before adding another framework.
2. In an isolated test fixture or disposable checkout, demonstrate that removing
   an own-property guard, abort handoff, fence check, authorization check or
   provider ambiguity distinction causes the corresponding test to fail.
3. Add targeted perturbations only for uncovered high-consequence decisions.
   Include a deliberately malformed contract and false/missing report evidence.
4. Classify equivalent or unreachable mutations honestly. Fix weak assertions;
   do not optimize for a repository-wide mutation percentage.
5. Remove an old test only when a named replacement preserves its meaningful
   assertion and has demonstrated sensitivity to the relevant fault.

Done when: every selected canary has an expected failure and a green restored
baseline, with no deliberate mutation left in the user's checkout. Test count
reduction is optional; maintained fault detection is mandatory.

### Q06 — Simplify API and worker composition where it pays off

Classification: conditional structural improvement. Priority: medium.
Size: medium per independently justified extraction.

Targets: `apps/api/src/app.ts`, `apps/api/src/platform/workflow/`, feature use
cases, `apps/worker/src/execution/node-runtime-capabilities.ts`, attempt/preview
handlers and worker runtime composition.

1. Trace construction, ownership, cancellation and cleanup for each external
   resource. Start from the existing MC-01/02/03 cleanup; do not reintroduce
   duplicate providers or another dependency container.
2. Identify any remaining repeated policy or HTTP knowledge in application
   commands. Keep Nest controllers/guards as transport adapters, and preserve
   request-bound authorization and current error semantics.
3. Extract only cohesive private behavior that hides repeated knowledge from
   real callers. Keep one lifecycle owner; compare keeping a linear function
   against extraction before changing it.
4. Preserve pre-/post-dispatch distinctions, completed replay behavior and
   shutdown ordering. Use composed routing and deferred-work/process tests.

Done when: each change reduces caller knowledge or duplicated policy, removes
its predecessor path and passes owning behavioral suites. If extraction merely
adds forwarding layers, retain the current design and record that decision.

### Q07 — Clarify connection persistence without splitting transactions

Classification: observed density / conditional design. Priority: medium.
Size: medium.

Targets: `packages/database/src/connections/connection-persistence.ts`, existing
management/secret/test/resolution/health persistence modules and role-specific
exported contracts, including consumers through `connections.ts` and `testing.ts`.

1. Inventory existing role-specific projections and actual consumers. The
   current modules already separate capabilities; do not reconstruct them.
2. Distinguish shared domain contracts, row decoding, transaction helpers and
   factory composition still colocated in the dense shared file.
3. Compare retaining that file with moving genuinely shared neutral contracts
   or pure row decoding to feature-local leaves. Select only a measurable
   locality improvement; retain role-specific interfaces and public exports.
4. Preserve secret-version pinning, conditional writes, idempotency hashes,
   lease/dispatch markers and pool ownership. SQL ordering is not an incidental
   detail that a generic helper may rearrange.

Done when: consumers depend on the smallest existing capability they use, no
root/child type cycle is introduced, and connection compatibility/concurrency,
secret rotation, stale completion and cross-workspace tests pass on PostgreSQL.

### Q08 — Make destructive and coordinator orchestration easier to inspect

Classification: observed density / conditional design. Priority: medium-high
because of consequence, not a claim of a newly found deletion bug. Size: large;
one hotspot per reviewable change.

Targets: `packages/database/src/lifecycle/workspace-purge.ts`,
`control-ledger-coordinator.ts`, existing retention capabilities,
`packages/artifact-store/src/control-ledger.ts`, and database coordinator
observation/commit modules. Physical object-version/delete-marker I/O belongs to
`packages/artifact-store/src/store.ts` and `dual-region-artifact-store.ts`;
include these owners when tracing purge behavior, not just ledger reconciliation.

1. Reconcile current symbols with `infrastructure/complexity-baseline.json`.
   Historical line counts are not current measurements. MC-04's completed
   retention composition must remain intact.
2. Write a short stage/ownership table for a selected operation: claim, locked
   observation, external I/O, fence revalidation, commit, release/retry.
3. Characterize hold arrival, stale fences, contention, partial external
   deletion, restart and cancellation through the public operation before
   extraction. Reuse current purge/legal-hold/recovery tests wherever possible.
   Include hold arrival during deletion, stale step leases, ambiguous dual-region
   deletion, checkpoint retry, cancellation during advisory-lock acquisition and
   concurrent claim/release; identify missing combinations rather than duplicate
   already-covered individual cases.
4. Consider private pure page validation or observation decoding first.
   Keep transaction-spanning orchestration visible and pass the already-owned
   client into helpers; do not acquire additional pools inside a transaction.
5. Preserve advisory-lock lifetime, SQL lock order, rollback/destroy behavior,
   immutable ledger high-water verification and bounded paging. Keep app-level
   retention thin; do not duplicate database policy there.
   Workspace purge retains its session advisory lock across external I/O without
   holding a PostgreSQL transaction open. Preserve both properties and the
   regression that checks transaction lifetime while object erasure is delayed.

Done when: reviewers can trace authority and cleanup in one owner, retained
tests prove the same durable outcomes, and query count/pool demand do not grow.
Remove a complexity allowance only when genuinely no longer needed. A retained
state machine with explicit reasoning is preferable to fragmentation.

### Q09 — Strengthen execution and public-contract composition

Classification: conditional assurance. Priority: medium. Size: medium.

Targets: `packages/workflow-model`, `packages/workflow-engine`,
`packages/contracts`, `packages/node-sdk`, `packages/node-catalog`,
`packages/nodes-core`, and their API/database/worker consumers.

1. Map valid terminal/checkpoint shapes to persistence and rendering consumers.
   Use the repaired node-free timeout as the pattern for cross-package tests,
   not as a reason to loosen schemas everywhere.
2. Reuse independent golden identities and public registration inventories for
   old/new executable, checkpoint and node releases. Cover replay after restart,
   cancellation, bounded loops, branch failure and wait recovery where the
   existing matrix lacks a consumer-level assertion.
3. Extend runtime/OpenAPI acceptance parity across required headers, duplicate
   values, safe errors and response shapes using actual composed routes.
   Generated output matching its source is necessary but not independent proof
   that either is correct.
4. Preserve browser/server export checks and immutable version behavior. Do not
   deduplicate historical node implementations or regenerate expected golden
   fingerprints from the implementation under test.
5. Check whether the existing gates exercise built package exports as well as
   source imports. If not, add a small built-output consumer fixture using the
   actual browser/server export conditions; avoid introducing a frontend app
   or new bundler solely for this check.

Done when: every newly selected case is checked across its real consumer seam,
contract generation remains deterministic and compatibility fixtures remain
independent. No gratuitous production edit is required in already cohesive
catalog, SDK or model modules.

### Q10 — Prove transport, provider and diagnostic failure composition

Classification: conditional assurance. Priority: medium. Size: medium.

Targets: `packages/queue`, `packages/integrations`, `packages/artifact-store`,
`packages/observability`, `packages/rate-limit` and their app-level consumers.

1. Map existing outage/abort/retry suites, then add only missing composed cases:
   Redis loss during active delivery, shutdown during external work, diagnostic
   failure during error handling and limiter unavailability at a real route.
2. Assert PostgreSQL remains execution authority, duplicate delivery does not
   duplicate durable intent, and unsafe ambiguous provider calls are not
   silently retried as definitely unsent.
3. Verify secret/plaintext cleanup, bounded bodies, same-origin exercise inputs,
   label cardinality and redaction at consumers as well as adapter tests.
4. Preserve the deliberately linear SSRF/DNS/TLS/redirect validation order.
   Share test setup where useful, but not independent security checks across
   trust levels merely because they look alike.

Done when: each selected failure has an observable safe result, bounded cleanup
and an appropriate recovery/retry decision. Local provider fixtures remain
explicitly distinct from live Slack/email/AWS success evidence.

### Q11 — Establish performance evidence before optimizing

Classification: evidence gap, followed by conditional optimization.
Priority: establish baseline early; optimize only after measurement. Size: large.

Targets: existing `infrastructure/exercises`, API/worker telemetry, database
admission/dispatch/coordinator/retention queries and the existing complexity
performance comparison. Reuse ADR 015 objectives; do not invent new SLOs.

1. Record hardware, runtime, database size, pool/task counts, warmup, concurrency,
   workload seeds and repeated-run variability. The historical package-test
   timing comparison is not a production latency benchmark.
2. Exercise representative authoring/publication, API/webhook admission,
   schedule-to-start, event visibility, large bounded loops, artifact streaming
   and retention competing with foreground work.
3. Capture latency distributions, throughput, RSS/heap trend, event-loop lag,
   SQL round trips, pool checkout wait and lock wait. Compare baseline and
   candidate using the same environment and fixture populations.
4. Inspect query plans on disposable representative data only. Run mutating
   `EXPLAIN ANALYZE` inside an appropriately isolated test, never casually on
   production. Preserve RLS and actual runtime-role behavior in measurements.
   Include retention keyset scans, `execute_workspace_tenant_rows_page`, purge
   discovery/claim/checkpoint and artifact-version listing; collect buffers and
   lock observations where applicable, preserving FK/replay-lineage ordering.
5. Optimize the demonstrated bottleneck only. Require forward migrations for
   indexes/schema changes, compatibility tests and unchanged fencing/ordering.
   Set regression budgets from stable measured variation before gating them.

Done when: repeatable local measurements expose bottlenecks and regression
budgets; any optimization has before/after evidence without correctness loss.
Capacity, availability and regional RPO/RTO remain externally qualified facts,
not conclusions drawn from a laptop benchmark.

### Q12 — Calibrate ratchets and make current evidence easy to find

Classification: observed policy headroom / documentation. Priority: after
stable measurements. Size: small-to-medium.

Targets: coverage configs, risk-review manifest, complexity/duplication baselines,
validator tests, CI result publication and existing operational documentation.

1. Compare configured coverage floors with stable observed results. For example,
   the API orchestration branch floor is 67% while the verified run was 94.04%.
   Investigate stable headroom and ratchet conservatively; do not assume one
   run's exact decimal is a robust new threshold.
2. Retire remaining unreviewed debt one behavioral case at a time, starting with
   higher-consequence reachable paths. Keep strict cohorts strict and do not
   raise the frozen artifact/contracts/integrations/engine debt ceilings.
3. Add negative fixtures for any newly advertised gate. Distinguish source
   presence, referenced-only evidence and source-matched executed evidence.
4. Keep one current quality entrypoint, with links to authoritative ADRs,
   compatibility inventory and test-confidence policy. Preserve historical
   audit revisions; do not delete or rewrite them to simplify the dashboard.
5. Update codebase navigation only when ownership actually moves. Naming edits
   must improve domain clarity, not enforce personal vocabulary preferences.

Done when: checks reject meaningful regressions, thresholds reflect stable
evidence, and readers can find current status without interpreting historical
claims as open bugs. No new parallel documentation authority is introduced.

### Q13 — Independent final verification and reassessment

Classification: integration gate. Priority: last. Size: medium.

1. Inspect the complete cumulative diff against the recorded candidate baseline,
   including new files, migrations, contract artifacts, test deletions and
   baseline changes. Use a fixed-point diff review at this stage.
2. Reconcile every area below with changed/verified/retained/deferred evidence.
   Perform an independent cross-package review of authority, cancellation,
   durable identity and cleanup. Do not call an unchanged-file sample a fresh
   exhaustive whole-repository inspection.
3. Run the verification matrix below on the final candidate, without concurrent
   output collisions. Report unavailable external checks and legitimate skips.
4. Reassess the five scoring criteria from the evidence, not from task count or
   an aspiration to reach 9. Record unresolved risks and follow-up owners.

Done when: no confirmed blocking regression remains; each work item has a
supported disposition; source identity, tests, limits and Git state are recorded.
External gaps cannot be silently marked complete.

### Q14 — Separate external qualification, not local refactoring

Classification: external qualification. Priority: before production sign-off.
Size/environment/budget: determined under the existing Phase 7 plan.

Reuse the existing release-security, external-platform, observability and
regional-recovery procedures. With explicit authorization, run AWS Object Lock,
IAM/KMS and dual-region object/ledger proofs; real provider delivery using test
recipients; deployed load and alarms; migration/rollback drills; and recovery
with measured RPO/RTO. Specify targets, data, expected side effects, rollback,
cost limits and cleanup before execution. Do not send real customer messages
or perform destructive regional drills under this planning request.

Done when: existing production criteria have retained deployed evidence and
owner approval. These results do not follow automatically from Q01–Q13.

## Every-area disposition

The matrix ensures coverage of the codebase, not compulsory edits to every row.

| Area | Planned improvement / protection | Work items |
| --- | --- | --- |
| API | Stronger identity/bootstrap evidence; simpler composition only where useful; real route/contract parity | Q04, Q06, Q09 |
| Worker | Notification rollout proof; lifecycle and dispatch ownership; process/outage assertions | Q03, Q04, Q06, Q10 |
| Lifecycle command | Preserve confirmation, replay, deadline and cleanup through command-level fault tests | Q04, Q05 |
| Operator command | Keep explicit authorization/target identity; verify cancellation and safe recovery outcomes | Q04, Q05 |
| Recovery | Verify fail-closed local orchestration; keep regional proof separate | Q04, Q10, Q14 |
| Retention app | Keep thin ownership; test shutdown/contention with database owner rather than duplicate policy | Q04, Q08, Q11 |
| Artifact store | Hash-chain/object lifecycle composition and streaming evidence; external storage guarantees explicit | Q08, Q10, Q11, Q14 |
| Contracts | Independent runtime acceptance/rejection and response parity alongside generation | Q09, Q12 |
| Database | Connection locality, inspectable destructive stages, consumer invariants and measured query/pool behavior | Q03, Q04, Q07, Q08, Q11 |
| Integrations | Preserve security-validation order and ambiguity policy; cover missing consumer failure combinations | Q05, Q10, Q14 |
| Node catalog | Preserve cohesive registration/projection and independent release fixtures; no forced split | Q09 |
| Node SDK | Protect public contracts and browser/server separation; no generic capability expansion | Q05, Q09 |
| Core nodes | Preserve immutable versions; extend missing executable behavior cases, not filename assertions | Q05, Q09 |
| Observability | Verify diagnostic isolation at consumers, redaction and bounded labels under failure | Q10, Q11 |
| Queue | Verify active delivery during loss/drain; preserve transport versus durable-authority separation | Q04, Q10 |
| Rate limit | Verify real-route unavailable/limit behavior; retain compact policy/store design | Q05, Q10 |
| Workflow engine | Consumer-level valid-outcome matrix; retain pure transitions and deliberate state-machine complexity | Q03, Q09, Q11 |
| Workflow model | Strict old/new shape contracts, canonical identities and hostile-value protection | Q03, Q05, Q09 |
| Root / CI / infrastructure | Isolated reproducible verification, honest skips/evidence and meaningful ratchets | Q01, Q02, Q05, Q11, Q12 |
| Documentation | Revision-bound current status, stable navigation and clear external qualification limits | Q01, Q12, Q13 |

## Verification and handoff contract

Use the narrowest owning checks while working; run combined gates at a coherent
workstream closeout. Exact test counts may change and are not acceptance targets.

| Change | Minimum evidence |
| --- | --- |
| Documentation only | Targeted Prettier check, `pnpm docs:check`, `git diff --check` |
| Local module refactor | Owning unit/component tests and typecheck/build; architecture, complexity and duplication checks as relevant |
| Transport/API contract | Composed route tests, package tests, `pnpm contracts:check`; regenerate artifacts only for intended changes |
| Transaction, lock, retention or migration | Real PostgreSQL regression/concurrency tests under actual roles; upgrade/rollback compatibility where applicable |
| Worker/queue/lifecycle | Process-level cleanup and relevant real-service resilience alongside focused tests |
| Coverage/report/tooling | Positive and negative gate fixtures; fresh source-bound reports; no swallowed missing cohorts |
| Full local closeout | `pnpm check`, serialized or isolated `pnpm test:coverage`, all applicable local integrations and specialized suites, `pnpm deployment:check`, `pnpm images:check`, `pnpm exercise:check` |
| External qualification | Existing release/operations commands and authorized deployed evidence; never inferred from the local closeout |

Each completed item must record: original friction/gap; selected change or
retain-unchanged decision; removed/replaced path; exact candidate identity;
commands and results; changed coverage scope; residual limits; rollback impact;
and commits/pushes only if separately authorized. Do not overwrite unrelated
changes or automatically amend/squash existing history.

## Proposed tracking checklist

- [x] Q01 — Baseline and current evidence reconciled.
- [x] Q02 — Reproducible isolated local verification.
- [x] Q03 — Notification mixed-version activation and rollback proof.
- [x] Q04 — High-consequence behavior map and missing evidence closed.
- [x] Q05 — Targeted fault-detection canaries verified.
- [x] Q06 — API/worker composition changes or retain decisions justified.
- [x] Q07 — Connection persistence locality decision verified.
- [x] Q08 — Selected destructive/coordinator hotspot decisions verified.
- [x] Q09 — Execution and public-contract consumer evidence completed.
- [x] Q10 — Missing transport/provider/diagnostic failure combinations covered.
- [x] Q11 — Repeatable performance baseline and justified optimizations.
- [x] Q12 — Ratchets calibrated and current documentation reconciled.
- [x] Q13 — Independent cumulative review and local closeout.
- [ ] Q14 — External qualification, separately authorized and tracked in Phase 7.

Recommended first implementation slice: Q01 and Q02, then Q03. This establishes
trustworthy evidence and addresses the specific rollout uncertainty before
attempting broad maintainability improvements.

## Implementation record

### Q01 — Baseline and current evidence reconciled

Status: complete on 2026-09-09 for the pre-Q01–Q13 candidate. This identity is
the input baseline for the quality work, not the final candidate identity that
Q13 must record after all local changes.

- **Original gap:** the remediation existed in a dirty tree, while the audit
  closeout named only `HEAD` and reported 23 unreviewed branches without binding
  that number to the later regenerated report.
- **Decision:** preserve the historical 7/10 and remediation narratives, add a
  separately revision-bound current entry, and identify the dirty candidate by
  its base commit, binary tracked patch, tracked-path inventory, and every
  implementation-relevant untracked file. The tracking plan itself is excluded
  from the implementation identity so that recording the identity is not
  self-referential.
- **Source identity:** branch `main`; upstream `origin/main`; base `HEAD`
  `9a09ccec09fa97215f54ed46a687cb00805dd4f6` (one local commit ahead, zero
  behind); no staged changes; tracked binary patch SHA-256
  `95810cd07a1597d3e89c5970312bb3681deaf869559a1eaebc13bdb7fd21d0bb`;
  sorted tracked-path-list SHA-256
  `4fdaf5b86869d19486f28ede1c71de22db02a853f8b90387f216aa6e8ab61ab5`.
- **Untracked implementation files at the baseline:**

  | SHA-256 | Path |
  | --- | --- |
  | `ac82c6c21d9bb6a3cf51b4c78ebc7d12a91f42042e376ff43f5409d2a4646ff2` | `apps/api/test/orchestration-coverage-config.test.ts` |
  | `644073457e75dffb4c6471b14f696f978dcd63d9e798bae8fa6df4f276219d8c` | `apps/api/vitest.orchestration-coverage.config.ts` |
  | `c7dec4ea217cc53a50474d7471d9cbec4b36cf96d3d270ee74ca74288e63bcf7` | `apps/worker/test/worker-process-shutdown.test.ts` |
  | `83140c17371fe804b5a4eebe31cac07e177ca9f09f0db5c8a7d1b4e9ac701675` | `apps/worker/test/worker-readiness-lifecycle.test.ts` |
  | `4b39b8aef720da5631f42bdbabada0dbfe6bdca8bc716f4fa9b9201f06e6af61` | `infrastructure/browser-entry-dependencies.mjs` |
  | `9bf868a6f83ba2a5f7ccef0546547007a5cc578901c4a6fb6b69ce4207e489ed` | `infrastructure/browser-entry-dependencies.test.mjs` |
  | `cd311b174b7e25b7293a30a6f94fa5f28a78f7bf38244d0981e3b87538390305` | `packages/contracts/src/http/transport-headers.ts` |
  | `a202ad58ba20d5c09b8a93f403fea4dc9a17602d9535cc4f59c54917495568a8` | `packages/database/src/authoring/workflow-authoring-contracts.ts` |
  | `3ad094242ecaaca660ba205a81e5e9411e99feeee15f57e8d57f20d3d37e797a` | `packages/database/src/execution/dispatcher-contracts.ts` |
  | `0fd3c1577ccc08e80a13e6339aeb79a691b2872896b4f4ed56c5f8a8a751759d` | `packages/database/src/execution/failure-notification-contracts.ts` |
  | `5567b681ccd5469f1b3788d9e29ec31e9d7b84c9a3a8773a85e191c1656d843a` | `packages/database/src/lifecycle/retention-contracts.ts` |
  | `04575d9230382efced353dfbd2ddba479204031a21740db3eec32021feabc655` | `packages/database/src/lifecycle/retention-database-capabilities.ts` |
  | `e56485a10d2a4f139c71fa42accbc7e47c52ab85c809a4803fd47835412f8633` | `packages/database/src/lifecycle/retention-support.ts` |
  | `ead092264bca890081570f9c6661ab5af53e9933b34ac182eda2965799d1a999` | `packages/database/src/operator/operator-command-contracts.ts` |
  | `cbdb1ace0b7b2833f44d0328592a38c828df683e1148c687dbc12ef26ce19653` | `packages/database/src/tenant-access/identity-workspace-contracts.ts` |
- **Coverage reconciliation:** the source-bound report generated at
  `2026-09-09T12:11:25.558Z` contains 468 reviewed and 22 unreviewed branches.
  The 22 are artifact store 8, contracts 1, integrations 2 and workflow engine
  11. The closeout's 23 was the preceding observation and also equals the four
  configured debt ceilings (8 + 1 + 3 + 11); it is retained as historical
  evidence rather than relabeled as the newer run. No threshold changed.
- **Changed/replaced paths:** this implementation record and the current-status
  entry replace the ambiguous use of `HEAD` alone; no production path changed.
- **Verification:** focused Prettier checks, `pnpm docs:check` (13/13 tests and
  308 validated links), `pnpm quality:local:check` and `git diff --check`
  passed at the coherent Q01/Q02 boundary.
- **Limits and rollback:** the identity is a local dirty-tree description, not a
  commit, deployed artifact or production qualification. Removing these notes
  changes no runtime behavior, but would restore the evidence ambiguity.

### Work-item provenance

| Item | Existing finding, limit, or conditional proposal |
| --- | --- |
| Q01 | Dirty-tree and stale/latest evidence ambiguity in the remediation closeout. |
| Q02 | Service-gated integration skips and shared coverage directories observed during the closeout. |
| Q03 | ADR 022 predecessor-reader incompatibility for the additive run-level failure context. |
| Q04 | Remaining high-consequence branches and lifecycle/fault combinations identified by TQ-03–05. |
| Q05 | Mutation-sensitivity policy in `docs/operations/test-confidence.md`, presently demonstrated only for selected canaries. |
| Q06 | Conditional follow-up to MC-01–03 API/worker ownership cleanup. |
| Q07 | Conditional locality review after MC-05's contract-leaf extraction; transaction shape remains protected. |
| Q08 | Conditional density review of destructive/coordinator owners after MC-04; no deletion defect is presumed. |
| Q09 | Consumer-level follow-up to WB-09/WB-10 and TQ-01/TQ-02 public-contract evidence. |
| Q10 | Remaining local composed outage/diagnostic combinations; live provider and AWS outcomes stay external. |
| Q11 | Missing repeatable performance evidence against ADR 015 objectives. |
| Q12 | Stable headroom, 22 remaining unreviewed branches, and discoverability of current versus historical evidence. |
| Q13 | Required fixed-point cumulative review, full local matrix and evidence-based reassessment. |
| Q14 | Phase 7 external qualification; explicitly outside this authorization. |

Unless a narrower measurement identity is stated below, Q02–Q13 refer to the
final dirty-tree identity recorded by Q13. No Q01–Q13 work was committed,
pushed or deployed. Each rollback described here is therefore a source revert;
it must preserve the uncommitted remediation baseline identified by Q01.

### Q02 — Reproducible isolated local verification

Status: complete locally on 2026-09-09.

- **Gap and decision:** replace the manual, collision-prone closeout sequence
  with `pnpm quality:local`. The runner parses and fail-checks CI's service
  environment, exact specialized-suite commands, service-start/bootstrap,
  migration, coverage-merge and cleanup commands; reserves five distinct
  loopback ports, creates a unique Compose project, serializes the repository's
  fixed coverage destinations with an ownership-checked lock, and records an
  atomic per-run manifest. Partial runs are explicitly non-qualifying.
- **Changed/replaced paths:** `package.json`, `README.md`,
  `infrastructure/run-local-quality.mjs`, its negative/cleanup tests, and
  `docs/operations/local-quality-verification.md`. No CI environment was copied:
  `.github/workflows/ci.yml` remains the checked contract. The Q11 performance
  cohort was later inserted after migration and uses the same owned services.
- **Evidence:** runner tests passed 7/7. Disposable runs for `exercises`,
  `integration-queue`, and `performance` started unique PostgreSQL, Redis and
  three object-store endpoints, applied migrations, validated reports, and
  removed the exact containers, network, five volumes and coverage lock. The
  performance smoke manifest
  `2026-09-09t13-14-06-289z-26984-54a19792` is source-stable and visibly
  `partial`; it is not mislabeled as the final qualification.
- **Limits and rollback:** fixed coverage consumers require serialization, so a
  second run in one checkout is refused rather than partially isolated.
  Worktrees remain independent. Removing the entrypoint restores manual local
  verification and its skip/collision risk; it changes no production runtime.

### Q03 — Notification-context mixed-version compatibility

Status: complete locally on 2026-09-09; deployment activation remains Q14.

- **Gap and decision:** the predecessor V1 reader rejects the additive run-level
  timeout shape. Pinned predecessor/candidate JSON fixtures now prove the exact
  reader matrix. ADR 022 defines R0, reader-first R1 and writer-enabled R2. A
  strict `FAILURE_NOTIFICATION_RUN_TIMEOUT_CONTEXT_ENABLED` worker setting,
  defaulting to and rendered as `false`, makes R1 deployable; only exact `true`
  activates R2. The gate suppresses only node-free timeout notification intent
  creation, never terminal run/event truth or predecessor node-shaped intents.
- **Changed/replaced paths:** the workflow-model schema/tests/fixtures;
  coordinator terminal, transition, commit and factory seams; worker config,
  runtime/provider and config tests; `infrastructure/ecs/workloads.json`; ADR
  022; and the compatibility retirement inventory. The former unconditional
  candidate writer is replaced by the explicit additive-writer gate. No schema
  migration, stored rewrite, intent identity or payload identity changed.
- **Evidence:** workflow-model passed 97/97; database units 264/264 and worker
  units 291/291 passed. Eleven focused real-PostgreSQL scheduling/purge tests
  passed. They prove R1 commits a queued timeout with zero candidate intents;
  R2 atomically commits one immutable context/intent/outbox, rejects it in the
  predecessor reader before claim, permits dual-reader takeover, and preserves
  checksum/identity through restart, recovery and redelivery.
- **Limits and rollback:** this is local rollout proof, not a fleet observation.
  R2 rollback first disables every producer and may return only to R1 until
  production zero-result evidence covers retained intents, outbox/queue work,
  retries and replay. R0 rollback with candidate contexts remains forbidden.

### Q04 — High-consequence behavior evidence

Status: complete for the selected local behaviors on 2026-09-09.

- **Gap and decision:** `docs/operations/test-confidence.md` now maps
  authorization loss, external cancellation, initialization/shutdown failure,
  acquisition exhaustion, stale leases/fences, duplicate delivery, ambiguous
  dispatch and rollback to their owning direct, composed, process and
  PostgreSQL suites. Existing assertions were retained instead of duplicating
  whole matrices. The original strict API orchestration cohort continues to
  measure application-error, connection-test and SSE/run-use-case owners. A
  separate priority cohort instruments application bootstrap, identity, OIDC,
  identity/workspace and authoring orchestration without weakening the original
  ratchet.
- **Changed/replaced paths:** the behavior map and risk-coverage selection are
  evidence changes; `apps/api/vitest.priority-coverage.config.ts` and its
  inventory test make the newly selected scope executable. No production
  abstraction was introduced. Q03, Q08 and Q10 add the only missing
  consumer-level cases discovered by the map.
- **Evidence:** the restored selected canary suites passed; the API
  orchestration run passed 583/583 at 94.04% branches, 96.82% functions, 97.31%
  lines and 96.47% statements. The priority cohort passed 584/584 at 83.50%
  branches, 97.29% functions, 93.47% lines and 92.09% statements, above its
  conservative 82%/96%/92%/91% floors. Q13 runs all process and real-service
  cohorts.
- **Limits and rollback:** forced uncertainty on the PostgreSQL `COMMIT` wire is
  not simulated, and local fixtures do not qualify AWS/provider behavior.
  Removing the map loses traceability but changes no runtime behavior.

### Q05 — Policy-regression sensitivity

Status: complete for six selected canaries on 2026-09-09.

- **Decision and changed paths:** disposable source perturbations exercised the
  existing transition, retry ambiguity, workspace authorization, provider
  fence and abort-handoff canaries. The one missing hostile input was added to
  `packages/workflow-model/test/mapping.test.ts`: inherited JSON-path properties
  must remain missing while own properties resolve. The mutation record lives
  in `docs/operations/test-confidence.md`.
- **Evidence:** each of six deliberately wrong variants produced its named red
  test, then the untouched checkout passed the restored owning files: 4 model,
  3 transition, 2 retry, 2 authorization, 40 Slack and 17 queue tests. Malformed
  package, mutable-image, and missing/failed/skipped/mismatched/stale evidence
  fixtures remain separate negative controls. No mutation remains in this tree.
- **Limits and rollback:** this is targeted sensitivity evidence, not a
  repository-wide mutation score. Reverting the added inherited-property test
  would reopen that specific false-positive path without changing production.

### Q06 — API and worker composition ownership

Status: complete with one focused worker-capability extraction on 2026-09-09.

- **Decision:** retain the linear API bootstrap as the single lifecycle owner
  and the broad worker capability runtime as the owner of database leases,
  artifact capabilities, readiness and aggregate close failures. Extract the
  cohesive provider-connection runtime into
  `apps/worker/src/execution/provider-connection-runtime.ts`; it now owns rate
  admission, credential resolution/currentness translation, identity checks,
  cancellation and secret clearing, while the composing runtime still owns its
  dependencies and lifetime. Attempt/preview handlers remain the visible owners
  of pre-/post-dispatch and replay truth.
- **Changed/replaced paths:** `node-runtime-capabilities.ts` delegates only the
  provider-connection factory to the new focused module. No duplicate Nest
  provider/container, pool, encryption runtime or close owner was introduced.
- **Evidence:** the provider-capability and actual attempt-consumer regressions
  pass 46/46, the integrations provider suites pass 241/241, and worker coverage
  includes the extracted module in its measured critical-runtime cohort. Q13
  supplies the broader worker/API suites.
- **Limits and rollback:** the extraction changes no public interface, database
  role, dispatch order or lifetime. Rollback may inline the factory only if it
  preserves the portable error taxonomy, cancellation, zeroization and
  consumer-level tests; it must not restore the prior file hotspot.

### Q07 — Connection persistence locality

Status: complete with a retain-unchanged decision on 2026-09-09.

- **Decision:** production API and worker consumers already depend on
  `ConnectionManagementDatabase`, `ConnectionTestDatabase`, or
  `ConnectionResolutionDatabase`; five role-focused leaves own SQL and one
  composing factory owns the pool. The shared 651-line
  `connection-persistence.ts` is a neutral contract/validation/codec/transaction
  leaf. Splitting it would move roughly 60 internal imports and risk a
  root/child type cycle without narrowing any production consumer.
- **Changed/replaced paths:** the measured consumer/owner inventory was added to
  `docs/operations/complexity-hotspot-retention.md`; no SQL, public export,
  transaction or factory changed.
- **Evidence:** database unit 264/264 and worker unit 291/291 results cover the
  narrow consumers; Q13 runs real PostgreSQL compatibility, conditional-write,
  secret-version, stale-completion and cross-workspace cohorts.
- **Limits and rollback:** retain for the current topology. Removing the record
  loses the deletion-test rationale; there is no runtime rollback.

### Q08 — Destructive/coordinator orchestration

Status: complete locally on 2026-09-09.

- **Decision:** retain `WorkspacePurgeCoordinator.processNext` as the single
  traceable owner of discovery, session-lock claim, external object I/O, fence
  revalidation, checkpoint, release/retry and completion. The measured symbol
  is 525 lines/45 branches versus its 530/45 allowance. Splitting those stages
  would move lock/transaction authority into shallow forwarding helpers.
- **Changed/replaced paths:** the current hotspot inventory and explicit
  stage/authority table were added to
  `docs/operations/complexity-hotspot-retention.md`; one missing real-PostgreSQL
  stale-step/concurrent-reclaim regression was added to
  `packages/database/test/workspace-purge-foundation.integration.test.ts`.
- **Evidence:** the focused scheduling/purge cohort passed 11/11. The new test
  proves expired lease release/checkpoint are fenced, two coordinators produce
  one physical purge after reclaim, and the fence increases monotonically.
  Existing public tests retain hold-arrival serialization, partial/ambiguous
  dual-region deletion, checkpoint retry/restart, cancellation during pool or
  advisory-lock acquisition, and no open transaction during object I/O.
- **Limits and rollback:** query count, pool demand, lock order and production
  concurrency are unchanged. Reverting the test/doc reopens evidence only.

### Q09 — Execution and public-contract composition

Status: complete locally on 2026-09-09.

- **Decision:** existing workflow-engine outcome/For Each/retry/wait suites,
  immutable release histories and independent golden fingerprints already cover
  terminal/checkpoint consumers, restart/replay, cancellation, bounded loops
  and branch failure. The missing gate was actual built-package consumption.
- **Changed/replaced paths:** `infrastructure/validate-built-package-exports.mjs`
  and its negative fixtures add 14 self-reference imports across contracts,
  SDK, core nodes, catalog, model and engine under real Node/browser export
  conditions, including explicit false server targets. `package.json` runs the
  gate immediately after build. No source-only package assertion was removed.
- **Evidence:** 599 model/engine/contracts/SDK/catalog/core tests passed; the
  built gate passed 3/3 fixtures and all 14 real consumer cases. Resolutions
  must land in each package's own `dist`, export nonempty values, and reject
  server entrypoints under `browser` with `ERR_INVALID_PACKAGE_TARGET`.
- **Limits and rollback:** this is Node conditional-export evidence, not a new
  browser bundler or frontend. Reverting the gate restores the source-only
  blind spot without changing runtime packages.

### Q10 — Transport/provider/diagnostic composition

Status: complete for local seams on 2026-09-09.

- **Gap and decision:** existing queue/worker resilience, provider ambiguity,
  telemetry isolation, redaction and dual-store suites already covered most of
  the requested matrix. A composed OIDC-start route now proves Redis limiter
  failure returns bounded `503`/`Retry-After` before provider work. A discovered
  cleanup defect is fixed: streamed transport chunks are cleared even when
  cancellation or size rejection wins before redaction, and already-aborted
  work receives a rejection observer so cancellation cannot leak an unhandled
  promise rejection.
- **Changed/replaced paths:** `apps/api/test/api-bootstrap.test.ts`,
  `packages/integrations/src/http/stream-redaction.ts`,
  `secure-http.ts`, and its public-client regression. Cleanup now encloses the
  complete per-chunk path and abort listener lifetime; SSRF/DNS/TLS/redirect
  validation order and retry classification are unchanged.
- **Evidence:** Secure HTTP passed 86/86 and API bootstrap passed 30/30. The
  regression cancels before the first streamed chunk is processed, observes a
  zeroed buffer and one transport close, and retains `possiblyDispatched=true`.
  The route test observes no application/provider invocation or internal Redis
  detail. Q13 runs queue, resilience, artifact and observability composition.
- **Limits and rollback:** local fakes do not demonstrate live Slack, email or
  AWS success. Reverting production cleanup reintroduces plaintext retention and
  unhandled-rejection risk, so rollback should retain the tests and use the
  prior bounded semantics only after an equivalent cleanup fix.

### Q11 — Local performance baseline

Status: complete as a repeatable local baseline on 2026-09-09; no optimization
was justified. Final source-stable inclusion in Q13 passed.

- **Decision and changed paths:**
  `infrastructure/performance/run-local-benchmark.mjs`, its manifest/tests and
  `docs/operations/local-performance-evidence.md` measure seven existing
  consumer seams inside Q02-owned services. The full qualification owns the
  performance cohort. The runner records source/host/runtime/seed/warmup/rounds,
  versioned operation markers with absolute monotonic boundaries and declared
  fixture populations. It records raw and summarized operation latency,
  interval-derived throughput, 100 ms workload process-group RSS/CPU/process
  series and trends, separately labelled orchestrator diagnostics, and 250 ms
  PostgreSQL database-size/connection/active-task/lock-wait samples.
  PostgreSQL statement statistics add per-scenario SQL-call/server-time counts;
  repository telemetry records pool checkout duration; and a disposable
  44-workspace/400-artifact fixture captures six real maintenance-role plans.
  The retention scenario uses a two-participant release barrier and requires
  exact retention/foreground interval overlap in every measured round.
- **Measurement identity:** complete qualification run
  `2026-09-09t20-27-02-938z-25703-bc910c0c`; benchmark source SHA-256
  `3507b4e0c7f2a2bb1edc44e64a659866843174bc19db945e13dc0b07c9fb3222`;
  runner start/end fingerprint
  `8e8ecaeadd290b4134be004e5d269f3428b81aa643b8b8082496f30dae6c7039`;
  Apple M4/10 logical CPUs/24 GiB, macOS 25.6.0 arm64, Node 24.15.0, pnpm
  11.22.0, seed 15011, one warmup and five measured rounds. The manifest and
  service cleanup passed with stable start/end source.
- **Results:** named-operation p95 milliseconds were workflow create 11.38,
  initial publish 14.10, executable-change publish 20.46, webhook admission
  42.88, due schedule to durable `run.started` 174.51, live-event visibility
  8.99, loop load/commit for 128 items 14.91/18.58, artifact begin/upload/
  finalize/metadata/download for a 1 MiB body 34.22/19.87/52.96/5.11/912.85,
  and retention scheduling over 26 workspaces versus 32 foreground acceptances
  21.18/83.19. Retention/foreground overlap was proven in all five rounds at
  17.90–21.17 ms. Peak workload process-group RSS ranged 646–1,265 MB. The
  database peaked at 15,333,055 bytes, 14 connections, one active task and
  zero sampled lock waits. Three contended pool checkouts measured 60.5–61.7
  ms, and all six maintenance-role plans remained available.
- **Comparison policy:** no automated SLO gate is created from one laptop.
  A same-host/same-manifest candidate merits investigation when p95 exceeds the
  `maximum × (1 + max(0.10, 5 × CV))`. The result is rounded upward to a
  5 ms quantum below 100 ms, 25 ms below 1,000 ms, and 100 ms thereafter. The
  named-operation bands and populations are recorded in the local performance
  evidence. These are comparison bands, not production latency promises.
- **Limits and rollback:** per-process Node heap/event-loop lag remains
  unavailable across the pnpm/Vitest process trees;
  scenario SQL calls are aggregate PostgreSQL calls rather than domain-operation
  attribution, and security-definer function internals appear as Function Scan
  roots rather than nested plan trees. Since stable harness evidence exposed no
  candidate regression, no index/query optimization was made. Removing the
  harness loses comparability; reverting the checkout histogram loses a
  production-observable saturation symptom and should retain its unit and real
  PostgreSQL tests.

### Q12 — Ratchets and current evidence navigation

Status: complete locally on 2026-09-09.

- **Decision and changed paths:** two stable API-orchestration observations at
  94.04%/94.05% branches supported conservative floors of 92% branches, 95%
  functions/lines and 94% statements in
  `apps/api/vitest.orchestration-coverage.config.ts`; its config test freezes
  the scope and floors. The added priority cohort records 82% branch, 96%
  function, 92% line and 91% statement floors against its first expanded
  83.50%/97.29%/93.47%/92.09% observation; it is separate so the established
  stricter cohort was not reduced. The integrations unreviewed ceiling moves from three to
  two, matching the latest source-bound observation; positive 2/reject 3
  fixtures protect the ratchet. This plan links the operational evidence set,
  while current status and codebase navigation continue to point here.
- **Evidence:** API orchestration passed 584/584 at 94.04% branches; risk-report
  tests passed 13/13; complexity passed with no new/worsened hotspot. Q13
  regenerates the source-bound report and exercises every threshold.
- **Limits and rollback:** artifact 8, contracts 1, integrations 2 and engine 11
  remain frozen ceilings rather than quality targets. Thresholds were not
  weakened and historical reports were not rewritten. Rollback would loosen
  proven headroom and therefore requires evidence of legitimate new risk code.

### Q13 — Independent cumulative review and local closeout

Status: complete locally on 2026-09-10; Q14 remains unexecuted and unauthorized.

- **Superseded evidence:** the earlier Q13 closeout and full local run
  `2026-09-09t14-14-37-601z-28306-eda6bcb3` predate the follow-up provider,
  readiness, runner-supervision and Q11 measurement changes. They remain useful
  historical diagnostics but are not final evidence for the current candidate.
  The later run `2026-09-09t21-37-53-862z-78333-70a148c8` is also not
  qualification evidence: macOS power history confirms clamshell sleep from
  23:42:20 through maintenance-wake intervals until the 23:57:31 user wake,
  spanning the artifact test's 30-second timer. A subsequent isolated
  performance rerun passed all warm-up and measured artifact executions.
- **Six-group disposition:** provider resolution and fencing now preserve
  transient/cancellation failures through the worker retry policy while genuine
  invalid/revoked/rotated credentials remain permanent and post-dispatch
  ambiguity remains unsafe to retry. Transient connection-resolution and
  dispatch-evidence outages now use the existing retryable `provider` class;
  immutable `engine.retry@1` remains unchanged and continues to reject true
  internal failures. Pre-execution and in-flight heartbeat cancellation
  preserve durable dispatch uncertainty reconstructed from an earlier attempt.
  Readiness revocation aggregates marker and dependency failures, marks the
  process unhealthy, and cannot strand shutdown.
  The nested runner test owns an isolated lock/fixture. Both qualification and
  benchmark runners supervise complete owned process trees across interruption,
  failed parents and cleanup; parent exit starts cleanup before descendant-held
  output pipes are awaited. The eight reported lint failures were corrected
  without suppressions. Q11 now measures the intended durable schedule start,
  a 128-item loop, a 1 MiB stream and proven retention/foreground overlap, with
  interval-derived throughput and explicitly bounded metric limitations.
- **Independent review:** separate specification and implementation-standards
  fixed-point reviews inspected the complete dirty-tree diff against
  `9a09ccec09fa97215f54ed46a687cb00805dd4f6`. Findings covering cleanup-error
  aggregation, process ownership/retry, readiness bootstrap order, ECS
  not-ready enforcement, SSE subscription races and duplicated test support
  were corrected. Their final focused re-reviews also examined the immutable
  retry-policy mapping, historical dispatch uncertainty through cancellation
  and HTTP/Slack resolution or fencing failure, and runner exit/close/log-error
  ordering. Their last re-reviews also covered heartbeat cancellation before
  redispatch, inherited-pipe cleanup and combined command/cleanup errors. Both
  reviewers reported no remaining substantive finding; focused typechecks, 245
  integration tests, 32 worker node-attempt tests, 25 runner tests and the
  retry-policy mutation suite passed.
- **Historical local evidence:** unchanged `pnpm quality:local` passed as run
  `2026-09-09t20-27-02-938z-25703-bc910c0c`: all 20 required cohorts passed,
  including 2,427 unit/component and 491 local integration, resilience and
  compatibility tests. Coverage recorded 470 reviewed and 22 ceiling-bound
  unreviewed branches across 130 risk files/5,512 coverable lines, with zero
  unreviewed branches in every strict cohort. The dirty candidate remained on
  `HEAD` `9a09ccec09fa97215f54ed46a687cb00805dd4f6` with identical start/end
  fingerprint
  `8e8ecaeadd290b4134be004e5d269f3428b81aa643b8b8082496f30dae6c7039`.
  Cleanup passed after the owned containers, volumes, ports, lock and process
  trees were released. The manifest SHA-256 is
  `b7e7413b77b5a1bb9e032873981722655d7dbe0fd25cda9b1c2216a4c756b7d9`.
  This run predates the three follow-up corrections and is not their final
  qualification.
- **Final local evidence:** unchanged `pnpm quality:local` passed as run
  `2026-09-09t22-46-29-939z-54701-2f1f81c8`: all 20 required cohorts passed,
  including 2,433 unit/component and 491 local integration, resilience and
  compatibility tests. Coverage recorded 470 reviewed and 22 ceiling-bound
  unreviewed branches across 130 risk files/5,522 coverable lines, with zero
  unreviewed branches in every strict cohort. The dirty candidate remained on
  `HEAD` `9a09ccec09fa97215f54ed46a687cb00805dd4f6` with identical start/end
  fingerprint
  `b148a5cc94d644e42deb8f412051b671310dc1d773299f896ffed0bef2ed6b5e`.
  Cleanup passed after the owned containers, volumes, ports, lock and process
  trees were released. The manifest SHA-256 is
  `e3884aa815c80fe383468b2564f92f7270ffd5927f0f35243465a4e69620701c`.
- **Final follow-up local evidence:** unchanged `pnpm quality:local` passed as
  run `2026-09-09t23-42-55-484z-56704-efd169bb`: all 20 required cohorts
  passed, including 2,435 unit/component and 491 passing local integration,
  resilience and compatibility tests. Coverage recorded 470 reviewed and 22
  ceiling-bound unreviewed branches across 130 risk files/5,523 coverable
  lines, with zero unreviewed branches in every strict cohort. The dirty
  candidate remained on `HEAD` `9a09ccec09fa97215f54ed46a687cb00805dd4f6`
  with identical start/end fingerprint
  `7337657e07d3f2679403fc4af5526cc10bdcf3bfd9140961acf37961358d4352`.
  Cleanup passed after the owned containers, volumes, ports, lock and process
  trees were released. The manifest SHA-256 is
  `48a7b6bbf02ca4aa16c12f69bf42979d921f373cdc46de517106d8c08ee66fe7`.
- **Final reassessment:** names/layout 8/10; control flow/readability 8/10;
  responsibility/interface design 8/10; runtime/data/error safety 8/10; tests
  and executable evidence 9/10. The risk-weighted local engineering assessment
  remains 8/10: the candidate is substantially better protected, but a finite
  local review and laptop matrix do not justify 9/10 or production readiness.
- **Scope limits:** no commit, push, deployment, paid service, provider delivery,
  AWS exercise or destructive external drill is authorized. Q14 remains owned
  by Phase 7 release/operations and cannot be inferred from local evidence. The
  three AWS-only Object Lock/bucket-policy checks remain explicit skips;
  provider delivery, deployed load/alarms, regional recovery and production
  SLO/RPO/RTO evidence remain external.
