# Infrastructure: deployment, role bootstrap and smoke ownership

Date: 2026-09-12. All 22 files below fully read by the primary reviewer.
Five ECS test files, offline deployment validation and deterministic rendering
were run; no AWS API, Docker startup, database provisioning or migration run.

| File | Disposition | Specific judgment |
| --- | --- | --- |
| `infrastructure/ecs/render-task-definitions.mjs` | KEEP | Sorted manifests, immutable image syntax, per-workload IAM prefixes, distinct config/secrets and readonly nonroot init/tmp settings are explicit. This renders definitions, not services or IAM policies; no generic deployment framework needed. Output directory is caller-owned, so stale-file replacement policy should be explicit if reused. |
| `infrastructure/ecs/validate-render.mjs` | KEEP; shared WQ-213 | Repeated byte equality, exact file inventory and mutable-image negative establish deterministic rendering. Cleanup preserves original failure; renderer subprocess should have a bounded completion time. |
| `infrastructure/ecs/validate-render-runtime-config.test.mjs` | KEEP | Real API/worker parsers consume only rendered references resolved with synthetic values across both cohorts. Literal activated-job inventory is intentional independent assertion. Artifact/encryption assertions should cover core as well when required; no production bootstrap claim from parser-only tests. |
| `infrastructure/ecs/validate-readiness-health-check.mjs` | WQ-217 | String inclusion is not proof shell command requires marker state. Echo or OR-true can satisfy validation. |
| `infrastructure/ecs/validate-readiness-health-check.test.mjs` | WQ-217 TEST | Current positive and missing-negative-marker cases are useful but do not test effective failure when readiness is absent/revoked. |
| `infrastructure/ecs/validate-runtime-closure.mjs` | KEEP | Small typed JS graph walk gathers production workspace dependencies and checks expected COPY fragments. This is a static closure precheck, not execution of container imports; retain image smoke as separate evidence. |
| `infrastructure/ecs/validate-runtime-closure.test.mjs` | KEEP | Real repo graph plus removing each role/app-only copy guards omissions. Negative test deliberately removes a whole line; does not prove commented COPY is active. |
| `infrastructure/ecs/tsconfig.runtime-closure.json` | KEEP | Narrow checkJs/noEmit config gives this build-critical JS seam static checks while preserving main TS build. |
| `infrastructure/ecs/run-release-job.sh` | KEEP; operational TEST | Quoted args, missing task rejection, stopped wait and exact migration container exit status fail closed. It does not enforce global single migration concurrency or stop a task after waiter timeout; document recovery with exact task ARN and test stub AWS CLI success/failure/timeout without cloud mutation. Do not auto-cancel live migrations without policy. |
| `infrastructure/ecs/validate-deployment.mjs` | WQ-217 | Named capacity/cooldown/signal validators help comprehension, but duplicate required signal can replace another. Large top-level validation would become testable by a pure validateDeploymentContracts input seam with file-loading CLI shell; retain all independent role/security/region constraints. |
| `infrastructure/ecs/validate-database-connection-budget.mjs` | KEEP | Per-role pools, monitors, transient clients, max replicas and rollout overlap are distinct real costs, not redundant branches. Pooler-none policy is explicit; non-none mode arithmetic is conservative rather than proven deployment sizing. |
| `infrastructure/ecs/validate-database-connection-budget.test.mjs` | KEEP | Separate API, worker, simultaneous overlap, rounding, admin reservation and undeclared pool cases establish calculation. Tests do not observe actual PostgreSQL max_connections or live replica concurrency. |
| `infrastructure/ecs/database-connection-budget.json` | DATA/KEEP | Declared primary required 398/400 includes 20 admin and 40 regional headroom; only two unallocated above these reserves, not two total reserve connections. Keep provider measurement as qualification requirement and keep pool owner changes synchronized. |
| `infrastructure/ecs/autoscaling.json` | DATA/KEEP; WQ-217 | Separate latency/CPU and age/slot ratio signals, slower scale-in and warm recovery capacity are clear. Configured 60 worker slots must remain tied to actual concurrency; config consistency alone is not load qualification. |
| `infrastructure/ecs/workloads.json` | DATA/KEEP | Seven deployment roles separate serving, one-shot and migration behavior. Environment values are nonsecret; API/worker/lifecycle markers and retention PID-only liveness intentionally differ. PID liveness is not retention readiness; do not describe it as such. |
| `infrastructure/ecs/validate-external-platform-evidence.mjs` | WQ-218 | Well-named network/role/service/telemetry/scaling/migration phases keep proof obligations navigable. Coercive migration count and incomplete observed policy fields weaken exact-contract claim. Source=aws-api is a provenance assertion, not cryptographic verification. |
| `infrastructure/ecs/validate-external-platform-evidence.test.mjs` | WQ-218 TEST | Fresh synthetic baseline and ten independent drift mutations are useful. Baseline deliberately generated from contract is not an independently collected deployment record; add omitted-field and observed-setting mismatches. |
| `infrastructure/ecs/external-platform-contract.json` | DATA/KEEP; WQ-218 | Explicit region/IAM/network/fence and rollout obligations remain existing architecture; no new provider recommendation. Evidence schema must distinguish declared source/hash from verified raw observations. |
| `infrastructure/ecs/rendered-task-startup-smoke.mjs` | WQ-219 | Strict rendered secret/config-set matching and immutable-image reinspection are strong. Container/server/temp acquisition, deadline and readiness observations need stronger ownership tests; local-config digest fallback is not a registry manifest attestation. |
| `infrastructure/postgres/init/10-roles.sh` | KEEP | Empty-volume superuser bootstrap safely quotes identifiers/literals with psql format, separates owner membership and grants only required DB access. NOT EXISTS plus password update is not full existing-role reconciliation; documented empty-volume scope matters. Password command arguments are local bootstrap-only, not safe remote logs. |
| `infrastructure/postgres/provision-operator-role.mjs` | TEST; shared resource ownership | Server format quotes role/password safely; transaction removes inherited memberships and hardens existing role flags. connect() occurs before cleanup try, so test failed-connect socket cleanup and bounded connect/query/end. Does not revoke every old object grant/ownership, so do not claim arbitrary privileged existing roles become least-privilege solely from this script. No provisioning run in audit. |
| `infrastructure/minio/bootstrap-ledger.sh` | KEEP | Narrow admin bootstrap creates dedicated ledger user and attaches explicit policy; fail-fast shell is appropriate. Keep credentials out of tracing/output and document rerun/partial-setup behavior rather than inventing automatic rollback. |

The two MinIO policy files are judged separately in the infrastructure data
ledger to preserve a one-file/one-primary-row inventory.

## WQ-217 — test deployment constraints, not substrings or list length

P2 FIX/TEST; source helper probes accepted both a duplicate signal pair and an
echo-only health command. In `validate-deployment.mjs:assertAutoscalingSignals`,
length equals expected size and each entry is allowed, but two latency signals
therefore pass while saturation is absent. Compare exact distinct names before
checking each measurement. Extract a pure top-level validation seam with loaded
manifest/contract inputs; test duplicate/omitted/unknown signals, numeric desired
counts and disjoint literal/config/secret names without editing repo files.

`validate-readiness-health-check.mjs` joins args and uses includes. Require the
small owned command grammar/exact canonical form, or execute controlled shell
fixtures against absent, ready and revoked states; do not attempt a full shell
parser. Reject `echo test -f ...`, `test ... || true`, wrong marker and missing
negative marker. Preserve current actual commands (no current deployment
readiness bypass alleged). Extend actual smoke to use full rendered worker
health check rather than only positive marker (WQ-219).

## WQ-218 — make external evidence coverage match the claimed policy

P2 FIX/TEST, source and synthetic-fixture proof only. In
`validate-external-platform-evidence.mjs:assertMigration`,
`maximumObservedConcurrentTasks <= 1` accepts null, -1 and 0; all three passed
current validator against its otherwise-valid fixture in this audit. Require a
positive safe integer and exact successful-task temporal/identity relationships.
Reject fractional/string/null/negative counts and nonfinite timestamps. Match
migration task definition and release identity to the observed migration workload,
not just independent ARN-prefix validation.

Current assertAutoscaling observes signal names/enabled alarm ARNs but not metric,
threshold, period, normalization or cooldown. assertSecretEvidence covers
Secrets Manager but no SSM configuration references/read permissions. Add these
specific observations and strict comparisons to a versioned evidence shape when
claiming exact deployment-contract qualification. Bind external contract,
workload manifest and scaling policy fingerprints; a hash of only one JSON file
does not bind all release settings. Preserve supported historical evidence as
historical, never retroactively claim it proves new fields. Require raw collection
references/collector identity and distinguish trusted normalized evidence from
verified remote state; do not turn literal source='aws-api' into an authenticity
claim. Tests mutate each newly required observation and confirm clear rejection.
No AWS access or policy change is authorized by this planning task.

## WQ-219 — give startup smoke explicit acquisition and readiness ownership

P2 FIX/REFACTOR/TEST. `rendered-task-startup-smoke.mjs` combines manifest
resolution, image identity, two container lifecycles, TLS bridge and cleanup.
Keep one orchestration owner, but isolate the meaningful owned smoke-resource
operations for injected tests, not arbitrary line-count fragments.

- `createObjectStoreBridge` allocates a separate temp directory before openssl,
  readFile, TLS construction and listen; rejection before returning loses its
  cleanup handle. Register cleanup at acquisition and preserve original error;
  remove the directory even if server close fails.
- startApi's loop deadline does not bound `fetch()`/response.text(); a hung
  readiness request can exceed 45s. Docker/openssl commands also have no local
  timeout. Give each operation remaining deadline/cancellation and reap owned
  children. Test response headers with never-ending body and stalled command.
- startWorker checks only ready file plus log text, not not-ready marker or the
  actual rendered conjunction. Require full health command success and running
  state together; test both marker files present. Logs are diagnostics, not the
  sole readiness contract.
- Fixed container names collide across runs. Use one per-run identifier and
  track exact creation IDs/ownership before later awaits; never remove a container
  merely because it has the same fixed name. Handle created-but-start-failed
  Docker outcomes and leave explicit manual recovery if ownership is uncertain.
- Close bridge in-flight sockets/upstream requests within a bound and observe
  response-stream errors; server.close alone may wait on active traffic. Bind
  local listeners only as broadly as Docker host access requires. Local password
  URL construction should use URL setters to encode reserved characters.

Test partial TLS acquisition, failed Docker start, never-ready API, revoked worker,
cleanup failure plus primary failure and concurrent runs using local fakes first.
Then run the authorized disposable-container smoke with both cohorts. Preserve
strict injection sets, nonroot/readonly/tmp/init settings and immutable image
identity. These are source-visible gaps, not a claim that a smoke run hung here.
