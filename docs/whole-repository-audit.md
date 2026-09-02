# Current Whole-Repository Engineering Audit

Recorded: 2026-09-02

Audited implementation tree: `640cbea4d5fcc6972bf30ad09466dcb9e818409e`

Status: current findings, remediation state, and remaining external evidence

## 1. Executive conclusion

The repository-controlled implementation is strong. This audit refresh was
followed by focused remediation at the fixed implementation snapshot above.
The PostgreSQL recovery control seam, Node runtime/type alignment, the eight
named complexity hotspots, the two same-owner helper clones, digest-bound local
image evidence, dependency grouping, and risk-coverage ratchets are now
implemented and locally verified.

Critical API failure-branch remediation raised API branch coverage from 84.45%
to 99.64%, increased the unit suite from 1,336 to 1,372 assertions, and reduced
the unreviewed selected-file branch inventory from 361 to 317. The documentation
gate added during that work exposed a merge-governance defect recorded as C-12:
the rebase-style merge rewrote the recorded audit commit, and protected CI did
not execute the new documentation command. The gate now binds the audit to a
merge-stable Git tree, has a rebase-style regression fixture, and runs from the
protected quality job with complete history. Protected execution of that updated
job remains to be observed before C-12 closes.

The project is still not production-ready. Live AWS, provider-control,
independent-review, registry-signing, load, failover, pager, backup/PITR, and
regional-recovery evidence cannot be manufactured by repository tests. The
previous red `main` recovery run is historical evidence. Pull request #7's
replacement run `33465359665` passed every protected context, including the
recovery and integration jobs, so C-02 is closed.

- Continue development: **GO**
- Claim local repository checks are green: **GO**
- Claim protected remote checks for this implementation: **GO**
- Claim protected CI has executed the updated canonical documentation gate:
  **NO-GO pending this pull request's run**
- Claim Phase 7 or production readiness: **NO-GO**

## 2. Review method and external calibration

This is a repository assessment, not an industry percentile or a certification.
No authoritative engineering standard defines a universally correct repository
size, package count, function length, abstraction count, or coverage percentage.
Those values are useful only when they expose change cost, unclear ownership,
weak verification, or operational risk.

The review combines direct evidence from this repository with these established
frameworks:

| Review dimension | External calibration | How it was applied here |
| --- | --- | --- |
| Module and interface design | The local codebase-design framework: deep modules, narrow interfaces, locality, and real seams | Reviewed package purpose, dependency direction, public exports, sibling-internal imports, abstraction depth, and complexity hotspots; did not classify code as defective from line count alone |
| Code health and reviewability | Google's [code-review standard](https://google.github.io/eng-practices/review/reviewer/standard.html), [review checklist](https://google.github.io/eng-practices/review/reviewer/looking-for.html), and [small-change guidance](https://google.github.io/eng-practices/review/developer/small-cls.html) | Reviewed design, functionality, complexity, naming, comments, documentation, tests, style, change focus, and whether the ratchet makes code health improve rather than decay |
| Type safety | TypeScript's official [`strict` guarantees](https://www.typescriptlang.org/tsconfig/strict) plus runtime trust-boundary validation | Verified strict compilation, exact response contracts, generated-contract checks, runtime parsing, and localized assertions; did not treat static types as validation of untrusted input |
| Secure development lifecycle | [NIST SSDF SP 800-218](https://csrc.nist.gov/pubs/sp/800/218/final) and the [OWASP SAMM model](https://owaspsamm.org/model/) | Checked governance, secure design/build/deployment, dependency handling, architecture and security verification, defect response, and operational controls |
| Repository security | [OpenSSF Scorecard](https://github.com/ossf/scorecard) and GitHub's [protected-branch controls](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches) | Checked branch protection, review policy, automated dependency updates, scanning, workflow permissions, and pinned/reviewed build inputs |
| Artifact integrity | [SLSA build provenance](https://slsa.dev/spec/v1.2/build-provenance) and [GitHub artifact attestations](https://docs.github.com/en/actions/concepts/security/artifact-attestations) | Distinguished an SBOM and vulnerability scan from cryptographically verifiable, digest-bound provenance and deployment identity |
| Test design and signal | Google's [test-size model](https://testing.googleblog.com/2010/12/test-sizes.html) and [flaky-test evidence](https://testing.googleblog.com/2017/04/where-do-our-flaky-tests-come-from.html) | Reviewed small, integration, and destructive-system cohorts separately; treated nondeterminism as a reliability defect even when an immediate local rerun passed |
| Delivery performance | [DORA](https://dora.dev/) | Used CI stability and change controls where repository evidence exists; did not claim an industry delivery ranking because deployment frequency, change lead time, failed-deployment recovery time, change-failure rate, and rework telemetry are not available |
| Production readiness | Google's [SRE production-readiness review model](https://sre.google/sre-book/evolving-sre-engagement-model/) | Required observed evidence for architecture dependencies, monitoring, emergency response, capacity, change management, availability, latency, and efficiency rather than accepting repository contracts as production proof |

The external frameworks influenced what was checked and what constitutes
evidence. They do not supply the numeric scores below. The scores use this audit
rubric:

| Score | Meaning in this audit |
| ---: | --- |
| 10 | Strong implementation, automated regression protection, and current operational proof; no material known gap |
| 9 | Strong implementation and verification with only bounded or external evidence gaps |
| 8 | Sound engineering with at least one material maintainability, CI, governance, or proof gap |
| 7 | Functional foundation with important risk concentration or incomplete verification |
| 5–6 | Substantial release or operational blockers despite useful foundations |
| Below 5 | Foundational correctness, security, or maintainability weakness |

Intermediate decimals express position inside a band; they are not statistical
precision. **9.0 codebase engineering quality** is the arithmetic mean of the
first ten code, data, security, test, CI, and reliability rows below. **8.6
overall state** is the arithmetic mean of all fourteen rows. Neither number is
an industry percentile, and future audits must retain the same rows and rubric
for trend comparisons.

## 3. Current scores

Scores are evidence-based engineering judgments, not a universal formula. A 10
requires both a strong implementation and convincing automated or operational
proof.

| Area | Score | What prevents a higher score |
| --- | ---: | --- |
| Architecture and domain ownership | 9.2/10 | Secondary large closures remain characterization candidates |
| Readability and maintainability | 8.8/10 | Complexity is reduced and ratcheted, not eliminated |
| TypeScript and runtime contracts | 9.2/10 | Repository-owned contracts are strong; third-party and deployed-provider compatibility still require maintained runtime schemas and observed evidence |
| Reuse and package design | 9.0/10 | Current package interfaces are disciplined, but their ongoing depth and ownership still need change-history evidence |
| PostgreSQL and data integrity | 9.0/10 | Live capacity, backup, failover, and scale behavior unproved |
| Application security | 9.0/10 | No current application exploit was found; provider-control canaries and deployed adversarial evidence remain absent |
| Repository and supply-chain security | 8.7/10 | External canaries, signed registry provenance, and independent review absent |
| Testing | 9.1/10 | Critical coverage is risk-selected rather than repository-wide |
| CI and change governance | 8.7/10 | The quality job now includes the canonical documentation gate, but its first protected pull-request and post-merge executions remain to be observed |
| Reliability and durability | 9.1/10 | Recovery control is green locally and remotely; deployed failure proof remains open |
| Observability and operability | 8.5/10 | No deployed pager/operator proof |
| Performance and scalability | 7.5/10 | No representative deployed load or aggregate DB capacity proof |
| Documentation and governance | 8.7/10 | The validator exists, but its first publication exposed rebase-merge identity and CI-enforcement gaps |
| Production readiness | 5.5/10 | Phase 7 live evidence remains incomplete |

Overall codebase engineering quality: **9.0/10**.

Overall state including production readiness: **8.6/10**.

### 3.1 What passing tests and coverage mean

`pnpm check` passing means every configured build, static check, contract check,
complexity check, type check, and all 1,372 currently defined unit assertions
completed successfully. The protected CI result adds the configured real-service,
compatibility, recovery, deployment-security, and production-image cohorts. This
is strong evidence that the behaviors exercised by those checks still work. It
does **not** mean that every source line, decision, failure mode, provider
interaction, or deployed operating condition was exercised.

Coverage answers a narrower question: which instrumented implementation paths
were executed by a particular test command. This repository intentionally gates
23 selected critical files rather than claiming whole-repository coverage.
Branch coverage is the most useful headline here because it measures alternative
decisions, not merely whether a line was touched. The current 79.34% workflow
engine, 61.53% database, 62.79% worker, and 99.64% API branch results therefore
mean that the configured floors pass while meaningful paths remain unexecuted.
The generated inventory records 317 uncovered branch sites as `unreviewed` and
one compiler-generated decorator branch as individually reviewed. Neither a
green test command nor a passing threshold silently classifies other sites as
safe.

Coverage percentage alone must not drive test work. Exercise consequential
authorization, tenancy, state-transition, retry, rollback, lease/fencing,
concurrency, timeout, idempotency, corruption, and provider-failure paths first.
Classify defensive or unreachable branches individually with durable evidence.
Do not add implementation-coupled assertions merely to increase a percentage,
and do not set a vanity 100% target that rewards deleting useful defensive
checks or testing private statements instead of module interfaces.

### 3.2 Evidence required to raise each score

Scores rise only after the relevant implementation and regression or operational
evidence exist. Completing a task without proving its effect does not by itself
raise a score. A 10 additionally requires current operational proof and no
material known gap, so several areas cannot reach 10 through repository-only
changes. This table is score-calibration guidance, not a second findings
register: Section 6 remains the canonical source for required work. “Preserve”
and “conditional” rows are regression or future-change rules, not current
implementation defects. C-03, the external portion of C-04, and C-08 are audit
assurance hardening; they do not silently extend the authoritative Phase 7
release criteria.

| Area | Best next improvement | Evidence required before raising the score |
| --- | --- | --- |
| Architecture and domain ownership | **Conditional:** characterize a remaining large persistence or coordination closure only after concrete change cost or unclear failure ownership is observed. Extract a private internal seam only where it improves locality; preserve the owning module's small external interface and do not add a hypothetical adapter. | Focused behavior and failure-path tests stay green; package dependency direction and public exports do not widen; complexity falls without extra queries, allocations, or latency. |
| Readability and maintainability | Work down the current complexity baseline when a hotspot creates real review or change cost. Prefer named policy/parser functions, explicit domain terms, short orchestration, and comments that explain invariants or reasons rather than restating code. | The ratchet records a lower hotspot, reviewers can trace success and failure paths locally, and focused tests plus the fixed-revision performance comparison show unchanged behavior and no material regression. |
| TypeScript and runtime contracts | **Preserve:** keep untrusted HTTP, queue, database, checkpoint, environment, and provider data behind runtime parsers. Add work only for a named unparsed trust seam; advance Node runtime and ambient types together. | Strict production/test type checks, generated-contract drift checks, negative parser fixtures, consumer compatibility tests, and deployed/provider compatibility evidence pass for the same versioned contracts. |
| Reuse and package design | **Preserve:** consolidate only same-owner behavior that shares an invariant and changes together. Keep cross-owner similarities local; remove pass-through exports or obsolete interfaces only when the deletion test shows they add no leverage. | No undeclared or circular dependencies, no sibling-internal imports, and bounded public export surfaces. A concrete shared change is fixed once without coupling unrelated packages. |
| PostgreSQL and data integrity | Prove worst-case connection budgets, pooler behavior, migration concurrency, backup/PITR, failover/failback, replica lag, tenant isolation, retention, and regional restore in the target environment. | Fresh reports bind database version, migration head, roles, workload, capacity arithmetic, recovery timings, integrity checks, and cleanup to the reviewed deployment; RPO/RTO and headroom meet the plan. |
| Application security | Add a focused adversarial test only when review identifies a missing authentication, authorization, tenancy, replay, abuse, payload, artifact, or lifecycle-command behavior. Existing negative matrices remain regression evidence. | The named gap has a negative unit/integration case, and a deployed security review finds no unresolved material exploit path. |
| Repository and supply-chain security | Complete the optional assurance hardening recorded canonically in C-03, C-04, and C-08: provider-control canaries, signed digest promotion, and independent review/signing identities when available. | CI, registry attestation, deployment manifest, and running task identify the same immutable digest; substitution tests fail; provider canaries are retained; future multi-maintainer controls reject unreviewed critical changes. |
| Testing | Review the 317 unreviewed selected-file branches and expand selection toward every critical policy module. Add mutation or failure-injection tests for high-consequence decisions, while retaining distinct unit, integration, compatibility, recovery, and production-image cohorts. | Every high-risk uncovered branch is exercised or individually justified; mutation canaries prove suites detect authorization/state-machine changes; thresholds ratchet upward; flake, duration, retry, and skip trends remain visible and bounded. |
| CI and change governance | Observe the updated protected quality job before and after its first rebase-style merge; then keep all required jobs reproducible and independently diagnosable, monitor action/runtime drift, observe Dependabot groups through real cycles, and remove the solo-review exception when another maintainer exists. | A fixture covers the supported merge strategy, repeated exact-tree runs execute the documentation gate and keep all 11 strict contexts green without blanket retries, failures retain useful artifacts, dependency updates are isolated and actionable, and a non-author approval/code-owner review protects critical paths when a second maintainer exists. |
| Reliability and durability | Run the existing crash, dependency-outage, backpressure, failover, restore, regional-loss, and replay exercises against immutable deployed versions under realistic concurrency. | Repeated reports demonstrate fencing, idempotency, no acknowledged-data loss outside the stated RPO, bounded recovery inside the RTO, correct degraded behavior, and successful cleanup with no unexplained intermittent failures. |
| Observability and operability | Deploy dashboards and alerts for the repository-defined SLIs, validate cardinality and trace correlation, exercise every operator command, and test pager routing plus escalation. | Synthetic incidents produce the expected metrics, traces, logs, alert, page, runbook action, ownership trail, and resolution timing; telemetry remains usable under load and during dependency failure. |
| Performance and scalability | Establish representative workload models and budgets for API latency, persisted-to-visible SSE latency, worker throughput, queue delay, artifact traffic, noisy-tenant fairness, autoscaling, and total PostgreSQL connections. | Repeatable deployed load reports record workload and versions, meet SLO/budget targets at expected and peak scale, demonstrate API/worker scaling independently, and identify a safe saturation and backpressure envelope. |
| Documentation and governance | Make fixed-audit identity compatible with the repository's rebase-style merge policy, keep the plan, ADRs, progress tracker, audit, runbooks, ownership, exceptions, and evidence links synchronized, and record measured delivery/incident evidence rather than inferred maturity. | The documentation validator passes before and after the supported merge flow, runs as a protected check with sufficient history, a fresh maintainer can reproduce the checks and operate a drill, and exceptions have owners and review dates. |
| Production readiness | Complete C-01 and close or explicitly accept every authoritative Phase 7 criterion using evidence from the immutable release candidate. C-03, C-04, and C-08 can raise audit assurance but are not backend-plan Phase 7 gates. | A production-readiness review links current capacity, availability, latency, telemetry, pager, backup/PITR, failover, regional recovery, runbook, rollback, and ownership evidence to one deployable version. |

### 3.3 Recommended order of work

Step 2 is the authoritative backend-plan release blocker. Steps 1 and 3–7 are
repository repair, audit hardening, or conditional maintenance and must not be
reported as unfinished Phase 7 criteria.

1. Confirm the configured documentation gate in protected pull-request and
   post-rebase `main` runs, closing C-12.
2. Complete live capacity, load, backup/PITR, failure, and regional-recovery
   evidence because these are the release-blocking unknowns in C-01.
3. Close the digest/signing/promotion chain and run the safe provider-control
   canaries in C-03/C-04.
4. Triage the 317 unreviewed branches by consequence, then add mutation and
   failure-injection tests before raising coverage floors.
5. Observe CI flake, duration, skip, retry, and Dependabot-group behavior over
   multiple real runs; fix trends rather than optimizing a single snapshot.
6. Refactor secondary complexity candidates only when characterization tests
   exist and the change demonstrably improves module depth or locality.
7. Add independent review and signing controls when the necessary second
   maintainer and identities exist; do not create a branch-protection deadlock.

## 4. Evidence checked for this implementation and publication

- On this publication branch at audited implementation tree `640cbea`,
  `pnpm check` passed formatting, documentation validation, runtime
  compatibility, build, ESLint,
  complexity, generated contracts, TypeScript, and 1,372 unit tests across all
  18 workspace projects.
- `pnpm test:coverage`: passed all current critical-module thresholds:
  workflow engine 79.34%, database 61.53%, worker 62.79%, and API 99.64%
  branch coverage. The generated report names the 23 exact selected files and
  records 317 uncovered branch sites as unreviewed and one exact reviewed
  compiler-generated branch; it makes no generated risk classification.
- The configured real-service matrix passed 5 artifact-store, 320 database, 21
  worker, and 14 API integration tests. The 3 artifact-store, 1 worker, and 2
  API provider-specific skips remained explicit.
- `pnpm security:audit`: no known production dependency vulnerability.
- `pnpm deployment:check`, `pnpm images:check`, and
  `pnpm exercise:check`: passed.
- GitHub security controls are enabled: secret scanning, push protection,
  vulnerability alerts, Dependabot security updates, and automated fixes.
- Protected `main` requires 11 strict contexts, including CodeQL and
  `production-image`.
- Exact-main CI run `33635957948` and CodeQL run `33635958168` passed, including
  5/8 artifact-store tests with three provider-specific cases pending and all
  320 database, 22 worker, and 15 API integration tests. The protected quality
  job did not execute `pnpm docs:check`, which is the open C-12 escape rather
  than evidence that the stale pre-publication audit head was valid.
- Pull request #7 CI run `33465359665` passed quality, compatibility, coverage,
  integration, recovery, deployment-security, production-image, and all three
  unit-test partitions; CodeQL run `33465359620` passed.
- The preceding audit-remediation pull request passed every protected context.
- Historical push CI run `33458288161` on the preceding `main` failed only in
  `recovery`. Its worker and API recovery reports passed, but the transport
  resilience suite failed while `docker compose up --wait postgres` observed
  the restarting container exit with status zero.
- The replacement transport resilience cohort passed three consecutive clean
  local Compose projects with no skip. It records container identity, permits
  only the documented clean-exit race retry, polls health to a deadline, and
  rejects unhealthy, nonzero-exit, or identity-changing failures.
- The worktree was clean before this documentation update.

## 5. Actual source-code review results

The research criteria were applied to production code and tests, not only to
repository configuration or prior audit prose.

### 5.1 Scope and structural statistics

- 18 workspace projects: six runnable applications and twelve capability
  packages.
- 86,749 TypeScript lines in production/configuration sources and 89,557 in
  package-local tests and test support.
- 3,419 functions or methods, 279 classes, and 317 declared interfaces.
- 48 functions span more than 200 lexical lines and 10 span more than 400.
  Many are deep factory functions whose span includes private returned methods;
  the branch ratchet, interface size, and invariant ownership determine whether
  they need refactoring.
- 10 classes span more than 200 lines. The largest are concrete AWS, BullMQ,
  dispatcher, expression, OIDC, and secure-HTTP adapters with cohesive external
  responsibilities; none is a cross-domain god class.
- The two same-owner consolidation candidates from the normalized-body scan
  are now owned by private HTTP-platform and artifact-store helpers. Other
  repeated adapter shells remain local intentionally.

### 5.2 Architecture, packages, and imports

- The workspace package dependency graph is acyclic.
- Each package owns a deployable capability, security role, deterministic
  model, or external adapter. Removing a package would move its complexity into
  several callers; no package currently fails the deletion test.
- There is no generic `shared`, `common`, or `utils` package.
- Database consumers import explicit `api`, `execution`, `lifecycle`,
  `maintenance`, `operator`, or `recovery` capability surfaces. ESLint rejects
  the broad database root and cross-runtime API/worker imports.
- API features are organized by business capability. Platform modules compose
  those features. The reused workspace-capability guard is a real security seam
  with multiple feature-specific adapters, not incidental sibling coupling.
- No production `forwardRef`, `ModuleRef` service locator, request-scoped
  provider, property injection, or direct package `src`/`dist` import was found.

### 5.3 TypeScript and runtime boundaries

- `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `useUnknownInCatchVariables`, `noImplicitOverride`, `noFallthroughCasesInSwitch`,
  and `noImplicitReturns` are enabled.
- Production source contains no explicit `any`, `as any`, `@ts-ignore`, or
  `@ts-expect-error` escape.
- Runtime inputs enter as `unknown` and are parsed with Zod contracts. API
  outputs are validated against exact response schemas; generated contract
  drift fails CI.
- Inline ESLint suppressions are confined to documented Nest module marker
  classes, frozen application-error values, and preserved rejection-value
  semantics. No blanket source-directory suppression was found.
- The ambient Node type package, engines range, CI jobs, and every Docker stage
  now resolve to Node 24. A fixture-backed compatibility gate rejects drift on
  any one surface.

### 5.4 NestJS and HTTP implementation

- Feature modules, constructor injection, symbol tokens, guards, and explicit
  ports/adapters are used consistently.
- Authentication, CSRF, workspace authorization, rate limiting, and error
  normalization are centralized. Controllers do not manually invent response
  error formats.
- Request bodies, parameters, queries, headers, and untrusted persisted/event
  values are parsed at their trust seams. Zod is used instead of
  `class-validator`; this provides the same required runtime validation without
  duplicating transport classes.
- Fastify application tests exercise routing, guards, parsing, cookies,
  serialization, and error behavior through the real application adapter.
- Configuration parsers fail fast, structured logging redacts sensitive
  context, readiness is separate from liveness, and API/worker bootstraps enable
  shutdown hooks and clean up failed initialization.

### 5.5 PostgreSQL implementation

- Seventy-four ordered SQL migrations are checksum-verified and protected by a
  transaction advisory lock. Dynamic role identifiers are escaped; business
  values use query parameters.
- The schema uses primary, foreign, unique, check, and index constraints. Tenant
  tables enable and force RLS, and real-role integration suites verify isolation
  and pooled-client context hygiene.
- Multi-step state changes use explicit transactions, row/advisory locking,
  compare-and-swap or lease fencing, rollback, and bounded lock/statement
  deadlines. The design uses explicit locks rather than `SERIALIZABLE`; absence
  of that isolation level is therefore not itself a finding.
- Pool sizes, connection/idle timeouts, PostgreSQL telemetry, compatibility
  checks, migration roles, runtime roles, and maintenance roles are explicit.
- `SELECT *` is primarily used for typed PostgreSQL composite-function results
  or complete persisted records. It was not treated as an automatic defect.
  Live query plans, index usage, bloat, autovacuum, WAL, replication, memory,
  and aggregate connection behavior still require deployed evidence under C-01.

### 5.6 Tests, CI, security, and operations

- Tests remain beside their owning workspace. A separate repository-wide test
  package would weaken ownership and is not recommended.
- Unit suites are fast and deterministic locally. Real PostgreSQL, Redis,
  object-store, HTTP, process-crash, compatibility, and recovery cohorts are
  isolated in explicit integration/resilience configurations.
- Required service cohorts emit machine-readable reports and fail on zero
  tests, failures, unexpected skips, pending tests, or todos.
- Coverage is deliberately risk-selected rather than repository-wide. CI emits
  the uncovered risk-branch inventory, and authorization and workflow status
  policies have exhaustive mutation canaries.
- CI actions and service images are digest-pinned, permissions are narrow,
  CodeQL and dependency scanning run, and production images are non-root and
  read-only compatible. The local provenance manifest binds the image digest,
  commit, SBOM hash, and scanner-report hash. External canary, registry-signing,
  deployment-identity, and governance evidence remains under C-01/C-03/C-04/C-08.

## 6. Current findings

### C-01 — Live production, recovery, and scale evidence is incomplete

**P1 — Production release blocker**

Status: **Open; external deployment evidence required.**

The target AWS environment still lacks retained evidence for:

- IAM admission and immutable task/image invocation;
- bucket versioning, Object Lock, replication, legal hold, and deletion;
- pager delivery and operator response;
- writer fencing, failover, failback, PITR, and regional restore;
- measured five-minute RPO and 24-hour RTO;
- representative load, provider failure, backpressure, and noisy-tenant
  fairness;
- separate API and worker autoscaling behavior; and
- worst-case PostgreSQL connection capacity across API, worker, dispatch,
  maintenance, migrations, operational jobs, pooler mode, and headroom.

Repository contracts prove expected shape, not deployed behavior.

**Required work**

Run the existing exercises against immutable deployed versions. Each report
must identify environment, image/task revision, data/storage version, workload,
expected result, observed result, timings, operator actions, cleanup, and
deviations. Keep reports secret-free and reject stale evidence.

**Accept when**

The external evidence validator accepts fresh reports, every open Phase 7 row
links to observed evidence, recovery objectives are measured, and maximum-scale
database capacity remains inside its safe budget.

### C-02 — PostgreSQL restart control is deterministic

**P1 — CI/release evidence blocker**

Status: **Resolved.**

GitHub Actions run `33458288161` failed in the destructive recovery job. The
transport resilience test calls:

`docker compose up -d --wait postgres`

after intentionally stopping PostgreSQL. Docker Compose sometimes observes the
old container exit before the restart reaches healthy state and returns failure.
The uploaded report shows the functional assertion failed at service
orchestration rather than at state recovery. A local exact reproduction passed,
so the test is nondeterministic.

This did not show durable-state corruption. The replacement service-control
seam records the stopped container, validates the intended clean exit, uses
`docker compose start`, retries only the documented transition race twice,
waits for health with a deadline, and rejects a changed container, unhealthy
state, or nonzero exit. Its negative fixtures and three consecutive destructive
local runs pass. The historical red run is not erased; replacement recovery job
`99723971025` passed in protected CI run `33465359665`.

No blanket job retry was added.

**Accept when**

The exact recovery cohort passes repeatedly from clean Compose projects on
GitHub-hosted runners, current `main` has all 11 required contexts green, and a
negative fixture still proves a genuinely unavailable PostgreSQL instance fails.

### C-03 — Security and image rejection canaries are not recorded

**P2 — External control evidence**

Status: **Open; GitHub/provider-side canary execution required.**

Secret scanning, push protection, dependency alerts/updates, and the protected
image scanner are enabled. However, there is no retained evidence that:

- a recognized non-production test secret is rejected before push;
- a controlled vulnerable dependency generates the expected alert/update; or
- a disposable vulnerable image causes the protected image context to fail.

**Required work**

Use provider-approved test tokens and disposable branches/fixtures. Never insert
a real secret or merge a vulnerable dependency. Record rejection, cleanup, and
the exact control that acted.

**Accept when**

All three controlled canaries produce the expected rejection or alert and leave
no credential, vulnerable dependency, image, or bypass behind.

### C-04 — Digest binding exists; signed promotion proof does not

**P2 — Supply-chain evidence**

Status: **Repository binding complete; registry signing and promotion open.**

The production-image job now builds with BuildKit metadata, records the content
digest, and creates a provenance manifest binding that digest and commit to the
SHA-256 hashes of the CycloneDX SBOM and Grype JSON report. Fixture tests reject
substitution. A real local production-image build emitted
`sha256:fda47b1215439a714ac7d0042fe41b4f8adfe62a7bc0c43c711cd029cb436bce`.
The manifest deliberately says `external-registry-required`: it is not a signed
registry attestation and does not claim deployment promotion.

Mutable Debian upgrades were correctly removed; this finding is about closing
the build-to-deployment identity chain.

**Remaining work**

- Publish/sign provenance through the chosen registry and CI identity.
- Promote by digest rather than rebuilding from the commit.
- Verify the deployment manifest references the scanned digest.

**Accept when**

The CI artifact and registry attestation identify one digest, deployment uses
that exact digest, verification rejects substitution, and rebuild equivalence is
either demonstrated or explicitly not relied upon because promotion reuses the
original immutable artifact.

### C-05 — Named complexity hotspots were reduced

**P3 — Maintainability improvement**

Status: **The eight named hotspots are remediated. Secondary candidates remain
under the ratchet as ordinary improvement work.**

The audit named eight branch-heavy functions. All eight were decomposed behind
private invariant-owned seams without widening their package interfaces:

| Former hotspot | Result |
| --- | --- |
| status and transition-plan validation | private status/policy and plan-validator modules |
| persisted-observation parsing | private parser dispatch module |
| loaded-checkpoint physical validation | private physical-state module |
| node-attempt execution input proof | private input-proof module |
| node-attempt completion outcomes | private outcome-policy module |
| workflow graph validation | private graph-validation policies |
| derived workflow transitions | named transition policies |

None of those eight remains in the complexity baseline. The current highest
measured source function is 220 lines/44 branches, down from 257/102 for the
former leader, and the ratchet reports no new or worsened hotspot.

The fixed-revision comparison in
[`docs/operations/complexity-refactor-performance.md`](./operations/complexity-refactor-performance.md)
runs each owning package suite five times at the pre-refactor and candidate
revisions. Median elapsed deltas were +0.36% database, +3.13% workflow engine
(with three additional tests), and 0.00% workflow model; median maximum-RSS
deltas were +1.18%, +0.26%, and +0.23%. Query-call inventory decreased from 215
to 213, and diff review found relocated statements but no new SQL or round trip.

The longest lexical factory functions also include workspace purge (584 lines),
control-ledger coordination (578), identity/workspace persistence (505),
workflow authoring persistence (498), and failure-notification persistence
(494). Their public interfaces remain comparatively deep, but changing an
invariant still requires navigating a large closure. Treat them as secondary
characterization candidates after the branch-heavy functions above.

**Follow-up rule**

Treat the remaining large lexical factories as characterization candidates,
not defects by size. Continue one invariant at a time only when change cost or
failure ownership justifies it.

**Accept when**

Each focused change lowers the relevant ratchet baseline, public interface size
does not grow, failure-path tests remain exhaustive, and query/allocation/latency
measurements do not regress.

### C-06 — Coverage proof is selective rather than repository-wide

**P3 — Test-confidence improvement**

Status: **Materially improved; uncovered risk branches remain a visible
follow-up inventory.**

Coverage remains deliberately selected critical-module coverage, not
whole-repository or whole-risk-surface coverage. The API critical-boundary
cohort now exercises authorization input and persisted-record rejection,
session clock/store/metadata failures, HTTP sanitization and response adapters,
request-header policies, and rate-limit allow, deny, fail-open, fail-closed,
classification, origin, and scope behavior. A cryptographic random source that
returns the wrong UUID byte count now fails closed. API branch coverage rose
from 84.45% to 99.64%, and its thresholds ratcheted to 99% branches, statements,
and lines and 98% functions.

CI emits `coverage/risk-uncovered-branches.json`. Schema V3 lists the 23 exact
measured files using repository-relative paths, keeps 317 sites `unreviewed`,
and attaches one exact `generated` review from the committed manifest. Missing,
duplicate, malformed, or stale review entries fail the report, so a source-line
change cannot preserve an obsolete justification. Generation does not classify
any site automatically. Exhaustive workflow-status mutation canaries and the
existing exhaustive role/capability matrix prove that consequential policy
changes fail tests.

**Remaining work**

- Add failure-injection or mutation tests for consequential testable branches.
- Reclassify individual sites as unreachable or defensive only with a durable
  justification; do not bulk-label them to manufacture closure.

**Accept when**

High-risk uncovered branches have tests or documented justification, selected
mutation tests prove the suites detect changed authorization/state-transition
logic, and thresholds ratchet upward without a vanity 100% target.

### C-07 — Dependency automation is enabled but not consistently actionable

**P3 — Dependency operations**

Status: **Repository policy complete; the next Dependabot cycle supplies
operational confirmation.**

The Node 26 proposal was closed, Node is constrained to the supported 24 line,
and bounded npm groups exist. At audit time:

- the Node 24 Docker update PR was fully green;
- the development update group was still running; and
- the production update group bundled 12 updates and had several failed
  contexts.

A failing update PR is not itself a product defect, but the former twelve-item
production group hid the incompatible boundary. Production updates are now
split into HTTP, validation, AWS, telemetry, queue, and routine groups. The
owner/SLA policy defines same-day security triage, 72-hour security disposition,
seven-day green-update review, two-business-day failing-boundary isolation, and
bounded documented deferral.

**Remaining work**

Observe the next automation cycle and record any intentional deferral with its
reason and review date.

**Accept when**

Routine supported updates become reviewable green PRs, a single incompatible
package can be isolated without disabling automation, and deferred updates have
a recorded reason and review date.

### C-08 — Independent review and signed provenance remain unavailable

**P3 — Accepted solo-maintainer risk**

Status: **Open external governance constraint; documented and accepted.**

CODEOWNERS covers critical paths, but GitHub reports one collaborator. Requiring
one approval or code-owner review would deadlock every author-owned PR. Required
approvals and signatures therefore remain disabled.

**Required work**

Keep the documented solo exception. When a second maintainer with review
permission exists, require one non-author approval and code-owner review for
critical paths. Provision signing for human and automation identities before
requiring verified commits or merge signatures.

**Accept while solo**

The exception names the sole-maintainer condition, protected checks remain
mandatory, and no approval rule is enabled that deadlocks legitimate work.

**Accept after a second maintainer and signing identities exist**

An unreviewed critical-path PR cannot merge, one non-author approval and
code-owner review are required, and protected merge commits/provenance are
verifiably attributable.

### C-09 — Current-status and audit evidence have drifted

**P3 — Documentation accuracy**

Status: **Resolved by this fixed-snapshot publication.**

The current status, tracker, and audit are now separated into implementation
state, historical evidence, and external evidence. This audit pins a merged
implementation snapshot; Phase 7 remains in progress. The preceding
red recovery run is retained as historical evidence and is explicitly
superseded by green pull request #7 run `33465359665`; later runtime-remediation
pull requests are recorded separately rather than rewriting that history.
`pnpm docs:check` now parses the repository Markdown, rejects missing local
targets or heading anchors, synchronizes the audited implementation tree across
the audit, progress tracker, and current-status document, and proves that tree
occurs in the publication ancestry. The solo-maintainer exception names its
owner and a bounded next-review date.

**Maintenance rule**

Record the eventual replacement remote run without rewriting the historical
failure, and keep deployment evidence distinct from repository verification.

**Accept when**

README, current status, this audit, and the tracker agree on branch state,
current head, current CI, and open production work; historical evidence remains
linked but cannot be mistaken for current status.

### C-10 — Node ambient types exceed the supported runtime major

**P2 — Type/runtime compatibility**

Status: **Resolved.**

`@types/node` is pinned to 24.13.3. The root compatibility check parses the
engines range, every workflow Node selection, every Docker stage, and the
ambient type major, requiring all of them to resolve to Node 24. It rejects
dynamic/matrix expressions, `node-version-file`, and setup-node steps without
their own literal selector. Selectors must belong to that exact step's `with`
mapping, so unrelated or sibling `node-version` keys cannot mask drift.
Workflow files are parsed structurally with pinned `yaml` 2.9.0: quoted action
values are recognized, block-scalar text is not treated as a step, and invalid
YAML fails closed. The `actions/setup-node` repository identity is compared
case-insensitively to match GitHub semantics. Fourteen fixtures prove the
supported surfaces. CI action pins for checkout, pnpm setup, Node setup, and
artifact upload now use immutable v6 releases whose action manifests declare
the Node 24 runtime; protected pull request #23 run `33625443334` completed
without the former Node.js 20 deprecation annotations.

**Maintenance rule**

Advance runtime and ambient types in one intentional change; do not bypass the
fixture-backed compatibility gate.

**Accept when**

The installed ambient types, engines range, CI runtime, and production image all
resolve to Node 24, and a fixture proves that drifting any one surface fails the
compatibility gate.

### C-11 — Two bounded same-owner helper clones were consolidated

**P3 — Readability and locality**

Status: **Resolved.**

Exact function-body comparison found 12 repeated groups of at least 12 lines.
Most should remain local: Nest module registration shells, feature-owned
authorization/current-draft behavior, cross-package UTF-8 calculations, and
small query wrappers do not justify wider interfaces.

The two groups with one natural owner were consolidated:

- request-header extraction and normalization are repeated across API request
  identifiers, rate limiting, and workflow controllers even though the HTTP
  platform module already owns request adaptation; and
- `metadataMatches` is duplicated inside the artifact-store package.

The private HTTP-platform helper now exposes raw, first-value, and
strict-single-value policies, while the webhook ingress deliberately retains raw
Fastify handling for duplicate/comma-folding security semantics. Artifact
metadata equality has one private artifact-store implementation. Neither change
adds a public subpath or generic shared package.

The later complexity decomposition briefly duplicated `assertPlan` and
`sameStoredValue` across coordinator plan/status validation. Both now live once
in the private database-owned `coordinator-run-store-validation-values` module;
no package export was added.

**Accept when**

Each header policy and artifact metadata comparison has one owned
implementation, callers retain their current behavior, package/public
interfaces do not grow, and the remaining intentional groups are documented by
this audit or a narrow code comment.

### C-12 — The documentation gate is not merge-safe or protected

**P1 — CI and audit-evidence integrity**

Status: **Implemented locally; protected pull-request and post-merge execution
evidence remains open.**

The documentation validator was added to root `pnpm check` and correctly
rejects missing local targets, missing anchors, cross-document audit-tree drift,
and an audited tree that does not occur in publication ancestry. Critical API
coverage remediation was originally audited at candidate commit `eb2cd1d`.
GitHub's rebase-style merge recreated that implementation as merged commit
`59a14c7` with the same Git tree, so `eb2cd1d` was not an ancestor of resulting
main commit `e9aa0f2`. On a full local clone, `pnpm docs:check` therefore failed
and made canonical `pnpm check` red.

Protected main CI run `33635957948` nevertheless passed because the quality job
manually invoked formatting, build, lint, contracts, and type checking instead
of root `pnpm check` and omitted `pnpm docs:check`. Its checkout also used
`fetch-depth: 1`, which is insufficient for a general ancestor proof. The green
protected contexts prove the code, coverage, integration, recovery, security,
and image cohorts that actually ran; they do not prove documentation validation.

The validator now records the full Git tree for the reviewed implementation
snapshot. Rebase merging may recreate commits, but it preserves their trees.
The protected quality job fetches complete history and explicitly runs
`pnpm docs:check`, and a temporary-repository fixture proves that a candidate
commit can be replaced on another parent while the matching reviewed tree is
still accepted. Missing trees and synchronized-document drift remain negative
cases. This preserves a narrow validator interface and avoids merge-policy
exceptions.

**Remaining evidence**

- Observe `pnpm docs:check` pass in the protected quality job for this pull
  request.
- After rebase merge, confirm the exact-main quality job resolves the same
  audited tree from full history.

**Accept when**

The documentation command passes on the publication branch and after the
supported merge flow; changing any synchronized audit tree, breaking a local
target/anchor, or recording a non-accepted implementation identity fails a
required protected context.

## 7. Areas with no current corrective finding

- The twelve-package modular-monolith structure remains justified.
- No generic `shared`, `common`, or `utils` package is needed.
- Runtime database roles use explicit capability subpaths; the broad root export
  is retired.
- Source dependency direction remains acyclic.
- Exact API response types and runtime schema validation are preserved.
- Feature modules no longer depend on the corrected sibling internals.
- Idempotency and invalid-session data now have bounded operated retention.
- Observability and provider telemetry clones use narrow owned modules.
- Fastify access is localized at a checked adapter seam.
- Test directories remain correctly package-local; no top-level test package is
  recommended.
- Remaining real-time waits reviewed by the prior remediation are tied to actual
  database, Redis, queue, process, cancellation, or external-clock behavior.

## 8. Ordered improvement plan

Repository-controlled remediation at the audited implementation snapshot:

- [x] Stabilize the recovery service-control seam and pass protected recovery
      CI (C-02).
- [x] Bind local image, SBOM, and scan evidence to the BuildKit digest (C-04
      repository portion).
- [x] Reduce all eight named complexity hotspots without widening public
      interfaces (C-05).
- [x] Emit a risk-branch inventory, raise critical thresholds, and add selected
      mutation canaries without generating an unreviewed classification (C-06
      repository portion).
- [x] Split dependency compatibility boundaries and define owner/SLAs (C-07).
- [x] Correct fixed-snapshot/current-status evidence drift (C-09).
- [x] Automate repository-local documentation link/anchor validation and
      cross-document audit-tree drift detection; bound the solo-maintainer
      exception with an owner and review date (C-09/C-08 repository policy).
- [x] Align Node ambient types and enforce cross-surface runtime compatibility
      (C-10).
- [x] Consolidate the two same-owner helper clones (C-11).
- [x] Correct the unreachable pre-rebase audit reference without erasing the
      escaped failure evidence (C-12 publication portion).
- [x] Bind audits to merge-stable Git trees, cover rebase-style recreation, and
      run the documentation gate with complete history in protected quality CI
      (C-12 implementation portion).

Remaining ordered work:

1. Observe the updated documentation validator in protected pull-request and
   post-rebase `main` CI (C-12).
2. Complete live Phase 7 evidence and aggregate capacity proof (C-01).
3. Execute safe provider canaries (C-03).
4. Select the registry and signing identities, publish the already digest-bound
   evidence, promote by digest, and verify deployment identity (C-04).
5. Continue consequential failure-branch/mutation coverage from the generated
   unreviewed inventory and observe the new dependency groups in operation
   (C-06/C-07).
6. Apply multi-maintainer review and signing enforcement when the required
   people and identities exist (C-08).

Only item 2 is an authoritative Phase 7 release blocker. Items 1 and 3–6 are
repository repair, audit-assurance improvements, or externally conditional work.

## 9. Closure rule

A finding closes only when the stated change exists, its acceptance evidence
passes, failure paths remain tested, the implementation tracker links current
proof, and the audit is refreshed at a fixed implementation snapshot represented
by a Git tree in its publication ancestry.

The goal is not a cosmetic 10/10. It is a repository whose remaining risk is
explicit, whose tests cannot pass without running, whose modules preserve
leverage and locality, and whose production claims are backed by observed
immutable evidence.
