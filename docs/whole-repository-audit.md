# Current Whole-Repository Engineering Audit

Recorded: 2026-09-01

Audited implementation head: `e3d173fe9573107c1cc9551ca2e007fbfc824e18`

Status: current open findings and improvement plan only

## 1. Executive conclusion

The repository-controlled implementation is strong. The original code-quality,
package, data-retention, type-safety, test-truthfulness, image, and dependency
findings were materially corrected. This document intentionally omits their
resolved history and records only work that remains.

The project is not production-ready. Live AWS evidence remains absent and the
latest CI run on current `main` is red because the destructive recovery test
raced while restarting PostgreSQL. A local reproduction passed, which makes the
problem intermittent rather than disproved.

- Continue development: **GO**
- Claim all repository checks are green: **NO-GO**
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
precision. **8.6 codebase engineering quality** is the arithmetic mean of the
first ten code, data, security, test, CI, and reliability rows below. **8.3
overall state** is the arithmetic mean of all fourteen rows. Neither number is
an industry percentile, and future audits must retain the same rows and rubric
for trend comparisons.

## 3. Current scores

Scores are evidence-based engineering judgments, not a universal formula. A 10
requires both a strong implementation and convincing automated or operational
proof.

| Area | Score | What prevents a higher score |
| --- | ---: | --- |
| Architecture and domain ownership | 9.0/10 | Remaining branch-heavy internal functions |
| Readability and maintainability | 8.2/10 | Ratcheted hotspots still require costly reasoning |
| TypeScript and runtime contracts | 8.6/10 | Node 26 ambient types do not match the required Node 24 runtime |
| Reuse and package design | 8.5/10 | Two bounded same-owner helper clones remain; no package removal is indicated |
| PostgreSQL and data integrity | 9.0/10 | Live capacity, backup, failover, and scale behavior unproved |
| Application security | 9.0/10 | No current application exploit found |
| Repository and supply-chain security | 8.5/10 | Canaries, signed provenance, and independent review absent |
| Testing | 8.7/10 | Recovery restart flake; critical coverage remains selective |
| CI and change governance | 8.0/10 | Current `main` recovery job is red |
| Reliability and durability | 8.8/10 | Local recovery passes, but remote restart orchestration is unstable |
| Observability and operability | 8.5/10 | No deployed pager/operator proof |
| Performance and scalability | 7.5/10 | No representative deployed load or aggregate DB capacity proof |
| Documentation and governance | 7.8/10 | Current-status wording and audit anchoring drifted |
| Production readiness | 5.5/10 | Phase 7 live evidence remains incomplete |

Overall codebase engineering quality: **8.6/10**.

Overall state including production readiness: **8.3/10**.

## 4. Evidence checked at this head

- `pnpm check`: passed formatting, build, ESLint, complexity ratchet,
  generated contracts, TypeScript, and 1,328 unit tests across all 18
  workspace projects.
- `pnpm test:coverage`: passed all current critical-module thresholds:
  workflow engine 79.36%, database 61.53%, worker 62.79%, API 82.56% branch
  coverage.
- `pnpm security:audit`: no known production dependency vulnerability.
- `pnpm deployment:check`, `pnpm images:check`, and
  `pnpm exercise:check`: passed.
- GitHub security controls are enabled: secret scanning, push protection,
  vulnerability alerts, Dependabot security updates, and automated fixes.
- Protected `main` requires 11 strict contexts, including CodeQL and
  `production-image`.
- The audit-remediation pull request passed every protected context.
- The latest push CI run on current `main`, `33458288161`, failed only in
  `recovery`. Its worker and API recovery reports passed, but the transport
  resilience suite failed while `docker compose up --wait postgres` observed
  the restarting container exit with status zero.
- The same transport resilience cohort was reproduced locally and passed 1/1
  with no skip.
- The worktree was clean before this documentation update.

## 5. Actual source-code review results

The research criteria were applied to production code and tests, not only to
repository configuration or prior audit prose.

### 5.1 Scope and structural statistics

- 18 workspace projects: six runnable applications and twelve capability
  packages.
- 86,564 TypeScript lines in production/configuration sources and 89,450 in
  package-local tests and test support.
- 3,419 functions or methods, 279 classes, and 317 declared interfaces.
- 48 functions span more than 200 lexical lines and 10 span more than 400.
  Many are deep factory functions whose span includes private returned methods;
  the branch ratchet, interface size, and invariant ownership determine whether
  they need refactoring.
- 10 classes span more than 200 lines. The largest are concrete AWS, BullMQ,
  dispatcher, expression, OIDC, and secure-HTTP adapters with cohesive external
  responsibilities; none is a cross-domain god class.
- Exact normalized-body scanning found 12 repeated function groups of at least
  12 lines. Most are intentional adapter shells or parallel feature-owned
  behavior. The two same-owner consolidation candidates are recorded in C-11.

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
- The ambient Node type package is `@types/node` 26.2.0 while engines, CI, and
  every Docker stage require Node 24. This is the current type/runtime defect in
  C-10.

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
- Coverage is deliberately risk-selected rather than repository-wide; the open
  improvement is C-06, not a cosmetic demand for 100%.
- CI actions and service images are digest-pinned, permissions are narrow,
  CodeQL and dependency scanning run, and production images are non-root and
  read-only compatible. Remaining CI, canary, provenance, and governance gaps
  are C-02 through C-04 and C-08.

## 6. Current findings

### C-01 — Live production, recovery, and scale evidence is incomplete

**P1 — Production release blocker**

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

### C-02 — Current `main` has an intermittent PostgreSQL restart failure

**P1 — CI/release evidence blocker**

GitHub Actions run `33458288161` failed in the destructive recovery job. The
transport resilience test calls:

`docker compose up -d --wait postgres`

after intentionally stopping PostgreSQL. Docker Compose sometimes observes the
old container exit before the restart reaches healthy state and returns failure.
The uploaded report shows the functional assertion failed at service
orchestration rather than at state recovery. A local exact reproduction passed,
so the test is nondeterministic.

This does not show durable-state corruption, but it means current `main` is red
and the recovery proof is not reliable enough.

**Required work**

Make the test's service-control seam explicitly wait through the stop/start
transition:

1. establish the intended stopped state and container identity;
2. issue a start/recreate operation with bounded retry only for the documented
   Docker transition race;
3. poll the PostgreSQL health/readiness condition with a deadline;
4. fail immediately for unexpected exit codes, unhealthy state, or a different
   container failure; and
5. keep product readiness and dispatcher recovery assertions unchanged.

Do not hide the problem with a blanket job retry.

**Accept when**

The exact recovery cohort passes repeatedly from clean Compose projects on
GitHub-hosted runners, current `main` has all 11 required contexts green, and a
negative fixture still proves a genuinely unavailable PostgreSQL instance fails.

### C-03 — Security and image rejection canaries are not recorded

**P2 — External control evidence**

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

### C-04 — Image provenance does not yet bind a promoted immutable digest

**P2 — Supply-chain evidence**

The production-image job builds the exact commit, verifies non-root/read-only
execution, generates a CycloneDX SBOM, and scans the local tag. It uploads an
artifact named `production-image-provenance`, but the job does not currently
record a content digest, sign an attestation, or prove that a later promoted
image is byte-identical to the scanned image.

Mutable Debian upgrades were correctly removed; this finding is about closing
the build-to-deployment identity chain.

**Required work**

- Record the built image digest.
- Bind the SBOM and scan result to that digest.
- Publish/sign provenance through the chosen registry and CI identity.
- Promote by digest rather than rebuilding from the commit.
- Verify the deployment manifest references the scanned digest.

**Accept when**

The CI artifact and registry attestation identify one digest, deployment uses
that exact digest, verification rejects substitution, and rebuild equivalence is
either demonstrated or explicitly not relied upon because promotion reuses the
original immutable artifact.

### C-05 — Complexity is prevented from worsening but not yet reduced

**P3 — Maintainability improvement**

The ratchet is valuable and passes. Current high-branch functions still include:

| Function | Current measured shape |
| --- | ---: |
| `coordinator-run-store-plan.ts#validateStatusTransitions` | 257 lines / 102 branches |
| persisted-observation parser arrow function | 275 / 82 |
| `validateLoadedCheckpointPhysicalState` | 153 / 65 |
| `validateTransitionPlan` | 119 / 60 |
| `operations.ts#executeNodeAttempt` | 236 / 54 |
| node-attempt completion arrow function | 387 / 53 |
| `workflow-model/graph.ts#validate` | 198 / 52 |
| `deriveWorkflowTransitions` | 241 / 47 |

These are not defects by line count alone. They are future change-cost and
review-risk concentrations.

The longest lexical factory functions also include workspace purge (584 lines),
control-ledger coordination (578), identity/workspace persistence (505),
workflow authoring persistence (498), and failure-notification persistence
(494). Their public interfaces remain comparatively deep, but changing an
invariant still requires navigating a large closure. Treat them as secondary
characterization candidates after the branch-heavy functions above.

**Required work**

Refactor only after characterization. Prefer discriminant-to-validator/parser
tables, state-specific handlers, named transition policies, and indexed lookup
state. Keep one deep public interface and make internal seams private. Preserve
transaction, authorization, and exhaustive-failure ownership.

**Accept when**

Each focused change lowers the relevant ratchet baseline, public interface size
does not grow, failure-path tests remain exhaustive, and query/allocation/latency
measurements do not regress.

### C-06 — Coverage proof is selective rather than repository-wide

**P3 — Test-confidence improvement**

Current coverage correctly targets critical modules; it must not be described as
whole-repository coverage. Database and worker branch thresholds are 61.53% and
62.79%. The percentages are not automatically inadequate, but unexecuted
failure branches in transaction, recovery, parser, and security code deserve
risk-based review.

**Required work**

- Generate an uncovered-branch report for security, transaction, recovery, and
  parser modules.
- Classify each uncovered branch as unreachable, defensive, or testable.
- Add failure-injection or mutation tests for consequential testable branches.
- Exclude generated/declarative code explicitly rather than lowering the signal.
- Raise thresholds only after meaningful coverage exists.

**Accept when**

High-risk uncovered branches have tests or documented justification, selected
mutation tests prove the suites detect changed authorization/state-transition
logic, and thresholds ratchet upward without a vanity 100% target.

### C-07 — Dependency automation is enabled but not consistently actionable

**P3 — Dependency operations**

The Node 26 proposal was closed, Node is constrained to the supported 24 line,
and bounded npm groups exist. At audit time:

- the Node 24 Docker update PR was fully green;
- the development update group was still running; and
- the production update group bundled 12 updates and had several failed
  contexts.

A failing update PR is not itself a product defect, but large groups can make
the incompatible dependency difficult to identify.

**Required work**

Triage the production group, split packages with independent compatibility risk,
retain useful patch/minor grouping, and define an owner/SLA for green updates,
security updates, and intentionally deferred versions.

**Accept when**

Routine supported updates become reviewable green PRs, a single incompatible
package can be isolated without disabling automation, and deferred updates have
a recorded reason and review date.

### C-08 — Independent review and signed provenance remain unavailable

**P3 — Accepted solo-maintainer risk**

CODEOWNERS covers critical paths, but GitHub reports one collaborator. Requiring
one approval or code-owner review would deadlock every author-owned PR. Required
approvals and signatures therefore remain disabled.

**Required work**

Keep the documented solo exception. When a second maintainer with review
permission exists, require one non-author approval and code-owner review for
critical paths. Provision signing for human and automation identities before
requiring verified commits or merge signatures.

**Accept when**

An unreviewed critical-path PR cannot merge without deadlocking legitimate work,
and protected merge commits/provenance are verifiably attributable.

### C-09 — Current-status and audit evidence have drifted

**P3 — Documentation accuracy**

`docs/current-implementation-status.md` says audit remediation is active on a
review branch even though it is merged. The preceding audit pinned a commit not
on current `main` ancestry, although its implementation tree was equivalent to
the merged commit. The detailed progress section still cites older head/run
evidence and previously claimed strengthened current-status documentation.

**Required work**

- Describe remediation as merged with the current remaining findings.
- Pin audits to an ancestor of the branch on which they are published.
- Separate current status from historical commit evidence.
- Record the current red recovery run and its eventual green replacement.
- Keep Phase 7 in progress.

**Accept when**

README, current status, this audit, and the tracker agree on branch state,
current head, current CI, and open production work; historical evidence remains
linked but cannot be mistaken for current status.

### C-10 — Node ambient types exceed the supported runtime major

**P2 — Type/runtime compatibility**

`package.json` constrains Node to `>=24 <25`, every GitHub job selects Node 24,
and every Docker stage uses Node 24. The root development dependency is
`@types/node` 26.2.0. TypeScript can therefore accept a Node 26-only global,
module export, option, or overload that is absent from the production runtime.
Existing tests reduce but do not eliminate the risk because unexecuted paths can
still compile against the newer ambient interface.

**Required work**

- Pin `@types/node` to the supported Node 24 major.
- Add an automated compatibility assertion tying engines, CI, Docker, and the
  ambient Node types to one approved major.
- Keep the assertion compatible with intentional staged upgrades so the runtime
  and types advance in the same change.

**Accept when**

The installed ambient types, engines range, CI runtime, and production image all
resolve to Node 24, and a fixture proves that drifting any one surface fails the
compatibility gate.

### C-11 — Two bounded same-owner helper clones remain

**P3 — Readability and locality**

Exact function-body comparison found 12 repeated groups of at least 12 lines.
Most should remain local: Nest module registration shells, feature-owned
authorization/current-draft behavior, cross-package UTF-8 calculations, and
small query wrappers do not justify wider interfaces.

Two groups do have one natural owner:

- request-header extraction and normalization are repeated across API request
  identifiers, rate limiting, and workflow controllers even though the HTTP
  platform module already owns request adaptation; and
- `metadataMatches` is duplicated inside the artifact-store package.

**Required work**

Centralize request-header normalization in the private HTTP platform with
explicit strict-single-value and first-value policies, and move artifact
metadata equality behind one private artifact-store helper. Keep both internal;
do not create a generic shared package or expose new public subpaths. Delete the
replaced local copies and test through their owning interfaces.

**Accept when**

Each header policy and artifact metadata comparison has one owned
implementation, callers retain their current behavior, package/public
interfaces do not grow, and the remaining intentional groups are documented by
this audit or a narrow code comment.

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

1. Stabilize the recovery service-control seam and restore green `main` (C-02).
2. Complete live Phase 7 evidence and capacity proof (C-01).
3. Execute safe control canaries and bind image evidence to the promoted digest
   (C-03, C-04).
4. Align Node ambient types and add the cross-surface major-version assertion
   (C-10).
5. Correct current-status and audit evidence drift (C-09).
6. Deepen the highest-risk complexity hotspots one invariant at a time (C-05).
7. Consolidate only the two same-owner helper clones (C-11).
8. Expand failure-branch and mutation confidence based on risk (C-06).
9. Keep dependency PRs actionable and apply multi-maintainer governance when
   people and signing identities exist (C-07, C-08).

## 9. Closure rule

A finding closes only when the stated change exists, its acceptance evidence
passes, failure paths remain tested, the implementation tracker links current
proof, and the audit is refreshed at a fixed ancestor of its publication branch.

The goal is not a cosmetic 10/10. It is a repository whose remaining risk is
explicit, whose tests cannot pass without running, whose modules preserve
leverage and locality, and whose production claims are backed by observed
immutable evidence.
