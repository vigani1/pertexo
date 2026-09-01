# Current Whole-Repository Engineering Audit

Recorded: 2026-09-01

Audited implementation head: `dea8f7e`

Status: repository-controlled remediation complete; external production evidence
remains open

## 1. Executive decision

The repository-controlled findings from the 2026-09-01 audit have been
implemented and verified at the audited head. The backend has strong domain
boundaries, strict TypeScript and runtime contracts, forced PostgreSQL tenant
isolation, durable execution semantics, truthful test cohorts, reproducible
container inputs, protected image scanning, and explicit operational contracts.

The repository is still not entitled to claim Phase 7 completion or production
readiness. Live AWS, recovery, load, pager, autoscaling, and aggregate database
capacity evidence has not been produced. Repository tests cannot substitute for
those observations.

- Continued development: **GO**
- Merge after all protected checks pass: **GO**
- Claim repository-controlled audit remediation complete: **GO**
- Claim Phase 7 or production readiness complete: **NO-GO**

No demonstrated tenant escape, authorization bypass, durable-state corruption,
Redis-authority violation, source dependency cycle, or known high-severity
production dependency vulnerability was found.

## 2. Scope and calibration

The audit covered every app and package; public and internal interfaces;
functions, imports, exports, dependencies, duplication, and complexity;
TypeScript and runtime validation; Nest composition; PostgreSQL schema, RLS,
roles, migrations, transactions, retention, and recovery; workflow and queue
correctness; test truthfulness and layout; CI, CodeQL, branch protection,
container provenance, deployment contracts, observability, runbooks, ADRs, the
backend plan, and the implementation tracker.

A useful refactor must improve ownership, locality, tests, or diagnostics. File
size alone is not a defect, and the hotspot inventory below is guidance rather
than an instruction to split stable code arbitrarily.

| Priority | Meaning |
| --- | --- |
| P0 | Active exploit, data loss, or systemic failure requiring stop-work |
| P1 | Release or production-readiness blocker |
| P2 | Material correctness, security, operational, or maintainability risk |
| P3 | Focused quality improvement or fix-when-touching item |

## 3. Current evidence

Repository evidence at or immediately preceding the audited head includes:

- Full formatting, build, ESLint, complexity-ratchet, and TypeScript gates pass.
- Database: 154 unit and 320 real PostgreSQL integration assertions pass.
- API: 332 unit assertions pass; focused real identity and webhook proofs pass.
- Worker: 205 unit assertions pass.
- Observability: 39 unit assertions pass.
- The required CI cohort validator rejects missing flags, zero-count reports,
  unexpected skips, and unexpected todos.
- GitHub reports secret scanning, push protection, vulnerability alerts,
  Dependabot security updates, and automated security fixes enabled.
- Protected `main` requires 11 strict contexts: quality, three unit partitions,
  coverage, integration, recovery, compatibility, deployment-security, CodeQL
  `analyze`, and `production-image`.
- The production-image job builds the exact commit, proves non-root/read-only
  execution, emits a CycloneDX SBOM, and fails for fixed high or critical
  vulnerabilities.
- Main protection enforces administrators, linear history, resolved
  conversations, and blocks force-pushes and deletion.

Evidence limits:

- No live AWS account or immutable production exercise bundle was available.
- GitHub validity checks and non-provider secret patterns are unavailable for
  the current repository plan.
- A real push-protection canary, controlled vulnerable-dependency advisory, and
  disposable vulnerable-image PR have not been executed.
- The repository has one collaborator, so an author-independent approval cannot
  currently be enforced without making every PR unmergeable.
- Coverage remains intentionally focused on critical modules rather than every
  source line.

## 4. Plan requirements versus audit recommendations

The backend plan is authoritative. Live Phase 7 exercises, capacity, recovery,
and cloud-control evidence are plan requirements and remain release blockers.

The following are audit hardening recommendations, not retroactive plan
requirements: a disposable secret/advisory/image canary, mandatory independent
human approval for a multi-contributor workflow, commit-signature enforcement,
and further reduction of already-ratcheted hotspots. They improve confidence but
must not be represented as unfinished backend-plan implementation unless the plan
is explicitly amended.

## 5. Open findings

### O-01 — Live production and recovery evidence is incomplete

**P1 — Plan requirement — open**

Live IAM and immutable invocation, versioned buckets, Object Lock and
replication, deployed load/noisy-tenant fairness, pager delivery, failover,
failback, PITR, regional restore, RPO/RTO, autoscaling, and aggregate PostgreSQL
connection capacity have not been observed in the target AWS account.

Accept only when fresh immutable reports pass the external evidence validator,
every Phase 7 live row links to an observed result, and maximum-scale connection
capacity includes API, worker, jobs, maintenance, migrations, pooling mode, and
headroom.

### O-02 — Security and image canaries are not yet observed

**P2 — Audit recommendation — external evidence open**

The controls and protected image gate are enabled, but there is no recorded safe
push-protection rejection, controlled dependency advisory/update, or disposable
vulnerable-image PR rejection. Do not introduce a real credential or merge a
known vulnerable dependency merely to manufacture evidence.

Accept when controlled, non-production canaries record the expected rejections
and cleanup without bypassing protection.

### O-03 — Independent human review is unavailable in the solo repository

**P3 — Governance recommendation — accepted risk**

Critical CODEOWNERS exist, but GitHub reports only `vigani1` as a collaborator.
GitHub does not let a PR author approve their own change, so one required
approval or code-owner review would deadlock all merges. The explicit policy is
recorded in `docs/repository-governance.md`.

When a second maintainer with review permission is added, require one approval
and code-owner review. Reconsider verified-commit enforcement when every local
and automation identity has a provisioned signing path.

## 6. Resolved findings

| Prior finding | Resolution and evidence |
| --- | --- |
| A-02 controls | Secret scanning, push protection, alerts, security updates, and automated fixes enabled; unsupported validity/non-provider settings recorded |
| A-03 idempotency retention | 24-hour terminal replay expiry, legal-hold-aware bounded reaper, indexed and lock-safe PostgreSQL proofs |
| A-04 session retention | 30-day expired/revoked metadata grace and bounded maintenance-only reaping |
| A-05 green skips | Every required cohort emits a reviewed machine-readable count and fails closed on missing configuration, unexpected skip, or todo |
| A-06 image gate | Per-change `production-image` job added and required on protected `main`; exact image, runtime hardening, SBOM, and scan are one context |
| A-07 readiness monolith | One public/snapshot owner retained; typed capability descriptors and four bounded SQL projections replace the 1,798-line probe |
| A-08 publication monolith | One transaction retained; named claim, lock/compile, version, projection, and finalization steps replace the 331-line lexical block |
| A-09 sibling internals | Node testing owns its module/port/guard/errors; execution owns checkpoint creation; static tests reject corrected crossings |
| A-10 erased API types | Use cases return exact validated contract outputs with compile-time negative assertions |
| A-11 mutable image inputs | Broad OS upgrade removed, reviewed init copied from a digest-pinned source, deterministic build inputs and SBOM recorded |
| A-12 dependency automation | Bounded grouped pnpm updates and Node 24 Docker policy added; incompatible Node 26 bot work closed |
| A-13 complexity regression | CI ratchets reviewed file/function line and branch baselines; new or worsened hotspots fail |
| A-14 database root | Production root export removed; explicit capability subpaths remain |
| A-15 avoidable sleeps | Session expiry uses an injected clock and mutable schedule leases advance through PostgreSQL; immutable/external-clock waits are documented |
| A-16 local clones | API/worker Nest observability behavior and Slack/email provider telemetry share narrow stable helpers with lifecycle/failure tests |
| A-17 Fastify assertions | Repeated double assertions replaced by one named runtime-checked adapter boundary |
| A-18 governance/docs | Critical CODEOWNERS, concise current status, aligned README, solo-review policy, and corrected ADR 029/030 index added |

## 7. Architecture and package conclusion

The modular-monolith package set remains justified. There is no generic
`shared`, `common`, or `utils` package. Each package owns a stable
capability, dependency direction, security boundary, or reusable contract:

| Package | Owner |
| --- | --- |
| `artifact-store` | bounded regional object persistence and lifecycle |
| `contracts` | transport schemas and exact public response outputs |
| `database` | PostgreSQL authority, tenancy, transactions, and migrations |
| `integrations` | provider, credential, and outbound-network boundaries |
| `node-catalog` | immutable compatibility release resolution |
| `node-sdk` | node definition and executor contracts |
| `nodes-core` | built-in deterministic nodes |
| `observability` | cross-process logging, tracing, metrics, and Nest lifecycle adapter |
| `queue` | identifier-only transport and lease policy |
| `rate-limit` | distributed abuse-limit policy |
| `workflow-engine` | infrastructure-free durable state machine |
| `workflow-model` | authoring, executable model, and expression policy |

The source graph remains acyclic. API feature composition occurs in platform
runtime modules; sibling features no longer import one another's implementation
internals.

## 8. Remaining hotspot guidance

The complexity ratchet reports the current highest branch-density functions,
including coordinator status/plan validation, persisted observation parsing,
node-attempt completion, and workflow-engine transition derivation. These are not
new audit findings by size alone. Refactor them only with behavior
characterization, one invariant owner, unchanged public surfaces, and a lower
ratchet baseline.

The authoring factory remains about 500 lines, but publication invariants are now
owned by bounded named steps in a separate internal module. Readiness remains one
public fail-closed probe with a small orchestrator and capability-owned
projections. Those findings are closed because their acceptance criteria, not an
arbitrary file-count target, are satisfied.

## 9. Closure rule

Repository-controlled remediation is complete only if the final branch remains
green under all protected checks and the audit head is not changed by unreviewed
code afterward. O-01 cannot close without live deployment evidence. O-02 cannot
close without controlled external canaries. O-03 is an explicit solo-maintainer
risk acceptance, not proof of independent review.

Phase 7 stays in progress until the authoritative implementation tracker links
fresh live evidence. Passing repository tests must never be used to mark those
external rows complete.
