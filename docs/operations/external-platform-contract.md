# External platform deployment contract

ADR 028 keeps the AWS implementation outside this repository while making its
release interface versioned and fail closed. The reviewed contract is
`infrastructure/ecs/external-platform-contract.json`; the matching validator is
`infrastructure/ecs/validate-external-platform-evidence.mjs`.

`pnpm deployment:check` validates the repository-owned contract and deterministic
task render without AWS credentials. It is necessary but is not deployment
evidence.

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
