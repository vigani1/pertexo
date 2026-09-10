# External platform deployment contract

ADR 028 keeps the AWS implementation outside this repository while making its
release interface versioned and fail closed. The reviewed contract is
`infrastructure/ecs/external-platform-contract.json`; the matching validator is
`infrastructure/ecs/validate-external-platform-evidence.mjs`.

`pnpm deployment:check` validates the repository-owned contract and deterministic
task render without AWS credentials. It is necessary but is not deployment
evidence.

The public artifact transfer slice requires the API workload to reach object
storage as well as the worker. Its rendered configuration includes both region
endpoints/buckets and distinct credential references, as declared in
`infrastructure/ecs/workloads.json`. The platform owner must provision those
API-scoped references and the matching restricted bucket permissions before
rollout. Local signing/replication tests do not establish deployed IAM access.
This contract change invalidates older evidence hashes; collect a new snapshot
with the API's `object-storage` egress class present.

## Platform adapter responsibility

The owner of the versioned AWS IaC must export one normalized JSON snapshot from
AWS read APIs after the migration task and service rollout. Run:

```sh
pnpm deployment:evidence:check -- /absolute/path/to/aws-evidence.json
```

The adapter may be implemented in the external platform repository, but its
output is part of this interface. It must not fill fields from desired IaC state,
CloudFormation inputs, Terraform state alone, or operator assertions. Every
resource object marked `source` must contain the literal value `aws-api` and be
derived from the deployed account. Do not include secret values, tenant data,
policy documents, or credentials.

The snapshot is accepted only for the SHA-256 of the exact contract bytes and
within the contract's freshness window. It identifies the exact Git commit and
digest-qualified image. Both `eu-central-1` and `eu-west-1` must be collected in
the same evidence run.

## Required normalized evidence

The top-level document has `schemaVersion`, `source`, `contractSha256`,
`observedAt`, `release`, `regions`, `migration`, and `recoveryWriterFence`.
The executable validator is authoritative for field names and invariants.

For each region, the adapter records:

- task subnets, security groups, availability zones, public-IP assignment,
  reachable regional endpoint classes, exact per-workload egress classes, and
  public ingress rules;
- every workload's exact task definition, image, task role, execution role,
  secret references, KMS keys, and independently calculated policy hashes;
- whether either IAM policy contains wildcard actions or wildcard access to
  sensitive resources (secrets, KMS keys, databases, buckets, and queues);
- each service's desired/running/pending counts, rollout state, deployment
  percentages, health grace, and load-balancer drain time;
- emitted metric names plus alarm ARNs and whether alarm actions are enabled;
  and
- API and worker scalable-target bounds, policy signal names, alarm ARNs, and
  enabled state.

The migration evidence records the exact ECS task and task definition, exit
code, maximum observed concurrent migration tasks, completion time, and earliest
serving-service update time. The adapter must sample migration task concurrency
for the entire release window; a point-in-time count is insufficient.

The recovery evidence records closed ingress, zero desired count for every
declared writer, and a hash over the normalized Route 53, load-balancer, ECS,
EventBridge, and queue-consumer policy state used to establish that fence.
Recovery-region infrastructure existing with writers at zero is expected; an
absent environment is not equivalent evidence.

## Release retention and review

Retain the accepted snapshot with the immutable image scan and release record.
The evidence itself contains resource identifiers and policy fingerprints, so
store it in the access-controlled release evidence system rather than committing
production account details to this repository. An independent platform reviewer
must compare the policy hashes with the reviewed IaC change and confirm that the
AWS caller used for collection has read access to every declared resource.

Any validator failure blocks production rollout. Repair the deployed resource
or explicitly revise ADR 028 and the versioned contract; never edit the evidence
to match an expected result. Re-run collection after repair because stale
evidence is rejected.

## What this does not prove

The repository fixture tests only prove validator behavior. They do not prove
that an AWS account exists, that the collector has complete visibility, that an
alarm reaches a pager, or that failover, PITR, scaling, drain, and regional
recovery work under load. Those live exercises remain Phase 7 release evidence.

## E01 external qualification approval packet

E01 is the separately authorized execution of Q14. This section is the packet
an operator completes before any AWS call, provider delivery, deployed load, or
failure/recovery drill. Square-bracketed values are deliberately unresolved.
They must be replaced with reviewed values in the change record; the packet is
not approved while any value required by an exercise remains unresolved.

### Release-wide fields

| Field | Required value before execution |
| --- | --- |
| Change record and window | `[UNRESOLVED: change/ticket ID]`; `[UNRESOLVED: UTC start/end]` |
| Deployment selector | AWS account `[UNRESOLVED]`; environment `[UNRESOLVED]`; primary `eu-central-1`; recovery `eu-west-1`; ECS cluster/service/task names `[UNRESOLVED]` |
| Release identity | Git commit `[UNRESOLVED]`; digest-qualified image `[UNRESOLVED]`; contract SHA-256 `[UNRESOLVED]`; migration head `[UNRESOLVED]` |
| Data boundary | Dedicated synthetic workspace IDs, workflow/version IDs, object prefix, queue names, connection IDs and test recipients `[UNRESOLVED]`; customer resources are forbidden |
| Financial and time authority | Aggregate cloud/provider ceiling `[UNRESOLVED: currency and amount]`; hard end time `[UNRESOLVED]`; ordinary profile durations do not grant spend authority |
| Evidence destination | Access-controlled immutable release-evidence location `[UNRESOLVED]`; production identifiers and provider receipt IDs are not committed to Git |
| Operators and cleanup | Exercise operator `[UNRESOLVED]`; cleanup owner `[UNRESOLVED]`; incident commander/on-call `[UNRESOLVED]` |
| Approvals | Release `[UNRESOLVED]`; platform `[UNRESOLVED]`; security `[UNRESOLVED]`; data/recovery `[UNRESOLVED]`; provider owner `[UNRESOLVED where used]` |

Global stop conditions are any target mismatch, customer identifier or
recipient, secret in output, spend/time-cap breach, unexpected writer, loss of
durable-state interpretability, disabled safety control, uncontrolled blast
radius, or an operator/incident-commander stop. Stop means halt new inputs,
preserve evidence, keep serving or recovery fenced as appropriate, and execute
only the exercise's reviewed rollback. Never weaken Object Lock, fencing,
retention, RLS, idempotency, or readiness to make a drill pass.

### E01-01 — release deployment and AWS-API snapshot

- **Purpose and selector:** prove the exact digest, workload roles, networking,
  secrets/KMS references, service rollout, autoscaling declarations, alarms,
  migration ordering and recovery writer fence in the release-wide account,
  regions, cluster and services above. Add ECR repository, task-definition
  revisions, load balancer, Route 53 zone, RDS/Redis resources, buckets, KMS
  keys and secret ARNs `[UNRESOLVED]`.
- **Access and data:** approved deploy identity plus a complete AWS read-only
  collector identity; no tenant body or secret value is collected. No synthetic
  application data is required.
- **Mutation, cap and stop:** publish/promote the approved image, run exactly one
  migration task and update only the selected services. Cap: `[UNRESOLVED: USD]`
  and `[UNRESOLVED: minutes]`. Stop before serving update on migration failure,
  more than one concurrent migration, digest/role/policy mismatch or failed
  readiness; stop rollout on unhealthy service or validator failure.
- **Rollback and cleanup:** keep or restore traffic to the compatible predecessor
  digest and follow the forward-migration compatibility procedure; never reverse
  a published migration. Platform owner `[UNRESOLVED]` removes failed task
  revisions or temporary collector grants after evidence retention.
- **Evidence and approval:** immutable image scan/SBOM/provenance, migration task
  record, rollout events, raw collector provenance and normalized
  `aws-evidence.json`; validate it with
  `pnpm deployment:evidence:check -- /absolute/path/to/aws-evidence.json`.
  Release, platform and security approvers above sign the result.

### E01-02 — dual-region Object Lock and conditional-write proof

- **Purpose and selector:** prove versioning, Object Lock/retention and
  conditional-create semantics in the selected primary and recovery tenant
  buckets plus both immutable control-ledger buckets. Record exact bucket ARNs,
  versioning/Object Lock modes, retention policy and a unique synthetic
  workspace/object prefix `[UNRESOLVED]`.
- **Access and data:** the deployed API/worker, maintenance, recovery and
  lifecycle roles plus a restricted evidence reader; use random non-secret bytes
  and synthetic workspace/command IDs only.
- **Mutation, cap and stop:** create bounded object versions, one deliberate
  matching conditional replay, one conflicting conditional write, retention and
  legal-hold/delete attempts, and matching dual-ledger entries. Maximum object
  count/bytes, retention duration, USD and elapsed time are `[UNRESOLVED]`.
  Stop on a customer prefix, successful forbidden overwrite/delete, regional
  byte/hash disagreement or ledger divergence.
- **Rollback and cleanup:** delete only eligible synthetic versions through the
  supported lifecycle path after retention permits it; retained versions remain
  inventoried until expiry and Object Lock is never shortened. Storage cleanup
  owner `[UNRESOLVED]` certifies both regions and ledger tails.
- **Evidence and approval:** bucket configuration from AWS APIs, version IDs,
  hashes/ETags, conditional response codes, retention/legal-hold timestamps,
  CloudTrail request identities, application ledger high waters and cleanup
  inventory. Platform, security and data/recovery approvers sign.

### E01-03 — IAM, KMS, network and secret-boundary probes

- **Purpose and selector:** test every workload role and execution role named by
  the accepted AWS snapshot against its exact RDS, Redis, queue, bucket, KMS,
  Secrets Manager, logging, telemetry and provider endpoints. Role, key, secret,
  security-group and VPC-endpoint ARNs are `[UNRESOLVED]`.
- **Access and data:** approved role-assumption/probe identity; dedicated
  synthetic ciphertext, secret references and object prefixes. Never read or
  print a production secret value.
- **Mutation, cap and stop:** perform reviewed positive calls required by each
  workload and negative cross-workload, wildcard-resource and unapproved-egress
  calls expected to fail. Request count, USD and duration are `[UNRESOLVED]`.
  Stop on any unexpected allow, incomplete caller identity or secret material in
  evidence.
- **Rollback and cleanup:** revoke temporary grants/credentials, remove synthetic
  encrypted values and close probe tasks/connections. Security cleanup owner
  `[UNRESOLVED]` reviews CloudTrail for the complete request set.
- **Evidence and approval:** caller ARN, target class, operation, allow/deny
  result, AWS request ID, policy hash and network-flow evidence with values
  redacted. Platform and security approvers sign.

### E01-04 — real provider delivery to controlled recipients

- **Purpose and selector:** prove HTTP, Slack and email delivery/classification
  through the exact deployed worker and approved sandbox/provider accounts.
  Record synthetic workspace/workflow/connection IDs, HTTPS endpoint, Slack
  workspace/channel and email recipient `[UNRESOLVED]`; all recipients must be
  operator-controlled and visibly marked as tests.
- **Access and data:** provider-sandbox credentials delivered through the
  selected secret references, plus read-only provider receipt/log access. Use
  non-sensitive synthetic payloads with a unique exercise ID.
- **Mutation, cap and stop:** publish bounded runs covering success, definitely
  pre-dispatch failure, transient retry, post-dispatch ambiguity and credential
  rotation/fence behavior. Per-provider message/request count, provider/cloud
  spend and duration are `[UNRESOLVED]`. Stop on an unapproved recipient,
  customer connection, duplicate effect beyond the approved idempotent case,
  secret leak or unexplained durable/provider disagreement.
- **Rollback and cleanup:** halt new runs, revoke/rotate sandbox credentials,
  disable the synthetic destinations and purge or retain test records through
  approved lifecycle policy. Provider cleanup owner `[UNRESOLVED]` confirms no
  pending provider work.
- **Evidence and approval:** redacted provider request/receipt IDs, timestamps,
  idempotency-key hashes, connection-version/fence facts, attempt/run outcome,
  retry decision and cleanup record. Provider, security and release approvers
  sign. There is no repository command for this live proof; its exact external
  driver command remains `[UNRESOLVED]` rather than being invented here.

### E01-05 — admitted load, fairness and autoscaling

- **Purpose and selector:** run all checked-in HTTP profiles against only the
  selected load balancer and dedicated synthetic tenant endpoints. Supply every
  path/body/session/HMAC environment named in
  `infrastructure/exercises/README.md`; record API/worker service and scalable
  target ARNs `[UNRESOLVED]`.
- **Access and data:** exercise clients, separate synthetic tenant sessions and
  signed webhook secret; workflows must have bounded synthetic effects and no
  customer/provider destination.
- **Mutation, cap and stop:** create accepted runs/events/queue work at the exact
  checked-in rates and durations, including concurrent noisy/control profiles.
  Profile maxima are documented with the commands; aggregate AWS/provider cost,
  repetition count and enclosing window are `[UNRESOLVED]`. Stop on wrong target,
  unexpected recipient/effect, safety alarm, admission-fairness loss beyond the
  approved envelope, database connection-budget breach or incident command.
- **Rollback and cleanup:** interrupt clients, close ingress if required, allow
  admitted work to reach truthful terminal state, then remove synthetic
  workspaces through supported lifecycle commands. Load cleanup owner
  `[UNRESOLVED]` verifies queues/outboxes and provider effects are settled.
- **Evidence and approval:** exclusive runner JSON, exact profile hashes,
  correlated run/database metrics, API/worker desired/running task timeline,
  scaling actions, latency/error/admission/backlog and noisy/control completion
  comparison. Platform, release and data approvers sign.

### E01-06 through E01-10 — controlled failure exercises

Each drill uses the selected synthetic load workspace and records the exact
injection resource plus fault start/end. External driver commands, if they live
in the platform repository, are filled into the change record; this repository
does not invent them.

| ID / purpose | Exact selector and expected mutation | Cap and stop | Rollback, cleanup, evidence and approver |
| --- | --- | --- | --- |
| E01-06 Redis loss | Primary/cache endpoint and security/control selector `[UNRESOLVED]`; block or fail only the selected client path while bounded synthetic work continues | `[UNRESOLVED: USD/minutes]`; stop on PostgreSQL truth conflict, cross-environment impact or unbounded backlog | Restore connectivity, let outbox/replay drain, never fabricate state; owner `[UNRESOLVED]`; retain fault events, queue/outbox age, run truth and recovery time; platform/release approval |
| E01-07 PostgreSQL failover | Exact RDS cluster/instance `[UNRESOLVED]`; invoke the approved failover while bounded writes run | `[UNRESOLVED: USD/minutes]`; stop on target mismatch, data-integrity uncertainty, writer split or RPO danger | Fence if uncertain, restore one writer and readiness, reconcile accepted runs; owner `[UNRESOLVED]`; retain RDS events, connection/readiness metrics, committed identities, loss/duplicate analysis and recovery time; platform/data/recovery approval |
| E01-08 provider outage | Approved sandbox endpoint/account and one provider egress control `[UNRESOLVED]`; create a bounded outage/timeout for synthetic effects | `[UNRESOLVED: requests/USD/minutes]`; stop on real recipient, uncontrolled account impact or unexplained ambiguous effect | Restore endpoint/egress, use persisted retry/recovery only; owner `[UNRESOLVED]`; retain provider and durable attempt timelines/classifications; provider/security/release approval |
| E01-09 worker drain | Selected ECS worker service/task revision `[UNRESOLVED]`; initiate one reviewed deployment/drain with bounded in-flight safe, unsafe and waiting work | `[UNRESOLVED: tasks/USD/minutes]`; stop on forced-drain safety breach, lost ownership or queue growth beyond cap | Restore desired count/compatible digest and allow fenced redelivery; owner `[UNRESOLVED]`; retain ECS stop events, drain logs, leases/fences, provider call counts and terminal truth; platform/release approval |
| E01-10 object-storage failure | One regional endpoint/access control for the synthetic prefix `[UNRESOLVED]`; make one region unavailable or deny the scoped role | `[UNRESOLVED: bytes/USD/minutes]`; stop on customer object impact, integrity disagreement, unsafe serving or cleanup uncertainty | Restore access, run bounded restore/reconciliation and keep unsafe objects unavailable; owner `[UNRESOLVED]`; retain request/safety metrics, object versions/hashes, ledger state and recovery outcome; platform/security/data approval |

Required drill-specific access is also unresolved until the approval record names
it: E01-06 requires the scoped Redis network/fault control and read-only
queue/outbox/telemetry access; E01-07 requires RDS failover authority plus
read-only event, connection and durable-identity access; E01-08 requires the
sandbox provider or scoped egress-fault control plus provider-receipt and attempt
evidence access; E01-09 requires the selected ECS service deployment/drain
authority plus task, queue and lease evidence access; and E01-10 requires only
the selected regional object endpoint/prefix deny-or-fault control plus
read-only regional version, ledger and application-state evidence access. Each
grant must be temporary or already reviewed, least-privilege, and identified in
the per-exercise execution record.

### E01-11 — deployed alarms, pager routing and autoscaling response

- **Purpose and selector:** prove every required emitted series/alarm from the
  accepted AWS snapshot, the real notification route/escalation policy, and
  independent API/worker scaling. Alarm ARNs, dashboard IDs, pager service,
  scalable targets and on-call schedule are `[UNRESOLVED]`.
- **Access and data:** metrics/alarm read and approved test-notification access;
  use E01-05 synthetic traffic or bounded synthetic metric injection only where
  the alarm source contract permits it.
- **Mutation, cap and stop:** cross each selected threshold, receive and
  acknowledge one test page, observe scale-out and scale-in within declared
  bounds. Page count, task-hour/USD and duration are `[UNRESOLVED]`. Stop on a
  real incident collision, unintended recipient, capacity/connection-budget
  breach or failure to bound scaling.
- **Rollback and cleanup:** end injection/load, confirm alarm recovery and
  capacity returns within minimum/maximum policy without disabling actions.
  Observability owner `[UNRESOLVED]` closes test incidents.
- **Evidence and approval:** raw metric/alarm history, notification receipt and
  acknowledgement, scaling activities, task/slot/backlog/latency timeline and
  cleanup. Platform, observability/on-call and release approvers sign.

### E01-12 — migration and compatible rollback rehearsal

- **Purpose and selector:** rehearse the exact predecessor/current image and
  migration head against a production-shaped isolated database or explicitly
  approved deployment environment `[UNRESOLVED]`; record task definitions and
  serving services.
- **Access and data:** release-job migration identity, service deploy authority
  and read-only database evidence access; use a reviewed synthetic dataset or
  approved sanitized snapshot `[UNRESOLVED]`, never unapproved customer data.
- **Mutation, cap and stop:** deploy the compatible predecessor, run one current
  migration task, exercise the declared mixed-version window, then roll serving
  tasks back to the compatible predecessor without reversing migrations. USD,
  storage and duration are `[UNRESOLVED]`. Stop on concurrency greater than one,
  readiness mismatch, destructive incompatibility or data-integrity concern.
- **Rollback and cleanup:** keep the forward schema, restore the last compatible
  serving digest, and destroy/isolate the rehearsal environment per approved
  retention. Migration cleanup owner `[UNRESOLVED]` verifies no serving task
  preceded migration success.
- **Evidence and approval:** backup identity, migration/task events, schema
  readiness hashes, mixed-version request results, rollback task timeline and
  integrity checks. Release, platform and data approvers sign.

### E01-13 — backup restore and point-in-time recovery

- **Purpose and selector:** restore the exact selected RDS backup/PITR point and
  corresponding object/ledger evidence into isolated recovery targets
  `[UNRESOLVED]`; record source/target ARNs and requested timestamp.
- **Access and data:** backup/restore authority and restricted validation access;
  seed timestamped synthetic acceptance/object markers before the recovery point.
- **Mutation, cap and stop:** create the isolated restore, apply compatible
  migrations and validate PostgreSQL/object high waters. Storage, task-hour/USD
  and duration are `[UNRESOLVED]`. Stop on wrong source, non-isolated writer,
  integrity disagreement or potential source mutation.
- **Rollback and cleanup:** never write to the source; quarantine a failed
  restore and delete restored resources only after evidence retention approval.
  Recovery owner `[UNRESOLVED]` inventories snapshots/logs left by cleanup.
- **Evidence and approval:** source and recovery-point identity, timestamps,
  restore events, earliest/latest synthetic markers, integrity/reconciliation
  results, measured data loss and cleanup record. Platform and data/recovery
  approvers sign.

### E01-14 — regional restore, writer fence and traffic cutover

- **Purpose and selector:** execute the regional runbook against the selected
  recovery environment, Route 53/load balancer, both region service/queue
  controls, restored PostgreSQL, Redis, buckets and ledgers `[UNRESOLVED]`.
- **Access and data:** audited regional fence, recovery-task, DNS/ingress and
  service-scaling authority; use only the synthetic tenants/markers approved for
  E01-13.
- **Mutation, cap and stop:** close ingress and set every declared writer to
  zero, restore/promote, run the unique `pnpm restore:before-serve` job, rebuild
  Redis, start worker consumption and API traffic in runbook order, then cut
  over. DNS/task/storage/USD and 24-hour maximum window are
  `[UNRESOLVED except ADR 015's RTO bound]`. Stop on any unexpected writer,
  one-sided ledger tail, nonzero restore exit, missing stable inventory sweeps,
  integrity issue or inability to stay within the five-minute RPO.
- **Rollback and cleanup:** immediately re-fence on uncertainty; return traffic
  only to a proven authoritative region, never create concurrent writers, and
  retire temporary recovery resources after approval. Recovery cleanup owner
  `[UNRESOLVED]` certifies DNS, ingress, services, schedulers and consumers.
- **Evidence and approval:** writer-fence AWS snapshot/hash, recovery-point and
  migration identities, restore job/image/log/inventory digests, ledger high
  waters, Redis rebuild, service/DNS timeline, synthetic acceptance probes,
  measured data loss (RPO), traffic-restoration time (RTO) and cleanup. Incident
  commander, platform, data/recovery and release approvers sign.

### E01-15 — retention, deletion and workspace-purge lifecycle

- **Purpose and selector:** prove the deployed lifecycle from retention
  scheduling through deletion request, legal-hold/fence enforcement, leased
  purge steps, regional object-version cleanup and terminal workspace purge.
  Record the exact synthetic workspace IDs, retention policy, purge-job and
  command IDs, both bucket/prefix selectors, database, maintenance task/service,
  queue and control-ledger resources `[UNRESOLVED]`.
- **Access and data:** use the deployed maintenance/operator identities and a
  read-only evidence identity. Seed only bounded synthetic rows and random
  objects beneath the approved prefixes; include one legal-hold control and one
  stale-fence/reclaim control. Customer workspaces, prefixes and objects are
  forbidden.
- **Mutation, cap and stop:** use two separately identified synthetic branches.
  In the recovery-window branch, request deletion through the supported
  operator command, verify access/triggers are revoked, then issue the supported
  restore command before its exact 30-day `purge_after`; prove the workspace is
  suspended with deletion metadata cleared and that access/triggers do not
  silently reactivate. In the purge branch, make a second deletion request and
  reach eligibility only by waiting for the real deadline or using an approved
  production-shaped isolated time-control mechanism named in the record; never
  backdate production rows. Place a legal hold through the supported operator
  command, prove destructive lifecycle work pauses while tenant access remains
  revoked, then release that exact hold through the supported command and prove
  processing resumes. Run only the selected lifecycle workers, exercise one
  lease reclaim and finish every purge step. Row/object/version counts,
  maximum object bytes, task/request count, USD and duration are `[UNRESOLVED]`.
  Stop on selector drift, an unexpected delete, bypassed hold/fence, concurrent
  active lease, cross-region or ledger disagreement, direct table mutation, or
  loss of resumable state.
- **Rollback and cleanup:** stop new commands and workers, preserve the last
  durable checkpoint and re-fence on uncertainty. Resume only through the
  supported command/worker path; do not shorten Object Lock or manually mark a
  step complete. Lifecycle cleanup owner `[UNRESOLVED]` inventories residual
  retained versions, rows, jobs, outboxes and ledger tails until policy permits
  their removal.
- **Evidence and approval:** retain both deletion requests, the pre-deadline
  restore command/result, suspended access/trigger probes, the purge branch's
  deadline provenance, hold placement/pause/release command results, workspace
  status transitions, policy/hold timestamps,
  lease owner/token/fence history, step checkpoints and retry/reclaim facts,
  regional object versions/hashes,
  database/outbox/queue metrics, both ledger high waters, terminal inventory
  sweeps and signed cleanup record. Data/recovery, platform, security and release
  approvers sign. The external driver/operator command and version remain
  `[UNRESOLVED]`; repository lifecycle tests are prerequisites, not this proof.

### Per-exercise execution record

Every E01 record, including each row of E01-06 through E01-10, must identify the
named operator and cleanup owner, the authenticated caller/assumed-role ARN and
session identifier, the exact reviewed command or automation definition plus
its immutable version/hash, start/end timestamps, resolved resource selectors,
approved caps, actual consumption, stop/rollback disposition, evidence URI and
approver signatures. A console action must record the service, action, request
ID and before/after state. `[UNRESOLVED]`, an unversioned command, an anonymous
operator session or a missing cleanup disposition makes that exercise `not run`,
not passed.

### Interpretation and authorization

Before E01, run the repository prerequisites named in the release-security
runbook and retain their outputs. A passing `pnpm deployment:check` means the
repository contract and deterministic render are internally valid. A passing
`deployment:evidence:check` means a fresh normalized AWS read snapshot matches
that contract. Neither result means any E01-02 through E01-15 mutation or drill
ran successfully. Conversely, a drill record cannot waive a failed repository
gate or AWS snapshot validator.

The operator must record `approved`, `rejected`, or `not run` for every E01 ID.
Any failed stop condition is a failed exercise even if the system later
recovers. E01/Q14 is complete only when all required IDs have retained evidence
and their listed approvers accept it; this locally prepared packet leaves every
ID **not run and unauthorized**.
