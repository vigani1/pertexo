# Whole-Repository Engineering Audit

Recorded: 2026-09-04

Audited implementation tree: `8fa2a2df36cd125c275919914add3f25e3f49c22`

Status: current resolution and remaining external-evidence plan

## 1. Executive verdict

This is a strong, serious backend codebase. Every repository-fixable correctness,
security, and runtime finding in this audit has been remediated or, where the
audit explicitly required restraint, reviewed and intentionally retained with a
documented reason. Test-suite decomposition and its owner-local setup extraction
are complete; the corrected clone statistic is pinned and reproducible. The modular-
monolith direction is sound; the workspace dependency graph is acyclic; package
export maps are deliberate; the TypeScript baseline is strict; runtime trust
boundaries are parsed; tenant isolation and transactional behavior receive
unusually strong real PostgreSQL coverage; and source duplication is low.

The initial audit found an open high-severity CodeQL alert, patchable Fastify
advisories, a worker production-packaging defect, and security gates that proved
tool execution rather than alert absence. Those are historical finding contexts,
not current defects at this implementation tree. The logger was bounded and
rescanned, Fastify and its lockfile paths were patched, the production dependency
graph and image role-load smoke were corrected, dependency admission now fails
at moderate severity, and ruleset `22213497` blocks high/critical code-scanning
alerts. Exact-main CI and CodeQL subsequently passed with zero open CodeQL and
Dependabot alerts. The repository-controlled security signal is therefore green;
signed hosted provenance and live provider/AWS exercises remain external evidence,
not missing local code.

The largest engineering debt remains concentration, but the repository-wide
A-06 refactor reduced the accepted baseline from 45 to 35 production-file
hotspots and from 42 to 40 function hotspots. The former 1,961-line database
schema and 1,356/1,340-line checkpoint/executable modules are now bounded-
context or grammar modules behind 165-, 92-, and 28-line stable composition
boundaries. The ratchet prevents new or worsened hotspots and the remaining
inventory is explicit; large transaction and state-machine functions still
need the same focused, behavior-preserving treatment when their owning
capability is changed.

Testing is broad in behavior and strong in failure scenarios, but the reported
coverage percentages are intentionally narrow. They instrument 30 selected
files containing 1,736 coverable lines. Those percentages must never be
described as package-wide or repository-wide coverage. The selected branch
inventory is now well controlled: 116 uncovered branches have semantic source
fingerprints and individual reviews, with zero unreviewed sites. Test-code
navigation improved because no test file exceeds 1,000 lines, and genuinely
shared split-suite setup now has owner-local support modules.

Current decision:

- Continue development: **GO**.
- Treat the architecture as a sound foundation: **GO**.
- Describe local quality checks and the exact-head GitHub CI and security state
  as green: **GO**.
- Call the code finished, perfectly clean, or fully covered: **NO-GO**.
- Claim Phase 7 or production readiness: **NO-GO**.

The code is good overall: readable at local boundaries, highly defensive, and
carefully tested. Its remaining engineering limits are explicit rather than
hidden: 35 accepted production-file hotspots, 40 accepted function hotspots,
selected rather than repository-wide coverage, solo-maintainer review policy,
and the external Phase 7 evidence required
before production readiness.

## 2. Scope, method, and scoring

### 2.1 What was reviewed

The review covered the repository rather than one phase or feature branch:

- the authoritative backend plan, supporting research, ADRs, implementation
  tracker, runbooks, and existing audit;
- all 6 applications and 12 packages, their dependency directions, manifests,
  export maps, TypeScript project references, and test configurations;
- representative API controllers, use cases, modules, guards, exception
  handling, identity boundaries, worker composition, workflow engine parsers
  and transitions, database transactions, raw SQL, schemas, migrations, RLS,
  object storage, queueing, telemetry, and operator processes;
- all production-file and function complexity measurements, source and test
  clone detection, unused file/export/dependency analysis, unsafe TypeScript
  escape-hatch searches, trust-boundary parsing, generic-folder naming, and
  package-internal import checks;
- unit, critical-file coverage, risk-coverage, deployment, image, exercise,
  dependency, GitHub Actions, CodeQL, Dependabot, branch-protection, and
  exact-main CI evidence;
- operational readiness, recovery, capacity, observability, deployment
  identity, artifact provenance, external-provider verification, ownership,
  review policy, and public-repository governance.

This was a static and executable repository audit. It was not a penetration
test, a live AWS review, a production load test, a backup restoration, or a
review of unavailable business/product telemetry.

### 2.2 External calibration

No credible standard defines a universally correct package count, file length,
function length, or coverage percentage. The numerical scores in this document
are review judgments under the fixed rubric below, not percentiles. External
guidance was used to choose questions and evidence:

| Dimension | Primary guidance | Application in this review |
| --- | --- | --- |
| Code health | Google's [code-review checklist](https://google.github.io/eng-practices/review/reviewer/looking-for.html), [review standard](https://google.github.io/eng-practices/review/reviewer/standard.html), and [small-change guidance](https://google.github.io/eng-practices/review/developer/small-cls.html) | Checked design, functionality, naming, comments, tests, complexity, future-proofing, and whether each change can improve rather than merely preserve code health |
| TypeScript scale | TypeScript [project references](https://www.typescriptlang.org/docs/handbook/project-references) | Checked that the monorepo is divided into independently compiled projects with declared logical dependencies and build ordering |
| Package APIs | Node.js [package exports](https://nodejs.org/api/packages.html) | Checked explicit public entry points and prevention of accidental consumer access to package internals |
| NestJS architecture | NestJS [modules](https://docs.nestjs.com/modules) and [providers](https://docs.nestjs.com/providers) | Checked feature ownership, exported provider surfaces, constructor injection, controller thinness, and global-module use |
| API security | [OWASP ASVS](https://owasp.org/www-project-application-security-verification-standard/) and the [OWASP API Security project](https://owasp.org/www-project-api-security/) | Checked authentication, object/function authorization, validation, resource limits, SSRF/provider consumption, logging, and security verification |
| PostgreSQL | PostgreSQL documentation for [row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html), [indexes](https://www.postgresql.org/docs/current/indexes.html), and [transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html) | Checked forced RLS, role separation, transaction-local tenant context, concurrency, constraints, index intent, and the boundary between repository proof and live workload proof |
| CI security | GitHub's [secure-use reference](https://docs.github.com/en/actions/reference/security/secure-use), [dependency review](https://docs.github.com/en/code-security/concepts/supply-chain-security/dependency-review), and [code-scanning merge protection](https://docs.github.com/en/code-security/concepts/code-scanning/merge-protection) | Checked immutable action references, token permissions, dependency admission, and whether security findings actually block merges |
| Supply chain | SLSA [provenance](https://slsa.dev/spec/v1.2/provenance) and [build levels](https://slsa.dev/spec/v1.2/build-track-basics) | Distinguished repository-generated metadata from hosted, signed, verified build provenance |
| Production readiness | Google's [production-readiness review model](https://sre.google/sre-book/evolving-sre-engagement-model/) and [capacity guidance](https://sre.google/sre-book/introduction/) | Required observed dependency, monitoring, emergency-response, capacity, change-management, latency, and efficiency evidence |

The local codebase-design guidance added four tests: interface depth, leverage,
locality, and deletion value. Similar-looking code was not automatically called
duplication, and a large function was not called defective solely because of
line count. The question was whether the shape increases change cost, obscures
an invariant, or expands the public surface without leverage.

### 2.3 Score rubric

| Score | Meaning |
| ---: | --- |
| 9–10 | Strong design, automated regression protection, no material known repository defect; 10 also requires current operational proof |
| 8–8.9 | Sound implementation with bounded but material maintainability, assurance, or evidence gaps |
| 7–7.9 | Good foundation with a significant current defect, debt concentration, or incomplete verification surface |
| 5–6.9 | Important release or operational blockers despite useful foundations |
| Below 5 | Foundational correctness, security, or maintainability weakness |

Scores reflect the remediated implementation tree, while separating selected-
file coverage from whole-repository coverage and repository proof from live
operational proof. Historical finding text below records why changes were made;
each remediation status records the current disposition.

## 3. Current scorecard

| Area | Score | Current reason |
| --- | ---: | --- |
| Architecture and domain ownership | 9.1/10 | Correct modular-monolith, dependency direction, capability ownership, and stable public seams |
| Repository and file structure | 9.0/10 | Database, schema, and workflow internals have capability-local owners and stable public facades; 35 explicitly accepted file hotspots remain |
| Readability and maintainability | 9.0/10 | Strong naming and explicit invariants; the ratchet holds 35 file and 40 function hotspots, while test setup is owner-local |
| Abstraction, reuse, and package design | 9.1/10 | Packages are justified, duplication is low, manifests are checked, and unsupported internal exports were removed |
| TypeScript and runtime contracts | 9.2/10 | Strict compiler baseline, typed tests, explicit exports, runtime parsing, and manifest/declaration dependency validation are enforced |
| NestJS/API design | 9.1/10 | Feature modules, guards, use cases, DI, centralized feature-owned error mapping, bounded rate limiting, and joined replies are verified |
| PostgreSQL and data integrity | 9.1/10 | Transaction, tenancy, UUIDv7, typed-schema ownership, migration, and RLS conventions are executable gates |
| Application and dependency security | 9.2/10 | No known production advisory or open code-scanning alert; moderate dependency admission and high/critical code-scanning merge protection are active |
| Test behavior and failure confidence | 9.2/10 | More than 1,600 unit tests plus strong real-service/recovery/process cohorts; no test file exceeds the limit and shared split-suite setup is owner-local |
| Coverage breadth and mutation confidence | 8.2/10 | Exact controls cover 30 selected critical files/1,736 coverable lines with 116 reviewed and zero unreviewed branches; this remains intentionally non-global |
| CI and change governance | 9.1/10 | Exact-head CI is comprehensive; dependency review, explicit docs/history checks, code-scanning merge protection, and rebase-tree identity are enforced; independent approval awaits a second maintainer |
| Reliability and durability | 9.1/10 | Crash, redelivery, fencing, idempotency, compatibility, shutdown, and unknown publication outcomes have regression coverage |
| Observability and operability | 8.7/10 | Broad telemetry and runbooks exist and logger safety is verified; live dashboard, alert, and pager behavior remain external evidence |
| Performance and scalability | 6.8/10 | Bounded local harnesses and index-aware tests exist, but representative load, saturation, fairness, pool budgets, and DB plans are not evidenced |
| Documentation and governance | 9.1/10 | Detailed plan/ADRs/progress, contribution/security policies, explicit no-license decision, and pinned clone evidence are maintained |
| Production readiness | 6.5/10 | Repository-controlled prerequisites are green, but authoritative live AWS, load, capacity, pager, backup/PITR, failover, provenance, provider, and regional recovery evidence remain open |

Overall codebase engineering quality: **8.8/10**.

Overall project state including production readiness: **8.4/10**.

These are not mathematical claims of “81% good.” They are a compact summary
of the evidence and priorities below.

## 4. Repository facts

- 6 applications and 12 reusable packages; 18 referenced workspace projects.
- 514 tracked production TypeScript source files and 365 tracked TypeScript
  test/support files.
- 87,792 physical production source lines and 94,788 physical test/support
  lines.
- 3,685 production function-like declarations, 279 classes, and 322
  interfaces under `apps/*/src` and `packages/*/src`.
- 35 source files over the repository's 500-line budget.
- 40 functions over the repository's 200-line or 40-branch budget.
- 40 production functions over 200 lexical lines; 8 exceed 400 lines.
- 45 reviewed source clone groups at a 12-line/80-token threshold: 992
  duplicated lines, **1.15%** of the analyzed source.
- A reproducible post-remediation scan of every `apps/*/test` and
  `packages/*/test` TypeScript file at the 18-line/130-token threshold reports
  6 reviewed clone groups and 267 duplicated lines, **0.29%** of the analyzed
  test corpus, down from 25 groups/1,977 lines (2.08%).
- Current static unused-code/package-boundary analysis passes without unused
  files, dependencies, unsupported exports, or duplicate-export findings. The
  original candidate inventory was reviewed under A-03 rather than deleted
  mechanically.
- No production `any`, `as unknown as`, `@ts-ignore`, or `@ts-expect-error`
  escape hatch was found. Test adapters use localized assertions to model
  foreign interfaces and invalid runtime input.
- No Nest `forwardRef` or `ModuleRef` service locator was found. There is one
  deliberate global HTTP platform module.
- No production import from another workspace's `src` or `dist` internals was
  found; package export maps and ESLint direction rules guard those boundaries.
- The package dependency graph is acyclic.

## 5. Findings register and resolution

Priority meanings: **P0** immediate correctness/data-loss/exploit emergency;
**P1** fix before production or the next release candidate; **P2** planned
engineering work; **P3** maintainability/hygiene improvement. No P0 issue was
found. The table preserves each finding as originally detected and its required
outcome; the remediation status under each finding is authoritative for the
audited implementation tree.

| ID | Priority | Finding | Required outcome |
| --- | --- | --- | --- |
| A-01 | P1 | Open high-severity CodeQL polynomial-ReDoS alert in structured log redaction | Bound input before regex work, remove ambiguous matching, add adversarial timing/regression tests, close the alert, and make high security alerts merge-blocking |
| A-02 | P1 | Two Fastify runtime advisories remain although 5.12.1 is available; dependency CI fails only at high | Resolve direct and Nest-transitive Fastify versions, test proxy/validation behavior, and adopt an explicit medium-or-risk-accepted dependency policy |
| A-03 | P1 | Worker production output imports a workspace package declared only as a development dependency | Move the runtime dependency to `dependencies` and prove an isolated production install/image can load every role entry point |
| A-14 | P1 | Worker's process-keepalive interval is never owned, cleared, or unreferenced | Tie keepalive lifetime to application shutdown and prove SIGTERM exits within the ECS drain budget with consumers disabled |
| A-04 | P1 | Phase 7 production evidence is incomplete | Produce immutable-release-bound live AWS, load, capacity, backup/PITR, failover, regional recovery, dashboard, alert, pager, and runbook evidence |
| A-05 | P2 | Coverage headlines describe selected files, not the repository | Publish scope with every percentage, expand selection by consequence, add mutation canaries, and trend skips/retries/duration/flake |
| A-06 | P2 | Complexity and directory concentration make changes expensive | Reorganize database/engine internals by capability and reduce named hotspots behind unchanged public interfaces and characterization tests |
| A-07 | P2 | API controllers repeat per-endpoint error mapping | Move feature-owned mapping to a filter/interceptor composition so controllers retain parsing, authorization metadata, and use-case delegation without repeated catches |
| A-08 | P2 | Image evidence is digest-bound metadata, not signed hosted provenance; live provider canaries are absent | Generate and verify signed hosted provenance and run safe credentialed provider contracts for the exact promoted digest |
| A-09 | P2 | Required CodeQL status proves analysis completion, not absence of alerts; branch protection requires zero approvals | Add code-scanning merge protection and, when a second maintainer exists, non-author/code-owner approval for critical paths |
| A-15 | P2 | Publish timeouts reject without canceling or reconciling the underlying operation | Introduce cancellation or an explicit unknown-outcome reconciliation state before releasing ownership and retrying |
| A-16 | P2 | Persistence conventions have drifted from the authoritative plan | Enforce UUIDv7 for persisted identifiers, account for all migration-owned tables in typed schema/registry checks, and resolve the retention-scheduler RLS exception |
| A-17 | P2 | Redis rate-limit calls are not end-to-end bounded and webhook reply promises are detached | Bound connection/command time and return/await native Fastify replies with stalled-backend and send-failure tests |
| A-10 | P3 | Internal exports are wider than observed consumers need; manifest/type surfaces need cleanup | Configure dependency/export validation, correct the API's declaration dependency, remove verified dead exports and the unused worker telemetry dev dependency, and preserve intentional entry points explicitly |
| A-11 | P3 | Several test files and top-level suites exceed 1,000 lines | Split by behavior/failure mode and reuse owner-local fixtures without hiding scenario setup or assertions |
| A-12 | P3 | Four repository tools exceed 300 lines while `.mjs` typed linting is disabled | Keep small Node tools in `.mjs`; convert or add checked types to large domain-shaped tools when touched |
| A-13 | P3 | Public-repository and workflow hygiene is incomplete | Add `SECURITY.md`, `CONTRIBUTING.md`, make an explicit license decision, remove the duplicate YAML key, and document security triage expectations |
| A-18 | P3 | Similar credential schemas and metadata/runtime imports create semantic and startup coupling | Name and test wire-versus-resolved credential semantics; split metadata-only loading only if measurement shows value |
| A-19 | P3 | The backend plan names `apps/web`, but this checkout is backend-only | State explicitly whether the web application is deferred, external, or removed from this repository's delivery scope |

### A-01 — Logger redaction can consume polynomial time

**Remediation status (2026-09-03): complete.**
`redactText` now bounds every string to
16,384 characters before pattern matching, drops an incomplete trailing token,
and appends an explicit truncation marker. URL-userinfo redaction is a
monotonic scanner rather than the ambiguous repeated-character expression.
The same path sanitizes ordinary fields, error messages, stacks, and causes.
Two adversarial regressions reproduce the former five-second scan, constrain
output size, cover messages/stacks, and now complete with the full 41-test
observability suite in under 300 ms; observability typecheck and the unchanged
complexity ratchet pass. Pull-request and exact-main CodeQL pass, alert 2 is
closed, and active repository
ruleset `22213497` blocks `main` updates with CodeQL analysis errors or
high/critical security alerts. No open CodeQL alert remains on the default
branch.

At the initial audit snapshot, GitHub CodeQL alert 2 was open on
`packages/observability/src/logger.ts:89`. The first `redactText` expression
contains ambiguous repeated character classes and processes logger input without
a maximum string length. CodeQL traces that input from every public logger
method. Because request/provider/error material can reach logging, this is a
credible availability risk even though no exploit was demonstrated during this
audit.

Required change:

1. Put a small, named maximum on every string before expensive redaction. Keep
   an explicit truncation marker and apply the same rule to error messages and
   stacks.
2. Replace the ambiguous URL-userinfo expression with a linear parser or a
   demonstrably linear expression. Do not weaken secret removal to silence the
   alert.
3. Add adversarial tests using long matching prefixes and non-matching suffixes;
   assert bounded output and a conservative time budget without making the test
   hardware-fragile.
4. Re-run CodeQL and close only after the fixed commit is analyzed.
5. Add a GitHub ruleset requiring CodeQL with at least “high or higher” security
   alerts. The ordinary `analyze` status check alone is insufficient.

Acceptance evidence: focused logger tests, `pnpm check`, CodeQL on the exact
commit, zero open high/critical alerts attributable to current code, and an
active code-scanning merge-protection rule.

### A-02 — Patchable Fastify advisories are allowed by the gate

**Remediation status (2026-09-03): complete.** The direct API dependency and Nest's
transitive copy are both forced to Fastify 5.12.1; `pnpm why fastify -r` now
reports one version and `pnpm security:audit` reports no known production
vulnerability. Because patched Fastify rejects insecure numeric proxy-hop
trust, deployed configuration now requires explicit `TRUST_PROXY_CIDRS` IP/CIDR
networks and passes them to Fastify's address-validating trust policy. Tests
cover an untrusted direct peer spoofing `X-Forwarded-For`, an allowed ingress,
invalid network configuration, and root-primitive coercion reaching the handler
as the validated number. Production audit admission now fails at `moderate`,
and pull requests run the SHA-pinned dependency-review action at the same
threshold. The full repository gate passes, and GitHub reports zero open
Dependabot alerts on the default branch.

At the initial audit snapshot, `pnpm audit --prod --audit-level high` exited
successfully while reporting two moderate advisories:

- schema-validation bypass through root primitive coercion mismatch;
- `X-Forwarded-*` spoofing with hop-count `trustProxy` configuration.

The API then pinned Fastify 5.12.0 and configured `trustProxy` from
`trustedProxyHops`; Nest's Fastify platform dependency resolves another 5.11.3
copy. Both advisories identify 5.12.1 as fixed. GitHub currently represents the
two unique advisories as four open Dependabot alerts because direct-manifest and
lockfile paths are tracked separately.

Required change:

1. Resolve both direct and transitive copies to a fixed version through a
   compatible Nest/Fastify upgrade or a reviewed workspace override.
2. Add regression cases for primitive request roots and the deployed proxy-hop
   model, including attacker-controlled forwarded headers.
3. Change dependency admission to fail for medium-or-higher production
   vulnerabilities, or maintain a machine-readable, owner/date/justification-
   bound exception process. A permanently high-only gate is too permissive for
   an internet-facing API.
4. Add dependency review to pull requests so a vulnerable version is rejected
   before it reaches `main`, not only discovered afterward.

The initial upgrade attempt was not acceptable until the lockfile no longer
contained the Nest-transitive 5.11.3 copy and the changed Fastify `trustProxy`
contract passed the forwarded-client regression. The completed remediation
satisfies both conditions.

Acceptance evidence: `pnpm audit --prod --audit-level moderate` exits zero,
`pnpm why fastify --recursive` shows only fixed versions, Dependabot alerts
close on the exact lockfile, and proxy/validation regressions pass locally and
in CI.

### A-03 — Worker runtime dependency is classified as development-only

**Remediation status (2026-09-03): complete.** `@pertexo/workflow-model` is now a worker production
dependency, the API's declaration-visible `@pertexo/node-sdk` edge is likewise
declared in production dependencies, and the worker's verified-unused
`@opentelemetry/sdk-node` development dependency was removed. Root
`dependencies:check` pins Knip 5.80.0 and is part of `pnpm check`; it reports no
unused or unlisted manifest dependency. The production-image job now imports
the side-effect-free composition module for every runtime role plus database
migrations from the final `--prod` image, so a missing workspace/runtime edge
fails CI before publication. Local API and worker typechecks pass. The local
Docker daemon was unavailable for duplicating that final-stage import check;
the hosted production-image job subsequently passed on exact `main`.

The emitted worker JavaScript imports `@pertexo/workflow-model` from the failure
notification delivery and handler modules. `apps/worker/package.json` lists the
package only in `devDependencies`. The production image deliberately runs
`pnpm install --prod`, so an isolated production dependency graph is not
contractually required to install or link that package. A full developer
workspace can conceal this because development installation hoists/links the
missing edge. pnpm's [production install contract](https://pnpm.io/cli/install)
explicitly omits development dependencies under `--prod`.

The API has a related but lower-risk declaration-surface mismatch:
`apps/api/src/node-testing` exports types that refer to `@pertexo/node-sdk`, but
that package is also declared only as a development dependency. Type-only
imports disappear from JavaScript, so this is not the same runtime failure, but
the generated declarations retain a consumer-visible package reference.

Required change:

1. Move `@pertexo/workflow-model` to worker `dependencies` and update the
   lockfile. Do not rely on workspace hoisting as an undeclared runtime edge.
2. Either make `@pertexo/node-sdk` an API production dependency or remove it
   from the API's emitted public declaration surface.
3. Add a manifest/dependency check that distinguishes runtime, declaration-
   only, development, test, and intentionally optional edges.
4. Build an isolated production dependency tree—the same shape copied into the
   final image—and load every compiled process entry point before publishing.

Acceptance evidence: the worker model edge appears under production
dependencies, an isolated `--prod` install resolves it without a root
development install, all compiled role entry points load, and the production
image smoke runs in CI.

### A-14 — Worker keepalive outlives application shutdown

**Remediation status (2026-09-03): repository implementation complete; live
image drain evidence remains A-04.** The anonymous interval was replaced by
`WorkerProcessKeepalive`, a Nest lifecycle owner that starts idempotently and
clears its only handle in `beforeApplicationShutdown`. The worker module owns
the provider, and its fake-timer regression proves no referenced timer remains
after shutdown. Repository-wide interval ownership search found the other
worker monitors already store and clear their handles. A compiled child-process
cohort now starts disabled-consumer and active-consumer workers, covers
bootstrap failure, sends SIGTERM, and proves bounded clean exit with application,
consumer, database, telemetry, and keepalive cleanup. Worker build, typecheck,
and focused lifecycle suites pass. A deployed ECS SIGTERM exercise under the
120-second stop timeout still requires the runtime environment and is not
represented as local proof.

`apps/worker/src/main.ts` creates a referenced interval with the maximum Node
timer delay so the process stays alive when every consumer is disabled. The
handle is not stored, cleared, or unreferenced. Once shutdown hooks install
signal handlers, closing the Nest application and queue connections does not
remove this event-loop reference. A disabled-consumer worker can therefore
remain alive after SIGTERM until ECS exhausts its 120-second drain window and
forcibly terminates it. Node documents that a referenced timer keeps the event
loop active and exposes [`unref()`](https://nodejs.org/api/timers.html#timeoutunref)
for the opposite behavior; Nest separately documents the lifecycle-hook
boundary in its [shutdown guidance](https://docs.nestjs.com/fundamentals/lifecycle-events).

Required change:

1. Give the keepalive handle an owner with an explicit start/stop lifecycle, or
   call `unref()` if the remaining owned resources should determine lifetime.
2. Make process shutdown a single idempotent path that closes the application,
   keepalive, telemetry, and outstanding dispatcher work in a documented order.
3. Add a compiled-process test that starts with every dispatch capability
   disabled, sends SIGTERM, and asserts clean exit well inside the deployment
   drain budget. Repeat it with one active consumer and during bootstrap
   failure.

Acceptance evidence: no anonymous referenced timer survives shutdown, the
compiled process exits zero within the bounded test, and the image-level drain
exercise passes under the ECS stop-timeout contract.

### A-04 — Repository readiness is not deployed readiness

**Remediation status (2026-09-03): intentionally open; external evidence
required.** No repository edit can manufacture the account-, region-,
credential-, workload-, backup-, failover-, pager-, or running-digest evidence
listed below. Repository-controlled prerequisites continue to be remediated by
the other findings, but A-04 closes only after the immutable release candidate
is exercised in the target AWS environment.

The repository contains detailed ECS contracts, digest pins, recovery programs,
dashboards, alerts, operator commands, and evidence schemas. These are strong
preconditions, not proof that the target environment behaves as designed.
Phase 7 remains incomplete in the authoritative progress tracker.

Required evidence for one immutable release candidate:

- target AWS account/region/VPC/service/task/IAM/KMS/S3/RDS/Redis identities and
  the exact running image digest;
- total API, worker, dispatcher, maintenance, migration, recovery, and operator
  PostgreSQL connection arithmetic with pooler behavior and emergency headroom;
- representative API, webhook, SSE, worker, queue, artifact, fan-out,
  noisy-tenant, and maintenance load at expected and peak demand;
- query plans and `pg_stat_statements` evidence for the hot paths, index usage,
  lock waits, deadlocks, temp I/O, WAL, autovacuum, bloat, XID age, disk, and
  replica lag under that workload;
- successful backup integrity verification, point-in-time restore, failover,
  failback, regional artifact/control-ledger recovery, and measured RPO/RTO;
- AWS-reported region, versioning, Object Lock/legal-hold, lifecycle,
  replication, checksum, and deletion behavior for both tenant buckets; the
  current tenant store readiness check only proves `HeadBucket`, while stronger
  control-ledger checks and configured-value comparisons do not prove these
  live tenant-bucket controls; validate this against AWS's actual
  [Object Lock](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html)
  and replication state rather than configuration intent;
- synthetic incidents that produce the intended logs, metrics, traces,
  dashboard signal, alert, page, owner response, and runbook outcome;
- rollback/progressive-rollout evidence and cleanup after every exercise.

Repository fixtures must not be relabeled as this evidence. Keep the current
Phase 7 `In progress` status until the plan's criteria are satisfied.

### A-05 — Coverage is strong but narrow

**Remediation status (2026-09-03): complete for repository evidence.** The
machine-readable report now publishes exact files, covered/total counts,
percentages, and test-health data per cohort. Selection grew from 23 to 30 files
by adding retry policy, provider failure-delivery policy, and every module in
the checkpoint grammar through public behavior tests. Exhaustive transition,
authorization, retry, and dispatch-fence
canaries pin the high-consequence decision spaces. All 116 remaining uncovered
instrumentation branches are individually reviewed with source fingerprints;
none are unreviewed. CI retains per-run duration/skip/todo/failure JSON, and
retries remain disabled so flakes cannot be masked by automatic reruns.

The selected coverage gates currently report:

| Cohort | Selected files | Coverable lines | Statements | Branches | Functions | Lines |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Workflow engine | 13 | 963 | 94.43% | 91.02% | 93.58% | 94.91% |
| Database | 1 | 99 | 96.36% | 95.38% | 100.00% | 97.97% |
| Worker | 4 | 357 | 93.18% | 93.14% | 80.00% | 93.27% |
| API | 12 | 317 | 100.00% | 100.00% | 100.00% | 100.00% |

Those are valid results for 30 selected files and 1,736 coverable lines. In
particular, “database 95.38% branch coverage” currently means
`packages/database/src/tenant-access/workspace.ts`,
not all 104 database source files. The risk report is now correctly labeled
`selected-critical-module-files`. Its remaining uncovered branches are reviewed
individually rather than automatically labeled testable or presented as whole-
repository coverage.

Required change:

- always publish the selected files and line denominator next to percentages;
- expand by risk: authentication/authorization/tenancy, state transitions,
  checkpoint parsing, fencing/leases, idempotency, retries, unknown outcomes,
  lifecycle deletion, retention/holds, provider error policy, and recovery;
- do not chase a repository-wide vanity threshold or test private statements;
- add mutation canaries to prove high-consequence tests fail when authorization,
  transition, retry, or fencing decisions are deliberately inverted;
- record duration, skipped tests, retries, and flakes per cohort over time;
- keep unit, real-service integration, compatibility, recovery, provider, load,
  and deployed drills distinct so one kind of test cannot impersonate another.

Acceptance evidence: every selected risk decision is executed or individually
reviewed; selection grows without implementation-private imports; mutation
canaries are killed; and thresholds only ratchet upward after real behavior is
covered.

### A-06 — Complexity and directory concentration

**Remediation status (2026-09-04): complete for locality; residual measured
complexity remains controlled debt.** Every
production file and function was remeasured before changing the named examples.
The accepted ratchet fell from 45 to 35 file hotspots and from 42 to 40 function
hotspots; it was regenerated only after the focused refactor and passes without
any new or worsened entry. Database internals moved from 122 TypeScript files at
`packages/database/src` to ten capability-owned directories behind 12 stable
public/composition entry points. The public testing barrel fell from 567 to 85 physical
lines and delegates exact test seams to owner-local barrels.

The affected repository locations were separated by ownership while preserving
their existing package entry points:

- `packages/database/src/schema.ts` is a 165-line aggregate over ten
  `src/schema/` modules for foundation, authoring, compatibility, connections,
  execution, retention, transport, and triggers. The aggregate retains the
  original table ordering and foreign-key visibility. The schema-ownership
  validator now scans the complete schema directory and still accounts for all
  67 migration-owned tables (48 typed and 19 intentionally raw SQL).
- `packages/workflow-engine/src/checkpoint.ts` is a 92-line public parser and
  serializer boundary. Bounded JSON/shared grammar, V1 join, V1 loop, V1 root,
  and V2 parsing are local modules; no package export changed.
- `packages/workflow-engine/src/executable-workflow.ts` is a 28-line public
  boundary over foundation, compatibility, compilation, validation, graph-
  boundary, and parse/verify modules. Unsupported internal exports were not
  introduced, and the package dependency graph remains clean.

The former monoliths were structural concentration rather than a demonstrated
behavioral defect, so the change moves declarations without changing SQL,
grammar, checksum, ordering, or failure semantics. Existing public-boundary
and compatibility tests provide the characterization. The workflow engine's
226 tests, database's 175 unit tests, all 1,604 repository unit tests, build,
typecheck, lint, dependency/export analysis, schema ownership, full `pnpm
check`, and critical-file coverage pass. Coverage provenance for moved
checkpoint branches was rebound by exact semantic source fingerprint: all 116
uncovered branches remain reviewed and zero are unreviewed across 30 files and
1,736 coverable lines. The complete enabled database integration suite passed
63 files and 320 tests against real PostgreSQL after the locality moves.

Remaining 35 file and 40 function occurrences are intentionally retained in
the ratchet, rather than mechanically split: they own atomic transactions,
state-machine decisions, or cohesive adapters where a further change requires
its own characterization and review. A future feature may lower those entries,
but no remaining occurrence is an untracked baseline exception. The
[complexity hotspot retention register](operations/complexity-hotspot-retention.md)
names every remaining file and function with its specific reason to remain.

Historical finding context follows.

The ratchet is well designed: a new file over 500 lines or function over 200
lines/40 branches fails unless the baseline changes, and existing hotspots
cannot grow. At the audit snapshot, debt was 45 file hotspots and 42 function
hotspots.

Largest files include:

- `packages/database/src/schema.ts` — 1,961 lines;
- `packages/workflow-engine/src/checkpoint.ts` — 1,356 lines;
- `packages/workflow-engine/src/executable-workflow.ts` — 1,340 lines;
- `packages/database/src/identity-workspace.ts` — 1,071 lines;
- `packages/database/src/control-ledger-coordinator.ts` — 1,048 lines;
- `packages/database/src/workflow-authoring.ts` — 1,011 lines;
- `packages/artifact-store/src/control-ledger.ts` — 997 lines;
- `packages/node-sdk/src/server.ts` — 954 lines.

Largest lexical factories include `createWorkspacePurgeCoordinator` (584
lines), `createControlLedgerCoordinator` (578), the identity/workspace database
factory (505), workflow-authoring database factory (498), failure-notification
store factory (494), operator-command factory (437), and connection-test
persistence factory (430). The worst measured decision hotspots remain
coordinator observations, checkpoint parsing, node-attempt input loading,
checkpoint/executable consistency, and worker attempt runtime composition.

This is not a recommendation to create more packages or generic repositories.
It is a locality refactor:

1. Converge `packages/database/src` on capability subdirectories from the
   authoritative plan: schema, transactions, execution, authoring, identity,
   triggers, connections, lifecycle/retention, operator, and recovery.
2. Split `schema.ts` by bounded context and re-export one internal
   `databaseSchema` aggregate. Preserve foreign-key visibility and migration
   review; do not change generated SQL as part of the move.
3. Extract pure validation, row mapping, and SQL statement ownership from the
   named long factories. Keep transaction sequencing in one short orchestrator
   where atomicity is the invariant.
4. Split checkpoint/executable parsers by versioned grammar section while
   retaining one public parse/serialize boundary and golden compatibility
   fixtures.
5. Lower the baseline only after each focused refactor. Never rewrite the
   baseline upward to admit a feature.

Acceptance evidence: unchanged public package exports, no dependency cycle or
extra query, characterization and integration tests green, lower ratchet counts,
and a reviewer can trace each success/failure path in one local unit.

### A-07 — Repeated controller catches obscure endpoint intent

**Remediation status (2026-09-03): complete.** All API feature controllers and
bootstrap registrations were searched. Feature-owned mapper providers now
compose through the platform application-error registry and global problem
filter; controllers retain route/header parsing, response metadata, and use-
case delegation without whole-handler catch/rethrow plumbing. The only
remaining controller catches perform local cleanup or translate native webhook
reply failures with distinct semantics. All API tests and typecheck pass.

API feature controllers contain 27 `catch (error: unknown)` sites. Most wrap a
whole endpoint only to call a feature mapper such as
`throwWorkflowApplicationError`. Feature-owned error maps are good; repeating
the same transport plumbing in every route is not.

Move mapper selection to a feature-scoped exception filter or a small global
composition registered by the owning feature. Do not create a universal
reflection-heavy command bus. Controllers should visibly own route parsing,
headers, guard metadata, response metadata, and delegation; feature mappers
should own domain-to-application error translation; the global RFC 9457 filter
should own serialization and safe logging.

Acceptance evidence: identical status/problem bodies/headers for every existing
negative contract test, fewer endpoint catch blocks, no vendor error class in a
controller, and no widened cross-feature dependency.

### A-08 — Provenance and provider proof stop before the live boundary

**Remediation status (2026-09-03): intentionally open; hosted identity and live
credentials required.** The repository can define attestation and canary
contracts, but it cannot produce a signed hosted-builder statement for a
promoted registry digest or safely exercise Slack, Resend, AWS, and deployed
verification without the target registry, deployment identity, and test
credentials. Existing digest metadata and fake-provider tests remain truthful
preconditions, not acceptance evidence.

The production-image job builds as non-root/read-only, generates an SBOM,
scans the image, and writes digest-bound provenance metadata. Actions are pinned
to full SHAs. These are strong controls. The generated JSON is not a signature
from a hosted builder and no deploy-time verifier proves that the promoted and
running digest satisfies a signed policy. Safe credentialed Slack/Resend and
target object-store/control-plane canaries are also absent from the scheduled
release workflow.

Required change:

- emit hosted, signed provenance/attestation for the image;
- verify issuer, repository, workflow identity, source revision, parameters,
  and subject digest before promotion and deployment;
- bind deployment evidence and the running task digest to the same subject;
- add secret-safe, bounded provider contract canaries with cleanup and a kill
  switch; never send real user data;
- retain the existing fake-provider tests because live canaries complement,
  rather than replace, deterministic failure testing.

### A-09 — Merge governance proves execution, not review or security state

**Remediation status (2026-09-03): complete for the current solo-maintainer
repository.** Dependency review is a pinned, moderate-severity pull-request
gate, `SECURITY.md` records triage and release-blocking policy, and active
repository ruleset `22213497` blocks `main` updates when CodeQL reports an
analysis error or a high/critical security alert. A non-author approval remains
intentionally unavailable while the project has one maintainer; no fake
approval is introduced. The documented trigger to require one approval and
code-owner review when a second maintainer exists remains in force.

`main` protection is strict and requires 11 current checks, linear history,
conversation resolution, admin enforcement, and no force pushes/deletion.
Every external action is SHA-pinned and workflow token permissions are narrow.
The repository settings nevertheless allow all actions and do not require SHA
pinning, so this safe state is convention rather than an enforced admission
rule.
Required approving reviews remain set to zero, code-owner review is not
required, and commit signatures are not required. `CODEOWNERS` maps all paths
to the same sole owner. Those review settings are a recorded solo-maintainer
exception rather than a false claim of independent review.

For a solo project, inventing a fake reviewer is worse than recording the
limitation. When a real second maintainer exists, require one non-author
approval and code-owner review for workflows,
identity, database migrations, integrations/credentials, infrastructure, and
ADRs. For releases, use a separate signing/deployment identity rather than the
source author. Document temporary exceptions with owner, reason, expiry, and
compensating checks.

### A-10 — Remove verified dead surface, not every static-analysis candidate

**Remediation status (2026-09-03): complete.** The pinned workspace-aware
dependency/export analysis now runs in the root gate across production, tests,
generated contracts, and explicit package entry points. The API declaration
edge is correctly classified, the worker's verified-unused dependency is
removed, and the repository-wide review removed 107 value/class and 98 type
exports with no supported consumer. Package export maps and composition entry
points remain explicit supported boundaries. The two legitimate same-shape
schema pairs now carry distinct semantic metadata rather than duplicate object
aliases. Knip reports zero unused dependencies, files, exports, types, or
duplicates; build, typecheck, unit tests, and the complexity ratchet preserve
behavior.

Static analysis found no unused files, which is important evidence against
wholesale obsolete modules. It did identify:

- unused `@opentelemetry/sdk-node` in `apps/worker` development dependencies;
- the API's type-only `@pertexo/node-sdk` public declaration edge described in
  A-03;
- broad application barrels such as `apps/api/src/executions/index.ts`,
  identity/workspace, identity, and HTTP platform exports with no observed
  consumer;
- constants and helper types exported from their defining files even when only
  used locally;
- three duplicate-export aliases that require human review.

Do not delete all 203 export candidates mechanically. Entry points, generated
contracts, test-only seams, and future public wire surfaces can look unused to a
workspace analyzer. Configure the analyzer with explicit production, test, and
generated entry points; then remove only verified exports with no supported
consumer. Application-internal files should default to non-exported symbols.
Package exports should be tested as contracts.

### A-11 — Tests are strong code and should be reviewed like code

**Remediation status (2026-09-04): complete.** A repository-wide line-count inventory found
seven test files above 1,000 lines. Each was split at scenario boundaries:
workflow foreach, database transport, database control-ledger coordination,
database schedule triggers, artifact control ledger, worker node attempts, and
worker transport. The largest remaining test file is exactly 1,000 lines and
no test file exceeds the limit. The affected unit scenarios pass, all split
integration files collect their scenario names, and package typechecks pass.

The split initially copied substantial setup into companion files. The exact
full-corpus baseline was 25 clone groups, 1,977 duplicated lines, and 16,403
duplicated tokens (2.08%) across 351 files and 94,939 lines. Owner-local support
modules now own genuinely shared environment initialization, lifecycle cleanup,
database/service setup, and domain fixture construction. Scenario-specific
state, actions, names, and assertions remain in each suite.

The principal affected pairs are:

- `packages/database/test/schedule-triggers.integration.test.ts` and
  `schedule-triggers-part-2.integration.test.ts`;
- `packages/database/test/control-ledger-coordinator.integration.test.ts` and
  `control-ledger-coordinator-part-2.integration.test.ts`;
- `packages/database/test/transport.integration.test.ts` and
  `transport-part-2.integration.test.ts`;
- `packages/artifact-store/test/control-ledger.test.ts` and
  `control-ledger-part-2.test.ts`;
- `apps/worker/test/transport.integration.test.ts` and
  `transport-part-2.integration.test.ts`; and
- `apps/worker/test/node-attempt-handler.test.ts` and
  `node-attempt-handler-part-2.test.ts`.

Reproduction command:

```sh
pnpm dlx jscpd@4.0.5 apps/*/test packages/*/test \
  --min-lines 18 --min-tokens 130 --format typescript \
  --reporters console --ignore '**/dist/**'
```

The same command now reports 6 reviewed groups, 267 duplicated lines (0.29%),
and 2,192 duplicated tokens (0.28%) across 362 files and 93,514 lines. The six
retained groups are individually classified: four are scenario-local
repetition whose visible state/actions/assertions aid review, and two are false
positives across distinct public or deployable-owner contracts. A pinned
`pnpm duplication:check` validates exact file pairs and fragment hashes plus
aggregate and per-family ceilings; it rejects stale, changed, harmful, new, or
worsened unexplained duplication in root and protected CI checks.

Every priority split suite collected and passed independently and together.
The real PostgreSQL, Redis, and object-store cohorts retained isolation and
cleanup, no shared mutable global or cross-package framework was introduced,
and no test file exceeds 1,000 lines.

The [25-occurrence baseline disposition ledger](operations/test-duplication-review.md)
records every original report, including multiple fragments for the same pair,
its semantic classification, and the exact support owner or retention reason.

### A-12 — `.mjs` is appropriate until a tool becomes an application

**Remediation status (2026-09-03): reviewed and intentionally retained.** The
repository-wide tooling inventory confirms that these files are direct Node
entry points with dedicated tests. No finding demonstrates a type defect, and
the audit explicitly makes conversion conditional on materially changing a
large tool. The remediation work did not alter those domain-shaped cores, so a
format-only TypeScript migration would add build coupling without evidence.

The repository's `.mjs` files are executable Node/ESM tooling, validators, and
process fixtures. That extension is correct: Node can run them directly without
a build, and they should not be renamed merely for consistency with application
TypeScript. Most are small and have dedicated `node:test` coverage.

The tradeoff is that ESLint disables type-aware TypeScript rules for `.mjs`.
Five tooling files now exceed 300 lines: the HTTP exercise runner (481),
external platform evidence validator (401), risk-coverage test (456),
risk-coverage reporter (387), and deployment validator (336). When materially
changing these tools, either add checked JSDoc
and `checkJs` coverage or convert the domain-shaped core to TypeScript while
keeping a tiny executable wrapper. Keep small dependency-light validators as
`.mjs`.

### A-13 — Public repository policy and workflow hygiene

**Remediation status (2026-09-03): complete.** `SECURITY.md` now defines the
private advisory channel, supported branch, safe report contents, same-day
triage, coordinated disclosure, and release-blocking severity policy.
`CONTRIBUTING.md` records setup, plan/ADR constraints, tests, commits, review,
and secret handling. The README makes the legally accurate current decision
explicit: public visibility grants no license, and choosing an open-source
license is deferred to the owner rather than guessed by tooling. The duplicate
artifact key no longer exists, and the structural YAML parser exercised by
`runtime:check` rejects syntax and duplicate mapping keys across every workflow.

The repository is public, has secret scanning and push protection enabled, and
has Dependabot/CodeQL automation. It has no license, `SECURITY.md`, or
`CONTRIBUTING.md`. That leaves external users unclear about legal reuse,
responsible vulnerability disclosure, supported versions, development setup,
and review expectations. Make an explicit license choice; “no license” can be
intentional, but it should be conscious. Add concise contribution and security
policies. Consider enabling non-provider secret patterns and validity checks if
their noise and plan availability are acceptable.

`.github/workflows/ci.yml` also contains the identical
`name: coverage-summaries` key twice in one artifact step. It is functionally harmless
because both values match, but duplicate YAML keys are exactly the kind of
configuration ambiguity that should be rejected. Remove it and consider a YAML
duplicate-key lint/parser gate.

### A-15 — A timeout does not settle queue publication truth

**Remediation status (2026-09-03): complete.** Queue publication now returns a
discriminated `published` or `outcome_unknown` result. The dispatcher retains
the lease and owns the non-rejecting late-settlement promise: late success
conditionally records publication, while late failure leaves the lease to
expire before deterministic-job-ID retry. The same settlement owner retains a
live `markPublished` database promise when its caller deadline expires; that
path returns `outcome_unknown` without releasing the lease, so a late
authoritative mark cannot race a retry. Repository-wide promise-race review
documented why lossy hints, canceled handlers, destroyed late database
connections, and observation-only bounds remain semantically different. Queue,
worker, timing, and full root checks pass.

The worker outbox dispatcher and queue producer use a timeout race that rejects
the caller while the underlying BullMQ or database promise continues. Timeout
therefore means “the caller stopped waiting,” not “the operation did not
happen.” A late publish can complete after a lease is released or a retry has
started, and a late database update can change truth after the timeout path has
selected a different outcome. Deterministic job identifiers reduce duplicate
execution but do not make this ownership race explicit.

Required change: prefer an operation that accepts `AbortSignal` and confirms
cancellation. Where the client cannot cancel authoritatively, keep ownership
until the operation settles or persist a `publish_unknown`/reconciliation state
that a dedicated recovery path resolves before republishing. Add deterministic
tests for completion just before, at, and after the deadline, lease expiry, and
process termination. Acceptance requires one authoritative state transition
for every timing and no retry while the previous publish can still complete
unobserved. BullMQ's [job-ID guidance](https://docs.bullmq.io/guide/jobs/job-ids)
supports deduplication but does not turn an abandoned client promise into a
confirmed non-publication.

### A-16 — Persistence implementation has drifted from plan conventions

**Remediation status (2026-09-03): complete.** Every production application
write path was classified. Persisted entity, event, version, attempt, intent,
idempotency-row, and artifact identities now use the database-owned UUIDv7
generator;
request correlation, lease, dispatch-capability, and hashed idempotency tokens
remain UUIDv4 by design. The final repository-wide UUIDv4 assertion search
also found `OpaqueSessionService`: persisted browser-session identities now use
the same UUIDv7 generator, while the bearer token retains independent
cryptographic randomness; the unused private UUIDv4 helper and its tests were
removed. Session, durable worker-attempt, and default artifact regressions
assert UUIDv7 through public persistence seams. Tests
prove UUIDv7 version, uniqueness, and monotonic order, while the schema gate
rejects UUID-generating column defaults. All 67
migration-owned application tables are now CI-accounted: 48 Drizzle tables and
19 reviewed raw-SQL tables with owner, access roles, RLS status, and ownership
reason. Forward-only migration `0074` enables and forces RLS on
`retention_schedule_state`, retains function-only maintenance access, and gives
the owner policy required by its `SECURITY DEFINER` functions. Database/API
typechecks, 577 focused tests, schema ownership validation, and the unchanged
complexity ratchet pass; the real-service migration suite remains part of the
hosted integration gate.

The authoritative plan says application-generated persisted identifiers use
UUIDv7 and that Drizzle definitions plus reviewed migrations are the schema
source of truth. Current production write paths still call `randomUUID()` for
runs, node runs, attempts, outbox events, publication records, and several
identity/workspace entities, while preview acceptance already uses `uuidv7()`.
If UUIDv7 is still the intended locality and ordering contract, this is an
implementation inconsistency rather than a style preference. PostgreSQL's
current [UUID type documentation](https://www.postgresql.org/docs/current/datatype-uuid.html)
recognizes UUIDv7 values, but generation policy remains an application design
decision that this repository's plan already made.

A static table inventory found 67 application tables created by migrations and
48 Drizzle table declarations. Raw-SQL-only operational tables are not
automatically wrong, but their ownership is invisible to a typed-schema-only
drift check. In addition, `retention_schedule_state` is keyed by workspace and
lacks both `ENABLE` and `FORCE ROW LEVEL SECURITY`; privileges are tightly
revoked and access is mediated by hardened maintenance functions, so no direct
runtime exposure was proved, but it is an undocumented exception to the plan's
forced-RLS rule for tenant tables.

Required change:

1. Inventory persisted ID columns and centrally generate UUIDv7 for entity/event
   identifiers; explicitly classify random tokens, nonces, and secrets that are
   not sortable IDs.
2. Add version/locality tests for generated persisted IDs and migration defaults.
3. Represent every application-owned table in Drizzle or maintain a CI-checked
   raw-SQL ownership registry containing owner, access roles, RLS status, and
   reason it is outside the typed schema.
4. Either add forced RLS and the required maintenance policy/tests to
   `retention_schedule_state`, or document and test why it is global
   maintenance metadata despite carrying `workspace_id`.

### A-17 — Two HTTP-path promises are not bounded or joined correctly

**Remediation status (2026-09-03): complete.** Redis rate limiting has one
end-to-end one-second deadline covering connect and command work, disconnects
and resets the client after expiry, and exposes explicit fail-open/fail-closed
caller policy. Native Fastify webhook handlers return/await reply delivery in
both success and problem paths, keeping serialization/send failure attached to
route completion without changing durable acceptance truth. Stalled Redis,
send failure, interceptor policy, webhook, API, and root regressions pass.

`RedisRateLimitRuntime` disables the offline queue and limits retries, but sets
no repository-owned connection or command deadline. The API interceptor awaits
the limiter, so a stalled connect or `EVAL` can occupy an inbound request until
library/network timeouts decide the outcome. Configure bounded connection and
command latency, make the intended fail-open/fail-closed policy explicit per
route class, and test a backend that accepts a connection but never replies.

The native Fastify webhook handler also uses `void reply.send(...)` in its
success and problem paths. An async Fastify handler should return or await the
reply so serialization and send failures stay attached to route completion and
telemetry. Change the helper contract to return the reply/promise, await it from
the handler, and test serialization failure and early socket close. Preserve
the existing rule that telemetry failures cannot change webhook acceptance
truth. This follows Fastify's official
[async reply contract](https://fastify.dev/docs/latest/Reference/Routes/#async-await).

### A-18 — Similar schemas need explicit semantic ownership

**Remediation status (2026-09-03): complete.** Credential ownership
is complete: contract schemas are explicitly the untrusted HTTP wire boundary,
integration `resolved*CredentialSchema` exports are the post-decryption
provider boundary, and the operations note records normalization and why both
must parse. Public API tests prove valid equivalence plus shared negative token,
mailbox, prohibited-header, and serialized-byte cases; the wire byte accounting
was corrected to include `name:value\r\n`, matching actual transport. The
node-catalog metadata import was measured separately (about 112 ms cold for the
server entry versus 79 ms for metadata-only root loading on this host). Because
the approximately 33 ms and executor-graph coupling were material at the API
validation boundary, definition registrations and release resolution now live
in browser-safe modules. The API imports the root catalog, while the server
entry composes executors on top of the same definitions. Package-contract
tests prevent the metadata resolver from importing integration or core server
entries; node-catalog, nodes-core, and all 405 API tests pass with the unchanged
complexity ratchet.

HTTP, Slack, and Resend credential shapes appear in public connection contracts
and again in server integration validation. Some differences—such as mailbox
length and resolved-secret/header rules—reflect distinct wire, encrypted, and
resolved-runtime boundaries; others may be drift. Do not force them into one
schema merely to reduce lines. Give each representation a boundary-specific
name, document transformations, and add equivalence plus negative tests for the
fields that intentionally overlap.

The node-catalog server entry also imports executor/integration modules for a
metadata-only validation path. This is not a proven boundary violation, but it
couples metadata startup to the server execution graph. Measure cold-start,
bundle, and import cost before splitting a metadata-only entry point; keep the
current deeper module if the measured gain is negligible.

### A-19 — Clarify where the web application belongs

**Remediation status (2026-09-03): complete.** The README and authoritative
backend plan now state that this checkout is intentionally backend-only, the
web client is deferred outside the current delivery scope, and an empty
`apps/web` package must not be created merely to match the historical
transition diagram. The stale transition step now describes a separately
planned future client migration.

The authoritative backend plan illustrates an `apps/web` workspace, while this
checkout and README are backend-only. That can be a valid repository boundary,
but the plan should state whether web is deliberately deferred, maintained in a
different repository, or removed from this delivery scope. Do not create an
empty web package merely to match a diagram.

## 6. Detailed assessment by engineering area

### 6.1 Architecture and topology

What is good:

- The modular monolith is the right level of distribution. API, worker,
  retention, recovery, lifecycle, and operator processes are deployable roles,
  while core logic stays in repository packages.
- Dependency direction matches the plan: model/SDK foundations do not depend
  on Nest, Redis, BullMQ, or Drizzle; the API does not import worker consumers;
  workers consume engine and persistence capabilities.
- The graph is acyclic and does not rely on Nest circular-dependency escape
  hatches.
- Runtime wiring is explicit, mostly constructor/factory injected, and tests can
  substitute capability ports without a service locator.

What should improve:

- Converge internal folder structure on the plan. The top-level packages are
  correct, but large flat internal directories now hide capability ownership.
- Add a small automated architecture report or dependency-cycle gate rather
  than relying only on ESLint import zones. It should report package nodes,
  runtime/browser edges, and cycles without becoming a build orchestrator.
- Record an ADR before any change that moves a public seam or deployment
  boundary. Internal file moves behind existing exports do not require a new
  service or package.

What not to do:

- Do not split this into microservices per feature.
- Do not add a generic `shared`, `common`, `utils`, base service, universal
  repository, or command bus.
- Do not introduce interfaces around deterministic local functions solely to
  make diagrams look layered.

### 6.2 Package-by-package necessity

All 12 packages have a current architectural reason to exist:

| Package | Production consumers | Verdict |
| --- | ---: | --- |
| `artifact-store` | 4 | Necessary boundary around S3/control-ledger durability and dual-region behavior |
| `contracts` | 1 current API consumer | Keep: owns public/generated wire schemas and the planned browser contract; ensure it never becomes a domain dumping ground |
| `database` | 6 | Necessary; capability subpath exports and decomposed bounded-context internals preserve a stable persistence boundary |
| `integrations` | 3 | Necessary provider ownership with browser-safe/server split |
| `node-catalog` | 2 | Necessary composition/compatibility registry; keep it declarative |
| `node-sdk` | 5 | Necessary stable definition/executor contract used across engine and nodes |
| `nodes-core` | 3 | Necessary core-node implementation owner |
| `observability` | 6 | Necessary cross-process logging/metrics/tracing owner with bounded, regression-tested redaction |
| `queue` | 2 | Necessary queue contracts/adapters shared by API and worker |
| `rate-limit` | 2 | Necessary distributed policy shared by API and worker ingress/admission |
| `workflow-engine` | 2 | Necessary pure scheduler/interpreter boundary |
| `workflow-model` | 4 | Necessary canonical graph/expression/value model |

The number of packages is not the problem. Their internal modules and supported
exports were reviewed repository-wide; the remaining surfaces have consumers or
an intentional composition role. Deleting a package only to move its files into
an application would weaken reuse and boundary enforcement.

### 6.3 Readability, naming, functions, and classes

Positive evidence:

- Filenames generally use domain vocabulary rather than vague helper names.
- Constants and discriminated unions express statuses and policies; no
  TypeScript enum sprawl was found.
- Guards, use cases, stores, and pure engine policies have recognizable roles.
- Comments usually explain concurrency, atomicity, compatibility, or security
  reasons rather than narrating syntax.
- Classes are used mainly for Nest DI/lifecycle or stateful adapters; pure
  engine/model code uses functions.
- Production unsafe casts and `any` are absent.

Improvement rules:

- Keep orchestration short: validate, acquire/authorize, transact, map, return.
- Name pure sub-policies for corrupt-state checks and versioned parsing instead
  of growing a single conditional tree.
- Keep SQL next to the capability that owns it, but move reusable transaction
  mechanics—not domain use cases—into transaction modules.
- Prefer one options object when arguments share one lifecycle, but do not grow
  generic option bags with unrelated booleans.
- Avoid adding a class when a plain function and explicit dependencies are
  enough.
- For long factories returning several methods, measure locality and decision
  count, not only lexical span; extract only coherent invariants.

### 6.4 Reuse, duplication, and abstraction depth

At 1.12% measured source duplication, broad DRY refactoring would likely make
the code worse. Similar public contract schemas, API/worker bootstrap modules,
and provider executors often have different owners or change pressures.

Review these same-owner clone families when the next related change occurs:

- preview and run-artifact retention claim/ledger/page mechanics;
- repeated sections inside preview cleanup and failure-notification delivery;
- workspace purge and lifecycle-command coordination mechanics;
- node SDK `release.ts` and `server.ts` schema/validation fragments;
- API/worker observability and database module bootstraps.

Extract only if the callers share the same invariant and are expected to change
together. The correct reusable unit is a named policy or transaction primitive,
not an untyped callback template.

### 6.5 TypeScript and import quality

The TypeScript setup is excellent: `strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, unknown catches, override/return/fallthrough
checks, isolated modules, and verbatim module syntax are centralized. Root
project references cover all workspaces. Tests receive their own typecheck.

Imports consistently use ESM `.js` specifiers for TypeScript sources, which is
correct for Node ESM output. Export maps prevent unsupported package deep
imports. Type-only imports are used. Runtime Zod schemas cover HTTP,
configuration, queues, persisted JSON/checkpoints, node/provider contracts, and
many database boundaries.

Continue to reject advanced type cleverness that only moves runtime complexity
into the compiler. Add a generic only when it preserves a real relation between
positions or powers a reused registry. Keep test-only seams in explicit
`./testing` exports and never expose them from production roots.

### 6.6 NestJS and HTTP API

The API is organized by feature, not global technical layers. Controllers use
guards and call use cases; application logic is not embedded in decorators.
DI uses explicit providers/tokens and no service locator. HTTP problems are
bounded, typed, correlated, and secret-conscious. Sessions, CSRF, OIDC, proxy
configuration, distributed rate limits, idempotency, and workspace capability
checks are extensively tested.

The one `@Global` HTTP platform module is defensible for the request-context and
problem-details substrate, and its exports remain minimal. Feature-owned error
mappers compose through the global problem filter, so controller bodies retain
transport parsing and use-case delegation without centralizing domain policy.

### 6.7 PostgreSQL and persistence

This is one of the repository's strongest areas. Forced RLS, separate
owner/migration/API/worker/dispatcher/maintenance/lifecycle/operator roles,
transaction-local workspace context, checked-out-client scoping, cleanup after
commit/rollback, fencing tokens, compare-and-swap updates, idempotency,
append-only facts, compatibility migrations, and real concurrency tests are all
substantive controls.

Raw SQL is appropriate for the complex transactional behavior. Drizzle is used
where its schema/typed query leverage is useful; forcing every stored function
or lock sequence through an ORM would reduce clarity. `SELECT *` calls to
stable, repository-owned functions are not equivalent to an unbounded table
query, but direct table reads should continue to select explicit columns unless
the full typed row is intentionally the contract.

Repository review cannot prove live index usefulness or capacity. Before
production, inspect actual plans and statistics. Verify every foreign-key
access path, write amplification on heavily indexed state tables, hot-update
behavior, autovacuum/XID age, long or idle transactions, statement/lock
timeouts, replication slots/lag, WAL archiving, and pool totals. Never remove an
index because a short-lived test environment reports zero scans.

### 6.8 Security model

Positive evidence includes deny-by-default authorization, object/workspace
checks, forced RLS, CSRF/session protections, secret encryption and redaction,
SSRF/address policy, bounded HTTP behavior, webhook replay controls, distributed
abuse limits, least-privilege database roles, non-root/read-only containers,
immutable action/image inputs, secret scanning, push protection, Dependabot,
CodeQL, and many negative tests.

Repository-controlled security is green at this tree: dependency audit reports
no known production vulnerability, CodeQL and Dependabot have no open alerts,
and admission blocks moderate dependency findings and high/critical code-
scanning alerts. The route/control/test security traceability covers
authentication, object/function authorization, property validation, resource
consumption, business-flow abuse, SSRF, inventory/versioning, and provider
consumption. Signed hosted provenance and credentialed live-provider proof
remain A-08 external evidence.

### 6.9 Testing architecture

The package-level `test/` layout is appropriate. Unit tests stay independent of
external services; PostgreSQL, Redis, BullMQ, object stores, API HTTP, process
crash, compatibility, and recovery cohorts are separate. Integration jobs use
disposable Compose projects and assert minimum executed test counts so skipped
cohorts cannot silently pass. The tests cover negative security and concurrency
behavior, not only happy paths.

`pnpm check` excludes integration tests by design; GitHub's protected jobs add
them. Therefore a local `pnpm check` pass and a full protected CI pass are
different claims. Keep both commands and document that distinction. Improve
suite organization and coverage truth through A-05/A-11 rather than moving
every test beside its source file.

#### Vitest and test-tooling modernization assessment

The testing stack is modern and appropriate for this backend. The audited tree
pins Node 24, pnpm 11.22.0, TypeScript 6.0.3, Vitest 4.1.10, and
`@vitest/coverage-v8` 4.1.10 under native ESM. A registry check on 2026-09-03
reported Vitest and its V8 provider at 4.1.11, so the runner is one patch—not a
generation—behind. Package tests compile separately through `tsconfig.test.json`
and all workspace packages use one root-owned Vitest version.

The same registry check reported pnpm 11.25.0 and TypeScript 7.0.2. Remaining
on a recent pinned pnpm 11 release is normal patch lag; TypeScript 7 is a major
compiler change and should be evaluated through a dedicated compatibility
branch rather than adopted merely to claim “latest.” Modernity here means a
supported, reproducible stack using current safety capabilities, not automatic
major-version churn.

Current use is substantive rather than nominal:

| Capability | Current use | Judgment |
| --- | --- | --- |
| TypeScript and ESM | Native `.ts` tests, `.js` ESM specifiers, package export maps, and separate test typechecks | Correct and current |
| V8 coverage | Official `@vitest/coverage-v8` provider, explicit includes, JSON summaries, and four aggregate threshold sets | Correct provider; selected scope and aggregate masking remain the limitation |
| Test cohorts | Unit, real-service integration, resilience, compatibility, recovery, and selected coverage use distinct scripts/configurations | Strong separation of failure evidence |
| Isolation and concurrency | Ordinary unit tests use Vitest defaults; stateful database/worker/resilience cohorts disable file parallelism and cap workers | Appropriate; concurrency is not a goal when shared services make it nondeterministic |
| Time control and mocking | Static inspection found 5 fake-timer, 47 mock, and 3 hoisted-setup call sites | Used selectively rather than making implementation-heavy mocks the default |
| Parameterized tests | 109 `describe.each`/`it.each`/`test.each` call sites | Strong use for policy and compatibility matrices |
| Type tests | 5 `expectTypeOf`/`assertType` call sites plus full test-project compilation | Useful, though runtime parsing remains authoritative for untrusted data |
| CI reporting | JSON reports and minimum executed-test counts are uploaded for service-consuming cohorts | Strong protection against silently skipped integration groups |
| Focus/retry hygiene | No committed `.only` and no blanket retry setting were found | Good: failures are not hidden by automatic retries |
| Snapshots | No snapshot assertions were found | Not a defect; explicit domain/API assertions are more reviewable here |

Vitest's official [feature inventory](https://v4.vitest.dev/guide/features)
includes projects, sharding, type tests, browser mode, benchmarking, snapshots,
mocking, and V8/Istanbul coverage. A mature repository should select among
those features rather than enable all of them. The current choices are mostly
sound.

The useful next capabilities are:

1. Add consequence-based per-file thresholds inside the selected security and
   state-machine cohort. Vitest supports
   [`coverage.thresholds.perFile`](https://v4.vitest.dev/guide/cli); do not let a
   highly covered file compensate for a weaker authorization, fencing, retry,
   or transition file.
2. Add changed-file coverage as pull-request information, not as a replacement
   for the critical-file gate. Vitest 4.1's `coverage.changed` can narrow the
   report while still allowing the relevant suite to run.
3. Add targeted mutation canaries for authorization, workspace scope, fencing,
   idempotency, retry class, and unknown-outcome decisions. This is more useful
   than chasing repository-wide 100% line coverage.
4. Add property/fuzz tests for workflow/checkpoint/expression parsing, cursor
   encoding, headers, credential transformations, serialization compatibility,
   and nested runtime input.
5. Add bounded benchmarks/adversarial cases for log redaction, expressions,
   checkpoint parsing, large workflow validation, and fan-out planning.
6. Consider a root Vitest
   [`projects`](https://main.vitest.dev/guide/projects) configuration only if it
   reduces duplicated configuration and makes named cohorts easier to discover.
   The existing pnpm-recursive orchestration is valid and should not be replaced
   for fashion.
7. Consider sharding the eight-minute integration job by isolated service
   cohort. Preserve disposable Compose identity, migration ordering, minimum
   test counts, and failure artifacts; otherwise faster CI would be less
   trustworthy.

Do not add browser mode until browser-owned code exists, switch from V8 to
Istanbul without a measured need, introduce broad snapshot testing for precise
domain contracts, enable unsafe concurrency in shared-service suites, or use
blanket retries to make flakes disappear. Those are available features, not
missing quality requirements.

### 6.10 CI/CD and supply chain

The exact audited HEAD has a successful GitHub CI run with quality, three unit
partitions, coverage, production image, integration, recovery, compatibility,
and deployment-security jobs. CodeQL also completed successfully. Actions are
pinned to immutable SHAs, permissions are explicit/minimal, jobs have timeouts,
service failures upload logs, image scans and SBOMs are retained, and branch
protection requires 11 strict contexts.

Automation is layered: CI runs on every pull request, every push to `main`, and
daily; CodeQL runs on pull requests, `main`, a weekly schedule, and manual
dispatch; the release gate runs weekly and manually. Local editing alone does
not run these checks, so contributors still need `pnpm check` before pushing.
The protected pull-request run is the automatic admission mechanism.

The repository-controlled policy gaps are closed: code-scanning alerts block at
high/critical severity, production dependency audit and dependency review block
at moderate severity, production role imports are exercised from the final
image, and workflow YAML/history/documentation drift have structural gates.
Approvals remain zero only because the repository has one maintainer; the
documented second-maintainer trigger avoids pretending self-review is
independent. Signed hosted provenance remains the external A-08 boundary, so a
green suite is a repository admission signal rather than Phase 7 production
readiness proof.

### 6.11 Reliability, observability, and performance

Durability design is strong: PostgreSQL is authoritative, queue payloads are
identifiers, outbox/inbox flows handle duplicates, leases are fenced, unknown
provider outcomes are explicit, checkpoints are versioned, and recovery tests
kill processes and remove dependencies at important boundaries.

The worker owns process signals, keepalive, application, consumers, database,
and telemetry shutdown through an idempotent bounded path. Queue publication
and its durable publication mark retain ownership after caller deadlines and
surface `outcome_unknown` without prematurely releasing the lease. Redis rate-
limit work is bounded end to end, and native webhook replies remain joined to
request completion.

Telemetry is broad and fixed-cardinality by design. Logs, traces, metrics,
health/readiness, drain behavior, queue depth/age, outbox, database, retention,
artifact, provider, SSE visibility, and lifecycle operations have repository
representations. Logger redaction is bounded without weakening secret removal.

Performance claims remain limited. Passing local integration tests says little
about peak throughput or saturation. Use the existing evidence harness to
measure per-role CPU/memory, event-loop delay, heap, queue lag, DB connections,
query/lock latency, Redis and object-store latency, SSE fan-out, backpressure,
and tenant fairness at expected, peak, and dependency-degraded load. Establish
budgets first; optimize only measured bottlenecks.

### 6.12 Documentation and maintainability process

The plan, ADR index, and progress tracker are unusually comprehensive and
provide real design constraints. Continue updating the tracker only when the
plan's evidence changes. The audit should remain a current-state document; do
not turn it back into a chronological branch diary. Git history already records
what was fixed.

For every audit remediation:

1. reproduce the finding and add characterization/regression evidence;
2. make one coherent implementation change;
3. run the narrowest relevant checks, then the root gate when appropriate;
4. lower a ratchet or close an alert only after evidence exists;
5. update this audit and the progress tracker if a plan checkpoint changed;
6. commit and review the change independently from unrelated refactors.

## 7. Prioritized improvement plan

### Stage 1 — Security truth before new release work

**Status: complete.** Logger and dependency findings are closed on the default
branch; worker production role loading and compiled-process shutdown are
exercised; moderate dependency and high/critical CodeQL findings block
admission; focused, root, image, protected CI, and CodeQL checks passed.

Exit: no unaccepted high/critical code alert or patchable medium-or-higher
runtime advisory; future equivalents block admission.

### Stage 2 — Make coverage and CI claims exact

**Status: complete.** Coverage publishes exact selected denominators and test
health, every retained uncovered branch has semantic evidence, mutation
canaries cover consequential decisions, workflow YAML is structurally parsed,
publication/mark outcomes retain ownership, Redis I/O is bounded, and webhook
replies are joined.

Exit: a reader cannot confuse selected coverage with whole-repo coverage, and
security/configuration outcomes—not only tool execution—are gated.

### Stage 3 — Reduce change-locality cost

**Status: complete with controlled hotspot debt.** UUIDv7, schema
ownership, and RLS conventions are enforced; the largest database and workflow
internals were split behind unchanged public seams; named hotspots and oversized
tests were decomposed with characterization coverage; and the reduced production
complexity baseline is enforced. A-06/C-22 database locality and A-11/C-21
test ownership are complete; C-23 retains only individually reasoned hotspot
debt.

Exit: fewer file/function hotspots, no new package or query edge, and improved
review locality.

### Stage 4 — Narrow surface and tooling debt

**Status: complete.** Static entry points are checked; verified dead dependency
and export surfaces are gone; genuine same-owner duplicates were centralized;
credential and metadata boundaries are measured/documented; public policy,
license, and backend-only scope decisions are explicit. Large `.mjs` tools were
reviewed and intentionally retained because no type defect or material rewrite
justified conversion.

Exit: smaller supported surface, no known unused dependency, and no speculative
abstraction added to achieve it.

### Stage 5 — Complete authoritative Phase 7

Run the live, immutable-release-bound workload, recovery, security, provider,
observability, and operational evidence listed in A-04/A-08. This is the only
stage that can raise production readiness materially. Repository refactors do
not substitute for it.

## 8. Verification evidence from this audit

Local commands at the audited implementation tree:

- `pnpm check` — passed; build, formatting, documentation, runtime alignment,
  lint, complexity ratchet, generated contracts, project/test typechecks, and
  all 1,604 configured non-integration tests passed.
- `pnpm test:coverage` — passed for the 30 selected critical files; percentages
  are recorded in A-05; 116 reviewed and zero unreviewed uncovered branches.
- `pnpm security:audit` — exited zero under the configured moderate threshold
  with no known production vulnerability.
- `pnpm deployment:check`, `pnpm images:check`, and `pnpm exercise:check` —
  passed.
- `pnpm dependencies:check` — passed with no unused files, dependencies, or
  unsupported internal exports.
- Enabled real-service integration cohorts — database 63 files/320 tests;
  worker 18 files/22 tests; API 4 files/15 tests with one SSE-only suite
  skipped; artifact store 2 files/5 tests with three provider-specific cases
  skipped.
- `pnpm dlx jscpd@4.0.5 apps/*/test packages/*/test --min-lines 18
  --min-tokens 130 --format typescript --reporters console --ignore
  '**/dist/**'` — the original baseline was 25 groups/1,977 lines (2.08%);
  owner-local extraction now reports 6 groups/267 lines (0.29%).
- `pnpm duplication:check` — passed the pinned semantic source/test ratchet:
  45 reviewed source groups/992 lines and 6 reviewed test groups/267 lines.
- `gh api` security inspection — zero open Dependabot alerts and zero open
  CodeQL alerts on the default branch.
- branch-protection/ruleset inspection — 11 strict required contexts plus
  active ruleset `22213497`, which blocks CodeQL analysis errors and
  high/critical security alerts. Required approving reviews remain zero under
  the documented solo-maintainer exception.

Remote evidence:

- Pull request #40 CI run
  [33818101198](https://github.com/vigani1/pertexo/actions/runs/33818101198)
  passed every protected context for commit `2c68aab935da8f3bd9d33cc76d895d8d85e53ed8`.
  Its complete tree `9069604bae2c15267bcdf7c3d6bcdd2ec56e2b14` is identical to
  rebased `main` commit `4e8585b6835520f5493a407d084b5b4c6bda881e`.
- Exact-main CodeQL run
  [33818839834](https://github.com/vigani1/pertexo/actions/runs/33818839834)
  passed for `4e8585b`. The corresponding push CI run
  [33818839787](https://github.com/vigani1/pertexo/actions/runs/33818839787)
  failed only in `deployment-security` after the npm advisory endpoint timed
  out; all other jobs passed. Scheduled CI run
  [33848095363](https://github.com/vigani1/pertexo/actions/runs/33848095363)
  subsequently passed every configured job on the same exact commit, including
  `deployment-security`.
- GitHub CI run
  [33795441965](https://github.com/vigani1/pertexo/actions/runs/33795441965)
  succeeded for exact `main` commit
  `90022ca684646bf455ce0c7e0525e7789450cf03`, including protected integration,
  recovery, image, coverage, and deployment-security jobs.
- GitHub CodeQL run
  [33795442043](https://github.com/vigani1/pertexo/actions/runs/33795442043)
  completed successfully for the same exact-main commit; the default branch
  subsequently reported zero open alerts.

## 9. Final answer to the practical questions

Is the actual code good? **Yes, overall.** It is unusually explicit about
invariants, runtime validation, tenancy, failures, and durability. The audited
repository defects are closed; the remaining 35 file and 40 function hotspots
are explicit ratcheted debt rather than unbounded growth.

Is it reusable without being overabstracted? **Mostly yes.** The package seams
are justified, the dependency graph is clean, duplication is low, and the
repository-wide export review removed unsupported surface without adding a
generic shared layer.

Are all packages needed? **Yes, given the current architecture.** `contracts`
has only one current production consumer but owns the deliberate public wire
boundary and planned browser consumption. The rest have multiple current
consumers or a clear runtime/domain responsibility.

Are tests good? **Yes in behavioral depth; coverage selection remains
continuous rather than global.** The separation into package `test/` directories is
appropriate, oversized suites were decomposed, and critical-file coverage is
honestly labeled with exact denominators and reviewed gaps. It is not
whole-repository coverage. A-11's genuinely shared split-suite setup is now
owner-local, with five narrow retained clone families explicitly reviewed.

Does it run in GitHub CI? **Yes.** Exact-main CI and CodeQL are green and
comprehensive. Moderate dependency findings and high/critical code-scanning
alerts now block admission; zero such alerts are open.

Are `.mjs` files wrong? **No.** They are appropriate for directly executable
Node tooling. Only the largest, domain-shaped tools have grown enough that
TypeScript or checked JSDoc would now provide worthwhile safety.

Is it production-ready? **No.** Repository-controlled prerequisites are green,
but the authoritative Phase 7 live AWS/load/pager/recovery evidence and A-08
hosted provenance/provider proof must be completed before making that claim.
