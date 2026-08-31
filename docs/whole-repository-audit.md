# Current Whole-Repository Engineering Audit

Recorded: 2026-09-01

Audited implementation head: `9e4263794715d273e8660c0dd4efa67c5032e940`

Status: current findings only; supersedes every earlier repository audit and
findings log

## 1. Executive decision

The codebase is good and substantially implemented. It has coherent domain
boundaries, strict TypeScript, strong tenant isolation, disciplined migrations,
deep durability tests, narrow production database surfaces, and credible CI.
It is materially better than a typical unfinished backend.

It is not yet a finished production platform or as maintainable as it can be.
Live AWS behavior is unproved, security controls on the public GitHub repository
are disabled, some database records have no bounded retention, some required
tests can become green skips, and several central persistence functions are too
large.

- Continued development and Phase 7 work: **GO**
- Ordinary merges after protected checks and review: **GO**
- Claim Phase 7 completion or production readiness: **NO-GO** until all P1
  findings have their stated evidence

No demonstrated tenant escape, authorization bypass, durable-state corruption,
Redis-authority violation, circular source dependency, or known high-severity
production dependency vulnerability was found.

## 2. Scope, method, and calibration

This is a review of actual code at the pinned head, not a generic best-practice
list. It covered every app and package; functions, classes, imports, exports,
dependencies, readability, repetition, reuse, and obsolete surfaces; TypeScript
and runtime validation; NestJS composition; PostgreSQL schema, RLS, privileges,
migrations, transactions, indexes, retention, and recovery; workflow and queue
correctness; all test classes and their layout; CI, CodeQL, branch protection,
dependencies, images, deployment contracts, observability, runbooks, ADRs, the
backend plan, and the implementation tracker.

The design standard is a deep module: substantial behavior and invariants hidden
behind a small stable interface. A refactor is useful when it improves ownership,
locality, tests, or diagnostics—not merely when it creates more files.

| Priority | Meaning |
| --- | --- |
| P0 | Active exploit, data loss, or systemic failure requiring stop-work |
| P1 | Release or production-readiness blocker |
| P2 | Material correctness, security, operational, or maintainability risk |
| P3 | Focused quality improvement or fix-when-touching item |

Scores are repository-specific engineering judgments, not a universal published
formula. Ten means no material gap was found with convincing proof; eight means
strong with bounded improvements; six means workable with important risk.

## 3. Evidence snapshot

- Clean worktree; `main` matched `origin/main` before this audit branch.
- `pnpm check` passed formatting, builds, ESLint, contract drift, TypeScript,
  and 1,312 unit-level tests.
- `pnpm test:coverage` passed the four critical-module branch thresholds:
  workflow engine 79.36%, database 61.53%, worker 62.79%, API 82.56%.
- `pnpm audit --prod --audit-level high` reported no known vulnerabilities.
- Deployment, image-contract, and exercise checks passed.
- CI run `33374292338` and release gate `33378998330` passed at the head;
  CodeQL was green. Normal CI takes roughly eight minutes, which is reasonable.
- 418 TypeScript source files / 85,253 lines; 322 test files / 88,546 lines;
  73 migrations / 12,839 SQL lines.
- 49 source files exceed 500 lines; 51 source functions exceed 200 lines.
- Clone analysis found 24 groups and 772 duplicated lines, about 1.05%.
- Dependency analysis processed 403 source files and found no circular source
  dependency.

The CI does not currently “fail most of the time.” Historical failures occurred
during hardening; the present head and release gate are green.

### Evidence limits

- No live AWS account/evidence bundle was available.
- Coverage is intentionally for critical modules, not the whole repository.
- A `knip` dead-code run failed because the transient tool was incompatible
  with the installed TypeScript API; absence of dead exports is not claimed.
- Static analysis and focused reading cannot prove every line correct.
- There is no product frontend here; browser UX/accessibility is out of scope,
  not considered passed.

## 4. Scorecard

| Area | Score | Judgment |
| --- | ---: | --- |
| Architecture/domain boundaries | 8.0 | Strong modular-monolith design; a few feature internals leak |
| Readability/maintainability | 7.0 | Clear local code; serious central complexity hotspots |
| TypeScript/runtime contracts | 8.0 | Strict and validated; some exact outputs are erased |
| Reuse/package design | 8.0 | Purposeful packages, low duplication, one broad compatibility root |
| Data integrity/persistence | 8.0 | Strong transactions/RLS; two unbounded retention classes |
| Application security | 8.5 | Strong auth, tenancy, SSRF, webhook, and least privilege |
| Repository/supply-chain security | 6.5 | Pinned inputs, but GitHub security controls are disabled |
| Testing | 8.0 | Exceptional depth; skip truthfulness and sleeps remain |
| CI/change governance | 8.0 | Partitioned, protected, green; image and review gaps |
| Observability/operations | 8.0 | Broad repository support; live pager proof absent |
| Performance/scalability | 7.0 | Good bounded design; live scale/DB capacity unproved |
| Production readiness | 5.5 | Advanced preparation, incomplete live evidence |
| Documentation/governance | 7.0 | Strong traceability, weak current-status discoverability |

Overall: **7.5/10**, meaning a strong pre-production backend, not a finished
production system.

## 5. Current findings

### A-01 — Live production and recovery evidence is incomplete

**P1 — Operations**

The Phase 7 tracker correctly leaves open live IAM/immutable invocation,
versioned buckets, Object Lock and replication, deployed load/noisy-tenant
fairness, pager delivery, failover, PITR, regional restore, RPO/RTO, and
autoscaling. Repository contracts cannot prove cloud behavior. The plan also
requires database pooling before many replicas; declared maxima reach 20 API
and 20 worker tasks, but live evidence does not prove the aggregate connection
budget or external pooler capacity/mode.

**Change:** execute the existing production-like exercises against immutable
versions. Record environment, versions, workload, expected/observed results,
timing, operator action, cleanup, and deviations. Include writer fencing,
failback, PITR/regional restore, five-minute RPO, 24-hour RTO, Object Lock,
legal hold/deletion, pager latency, provider failure, fairness/backpressure,
separate API/worker scaling, and worst-case database connections across tasks,
jobs, maintenance, migrations, and headroom.

**Accept when:** fresh immutable reports pass the external evidence validator,
every live Phase 7 row links to an observed result, capacity is safe at maximum
scale, and only then Phase 7 is complete.

### A-02 — Public-repository security controls are disabled

**P1 — Supply chain**

GitHub's API reports this public repository has secret scanning, push
protection, Dependabot security updates, and automated security fixes disabled.
`.github/dependabot.yml` covers Docker only. Passing dependency audit, SHA-pinned
Actions, and CodeQL do not detect a credential before it enters public history.

**Change:** enable secret scanning, push protection, alerts/security updates,
and validity checks where available. Add bounded grouped npm/pnpm updates.

**Accept when:** GitHub's API reports the controls enabled, a safe canary proves
push protection, and a controlled security advisory produces an alert/update.

### A-03 — Several idempotency record classes are retained forever

**P2 — Data lifecycle**

Migration `0004_execution_acceptance.sql` allows nullable `expires_at`.
Connection management, secret rotation, connection testing, workflow
publication, and failure-notification destination inserts omit expiry. Webhook
and schedule operations do set it. No general bounded reaper was found.

**Change:** define operation-specific replay windows, set expiry at claim time,
add a maintenance-only bounded/index-backed reaper, define key reuse, and never
remove an in-progress claim before safe lease recovery.

**Accept when:** PostgreSQL tests prove replay/conflict before expiry, safe
in-progress recovery, deletion and defined reuse after expiry, plus bounded
growth and indexed reaping under load.

### A-04 — Expired and revoked sessions are never physically reaped

**P2 — Privacy/data lifecycle**

`0008_identity_workspace.sql` provides expiry/revocation fields and active
indexes. Lookups ignore invalid sessions and logout marks revocation, but no
session deletion exists. Token digests and bounded user-agent/IP metadata remain
indefinitely.

**Change:** define an audit grace period and add a bounded maintenance-only
reaper with deletion-order indexing and an explicit metadata retention policy.

**Accept when:** real PostgreSQL tests preserve active sessions, safely remove
expired/revoked rows after grace, cover concurrent logout/reaping and workspace
deletion, and show bounded growth.

### A-05 — Required real-service suites can pass by being skipped

**P2 — Test truthfulness**

CI validates nonzero/no-skip JSON only for direct-webhook and distributed-rate-
limit API cohorts. Other required API resilience/compatibility, worker transport
and integration, and artifact-store control-ledger suites still select
`describe.skip` from environment flags or URLs. CI is configured correctly
today; a future typo can create a green skip.

**Change:** when CI requests a cohort, fail discovery if a service/flag is
missing. Validate machine-readable minimum test counts, zero unexpected skips,
and zero todo tests for every required cohort. Retain opt-in skips for ordinary
local runs only.

**Accept when:** removing one required environment value fails the job and every
configured job reports its expected nonzero cohort with no skips.

### A-06 — Image scanning is not a protected per-change gate

**P2 — CI/security**

The image is built, non-root/read-only checked, and scanned only by the manual/
weekly release gate. Normal protected CI validates contracts but does not scan
the production image; none of the ten required contexts is the image scan.

**Change:** scan image-affecting PRs and require the status, or enforce an
immutable pre-deployment gate against the exact promoted digest. PR feedback is
preferable.

**Accept when:** a disposable vulnerable image blocks merge/promotion, the
scanned digest equals the deployed digest, and policy prevents bypass.

### A-07 — Database readiness is a 1,798-line monolith

**P2 — Readability/correctness**

`packages/database/src/readiness.ts:81` spans roughly 1,798 lines, a 44-field
row, a large SQL projection, and dozens of ordered checks. It is fail-closed and
well tested; this is a maintainability/diagnostic finding, not known incorrectness.

**Change:** retain one public probe and shared connection/snapshot where needed,
but use phase/capability-owned typed descriptors, validation helpers, and
structured failures. Do not create public one-column abstractions.

**Accept when:** all missing table/role/grant/policy/function/head/compatibility
drift tests remain green, extracted probes have focused fixtures, failures name
their owner, and top-level complexity falls below the agreed budget.

### A-08 — Workflow publication concentrates too many invariants

**P2 — Readability/correctness**

`workflow-authoring.ts:564` begins an approximately 817-line factory. Its
roughly 330-line publish transaction coordinates idempotency, locks, ETags,
parse/compile, immutable versions, projections, pointer update, outbox, audit,
and completion. One transaction is correct; one giant lexical block is not
required.

**Change:** retain one client/transaction and extract named internal steps for
claim/replay, locked state, compilation/version persistence, projections,
side-effect records, and completion.

**Accept when:** step-level failure injection proves rollback, version reuse,
ETags, replay/conflict, and audit/outbox ordering without widening the API.

### A-09 — API features import sibling implementation internals

**P2 — Architecture/imports**

Node testing imports workflow-authoring persistence, parsing, mapping, guards,
and errors; workflow-authoring imports/re-exports node-testing internals; the
webhook runtime calls checkpoint creation from a workflow-runs PostgreSQL file.
There is no ESM cycle, but conceptual ownership is cyclic.

**Change:** move genuinely shared representation logic behind a neutral domain
capability, keep errors with their feature, expose checkpoint creation through
a narrow execution capability, and forbid sibling-internal imports.

**Accept when:** static tests reject internal crossings, each Nest module
instantiates through declared capabilities, reverse re-exports disappear, and
behavior remains green.

### A-10 — Validated API response types are erased to `unknown`

**P2 — TypeScript**

Workflow validation/version-list and node-test/preview use cases return
`Promise<unknown>` despite parsing explicit Zod response schemas whose output
types exist in `packages/contracts`.

**Change:** return exported or derived `z.output<typeof Schema>` types,
including response unions, while preserving runtime parsing.

**Accept when:** compile-time contract tests assign every result to its exact
response type, reject invalid variants, and runtime schema tests stay green.

### A-11 — Container builds include a mutable OS upgrade

**P2 — Reproducibility**

The Node image is digest-pinned, but the runtime performs unrestricted
`apt-get update && apt-get upgrade` and installs unpinned `tini`. Identical
commits can resolve different Debian packages on different dates.

**Change:** remove the broad upgrade; use a reviewed base containing init or a
dated snapshot with exact packages. Record provenance and an SBOM for promoted
digests.

**Accept when:** clean rebuilds are reproducible (or have documented equivalent
inputs), runtime remains non-root/read-only, and the promoted digest is scanned.

### A-12 — Dependency update automation is incomplete and noisy

**P2 — Dependencies**

Dependabot ignores pnpm/npm. `pnpm outdated -r` shows updates but the security
audit is green. The current Docker bot PR proposes unsupported Node 26 against a
Node 24 policy and fails CI.

**Change:** add bounded grouped npm updates, separate security work, constrain
Docker updates to 24.x until an explicit runtime upgrade updates engines/CI/
compatibility, and close or refresh incompatible bot work.

**Accept when:** relevant bounded JS and Docker PRs appear, supported updates
pass, security updates are timely, and major runtime moves require a decision.

### A-13 — Complexity has no automated ratchet

**P2 — Maintainability**

There are 49 files over 500 lines and 51 functions over 200 lines, but ESLint
sets no complexity, statement, or size budget. Size alone is not a defect; the
largest functions also contain many branches and responsibilities.

**Change:** baseline and ratchet hotspots: no new unapproved hotspot and no
worsening touched hotspot. Apply budgets to ordinary orchestration, allowlist
schema/data declarations, and report top hotspots. Refactor by invariant, never
arbitrary line count.

**Accept when:** CI blocks regressions and focused refactors reduce the hotspot
list without increasing public surface or weakening tests.

### A-14 — Database retains a broad compatibility root

**P3 — Package API**

`packages/database/src/index.ts` is approximately 568 export lines and its
contract calls it the broad compatibility root. Production uses better
`api`, `execution`, `lifecycle`, `maintenance`, `operator`, and
`recovery` surfaces.

**Change:** block new root imports, inventory consumers, move test/migration
capabilities to explicit subpaths, and retire or minimize `.` when consumers
reach zero. Do not split the package merely to remove a barrel.

**Accept when:** all consumers use explicit capabilities and the root is removed
or intentionally minimal.

### A-15 — Some tests use avoidable real-time sleeps

**P3 — Test speed/reliability**

Fixed waits occur in 39 test files. Some prove real cancellation/deadlines;
others wait about 5.1 seconds for session expiry or about 1.1 seconds for leases.

**Change:** inject clocks or set database timestamps where semantics, not real
time, are under test. Retain and document waits only for actual process/network/
clock boundaries.

**Accept when:** replaced tests prove the same boundary without elapsed sleeps
and repeated CI shows no new flakes.

### A-16 — A few implementations are exact or near clones

**P3 — Reuse**

API and worker observability Nest modules duplicate about 90 lines; email and
Slack telemetry are near clones. Total duplication is low, so this is local.

**Change:** extract a narrow shared Nest integration only if lifecycle behavior
must remain identical, and a typed provider-telemetry factory for the genuine
common invariant. Do not create a generic shared dumping ground.

**Accept when:** clones disappear, lifecycle/metric tests stay green, and the
new helper owns stable behavior rather than just fewer lines.

### A-17 — Fastify integration uses localized double assertions

**P3 — Type boundary**

`apps/api/src/app.ts` uses two `as unknown as FastifyInstance` conversions.
No broad production `any` or unsafe-cast pattern was found.

**Change:** use the typed adapter API or one named helper with a minimal runtime
capability check.

**Accept when:** repeated assertions disappear and HTTP startup/shutdown tests
remain green.

### A-18 — Review ownership and current documentation are weak

**P3 — Governance/docs**

Protected `main` has strict checks, admin enforcement, linear history,
resolved conversations, and no force-push/deletion, but requires zero approvals,
no code-owner review, and no signed commits. The 4,600-line tracker mixes current
status with history; its date and README's “orchestration slice” wording lag the
actual Phase 7 status.

**Change:** for production/multi-contributor work require one approval, add
CODEOWNERS for auth/data/deployment paths, consider verified commits, split a
concise current tracker from linked history, and update status text with phases.

**Accept when:** settings enforce the chosen policy, an unreviewed proof PR
cannot merge, critical owners exist, and README/current tracker agree. A solo
workflow may explicitly accept the approval risk, but this repository is public
and production-oriented.

## 6. Highest-value code hotspots

| Location | Approximate size | Best seam |
| --- | ---: | --- |
| `database/readiness.ts:81` | 1,798 lines / 67 branches | Capability probes under one orchestrator |
| `database/workflow-authoring.ts:564` | 817 / 91 | Operation modules sharing one transaction |
| `database/workspace-purge.ts:214` | 584 / 67 | Inventory, fencing, mutation, side effects, completion |
| `database/control-ledger-coordinator.ts:468` | 578 / 69 | Reconciliation steps and command policy |
| `database/workspace-purge.ts:263` | 533 / 64 | Explicit fenced purge-state handlers |
| `database/identity-workspace.ts:566` | 505 / 40 | Identity, membership, session, audit operations |
| `database/failure-notifications.ts:240` | 494 / 73 | Claim, resolve, result, recovery steps |
| `workflow-engine/persisted-observations.ts:211` | 435 / 126 | Per-kind parser table and indexed lookup |
| `database/coordinator-run-store-plan.ts:413` | 257 / 106 | Status validators with exhaustive dispatch |

For each refactor: characterize behavior first; preserve public interfaces;
keep transactions, locks, and authorization at one owner; extract by invariant;
and compare query count/plans/latency before claiming improvement.

## 7. Are all monorepo packages needed?

Yes. There is no generic `shared` package. All twelve packages own a real
domain or runtime capability.

| Package | Verdict |
| --- | --- |
| `artifact-store` | Keep: bounded object persistence/lifecycle boundary |
| `contracts` | Keep: transport schemas; export exact response outputs |
| `database` | Keep: authority/persistence; deepen internals and retire root |
| `integrations` | Keep: provider boundary; consolidate telemetry only |
| `node-catalog` | Keep: catalog/version resolution |
| `node-sdk` | Keep: stable definition/executor contracts |
| `nodes-core` | Keep: built-ins separate from their SDK |
| `observability` | Keep: cross-process telemetry invariant |
| `queue` | Keep: identifier-only transport/lease policy |
| `rate-limit` | Keep: small but genuinely shared distributed policy |
| `workflow-engine` | Keep: infrastructure-free state machine |
| `workflow-model` | Keep: authoring/compiled model and expression policy |

Do not add `shared`, `utils`, or `common`. A package should own a stable
capability, dependency direction, security boundary, or reusable contract.
Prefer explicit subpaths, keep frameworks out of domain packages, and give every
compatibility export an owner, consumer inventory, and removal condition.

## 8. Testing and CI answers

Testing is one of the strongest areas. It covers unit behavior, real PostgreSQL/
RLS, Redis/BullMQ, S3-compatible storage, migrations, crashes, outages,
compatibility, retention, recovery, HTTP, and security boundaries. The caveats
are A-05/A-15 and selective—not global—coverage.

The directory layout is good. Package-local `test/`, `test/support`, and
`test/fixtures` plus dedicated Vitest configs preserve ownership and CI
partitioning. A top-level testing package would blur boundaries. Keep helpers in
the owning test tree, name suites by invariant, use deterministic barriers, and
make requested CI cohorts fail closed with expected counts.

It runs successfully in GitHub. Keep the quality, three unit, coverage,
integration, recovery, compatibility, and deployment-security partitions rather
than building a serial mega-job. Add universal no-skip proof and image-scan
protection before treating green as complete release evidence.

## 9. Area conclusions

- **Architecture:** coherent modular monolith and authority model; correct the
  sibling-internal imports. Early and late code did not drift into incompatible
  architectures; late operational code mainly became denser.
- **Readability:** naming is domain-specific and explicit. Closure-based
  persistence factories, not giant classes, are the main issue.
- **Imports:** direction is strongly linted and no cycle was detected. Narrow
  sibling crossings and the database root.
- **Reuse:** duplication is low and abstractions usually own real invariants.
  The codebase is not broadly overabstracted.
- **TypeScript:** strict schemas, unions, immutable values, and typed SQL rows
  are strong. Fix known outputs typed as `unknown` and isolate casts.
- **NestJS:** modules, guards, filters, validation, rate limits, and shutdown are
  sound; feature ownership is the main weakness.
- **PostgreSQL:** forced RLS, role separation, transaction-local scope, pool
  hygiene, checksummed locked migrations, leases/fences/outbox are strong.
  Add session/idempotency lifecycle ownership.
- **Security/privacy:** auth, browser binding, PKCE/CSRF, SSRF, webhooks,
  redaction, encryption, abuse limits, and non-root runtime are strong. GitHub
  controls and indefinite metadata retention are the gaps.
- **Reliability:** durable checkpoints, bounded claims, recovery, cancellation,
  and failure tests are unusually deep. Cloud recovery still needs observation.
- **Performance:** bounded work and separate scale signals are sensible. Prove
  load, fairness, query plans, and aggregate connections at real scale.
- **Observability:** broad logs/traces/metrics/dashboards/alerts/runbooks exist.
  Close the loop with a deployed pager/operator exercise.
- **Supply chain:** exact dependencies, frozen lockfile, pinned Actions/images,
  CodeQL, auditing, and hardened runtime are good. Fix A-02/A-06/A-11/A-12.
- **Dead code:** no package is obviously obsolete. The broad database root is
  the clearest retirement target; run a pinned compatible dead-export tool
  periodically and review rather than auto-delete its output.

## 10. Remediation order and closure rule

1. Enable repository security controls (A-02).
2. Complete immutable live Phase 7 evidence, including DB capacity (A-01).
3. Add idempotency/session retention (A-03/A-04).
4. Fail every requested suite on skip and protect image scanning (A-05/A-06).
5. Refactor readiness/publication with failure characterization (A-07/A-08).
6. Correct feature ownership and exact response types (A-09/A-10).
7. Make images reproducible and dependency automation useful (A-11/A-12).
8. Install the complexity ratchet (A-13).
9. Address A-14 through A-18 in focused cleanup or when touching those areas.

Close a finding only when its change exists, its acceptance evidence passes,
failure paths remain tested, the implementation tracker records concrete proof,
and this audit is refreshed at a new fixed head. The target is not more
abstractions or a vanity coverage number. It is one clear owner per invariant,
narrow interfaces, explicit transactions and failures, tests that cannot pass
without running, production claims backed by observation, and routine changes
that do not require understanding thousand-line orchestration blocks.
