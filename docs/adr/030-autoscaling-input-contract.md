# ADR 030: Repository-owned autoscaling input contract

- **Status:** accepted
- **Date:** 2026-08-28

## Context

ADR 028 leaves autoscaling external to the ECS task-definition checkpoint, but
Phase 7 requires API and worker scaling to remain independently reviewable. A
cloud-only policy would hide signal semantics and capacity assumptions from the
repository, while repository-owned AWS resources would expand the current
deployment boundary substantially.

## Decision

The repository owns a declarative, statically validated autoscaling **input
contract** for API and worker services. It records regional bounds, cooldowns,
metric semantics, thresholds, and configured worker slot capacity. The raw
active-handler signal is an absolute count. Worker utilization is derived as the
sum of active handlers divided by running task count times configured slots per
task; the raw count is never relabeled as a percentage. Queue age means the
oldest waiting job and excludes intentionally delayed work.

AWS Application Auto Scaling targets, CloudWatch alarms, metric publication,
policy wiring, rollout, and measured scaling behavior remain external deployment
gates. This decision extends ADR 028 only for reviewed inputs; it does not make
broader AWS infrastructure repository-owned.
