# Release and Security Gate

This runbook covers repository checks that are reproducible without production
credentials or an AWS account. It is a release prerequisite, not production
deployment evidence.

## Commands

- `pnpm security:audit` queries the pnpm advisory service for high or critical
  vulnerabilities in production dependencies. Registry errors fail the gate;
  they are not treated as a clean audit.
- `pnpm deployment:check` validates the Docker/ECS source contract, independent
  API and worker autoscaling declarations, and two byte-identical task-definition
  renders. It also proves that a mutable image tag is rejected.
- `pnpm release:check` runs the dependency audit, the full root quality gate,
  deployment validation, and exercise-contract validation in that order.

CI runs dependency, deployment, and exercise-contract gates on every pull request
and push to `main`. `.github/workflows/release-gate.yml` runs the complete local
gate plus a production-image build, non-root/read-only smoke, and high/critical
Grype scan every Monday and on manual dispatch. The scan action is commit-pinned.
`.github/workflows/codeql.yml` runs commit-pinned JavaScript/TypeScript CodeQL on
`main`, weekly, and on manual dispatch. A failed or unavailable advisory/scanner
query blocks the gate and must be retried; it must not be treated as clean.

## Image and Deployment Boundary

`ECS_IMAGE_URI` must include `<repository>@sha256:<digest>`. Tag-only references
such as `latest` or a release name are not accepted by the renderer. Build and
scan an image before rendering, retain the scanner report with release evidence,
and pass the scanned digest to the renderer. The scheduled/manual release gate
scans the built image with commit-pinned `anchore/scan-action` and fails on any
high or critical finding for which the vendor publishes a fix. Unfixed findings
remain visible in scanner output and require release risk review rather than an
unmaintainable repository ignore. The report is CI evidence; production
deployment must retain it alongside the exact deployed image digest.

The release migration remains a one-off ECS task. Deployment automation must
wait for its successful exit before updating serving tasks. The local gate does
not prove AWS IAM, networking, Secrets Manager delivery, service rollout,
autoscaling alarms/policies, or migration execution against production.

## Autoscaling Contract

`infrastructure/ecs/autoscaling.json` keeps API and worker capacity independent.
API scale-out inputs are p95 request latency and ECS CPU saturation. Worker
inputs are oldest admitted queue-job age and active handlers normalized by the
configured slots per task. Scaling complements admission control and never
admits work by itself.

The thresholds are reviewed launch defaults. Before AWS rollout, deployment
owners must map the OpenTelemetry metrics into CloudWatch, define the active-slot
metric math, create scaling policies and alarms, and verify behavior under the
engineering-envelope load tests. Until that evidence exists, autoscaling remains
AWS-blocked and Phase 7 is not complete.
