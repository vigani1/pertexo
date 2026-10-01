# Backend Implementation Progress

Last updated: 2026-10-01

This is the mutable delivery tracker for
[`workflow-platform-backend-plan.md`](./workflow-platform-backend-plan.md).
A phase is complete only when its plan requirements and applicable
vertical-slice criteria have passed. Local checks never substitute for the
external production evidence listed under Phase 7.

## Current qualification

### F05 — same-workspace workflow duplication

The user approved a fresh workflow identity with preserved internal graph IDs
on 2026-10-01. [ADR060](./adr/060-workflow-duplication-identity.md) and the
[F05 first-slice plan](./feature-plans/05-workflow-portability.md) define the
atomic command, source selection, authority, replay and verification contract
against starting merged main `0f54e31d`. This is a saved draft/chosen-version copy
into an independent unpublished draft, not import/export or automatic activation.

- [x] Reconcile the existing authoring/model baseline and resolve graph identity.
- [x] Record the accepted first-slice decision before implementation.
- [x] Implement atomic persistence, contracts/API and the browser command.
- [x] Prove isolation, races/replay and enabled live browser/backend acceptance.
- [x] Complete independent reviews and green exact-head/natural-main release.

The first slice is independently reviewed, merged through
[PR142](https://github.com/vigani1/pertexo/pull/142) and qualified on natural main
`5f78e1552c55fede6f04264f8be4197296629e9c` (merged 2026-10-01 at 15:06:01 UTC).
Both review axes closed all findings on `a766f585bdfe86cace8747b85818173a51629629`;
all 14 exact-head checks passed, including
[CI 36878945569](https://github.com/vigani1/pertexo/actions/runs/36878945569) and
[CodeQL 36878945724](https://github.com/vigani1/pertexo/actions/runs/36878945724).
Natural merged-main [CI 36881611828](https://github.com/vigani1/pertexo/actions/runs/36881611828)
and [CodeQL 36881611922](https://github.com/vigani1/pertexo/actions/runs/36881611922)
also passed on that exact main SHA. Main CI's real workflow duplication browser
journey validation and report upload succeeded.

Original local evidence on frozen `06ca64c1` includes 25 enabled PostgreSQL cases
(atomic rollback, source/catalog/membership
races, replay, defaults, ACL/readiness drift, populated 0128→0129 upgrade,
legal hold and workspace erasure), all 113 enabled ordinary API integration
cases, 142 contract tests, and 831 web unit tests. The enabled real-browser
duplication gate passes one journey with ordinary signup, saved-draft and chosen
version copies, three independent publications/runs, nested For Each and
Parallel/Merge, dynamic expression outputs isolated by run, and copy-only edits.
It verifies two atomic receipts/audits and normal fixture teardown. The full
repository check and 90 browser journeys pass; all 821 PostgreSQL integration
tests across 109 files pass without skips. Coverage binds 24 cohorts to the frozen
source and records zero unreviewed risk branches. Final reviewed `a766f585`
adds safe uncertain/stale/accepted-result recovery; its 849 web tests, 90 browser
journeys and 24 source-bound coverage cohorts pass with zero unreviewed risk
branches. The manager independently reran 26 focused duplication tests. Earlier
service-backed local results remain bound to `06ca64c1`; hosted qualification
of the repaired head and natural main is recorded separately above.
Only the same-workspace Duplicate first slice is complete. Import/export,
templates and cross-workspace copy remain unimplemented. No production effect
is authorized, and finite receipt retention and migration-0129 rollout/rollback
limits in the F05 plan still apply. F12, F29 and F30 remain qualified; their
completed work is not reopened by this slice.

### F30 — connection health first slice

The manager accepted [ADR059](./adr/059-connection-health-observations.md) and
the [F30 plan](./feature-plans/30-connection-health.md) on 2026-10-01, based on
reviewed F29 head `7561e822`. The narrow slice is independently reviewed and
merged through PR139 and test-only follow-up PR140. Final natural main
`adaa26df5f31ad4bbf69429f091f77acc707bf70` passed CI and CodeQL.
Scope is Slack run-derived evidence,
version/revision-fenced durable application, safe manual recovery, authorized
published-version usage, and the existing connections/settings UI. Notices and
other automatic providers are deferred; production activation is not authorized.

- [x] Reconcile baseline and record signal, ordering, recovery and usage choices.
- [x] Accept ADR059 and the manager-owned implementation/acceptance plan.
- [x] Implement contracts, capability security and durable backend with focused
      real PostgreSQL proof.
- [x] Implement the frontend and real API/worker/browser behavior.
- [x] Pass frozen-source local qualification, including full PostgreSQL and
      enabled HTTP/browser evidence.
- [x] Repair the reviewed ordinary-command conflict eviction and prove real
      abandoned publication ownership recovery after natural lease expiry.
- [x] Complete independent reviews; merge a scoped green PR and inspect natural
      postmerge checks.

Focused evidence: 23 run-health PostgreSQL cases, 16 boundary cases and two
bounded usage cases pass. The boundary executes legal-hold/release, retention
cascade/command cleanup, late delivery and actual tenant purge, plus exact 0127
upgrade and ACL/readiness drift. Notification acceptance's bounded lock-and-read
capability preserves the current secret after concurrent rotation; omitted or
cross-workspace context yields no rows, and body/execute-grant drift fails
startup. Interrupted publish, durable publish-mark
failure and health-application rollback preserve accepted run/attempt snapshots.
The real controlled-Slack HTTP and browser fixtures each pass one enabled case
with zero skips; provider calls do not increase across the acknowledged
worker-runtime restart. The repaired HTTP proof additionally abandons a real
dispatcher owner's durable health-publication claim before returning the event:
no publish, acknowledgment or release occurs. The token remains unexpired across
runtime recreation, then the unchanged 30-second lease expires naturally before
publication/application. Exactly one completed receipt and transition result;
the accepted run/attempt snapshots and one provider call remain unchanged. This
is not an OS process-kill claim. The same-hook user/workspace-switch command race
and held replacement ordinary/idempotency 409s are covered; 822 web tests pass.
Conflicts preserve the typed credential, retained command, retry key and feedback;
actual access loss still clears scoped caches. All 89 web browser cases pass.
Deployment contracts (61 cases), browser-safety probes (seven cases) and the
non-artifact API service cohort (86 cases, zero skips) pass. Frozen-source full
PostgreSQL integration with coverage passes 107 files / 795 cases with zero skips;
the final-built HTTP and browser cases also pass. Final `pnpm check` and
`pnpm test:coverage` pass: 24 source-bound cohorts, zero unreviewed risk branches
and 388 reviewed residual branches across 211 selected files. Four reachable
arms gained tests; two now-covered reviews were removed and one unchanged
defensive fingerprint was refreshed, with no threshold/exclusion relaxation.
Implementation commit `e5a44165` is integrated with qualified main `02750811`
through normal merge `f03191d3`, without rewriting history. The merge tree is
identical to the qualified implementation tree; CI routing, schema ownership,
documentation and coverage provenance passed again. Source fingerprint:
`sha256:b3586f5eee9b970ba85b7e2e120b37d708812ba109747c65e32397dcee1dd276`.
The owned `pertexo-connection-health-20261001` PostgreSQL/Redis containers,
network and two volumes were removed after all database clients closed and
fixture Redis DB13 was empty. Evidence remains outside the checkout under
`/Users/vigan/.codex/evidence/pertexo-f30-2026-10-01/`. At that local qualification
point, no push had been performed; 43 unrelated primary-checkout changes were
preserved. Review repairs are
`ef5c955d` (command conflicts) and `72a32b2f` (abandoned ownership proof).
Fresh repair evidence is retained in the receipt's `repair/` directory; the
original qualification receipt remains historical. The isolated
`pertexo-connection-health-repair-20261001` project was also removed after zero
clients, disposable databases and Redis DB13 keys/ownership were verified.
Production lease budgets, coverage thresholds and CI owners remain unchanged;
only the HTTP proof's bounded test ceiling accommodates actual lease expiry.
Production mode remains `off`; no provider traffic outside owned fixtures is
authorized.

[PR139](https://github.com/vigani1/pertexo/pull/139)'s earlier
`06917f74` CI recovery and integration lanes exposed the same older HTTP-worker
fixture reset failure after a legitimate email credential rotation: restoration
omitted the revision-aware protocol. Repair `7abbc106` changes test fixtures only,
advances revision and clears current-credential health on version restoration,
and leaves revoked rows unchanged. A separate connection regression proves
restoration is idempotent and cannot roll back a revoked current version. The
same four recovery files pass 22 cases; full enabled worker integration passes
22 files / 47 cases, both strict zero-skip. Worker units (903 cases), full build,
worker lint/typecheck, complexity, duplication and CI routing pass. Production
source and its qualified coverage fingerprint are unchanged. The downstream
API integration cohort passes 21 files / 109 cases with the unchanged CI
exclusions; API SSE reconstruction and worker transport service-loss recovery
each pass one enabled case. All reports pass strict zero-skip validation.
Owned fixture services/data were removed after zero-client/database/proof-key
checks. These local results are historical and recorded in the CI-repair receipt.

Independent feature specification and standards reviews accepted the
implementation and repairs. PR139 merged reviewed head
`94509ee87171f1b06777aa692f7409edf675efca` as
`4ad9f8afe7a82184e2356345eaeed3492688dfe5` after exact-head
[CI](https://github.com/vigani1/pertexo/actions/runs/36830092069) and
[CodeQL](https://github.com/vigani1/pertexo/actions/runs/36830092139) passed.
Its [first natural-main run](https://github.com/vigani1/pertexo/actions/runs/36831587356)
failed one statistics plan assertion. A retained
pre-insert snapshot reproduced the bitmap-scan symptom and showed that a
successful VACUUM alone did not establish all-visible fixture pages. Test-only
[PR140](https://github.com/vigani1/pertexo/pull/140) added bounded snapshot
readiness, explicit visibility assertions, a regression and diagnostic plan
output without changing queries, planner settings or performance budgets.
The original failed CI run captured no snapshot/plan state, so its precise
cause remains unconfirmed. No unchanged failed run was retried for qualification.
Local repair evidence passes 796 database integration tests, all 20 statistics
cases and 891 database unit tests; both independent repair reviews found zero
findings.

PR140 merged reviewed head `0b22c49448d314ee9917dad6094cd7c771f5e9a8` after
exact-head [CI](https://github.com/vigani1/pertexo/actions/runs/36835574309) and
[CodeQL](https://github.com/vigani1/pertexo/actions/runs/36835574239) passed.
Final natural main `adaa26df5f31ad4bbf69429f091f77acc707bf70` passed
[CI](https://github.com/vigani1/pertexo/actions/runs/36837670529) and
[CodeQL](https://github.com/vigani1/pertexo/actions/runs/36837670516).
All applicable lanes passed, including integration, recovery, browser, coverage,
production image, compatibility and deployment security; dependency review was
appropriately skipped on main and passed on the PR. Final qualification and
the indexed local evidence are recorded in
`/Users/vigan/.codex/evidence/pertexo-f30-2026-10-01/final-receipt.md`.
Owned disposable services were removed; unrelated primary-checkout work and
everyday services were preserved. `CONNECTION_RUN_HEALTH_MODE` remains `off`.
This closes only F30's planned narrow Slack slice, not production activation or
any other phase.

### F29 — queue-only workflow concurrency

The ADR058 queue-only first slice is qualified. Independent specification and
standards reviews closed the correctness and CI-ownership findings; final
rereviews reported no remaining findings. [PR138](https://github.com/vigani1/pertexo/pull/138)
merged reviewed head `7561e822` as `02750811c0bbb8545042f96f9f6f53784c9ff5d2`
on 2026-10-01. Required exact-head checks and natural postmerge CI/CodeQL passed.
This does not close Phase 7 or supersede the
historical qualification fingerprints below. F12 PR137 is merged as `23cc5b45`;
the release owner has confirmed natural main CI and CodeQL success on that
commit, closing the first read-only capacity/activity slice's qualification.
This satisfies the F12 dependency independently of F29's completed qualification.

- [x] Current workflow cap, durable acceptance tickets, workspace-authoritative
      admission, ordered starts, and grandfathered reservations implemented.
- [x] Authorized CAS/idempotent settings commands and timestamped queued-run
      blockers implemented with settings/history UI.
- [x] Real PostgreSQL proof: 22 concurrency cases plus 18 existing regression
      cases; 878 database unit tests. Coverage includes reverse starts, shared
      workspace capacity, settings/acceptance races, control-path delivery,
      legacy upgrade, role boundaries, and readiness drift rejection.
- [x] Repaired full PostgreSQL suite: 104 files / 753 tests passed. The privileged
      trigger-disabled terminal-history seed allocates mandatory tickets
      explicitly; its normal-planner budgets remain unchanged.
- [x] Real HTTP proof: three authorization, command, replay, and policy cases.
- [x] Repaired enabled non-artifact API service cohort: 19 files / 86 tests
      passed, zero skips under strict JSON validation. Artifact-transfer,
      compatibility rollout and the editor/Usage/concurrency browser files were
      explicitly excluded; F29's live browser proof below ran separately.
- [x] Real API/worker/browser proof: cap 1 leaves the second run queued with no
      node execution; an acknowledged worker-runtime restart preserves state;
      browser removal releases the second run with ordered start timestamps.
- [x] Repaired head `9bda9ee8` passed `pnpm check`: full build, typecheck, lint,
      contracts, architecture, complexity, duplication and unit suites passed
      (API 1,790, worker 868, database 878, web 798 tests).
      Changed React Doctor score: 100/100.
- [x] Repaired tree passed `pnpm test:coverage`: 24 cohorts bound to source
      fingerprint
      `sha256:7d10d5483a39527bae8ca485fb738fad60461e6c18ad1cae80eb22cb9fe64a44`;
      zero unreviewed / 390 reviewed residual branches across 210 selected
      files and 8,075 coverable lines. No review, exclusion or budget changed
      during the repair qualification. The pre-review witness was
      `sha256:198aa04d84d05ffc8c94893acc070ff10e50930640ab59d7b546829c04a82581`.
- [x] `pnpm test:browser-probes` (seven assertions) and
      `pnpm deployment:check` (60 assertions) passed locally.
- [x] Lock order, mixed-version fail-closed enforcement, and rollback documented
      in [the enforcement note](./operations/workflow-concurrency-enforcement.md).
- [x] Independent manager review and complete first-slice release qualification.
- [x] Close the reviewed active-insert serialization race, preserve committed
      reservations during FIFO deferral, and cancel stale reads before
      denied-write cache eviction; focused RED/GREEN proofs recorded below.
- [x] Requalify the repaired tree locally with repository checks, coverage,
      full PostgreSQL, real HTTP/browser, browser probes and deployment checks.
- [x] Complete independent rereview of the repaired implementation.
- [x] Scoped PR merged with required checks; natural postmerge result inspected.

The PostgreSQL receipt proof exercises bounded maintenance reaping and verifies
both new tables in the authoritative tenant purge function; it does not claim
an executed tenant-row purge. The live restart is a worker-runtime lifetime
restart, not an operating-system process kill. Skip overflow and independent
queue configuration remain deferred. No production deployment or activation
was performed.

Implementation commits: `c02f0ce4` (database/contracts/API) and `36392cdb`
(settings/history UI and integrated proof). Normal merge `a3f0af4c` incorporates
the manager-reviewed F12 qualification repairs; it is not a release or postmerge
main qualification claim.

The CI-routing follow-up normally merged F12's reviewed browser-owner fix
`80621acb` in `f1b4cb4`, then gives the concurrency fixture its own required
browser-installed CI step and ordinary/local cohort exclusion. Local execution
with the CI environment and an attested task-owned Compose project passed
one live test; the unchanged strict JSON validator accepted it with zero skips.
Ownership unit tests cover 45 accepted and rejected configurations. CI routing
and local-quality contracts pass; this is not a hosted CI completion claim and
does not change the manager's fixed-point core implementation review.
The exact task-owned Compose CI proof project was retained through repair
verification, then removed with its two disposable volumes after checking zero
fixture databases, zero base clients and empty Redis DB11. Its browser/worker
lifetimes had closed. No everyday service was adopted.

The review fixes were reproduced before implementation. Eight real PostgreSQL
API/worker × running/waiting × marked/unmarked INSERT races observed the writer
blocked by the authenticated settings transaction, then incorrectly committed
after the cap. The post-counter policy check now rejects all eight with the
expected `PTC01`/`PTC02`. A real coordinator-store test reproduced B's lost slot
when cap 2 reservations were lowered to 1 and B arrived before A. The repaired
path preserves and rebinds B's reservation through deferral, duplicate delivery
and store restart; A then B start using their committed slots, without a third
grant. Twelve new regressions (the nine original failures plus worker/context,
binding and real-recovery boundaries), the existing 22 concurrency cases and
19 coordinator scheduling cases pass: 51 assertions. Readiness mutation tests
reject helper body and execution-ACL drift for API, worker and dispatcher.

Frontend commit `2a8d89f0` cancels the exact protected settings read before cache
eviction. All 21 settings tests pass, including held GET + denied PUT
401/403/404 with real HTTP and cancellation-ignoring reads, remount/network
failure and fresh authorized recovery; changed React Doctor remains 100/100.
The new reservation helper is worker-only and readiness pins its body and exact
ACL; the trigger fingerprint now includes its serialized second policy check.

Database repair commit `9bda9ee8` passed the full PostgreSQL suite and repository
checks. The repaired real HTTP proof passed 3/3 and the CI-environment live
API/worker/browser proof passed 1/1, both with zero skips under strict JSON
validation. Normal merge `7953fd6a` incorporates PR137's main merge `23cc5b45`;
the merged tree is exactly identical to its first parent `9bda9ee8`. Conflicts
retained the already-merged F12 behavior and reviewed F29 migration/CI additions;
one automatic duplicate type import was removed. CI gate tests and API typecheck
also passed after resolution. The subsequent manager receipt confirms natural
main CI `36806860550` and CodeQL `36806860572` both concluded `SUCCESS` on
`23cc5b45`; see the [F12 evidence log](./feature-plans/12-usage-and-insights.md#delivery-tracker).
These hosted F12 results are not inferred from local qualification and do not
establish F29 hosted CI or release approval. F12 warnings/trends remain deferred.

Final repair qualification passed `pnpm test:coverage` (24 source-bound cohorts,
zero unreviewed residual branches), seven browser probes and 60 deployment
assertions. The enabled non-artifact API cohort passed all 86 cases after the
normal migration bootstrap of this task's previously empty owned base database.
The earlier broader API attempt failed on missing `app.auth_identities`; this
was a local setup omission, not masked by exclusions or test changes. Likewise,
an unchanged benchmark SIGINT process-startup timeout passed in isolation and
in the full `pnpm check` rerun with its original deadline. Generated JSON reports
were preserved outside the checkout, not committed. Required independent
rereview and F29 release/PR checks subsequently closed by the release-owner
receipt below; F12 natural main qualification is independently complete.

Heavy qualification suites were serialized after concurrent runs hit unchanged
workflow-engine and coordinator-observation test timeouts. Isolated observation
tests and the final full database suite passed with their original budgets;
no production code, timeout, or gate was changed to hide those failures.

Both the original and follow-up task-owned PostgreSQL/Redis projects were removed
after qualification;
their disposable fixture data was discarded. Everyday services and the 43
uncommitted paths in the primary checkout were left untouched. The F29 branch
was subsequently pushed and tracks `origin/feat/workflow-concurrency`.

The release owner's 2026-10-01 receipt confirms exact-head
[CI36810146630](https://github.com/vigani1/pertexo/actions/runs/36810146630) and
[CodeQL36810146584](https://github.com/vigani1/pertexo/actions/runs/36810146584)
passed before PR138 merged. Natural main
[CI36811514908](https://github.com/vigani1/pertexo/actions/runs/36811514908) and
[CodeQL36811514931](https://github.com/vigani1/pertexo/actions/runs/36811514931)
both succeeded on exact merge head `02750811c0bbb8545042f96f9f6f53784c9ff5d2`.
The main-push dependency-review skip is expected; applicable quality,
integration, browser, coverage, recovery, compatibility, deployment-security
and production-image checks passed. Queue-only qualification is complete;
skip overflow remains deferred and Phase 7 remains open. No production
deployment or activation is claimed.

### Historical backend qualification

The backend fixes are recorded in commit `f0484564`. The final SSE
public-projection correction keeps the original validation error, starts the
transport cleanup budget before awaiting an uncooperative nested iterator, and
observes late fulfillment/rejection without leaking resources. The full API
run passed 97 files / 1,277 tests.

The pre-cleanup full local qualification,
`pertexo-local-quality-2026-09-14t09-35-41-831z-24290-031bb08c`, passed all 21
required cohorts at full-run candidate fingerprint
`sha256:37fb33395ed496f5fbfb5dda82ac221c03bbc54b802155569a37ae6079d28743`.
Its app/package source inventory fingerprint is
`sha256:b460ce440131ff15831907d051f0b062f7f1e943ad538925a4c2bd6872c7d01c`.
The source inventory accounts for 691 files, and risk evidence records 405
reviewed / 0 unreviewed branches across 186 selected files and 7,500
coverable lines. This fingerprint and evidence describe the pre-cleanup
candidate only; they are not a claim about the post-move source tree. Local
service evidence contains 665 assertions. The only
exclusions are the three declared AWS-only control-ledger cases. This remains
local qualification; that run did not perform hosted CI, deployment, provider
requests, or AWS operations.

The subsequent documentation and infrastructure organization passes
`pnpm prepush:check`, `pnpm deployment:check`, `pnpm images:check`, and
`pnpm exercise:check`. The new documentation checks retain link and current
operational-policy validation without requiring retired audit records.
Fresh coverage binds all 24 producer cohorts to app/package source fingerprint
`sha256:52bccd43d4b33466f1d2228a9a4edb663eae9ca0fdceebc65610ecc6fd07e9cd`.
`pnpm coverage:evidence` regenerated the [source inventory](./remaining-work/source-inventory.json)
and [risk snapshot](./remaining-work/risk-snapshot.json): 691 sources, zero
unmapped runtime files, and 405 reviewed / zero unreviewed residual branches.
Source-to-test mapping is not execution coverage. These checks verify the
cleanup; the service-backed qualification above remains explicitly pre-cleanup.

## Status summary

| Checkpoint | Status | Evidence retained |
| --- | --- | --- |
| Phase 0A — repository and process skeleton | Complete | ADR 001; API/worker bootstrap and lifecycle checks; `pnpm check` |
| Phase 0B — PostgreSQL tenancy and RLS proof | Complete | ADR 003; clean PostgreSQL migration and RLS integration matrix |
| Phase 0C — HTTP and observability foundation | Complete | Compiled API/worker role, health, and telemetry smoke checks |
| Phase 0D — queue, outbox, and duplicate-delivery proof | Complete | ADRs 005–006; unit, real-service, and recovery assertions |
| Phase 0E — execution durability and engine gate | Complete | ADRs 005, 007–009; engine, process-recovery, SSE-outage, and transport-outage proofs |
| Phase 1 — identity/workspace vertical slice | Complete | ADR 004; generated-contract drift and real-service identity/RLS evidence |
| Phase 2 — workflow authoring vertical slice | Complete | ADRs 002/011; draft, publication, lifecycle, and version-restore evidence |
| Phase 3 — first executable-node slice | Complete | ADR 010; compatibility, execution, rollout, and recovery evidence |
| Phase 4 — first side-effecting integration slice | Complete | ADRs 007/016; PostgreSQL/outbox/BullMQ retry-wakeup and recovery evidence |
| Phase 5 — orchestration slice | Complete | ADRs 008, 017–022; branching, parallelism, retry/wait, notification, and recovery matrix |
| Phase 6 — V1 providers and triggers | Complete | ADRs 012–014, 023–026; provider, webhook, schedule, retained-history, and rollout evidence |
| Phase 7 — production operations | **In progress** | Repository implementation is qualified locally; external deployment, provider, load, recovery, telemetry, and pager evidence remains open |
| F29 — queue-only workflow concurrency | Qualified | ADR058 queue-only slice, independent reviews, PR138 exact-head and natural main CI/CodeQL; skip overflow deferred |
| F30 — first Slack connection-health slice | Qualified | ADR059 narrow Slack slice; independent reviews, PR139/140 exact-head checks and natural main CI/CodeQL on `adaa26df`; production mode off |

The 0A–0E rows subdivide the plan's single Phase 0 and do not change its
authoritative scope. All accepted architecture decisions remain under
[`adr/`](./adr/); their presence governs implementation but does not close
production gates.

## Phase 7 — Production operations

Status: **In progress**

### Authority and production policy

- [x] ADR 013 governs destructive retention, workspace purge, legal hold, and
      backup-erasure behavior.
- [x] ADR 015 fixes the initial SLO, hosting regions, backup, failover,
      recovery, RPO, and RTO strategy.
- [x] Operated legal authority, backup rotation, minimization, and retention
      policy inputs are recorded without claiming legal certification.
- [x] ADR 027 governs asynchronous tenant-facing deletion and restore dispatch.

### Retention, deletion, and legal hold

- [x] Dedicated maintenance credentials and migration-role substitution are
      bounded and do not grant serving-role access.
- [x] External control-ledger adapters, ordered PostgreSQL projection,
      high-water reconciliation, and restore-before-serve are implemented.
- [ ] Prove the dual-region append-only ledger and restore-before-serve gate
      against production AWS accounts, regions, IAM roles, and Object Lock.
- [x] Legal-hold placement/release, bounded resumable retention, leases,
      fencing, dry-run support, and dependency-safe 30/90/365-day retention are
      implemented.
- [x] Workspace deletion/restore revokes access and triggers, cancels work,
      preserves the recovery window, and records retryable purge progress and a
      non-sensitive completion tombstone.
- [ ] Prove deletion, legal hold, recovery-window, purge, and regional object
      behavior through production deployment and immutable invocation evidence.

### Operator recovery and observability

- [x] Authenticated, authorized, audited, reason-required operator commands
      cover outbox redispatch, lease reconciliation, due-work resume,
      unknown-outcome evidence, cancellation, replay, trigger reconciliation,
      and retention/purge reruns.
- [x] Cardinality-safe metrics and repository-owned dashboards/alerts cover
      API, PostgreSQL, queues, workers, triggers, providers, artifacts,
      retention, purge, and the control ledger.
- [ ] Deploy dashboards and alerts and capture pager-routing/response evidence.
- [x] Non-root, read-only, digest-pinned image/task contracts, separate
      commands and health checks, release-job migrations, and secret-manager
      references are validated locally.
- [ ] Prove rendered image, task-role, filesystem, migration-job, health, and
      secret-manager boundaries in the production deployment.
- [x] Separate API/worker autoscaling inputs are declared against admitted
      load, latency/saturation, oldest-job age, active slots, and resource
      safety.
- [ ] Deploy and measure autoscaling under representative load and saturation.

### Release exercises and completion gates

- [x] The source-stable local quality checkpoint passes coverage, mutation,
      performance, integration, deployment-rendering, recovery, and cleanup
      gates, with explicit AWS exclusions.
- [ ] Run webhook bursts, large fan-out, long-wait, and noisy-tenant load tests
      and prove fair admission under saturation.
- [ ] Run Redis-loss, PostgreSQL-failover, provider-outage, worker-drain, and
      object-storage failure exercises without contradictory durable truth.
- [ ] Run backup/PITR and regional restore drills, reconcile the control ledger
      before traffic, and measure five-minute RPO / 24-hour RTO.
- [x] Root checks, dependency/security scans, migration checks, real-service /
      recovery matrices, and production-build verification pass locally.
- [x] Fixed-head review blockers and high findings are resolved through the
      implementation checkpoint; this does not close external gates.

### Current Phase 7 evidence and open obligations

The local qualification above is paired with the active operational contracts:
[external platform](./operations/external-platform-contract.md), [local
quality](./operations/local-quality-verification.md), [regional recovery](./operations/regional-recovery.md),
[database function readiness](./operations/database-function-readiness.md),
[release/security gate](./operations/release-security-gate.md), [observability
alerts](./operations/observability-alerts.md), and [production data policy](./operations/production-data-policy.md).
These documents define owners, bounds, evidence schemas, cleanup, and explicit
limits; they do not assert deployment.

The remaining named external evidence families are:

- **ART-002:** production artifact latency and capacity observations.
- **ART-008:** live AWS dual-region artifact and recovery qualification.
- **DB-011:** representative PostgreSQL workload, planner/cache, lock/WAL,
  vacuum, and index-usage evidence at expected and burst cardinality.
- **DB-017:** deployed backup/PITR, restore, pooler, failover, RPO/RTO,
  autovacuum, replica-admission, and capacity evidence.
- **INT-010:** protected Slack, Resend, and AWS KMS sandbox compatibility.
- **INT-013:** production-like DNS/connect/TLS concurrency and latency before
  changing the safe no-pooling policy.
- **OBS-006:** production telemetry retrieval and alert/pager proof.
- **RL-002:** deployed non-clustered replicated Redis topology compatible with
  the atomic multi-key rate-limit policy.

The separately authorized Q14/E01 evidence packet covers deployment, storage,
security, provider, load, failure, pager, migration/PITR, regional recovery,
deletion, restore, and purge drills. Every drill requires identity, access,
command, capability, result, and cleanup fields. A completed packet is not
execution evidence; production accounts and deployed infrastructure are still
required. API-key and connected-subscription entities remain deferred by the
V1 scope and must not be invented solely to satisfy deletion coverage.

## Requirement-to-evidence navigation

| Plan area | Canonical owners | High-value proof |
| --- | --- | --- |
| Foundation and process roles | `apps/api/src/main.ts`, `apps/worker/src/main.ts` | API bootstrap and worker lifecycle tests |
| Identity, tenancy, and security | `apps/api/src/identity-workspace/`, `packages/database/src/tenant-access/` | Real identity HTTP and RLS integration tests |
| Authoring and publication | `apps/api/src/workflow-authoring/`, `packages/database/src/authoring/` | Lifecycle and version-restore integration tests |
| Execution, queues, and recovery | `packages/workflow-engine/`, `packages/database/src/execution/`, worker coordinator | Parallel assurance and redelivery/recovery tests |
| Integrations and connections | `packages/integrations/`, API connections | HTTP executor and connection integration tests |
| Providers and triggers | API webhooks, worker triggers, database trigger stores | Direct webhook and schedule recurrence integration tests |
| Artifacts and capacity | `packages/artifact-store/`, database artifact authority, API artifact controller | Dual-region store and artifact transfer tests |
| Operations and recovery | retention/recovery apps, database lifecycle, `infrastructure/ecs/` | Retention inventory and restore-before-serve tests; external evidence remains open |

These routes locate responsibility; they are not independent completion claims.

## API discovery gap closure

The four previously unallocated read surfaces are implemented and verified
locally: `GET /v1/users/me`, workspace member listing with opaque keyset
pagination, `GET /v1/node-definitions`, and `GET /v1/integrations`. They use
existing authentication/rate limits, bounded public projections, authorization,
RLS, generated contracts, and deterministic catalog selection. They do not add
profile administration, invitations, membership mutation, connection
credentials, or a second connection resource. Later identity slices add role
changes and removal (ADR 037, ADR 042), invitations (ADR 038), the
signed-in person's own display-name change (ADR 043), and leaving,
suspension, reactivation and ownership transfer (ADR 047).

## Weft follow-up reads

Post-plan read surfaces close gaps the Weft frontend recorded, each behind its
own ADR and implemented through contracts, database, API, integrations and
web:

| Surface | Route, authority and rate class | Decision and storage |
| --- | --- | --- |
| Webhook delivery log | `GET /v1/workspaces/:workspaceId/workflows/:workflowId/triggers/:triggerId/webhook/deliveries`; `workflow:read` guard plus the owner/admin/builder trigger-read check; `authenticated_read` | [ADR 045](./adr/045-webhook-delivery-log.md). Migration `0115_webhook_delivery_log.sql` adds outcome, HTTP status, signature and replay checks and body size to `app.webhook_trigger_deliveries`. Post-allowance rejections are recorded best effort in their own transaction; the 90-day retention class, RLS and purge are unchanged, and expired rows are never served. |
| Slack channel names | `GET /v1/workspaces/:workspaceId/connections/:connectionId/slack/channels?channelIds=…`; `connection:use` guard and database check; `provider_test` | [ADR 046](./adr/046-slack-channel-name-resolution.md), extending ADR 023. Up to ten IDs per request resolve through `conversations.info` with the connection's bot token under the `connection.credential_accessed` audit fact; names are never stored and unresolved channels return a reason instead of an error. No migration. |
| Schedule run history | `GET /v1/workspaces/:workspaceId/workflows/:workflowId/triggers/:triggerId/schedule/occurrences`; `workflow:read` guard plus the active-member schedule-read check; `authenticated_read` | [ADR 048](./adr/048-schedule-fire-history-and-next-runs.md). Pages the occurrences the scanner already records (`accepted` with its run, or `skipped`), newest first, with a trigger-bound cursor; occurrences past the 90-day trigger-summary cutoff are never served. Throttled or failed claims stay trigger health. No migration: the existing occurrence index serves the keyset. |
| Schedule next runs and draft preview | `GET …/triggers/:triggerId/schedule/next-runs?count=` (`authenticated_read`) and `POST …/triggers/schedules/preview` (`workflow_compile`, CSRF); same authority | [ADR 048](./adr/048-schedule-fire-history-and-next-runs.md) on ADR 014. The persisted next fire, then the instants the scanner would persist, 1–10 (default 3), from the scheduler's own engine, timezone and DST rules and database time. The preview checks an unsaved Schedule step setup with the scheduler's parser and runs in a read-only transaction. The engine caches one `Intl.DateTimeFormat` per canonical timezone. |
| Run data | `GET /v1/workspaces/:workspaceId/runs/:runId/input` and `GET …/runs/:runId/node-runs/:nodeRunId/output`; `run:read` guard; `authenticated_read` | [ADR 050](./adr/050-run-data-reads.md). Returns a run's stored input or one node run's stored output (inline JSON, an artifact reference, `none`, or an input `expired` past its 30-day window) from a workspace-scoped read transaction. Run summaries add `replaySourceRunId`; list items add `failedStep`, named from the run's version graph (nested loop steps included) by one bounded extra query for the page's unsuccessful runs. No migration. The web run page shows each step's Data in and Data out, the run's input with Replay starting from it, and the replay source; run lists say where a run failed. |
| Step history and health | `GET /v1/workspaces/:workspaceId/workflows/:workflowId/step-health` and `GET …/workflows/:workflowId/steps/:nodeId/runs?limit=`; `run:read` guard; `authenticated_read` | [ADR 051](./adr/051-step-history-and-health.md). Both read the workflow's newest 100 runs through the existing workflow and node-run indexes: per step, how often it ran, succeeded, failed or was skipped, its latest status and the median and 95th percentile duration of its successful runs; and one step's latest runs with the run each belongs to. No migration. The editor's step panel gains a Runs tab (health, last result, recent runs) and workflow settings a Steps section ordered by failure rate. |
| Recorded step inputs | `GET /v1/workspaces/:workspaceId/runs/:runId/node-runs/:nodeRunId/input`; `run:read` guard; `authenticated_read` | [ADR 052](./adr/052-record-step-inputs.md). Before its executor runs, each attempt of a step that doesn't use a connection records its resolved input on `app.node_runs.input_ref` under the attempt's lease and fence, best effort and inline only (256 KiB). Admitting a retry clears its predecessor's input, so none passes for another attempt's; a resumed wait keeps its step's. Migration `0119` grants the worker `UPDATE (input_ref)`, and the readiness probe requires it. Steps that ran before read `none`. The run page's Data in shows the recorded input, with where it came from underneath, and otherwise says why there is none and labels the source data as such. |

Evidence: database integration tests on disposable databases
(`webhook-triggers`, `webhook-trigger-prior-head`, `connection-lookup`,
`schedule-trigger-reads`, `workflow-run-api`), DST-boundary projection tests
(`schedule-fire-projection`), the
direct-webhook HTTP integration test, API unit and coverage suites (the delivery
recorder joins the priority cohort and the channel lookup the orchestration
cohort), the API bootstrap HTTP test for the schedule routes, the Slack client
tested against a mocked HTTP boundary, regenerated webhook, connection and
schedule OpenAPI artifacts, and web component and hook tests. Recorded step
inputs are covered by `coordinator-run-store-node-attempts` (recorded under a
live lease, nothing once it is lost) and `workflow-run-api` (read back, `none`
before recording), and were checked against a local stack, where a scheduled
run's steps each recorded what their executor received. Live Slack
workspaces and deployed traffic were not exercised.

## Update protocol

When a checkpoint changes status:

1. Update its checklist and the summary table together.
2. Record concrete ADRs, commits, commands, tests, measured results, or drills.
3. Leave incomplete and deferred requirements unchecked with their blocker.
4. Never mark complete from generated files, unit tests, or prose alone.
5. Re-run the documentation and relevant implementation gates after structural
   changes before treating this tracker as release evidence.
