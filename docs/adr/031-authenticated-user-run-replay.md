# ADR 031: Authenticated user run replay

- **Status:** accepted
- **Date:** 2026-09-06

## Context

The backend plan requires `ReplayWorkflowRun` as a tenant command distinct from
queue redelivery, logical retry and the operator recovery command in ADR 029.
ADRs 004 and 007 already require workspace authorization, explicit version
selection, a new run identity, request idempotency and unchanged source history.
The public route and its transaction boundary need a concrete contract before
implementation.

## Decision

`POST /v1/workspaces/:workspaceId/runs/:runId/replay` accepts an authenticated
browser session, valid CSRF proof and exactly one valid `Idempotency-Key`.
Both the guard and application command require the existing `run:replay`
capability in an **active** workspace. Ordinary `run:start` authority is not
replay authority: a builder may start a workflow but cannot replay prior
effects. This preserves the existing capability policy rather than widening it
while introducing the route. Suspended and pending-deletion
workspaces may remain readable but cannot accept replay. Unauthorized workspace
or source access uses the existing not-found disclosure policy.

The strict body requires `workflowVersionId` and bounded JSON `input`.
`deadlineAt` is optional and follows ordinary run-start deadline validation.
The caller explicitly selects the original version or another retained,
published, executable version of the same workflow (including its current
version). There is no implicit latest-version lookup or hidden source-input
copy. A missing or cross-workspace source/version is not found; an unavailable
executable is rejected using the existing execution error taxonomy.

Acceptance creates a fresh run with trigger type `replay`, the selected immutable
version, explicit input and `replay_source_run_id`. The source run, its attempts,
events and outcomes are not changed. Replay does not infer absence of prior
provider effects or reuse their provider idempotency keys. The response is HTTP
202 with the normal accepted-run summary and the existing `replayed` request-
deduplication indicator. Source lineage is recorded as a safe identifier, never
as copied execution output or credentials.

A single workspace transaction protects source/version identity from concurrent
retention, checks normal admission/lifecycle/compatibility policy, claims the
workspace-, operation- and source-scoped idempotency key, and writes the new run,
initial checkpoint, event, audit fact and outbox delivery. The canonical request
hash binds actor, workspace, source, selected version, input and deadline. An
exact retry returns the same accepted run without a second audit/event/outbox;
different material under the same key returns `request.idempotency_conflict`.
Retained history and explicit idempotency expiry remain authoritative.

Use the existing least-privilege tenant API transaction and acceptance
primitives where they preserve these invariants. Do not grant the API access to
operator command tables/functions, maintenance authority or cross-workspace
credentials. A forward migration is permitted only for the narrow replay
transaction invariant or privilege needed; existing migrations stay immutable.

## Required evidence

Contract and authenticated HTTP tests cover validation, CSRF, capability and
workspace-state denial. Real PostgreSQL tests cover original/current version
selection, unchanged source history, distinct new-run identity, concurrent exact
deduplication, conflicting keys, admission rejection, RLS/tenant isolation and
atomic event/checkpoint/audit/outbox persistence. A worker recovery test must
consume the accepted replay through the ordinary execution path, without
operator authority or manual row repair.

## Consequences

User replay is a normal, explicitly side-effecting tenant command rather than
an HTTP proxy for recovery authority. Requiring input makes the choice clear
even after source-input retention expires. Clients must supply the intended
version and input rather than relying on mutable server defaults.
