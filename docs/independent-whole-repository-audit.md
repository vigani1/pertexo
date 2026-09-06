# Independent whole-repository audit

Audit date: 2026-09-06. Implementation baseline: `faed09c4543784c0f0e9bcaa0ed2a5335b411261`.

## 1. Executive verdict and production-readiness boundary

**Continue development; do not release this baseline as production-ready.** The modular-monolith architecture is appropriate, and the repository has substantial real-service durability, tenancy, recovery, and compatibility verification. Nevertheless, green checks coexist with reproducible scheduling, orchestration, credential-fencing, retention, and deployment defects. These are implementation problems, not merely missing production certifications.

The most consequential risks are: a valid DST schedule can synchronously trap a worker; rendered production configuration cannot start the API and leaves worker execution disabled; HTTP/Slack credential validation is not atomic with dispatch; automatic HTTP tracing captures OAuth query material; and legal nested/skipped Parallel/Merge graphs violate execution semantics. Section 17 records 17 new findings: **0 P0, 4 P1, 10 P2, 3 P3**. Two existing P2 lifecycle-command findings remain open separately. External release-evidence obligations are not counted as new code defects.

Local PostgreSQL/Redis/S3-compatible tests do not establish AWS IAM, KMS policy, Object Lock, managed-service failover, production capacity, signed promotion provenance, provider behavior, or regional RPO/RTO. Phase 7 must remain incomplete. The current tracker correctly leaves the external release boundary open, but its earlier completed slices need targeted regression corrections; a completed historical checkpoint is not proof against later interactions.

No recommendation here requires replacing the architecture, introducing microservices, moving all SQL into an ORM, replacing every small script with TypeScript, or deleting compatibility contracts. Fix the demonstrated invariants first. Re-evaluate the custom-engine gate if repairs require growing special-case compensation rather than a coherent scoped scheduling model.

## 2. Exact audited commit and scope

| Fact | Recorded value |
| --- | --- |
| Starting HEAD | `faed09c4543784c0f0e9bcaa0ed2a5335b411261` |
| Branch / upstream | `main` / `origin/main` |
| Remote | `git@github.com:vigani1/pertexo.git` |
| Starting relationship | Ahead 0, behind 0; remote main resolved to the same commit |
| Starting working tree | Clean, including untracked-file check |
| Tracked scope | 1,287 files; 278,655 physical lines |
| Workspace | 6 applications and 12 packages |
| Host runtime | Node `24.15.0`, pnpm `11.22.0`, Docker server `29.2.0` |
| Built runtime | Node `24.18.1`, UID `10001` |
| Baseline content digest | `99bffbd6a11455fc16d9efd8d00fea4fda4a0294ac94dde3a531fd2a6a9c068b` |

The digest hashes sorted tracked paths, a NUL, each file's raw bytes, and a NUL using SHA-256. Section 4 lists the individual files. Included: all tracked production code, tests/support/fixtures, generated contracts, SQL and execution plan, manifests, lockfile, infrastructure, shell/JavaScript tooling, configuration, and documentation. Generated-but-tracked contracts were examined, not excluded as generated noise.

Excluded: `.git` internals, installed third-party source except targeted dependency behavior checks, ignored build/coverage/cache output, local secret/environment files, external cloud accounts and customer data. The synthetic tracked `.env.example` was included. This is not a claim that third-party dependencies were individually source-audited or that every possible state transition was exhaustively executed.

The only authorized repository addition is this report. No production/test/configuration fix, migration edit, commit, branch change, push, or remote mutation was performed. Temporary probes and disposable services were isolated outside the tracked tree.

## 3. Methodology, tools, skills, sources, and limitations

The review used full-file examination across explicit owners, cross-package tracing, adversarial probes, real PostgreSQL/Redis/object-store tests, container construction, and exact-commit remote checks. Existing audits were read as claims; their remediation headers were compared with implementation, not copied as conclusions. Suspicions were rejected when no realistic path or violated invariant could be established.

Skills used: `delegate-native-work` for bounded app/database/engine reviews; `nestjs-best-practices` for module, DI, request and failure ownership; `postgres` for runtime roles, transactions, constraints and migrations; `codebase-design` for interface depth and locality; `typescript-advanced-types` for static/runtime contract boundaries; `diagnosing-bugs` for hypotheses and reproduction; and `tdd` principles for correction-test criteria and controlled negatives. The fixed-point `code-review` skill was inspected but its diff-only scope was not substituted for the requested whole-repository review. React/frontend skills do not apply: this checkout deliberately contains no web application.

The skill-guided decomposition influenced the audit, not repository architecture: reviewers had disjoint implementation areas, while the primary reviewer checked critical cross-package findings and reconciled the scope. No implementation was delegated for repair.

Primary-source calibration used during this audit:

| Source | What it supports; not an inferred certification |
| --- | --- |
| [PostgreSQL row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html) | Owner/bypass behavior and policy enforcement; supports checking non-owner runtime roles and FORCE RLS, not declaring deployed roles safe |
| [Redis script atomicity](https://redis.io/docs/latest/develop/programmability/eval-intro/) | Lua execution is atomic; supports reviewing all dimensions before mutation and avoiding Redis Cluster assumptions |
| [BullMQ production guidance](https://docs.bullmq.io/guide/going-to-production) | Transport configuration and graceful shutdown remain operational requirements; queue completion is not database truth |
| [Resend idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys) | Provider idempotency has a bounded retention horizon; local retry tests cannot establish unbounded deduplication |
| [ECS deployment configuration](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_DeploymentConfiguration.html) | `maximumPercent` permits old/new task overlap; the connection-budget surge calculation in IWA-09 is an engineering inference from this documented behavior |
| [node-postgres client API](https://node-postgres.com/apis/client) | Query configuration and timeout semantics must match the installed driver; an arbitrary `signal` property is not proof of wire cancellation |
| [Vitest coverage](https://vitest.dev/guide/coverage.html) | Coverage provider/scope must be explicit; passing branch percentages do not prove untested state combinations |

Sources establish specific semantics, not universal package-count, LOC, coverage, or scoring standards. Findings and severity are this review's judgments grounded in the evidence below. External guidance is not a substitute for the plan/ADRs.

Limitations: no live provider calls, deployment mutation, real AWS disaster exercise, production query-plan sampling, independent cryptographic implementation audit, or full mutation-testing campaign. A fake public resolver was used for hostname/CPU probes, intentionally avoiding outbound traffic. The dispatch-race probe controls the interleave; database implementation tracing establishes the missing atomic fence. The engine probes build legal executable graphs rather than merely constructing malformed checkpoints.

## 4. Complete reviewed-file inventory

The inventory at the end of this section is generated from the exact tracked baseline after review, grouped by ownership area. Listing a file is not itself the review method: source and test bodies, generated artifacts, migrations, and documents were opened and examined by the assigned reviewer. Primary review owns root/infrastructure and artifact-store/integrations/observability/queue/rate-limit; app, database, and engine-contract reviewers own the remaining explicitly named areas. Critical findings were cross-checked across these boundaries.

### .githooks — 1 files

| Reviewed path (repository-relative) | Physical lines |
| --- | ---: |
| `.githooks/pre-push` | 13 |

### .github — 5 files

| Reviewed path (repository-relative) | Physical lines |
| --- | ---: |
| `.github/CODEOWNERS` | 12 |
| `.github/dependabot.yml` | 87 |
| `.github/workflows/ci.yml` | 569 |
| `.github/workflows/codeql.yml` | 33 |
| `.github/workflows/release-gate.yml` | 41 |

### apps/api — 205 files

| Reviewed path (repository-relative) | Physical lines |
| --- | ---: |
| `apps/api/package.json` | 45 |
| `apps/api/src/app.module.ts` | 231 |
| `apps/api/src/app.ts` | 283 |
| `apps/api/src/application-error-mappers.ts` | 60 |
| `apps/api/src/connections/authorization.ts` | 48 |
| `apps/api/src/connections/controllers.ts` | 198 |
| `apps/api/src/connections/errors.ts` | 74 |
| `apps/api/src/connections/failure-notification-destinations.ts` | 371 |
| `apps/api/src/connections/guards.ts` | 41 |
| `apps/api/src/connections/index.ts` | 10 |
| `apps/api/src/connections/module.ts` | 137 |
| `apps/api/src/connections/ports.ts` | 50 |
| `apps/api/src/connections/telemetry.ts` | 91 |
| `apps/api/src/connections/tokens.ts` | 4 |
| `apps/api/src/connections/types.ts` | 30 |
| `apps/api/src/connections/use-cases.ts` | 574 |
| `apps/api/src/executions/index.ts` | 12 |
| `apps/api/src/executions/initial-workflow-checkpoint.ts` | 88 |
| `apps/api/src/executions/postgres-run-event-reader.ts` | 54 |
| `apps/api/src/executions/redis-run-event-publisher.ts` | 7 |
| `apps/api/src/executions/redis-run-event-source.ts` | 381 |
| `apps/api/src/executions/run-event-stream.ts` | 270 |
| `apps/api/src/identity-infrastructure/index.ts` | 5 |
| `apps/api/src/identity-infrastructure/oidc-adapter.ts` | 506 |
| `apps/api/src/identity-infrastructure/oidc-secret-encryption.ts` | 224 |
| `apps/api/src/identity-workspace/contracts.ts` | 4 |
| `apps/api/src/identity-workspace/controllers.ts` | 399 |
| `apps/api/src/identity-workspace/database-adapter.ts` | 129 |
| `apps/api/src/identity-workspace/errors.ts` | 84 |
| `apps/api/src/identity-workspace/guards.ts` | 222 |
| `apps/api/src/identity-workspace/index.ts` | 41 |
| `apps/api/src/identity-workspace/module.ts` | 231 |
| `apps/api/src/identity-workspace/ports.ts` | 106 |
| `apps/api/src/identity-workspace/request-identifiers.ts` | 26 |
| `apps/api/src/identity-workspace/telemetry.ts` | 189 |
| `apps/api/src/identity-workspace/tokens.ts` | 14 |
| `apps/api/src/identity-workspace/types.ts` | 36 |
| `apps/api/src/identity-workspace/use-cases.ts` | 302 |
| `apps/api/src/identity/crypto.ts` | 54 |
| `apps/api/src/identity/csrf.ts` | 42 |
| `apps/api/src/identity/errors.ts` | 72 |
| `apps/api/src/identity/index.ts` | 25 |
| `apps/api/src/identity/oidc.ts` | 288 |
| `apps/api/src/identity/ports.ts` | 93 |
| `apps/api/src/identity/session.ts` | 235 |
| `apps/api/src/identity/types.ts` | 138 |
| `apps/api/src/main.ts` | 69 |
| `apps/api/src/node-testing/controller.ts` | 137 |
| `apps/api/src/node-testing/errors.ts` | 90 |
| `apps/api/src/node-testing/guards.ts` | 17 |
| `apps/api/src/node-testing/index.ts` | 8 |
| `apps/api/src/node-testing/module.ts` | 73 |
| `apps/api/src/node-testing/ports.ts` | 18 |
| `apps/api/src/node-testing/tokens.ts` | 3 |
| `apps/api/src/node-testing/use-case.ts` | 328 |
| `apps/api/src/node-testing/validation.ts` | 221 |
| `apps/api/src/platform/config/api-config.ts` | 431 |
| `apps/api/src/platform/connections/connection-runtime.module.ts` | 178 |
| `apps/api/src/platform/database/database.module.ts` | 99 |
| `apps/api/src/platform/health/drain-state.ts` | 19 |
| `apps/api/src/platform/health/live.controller.ts` | 18 |
| `apps/api/src/platform/health/ready.controller.ts` | 52 |
| `apps/api/src/platform/http/application-error.ts` | 46 |
| `apps/api/src/platform/http/http.module.ts` | 78 |
| `apps/api/src/platform/http/idempotency-key.ts` | 33 |
| `apps/api/src/platform/http/index.ts` | 17 |
| `apps/api/src/platform/http/problem-details.filter.ts` | 403 |
| `apps/api/src/platform/http/request-context.ts` | 186 |
| `apps/api/src/platform/http/request-headers.ts` | 38 |
| `apps/api/src/platform/http/request-operation-signal.ts` | 37 |
| `apps/api/src/platform/identity/identity-runtime.module.ts` | 154 |
| `apps/api/src/platform/observability/api-metrics.ts` | 151 |
| `apps/api/src/platform/observability/observability.module.ts` | 33 |
| `apps/api/src/platform/observability/sse-visibility-metrics.ts` | 79 |
| `apps/api/src/platform/rate-limit/interceptor.ts` | 144 |
| `apps/api/src/platform/rate-limit/metadata.ts` | 16 |
| `apps/api/src/platform/rate-limit/metrics.ts` | 27 |
| `apps/api/src/platform/rate-limit/rate-limit.module.ts` | 54 |
| `apps/api/src/platform/schedules/schedule-runtime.module.ts` | 52 |
| `apps/api/src/platform/webhooks/webhook-runtime.module.ts` | 80 |
| `apps/api/src/platform/workflow/workflow-runtime.module.ts` | 468 |
| `apps/api/src/schedules/controllers.ts` | 133 |
| `apps/api/src/schedules/guards.ts` | 27 |
| `apps/api/src/schedules/module.ts` | 56 |
| `apps/api/src/schedules/service.ts` | 100 |
| `apps/api/src/schedules/telemetry.ts` | 50 |
| `apps/api/src/webhooks/controllers.ts` | 120 |
| `apps/api/src/webhooks/guards.ts` | 27 |
| `apps/api/src/webhooks/ingress.ts` | 419 |
| `apps/api/src/webhooks/module.ts` | 57 |
| `apps/api/src/webhooks/service.ts` | 183 |
| `apps/api/src/webhooks/telemetry.ts` | 79 |
| `apps/api/src/workflow-authoring/controllers.ts` | 300 |
| `apps/api/src/workflow-authoring/cursor.ts` | 78 |
| `apps/api/src/workflow-authoring/errors.ts` | 94 |
| `apps/api/src/workflow-authoring/etag.ts` | 24 |
| `apps/api/src/workflow-authoring/graph.ts` | 7 |
| `apps/api/src/workflow-authoring/guards.ts` | 64 |
| `apps/api/src/workflow-authoring/index.ts` | 11 |
| `apps/api/src/workflow-authoring/module.ts` | 158 |
| `apps/api/src/workflow-authoring/ports.ts` | 36 |
| `apps/api/src/workflow-authoring/preconditions.ts` | 54 |
| `apps/api/src/workflow-authoring/serializers.ts` | 148 |
| `apps/api/src/workflow-authoring/telemetry.ts` | 182 |
| `apps/api/src/workflow-authoring/tokens.ts` | 12 |
| `apps/api/src/workflow-authoring/types.ts` | 64 |
| `apps/api/src/workflow-authoring/use-cases.ts` | 364 |
| `apps/api/src/workflow-runs/controllers.ts` | 336 |
| `apps/api/src/workflow-runs/errors.ts` | 52 |
| `apps/api/src/workflow-runs/event-streamer.ts` | 77 |
| `apps/api/src/workflow-runs/guards.ts` | 47 |
| `apps/api/src/workflow-runs/index.ts` | 8 |
| `apps/api/src/workflow-runs/module.ts` | 122 |
| `apps/api/src/workflow-runs/ports.ts` | 124 |
| `apps/api/src/workflow-runs/postgres-persistence.ts` | 179 |
| `apps/api/src/workflow-runs/tokens.ts` | 3 |
| `apps/api/src/workflow-runs/use-cases.ts` | 254 |
| `apps/api/src/workspaces/actor-context.ts` | 73 |
| `apps/api/src/workspaces/audit.ts` | 183 |
| `apps/api/src/workspaces/authorize-workspace.ts` | 224 |
| `apps/api/src/workspaces/index.ts` | 5 |
| `apps/api/src/workspaces/policy.ts` | 70 |
| `apps/api/src/workspaces/types.ts` | 76 |
| `apps/api/test/api-bootstrap.test.ts` | 630 |
| `apps/api/test/api-config.test.ts` | 294 |
| `apps/api/test/connections/controllers.test.ts` | 172 |
| `apps/api/test/connections/credential-boundaries.test.ts` | 115 |
| `apps/api/test/connections/errors.test.ts` | 60 |
| `apps/api/test/connections/failure-notification-destinations.test.ts` | 264 |
| `apps/api/test/connections/http-stack.test.ts` | 328 |
| `apps/api/test/connections/module.test.ts` | 67 |
| `apps/api/test/connections/telemetry.test.ts` | 39 |
| `apps/api/test/connections/use-cases.test.ts` | 773 |
| `apps/api/test/executions/postgres-run-event-reader.test.ts` | 122 |
| `apps/api/test/executions/redis-run-event-publisher.test.ts` | 90 |
| `apps/api/test/executions/redis-run-event-source.test.ts` | 229 |
| `apps/api/test/executions/run-event-stream.integration.test.ts` | 205 |
| `apps/api/test/executions/run-event-stream.resilience.integration.test.ts` | 315 |
| `apps/api/test/executions/run-event-stream.test.ts` | 304 |
| `apps/api/test/feature-import-boundaries.test.ts` | 37 |
| `apps/api/test/http/problem-details.filter.test.ts` | 703 |
| `apps/api/test/http/request-context.test.ts` | 116 |
| `apps/api/test/http/request-headers.test.ts` | 41 |
| `apps/api/test/identity-infrastructure/identity-runtime.test.ts` | 109 |
| `apps/api/test/identity-infrastructure/oidc-adapter.test.ts` | 384 |
| `apps/api/test/identity-infrastructure/oidc-secret-encryption.test.ts` | 121 |
| `apps/api/test/identity-workspace/contracts.test.ts` | 134 |
| `apps/api/test/identity-workspace/controllers.test.ts` | 304 |
| `apps/api/test/identity-workspace/database-adapter.test.ts` | 34 |
| `apps/api/test/identity-workspace/errors.test.ts` | 100 |
| `apps/api/test/identity-workspace/guards-request-context.test.ts` | 223 |
| `apps/api/test/identity-workspace/nest-module.test.ts` | 100 |
| `apps/api/test/identity-workspace/real-api.integration.test.ts` | 922 |
| `apps/api/test/identity-workspace/request-identifiers.test.ts` | 25 |
| `apps/api/test/identity-workspace/telemetry.test.ts` | 200 |
| `apps/api/test/identity-workspace/use-cases.test.ts` | 397 |
| `apps/api/test/identity/oidc.test.ts` | 402 |
| `apps/api/test/identity/session.test.ts` | 307 |
| `apps/api/test/node-testing/controller.test.ts` | 217 |
| `apps/api/test/node-testing/errors.test.ts` | 41 |
| `apps/api/test/node-testing/module.test.ts` | 41 |
| `apps/api/test/node-testing/use-case.test.ts` | 470 |
| `apps/api/test/node-testing/validation.test.ts` | 123 |
| `apps/api/test/platform/compatibility-rollout.integration.test.ts` | 829 |
| `apps/api/test/platform/http/request-operation-signal.test.ts` | 62 |
| `apps/api/test/platform/observability/api-metrics.test.ts` | 181 |
| `apps/api/test/platform/observability/sse-visibility-load.test.ts` | 40 |
| `apps/api/test/platform/observability/sse-visibility-metrics.test.ts` | 62 |
| `apps/api/test/rate-limit/distributed-rate-limiter.integration.test.ts` | 151 |
| `apps/api/test/rate-limit/interceptor.test.ts` | 299 |
| `apps/api/test/rate-limit/rate-limit.module.test.ts` | 58 |
| `apps/api/test/rate-limit/route-classification.test.ts` | 99 |
| `apps/api/test/rate-limit/trusted-proxy.test.ts` | 73 |
| `apps/api/test/response-contract-types.test.ts` | 49 |
| `apps/api/test/schedules/service.test.ts` | 79 |
| `apps/api/test/support/api-platform.fixture.ts` | 110 |
| `apps/api/test/support/disposable-database.ts` | 28 |
| `apps/api/test/support/integration-gate.test.ts` | 40 |
| `apps/api/test/support/integration-gate.ts` | 20 |
| `apps/api/test/webhooks/direct-webhook.integration.test.ts` | 827 |
| `apps/api/test/webhooks/ingress.test.ts` | 418 |
| `apps/api/test/webhooks/service.test.ts` | 167 |
| `apps/api/test/webhooks/telemetry.test.ts` | 57 |
| `apps/api/test/workflow-authoring/controllers.test.ts` | 209 |
| `apps/api/test/workflow-authoring/errors.test.ts` | 74 |
| `apps/api/test/workflow-authoring/etag.test.ts` | 89 |
| `apps/api/test/workflow-authoring/graph.test.ts` | 71 |
| `apps/api/test/workflow-authoring/module.test.ts` | 39 |
| `apps/api/test/workflow-authoring/preconditions.test.ts` | 46 |
| `apps/api/test/workflow-authoring/telemetry.test.ts` | 69 |
| `apps/api/test/workflow-authoring/use-cases.test.ts` | 434 |
| `apps/api/test/workflow-runs/controllers.test.ts` | 204 |
| `apps/api/test/workflow-runs/event-streamer.test.ts` | 79 |
| `apps/api/test/workflow-runs/module.test.ts` | 42 |
| `apps/api/test/workflow-runs/postgres-persistence.test.ts` | 370 |
| `apps/api/test/workflow-runs/use-cases.test.ts` | 212 |
| `apps/api/test/workspaces/audit.test.ts` | 128 |
| `apps/api/test/workspaces/authorization.test.ts` | 438 |
| `apps/api/tsconfig.json` | 21 |
| `apps/api/tsconfig.test.json` | 19 |
| `apps/api/vitest.compatibility-rollout.config.ts` | 12 |
| `apps/api/vitest.config.ts` | 8 |
| `apps/api/vitest.coverage.config.ts` | 25 |
| `apps/api/vitest.integration.config.ts` | 12 |
| `apps/api/vitest.sse-resilience.config.ts` | 15 |

### apps/lifecycle-command — 10 files

| Reviewed path (repository-relative) | Physical lines |
| --- | ---: |
| `apps/lifecycle-command/package.json` | 18 |
| `apps/lifecycle-command/src/config.ts` | 129 |
| `apps/lifecycle-command/src/main.ts` | 87 |
| `apps/lifecycle-command/src/readiness-marker.ts` | 15 |
| `apps/lifecycle-command/src/run.ts` | 100 |
| `apps/lifecycle-command/test/config.test.ts` | 49 |
| `apps/lifecycle-command/test/run.test.ts` | 180 |
| `apps/lifecycle-command/tsconfig.json` | 13 |
| `apps/lifecycle-command/tsconfig.test.json` | 10 |
| `apps/lifecycle-command/vitest.config.ts` | 8 |

### apps/operator-command — 9 files

| Reviewed path (repository-relative) | Physical lines |
| --- | ---: |
| `apps/operator-command/package.json` | 17 |
| `apps/operator-command/src/config.ts` | 368 |
| `apps/operator-command/src/main.ts` | 75 |
| `apps/operator-command/src/run.ts` | 252 |
| `apps/operator-command/test/config.test.ts` | 185 |
| `apps/operator-command/test/run.test.ts` | 66 |
| `apps/operator-command/tsconfig.json` | 13 |
| `apps/operator-command/tsconfig.test.json` | 10 |
| `apps/operator-command/vitest.config.ts` | 8 |

### apps/recovery — 9 files

| Reviewed path (repository-relative) | Physical lines |
| --- | ---: |
| `apps/recovery/package.json` | 18 |
| `apps/recovery/src/config.ts` | 211 |
| `apps/recovery/src/main.ts` | 102 |
| `apps/recovery/src/restore-before-serve.ts` | 173 |
| `apps/recovery/test/config.test.ts` | 83 |
| `apps/recovery/test/restore-before-serve.test.ts` | 305 |
| `apps/recovery/tsconfig.json` | 13 |
| `apps/recovery/tsconfig.test.json` | 10 |
| `apps/recovery/vitest.config.ts` | 8 |

### apps/retention — 12 files

| Reviewed path (repository-relative) | Physical lines |
| --- | ---: |
| `apps/retention/package.json` | 19 |
| `apps/retention/src/config.ts` | 175 |
| `apps/retention/src/main.ts` | 161 |
| `apps/retention/src/maintenance-loops.ts` | 419 |
| `apps/retention/src/metrics.ts` | 308 |
| `apps/retention/src/run.ts` | 133 |
| `apps/retention/test/config.test.ts` | 88 |
| `apps/retention/test/metrics.test.ts` | 83 |
| `apps/retention/test/run.test.ts` | 387 |
| `apps/retention/tsconfig.json` | 13 |
| `apps/retention/tsconfig.test.json` | 10 |
| `apps/retention/vitest.config.ts` | 8 |

### apps/worker — 132 files

| Reviewed path (repository-relative) | Physical lines |
| --- | ---: |
| `apps/worker/package.json` | 43 |
| `apps/worker/src/app.ts` | 113 |
| `apps/worker/src/config/worker-config.ts` | 472 |
| `apps/worker/src/execution/coordinator-engine.ts` | 102 |
| `apps/worker/src/execution/coordinator-handler.ts` | 193 |
| `apps/worker/src/execution/coordinator-runtime.ts` | 248 |
| `apps/worker/src/execution/coordinator-telemetry.ts` | 31 |
| `apps/worker/src/execution/core-definition-identities.ts` | 58 |
| `apps/worker/src/execution/email-provider-telemetry.ts` | 28 |
| `apps/worker/src/execution/failure-notification-delivery.ts` | 507 |
| `apps/worker/src/execution/failure-notification-handler.ts` | 115 |
| `apps/worker/src/execution/http-provider-telemetry.ts` | 202 |
| `apps/worker/src/execution/node-attempt-engine.ts` | 353 |
| `apps/worker/src/execution/node-attempt-handler.ts` | 482 |
| `apps/worker/src/execution/node-attempt-runtime.ts` | 351 |
| `apps/worker/src/execution/node-runtime-capabilities.ts` | 514 |
| `apps/worker/src/execution/operator-run-replay-runtime.ts` | 137 |
| `apps/worker/src/execution/preview-attempt-handler.ts` | 525 |
| `apps/worker/src/execution/preview-attempt-runtime.ts` | 307 |
| `apps/worker/src/execution/preview-maintenance-runtime.ts` | 213 |
| `apps/worker/src/execution/preview-reconciliation-runtime.ts` | 123 |
| `apps/worker/src/execution/preview-telemetry.ts` | 128 |
| `apps/worker/src/execution/provider-telemetry.ts` | 94 |
| `apps/worker/src/execution/slack-provider-telemetry.ts` | 28 |
| `apps/worker/src/execution/unknown-outcome-reconciliation-runtime.ts` | 90 |
| `apps/worker/src/main.ts` | 66 |
| `apps/worker/src/platform/database/database.module.ts` | 109 |
| `apps/worker/src/platform/observability/observability.module.ts` | 33 |
| `apps/worker/src/runtime/abortable-delay.ts` | 53 |
| `apps/worker/src/runtime/artifact-metrics.ts` | 28 |
| `apps/worker/src/runtime/worker-drain-state.ts` | 19 |
| `apps/worker/src/runtime/worker-process-keepalive.ts` | 25 |
| `apps/worker/src/runtime/worker-process-shutdown.ts` | 52 |
| `apps/worker/src/runtime/worker-readiness-monitor.ts` | 59 |
| `apps/worker/src/runtime/worker-readiness.ts` | 51 |
| `apps/worker/src/runtime/worker-resource-monitor.ts` | 94 |
| `apps/worker/src/testing.ts` | 20 |
| `apps/worker/src/transport/coordinator-runtime-provider.ts` | 49 |
| `apps/worker/src/transport/dispatch-consumer-capabilities.ts` | 81 |
| `apps/worker/src/transport/dispatch-providers.ts` | 171 |
| `apps/worker/src/transport/node-attempt-runtime-provider.ts` | 107 |
| `apps/worker/src/transport/outbox-dispatcher.ts` | 537 |
| `apps/worker/src/transport/outbox-publication-settlements.ts` | 61 |
| `apps/worker/src/transport/preview-maintenance-runtime-provider.ts` | 138 |
| `apps/worker/src/transport/transport-job.ts` | 60 |
| `apps/worker/src/transport/transport-lifecycle.ts` | 63 |
| `apps/worker/src/transport/transport-metrics-adapter.ts` | 68 |
| `apps/worker/src/transport/transport-operation-deadline.ts` | 33 |
| `apps/worker/src/transport/transport-tokens.ts` | 42 |
| `apps/worker/src/transport/transport.module.ts` | 66 |
| `apps/worker/src/transport/trigger-runtime-provider.ts` | 51 |
| `apps/worker/src/triggers/trigger-handler.ts` | 85 |
| `apps/worker/src/triggers/trigger-runtime.ts` | 264 |
| `apps/worker/src/triggers/trigger-telemetry.ts` | 56 |
| `apps/worker/src/worker.module.ts` | 164 |
| `apps/worker/test/abortable-delay.test.ts` | 47 |
| `apps/worker/test/artifact-reference.integration.test.ts` | 421 |
| `apps/worker/test/compatibility-rollout.test.ts` | 70 |
| `apps/worker/test/compose-service-control.test.ts` | 116 |
| `apps/worker/test/coordinator-consumer-failure-notification.integration.test.ts` | 765 |
| `apps/worker/test/coordinator-consumer-foreach-cancellation.integration.test.ts` | 489 |
| `apps/worker/test/coordinator-consumer-identity-mismatch.integration.test.ts` | 120 |
| `apps/worker/test/coordinator-consumer-linear-execution.integration.test.ts` | 387 |
| `apps/worker/test/coordinator-consumer-parallel-recovery.integration.test.ts` | 283 |
| `apps/worker/test/coordinator-consumer-redelivery.integration.test.ts` | 162 |
| `apps/worker/test/coordinator-consumer-retry-wait.integration.test.ts` | 477 |
| `apps/worker/test/coordinator-consumer.fixtures.ts` | 491 |
| `apps/worker/test/coordinator-engine.test.ts` | 190 |
| `apps/worker/test/coordinator-handler.test.ts` | 272 |
| `apps/worker/test/coordinator-runtime.test.ts` | 214 |
| `apps/worker/test/coordinator-telemetry.test.ts` | 27 |
| `apps/worker/test/email-provider-telemetry.test.ts` | 64 |
| `apps/worker/test/failure-notification-delivery.test.ts` | 941 |
| `apps/worker/test/failure-notification-handler.test.ts` | 145 |
| `apps/worker/test/fixtures/retained-core-workflow-v2.json` | 163 |
| `apps/worker/test/for-each-worker-process-fixture.ts` | 60 |
| `apps/worker/test/http-node-attempt.integration.test.ts` | 928 |
| `apps/worker/test/http-provider-telemetry.test.ts` | 157 |
| `apps/worker/test/node-attempt-engine.test.ts` | 465 |
| `apps/worker/test/node-attempt-handler-part-2.test.ts` | 451 |
| `apps/worker/test/node-attempt-handler.test.ts` | 521 |
| `apps/worker/test/node-attempt-runtime.test.ts` | 449 |
| `apps/worker/test/node-runtime-capabilities.test.ts` | 887 |
| `apps/worker/test/outbox-dispatcher.test.ts` | 694 |
| `apps/worker/test/preview-attempt-handler.test.ts` | 521 |
| `apps/worker/test/preview-attempt-runtime.test.ts` | 690 |
| `apps/worker/test/preview-consumer-artifact-retention.integration.test.ts` | 180 |
| `apps/worker/test/preview-consumer-crash-boundaries.integration.test.ts` | 360 |
| `apps/worker/test/preview-consumer-delivery.integration.test.ts` | 156 |
| `apps/worker/test/preview-consumer-reconciliation.integration.test.ts` | 128 |
| `apps/worker/test/preview-consumer-sigkill-reconciliation.integration.test.ts` | 236 |
| `apps/worker/test/preview-reconciliation-process-fixture.mjs` | 160 |
| `apps/worker/test/preview-reconciliation-runtime.test.ts` | 157 |
| `apps/worker/test/preview-telemetry.test.ts` | 104 |
| `apps/worker/test/retained-core-workflow-v2.test.ts` | 107 |
| `apps/worker/test/schedule-trigger.integration.test.ts` | 1000 |
| `apps/worker/test/slack-provider-telemetry.test.ts` | 126 |
| `apps/worker/test/support/compatibility-release.fixture.ts` | 106 |
| `apps/worker/test/support/compose-service-control.ts` | 198 |
| `apps/worker/test/support/coordinator-dispatch-fixtures.ts` | 98 |
| `apps/worker/test/support/coordinator-run-fixtures.ts` | 325 |
| `apps/worker/test/support/coordinator-workflow-fixtures.ts` | 405 |
| `apps/worker/test/support/disposable-database.ts` | 33 |
| `apps/worker/test/support/execution-engine.fixture.ts` | 40 |
| `apps/worker/test/support/http-node-attempt.fixture.ts` | 572 |
| `apps/worker/test/support/http-node-attempt.runtime.ts` | 225 |
| `apps/worker/test/support/node-attempt-handler.fixture.ts` | 145 |
| `apps/worker/test/support/preview-consumer-crash-process.support.ts` | 112 |
| `apps/worker/test/support/preview-consumer.integration.support.ts` | 576 |
| `apps/worker/test/support/transport.integration.support.ts` | 336 |
| `apps/worker/test/support/workspace-query.ts` | 24 |
| `apps/worker/test/transport-metrics-adapter.test.ts` | 134 |
| `apps/worker/test/transport-part-2.integration.test.ts` | 338 |
| `apps/worker/test/transport.integration.test.ts` | 663 |
| `apps/worker/test/transport.resilience.integration.test.ts` | 748 |
| `apps/worker/test/trigger-consumer.integration.test.ts` | 141 |
| `apps/worker/test/trigger-handler.test.ts` | 134 |
| `apps/worker/test/trigger-runtime.test.ts` | 245 |
| `apps/worker/test/unknown-outcome-reconciliation-runtime.test.ts` | 52 |
| `apps/worker/test/worker-bootstrap.test.ts` | 520 |
| `apps/worker/test/worker-config.test.ts` | 383 |
| `apps/worker/test/worker-process-keepalive.test.ts` | 23 |
| `apps/worker/test/worker-process-lifecycle.fixture.mjs` | 173 |
| `apps/worker/test/worker-process-lifecycle.test.ts` | 98 |
| `apps/worker/test/worker-resource-monitor.test.ts` | 56 |
| `apps/worker/test/workflow-publish-transport-contract.test.ts` | 16 |
| `apps/worker/tsconfig.json` | 20 |
| `apps/worker/tsconfig.test.json` | 10 |
| `apps/worker/vitest.config.ts` | 16 |
| `apps/worker/vitest.coverage.config.ts` | 34 |
| `apps/worker/vitest.integration.config.ts` | 13 |
| `apps/worker/vitest.resilience.config.ts` | 13 |

### docs — 70 files

| Reviewed path (repository-relative) | Physical lines |
| --- | ---: |
| `docs/adr/001-modular-monolith-monorepo-api-worker.md` | 121 |
| `docs/adr/002-postgresql-jsonb-drafts-immutable-versions-checksum-identity.md` | 485 |
| `docs/adr/003-workspace-tenancy-rls-runtime-roles.md` | 303 |
| `docs/adr/004-managed-oidc-and-internal-authorization.md` | 246 |
| `docs/adr/005-postgresql-authority-bullmq-outbox-engine-gate.md` | 337 |
| `docs/adr/006-coordinator-checkpoint-and-node-attempt-jobs.md` | 45 |
| `docs/adr/007-run-node-state-retry-idempotency.md` | 237 |
| `docs/adr/008-structured-bounded-loops.md` | 113 |
| `docs/adr/009-restricted-jsonata.md` | 215 |
| `docs/adr/010-node-executor-compatibility-retirement.md` | 292 |
| `docs/adr/011-optimistic-draft-concurrency.md` | 293 |
| `docs/adr/012-fair-admission-backpressure-entitlements.md` | 125 |
| `docs/adr/013-retention-workspace-deletion-legal-hold.md` | 113 |
| `docs/adr/014-schedule-timezone-dst-misfire.md` | 72 |
| `docs/adr/015-production-slo-region-and-recovery.md` | 145 |
| `docs/adr/016-node-preview-testing-semantics.md` | 130 |
| `docs/adr/017-condition-branch-selection.md` | 126 |
| `docs/adr/018-switch-ordered-case-selection.md` | 89 |
| `docs/adr/019-bounded-parallel-and-merge.md` | 98 |
| `docs/adr/020-bounded-for-each.md` | 128 |
| `docs/adr/021-durable-wait.md` | 90 |
| `docs/adr/022-run-failure-notification.md` | 81 |
| `docs/adr/023-slack-send-message-provider.md` | 86 |
| `docs/adr/024-resend-email-notification-provider.md` | 98 |
| `docs/adr/025-provider-failure-notification-destinations.md` | 109 |
| `docs/adr/026-generic-webhook-signature-replay.md` | 144 |
| `docs/adr/027-workspace-lifecycle-command-dispatch.md` | 94 |
| `docs/adr/028-ecs-deployment-manifest.md` | 65 |
| `docs/adr/029-operator-command-execution-boundary.md` | 57 |
| `docs/adr/030-autoscaling-input-contract.md` | 27 |
| `docs/audits/README.md` | 102 |
| `docs/audits/apps/lifecycle-command.md` | 188 |
| `docs/audits/packages/artifact-store.md` | 798 |
| `docs/audits/packages/contracts.md` | 617 |
| `docs/audits/packages/database.md` | 1255 |
| `docs/audits/packages/integrations.md` | 1023 |
| `docs/audits/packages/node-catalog.md` | 389 |
| `docs/audits/packages/node-sdk.md` | 855 |
| `docs/audits/packages/nodes-core.md` | 619 |
| `docs/audits/packages/observability.md` | 642 |
| `docs/audits/packages/queue.md` | 668 |
| `docs/audits/packages/rate-limit.md` | 462 |
| `docs/audits/packages/workflow-engine.md` | 1127 |
| `docs/audits/packages/workflow-model.md` | 710 |
| `docs/ci-image-update-procedure.md` | 24 |
| `docs/code-audit.md` | 1625 |
| `docs/current-implementation-status.md` | 131 |
| `docs/implementation-progress.md` | 5294 |
| `docs/operations/compatibility-retirement-inventory.md` | 132 |
| `docs/operations/complexity-hotspot-retention.md` | 94 |
| `docs/operations/complexity-refactor-performance.md` | 69 |
| `docs/operations/credential-boundaries.md` | 26 |
| `docs/operations/database-function-readiness.md` | 68 |
| `docs/operations/dependency-updates.md` | 27 |
| `docs/operations/external-platform-contract.md` | 85 |
| `docs/operations/immutability-policy.md` | 26 |
| `docs/operations/observability-alerts.md` | 216 |
| `docs/operations/persisted-identifiers.md` | 34 |
| `docs/operations/phase-terminology-compatibility.md` | 82 |
| `docs/operations/production-data-policy.md` | 69 |
| `docs/operations/regional-recovery.md` | 50 |
| `docs/operations/release-security-gate.md` | 79 |
| `docs/operations/repository-governance.md` | 46 |
| `docs/operations/supported-export-surface.md` | 25 |
| `docs/operations/test-confidence.md` | 37 |
| `docs/operations/test-duplication-review.md` | 48 |
| `docs/repository-governance.md` | 38 |
| `docs/whole-repository-audit.md` | 1484 |
| `docs/workflow-platform-backend-plan.md` | 2436 |
| `docs/workflow-platform-backend-research.md` | 289 |

### infrastructure — 61 files

| Reviewed path (repository-relative) | Physical lines |
| --- | ---: |
| `infrastructure/complexity-baseline.json` | 211 |
| `infrastructure/create-image-provenance.mjs` | 78 |
| `infrastructure/create-image-provenance.test.mjs` | 40 |
| `infrastructure/ecs/autoscaling.json` | 65 |
| `infrastructure/ecs/database-connection-budget.json` | 54 |
| `infrastructure/ecs/external-platform-contract.json` | 132 |
| `infrastructure/ecs/render-task-definitions.mjs` | 106 |
| `infrastructure/ecs/run-release-job.sh` | 49 |
| `infrastructure/ecs/validate-database-connection-budget.mjs` | 126 |
| `infrastructure/ecs/validate-database-connection-budget.test.mjs` | 77 |
| `infrastructure/ecs/validate-deployment.mjs` | 349 |
| `infrastructure/ecs/validate-external-platform-evidence.mjs` | 401 |
| `infrastructure/ecs/validate-external-platform-evidence.test.mjs` | 275 |
| `infrastructure/ecs/validate-render.mjs` | 121 |
| `infrastructure/ecs/workloads.json` | 228 |
| `infrastructure/exercises/README.md` | 58 |
| `infrastructure/exercises/profiles/api-steady.json` | 25 |
| `infrastructure/exercises/profiles/large-fan-out.json` | 25 |
| `infrastructure/exercises/profiles/long-wait.json` | 25 |
| `infrastructure/exercises/profiles/noisy-tenant-control.json` | 25 |
| `infrastructure/exercises/profiles/noisy-tenant-load.json` | 25 |
| `infrastructure/exercises/profiles/webhook-burst.json` | 25 |
| `infrastructure/exercises/run-http-exercise.mjs` | 481 |
| `infrastructure/exercises/run-http-exercise.test.mjs` | 112 |
| `infrastructure/exercises/validate-exercises.mjs` | 47 |
| `infrastructure/install-git-hooks.mjs` | 34 |
| `infrastructure/merge-istanbul-coverage.mjs` | 75 |
| `infrastructure/merge-istanbul-coverage.test.mjs` | 32 |
| `infrastructure/minio/bootstrap-ledger.sh` | 7 |
| `infrastructure/minio/primary-ledger-policy.json` | 32 |
| `infrastructure/minio/recovery-ledger-policy.json` | 36 |
| `infrastructure/observability/compose.yaml` | 38 |
| `infrastructure/observability/grafana-dashboard.json` | 466 |
| `infrastructure/observability/grafana-dashboards.yaml` | 8 |
| `infrastructure/observability/grafana-datasource.yaml` | 8 |
| `infrastructure/observability/otel-collector.yaml` | 59 |
| `infrastructure/observability/pertexo-alerts.yaml` | 337 |
| `infrastructure/observability/prometheus.yaml` | 11 |
| `infrastructure/observability/validate-config.mjs` | 74 |
| `infrastructure/postgres/init/10-roles.sh` | 117 |
| `infrastructure/postgres/provision-operator-role.mjs` | 88 |
| `infrastructure/report-risk-coverage.mjs` | 395 |
| `infrastructure/report-risk-coverage.test.mjs` | 456 |
| `infrastructure/risk-coverage-reviews.json` | 5319 |
| `infrastructure/test-duplication-baseline.json` | 489 |
| `infrastructure/validate-complexity.mjs` | 221 |
| `infrastructure/validate-complexity.test.mjs` | 56 |
| `infrastructure/validate-database-schema.mjs` | 137 |
| `infrastructure/validate-database-schema.test.mjs` | 14 |
| `infrastructure/validate-documentation.mjs` | 236 |
| `infrastructure/validate-documentation.test.mjs` | 183 |
| `infrastructure/validate-iana-address-registry.mjs` | 60 |
| `infrastructure/validate-iana-address-registry.test.mjs` | 30 |
| `infrastructure/validate-image-pins.mjs` | 67 |
| `infrastructure/validate-image-pins.test.mjs` | 33 |
| `infrastructure/validate-runtime-major.mjs` | 164 |
| `infrastructure/validate-runtime-major.test.mjs` | 275 |
| `infrastructure/validate-test-duplication.mjs` | 165 |
| `infrastructure/validate-test-duplication.test.mjs` | 101 |
| `infrastructure/validate-vitest-gate-report.mjs` | 74 |
| `infrastructure/validate-vitest-gate-report.test.mjs` | 100 |

### packages/artifact-store — 30 files

| Reviewed path (repository-relative) | Physical lines |
| --- | ---: |
| `packages/artifact-store/package.json` | 29 |
| `packages/artifact-store/src/artifact-metadata.ts` | 20 |
| `packages/artifact-store/src/config-primitives.ts` | 32 |
| `packages/artifact-store/src/config.ts` | 91 |
| `packages/artifact-store/src/control-ledger-config.ts` | 115 |
| `packages/artifact-store/src/control-ledger.ts` | 1026 |
| `packages/artifact-store/src/dual-region-artifact-store.ts` | 365 |
| `packages/artifact-store/src/dual-region-control-ledger.ts` | 492 |
| `packages/artifact-store/src/index.ts` | 88 |
| `packages/artifact-store/src/object-store-telemetry.ts` | 283 |
| `packages/artifact-store/src/s3-client-contract.ts` | 125 |
| `packages/artifact-store/src/server-only.ts` | 5 |
| `packages/artifact-store/src/store.ts` | 985 |
| `packages/artifact-store/test/config.test.ts` | 101 |
| `packages/artifact-store/test/control-ledger-config.test.ts` | 119 |
| `packages/artifact-store/test/control-ledger-part-2.test.ts` | 422 |
| `packages/artifact-store/test/control-ledger.integration.test.ts` | 412 |
| `packages/artifact-store/test/control-ledger.test.ts` | 525 |
| `packages/artifact-store/test/dual-region-artifact-store.test.ts` | 322 |
| `packages/artifact-store/test/dual-region-control-ledger.test.ts` | 549 |
| `packages/artifact-store/test/object-store-telemetry.test.ts` | 217 |
| `packages/artifact-store/test/s3-client-contract.test-d.ts` | 40 |
| `packages/artifact-store/test/store.integration.test.ts` | 147 |
| `packages/artifact-store/test/store.test.ts` | 1019 |
| `packages/artifact-store/test/support/control-ledger.fixture.ts` | 291 |
| `packages/artifact-store/tsconfig.json` | 15 |
| `packages/artifact-store/tsconfig.test.json` | 12 |
| `packages/artifact-store/vitest.config.ts` | 9 |
| `packages/artifact-store/vitest.coverage.config.ts` | 16 |
| `packages/artifact-store/vitest.integration.config.ts` | 9 |

### packages/contracts — 47 files

| Reviewed path (repository-relative) | Physical lines |
| --- | ---: |
| `packages/contracts/artifacts/connections.client-schema.json` | 1150 |
| `packages/contracts/artifacts/connections.openapi.json` | 2107 |
| `packages/contracts/artifacts/identity-workspace.client-schema.json` | 339 |
| `packages/contracts/artifacts/identity-workspace.openapi.json` | 806 |
| `packages/contracts/artifacts/node-testing.client-schema.json` | 1083 |
| `packages/contracts/artifacts/node-testing.openapi.json` | 1371 |
| `packages/contracts/artifacts/schedules.client-schema.json` | 25 |
| `packages/contracts/artifacts/schedules.openapi.json` | 292 |
| `packages/contracts/artifacts/webhooks.client-schema.json` | 43 |
| `packages/contracts/artifacts/webhooks.openapi.json` | 434 |
| `packages/contracts/artifacts/workflow-authoring.client-schema.json` | 5799 |
| `packages/contracts/artifacts/workflow-authoring.openapi.json` | 6521 |
| `packages/contracts/artifacts/workflow-runs.client-schema.json` | 1014 |
| `packages/contracts/artifacts/workflow-runs.openapi.json` | 1440 |
| `packages/contracts/package.json` | 60 |
| `packages/contracts/redocly.yaml` | 11 |
| `packages/contracts/scripts/generate-artifacts.ts` | 42 |
| `packages/contracts/src/artifacts.ts` | 56 |
| `packages/contracts/src/connections.ts` | 365 |
| `packages/contracts/src/errors/api-problem.ts` | 285 |
| `packages/contracts/src/http/connections.ts` | 337 |
| `packages/contracts/src/http/failure-notification-destinations.ts` | 58 |
| `packages/contracts/src/http/http-field-value.ts` | 6 |
| `packages/contracts/src/http/identity-workspace.ts` | 83 |
| `packages/contracts/src/http/node-testing.ts` | 140 |
| `packages/contracts/src/http/schedules.ts` | 63 |
| `packages/contracts/src/http/webhooks.ts` | 68 |
| `packages/contracts/src/http/workflow-authoring.ts` | 169 |
| `packages/contracts/src/http/workflow-runs.ts` | 165 |
| `packages/contracts/src/identity-workspace.ts` | 226 |
| `packages/contracts/src/index.ts` | 44 |
| `packages/contracts/src/node-testing.ts` | 171 |
| `packages/contracts/src/openapi-primitives.ts` | 94 |
| `packages/contracts/src/schedules.ts` | 78 |
| `packages/contracts/src/schema-projection.ts` | 85 |
| `packages/contracts/src/webhooks.ts` | 130 |
| `packages/contracts/src/workflow-authoring.ts` | 326 |
| `packages/contracts/src/workflow-runs.ts` | 178 |
| `packages/contracts/test/contracts.test.ts` | 760 |
| `packages/contracts/test/failure-notification-destinations.test.ts` | 111 |
| `packages/contracts/test/package-contract.test.ts` | 58 |
| `packages/contracts/test/schedules.test.ts` | 67 |
| `packages/contracts/test/webhooks.test.ts` | 66 |
| `packages/contracts/tsconfig.json` | 21 |
| `packages/contracts/tsconfig.test.json` | 18 |
| `packages/contracts/vitest.config.ts` | 6 |
| `packages/contracts/vitest.coverage.config.ts` | 16 |

### packages/database — 373 files

| Reviewed path (repository-relative) | Physical lines |
| --- | ---: |
| `packages/database/migrations/0000_rls_probe.sql` | 34 |
| `packages/database/migrations/0001_queue_transport.sql` | 152 |
| `packages/database/migrations/0002_artifacts.sql` | 68 |
| `packages/database/migrations/0003_transport_security_audit.sql` | 34 |
| `packages/database/migrations/0004_execution_acceptance.sql` | 173 |
| `packages/database/migrations/0005_inbox_least_privilege.sql` | 4 |
| `packages/database/migrations/0006_execution_vocabulary.sql` | 38 |
| `packages/database/migrations/0007_execution_runtime.sql` | 251 |
| `packages/database/migrations/0008_identity_workspace.sql` | 230 |
| `packages/database/migrations/0009_oidc_login_transactions.sql` | 51 |
| `packages/database/migrations/0010_oidc_transaction_capacity.sql` | 74 |
| `packages/database/migrations/0011_workspace_creation_idempotency.sql` | 55 |
| `packages/database/migrations/0012_workflow_authoring.sql` | 247 |
| `packages/database/migrations/0013_published_workflow_execution.sql` | 51 |
| `packages/database/migrations/0014_execution_value_persistence.sql` | 30 |
| `packages/database/migrations/0015_coordinator_run_store.sql` | 42 |
| `packages/database/migrations/0016_engine_invocation_keys.sql` | 10 |
| `packages/database/migrations/0017_node_compatibility_releases.sql` | 224 |
| `packages/database/migrations/0018_phase3_core_executor_non_removal.sql` | 54 |
| `packages/database/migrations/0019_node_compatibility_preactivation.sql` | 499 |
| `packages/database/migrations/0020_connections.sql` | 205 |
| `packages/database/migrations/0021_workflow_integration_usage.sql` | 62 |
| `packages/database/migrations/0022_preview_execution.sql` | 283 |
| `packages/database/migrations/0023_preview_artifact_ownership.sql` | 81 |
| `packages/database/migrations/0024_preview_retention_cleanup.sql` | 141 |
| `packages/database/migrations/0025_preview_cleanup_idempotency.sql` | 89 |
| `packages/database/migrations/0026_preview_cleanup_terminal_guard.sql` | 92 |
| `packages/database/migrations/0027_preview_terminal_facts.sql` | 142 |
| `packages/database/migrations/0028_preview_terminal_fact_corrections.sql` | 89 |
| `packages/database/migrations/0029_provider_idempotency_key_invariants.sql` | 18 |
| `packages/database/migrations/0030_coordinator_retry_decisions.sql` | 30 |
| `packages/database/migrations/0031_due_node_wakeups.sql` | 90 |
| `packages/database/migrations/0032_for_each_barriers.sql` | 27 |
| `packages/database/migrations/0033_durable_wait.sql` | 110 |
| `packages/database/migrations/0034_run_failure_notifications.sql` | 223 |
| `packages/database/migrations/0035_slack_bot_token_connections.sql` | 4 |
| `packages/database/migrations/0036_resend_api_key_connections.sql` | 82 |
| `packages/database/migrations/0037_failure_notification_destinations.sql` | 496 |
| `packages/database/migrations/0038_execution_admission.sql` | 639 |
| `packages/database/migrations/0039_webhook_triggers.sql` | 254 |
| `packages/database/migrations/0040_schedule_triggers.sql` | 208 |
| `packages/database/migrations/0041_trigger_hardening.sql` | 219 |
| `packages/database/migrations/0042_worker_run_admission_lock.sql` | 52 |
| `packages/database/migrations/0043_workflow_run_input_retention.sql` | 20 |
| `packages/database/migrations/0044_retention_control_foundation.sql` | 559 |
| `packages/database/migrations/0045_control_ledger_command_lock.sql` | 73 |
| `packages/database/migrations/0046_workspace_deletion_control_projection.sql` | 270 |
| `packages/database/migrations/0047_workspace_lifecycle_command_intents.sql` | 387 |
| `packages/database/migrations/0048_workspace_lifecycle_command_hardening.sql` | 304 |
| `packages/database/migrations/0049_workspace_deletion_side_effects.sql` | 187 |
| `packages/database/migrations/0050_workspace_lifecycle_api_authority.sql` | 7 |
| `packages/database/migrations/0051_workflow_run_input_retention_dry_run.sql` | 133 |
| `packages/database/migrations/0052_workflow_run_input_retention_enforcement.sql` | 263 |
| `packages/database/migrations/0053_preview_retention_enforcement.sql` | 269 |
| `packages/database/migrations/0054_workflow_run_input_retention_scheduling.sql` | 100 |
| `packages/database/migrations/0055_standard_retention_classes.sql` | 632 |
| `packages/database/migrations/0056_workspace_purge_foundation.sql` | 310 |
| `packages/database/migrations/0057_workspace_tenant_rows_purge.sql` | 355 |
| `packages/database/migrations/0058_workspace_object_versions_purge.sql` | 191 |
| `packages/database/migrations/0059_workspace_purge_completion.sql` | 304 |
| `packages/database/migrations/0060_standard_retention_dry_run.sql` | 333 |
| `packages/database/migrations/0061_operator_outbox_redispatch.sql` | 230 |
| `packages/database/migrations/0062_operator_command_ledger.sql` | 116 |
| `packages/database/migrations/0063_operator_execution_recovery.sql` | 346 |
| `packages/database/migrations/0064_operator_trigger_reconciliation.sql` | 138 |
| `packages/database/migrations/0065_operator_run_replay.sql` | 318 |
| `packages/database/migrations/0066_operator_maintenance_rerun.sql` | 230 |
| `packages/database/migrations/0067_reconcile_published_migration_repairs.sql` | 523 |
| `packages/database/migrations/0068_restore_artifact_inventory.sql` | 43 |
| `packages/database/migrations/0069_regional_write_admission.sql` | 79 |
| `packages/database/migrations/0070_preview_execution_deadline.sql` | 61 |
| `packages/database/migrations/0071_oidc_browser_binding.sql` | 15 |
| `packages/database/migrations/0072_regional_replica_identity.sql` | 86 |
| `packages/database/migrations/0073_transient_data_retention.sql` | 119 |
| `packages/database/migrations/0074_retention_schedule_state_rls.sql` | 20 |
| `packages/database/migrations/0075_workspace_purge_step_release.sql` | 25 |
| `packages/database/migrations/migration-execution-plan.json` | 5 |
| `packages/database/package.json` | 58 |
| `packages/database/raw-sql-table-registry.json` | 140 |
| `packages/database/src/api.ts` | 101 |
| `packages/database/src/authoring/testing.ts` | 26 |
| `packages/database/src/authoring/workflow-authoring-drafts.ts` | 248 |
| `packages/database/src/authoring/workflow-authoring-errors.ts` | 17 |
| `packages/database/src/authoring/workflow-authoring-reads.ts` | 171 |
| `packages/database/src/authoring/workflow-authoring-rows.ts` | 133 |
| `packages/database/src/authoring/workflow-authoring.ts` | 626 |
| `packages/database/src/authoring/workflow-publication.ts` | 477 |
| `packages/database/src/authoring/workflow-trigger-reconciliation.ts` | 29 |
| `packages/database/src/compatibility/compatibility-release-maintenance.ts` | 222 |
| `packages/database/src/compatibility/compatibility-release-readiness.ts` | 47 |
| `packages/database/src/compatibility/compatibility-release.ts` | 254 |
| `packages/database/src/compatibility/persisted-workflow-checkpoint.ts` | 473 |
| `packages/database/src/compatibility/testing.ts` | 20 |
| `packages/database/src/config.ts` | 210 |
| `packages/database/src/connections/connection-health-persistence.ts` | 113 |
| `packages/database/src/connections/connection-management-persistence.ts` | 325 |
| `packages/database/src/connections/connection-persistence.ts` | 650 |
| `packages/database/src/connections/connection-resolution-persistence.ts` | 106 |
| `packages/database/src/connections/connection-secret-persistence.ts` | 308 |
| `packages/database/src/connections/connection-test-persistence.ts` | 475 |
| `packages/database/src/connections/connections.ts` | 108 |
| `packages/database/src/connections/testing.ts` | 51 |
| `packages/database/src/connections/workflow-integration-usage.ts` | 166 |
| `packages/database/src/database.ts` | 70 |
| `packages/database/src/execution.ts` | 118 |
| `packages/database/src/execution/artifacts.ts` | 435 |
| `packages/database/src/execution/coordinator-run-store-commit-state.ts` | 286 |
| `packages/database/src/execution/coordinator-run-store-commit.ts` | 193 |
| `packages/database/src/execution/coordinator-run-store-contract.ts` | 116 |
| `packages/database/src/execution/coordinator-run-store-delivery.ts` | 262 |
| `packages/database/src/execution/coordinator-run-store-execution.ts` | 480 |
| `packages/database/src/execution/coordinator-run-store-fact-physical-state.ts` | 98 |
| `packages/database/src/execution/coordinator-run-store-observations.ts` | 725 |
| `packages/database/src/execution/coordinator-run-store-physical-state.ts` | 262 |
| `packages/database/src/execution/coordinator-run-store-plan-validation.ts` | 223 |
| `packages/database/src/execution/coordinator-run-store-plan.ts` | 443 |
| `packages/database/src/execution/coordinator-run-store-run-transition.ts` | 120 |
| `packages/database/src/execution/coordinator-run-store-settlement.ts` | 95 |
| `packages/database/src/execution/coordinator-run-store-status-validation.ts` | 396 |
| `packages/database/src/execution/coordinator-run-store-terminal.ts` | 179 |
| `packages/database/src/execution/coordinator-run-store-transactions.ts` | 33 |
| `packages/database/src/execution/coordinator-run-store-validation-values.ts` | 13 |
| `packages/database/src/execution/coordinator-run-store.ts` | 49 |
| `packages/database/src/execution/deadline-wakeup-scanner.ts` | 29 |
| `packages/database/src/execution/dispatcher-rows.ts` | 50 |
| `packages/database/src/execution/dispatcher.ts` | 511 |
| `packages/database/src/execution/due-node-wakeup-scanner.ts` | 29 |
| `packages/database/src/execution/execution-acceptance.ts` | 545 |
| `packages/database/src/execution/execution-state.ts` | 11 |
| `packages/database/src/execution/failure-notification-completion-store.ts` | 153 |
| `packages/database/src/execution/failure-notification-destination-errors.ts` | 12 |
| `packages/database/src/execution/failure-notification-destination-store.ts` | 197 |
| `packages/database/src/execution/failure-notification-destinations.ts` | 636 |
| `packages/database/src/execution/failure-notification-errors.ts` | 3 |
| `packages/database/src/execution/failure-notification-store-support.ts` | 77 |
| `packages/database/src/execution/failure-notifications.ts` | 300 |
| `packages/database/src/execution/inbox.ts` | 122 |
| `packages/database/src/execution/node-attempt-run-store-claim.ts` | 281 |
| `packages/database/src/execution/node-attempt-run-store-completion.ts` | 160 |
| `packages/database/src/execution/node-attempt-run-store-contract.ts` | 372 |
| `packages/database/src/execution/node-attempt-run-store-delivery.ts` | 141 |
| `packages/database/src/execution/node-attempt-run-store-dispatch.ts` | 133 |
| `packages/database/src/execution/node-attempt-run-store-heartbeat.ts` | 90 |
| `packages/database/src/execution/node-attempt-run-store-inputs.ts` | 325 |
| `packages/database/src/execution/node-attempt-run-store-outcomes.ts` | 368 |
| `packages/database/src/execution/node-attempt-run-store-transactions.ts` | 53 |
| `packages/database/src/execution/node-attempt-run-store.ts` | 66 |
| `packages/database/src/execution/outbox.ts` | 99 |
| `packages/database/src/execution/preview-execution-acceptance.ts` | 562 |
| `packages/database/src/execution/preview-execution-claim.ts` | 311 |
| `packages/database/src/execution/preview-execution-completion.ts` | 248 |
| `packages/database/src/execution/preview-execution-contract.ts` | 135 |
| `packages/database/src/execution/preview-execution-delivery.ts` | 276 |
| `packages/database/src/execution/preview-execution-dispatch.ts` | 130 |
| `packages/database/src/execution/preview-execution-heartbeat.ts` | 80 |
| `packages/database/src/execution/preview-execution-reconciliation.ts` | 486 |
| `packages/database/src/execution/preview-execution.ts` | 57 |
| `packages/database/src/execution/published-workflow-reader.ts` | 220 |
| `packages/database/src/execution/run-events.ts` | 195 |
| `packages/database/src/execution/stored-execution-value.ts` | 361 |
| `packages/database/src/execution/testing.ts` | 192 |
| `packages/database/src/execution/unknown-outcome-reconciliation.ts` | 129 |
| `packages/database/src/execution/workflow-run-api.ts` | 519 |
| `packages/database/src/execution/workflow-run-cancellation.ts` | 90 |
| `packages/database/src/lifecycle.ts` | 4 |
| `packages/database/src/lifecycle/control-ledger-coordinator.ts` | 1185 |
| `packages/database/src/lifecycle/preview-cleanup.ts` | 547 |
| `packages/database/src/lifecycle/preview-retention.ts` | 286 |
| `packages/database/src/lifecycle/retention-transaction.ts` | 76 |
| `packages/database/src/lifecycle/retention.ts` | 791 |
| `packages/database/src/lifecycle/run-artifact-retention.ts` | 234 |
| `packages/database/src/lifecycle/testing.ts` | 82 |
| `packages/database/src/lifecycle/transient-data-retention.ts` | 39 |
| `packages/database/src/lifecycle/workspace-lifecycle-commands.ts` | 585 |
| `packages/database/src/lifecycle/workspace-purge.ts` | 853 |
| `packages/database/src/maintenance.ts` | 33 |
| `packages/database/src/migrate.ts` | 16 |
| `packages/database/src/migration-execution-plan.ts` | 111 |
| `packages/database/src/migrations.ts` | 393 |
| `packages/database/src/operator.ts` | 11 |
| `packages/database/src/operator/operator-command-errors.ts` | 6 |
| `packages/database/src/operator/operator-command-runtime.ts` | 244 |
| `packages/database/src/operator/operator-commands.ts` | 431 |
| `packages/database/src/operator/operator-run-replay.ts` | 234 |
| `packages/database/src/operator/testing.ts` | 25 |
| `packages/database/src/platform/database-runtime.ts` | 82 |
| `packages/database/src/platform/persisted-id.ts` | 6 |
| `packages/database/src/platform/postgres-pool-policy.ts` | 110 |
| `packages/database/src/platform/postgres-telemetry.ts` | 605 |
| `packages/database/src/platform/readiness-probe-1.sql.ts` | 375 |
| `packages/database/src/platform/readiness-probe-2.sql.ts` | 396 |
| `packages/database/src/platform/readiness-probe-3.sql.ts` | 436 |
| `packages/database/src/platform/readiness-probe-4.sql.ts` | 389 |
| `packages/database/src/platform/readiness-probe-sql.ts` | 11 |
| `packages/database/src/platform/readiness-probe.ts` | 209 |
| `packages/database/src/platform/readiness.ts` | 357 |
| `packages/database/src/recovery.ts` | 7 |
| `packages/database/src/schema.ts` | 165 |
| `packages/database/src/schema/app-schema.ts` | 3 |
| `packages/database/src/schema/authoring.ts` | 213 |
| `packages/database/src/schema/compatibility.ts` | 186 |
| `packages/database/src/schema/connections.ts` | 127 |
| `packages/database/src/schema/execution-support.ts` | 124 |
| `packages/database/src/schema/execution.ts` | 408 |
| `packages/database/src/schema/foundation.ts` | 269 |
| `packages/database/src/schema/retention.ts` | 291 |
| `packages/database/src/schema/transport.ts` | 152 |
| `packages/database/src/schema/triggers.ts` | 221 |
| `packages/database/src/tenant-access/identity-workspace-errors.ts` | 33 |
| `packages/database/src/tenant-access/identity-workspace-identity-store.ts` | 261 |
| `packages/database/src/tenant-access/identity-workspace-rows.ts` | 158 |
| `packages/database/src/tenant-access/identity-workspace-session-store.ts` | 111 |
| `packages/database/src/tenant-access/identity-workspace-support.ts` | 78 |
| `packages/database/src/tenant-access/identity-workspace.ts` | 593 |
| `packages/database/src/tenant-access/oidc-login-transactions.ts` | 255 |
| `packages/database/src/tenant-access/testing.ts` | 55 |
| `packages/database/src/tenant-access/workspace.ts` | 315 |
| `packages/database/src/testing.ts` | 85 |
| `packages/database/src/triggers/schedule-recurrence.ts` | 212 |
| `packages/database/src/triggers/schedule-trigger-errors.ts` | 12 |
| `packages/database/src/triggers/schedule-triggers.ts` | 673 |
| `packages/database/src/triggers/testing.ts` | 41 |
| `packages/database/src/triggers/webhook-triggers.ts` | 668 |
| `packages/database/src/triggers/workflow-trigger-projection.ts` | 109 |
| `packages/database/src/triggers/workflow-triggers.ts` | 505 |
| `packages/database/src/validation/persisted-primitives.ts` | 4 |
| `packages/database/test/artifacts.integration.test.ts` | 365 |
| `packages/database/test/baseline-compatibility-fixture.ts` | 21 |
| `packages/database/test/compatibility-release.integration.test.ts` | 743 |
| `packages/database/test/compatibility-release.test.ts` | 145 |
| `packages/database/test/config.test.ts` | 187 |
| `packages/database/test/connection-tests.integration.test.ts` | 371 |
| `packages/database/test/connections-compatibility.integration.test.ts` | 509 |
| `packages/database/test/connections-concurrency-security.integration.test.ts` | 253 |
| `packages/database/test/connections-lifecycle.integration.test.ts` | 493 |
| `packages/database/test/control-ledger-command-lock-migration.test.ts` | 30 |
| `packages/database/test/control-ledger-coordinator-part-2.integration.test.ts` | 380 |
| `packages/database/test/control-ledger-coordinator.integration.test.ts` | 407 |
| `packages/database/test/control-ledger-coordinator.test.ts` | 797 |
| `packages/database/test/coordinator-retry-migration.test.ts` | 31 |
| `packages/database/test/coordinator-run-store-cas.integration.test.ts` | 855 |
| `packages/database/test/coordinator-run-store-commit-output.integration.test.ts` | 928 |
| `packages/database/test/coordinator-run-store-foreach.integration.test.ts` | 594 |
| `packages/database/test/coordinator-run-store-migrations.integration.test.ts` | 566 |
| `packages/database/test/coordinator-run-store-node-attempts.integration.test.ts` | 904 |
| `packages/database/test/coordinator-run-store-observations.integration.test.ts` | 1065 |
| `packages/database/test/coordinator-run-store-pending-failures.integration.test.ts` | 146 |
| `packages/database/test/coordinator-run-store-scheduling.integration.test.ts` | 753 |
| `packages/database/test/coordinator-run-store-wakeups.integration.test.ts` | 198 |
| `packages/database/test/coordinator-run-store.fixtures.ts` | 702 |
| `packages/database/test/coordinator-run-store.test.ts` | 119 |
| `packages/database/test/database-runtime.integration.test.ts` | 104 |
| `packages/database/test/database-runtime.test.ts` | 66 |
| `packages/database/test/due-node-wakeup-migration.test.ts` | 30 |
| `packages/database/test/durable-wait-migration.test.ts` | 40 |
| `packages/database/test/execution-acceptance-capacity.integration.test.ts` | 470 |
| `packages/database/test/execution-acceptance-lifecycle.integration.test.ts` | 159 |
| `packages/database/test/execution-acceptance-notifications.integration.test.ts` | 398 |
| `packages/database/test/execution-acceptance-persistence.integration.test.ts` | 416 |
| `packages/database/test/execution-acceptance-regional.integration.test.ts` | 93 |
| `packages/database/test/execution-acceptance-security.integration.test.ts` | 383 |
| `packages/database/test/execution-acceptance.fixtures.ts` | 439 |
| `packages/database/test/execution-acceptance.test.ts` | 46 |
| `packages/database/test/execution-admission-migration.test.ts` | 61 |
| `packages/database/test/execution-value-persistence.integration.test.ts` | 488 |
| `packages/database/test/execution-value-persistence.test.ts` | 47 |
| `packages/database/test/fixtures/queue-duplicate-proof.sql` | 130 |
| `packages/database/test/for-each-barrier-migration.test.ts` | 22 |
| `packages/database/test/identity-workspace.integration.test.ts` | 898 |
| `packages/database/test/migration-checksum-compatibility.test.ts` | 60 |
| `packages/database/test/migration-execution-modes.integration.test.ts` | 194 |
| `packages/database/test/migration-execution-plan.test.ts` | 78 |
| `packages/database/test/node-attempt-run-store.test.ts` | 72 |
| `packages/database/test/oidc-browser-binding-migration.integration.test.ts` | 123 |
| `packages/database/test/oidc-browser-binding-migration.test.ts` | 25 |
| `packages/database/test/operator-command-ledger-migration.test.ts` | 23 |
| `packages/database/test/operator-execution-recovery-migration.test.ts` | 40 |
| `packages/database/test/operator-maintenance-rerun-migration.test.ts` | 28 |
| `packages/database/test/operator-outbox-redispatch-migration.test.ts` | 37 |
| `packages/database/test/operator-run-replay-migration.test.ts` | 27 |
| `packages/database/test/operator-trigger-reconciliation-migration.test.ts` | 27 |
| `packages/database/test/package-contract.test.ts` | 186 |
| `packages/database/test/persisted-id.test.ts` | 13 |
| `packages/database/test/persisted-workflow-checkpoint.test.ts` | 323 |
| `packages/database/test/postgres-telemetry.integration.test.ts` | 123 |
| `packages/database/test/postgres-telemetry.test.ts` | 433 |
| `packages/database/test/preview-execution-deadline-migration.integration.test.ts` | 133 |
| `packages/database/test/preview-execution-deadline-migration.test.ts` | 35 |
| `packages/database/test/preview-execution.integration.test.ts` | 630 |
| `packages/database/test/preview-retention-enforcement-migration.test.ts` | 37 |
| `packages/database/test/preview-retention-migration.integration.test.ts` | 334 |
| `packages/database/test/preview-worker-artifact-retention.integration.test.ts` | 321 |
| `packages/database/test/preview-worker-attempt-lifecycle.integration.test.ts` | 455 |
| `packages/database/test/preview-worker-reconciliation.integration.test.ts` | 448 |
| `packages/database/test/preview-worker-schema.integration.test.ts` | 120 |
| `packages/database/test/published-migration-repair.integration.test.ts` | 144 |
| `packages/database/test/published-migration-repair.test.ts` | 32 |
| `packages/database/test/published-workflow-reader.integration.test.ts` | 408 |
| `packages/database/test/published-workflow-reader.test.ts` | 39 |
| `packages/database/test/readiness-probe.test.ts` | 113 |
| `packages/database/test/regional-replica-identity-migration.test.ts` | 32 |
| `packages/database/test/regional-write-admission-migration.test.ts` | 27 |
| `packages/database/test/regional-write-admission.integration.test.ts` | 237 |
| `packages/database/test/restore-artifact-inventory-migration.test.ts` | 29 |
| `packages/database/test/retention-artifacts.integration.test.ts` | 227 |
| `packages/database/test/retention-control-foundation-migration.integration.test.ts` | 733 |
| `packages/database/test/retention-control-foundation-migration.test.ts` | 37 |
| `packages/database/test/retention-execution-purge.integration.test.ts` | 611 |
| `packages/database/test/retention-inventory.integration.test.ts` | 228 |
| `packages/database/test/retention-legal-hold.integration.test.ts` | 208 |
| `packages/database/test/retention-operator.integration.test.ts` | 142 |
| `packages/database/test/retention-schedule-state-rls-migration.test.ts` | 31 |
| `packages/database/test/retention-scheduling.integration.test.ts` | 156 |
| `packages/database/test/rls.integration.test.ts` | 534 |
| `packages/database/test/run-events.integration.test.ts` | 225 |
| `packages/database/test/schedule-recurrence.test.ts` | 110 |
| `packages/database/test/schedule-trigger-migration.test.ts` | 40 |
| `packages/database/test/schedule-triggers-part-2.integration.test.ts` | 388 |
| `packages/database/test/schedule-triggers.integration.test.ts` | 421 |
| `packages/database/test/schema-shape.integration.test.ts` | 193 |
| `packages/database/test/serving-readiness.test.ts` | 38 |
| `packages/database/test/standard-retention-classes-migration.test.ts` | 38 |
| `packages/database/test/standard-retention-dry-run-migration.test.ts` | 44 |
| `packages/database/test/stored-execution-value.test.ts` | 362 |
| `packages/database/test/support/connections.integration.support.ts` | 396 |
| `packages/database/test/support/control-ledger-coordinator.integration.support.ts` | 313 |
| `packages/database/test/support/disposable-database.ts` | 78 |
| `packages/database/test/support/preview-worker-fixture.ts` | 431 |
| `packages/database/test/support/retention.integration.support.ts` | 184 |
| `packages/database/test/support/schedule-triggers.integration.support.ts` | 319 |
| `packages/database/test/support/transport.integration.support.ts` | 172 |
| `packages/database/test/support/workflow-authoring.integration.support.ts` | 316 |
| `packages/database/test/tenant-context-hygiene.integration.test.ts` | 240 |
| `packages/database/test/transient-data-retention-migration.test.ts` | 35 |
| `packages/database/test/transient-data-retention.integration.test.ts` | 146 |
| `packages/database/test/transport-part-2.integration.test.ts` | 337 |
| `packages/database/test/transport.integration.test.ts` | 773 |
| `packages/database/test/transport.test.ts` | 94 |
| `packages/database/test/webhook-trigger-migration.test.ts` | 35 |
| `packages/database/test/webhook-trigger-prior-head.integration.test.ts` | 110 |
| `packages/database/test/webhook-triggers.integration.test.ts` | 596 |
| `packages/database/test/workflow-authoring-atomicity.integration.test.ts` | 282 |
| `packages/database/test/workflow-authoring-coordination.integration.test.ts` | 415 |
| `packages/database/test/workflow-authoring-drafts.integration.test.ts` | 415 |
| `packages/database/test/workflow-authoring-publication.integration.test.ts` | 483 |
| `packages/database/test/workflow-authoring-readiness.integration.test.ts` | 102 |
| `packages/database/test/workflow-authoring.test.ts` | 133 |
| `packages/database/test/workflow-run-api.integration.test.ts` | 295 |
| `packages/database/test/workflow-run-input-retention-dry-run-migration.test.ts` | 23 |
| `packages/database/test/workflow-run-input-retention-enforcement-migration.test.ts` | 31 |
| `packages/database/test/workflow-run-input-retention-migration.integration.test.ts` | 176 |
| `packages/database/test/workflow-run-input-retention-migration.test.ts` | 20 |
| `packages/database/test/workflow-run-input-retention-scheduling-migration.test.ts` | 28 |
| `packages/database/test/workflow-trigger-projection.test.ts` | 136 |
| `packages/database/test/workspace-deletion-control-projection-migration.test.ts` | 45 |
| `packages/database/test/workspace-deletion-side-effects-migration.test.ts` | 33 |
| `packages/database/test/workspace-lifecycle-api-authority-migration.test.ts` | 21 |
| `packages/database/test/workspace-lifecycle-command-hardening-migration.test.ts` | 26 |
| `packages/database/test/workspace-lifecycle-command-intents-migration.test.ts` | 33 |
| `packages/database/test/workspace-lifecycle-command-intents.integration.test.ts` | 731 |
| `packages/database/test/workspace-object-versions-purge-migration.test.ts` | 42 |
| `packages/database/test/workspace-purge-completion-migration.test.ts` | 49 |
| `packages/database/test/workspace-purge-foundation-migration.test.ts` | 42 |
| `packages/database/test/workspace-purge-foundation.integration.test.ts` | 701 |
| `packages/database/test/workspace-purge-step-release-migration.test.ts` | 28 |
| `packages/database/test/workspace-tenant-rows-purge-migration.test.ts` | 39 |
| `packages/database/test/workspace-transaction-engine.test.ts` | 619 |
| `packages/database/tsconfig.json` | 14 |
| `packages/database/tsconfig.test.json` | 12 |
| `packages/database/vitest.config.ts` | 8 |
| `packages/database/vitest.coverage.config.ts` | 24 |
| `packages/database/vitest.integration-coverage.config.ts` | 22 |
| `packages/database/vitest.integration.config.ts` | 10 |

### packages/integrations — 42 files

| Reviewed path (repository-relative) | Physical lines |
| --- | ---: |
| `packages/integrations/package.json` | 35 |
| `packages/integrations/src/credentials/aws-envelope-runtime.ts` | 39 |
| `packages/integrations/src/credentials/envelope-encryption.ts` | 181 |
| `packages/integrations/src/credentials/kms-client.ts` | 27 |
| `packages/integrations/src/crypto/envelope-cipher.ts` | 409 |
| `packages/integrations/src/email/client.ts` | 126 |
| `packages/integrations/src/email/definition.ts` | 55 |
| `packages/integrations/src/email/executor.ts` | 285 |
| `packages/integrations/src/email/index.ts` | 17 |
| `packages/integrations/src/email/validation.ts` | 104 |
| `packages/integrations/src/http-request/definition.ts` | 66 |
| `packages/integrations/src/http-request/executor.ts` | 421 |
| `packages/integrations/src/http-request/index.ts` | 22 |
| `packages/integrations/src/http-request/validation.ts` | 236 |
| `packages/integrations/src/http/address-policy.ts` | 122 |
| `packages/integrations/src/http/header-value.ts` | 6 |
| `packages/integrations/src/http/iana-address-policy-snapshot.ts` | 42 |
| `packages/integrations/src/http/node-transport.ts` | 80 |
| `packages/integrations/src/http/outcome-policy.ts` | 176 |
| `packages/integrations/src/http/secure-http.ts` | 911 |
| `packages/integrations/src/index.ts` | 3 |
| `packages/integrations/src/provider-dispatch-fence.ts` | 56 |
| `packages/integrations/src/server-only.ts` | 4 |
| `packages/integrations/src/server.ts` | 98 |
| `packages/integrations/src/slack/client.ts` | 205 |
| `packages/integrations/src/slack/definition.ts` | 55 |
| `packages/integrations/src/slack/executor.ts` | 253 |
| `packages/integrations/src/slack/index.ts` | 18 |
| `packages/integrations/src/slack/validation.ts` | 66 |
| `packages/integrations/src/webhooks/crypto.ts` | 232 |
| `packages/integrations/test/email-send-notification.test.ts` | 813 |
| `packages/integrations/test/envelope-encryption.test.ts` | 204 |
| `packages/integrations/test/http-outcome-policy.test.ts` | 193 |
| `packages/integrations/test/http-request.test.ts` | 887 |
| `packages/integrations/test/package-contract.test.ts` | 37 |
| `packages/integrations/test/secure-http.test.ts` | 949 |
| `packages/integrations/test/slack-send-message.test.ts` | 609 |
| `packages/integrations/test/webhook-crypto.test.ts` | 203 |
| `packages/integrations/tsconfig.json` | 15 |
| `packages/integrations/tsconfig.test.json` | 13 |
| `packages/integrations/vitest.config.ts` | 9 |
| `packages/integrations/vitest.coverage.config.ts` | 16 |

### packages/node-catalog — 15 files

| Reviewed path (repository-relative) | Physical lines |
| --- | ---: |
| `packages/node-catalog/package.json` | 34 |
| `packages/node-catalog/src/definition-resolution.ts` | 61 |
| `packages/node-catalog/src/index.ts` | 5 |
| `packages/node-catalog/src/registry.ts` | 617 |
| `packages/node-catalog/src/server-only.ts` | 4 |
| `packages/node-catalog/src/server.ts` | 182 |
| `packages/node-catalog/test/definition-resolution.test.ts` | 35 |
| `packages/node-catalog/test/package-contract.test.ts` | 41 |
| `packages/node-catalog/test/release-history.golden.ts` | 39 |
| `packages/node-catalog/test/release-history.test.ts` | 1010 |
| `packages/node-catalog/test/server-registry.test.ts` | 220 |
| `packages/node-catalog/tsconfig.json` | 21 |
| `packages/node-catalog/tsconfig.test.json` | 17 |
| `packages/node-catalog/vitest.config.ts` | 6 |
| `packages/node-catalog/vitest.coverage.config.ts` | 21 |

### packages/node-sdk — 16 files

| Reviewed path (repository-relative) | Physical lines |
| --- | ---: |
| `packages/node-sdk/package.json` | 38 |
| `packages/node-sdk/src/compatibility-canonical.ts` | 245 |
| `packages/node-sdk/src/executor-contracts.ts` | 143 |
| `packages/node-sdk/src/executor-errors.ts` | 178 |
| `packages/node-sdk/src/identity.ts` | 30 |
| `packages/node-sdk/src/index.ts` | 1 |
| `packages/node-sdk/src/json-boundary.ts` | 178 |
| `packages/node-sdk/src/release.ts` | 707 |
| `packages/node-sdk/src/server-only.ts` | 4 |
| `packages/node-sdk/src/server.ts` | 528 |
| `packages/node-sdk/test/package-contract.test.ts` | 65 |
| `packages/node-sdk/test/registry.test.ts` | 1131 |
| `packages/node-sdk/tsconfig.json` | 21 |
| `packages/node-sdk/tsconfig.test.json` | 12 |
| `packages/node-sdk/vitest.config.ts` | 6 |
| `packages/node-sdk/vitest.coverage.config.ts` | 16 |

### packages/nodes-core — 62 files

| Reviewed path (repository-relative) | Physical lines |
| --- | ---: |
| `packages/nodes-core/package.json` | 34 |
| `packages/nodes-core/src/condition/definition.ts` | 43 |
| `packages/nodes-core/src/condition/executor.ts` | 27 |
| `packages/nodes-core/src/condition/index.ts` | 2 |
| `packages/nodes-core/src/condition/validation.ts` | 9 |
| `packages/nodes-core/src/definitions.ts` | 186 |
| `packages/nodes-core/src/for-each/definition.ts` | 40 |
| `packages/nodes-core/src/for-each/executor.ts` | 26 |
| `packages/nodes-core/src/for-each/index.ts` | 2 |
| `packages/nodes-core/src/for-each/validation.ts` | 38 |
| `packages/nodes-core/src/index.ts` | 14 |
| `packages/nodes-core/src/manual/definition.ts` | 40 |
| `packages/nodes-core/src/manual/executor.ts` | 17 |
| `packages/nodes-core/src/manual/index.ts` | 2 |
| `packages/nodes-core/src/manual/validation.ts` | 6 |
| `packages/nodes-core/src/merge/definition.ts` | 92 |
| `packages/nodes-core/src/merge/executor.ts` | 36 |
| `packages/nodes-core/src/merge/index.ts` | 2 |
| `packages/nodes-core/src/merge/validation.ts` | 109 |
| `packages/nodes-core/src/parallel/definition.ts` | 88 |
| `packages/nodes-core/src/parallel/executor.ts` | 41 |
| `packages/nodes-core/src/parallel/index.ts` | 2 |
| `packages/nodes-core/src/parallel/validation.ts` | 76 |
| `packages/nodes-core/src/policies.ts` | 9 |
| `packages/nodes-core/src/registrations.ts` | 96 |
| `packages/nodes-core/src/registry.ts` | 67 |
| `packages/nodes-core/src/schedule/definition.ts` | 87 |
| `packages/nodes-core/src/schedule/executor.ts` | 36 |
| `packages/nodes-core/src/schedule/index.ts` | 2 |
| `packages/nodes-core/src/schedule/validation.ts` | 125 |
| `packages/nodes-core/src/server-only.ts` | 4 |
| `packages/nodes-core/src/server.ts` | 99 |
| `packages/nodes-core/src/set/definition.ts` | 40 |
| `packages/nodes-core/src/set/executor.ts` | 20 |
| `packages/nodes-core/src/set/index.ts` | 2 |
| `packages/nodes-core/src/set/validation.ts` | 6 |
| `packages/nodes-core/src/switch/definition.ts` | 44 |
| `packages/nodes-core/src/switch/executor.ts` | 27 |
| `packages/nodes-core/src/switch/index.ts` | 2 |
| `packages/nodes-core/src/switch/validation.ts` | 68 |
| `packages/nodes-core/src/terminate/definition.ts` | 44 |
| `packages/nodes-core/src/terminate/executor.ts` | 20 |
| `packages/nodes-core/src/terminate/index.ts` | 2 |
| `packages/nodes-core/src/terminate/validation.ts` | 6 |
| `packages/nodes-core/src/wait/definition.ts` | 39 |
| `packages/nodes-core/src/wait/executor.ts` | 17 |
| `packages/nodes-core/src/wait/index.ts` | 2 |
| `packages/nodes-core/src/wait/validation.ts` | 18 |
| `packages/nodes-core/src/webhook/definition.ts` | 39 |
| `packages/nodes-core/src/webhook/executor.ts` | 20 |
| `packages/nodes-core/src/webhook/index.ts` | 2 |
| `packages/nodes-core/src/webhook/validation.ts` | 7 |
| `packages/nodes-core/test/data-nodes.test.ts` | 155 |
| `packages/nodes-core/test/node-execution.test.ts` | 192 |
| `packages/nodes-core/test/orchestration-nodes.test.ts` | 253 |
| `packages/nodes-core/test/package-contract.test.ts` | 76 |
| `packages/nodes-core/test/retained-registry.test.ts` | 213 |
| `packages/nodes-core/test/trigger-nodes.test.ts` | 77 |
| `packages/nodes-core/tsconfig.json` | 21 |
| `packages/nodes-core/tsconfig.test.json` | 12 |
| `packages/nodes-core/vitest.config.ts` | 6 |
| `packages/nodes-core/vitest.coverage.config.ts` | 16 |

### packages/observability — 25 files

| Reviewed path (repository-relative) | Physical lines |
| --- | ---: |
| `packages/observability/package.json` | 85 |
| `packages/observability/src/config.ts` | 67 |
| `packages/observability/src/index.ts` | 29 |
| `packages/observability/src/logger.ts` | 392 |
| `packages/observability/src/maintenance-metrics.ts` | 77 |
| `packages/observability/src/nest-runtime.ts` | 180 |
| `packages/observability/src/queue-tracing.ts` | 98 |
| `packages/observability/src/runtime.ts` | 23 |
| `packages/observability/src/server-only.ts` | 5 |
| `packages/observability/src/telemetry.ts` | 156 |
| `packages/observability/src/transport-metrics.ts` | 412 |
| `packages/observability/test/config.test.ts` | 57 |
| `packages/observability/test/logger.test.ts` | 283 |
| `packages/observability/test/maintenance-metrics.test.ts` | 62 |
| `packages/observability/test/nest-runtime.test.ts` | 177 |
| `packages/observability/test/operations-assets.test.ts` | 232 |
| `packages/observability/test/package-contract.test.ts` | 45 |
| `packages/observability/test/queue-tracing.test.ts` | 119 |
| `packages/observability/test/runtime.test.ts` | 44 |
| `packages/observability/test/telemetry.test.ts` | 122 |
| `packages/observability/test/transport-metrics.test.ts` | 355 |
| `packages/observability/tsconfig.json` | 14 |
| `packages/observability/tsconfig.test.json` | 12 |
| `packages/observability/vitest.config.ts` | 9 |
| `packages/observability/vitest.coverage.config.ts` | 16 |

### packages/queue — 30 files

| Reviewed path (repository-relative) | Physical lines |
| --- | ---: |
| `packages/queue/package.json` | 29 |
| `packages/queue/src/consumer.ts` | 682 |
| `packages/queue/src/contracts.ts` | 290 |
| `packages/queue/src/defaults.ts` | 95 |
| `packages/queue/src/index.ts` | 110 |
| `packages/queue/src/names.ts` | 38 |
| `packages/queue/src/producer.ts` | 466 |
| `packages/queue/src/redis-endpoint.ts` | 22 |
| `packages/queue/src/redis-telemetry-contracts.ts` | 172 |
| `packages/queue/src/redis-telemetry.ts` | 78 |
| `packages/queue/src/run-event-notifications.ts` | 207 |
| `packages/queue/src/server-only.ts` | 5 |
| `packages/queue/test/compatibility.test.ts` | 23 |
| `packages/queue/test/consumer.test.ts` | 602 |
| `packages/queue/test/contracts.test.ts` | 281 |
| `packages/queue/test/defaults.test.ts` | 40 |
| `packages/queue/test/fixtures/queue-jobs-v1.json` | 100 |
| `packages/queue/test/names.test.ts` | 54 |
| `packages/queue/test/package-contract.test.ts` | 36 |
| `packages/queue/test/producer.test.ts` | 363 |
| `packages/queue/test/public-surface.test.ts` | 54 |
| `packages/queue/test/redis-endpoint.test.ts` | 44 |
| `packages/queue/test/redis-telemetry.integration.test.ts` | 47 |
| `packages/queue/test/redis-telemetry.test.ts` | 106 |
| `packages/queue/test/run-event-notifications.test.ts` | 32 |
| `packages/queue/tsconfig.json` | 21 |
| `packages/queue/tsconfig.test.json` | 12 |
| `packages/queue/vitest.config.ts` | 9 |
| `packages/queue/vitest.coverage.config.ts` | 16 |
| `packages/queue/vitest.integration.config.ts` | 10 |

### packages/rate-limit — 12 files

| Reviewed path (repository-relative) | Physical lines |
| --- | ---: |
| `packages/rate-limit/package.json` | 22 |
| `packages/rate-limit/src/distributed-rate-limiter.ts` | 152 |
| `packages/rate-limit/src/index.ts` | 20 |
| `packages/rate-limit/src/policy.ts` | 200 |
| `packages/rate-limit/src/redis-runtime.ts` | 112 |
| `packages/rate-limit/test/distributed-rate-limiter.test.ts` | 134 |
| `packages/rate-limit/test/policy.test.ts` | 207 |
| `packages/rate-limit/test/redis-runtime.test.ts` | 176 |
| `packages/rate-limit/tsconfig.json` | 21 |
| `packages/rate-limit/tsconfig.test.json` | 17 |
| `packages/rate-limit/vitest.config.ts` | 5 |
| `packages/rate-limit/vitest.coverage.config.ts` | 21 |

### packages/workflow-engine — 75 files

| Reviewed path (repository-relative) | Physical lines |
| --- | ---: |
| `packages/workflow-engine/package.json` | 36 |
| `packages/workflow-engine/src/advance-workflow.ts` | 142 |
| `packages/workflow-engine/src/checkpoint-identity.ts` | 36 |
| `packages/workflow-engine/src/checkpoint-shared.ts` | 452 |
| `packages/workflow-engine/src/checkpoint-v1-join.ts` | 211 |
| `packages/workflow-engine/src/checkpoint-v1-loop.ts` | 233 |
| `packages/workflow-engine/src/checkpoint-v1.ts` | 275 |
| `packages/workflow-engine/src/checkpoint-v2.ts` | 143 |
| `packages/workflow-engine/src/checkpoint.ts` | 100 |
| `packages/workflow-engine/src/coordinator-failures.ts` | 106 |
| `packages/workflow-engine/src/coordinator-observations.ts` | 475 |
| `packages/workflow-engine/src/coordinator-output.ts` | 62 |
| `packages/workflow-engine/src/core-definition-identities.ts` | 41 |
| `packages/workflow-engine/src/errors.ts` | 24 |
| `packages/workflow-engine/src/executable-boundary.ts` | 138 |
| `packages/workflow-engine/src/executable-compatibility.ts` | 130 |
| `packages/workflow-engine/src/executable-compilation.ts` | 449 |
| `packages/workflow-engine/src/executable-foundation.ts` | 191 |
| `packages/workflow-engine/src/executable-graph-boundary.ts` | 260 |
| `packages/workflow-engine/src/executable-graph-validation-index.ts` | 70 |
| `packages/workflow-engine/src/executable-graph.ts` | 28 |
| `packages/workflow-engine/src/executable-validation.ts` | 284 |
| `packages/workflow-engine/src/executable-workflow.ts` | 30 |
| `packages/workflow-engine/src/graph-scheduler.ts` | 355 |
| `packages/workflow-engine/src/index.ts` | 51 |
| `packages/workflow-engine/src/node-attempt-input.ts` | 289 |
| `packages/workflow-engine/src/operation-values.ts` | 43 |
| `packages/workflow-engine/src/operations.ts` | 666 |
| `packages/workflow-engine/src/ordering.ts` | 2 |
| `packages/workflow-engine/src/persisted-observation-parser.ts` | 361 |
| `packages/workflow-engine/src/persisted-observations.ts` | 369 |
| `packages/workflow-engine/src/retries.ts` | 164 |
| `packages/workflow-engine/src/runtime.ts` | 72 |
| `packages/workflow-engine/src/scheduling.ts` | 257 |
| `packages/workflow-engine/src/scope.ts` | 40 |
| `packages/workflow-engine/src/server-only.ts` | 4 |
| `packages/workflow-engine/src/testing-graph.ts` | 39 |
| `packages/workflow-engine/src/testing.ts` | 86 |
| `packages/workflow-engine/src/transition-decisions.ts` | 83 |
| `packages/workflow-engine/src/transitions.ts` | 99 |
| `packages/workflow-engine/src/types.ts` | 303 |
| `packages/workflow-engine/src/workflow-transition-derived.ts` | 296 |
| `packages/workflow-engine/src/workflow-transition-observations.ts` | 527 |
| `packages/workflow-engine/src/workflow-transition-plan.ts` | 186 |
| `packages/workflow-engine/src/workflow-transition-state.ts` | 315 |
| `packages/workflow-engine/src/workflow-transition-stops.ts` | 165 |
| `packages/workflow-engine/test/advance-workflow-branching.test.ts` | 594 |
| `packages/workflow-engine/test/advance-workflow-risk-branches.test.ts` | 66 |
| `packages/workflow-engine/test/advance-workflow-transitions.test.ts` | 417 |
| `packages/workflow-engine/test/branch-join-scheduling.test.ts` | 89 |
| `packages/workflow-engine/test/checkpoint-risk-branches.test.ts` | 352 |
| `packages/workflow-engine/test/checkpoint-seam.test.ts` | 747 |
| `packages/workflow-engine/test/executable-workflow-branching.test.ts` | 696 |
| `packages/workflow-engine/test/executable-workflow-controls.test.ts` | 484 |
| `packages/workflow-engine/test/executable-workflow-foreach-part-2.test.ts` | 428 |
| `packages/workflow-engine/test/executable-workflow-foreach.test.ts` | 923 |
| `packages/workflow-engine/test/executable-workflow-identity.test.ts` | 712 |
| `packages/workflow-engine/test/executable-workflow-inputs.test.ts` | 542 |
| `packages/workflow-engine/test/executable-workflow-outcomes.test.ts` | 606 |
| `packages/workflow-engine/test/executable-workflow.fixtures.ts` | 678 |
| `packages/workflow-engine/test/foreach-scheduling.test.ts` | 97 |
| `packages/workflow-engine/test/operation-risk-branches.test.ts` | 376 |
| `packages/workflow-engine/test/package-contract.test.ts` | 44 |
| `packages/workflow-engine/test/retry-policy-mutation.test.ts` | 131 |
| `packages/workflow-engine/test/retry-wait-cancellation.test.ts` | 188 |
| `packages/workflow-engine/test/scheduler-projection.test.ts` | 59 |
| `packages/workflow-engine/test/scope.test.ts` | 37 |
| `packages/workflow-engine/test/state-machine-model.test.ts` | 588 |
| `packages/workflow-engine/test/support/advance-workflow.fixture.ts` | 71 |
| `packages/workflow-engine/test/transition-policy-mutation.test.ts` | 110 |
| `packages/workflow-engine/test/workflow-transition-risk-behavior.test.ts` | 483 |
| `packages/workflow-engine/tsconfig.json` | 20 |
| `packages/workflow-engine/tsconfig.test.json` | 17 |
| `packages/workflow-engine/vitest.config.ts` | 9 |
| `packages/workflow-engine/vitest.coverage.config.ts` | 42 |

### packages/workflow-model — 27 files

| Reviewed path (repository-relative) | Physical lines |
| --- | ---: |
| `packages/workflow-model/package.json` | 67 |
| `packages/workflow-model/src/assert-never.ts` | 3 |
| `packages/workflow-model/src/canonical-json.ts` | 137 |
| `packages/workflow-model/src/expression-worker-runtime.ts` | 51 |
| `packages/workflow-model/src/expressions.ts` | 672 |
| `packages/workflow-model/src/failure-notification.ts` | 119 |
| `packages/workflow-model/src/graph-contract.ts` | 351 |
| `packages/workflow-model/src/graph-validation.ts` | 337 |
| `packages/workflow-model/src/graph.ts` | 889 |
| `packages/workflow-model/src/index.ts` | 76 |
| `packages/workflow-model/src/invocation-identity.ts` | 93 |
| `packages/workflow-model/src/mapping.ts` | 131 |
| `packages/workflow-model/src/observation-window.ts` | 9 |
| `packages/workflow-model/src/server-only.ts` | 3 |
| `packages/workflow-model/test/canonical-json.test.ts` | 61 |
| `packages/workflow-model/test/expressions.test.ts` | 613 |
| `packages/workflow-model/test/failure-notification.test.ts` | 131 |
| `packages/workflow-model/test/fixtures/retained-workflow-v1.json` | 13 |
| `packages/workflow-model/test/graph.test.ts` | 376 |
| `packages/workflow-model/test/mapping.test.ts` | 86 |
| `packages/workflow-model/test/package-contract.test.ts` | 187 |
| `packages/workflow-model/test/retained-workflow-v1.test.ts` | 77 |
| `packages/workflow-model/test/workflow-graph-contract.test.ts` | 713 |
| `packages/workflow-model/tsconfig.json` | 21 |
| `packages/workflow-model/tsconfig.test.json` | 12 |
| `packages/workflow-model/vitest.config.ts` | 5 |
| `packages/workflow-model/vitest.coverage.config.ts` | 16 |

### root — 19 files

| Reviewed path (repository-relative) | Physical lines |
| --- | ---: |
| `.dockerignore` | 9 |
| `.env.example` | 154 |
| `.gitignore` | 8 |
| `.mailmap` | 2 |
| `.node-version` | 1 |
| `.prettierignore` | 7 |
| `.prettierrc.json` | 6 |
| `AGENTS.md` | 56 |
| `CONTRIBUTING.md` | 36 |
| `Dockerfile` | 44 |
| `README.md` | 143 |
| `SECURITY.md` | 30 |
| `compose.yaml` | 201 |
| `eslint.config.mjs` | 578 |
| `package.json` | 88 |
| `pnpm-lock.yaml` | 5732 |
| `pnpm-workspace.yaml` | 15 |
| `tsconfig.base.json` | 20 |
| `tsconfig.json` | 23 |

## 5. Architecture and dependency assessment

The dependency direction is sound: deployment applications compose capabilities; database and integration adapters implement stateful boundaries; workflow-engine/model/SDK describe execution without Nest dependency; contracts project public wire shapes. Explicit exports and role-specific database entrypoints prevent the database package from becoming a privilege-neutral root import. No production dependency cycle was found, and build/dependency checks pass.

| Layer | Owns | Assessment |
| --- | --- | --- |
| API | HTTP, authentication/authorization, DTO seams, feature use cases | Thin controllers and feature-owned problem mapping; replay surface is missing |
| Worker | Dispatch/consumer composition, coordinator/node runtime capabilities | Appropriate separate process; activation must be represented by deployment manifest |
| Maintenance apps | Lifecycle, retention, recovery, operator process policy | Separate credential/process boundaries are justified, not gratuitous microservices |
| Database | Durable state, transaction recipes, scoped queries, migration compatibility | Broad package but capability-local internals and authority-specific exports provide leverage; cross-capability retention interaction is defective |
| Engine / model | Deterministic transitions, graph/executable/checkpoint formats, mappings | Framework-independent and meaningful; nested scope needs one consistent indexing/admission model |
| SDK / catalog / nodes | ABI, release manifests, selectable executable registry | Distinct contract and composition roles; retained versions are required by references |
| Integrations | Secret envelope, safe HTTP boundary, provider adapters | Deep useful modules; atomic credential fence is lost at a shared helper seam |
| Artifact / queue / rate-limit / observability | Bounded infrastructure capabilities | Cohesive ownership; no justification for merging these into a generic shared package |

Database factories are not inherently bad abstractions: they hide transaction and privilege invariants used by multiple applications. The remaining large functions are mainly state transitions and SQL recipes; splitting them into arbitrary one-line wrappers would worsen discoverability. Existing complexity ratchets identify 35 file and 40 function hotspots. Change them when a coherent invariant can be isolated, with behavior characterization first.

Versioning is deliberate: metadata/browser-safe projection is separated from runtime executors, executable releases pin exact node/executor contracts, and retirement checks protect durable references. Transitional migration/checksum compatibility must not be removed merely because the current tree is clean. The plan's original no-legacy-product compatibility non-goal does not authorize breaking already-published migration or executor identities.

## 6. Package-by-package and app-by-app assessment

| Area | Implementation/test assessment | Material qualification |
| --- | --- | --- |
| `apps/api` | Feature modules, authenticated actor context, policy guards, optimistic draft/publication, previews, webhooks and SSE are substantive; real HTTP/PG tests | Missing replay, workflow lifecycle/activation and artifact upload/finalize surfaces; production environment contract fails startup |
| `apps/worker` | Separate coordinator/attempt jobs, leases, dispatch evidence, artifact capabilities, recovery and transport probes | Generic HTTP/Slack fence omission; manifest enables no outbox jobs by default |
| `apps/lifecycle-command` | Small process adapter; ordered cleanup and readiness ownership | Existing LC-001 active abort classification and LC-002 process assurance remain open |
| `apps/retention` | Bounded maintenance composition, explicit role/lease/deadline settings | Current SQL run-summary deletion conflicts with replay lineage |
| `apps/recovery` | Restore-before-serve composition and fail-closed readiness | Local fake/compatible-store proof is not actual regional restoration |
| `apps/operator-command` | Deliberately narrow command admission separate from normal worker execution | Operator replay exists but does not implement user API replay |
| `packages/database` | Real-role RLS, lock/fence/CAS, immutable publication, outbox/inbox, migration/recovery fixtures | DST loop and retention interaction; cancellation/config cleanup qualifications |
| `packages/workflow-engine` | Pure transition/checkpoint machinery, property and crash/duplicate tests | Nested Parallel cap and skipped Merge defects survive 257 unit tests |
| `packages/workflow-model` | Canonical graph, structured bodies, immutable identity, bounded JSONata worker | Hostile shapes and cycles are addressed; CPU control in HTTP is a different boundary |
| `packages/node-sdk` | Exact ABI/release contracts, bounded JSON envelope, typed execution capabilities | Optional fence interface requires each provider adapter to supply the fence correctly |
| `packages/node-catalog` | Release composition and cohort admission have genuine separate ownership | Deployed cohort selection is missing in worker manifest, not catalog implementation |
| `packages/nodes-core` | Real versioned Manual/Set/Terminate/control/trigger definitions and executors; no placeholder publishables | Planned Validate node absent; engine consumption of valid nested control graphs is defective |
| `packages/contracts` | Zod/OpenAPI generation and checked public response/parameter shapes | Replay/artifact routes absent and activation limited to inactive; generation cannot find omitted product requirements |
| `packages/integrations` | Shared secure transport, explicit dispatch ambiguity, redaction, provider adapters and envelope ownership | Credential race, hexadecimal-looking hostname rejection, residual redaction CPU |
| `packages/artifact-store` | Bounded ownership/cleanup, dual-region ledger, exact acknowledgement and version semantics | AWS Object Lock/KMS/cross-region evidence remains external |
| `packages/observability` | Safe structured logging, bounded metric labels, lifecycle ownership, explicit instrumentation | Logger safety does not establish trace-export privacy or live alert/pager behavior |
| `packages/queue` | IDs-only contracts, outbox publisher reconciliation, bounded consumer drain, real Redis smoke | Cooperative cancellation remains a caller contract; no claim of exactly-once external transport |
| `packages/rate-limit` | Atomic Lua preflight, bounded Redis client and shared endpoint normalization | Real integration cases do not thoroughly exercise multi-dimensional partial-increment rejection; nonclustered topology is intentional |

### Where the findings concentrate

Assigning each new finding once to its primary implementation/product owner gives the following distribution. This is an explanatory grouping, not a severity or quality score; several defects cross application, package and infrastructure boundaries.

| Primary area | New findings | IDs |
| --- | ---: | --- |
| Packages | 10 | IWA-01/03/04/05/06/07/08/13/14/15 |
| Apps/API product capabilities | 3 | IWA-10/16/17 |
| Infrastructure/deployment | 3 | IWA-02/09/11 |
| Documentation | 1 | IWA-12 |

The six apps are not trivial or lightly reviewed. API use cases, authorization, worker runtime composition and process lifecycle contain substantial implementation. Their boundaries are generally sound, while much of the most error-prone scheduling, graph execution, transaction, provider and telemetry logic deliberately lives in packages. That explains the concentration better than either "apps have little code" or "apps are proven exceptionally clean." The two existing LC-001/002 P2 findings additionally belong to an app and are not included in the 17-new-finding table. Package-origin defects still affect API/worker behavior; fewer findings are not proof of fewer latent defects or better naming/readability.

## 7. Critical-path behavioral assessment

| Path traced | Evidence and result |
| --- | --- |
| Author → save → publish | Revision/ETag CAS; graph normalization/checksum; immutable executable/version; compatible registry; trigger reconciliation intent. Tests cover conflicts and stable publication identity |
| Release → persisted reference → retained execution | Exact version/manifest support across catalog, model, DB readiness, worker and recovery. Separate rollout integration passed |
| OIDC → workspace → authorized operation | Browser binding, single-use transaction, internal membership, tenant-local transaction and problem response. No cross-workspace bypass found |
| Manual run → outbox → coordinator → attempt | Durable run/checkpoint/outbox write, transport IDs, fenced claims, immutable materialization and attempt completion. Duplicate/crash tests use real PG |
| Preview → execute → complete | Explicit side-effect disclosure, bounded inputs/artifacts and deadline migration. Some completion paths omit queue signal; fenced completion alone is not evidence of false state, so not promoted without harm |
| Condition/Switch → Parallel/Merge | Selection ports and join ledger are durable, but skipped Parallel→Merge and nested concurrency interactions fail legal-graph probes |
| For Each | Structured-body validation, ordinal identity, bounded iteration and barrier recovery exist; nested Parallel lookup ignores body nodes |
| Wait → resume | PostgreSQL resume time, no worker held for duration, duplicate-safe wakeup. Redis is a hint, not timer authority |
| Cancel/retry → terminal state | Cooperative signals, persisted cancel observation, explicit unknown outcome and stable invocation keys. Do not interpret abort as undoing a completed provider effect |
| HTTP/Slack/email dispatch | URL/address checks and pinned transport; marker before bytes; email supplies atomic connection fence, shared HTTP/Slack helper does not |
| Mapping → execution input | Restricted JSONata isolated worker, bounded canonical inputs/outputs, stable predecessor outputs. No arbitrary code/network capability introduced |
| Webhook → acceptance → run | Signature/replay checks, durable idempotency, joined native reply and projected active trigger. Real HTTP suite passed |
| Schedule → due occurrence → run | Canonical recurrence and misfire semantics; DST repeated-hour normalization can make the cursor cycle and freeze scanning |
| Failure notification | Durable intent, safe context, provider destination pin, bounded configured retries. Late completion after abort warrants regression work; no unbounded idempotency guarantee is established |
| Artifact → ledger → lifecycle/restore | Exact region/version/acknowledgement, deletion intent and reconciliation. Local compatible-store recovery passed; cloud retention/immutability still unproven |
| Retention → replay lineage | Bounded SQL deletion does not account for newer replay child foreign keys; realistic parent deletion fails atomically |
| Operator replay → worker admission | Authorized durable command and lineage exist; distinct from the plan's authenticated replay endpoint |
| SSE after Redis loss | Durable sequence backfill and live resubscription probe passed without history depending on Redis |

## 8. Code quality and implementation craft

The strict TypeScript baseline, exact optional fields, typed test configurations, Zod seams, explicit public exports and owner-local test helpers are valuable. `unknown` at untrusted boundaries is appropriate; casts after a validated discriminant or a narrow library adapter are not automatically defects. No recommendation is based on counting casts, readonly modifiers, classes, or generic parameters.

The most important craft failures are semantic, not stylistic: a shared helper weakens a deeper transaction contract by dropping an argument; top-level-only indexing loses nested graph semantics; and map/object API confusion silently disables part of a validator. These are examples where stronger domain types or a narrower interface provide concrete value. The validator controlled negative demonstrates why the currently untyped domain-shaped `.mjs` tool deserves checked types when repaired.

The secure HTTP module's byte-wise redaction is bounded in allocation but not sufficiently bounded in CPU work. A configured timeout cannot preempt synchronous work on the same event loop. Redundant parse/freeze/normalization is often justified at persisted or external seams; remove it only with ownership/mutation evidence, not wholesale. Compatibility modules and migration aliases require durable-reference retirement evidence before deletion.

Naming is generally domain-oriented. The database capability folders and narrow entrypoints improve locality; generic factory-to-class conversions would not add value. The concentrated transition/SQL modules remain harder to change safely, but their concrete invariants matter more than a mechanical LOC threshold. No formatting-only or shallow-wrapper finding is raised.

### Senior-level maintainability assessment

The review assessed meaningful responsibilities, useful reuse versus accidental generalization, unnecessary wrappers/indirection, duplicated concepts, naming, control flow, coupling, public interfaces, type/runtime agreement, error ownership and repeated work. It was not limited to checking compilation or test totals. The general result is a sound modular structure with concrete semantic and assurance defects, not a certification that every function is ideal.

Naming and reuse are generally domain-oriented: capability-specific database entrypoints and framework-independent engine/SDK contracts expose meaningful behavior. A shared helper is only useful if it preserves the underlying contract; IWA-03 demonstrates harmful reuse that drops the atomic fence. Similarly, top-level-only scheduling helpers do not correctly generalize to nested scopes (IWA-04/05). Optimize or extract around those invariants, rather than mechanically converting factories to classes, deleting small functions, or splitting large transactional recipes. CPU redaction IWA-08 has measured cost; other perceived allocation/parse duplication should not be called an optimization defect without ownership or workload evidence. This audit is not a function-by-function refactoring catalogue.

### Error conventions, TypeScript and imports

- **Error uniformity means consistent boundaries, not one universal class.** `apps/api/src/platform/http/application-error.ts:9` defines a shared readonly `ApplicationError` structure with stable catalog codes, safe detail and retained cause; `problem-details.filter.ts:233` normalizes application/domain/framework errors into the public problem contract. Engine/SDK types such as `WorkflowEngineError`, `NodeExecutorFailure` and `NodeSdkError` retain domain-specific meaning without importing HTTP concerns. The plan explicitly distinguishes application errors from execution errors. These separate representations are appropriate when adapters preserve classification and safe exposure; a repository-wide base-class conversion is not justified.
- **Error handling is not uniformly correct merely because the conventions are coherent.** Existing LC-001 records an expected active cancellation as a failure and ultimately throws an aggregate error. Preserve genuine cleanup failures while distinguishing expected shutdown. Provider ambiguity and retries also require behavioral evidence, not only a common error shape. No universal correctness claim is made for every catch/throw branch.
- **TypeScript is generally used effectively.** Strict settings, exact optional properties, typed tests, Zod boundary validation and constrained public contracts are strengths. `unknown` for untrusted values and narrow validated/library-adapter assertions are not inherently poor code. Conversely, compilation does not prove that a helper forwards all required semantics: IWA-03 is an example where a tighter capability interface could prevent an omission. Runtime contracts still need hostile-input and state-transition tests.
- **Imports and exports were reviewed as runtime architecture.** Explicit package/domain exports, authority-specific database entrypoints, dependency direction and browser/server separation were inspected; dependency/build checks and real image role-import smoke passed. No production dependency cycle was established. Successful imports prove the tested runtime dependency closure, not deployed configuration startup (IWA-02), and do not certify every possible consumer combination.
- **Using `.ts` everywhere is not itself a quality requirement.** Small `.mjs` tooling is reasonable. A script modeling dependency graphs and deployment contracts benefits from checked types and negative tests: IWA-11's `Object.keys` on a `Map` silently disables validation. Add useful type checking when repairing that tool, rather than recommending a blanket extension conversion.

## 9. Data and PostgreSQL assessment

Strengths include composite workspace relationships, non-owner runtime roles, transaction-local workspace context, FORCE RLS, explicit privileged maintenance boundaries, SQL constraints matching runtime vocabulary, short fenced state transitions, and real PostgreSQL tests for contaminated pools, concurrent publication, leases, replay, and compatibility. Migration application through `0075` succeeded in the isolated stack.

The broad database package is justified by one durable authority, but schema additions must be reviewed against all lifecycle consumers. The replay foreign key added in `0065` is individually reasonable; it makes the existing retention deletion in `0055` incomplete. A migration can pass an empty-database upgrade and still break an older bounded deletion recipe.

The steady-state connection calculation passes 382/400, but allowed ECS rolling overlap exceeds that ceiling. This is not proof of observed production exhaustion: it is a repository contract inconsistency requiring a surge-aware budget and operational test. Query/index design is mostly bounded and purpose-specific; no production EXPLAIN/ANALYZE or representative tenant skew was available, so index presence is not a scalability certification.

Cancellation deserves driver-level evidence. Some maintenance helpers pass a `signal` field to installed `pg`, whereas the hardened tenant engine actively disposes uncertain clients. PostgreSQL lock/statement timeouts still bound those maintenance calls; an ignored AbortSignal must not be described as an infinite query or automatically a P1 data-integrity defect. Invalid migration-runner options are also validated after resource acquisition, creating a cleanup gap on invalid configuration.

## 10. Security and privacy assessment

Repository-controlled strengths: browser-bound OIDC transactions, object-level workspace authorization, real-role RLS, bounded request/graph/expression input, parameterized data SQL and quoted configuration identifiers, encrypted versioned credentials, safe problem vocabulary, restricted URL/address/redirect handling, IDs-only queue payloads, and substantially hardened structured logging. No arbitrary-code execution surface or generic entity API was found.

The HTTP/Slack atomic fence omission is a security defect: secret revocation can commit after a successful standalone check but before a dispatch marker that no longer verifies the connection. It does not imply all provider fencing is absent; email takes the stronger path. The hostname defect fails closed and is availability/correctness, not SSRF bypass. Redaction CPU is an abuse/performance boundary, not evidence that secret bytes were leaked.

A controlled local exported-span probe established verbatim OAuth-like query capture by default HTTP instrumentation: server `url.query` and client `url.full` contained synthetic code/state/token values. The actual callback uses those query fields; IWA-14 records this repository-controlled privacy defect. This is not evidence of an observed production incident. Normal provider errors are sanitized, and the separate raw queue-exception leak hypothesis was not promoted. Structured-log tests must not be presented as proof of trace privacy or telemetry-backend policy.

Supply-chain checks are strong at this commit: pinned Actions/images, moderate dependency admission, current exact-head CodeQL success, and a non-root production image. These facts do not prove absence of unknown vulnerabilities or signed provenance for a promoted cloud image. Cloud IAM separation, secret-store permissions, TLS/network egress, KMS encryption context, and Object Lock must be evidenced against the actual release.

## 11. Tests and coverage assessment

Root verification passed, including all 18 workspace unit suites. Real-service suites use separate PostgreSQL roles and disposable databases rather than replacing persistence with mocks. Crash/recovery, idempotency, fenced transitions, contaminated pooled connections, compatibility and SSE tests are materially stronger than happy-path-only testing. The isolated stack used nondefault loopback ports and a unique Compose project; no existing service was restarted.

All 12 packages and six apps were included in source/test/configuration review and their configured workspace verification, not only selected high-risk packages. That is complete repository review scope, not exhaustive behavioral execution: not every branch, input, interleave, integration combination or deployed environment was exercised. The 1,898 unit tests and 377 integration/resilience passes are evidence of the cases actually run; the inventory, coverage denominator and unproven production obligations answer different questions.

Coverage is not repository-wide: the root risk report selects 105 files and 4,938 coverable lines, reporting 501 reviewed uncovered branches and zero unreviewed sites at this baseline. Additional package coverage thresholds do not make that risk denominator global. The four small operational applications are not all included in the root selected coverage policy. Some review explanations repeat a generic rationale; a source fingerprint prevents stale coordinates but does not prove the rationale is true.

The suite missed the legal DST/nested-control/replay-retention interactions and rendered configuration failure. These are behavioral matrix gaps, not deficiencies that can be fixed by increasing a headline percentage. Required new tests are specified per finding. The integration redaction tests protect memory/cross-chunk semantics, but do not establish a CPU deadline for long near-matching patterns. Real rate-limit tests should exercise rejection across multiple counters, not merely individual limits.

Controlled negative: the deployment validator was evaluated with an in-memory Dockerfile view omitting the worker `dist` COPY. It still printed `ECS deployment contract is valid.` The repository file itself was never edited. This proves a validator blind spot; the separate real image role-import check is a compensating control. No full mutation score is claimed.

The local combined integration run passed 374 tests, skipped three AWS-specific artifact tests and one separately gated compatibility test. The latter then passed with its explicit flag. SSE-loss and worker transport-resilience tests also passed separately. Those are not four unresolved missing integration behaviors: the three live AWS checks remain external; compatibility was executed in its proper cohort.

## 12. CI/CD, tooling, and dependencies

Exact audited HEAD: [CI run 33996506656](https://github.com/vigani1/pertexo/actions/runs/33996506656) succeeded; [CodeQL run 33996506642](https://github.com/vigani1/pertexo/actions/runs/33996506642) succeeded. Code-scanning analysis `1730377432` matched the commit, had no error/warning, and reported zero results. Dependency review is skipped on a push run by design; it is not a failed job. Remote evidence is point-in-time, not a guarantee about future branch protection or newly disclosed advisories.

The root gate covers formatting, docs, runtime major, dependencies, schema registry, build, lint, complexity/duplication, generated contracts, typed tests and units. Pre-push adds coverage; the full integration gate is intentionally more expensive and protected CI runs service cohorts. Shell `-e`/pipefail behavior was checked with a failing grouped pipeline; the suspected masked-error defect was rejected.

The production image built successfully and imported all seven role module paths under a read-only filesystem/non-root user. This proves current dependency closure for those imports, not successful configured application startup. IWA-02 is precisely the gap between module import smoke and actual rendered configuration.

Small `.mjs` tools are appropriate; type-aware checks become valuable when a tool models dependency graphs and release contracts. The Map/Object.keys defect is a concrete reason, not a blanket language preference. The lockfile includes expected transitive version duplication (for example type packages and plugin generations); no unsupported conclusion about duplicate vulnerability exposure is made. `pnpm security:audit` passed at moderate severity. The explicit repository license/governance decision is documented; absence of a permissive license is not an accidental defect.

## 13. Reliability, observability, and performance

Readiness checks validate durable authority rather than only process liveness; provider/artifact capabilities have deadlines and ownership; queue loss and PG/Redis reconnection have executable probes. Worker transport resilience reported no new claims during drain, bounded force-close, and recovery after isolated failures. Wait state is durable and does not consume a slot.

The limitations are concrete: event-loop CPU cannot be preempted by an AbortSignal timer; a DST cursor can loop forever; allowed rollout surge exceeds the connection budget; lifecycle-command active abort is reported as fatal; and live deployment/restore ownership remains unevidenced. Local timings are environment measurements, not SLO promises.

Telemetry has bounded labels, structured safe logs, metrics for actual outcomes, dashboards and alert rules. YAML/Grafana validation, Prometheus configuration/rule validation (24 rules), and collector validation passed. That does not prove a real API-to-worker trace can be retrieved, alerts reach a responsible person, or thresholds are calibrated against launch traffic.

## 14. Documentation and maintainability

The plan, ADRs, progress tracker, operational runbooks and package audits provide unusually detailed ownership and historical reasoning. Historical audit bodies explicitly pinned to older trees must not be misread as current unresolved findings. Conversely, remediation headers are claims, not authority: the integration CPU claim and deployment completeness need correction in light of this audit.

Current status has concrete drift: migration-head prose still says `0074` where source/readiness and the current migration set require `0075`; the compatibility inventory mixes both. The release-security runbook says high/critical while the actual dependency gate uses moderate. These are small but operationally relevant inconsistencies, not evidence that historical records should be deleted.

Avoid another duplicate mutable checklist. This report is immutable evidence for the named baseline; future corrections should update the authoritative progress tracker and link specific finding IDs/verification. Do not mark a phase complete solely because all rows in a past audit were closed. Distinguish a requirement that was met at a checkpoint from new cross-feature regressions discovered later.

## 15. Plan and ADR compliance matrix

### Quality of the implementation plan itself

**Assessment: retain and refine the blueprint, not replace it.** Its strongest elements are explicit durable authority, package/process ownership, transactional invariants, compatibility and tenancy rules, ADR-before-decision discipline, acceptance criteria and separation of repository proof from deployed evidence. Those are appropriate concerns for this workflow platform, not unnecessary enterprise features merely because the project is personal.

The following improvements distinguish demonstrated omissions from planning judgments:

| Aspect | Assessment and recommended improvement | Evidence status |
| --- | --- | --- |
| Scope and completion reconciliation | Validate, user replay, workflow lifecycle/version restoration and public artifact ingestion require implementation or explicit approved deferral. A narrower completed slice must not imply the entire product requirement is complete. | Confirmed IWA-10/15/16/17 and matrix below |
| Product semantics | Define executable Validate input/output, limits and failure behavior before building it; specify lifecycle/activation and upload behavior against existing durability policies. Named capabilities alone are insufficient executable specifications. | Validate underspecification recorded in IWA-15; detailed correction criteria in IWA-16/17 |
| Launch sequencing and complexity | Make launch-blocking requirements and later scope unmistakable while retaining mandatory safety and recovery controls. The multi-role/regional operational design is ambitious; sequencing should avoid obscuring unfinished user-facing capabilities. This is not a recommendation to remove required safeguards or an assertion that the justified process boundaries are overengineered. | Engineering judgment from scope and operational breadth; customer demand, capacity and policy suitability remain external |
| Custom-engine acceptance | Requalify the gate using legal nested branching, joins, concurrency, persistence, crash and recovery combinations. Individual node completion and green isolated suites do not establish composition correctness. | Confirmed IWA-04/05; existing conditional engine gate remains appropriate |
| Plan maintainability and traceability | The long plan repeats related obligations across product scope, module maps, transitions, endpoints and phase criteria. Maintain requirement-to-owner/code/test/evidence links in the authoritative progress tracker, including explicit deferrals, to reduce omission/drift risk. Do not create another independently mutable checklist. | Engineering judgment supported by cross-section omissions and IWA-12 drift; not a new severity-rated defect based on document length |

Overall, architectural and reliability planning are strong; synchronization of scope, precise product behavior and completion evidence needs improvement. These judgments supplement the evidence-backed findings rather than increasing their count. This audit does not authorize changing the plan, ADRs or implementation.

### Requirement compliance

Status legend: **implemented** means the inspected implementation and cited suites support the requirement at this baseline, not mathematical proof; **partial** means a concrete defect or missing surface; **external** means a deployed/product decision cannot be established locally; **deferred** follows the explicit plan. Related requirements are grouped by their named authoritative section, without treating absence from a test suite as automatically noncompliant.

| Plan requirement / section | Status and evidence |
| --- | --- |
| Product goal and V1 node surface | Partial: implemented Manual, Set/Map, Condition, Switch, For Each, Parallel, Merge, Wait, Terminate, HTTP, Slack, email and failure notification; the separately listed executable Validate node is absent (IWA-15), in addition to control composition defects |
| Webhook and Schedule V1 | Partial: acceptance/signature/dedupe/health exist; repeated-hour DST recurrence fails IWA-01 |
| Backend-only delivery | Implemented explicit boundary; no missing React app finding |
| Deferred polling, arbitrary code, approvals, forms, nested workflows, multiplayer, synchronous webhooks, active-active | Deferred as specified; no placeholder publishable implementations required |
| Engineering envelope, customer demand, quota and retention suitability | External validation; local bounds/defaults exist, not measured launch suitability |
| PostgreSQL source of truth, IDs-only transport, transactional outbox/idempotent consumers | Implemented; crash/duplicate/Redis-loss suites |
| Immutable workflow versions and exact node/executor pinning | Implemented across publication, executable, persistence, materialization and readiness |
| Separate API/worker scaling and framework-free engine | Implemented package/process boundaries; deployed activation partial IWA-02 |
| Bounded loops/no arbitrary cycles | Implemented graph grammar, iteration budgets and scoped identities; nested Parallel bound partial IWA-04 |
| Unsafe ambiguity remains outcome_unknown, not blind retry | Implemented dispatch evidence and safe retry categories; revocation fence partial IWA-03 |
| Long waits release slots and persist resume authority | Implemented Wait store/recovery/worker fixtures |
| Recommended Nest/Fastify/PG/Drizzle/Redis/BullMQ/S3/KMS/REST/SSE/Zod/OTel stack | Implemented; actual managed-service configuration external |
| Repository layout, package dependencies and Nest module rules | Implemented feature ownership, app composition and checked exports; justified extra maintenance roles have ADRs |
| Strict compiler, inferred types, parse-at-seam, errors/results, constrained assertions, typed contract tests | Implemented root/package configs and typed suites; `.mjs` validator exception IWA-11 |
| Identity/workspace, OIDC browser binding, internal roles | Implemented auth and real-role PG/HTTP tests; vendor procurement external |
| Workflow create/read/save/validate/publish/archive/restore and activation | Partial: immutable/CAS authoring and ETag conflicts implemented; archive/restore operations and normative activation state model absent, IWA-16 |
| Catalog availability and reference-based compatibility retirement | Implemented release composition/readiness/reference checks; external deployed drain remains required |
| Connections, envelope encryption, rotation, secret reference-only exposure | Partial: envelope and metadata boundaries exist; atomic HTTP/Slack dispatch fence IWA-03 |
| Execution operations: start/list/detail/events/cancel/replay | Partial: normal run operations exist; authenticated replay route/use case absent IWA-10 |
| DB conventions, entities, canonical statuses, UUID and tenant composite keys | Implemented schema/registry/migration/runtime tests; later replay FK retention interaction IWA-06 |
| Canonical graph contract, checksum identity, metadata/browser projection | Implemented model/SDK/contracts and generated fixtures |
| Save/publish/accept/outbox/coordinator/trigger/artifact transaction recipes | Internal fenced transactional modules implemented; public artifact ingestion remains absent IWA-17; inspect special maintenance cancellation caveat in section 9 |
| Queue contracts and compatibility parsing | Implemented all active job envelopes and retained parsers; no files/secrets in jobs |
| Runtime state/value flow and event contract | Implemented canonical event/checkpoint and persisted-output loading; no corrupt-input hypothetical promoted |
| Preview validation/execution and side-effect disclosure | Implemented; cancellation truth must remain explicitly tested |
| Parallel joins and skipped branches | Partial IWA-04/IWA-05: exact ledger exists but legal nested/skipped combinations fail |
| Retry and cancellation | Implemented durable observation and cooperative runtime semantics; no guarantee of undoing external effects |
| Webhook signatures, replay protection, generic raw-body contract | Implemented real HTTP/PG tests and ADR 026 |
| Schedule timezone, DST, misfire and reconciliation | Partial IWA-01 despite existing schedule tests |
| Live history and reconnect/backfill after Redis loss | Implemented; independent SSE resilience passed |
| Fair admission, entitlements, bounded backlog and non-monopolization | Implemented transactional admission/Lua; representative noisy-tenant fairness external |
| Deployment units, containers and production topology | Partial IWA-02/IWA-09/IWA-11; image itself imports successfully |
| Memory/resource limits, deadlines, backpressure, cleanup | Partial redaction CPU IWA-08 and existing LC-001; other ownership/size limits have tests |
| Structured logs, required metrics, health | Partial: emitters/assets/validators implemented, but repository trace-query privacy defect IWA-14 remains; live backend/access/retrieval and pager ownership additionally require external evidence |
| SLO 99.9%, write/webhook/schedule/SSE targets; RPO/RTO | External release evidence, not established by local timings |
| Retention defaults, legal holds, workspace deletion and backup erasure | Partial run-summary replay retention IWA-06; cloud/legal effectiveness external |
| Failure/operator recovery, regional restore-before-serve | Implemented local ledger/command/recovery contracts; actual failover/PITR/restore external |
| Security authentication/isolation/secrets/SSRF/abuse/supply chain | Partial IWA-03 and CPU abuse; strong local controls do not certify deployed IAM/network policies |
| Public API OpenAPI, problem codes and endpoint/use-case map | Partial: replay IWA-10 and artifact upload/finalize IWA-17 omitted; workflow lifecycle gap IWA-16; existing generated contracts and problem seams checked |
| Unit/integration/contract/property/recovery tests and CI gates | Implemented broad suites; missing combinations demonstrated, not whole-state proof |
| Forward-only migration discipline and compatibility | Current migration sequence applies; accepted published checksum reconciliation is explicit; no history rewritten by audit |
| Phase 0 skeleton and real-service spikes | Historical executable evidence exists and current recovery suites pass; branch/join and bounded behavior must be requalified after IWA-04/05 |
| Custom-engine go/no-go | Conditional continuation; repair invariant-level defects and rerun common fixtures, do not treat historical go as permanent approval |
| Phase 1 identity/workspace | Implemented local acceptance evidence |
| Phase 2 authoring | Core draft/publication acceptance evidence exists; full planned lifecycle/version-restoration and activation scope remains partial IWA-16 |
| Phase 3 core execution | Implemented core path; rerun cross-feature regression suite after fixes |
| Phase 4 side effects/preview | Partial fence/hostname/CPU defects |
| Phase 5 orchestration | Partial nested Parallel/skipped Merge defects |
| Phase 6 providers/triggers | Partial fence and DST defects; live provider canaries external |
| Phase 7 operations | Incomplete, correctly not production-certified; repository deployment/retention gaps plus external exercises |
| Vertical-slice completion conditions 1–11 | Vocabulary/contracts/auth/transactions/adapters/problems/telemetry/docs/tests broadly present; behavioral completeness fails for findings, so publishability claims need revalidation |
| Acceptance: draft changes cannot alter active run/version exactly once | Supported by immutable version/CAS tests |
| Acceptance: publication and trigger change atomic from product perspective | Durable projection/reconciliation design supports; not immediate external delivery guarantee |
| Acceptance: Redis loss preserves definitions/history and workers recover checkpoints | Supported by real service/recovery tests |
| Acceptance: days-long waits consume no slot; independent scaling | Supported architecture/tests; actual long-duration production soak not run |
| Acceptance: workspace cannot monopolize capacity | Local admission controls supported; nested node cap fails and noisy-tenant load remains external |
| Acceptance: no large values/secrets in queue; unified reconstructable events | Supported envelope and SSE tests |

### ADR-by-ADR

| ADR | Current assessment |
| --- | --- |
| 001 modular monolith | Implemented; role-specific maintenance apps are justified extensions |
| 002 JSONB/immutable identity | Implemented canonical checksum and immutable publication |
| 003 tenancy/RLS | Implemented hardened scoped transactions and real-role tests |
| 004 OIDC/internal auth | Implemented independent browser binding and membership enforcement |
| 005 PG/BullMQ/engine gate | Implemented durable authority; engine gate must account for new legal-graph regressions |
| 006 separate coordinator/attempt | Implemented jobs, stores and worker handlers |
| 007 retry/idempotency/unknown | Implemented dispatch truth; IWA-03 weakens connection revocation, not general marker existence |
| 008 structured loops | Implemented grammar/iteration identities; IWA-04 nested concurrency partial |
| 009 restricted JSONata | Implemented worker isolation and bounded contract |
| 010 compatibility/retirement | Implemented exact manifests/reference checks; operational drain external |
| 011 draft concurrency | Implemented ETag/revision CAS |
| 012 admission/backpressure | Implemented controls; surge budget IWA-09 and live fairness evidence remain |
| 013 retention/deletion/hold | Partial IWA-06 replay lineage interaction; cloud erasure evidence external |
| 014 timezone/DST/misfire | Partial IWA-01; policy itself is coherent but cursor algorithm is not |
| 015 SLO/region/recovery | Local architecture implemented; objectives externally unproven |
| 016 preview | Implemented explicit test semantics/deadline persistence |
| 017 Condition | Partial composition with skipped Parallel/Merge IWA-05 |
| 018 Switch | Implemented stable ordered case/port contracts; include analogous skipped-path regression |
| 019 Parallel/Merge | Partial IWA-04/IWA-05 |
| 020 For Each | Implemented body/barrier/ordinal rules; nested Parallel interaction partial |
| 021 Wait | Implemented PG timing and resume fencing |
| 022 failure intent | Implemented durable safe intent/recovery |
| 023 Slack | Partial atomic credential fence IWA-03; live canary external |
| 024 Resend | Implemented binding/dispatch/idempotency-aware configured policy; actual provider/horizon behavior external |
| 025 provider destinations | Implemented versioned destination/delivery path; live provider proof external |
| 026 generic webhook | Implemented signature/replay acceptance |
| 027 lifecycle dispatch | Implemented credential separation; existing LC-001/002 remain |
| 028 ECS manifest | Partial IWA-02/IWA-09/IWA-11 |
| 029 operator boundary | Implemented durable admission then normal worker execution; does not replace public replay requirement |
| 030 autoscaling | Input contract implemented; surge and observed scaling capacity incomplete |

The ADR set is technically coherent overall. Do not add speculative ADRs for deferred features. Operational assumptions (provider horizons, legal retention suitability, customer demand, cloud control ownership) need evidence or a new decision when changed. The audit does not independently certify the historical ordering of every ADR commit versus every implementation commit; it verifies current decisions and records the historical-order limit explicitly.

## 16. Existing-audit reconciliation

IDs are namespaced by their source document/era. In particular, historical progress `A-05` (coordinator decomposition) is not current whole-repository `A-05` (coverage). “Fixed” below means the original defect is no longer present in inspected code; it does not certify every related capability. New defects are not retroactively assigned an unrelated old ID.

### Current whole-repository audit A-01–A-19

| ID | Independent disposition | Current evidence / qualification |
| --- | --- | --- |
| A-01 | Fixed for original logger ReDoS | Bounded logger parser, adversarial tests, exact-head CodeQL clean; IWA-08 concerns another algorithm |
| A-02 | Fixed; continuous dependency gate | Fastify 5.12.1 lock paths and moderate audit passed |
| A-03 | Fixed current packaging | Runtime dependency declarations and real image seven-role imports pass; IWA-11 finds validator weakness, not current missing package |
| A-04 | Still external/incomplete | No live Phase 7 certification supplied; new repository blockers also exist |
| A-05 | Scope disclosure fixed; assurance continuous | 105 selected files/4,938 coverable lines, not global coverage; legal-state gaps demonstrated |
| A-06 | Refactor implemented; controlled debt | Capability-local database/engine modules and 35/40 hotspot ratchet, not a clean-code completion guarantee |
| A-07 | Fixed | Feature-owned API problem/filter mapping; controllers no longer repeat original whole-handler plumbing |
| A-08 | Still external | Local digest metadata/image does not prove signed hosted provenance or credentialed provider canaries |
| A-09 | Security execution verified; governance conditional | Exact-head CI/CodeQL green; independent second-maintainer approval remains a policy boundary, not invented local evidence |
| A-10 | Fixed | Narrow exports, runtime/declaration dependencies and dependency checks pass |
| A-11 | Fixed original oversized suite organization | Behavior-local tests/support and duplication ratchet; size alone does not prove quality |
| A-12 | Retained tooling debt; concrete defect now IWA-11 | `.mjs` is not inherently wrong; Map enumeration would benefit from checked types and negatives |
| A-13 | Fixed/explicit policy | CONTRIBUTING/SECURITY/governance, explicit license decision, parsed CI YAML |
| A-14 | Worker keepalive fixed locally | Worker lifecycle/transport drain tests pass; deployed drain budget still external; LC-001 is a different app |
| A-15 | Fixed original publication truth | Explicit unknown-publication reconciliation rather than blindly treating timeout as no publication |
| A-16 | Fixed original persistence conventions | Schema/UUID registry, migration tests and retention schedule FORCE RLS; IWA-06 is later replay interaction |
| A-17 | Fixed | Bounded rate-limit runtime and joined webhook replies, real HTTP/Redis tests |
| A-18 | Intentionally retained with explicit semantics | Wire-vs-resolved credential contracts serve different seams; no justified universal schema merger |
| A-19 | Fixed | Plan explicitly backend-only; no frontend implementation required here |

### Code audit C-01–C-28

| ID | Independent disposition | Evidence / qualification |
| --- | --- | --- |
| C-01 | Fixed | Queue publication ownership and unknown-result reconciliation |
| C-02 | Fixed original duplication | Failure notification transactions use shared tenant machinery; signal semantics still need driver/caller-specific review |
| C-03 | Fixed | Worker keepalive is lifecycle-owned |
| C-04 | Fixed | Workspace runtime dependency and production image import |
| C-05 | Fixed | Guarded workspace authorization is reused through request context |
| C-06 | Fixed | Shared abortable delay with bounded inputs |
| C-07 | Fixed | Native webhook reply promise is joined |
| C-08 | Fixed | Redis runtime deadline/connection recovery |
| C-09 | Fixed | API composition variants constrain contradictory states |
| C-10 | Fixed structural checkpoint | Worker transport internals split by responsibility behind composition |
| C-11 | Fixed structural checkpoint | Database capability factories/public facades narrow ownership |
| C-12 | Fixed original parser drift | Canonical persisted primitive/row seams, typed tests |
| C-13 | Fixed | Catalog release projection/composition centralized |
| C-14 | Fixed | Feature-owned exception mapping composition |
| C-15 | Fixed | No-op draft catch/rethrow removed |
| C-16 | Fixed original duplicate request parsing | HTTP parsing/use-case contracts inspected; persisted trust seams still legitimately parse |
| C-17 | Fixed original scattering | Explicit response contract/projection ownership |
| C-18 | Fixed original style drift | Canonical route/cursor parsing seams |
| C-19 | Fixed/retained by policy | Errors with distinct policy remain; no automatic class-count complaint |
| C-20 | Fixed original repeated graph scans | Indexed graph validation; nested scheduling lookup IWA-04 is different behavior |
| C-21 | Fixed | Owner-local split-suite support; root duplication ratchet passes |
| C-22 | Fixed | Capability-local database directories and stable authority exports |
| C-23 | Controlled debt | 35 files/40 functions remain above accepted thresholds; no claim all complexity removed |
| C-24 | Continuous assurance | Correct selected denominator; mutation/behavior confidence remains limited |
| C-25 | Accepted policy/evidence-gated | Immutability removal requires ownership/mutation or profile evidence |
| C-26 | Fixed with compatibility retainers | Durable source terminology; persisted/operational identifiers retained intentionally |
| C-27 | Retained conditional debt, now actionable | IWA-11 provides a concrete unchecked JavaScript contract error |
| C-28 | Fixed continuous gate | Pinned reproducible source/test clone baseline and negative tooling tests |

### Artifact-store component

| ID | Independent disposition | Evidence |
| --- | --- | --- |
| ART-001 | Fixed locally; geography external | Provider-reported region normalization/validation, including root-region cases |
| ART-002 | Fixed local amplification; production latency external | Expiring readiness attestations and bounded reconciliation GET concurrency |
| ART-003 | Fixed | Bounded dual-region partial/divergent/unavailable observation |
| ART-004 | Fixed | Both owned stores close, failure aggregation and memoization |
| ART-005 | Fixed continuous gate | All package source thresholding and selected risk reviews; coverage run passed |
| ART-006 | Fixed | Presign signal/deadline and late-settlement suppression |
| ART-007 | Fixed | Command/output mapping with compile-time mismatch proofs |
| ART-008 | External, still open | Three AWS-only tests skipped; no substitute cloud proof |
| ART-009 | Fixed | Shared private endpoint/bucket/region primitives, distinct policies preserved |
| ART-010 | Fixed | Exact verbose delete acknowledgement validation |
| ART-011 | Intentional retained safeguard | Unbundled command constructors and actual image work; no unsupported bundler requirement |
| ART-012 | Fixed | PUT and HEAD share caller/deadline; ownership tests |
| ART-013 | Fixed | Borrowed-vs-owned SDK client cleanup contract |

### Integrations component

| ID | Independent disposition | Evidence |
| --- | --- | --- |
| INT-001 | Fixed original signal propagation | Provider/KMS call sites pass invocation/operation signals; node completion uses queue signal |
| INT-002 | Fixed original detached marker settlement | Secure HTTP awaits authoritative marker outcome; this does not fix missing atomic connection argument IWA-03 |
| INT-003 | Fixed translation behavior; composition assurance remains | Real adapter error translation and safe executor errors; require interleaving tests for IWA-03 |
| INT-004 | Fixed | Credential/header schemas use the shared field predicate |
| INT-005 | Fixed | Shared envelope core owns AES/KMS protocol and buffer rules |
| INT-006 | Fixed continuous coverage baseline | Package thresholds and integrations risk cohort now run; not global completeness |
| INT-007 | Fixed | Owned response chunks/pending buffers cleared through finally paths |
| INT-008 | **Partially fixed; broader closure incorrect** | Allocation/output bound fixed, but IWA-08 reproduces near-match CPU work beyond timeout; original finding explicitly required time ceilings |
| INT-009 | Continuous safeguard | IANA address snapshot/checker and regression corpus; do not mistake drift check for all URL classes |
| INT-010 | External, still open | No credentialed provider/KMS canaries performed |
| INT-011 | Fixed original telemetry ownership | Bounded provider observer; automatic HTTP span privacy is separate IWA-14 |
| INT-012 | Fixed | Unused local constant/surface removed |
| INT-013 | External performance evidence | No representative production connection-pool/provider benchmark |
| INT-014 | Fixed | Parse/error classification guard in current implementation |

### Observability component

| ID | Independent disposition | Evidence |
| --- | --- | --- |
| OBS-001 | Fixed original structured-log keys | Bounded classifier and hostile secret-key tests |
| OBS-002 | Fixed | Fail-safe hostile getter/proxy/error handling |
| OBS-003 | Fixed | Bounded Nest call-shape/stack parser and level tests |
| OBS-004 | Fixed continuous gate | Structural, Prometheus 24-rule and collector validation passed |
| OBS-005 | Baseline fixed; wording overstates root risk scope | Package coverage enforced, but root risk report's selected cohorts do not include observability; package thresholds are the actual control |
| OBS-006 | External obligation remains; “repository complete” qualified | Live backend/access/sampling/retrieval unproven; IWA-14 is a repository-controlled privacy defect, not excused by this external status |
| OBS-007 | Fixed | Execution-storage observer required by contract and substitutes |
| OBS-008 | Fixed | Negative/nonfinite duration rejection |
| OBS-009 | Fixed breadth declaration; privacy not certified | Eight explicitly constructed/pinned adapters; defaults leak query attributes IWA-14 |
| OBS-010 | Fixed | Safe nonnegative timer input range and tests |

### Queue component

| ID | Independent disposition | Evidence |
| --- | --- | --- |
| QUEUE-001 | Fixed | Memoized bounded producer close/fallback |
| QUEUE-002 | Fixed | Exact own-key hostile-envelope parsing |
| QUEUE-003 | Fixed compatibly | Active jobs separate from retained schemas |
| QUEUE-004 | Fixed | One transport identity check before dispatch |
| QUEUE-005 | Fixed | Shared bounded Redis endpoint policy across four consumers |
| QUEUE-006 | Baseline fixed; root risk wording too broad | Package thresholds enforced; selected root risk report does not itself include queue |
| QUEUE-007 | Fixed continuous | Retained fixtures and public surface tests |
| QUEUE-008 | Fixed | Unreferenced advisory publisher timer |
| QUEUE-009 | Fixed continuous integration | Pinned real ioredis instrumentation ownership test; unit cohort excludes integration |
| QUEUE-010 | Fixed | Registry entries frozen without freezing Zod internals |
| QUEUE-011 | Fixed | Verified unused aliases/subpaths removed; explicit export surface |
| QUEUE-012 | Fixed | Isolated transport tracking/residual cleanup and resilience test passed |

### Rate-limit component

| ID | Independent disposition | Evidence |
| --- | --- | --- |
| RL-001 | Fixed | Failed-connect reset/recovery and terminal close state |
| RL-002 | External topology obligation | Nonclustered replicated primary is intentional; deployment still needs proof |
| RL-003 | Fixed | Endpoint/window/counter identity/limit/uniqueness validation before Redis |
| RL-004 | Fixed | Full policy subject/dimension matrix; add real multi-counter rejection coverage as assurance |
| RL-005 | Fixed | Real production Redis runtime connection-kill/recovery integration |
| RL-006 | Fixed continuous | Package coverage thresholds/root invocation pass |
| RL-007 | Fixed | API metric dimension uses finite contract |
| RL-008 | Fixed | Policy-owned key compatibility version |

### Lifecycle-command component

| ID | Independent disposition | Evidence / required change |
| --- | --- | --- |
| LC-001 | **Still open P2, confirmed** | `apps/lifecycle-command/src/run.ts:42` catches expected active `signal.reason`, records failure, then `:94` throws AggregateError; main treats it as fatal. Distinguish expected abort while preserving real cleanup errors; test active SIGTERM rejection and clean exit |
| LC-002 | **Still open P2 assurance gap** | No subprocess/main/readiness-marker test; current tests abort after processNext resolves. Add real signal/bootstrap/marker cleanup test, not a blanket line-coverage target |

### Workflow-engine component

| ID | Independent disposition | Current implementation evidence |
| --- | --- | --- |
| WFE-001 | Fixed | Shared bounded persisted fact-window contract matches database |
| WFE-002 | Fixed | Structured body projected once, linear visitation regression |
| WFE-003 | Fixed | Completed outputs/outcomes/nodes/invocations indexed/prepared once |
| WFE-004 | Fixed selected continuous gate | Consequence-selected/per-file floors and hashed reviews; not whole-state assurance |
| WFE-005 | Fixed | Current checkpoint IDs/timestamps/bytes match persistence admission |
| WFE-006 | Fixed | Single hostile-object traversal at public checkpoint/executable boundary |
| WFE-007 | Fixed | Shared allocation-free scope equality/prefix helpers |
| WFE-008 | Generative testing added; coverage continuous | Seeded shrinkable tests are real; IWA-04/05 demonstrate missing legal combinations, not absence of generative testing |
| WFE-009 | Fixed | Duplicate declaration equality includes durable scope/topology |
| WFE-010 | Fixed | Narrow public facade with exact export test |
| WFE-011 | Fixed | Purpose-named primitive ownership |
| WFE-012 | Intentionally retained compatibility | Breaking-release/zero-consumer retirement milestone; durable identities preserved |

### Workflow-model component

| ID | Independent disposition | Current implementation evidence |
| --- | --- | --- |
| WM-001 | Fixed | Publish validates missing/non-upstream/unrelated/cross-body mappings |
| WM-002 | Fixed by explicit design | Bounded one-shot expression workers; construction failure and capacity recovery |
| WM-003 | Fixed | Shared aggregate nested graph limits at browser/server seams |
| WM-004 | Fixed | Shared 100-issue validation cap |
| WM-005 | Fixed | Own dense-array descriptors; hostile/inherited/accessor/extra-key cases rejected |
| WM-006 | Fixed | Minimal evaluator port and composition-owned preview evaluator |
| WM-007 | Fixed | Startup deadline covers ready-to-start handoff and bounded termination |
| WM-008 | Fixed | Checked compiled expression runtime, explicit dynamic worker ownership |
| WM-009 | Fixed | Strict failure-delivery discriminated states |
| WM-010 | Fixed continuous gate | Canonical depth/override bounds and package coverage |
| WM-011 | Fixed with retained cohesive complexity | Invocation identity/worker owners and explicit facade; sequencing-sensitive internals retained |
| WM-012 | Fixed | Strict discriminated invocation scope before formatting/hashing |

### Nodes-core component

| ID | Independent disposition | Current implementation evidence |
| --- | --- | --- |
| CORE-001 | Original validation parity fixed | Strict Schedule V2/V3 shared with DB/engine/catalog; DST algorithm IWA-01 is separate |
| CORE-002 | Original schema contract fixed | Versioned strict Parallel/Merge ledger contracts; IWA-04/05 concern scheduling composition |
| CORE-003 | Fixed | Typed server registration joins exact definitions/executors and rejects orphan/missing/duplicate |
| CORE-004 | Fixed | Strict trigger envelope/runtime-only metadata, retained fingerprints |
| CORE-005 | Fixed | Recursive owned manifest immutability |
| CORE-006 | Fixed continuous gate | Package execution/coverage floors through public SDK boundary |
| CORE-007 | Fixed | Six behavior-owned suites and full node-owner layout check |
| CORE-008 | Fixed | Unused terminal alias removed; canonical SDK identity used |

### Node-SDK component

| ID | Independent disposition | Current implementation evidence |
| --- | --- | --- |
| SDK-001 | Fixed | Synchronous marker state prevents concurrent duplicate marker; race/rejection tests |
| SDK-002 | Fixed | Own hostile keys preserved as data through canonical copy/release roundtrip |
| SDK-003 | Fixed | Dense-array own-key/descriptor parity |
| SDK-004 | Fixed under explicit compatibility policy | Runtime-only metadata annotation distinguished from structure, additive V3 evidence with retained identities |
| SDK-005 | Resolved by deletion/explicit boundary | Unused phantom abstractions removed; callable provider boundaries intentionally reparse |
| SDK-006 | Fixed | Identity/JSON/contracts/errors/canonical owners behind stable facades |
| SDK-007 | Fixed continuous gate | Package coverage plus UTF-8/padding/long-input hash vectors |
| SDK-008 | Fixed | Safe integer limits and exception-total hostile reflection handling |
| SDK-009 | Fixed additively | V2 explicit executor ABI; V1 parse/fingerprint preserved |
| SDK-010 | Fixed | Successor exactly next epoch and changed fingerprint |

### Node-catalog component

| ID | Independent disposition | Current implementation evidence |
| --- | --- | --- |
| NC-001 | Fixed | Independent release-history golden fingerprints |
| NC-002 | Fixed | Single transition/cohort composition owner, golden/cohort tests |
| NC-003 | Fixed | Only release-selected provider executors constructed; getter-spy tests |
| NC-004 | Fixed | History/definition/server/package test ownership separated |
| NC-005 | Fixed continuous gate | Package-owned coverage invoked by root/CI |
| NC-006 | Fixed | Definition resolution accepts unknown and owns validation |

### Contracts component

| ID | Independent disposition | Current implementation evidence |
| --- | --- | --- |
| CON-001 | Fixed | Client/OpenAPI references and path parameters resolve; seven OpenAPI documents validate |
| CON-002 | Fixed | Recursive graph schema represents authoritative structure/limits |
| CON-003 | Fixed continuous gate | Deterministic generation plus pinned structural validation |
| CON-004 | Fixed | Shared typed package-private assembly with domain-local routes |
| CON-005 | Fixed expressible parity | Projected bounds and documented runtime-only refinements with differential tests |
| CON-006 | Fixed | Domain subpaths, root aggregation import guard |
| CON-007 | Fixed | HTTP field-value control-byte/Latin-1 corpus |
| CON-008 | Fixed | Strict lifecycle/delivery state variants |
| CON-009 | Fixed continuous gate | Package thresholds and source-hashed selected risk review |
| CON-010 | Fixed | Browser-safe canonical problem manifest shared by consumers |
| CON-011 | Fixed | List/artifact/export registry ownership and removed unused aliases |

### Database component

| ID | Independent disposition | Current implementation evidence |
| --- | --- | --- |
| DB-001 | Fixed | Shared bounded observation-window contract; same original issue as WFE-001 |
| DB-002 | Pool ownership fixed; capacity qualified | Process-shared runtime pools/monitors; IWA-09 finds omitted deployment surge in aggregate budget |
| DB-003 | Fixed original external-I/O lock pattern | Lifecycle/control coordination releases/reacquires authority around external work with fenced reconciliation |
| DB-004 | Runner modes fixed; timing external | Explicit execution plan and per-mode migration tests; deployed lock/duration proof remains DB-011 |
| DB-005 | Fixed original fact batching | Indexed/batched observation loading and query-plan regression suite; production cardinality external |
| DB-006 | Fixed continuous CI control | Unit/integration Istanbul merge and validated coverage reporting; local selected unit coverage is not the merged global denominator |
| DB-007 | Fixed | Pool/query/lock diagnostic ownership and bounded failure telemetry |
| DB-008 | Fixed original publication query scaling | Bounded publication query/projection path and regressions |
| DB-009 | Fixed where batching is safe | Transition writes batched without dropping individual fence/identity invariants |
| DB-010 | Normal transaction bounds fixed; cancellation caveat | Configured lock/statement/idle limits and hardened tenant engine; maintenance QueryConfig.signal alone does not cancel installed pg queries, so earlier abort than SQL timeout is not proved |
| DB-011 | External/open | Representative production query plans, write/index cost and connection workload evidence absent |
| DB-012 | Fixed continuous schema control | Real migrated catalog checked against typed schema/raw SQL registry |
| DB-013 | Intentionally retained cohesive complexity | Capability-local owners and stable interfaces; transaction sequencing not fragmented mechanically |
| DB-014 | Fixed | Shared persisted/configuration primitives and explicit role-specific differences |
| DB-015 | Fixed local aggregation | Shared runtime/monitor telemetry ownership; deployed signal usefulness external |
| DB-016 | Repository retirement inventory fixed; continuous/external | Published checksum/retained identity rules explicit; actual deployed zero-consumer inventory required before removal |
| DB-017 | External/open | Actual backup/PITR/restore, failover, vacuum/pooler and production recovery evidence not supplied |

The new DST, replay-retention, and invalid-option cleanup defects are not evidence that all original DB remediations failed. DB-010's configured SQL bounds are real; the ignored AbortSignal is a narrower maintenance cancellation limitation, not an infinite-query claim.

### Historical F-series retained in progress references

The original register was recovered read-only from `c9bb457:docs/whole-repository-audit.md` (audit baseline `8debd0090a972921ce523b0f7809558f6ba7c10d`). These are historical identities, not additional current A-series findings. Current code was compared with the original subject, rather than inferring closure from commit messages alone.

| ID | Independent current disposition | Subject / current evidence |
| --- | --- | --- |
| F-01 | Fixed | Independent OIDC browser binding, digest consume and HTTP cookie tests |
| F-02 | Fixed | Complete shared rate-limit policy/runtime; local Redis tests |
| F-03 | Fixed original transaction divergence | Shared hardened coordinator/attempt tenant engine and real PG tests |
| F-04 | Fixed | Required service cohorts have fail-on-skip/minimum-run gates; actual exact-head API CI 16/16 |
| F-05 | Repository governance implemented; conditional external review | Protected checks/ruleset evidence exists; independent nonauthor review remains dependent on maintainer policy |
| F-06 | Still external/open | Live AWS, load, failover, PITR, regional restore and pager evidence; current A-04 |
| F-07 | Fixed | Replica identity cardinality migration and tests |
| F-08 | Fixed | Least-capability DB entrypoints and consumers |
| F-09 | Fixed original connection persistence issue | Connection capability-local persistence/validation; new dispatch interleave IWA-03 separate |
| F-10 | Fixed original legacy execution issue | Retained execution path and compatibility fixtures |
| F-11 | Fixed local SSE latency behavior | Durable backfill/live subscription and independent Redis-loss exercise |
| F-12 | Fixed | CI partitioning and service-specific gates |
| F-13 | Fixed | Immutable CI image inputs and update procedure |
| F-14 | Repository ownership fixed; live part external | Role-specific deployment/operations ownership; cloud verification still F-06 |
| F-15 | Fixed targeted structural/sleep work; controlled debt | Named decomposition, owner-local tests, retained clock-dependent proofs |
| F-16 | Fixed | Coverage diagnostics explicitly selected, not repository-wide |
| F-17 | Fixed original unsafe assertion issues | Checked adapters/runtime seams and typed contract tests |
| F-18 | Fixed | Engine type ownership separated from implementation wiring |
| F-19 | Continuous retirement safeguard | Reference inventory exists; current migration-head prose drift IWA-12 |
| F-20 | Fixed onboarding consolidation; ongoing accuracy | Current-status/operations/audit documentation exists; semantic drift requires maintenance |

### Earlier structural A-series in implementation-progress

| Historical ID | Disposition and identity (not current whole-audit identity) |
| --- | --- |
| A-05 | Coordinator-store transaction/observation/write decomposition implemented |
| A-06 | Engine/schema/checkpoint/executable decomposition implemented |
| A-07 | Node-attempt and preview persistence decomposition implemented |
| A-08 | Database authority entrypoints and capability imports narrowed |
| A-09 | Test-suite decomposition implemented |
| A-10 | Phase 7 progress granularity improved; live completion still open |
| A-11 | Readiness-hash governance implemented |
| A-12 | Unsafe optional-capability cast removed under TypeScript cleanup |

There are no A-01–A-04 entries in that structural progress subsection. Historical wording is preserved as historical; it is not automatically a current-status contradiction. Incorrectly broad closures established here are INT-008 (CPU remains), OBS-005/QUEUE-006 root-risk wording (package thresholds exist but those cohorts are not in the selected report), and OBS-006's claim that repository configuration is complete (IWA-14). Original A/C fixes generally remain genuine; new invariant defects do not undo unrelated remediations.

## 17. New findings ordered by severity

All findings below are repository-controlled unless explicitly qualified. Severity is consequence-based: P1 blocks release because a normal supported path can violate a critical invariant; P2 is a material functional, reliability or assurance defect; P3 is bounded tooling/documentation/configuration debt. No P0 was established. Passing current automated gates do **not** detect these reproductions unless a compensating control is noted.

### IWA-01 — P1: DST recurrence can trap the worker synchronously

- **Confidence / classification:** confirmed; correctness, reliability.
- **Location:** `packages/database/src/triggers/schedule-recurrence.ts:128`, `:197`, `:207`; called by `packages/database/src/triggers/schedule-triggers.ts` during due-schedule reconciliation.
- **Evidence:** built `resolveScheduleObservation(parseScheduleRecurrence({kind:'cron',expression:'*/5 * * * *',timezone:'Europe/Berlin'}), new Date('2026-01-01T00:00:00Z'), new Date('2026-10-25T01:00:00Z'))` did not return and was killed by a two-second external alarm (exit 142). A control at `2026-10-24T01:00:00Z` returned the expected `01:05Z` next occurrence in 17.89 ms. A New York fallback case was also identified by the database reviewer.
- **Root cause:** ambiguous local times are canonicalized to the first UTC occurrence. Feeding the canonicalized date back to `nextCronOccurrence` can map the later duplicate back to an earlier candidate. The `while` loop has no monotonic raw cursor invariant or bound, so repeated-hour progress cycles.
- **Impact:** one valid due schedule can occupy the event loop indefinitely; timers, cancellation and other work in that worker cannot progress. This is not a slow cron query or merely duplicate occurrence generation.
- **Change:** separate monotonic raw cron traversal from local-identity deduplication; bound traversal and fail closed if progress is violated.
- **Verification:** subprocess tests for both repeated-hour halves, every-five-minute and sparse recurrences, Europe/Berlin and America/New_York, spring-forward and misfire controls; assert termination, no duplicate logical local occurrence, and next time strictly after observation. Run real schedule acceptance/recovery tests.
- **Requirement / detection:** plan Schedule and resource safety; ADR 014. Current unit/integration/root checks pass and miss this combination.

### IWA-02 — P1: Rendered production configuration cannot run the intended API/worker

- **Confidence / classification:** confirmed; reliability, deployment correctness.
- **Location:** `infrastructure/ecs/workloads.json:21` and `:60`; `infrastructure/ecs/render-task-definitions.mjs:44`; `apps/api/src/platform/config/api-config.ts:254`.
- **Evidence:** the API manifest omits `CONNECTION_KMS_KEY_REFERENCE`, `CONNECTION_KMS_REGION`, and `TRUST_PROXY_CIDRS`. The renderer emits only listed values. With otherwise-valid production settings (including a synthetic trusted proxy), parsing failed with `Connection KMS configuration is incomplete`; adding the KMS pair passed. Without the extra trusted-proxy setting, the next error is `TRUST_PROXY_CIDRS is required when deployed` (`api-config.ts:222`). Worker rendered-like configuration produced `enabledJobNames: []`, cohort `core`, no connection encryption, and development-default service version. Its manifest does not express `OUTBOX_DISPATCH_JOB_NAMES` or `NODE_COMPATIBILITY_COHORT` activation.
- **Root cause:** the manifest and configuration schemas evolved independently; deployment validation checks structural fields but not each role's actual parsed runtime contract.
- **Impact:** the API fails startup with the supplied task-definition workflow. After patching just the API, the worker can still do no outbox work and cannot execute the intended provider cohort. This is a checked-in deployment contract defect, not an unconfigured optional live AWS exercise.
- **Change:** explicitly include all required nonsecret/secret settings, cohort/job activation and release identity; derive/check role configuration against the actual parsers. Keep credentials in secret injection, not environment literals.
- **Verification:** render synthetic production definitions, resolve their configuration/secret placeholders safely, parse each role's environment, and assert enabled jobs/cohort; bootstrap the real image with controlled dependencies. A module-import smoke alone is insufficient.
- **Requirement / detection:** plan deployment units/complete vertical slice; ADRs 028/030. `pnpm deployment:check` and image role imports passed despite this defect.

### IWA-03 — P1: HTTP/Slack drop the atomic connection fence before dispatch

- **Confidence / classification:** confirmed; security, correctness.
- **Location:** `packages/integrations/src/provider-dispatch-fence.ts:38` and `:51`; `apps/worker/src/execution/node-attempt-handler.ts:329`; `packages/database/src/execution/node-attempt-run-store-dispatch.ts:33`.
- **Evidence:** the helper awaits `connections.assertCurrent(...)`, then calls bare `runtime.beforeDispatch()`. The SDK supports a connection fence, the worker forwards it only if provided, and DB dispatch checks it only when supplied. A controlled interleave revoked the connection immediately after `assertCurrent`; the marker was invoked with no fence while revoked, and the helper resolved. HTTP and Slack use this helper; email passes the fence atomically.
- **Root cause:** standalone validation and the marker are separate transactions. The helper discards the connection/version identity needed by the authoritative marking transaction.
- **Impact:** rotation or revocation can commit between those operations, yet stale credential bytes may still be sent to the provider. A prior successful check is not current dispatch authorization.
- **Change:** pass the exact connection/provider/auth/version fence through `runtime.beforeDispatch`, and retain the DB lock/check atomically with the dispatch marker. Do not merely add a second standalone check.
- **Verification:** real worker/PG interleave test rotating or revoking after initial resolution/check but before marking; no provider call and no authorized dispatch marker. Also test rotation after the marker with truthful ambiguity semantics, and preserve email behavior.
- **Requirement / detection:** plan connection rotation, privilege boundaries and side-effect slice; ADRs 007/023. Existing check-failure tests do not exercise this interleave; current gates pass.

### IWA-14 — P1: Default HTTP tracing captures OAuth callback query credentials

- **Confidence / classification:** confirmed; security/privacy.
- **Location:** `packages/observability/src/telemetry.ts:40` and `:71`; `apps/api/src/identity-workspace/controllers.ts:99`; `infrastructure/observability/otel-collector.yaml:16`.
- **Evidence:** shared telemetry installs `new HttpInstrumentation()` without query sanitization and exports traces. A primary-reviewer local HTTP probe using the installed instrumenter and an in-memory exporter captured two spans: server `url.query` was exactly `code=AUDITCODE&state=AUDITSTATE&token=AUDITTOKEN`; client `url.full` contained the same query. The ordinary OIDC callback accepts code/state. The repository collector drops process identity, not query attributes. Structured logger redaction is not on this span path.
- **Root cause:** privacy controls are implemented for log/provider payloads but not automatic HTTP span attributes.
- **Impact:** credential-like OAuth artifacts and query data can be transmitted to the configured telemetry backend. Short-lived/single-use authorization codes reduce replay opportunity but do not justify copying authentication material into tracing storage.
- **Change:** remove or allowlist query information before export for incoming and outgoing HTTP/Undici instrumentation, including legacy/current semantic-convention attributes. Preserve useful route templates and bounded status attributes.
- **Verification:** run actual instrumented local callback and provider-like requests with synthetic code/state/opaque secrets; inspect exported spans and assert no secret in attributes/events. Check both successful and error paths, without relying on logger tests or only collector configuration parsing.
- **Requirement / detection:** plan secret privacy and observability safety; ADR 004. Existing OBS-006 external backend evidence is separate: the unsafe span is formed by repository configuration. Current tests do not detect it.

### IWA-04 — P2: Nested Parallel ignores its configured concurrency

- **Confidence / classification:** confirmed; correctness, resource reliability.
- **Location:** `packages/workflow-engine/src/transition-decisions.ts:15` and `:24`.
- **Evidence:** a legal compiled executable with a For Each body containing Parallel (`maxConcurrency: 1`) produced attempts for both `body-left` and `body-right` in one advance. The temporary `engine-probes.ts` builds/validates the executable, advances normal successful observations and asserts the two admissions.
- **Root cause:** the limit lookup indexes only `schedulerState.nodes`; structured-body nodes live under `structuredBodies`. Missing nested lookup becomes `{}` and therefore no constraint. Scope keys also deserve iteration-aware regression tests when repaired.
- **Impact:** user-selected provider concurrency is exceeded inside a supported structured body; downstream rate/cost/load assumptions fail even though overall admission remains bounded.
- **Change:** resolve nodes and active counters by complete branch/iteration/body scope; avoid a top-level-only map or global node counter that conflates loop iterations.
- **Verification:** real executable and coordinator tests for nested Parallel in one and several loop iterations, limits 1/N, active attempts, retries and reconstruction; assert both no over-admission and no erroneous cross-iteration throttling.
- **Requirement / detection:** plan bounded parallelism; ADRs 008/019/020. Existing 257 engine unit tests and full checks pass.

### IWA-05 — P2: A skipped Parallel branch can schedule Merge without a join

- **Confidence / classification:** confirmed; correctness.
- **Location:** `packages/workflow-engine/src/graph-scheduler.ts:242`, `:277`, `:318`; `packages/workflow-engine/src/workflow-transition-derived.ts:38`.
- **Evidence:** a legal Condition(false) graph whose true path contains Parallel/left/right/Merge skips the Parallel and branch nodes, completes the false terminal, then returns a running `merge` attempt while checkpoint `joins` is empty. Worker input derivation supplies no settled join input; core Merge rejects with `attempt_invalid` rather than completing the selected path.
- **Root cause:** descendant skip propagation stops at Merge, while readiness accepts skipped predecessors. Join declaration requires a succeeded Parallel, so neither path establishes valid Merge semantics.
- **Impact:** a valid workflow fails merely because the selected branch bypassed a Parallel region. No downstream secret exfiltration or arbitrary side effect is asserted.
- **Change:** model skip/reachability across a paired Parallel/Merge region consistently; do not admit Merge without a valid join or explicit skipped disposition.
- **Verification:** legal Condition and Switch graphs bypassing nested/top-level Parallel/Merge; crash/duplicate reconstruction before and after skipping; assert no Merge attempt without a join and correct terminal result.
- **Requirement / detection:** plan skipped-branch/join recovery; ADRs 017/018/019. Current unit/property suites miss this legal topology.

### IWA-06 — P2: Replay lineage can wedge run-summary retention

- **Confidence / classification:** confirmed; data-lifecycle correctness, reliability.
- **Location:** `packages/database/migrations/0055_standard_retention_classes.sql:371`; `packages/database/migrations/0065_operator_run_replay.sql:15`.
- **Evidence:** current effective `execute_standard_retention_page` deletes old detail-purged runs while excluding webhook/schedule references, but not replay children. `0065` adds `workflow_runs_replay_source_fk` with default NO ACTION. A fresh database migrated through `0075`, with an old source and a replay child, raises PostgreSQL `23503` naming that FK when the source is selected without the child. Larger pages only mask it if both happen to qualify and be deleted together; a newer child does not qualify.
- **Root cause:** a later lineage relationship was not integrated into the existing bounded deletion recipe.
- **Impact:** a retention page rolls back repeatedly, retaining eligible summaries and potentially blocking unrelated candidates in that page. This is not demonstrated data loss and is not severity P1.
- **Change:** preserve referenced sources until safe, or define explicit lineage lifecycle semantics and an ordered bounded deletion strategy. Do not cascade away a retained child merely to silence the FK.
- **Verification:** default page-size real PG tests with source older than 90 days and a newer/active replay; page boundary and replay chain cases; eventual deletion when all references expire; legal-hold and tenant isolation controls.
- **Requirement / detection:** retention/replay lifecycle; ADRs 013/029. Existing migrations and integration tests pass, lacking this cross-feature case.

### IWA-07 — P2: Valid hexadecimal-looking hostnames are rejected as IP literals

- **Confidence / classification:** confirmed; correctness.
- **Location:** `packages/integrations/src/http/secure-http.ts:575`.
- **Evidence:** the built secure client rejected `https://cafe.de` with `ssrf_blocked` before invoking a fake public DNS resolver. `https://example.de` resolved to the same public address and succeeded. No outbound request was made.
- **Root cause:** after IP validation throws, `/^[0-9a-f:.]+$/iu` treats a DNS name composed of hexadecimal letters and dots as an invalid/nonpublic IP literal.
- **Impact:** legitimate public integration endpoints in this spelling class cannot be called. It fails closed; it does not permit internal-address access.
- **Change:** use syntactic IP-literal detection distinct from public-address policy, then resolve ordinary DNS hostnames and apply the existing public-address checks to every answer.
- **Verification:** positive DNS names such as `cafe.de`/`dead.be`, normal names and mixed-case/trailing-dot forms; negative IPv4/IPv6/mapped/ambiguous literal variants; preserve DNS rebinding/redirect tests.
- **Requirement / detection:** V1 generic HTTP functionality and SSRF boundary. Existing SSRF tests pass but do not include this valid-hostname class.

### IWA-08 — P2: Streaming redaction remains CPU-heavy beyond its timeout

- **Confidence / classification:** confirmed; performance, abuse resistance.
- **Location:** `packages/integrations/src/http/secure-http.ts:669`, `:789`; allowed sensitive-value bounds at `:564`.
- **Evidence:** a fake transport returned 262,144 repeated `a` bytes with sensitive pattern `a.repeat(1023)+'b'`, all within configured input bounds. With a 5 ms timeout the operation completed after 265.10 ms. A primary follow-up using a realistic 65,536-byte chunk resolved in 74.29, 130.20 and 121.73 ms at the same 5 ms timeout. The scan checks every pattern at every byte; long common prefixes force repeated comparisons. Memory was bounded; CPU work was not.
- **Root cause:** naive byte-position × pattern × prefix scanning runs synchronously. Timeout signals cannot fire while this work blocks the event loop, and already-buffered chunks can continue through microtasks.
- **Impact:** adversarial near-matching responses/credential values delay unrelated jobs and timer-based cancellation. The measured latency is local evidence, not a production throughput extrapolation.
- **Change:** use a bounded multi-pattern matching strategy or cooperatively budget/yield work with correct cross-chunk redaction; enforce deadline by elapsed time as well as signal state where necessary.
- **Verification:** 64 KiB realistic chunks and bounded large responses, maximum allowed pattern length/count, overlapping/near-matching patterns, cancellation responsiveness and memory ceiling. Preserve exact cross-chunk secret removal and output budget behavior.
- **Requirement / detection:** plan CPU/deadline/abuse limits; existing INT-008 memory fix is real but its broader CPU/performance closure is incomplete. Current tests do not catch this workload.

### IWA-09 — P2: Connection budget omits permitted rollout overlap

- **Confidence / classification:** confirmed contract mismatch; reliability.
- **Location:** `infrastructure/ecs/validate-database-connection-budget.mjs:106`; `infrastructure/ecs/database-connection-budget.json:3`; `infrastructure/ecs/external-platform-contract.json:99`.
- **Evidence:** budget accepts steady 382/400 connections with API 20×6 and worker 20×9. The ECS contract allows 200% rollout task count. At configured maxima, just API overlap adds 120 (502 total); worker overlap adds 180 (562); simultaneous overlap permits 682. AWS documents the old/new task overlap semantics (source in section 3).
- **Root cause:** calculation counts autoscaling steady maxima and auxiliary pools, not deployment surge.
- **Impact:** an allowed rolling release at high scale can compete for connections beyond the declared database cap, degrading readiness and rollout. No actual production exhaustion is claimed.
- **Change:** include permitted surge/overlap and maintenance operations, or constrain deployment/rollout sequencing and max scale to a tested capacity envelope.
- **Verification:** controlled-negative budgets for API-only/worker-only/simultaneous rollout and reserved connections; real deployment/load evidence near allowed maxima.
- **Requirement / detection:** plan independent scaling/capacity; ADRs 012/028/030 and existing DB-002/DB-011 external capacity boundary. Current budget/deployment checks pass.

### IWA-10 — P2: Authenticated user replay API is absent

- **Confidence / classification:** confirmed; product/spec correctness.
- **Location:** `apps/api/src/workflow-runs/controllers.ts:81`; authoritative plan `docs/workflow-platform-backend-plan.md:1953` and `:2071`.
- **Evidence:** plan requires `POST /v1/workspaces/:workspaceId/runs/:id/replay` → `ReplayWorkflowRun`, creating a new explicitly pinned run. Current API controllers/use cases/contracts expose run start/read/list/events/cancel, not this replay operation. Operator command replay exists under a different authority and workflow.
- **Root cause:** operational replay was implemented without reconciling the separate user-facing endpoint requirement.
- **Impact:** authorized users cannot perform the specified replay/version-selection flow through the public API. Reusing start-run is not equivalent unless lineage, version/input policy, permissions, idempotency and audit semantics are defined.
- **Change:** implement the planned authenticated replay slice, or obtain an explicit plan/ADR product decision deferring it. Do not silently treat operator privilege as the API replacement.
- **Verification:** OpenAPI/client contract, unauthorized/cross-workspace denial, explicit original/current version semantics, expired/retired replay rejection, idempotency mismatch/concurrency, new lineage and audit event; real HTTP/PG tests.
- **Requirement / detection:** public endpoint-to-use-case map and user replay semantics; ADR 029 is complementary. Existing contract-generation checks cannot detect a missing requirement.

### IWA-15 — P2: The planned executable Validate node is absent

- **Confidence / classification:** confirmed absence; product/spec correctness.
- **Location:** `docs/workflow-platform-backend-plan.md:58`; `packages/nodes-core/src/registrations.ts:71` and `packages/nodes-core/src/definitions.ts:1`.
- **Evidence:** the authoritative V1 executable surface lists Validate separately from Set/Map. The complete node definition/executor registry and catalog contain no Validate node, schema, executor, release identity or tests. Draft validation and preview validation are API operations, not an executable step in the webhook→validate/map journey.
- **Root cause:** the V1 scope item did not receive a vertical slice or an explicit deferral/alternative decision; its detailed runtime behavior is also underspecified.
- **Impact:** users cannot author the specified validation step with an explicit schema/result/failure contract. Generic mapping or Condition may express some checks, but the plan does not designate those as the replacement.
- **Change:** decide the validation semantics and implement the complete versioned node slice, or explicitly amend the plan/ADR to defer it or define the supported replacement. Do not invent a placeholder publishable node merely to satisfy an inventory.
- **Verification:** normative behavior/limits, input/output schemas, browser/runtime parity, executor registration, publication/materialization/recovery and success/failure tests; or a clearly approved product-scope change.
- **Requirement / detection:** plan V1 core surface and vertical-slice completion rule. Current registry tests check declared definitions against declared executors, not the independent product inventory, so all gates pass.

### IWA-16 — P2: Workflow lifecycle and activation remain incomplete

- **Confidence / classification:** confirmed; correctness against product specification. Repository-controlled; no explicit deferral found.
- **Location:** `apps/api/src/workflow-authoring/controllers.ts:60`; `packages/database/src/authoring/workflow-authoring.ts:75` and `:183`; `packages/contracts/src/http/workflow-authoring.ts:41`; `packages/database/src/authoring/workflow-authoring-rows.ts:80`.
- **Evidence:** the controller and repository provide create/list/draft/save/validate/publish/version reads, but no archive or restore operation. The public activation schema and record type allow only `inactive`, and row projection supplies that constant. The plan separately requires archive/restore-version operations and normative workflow lifecycle/activation transitions. Existing webhook/schedule trigger operations do not supply this workflow-level contract.
- **Root cause:** the initial authoring foundation was not completed into the planned lifecycle and activation slice or reconciled with a revised product decision.
- **Impact:** users cannot archive/restore workflows through the specified product boundary, restore a version through a defined operation, or observe the planned activating/active/degraded/error state. This is a missing capability/representation, not proof that existing trigger execution never works.
- **Change:** define and implement lifecycle, version-restoration and aggregate activation semantics with durable trigger reconciliation, or explicitly amend the authoritative scope. Preserve immutable versions and completed runs; distinguish archive from cancellation.
- **Verification:** guarded HTTP/PG archive/restore tests, permissions and CAS/idempotency conflicts, trigger deactivation/reconciliation failure/recovery, truthful activation projection, version restoration without history mutation, and in-flight-run behavior.
- **Requirement / detection:** plan module map `docs/workflow-platform-backend-plan.md:599` and normative transitions `:914`. Existing authoring/schema tests verify the narrower implemented surface and pass; no independent required-operation inventory gate detects the omission.

### IWA-17 — P2: Planned public artifact upload and finalize API is absent

- **Confidence / classification:** confirmed; correctness against product specification. Repository-controlled; no explicit deferral found.
- **Location:** `apps/api/src/app.module.ts:124`; `packages/contracts/src/artifacts.ts:27`; authoritative endpoint map `docs/workflow-platform-backend-plan.md:2074`.
- **Evidence:** the map requires `POST /v1/workspaces/:workspaceId/artifacts/uploads` → `BeginArtifactUpload` and `POST /v1/workspaces/:workspaceId/artifacts/:id/finalize` → `FinalizeArtifactUpload`. Full API/controller/use-case review finds neither surface; generated HTTP contract domains contain no artifact API. The existing artifact-store runtime and worker artifact persistence are different consumers, not these authenticated upload operations.
- **Root cause:** internal artifact durability was implemented without the separately specified public ingestion slice or an approved deferral.
- **Impact:** API clients cannot obtain the specified pending upload metadata/signed URL and finalize a verified available artifact through the platform's public boundary.
- **Change:** implement the authenticated upload/finalize vertical slice, resolving how signed uploads satisfy current regional durability and ledger policies, or explicitly defer it in the authoritative plan. Do not expose a generic unrestricted object-store presigner.
- **Verification:** contracts and HTTP/real-storage tests for cross-workspace denial, quota/size/checksum/content restrictions, expiry and idempotency, finalize-before-object rejection, legal-hold/deletion races, abandoned pending cleanup and required regional durability.
- **Requirement / detection:** plan endpoint-to-use-case map `:2074–2075`. Existing artifact-store tests validate internal behavior; contract-generation checks cannot detect a missing declared product endpoint.

### IWA-11 — P3: Map/Object.keys disables application closure validation

- **Confidence / classification:** confirmed; tooling/testing.
- **Location:** `infrastructure/ecs/validate-deployment.mjs:104`.
- **Evidence:** `expectedCommands` is a Map; `Object.keys(expectedCommands)` is empty. Runtime dependency traversal starts only from database. Evaluating the unchanged validator with an in-memory Dockerfile view lacking the worker dist COPY still printed `ECS deployment contract is valid.`
- **Root cause:** object enumeration is used on a Map, and the negative test surface does not exercise each role's output closure.
- **Impact:** this validator cannot enforce its application runtime-closure claim. The current real image imports all roles successfully, and CI image imports are a compensating control; this is not a current broken image finding.
- **Change:** iterate Map keys and make per-role closure/output omissions fail; add checked typing or a narrow typed graph helper when touching this domain-shaped script.
- **Verification:** independent controlled negatives for every role and an app-only workspace dependency; retain real image imports.
- **Requirement / detection:** ADR 028; current A-03/C-04 packaging fix is real, while A-12/C-27 typed tooling debt now has concrete evidence. Current deployment validator misses it; image check compensates.

### IWA-12 — P3: Current operational status disagrees with implementation

- **Confidence / classification:** confirmed; documentation.
- **Location:** `docs/current-implementation-status.md:16`; `docs/implementation-progress.md:101`; `docs/operations/compatibility-retirement-inventory.md:23`; `docs/operations/release-security-gate.md:10`.
- **Evidence:** current-head prose says migration `0074`, while the migration set/readiness contract is `0075`; the compatibility inventory mixes these. Release-security text describes high/critical dependency admission while the actual script rejects moderate vulnerabilities.
- **Root cause:** mutable operational facts are duplicated across prose and executable policy without cross-checking those specific facts.
- **Impact:** operators/new maintainers may use the wrong readiness baseline or misunderstand the gate's failure threshold. Historical explicitly pinned prose is not included in this finding.
- **Change:** synchronize current status and reference the executable source for mutable facts; preserve historical evidence as historical.
- **Verification:** documentation check for current migration-head/policy references, plus manual runbook review.
- **Requirement / detection:** AGENTS progress accuracy and plan operations. Existing docs checks pass despite this semantic drift.

### IWA-13 — P3: Invalid migration options leak an acquired connection

- **Confidence / classification:** confirmed; resource ownership.
- **Location:** `packages/database/src/migrations.ts:232`–`:243`.
- **Evidence:** `new Pool` and `await pool.connect()` run before validating `lockTimeoutMs`/`statementTimeoutMs`; invalid values throw outside the later cleanup region. A reviewer probe observed the idle migration session remaining after the expected TypeError.
- **Root cause:** validation is ordered after acquisition, outside guaranteed release/end handling.
- **Impact:** invalid CLI/library configuration can retain an open connection and keep a failed invocation alive; repeated bad calls can consume resources. Normal valid migrations succeeded; this is not a production migration corruption finding.
- **Change:** validate options before constructing/acquiring resources, and ensure acquisition failure also closes owned pools.
- **Verification:** invalid options and connection-acquisition failure tests assert no retained session/handle; valid migration/checksum/advisory-lock tests remain green.
- **Requirement / detection:** plan resource ownership/migration safety. Current gates cover valid migration behavior, not this cleanup path.

## 18. External evidence still required

| Required evidence | Owner/control boundary | Release criterion |
| --- | --- | --- |
| Live workload roles, IAM/secrets/KMS/network/TLS | Platform/security owner | Exact immutable release, least privilege per role, no broad accidental authority; credentials never copied into reports |
| Frankfurt/Ireland artifact and ledger geography/Object Lock | Platform/storage owner | Actual bucket identity, versioning/retention, one-sided failure and restore evidence; three AWS-only tests pass |
| Signed hosted image provenance and promotion | Release owner | Verify signature/subject digest/source identity for promoted artifact, not merely local JSON metadata |
| Provider/KMS canaries | Integration owner | Safe credentialed HTTP/Slack/Resend/KMS contract tests for pinned implementations and retry horizons |
| Load/noisy-tenant/fairness/backpressure | Service/capacity owner | Representative engineering-envelope traffic, bounded queue/DB/provider load and tail latency |
| Aggregate pool capacity and rolling deployment | Platform/database owner | Steady + surge + maintenance concurrency within actual capacity, with reserved administration headroom |
| PostgreSQL failover, backups, PITR | Database/operator owner | Measured actual managed-service restoration/failover, correct write fencing and no hidden privilege dependency |
| Regional restore-before-serve | Recovery owner | Reconcile dual-region controls/artifacts, enforce deletion/holds and write admission, demonstrate RPO/RTO |
| Dashboards/traces/alerts/pager | On-call owner | Retrieve a real safe API→worker trace; prove alert delivery/acknowledgment and executable runbooks |
| Retention/legal holds/backup erasure | Product/legal/operator owner | Suitability of defaults and actual backup deletion/hold effectiveness, not just SQL tests |
| Identity vendor and review governance | Product/security/maintainer | OIDC deployment policy and documented independent-review capability |

These are not additional code defects or automatically P1 findings. They are mandatory release evidence where required by the plan and remain open until demonstrated. A local compatible service is useful verification, not a substitute for cloud policy or operational ownership.

## 19. Prioritized remediation sequence

1. Add reproducing regressions for IWA-01/02/03/14 and fix the monotonic schedule cursor, actual rendered role configuration, atomic connection fence, and trace query privacy. These are independent release blockers and should be coherent separate changes.
2. Repair the scoped scheduler model for IWA-04/05 together only if one coherent scope/reachability change addresses both. Use legal compiled fixtures, persistent reloads, and crash/duplicate tests; do not add isolated topology special cases.
3. Correct replay retention IWA-06 with a forward migration/defined lineage lifecycle, not a rewritten historical migration. Resolve authenticated replay IWA-10, executable Validate IWA-15, workflow lifecycle/activation IWA-16 and artifact upload/finalize IWA-17 with explicit product semantics or approved deferral; preserve existing operator semantics and durability controls.
4. Fix hostname classification and CPU-bounded redaction IWA-07/08, retaining the full SSRF/ownership/cross-chunk corpus. Add realistic pattern/chunk time tests with conservative deterministic budgets.
5. Close existing LC-001/002 with active-signal subprocess and readiness cleanup tests. Address maintenance driver cancellation explicitly where an earlier abort than SQL timeout is required.
6. Make capacity surge-aware (IWA-09), fix/type-check the validator with controlled negatives (IWA-11), validate migration options before resource acquisition (IWA-13), and synchronize current runbooks (IWA-12).
7. Rerun units, typed contracts, selected coverage, real-service/recovery/compatibility cohorts, deployment rendering, actual image startup/imports and security gates. Do not increase thresholds as a substitute for new state cases.
8. Only after repository blockers are resolved, execute release-bound cloud/provider/load/restore/pager evidence. Update the authoritative progress checklist and attach immutable results; do not mark Phase 7 complete from this audit.

Future implementation must follow incremental commit/push rules. This read-only audit intentionally created no commits or pushes, per the explicit task constraints.

## 20. Commands executed and exact results

Logs/probes were kept under `/tmp/pertexo-independent-audit.x0MLsS`, not committed. Routine `git ls-files`/status, `rg`, `sed`/`nl`, manifest and complete-file reads are grouped instead of listing thousands of inspection invocations as tests.

| Command / operation | Exact result |
| --- | --- |
| Git HEAD/status/upstream/remote-main reads | Baseline in section 2; clean start, ahead/behind 0/0 |
| `pnpm check` | Exit 0; format/docs/runtime/dependency/schema/build/lint/complexity/duplication/contracts/typecheck/unit gates passed |
| Root workspace unit suites | 1,898 assertions passed across 18 workspaces; breakdown below |
| `pnpm test:coverage` | Exit 0; all configured thresholds passed; risk report 105 files, 4,938 lines, 501 reviewed uncovered branches, 0 unreviewed |
| Dedicated Compose dependencies + ledger bootstrap | Exit 0, healthy PG/Redis/artifact/primary-ledger/recovery-ledger; unique project and nondefault ports |
| `pnpm db:migrate` in isolated environment | Exit 0; 76 SQL migrations `0000`–`0075` applied |
| `pnpm test:integration` in isolated environment | Exit 0; artifact 5 passed/3 AWS skips; queue 1; DB 330; worker 22; API 16/1 separately gated compatibility skip; total 374 passed/4 skipped |
| API compatibility rollout, explicit flag | Exit 0; 1 test passed, 4.73 s suite |
| API SSE Redis-loss resilience, explicit flag | Exit 0; 1 test passed, 7.72 s suite; detection 0.628 ms, health recovery 5,770.995 ms, backfill 5,784.204 ms, stop 288.676 ms |
| Worker transport resilience, explicit flag | Exit 0; 1 test passed, 17.02 s suite; queue-loss recovery 1,107.59 ms, Redis detection/recovery 508.90/5,475.27 ms, PG detection/recovery 0.545/5,571.66 ms, drain 0.635 ms, force-close 55.37 ms, no new claims 0 |
| `pnpm deployment:check` | Exit 0 despite IWA-02/IWA-09/IWA-11 |
| `pnpm security:audit` | Exit 0 at moderate severity |
| `pnpm observability:check`, separate audit project | Exit 0; YAML/Grafana, Prometheus config/24 rules and collector valid |
| `docker build --tag pertexo-independent-audit:faed09c .` | Exit 0; manifest `sha256:00548ed4e98bfea3b68d8fd948ad15532e6d0151034e775b92b2bffd0a409fe1`; index `sha256:59af8761fa9236e1e5b5e0e8da7f448c6382911d204e9d2e46be29773a64c147` |
| Read-only/non-root image import smoke | Exit 0; seven role modules imported; UID 10001, Node 24.18.1 |
| Exact-head GitHub CI/CodeQL read | Both successful; run links/analysis identity in section 12 |
| Hostname fake-resolver probe | `cafe.de` blocked before DNS; normal control succeeds, IWA-07 |
| DST subprocess probe | Killed by external 2-second alarm, exit 142; normal-day control 17.89 ms, IWA-01 |
| Temporary engine probe via `pnpm exec tsx` | Exit 0 reproducing two defects: two branches at cap 1; skipped Merge with no join |
| Production API parser negative/positive | Missing KMS pair fails exact message; adding pair passes, IWA-02 |
| Provider fence interleave | Revoked=true at marker; null fence argument, IWA-03 |
| Redaction CPU probes | 256 KiB/5 ms returns in 265.10 ms; 64 KiB returns in 74.29/130.20/121.73 ms, IWA-08 |
| Real PG replay-retention probe | `23503 workflow_runs_replay_source_fk`, IWA-06 |
| Invalid migration-option cleanup probe | Expected TypeError leaves idle acquired session, IWA-13 |
| Installed pg cancellation probe | Remains blocked after signal until lock release/SQL timeout; bounded caveat in section 9 |
| In-memory Dockerfile negative | Validator accepts omitted worker COPY, IWA-11; no tracked edit |
| Local HTTP + InMemorySpanExporter | Two spans contain synthetic query code/state/token, IWA-14 |
| Shell pipeline negative | `bash -e -o pipefail` grouped failure exits 1; masking hypothesis rejected |
| Final report Prettier check and `pnpm docs:check` | Exit 0; formatting passes; 6 documentation-validator tests pass, 53 local links across 72 validator-selected files validated at tree `d1b41b6` |

Unit counts (files/assertions): node-sdk 2/38; queue 11/55; observability 10/54; artifact-store 8/177; rate-limit 3/29; model 8/73; contracts 5/26; nodes-core 6/60; integrations 8/196; engine 23/257; catalog 4/19; database 63/192; operator 2/8; recovery 2/10; lifecycle 2/6; retention 3/11; API 66/409; worker 33/278. Repeated coverage/agent runs are not added to the unique count.

All prescribed repository suites run here passed. Adversarial probes intentionally produced failure/hang/unsafe acceptance. An initial standalone OTel probe failed transitive SDK module resolution; resolving through installed sdk-node and rerunning succeeded. Corrected inspection paths were not test failures. No live AWS/provider checks were represented as run.

Final integrity verification: HEAD, branch and upstream remain the values in section 2; read-only `git ls-remote origin refs/heads/main` still resolves to the audited commit. Both unstaged and staged tracked diffs are empty. Recomputed 1,287-file/278,655-line SHA-256 is exactly `99bffbd6a11455fc16d9efd8d00fea4fda4a0294ac94dde3a531fd2a6a9c068b`; all 1,287 paths have inventory rows. The only untracked repository addition is this report. No commits were created and nothing was pushed.

Cleanup: the isolated audit Compose stack was stopped and removed successfully, including its five disposable service volumes and network; the separate observability audit network was removed. Only disposable synthetic audit data was deleted, not shared development data. Temporary logs/probes remain outside the repository under the path above, and the locally built audit image may remain in Docker's image cache. Ignored build/test caches are excluded from the tracked-file immutability claim. Final report verification uses Prettier and the repository documentation check, not another unchanged implementation test run.

## 21. What was not proven

Not proven: absence of all bugs/vulnerabilities; every possible graph/state/interleave; production performance/fairness; actual KMS/IAM/Object Lock/network correctness; signed promoted provenance; provider deduplication beyond documented horizons; legal-hold/backup-erasure effectiveness; regional RPO/RTO; successful cloud deployment; pager/operational ownership; or third-party dependency source correctness.

No full mutation campaign, penetration test, production query-plan review, long-duration soak, or cloud account audit was conducted. Image imports are not configured startup. Fake DNS/transport is not internet reachability. Safe local span export proves sensitive attribute formation/export, not a production incident.

Rejected/unpromoted hypotheses: masked CI pipeline failure (negative rejected it); missing current worker dependency (image imports pass); generic raw provider exceptions through queue traces (normal paths sanitize); For Each missing-output behavior requiring malformed internal snapshots (no valid production omission shown); signal omissions without proof of false durable state; Redis Cluster support (outside chosen topology); and mechanically flagging large files, retained versions, repeated seam parsing or readonly declarations.

Parallel output assurance is a specific qualification: DB `completedInlineOutput` selects Condition/Switch and For Each shapes, not `{branchIds}`. The engine derives branches from immutable config/status without rechecking persisted Parallel output as ADR 019 describes. The pinned SDK validates core executor output before completion, and valid output is deterministic, so no normal-path incorrect result was established. Add a persisted-output corruption/miswiring regression and implement the explicit check or document the narrower trust boundary; do not inflate it into a P1 runtime defect.

## 22. Evidence-based scorecard

Scores use a reproducible checklist, not percentiles or intuitive decimal grades. Award one point each for: C1 clear inspected ownership/contract; C2 baseline checks passed; C3 relevant integration/adversarial evidence executed; C4 no material open repository finding affecting the area; C5 required deployed evidence demonstrated, or genuinely inapplicable to the local-only area. Missing proof scores zero, not presumed failure. No average is used: release blockers cannot be averaged away.

| Area | C1 | C2 | C3 | C4 | C5 | /5 | Withheld evidence |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Architecture/boundaries | 1 | 1 | 1 | 1 | 1 | 5 | Checked exports/build/image; no demonstrated cycle or unnecessary package |
| Workflow semantics | 1 | 1 | 1 | 0 | 0 | 3 | DST/nested/skipped-join defects; no production workload proof |
| API/product | 1 | 1 | 1 | 0 | 0 | 3 | Replay/lifecycle/artifact API and configuration; no live service proof |
| PostgreSQL/lifecycle | 1 | 1 | 1 | 0 | 0 | 3 | Retention interaction; no cloud failover/PITR/capacity proof |
| Security/privacy | 1 | 1 | 1 | 0 | 0 | 3 | Fence/query secrets; no deployed IAM review |
| Tests/assurance | 1 | 1 | 1 | 0 | 1 | 4 | Controlled negatives expose gaps; local test tools need no cloud certificate |
| CI/tooling/image | 1 | 1 | 1 | 0 | 0 | 3 | Validator/configuration; no signed promotion/deployed startup |
| Reliability/performance | 1 | 1 | 1 | 0 | 0 | 3 | CPU/surge/lifecycle; load/failure objectives unproven |
| Documentation | 1 | 1 | 1 | 0 | 1 | 4 | Semantic drift; source-to-doc comparison done, cloud inapplicable |
| Production readiness | 1 | 1 | 1 | 0 | 0 | 3 | Useful local proof, but code blockers and external release evidence missing |

**Release remains NO-GO regardless of totals.** Architecture and verification investment are genuine strengths. Repair demonstrated invariants and collect release-bound evidence; neither an architecture rewrite nor a higher coverage headline is the appropriate first response.
