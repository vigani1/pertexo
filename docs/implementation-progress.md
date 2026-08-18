# Backend Implementation Progress

Last updated: 2026-08-18

This file tracks delivery against
[the authoritative backend plan](./workflow-platform-backend-plan.md). A phase
is marked complete only when all of its plan requirements and applicable
vertical-slice completion criteria have passed. Commits or scaffolding alone do
not complete a phase.

## Status summary

| Checkpoint | Status | Evidence |
| --- | --- | --- |
| Phase 0A — repository and process skeleton | Complete | ADR 001; commits `8d064cd`, `c80a70c`; `pnpm check`; compiled API and worker smoke checks |
| Phase 0B — PostgreSQL tenancy and RLS proof | Not started | — |
| Phase 0C — HTTP and observability foundation | Not started | — |
| Phase 0D — queue, outbox, and duplicate-delivery proof | Not started | — |
| Phase 0E — execution durability proofs and engine gate | Not started | — |
| Phase 1 — identity/workspace vertical slice | Not started | — |
| Phase 2 — workflow authoring vertical slice | Not started | — |
| Phase 3 — first executable-node slice | Not started | — |
| Phase 4 — first side-effecting integration slice | Not started | — |
| Phase 5 — orchestration slice | Not started | — |
| Phase 6 — V1 providers and triggers | Not started | — |
| Phase 7 — production operations | Not started | — |

The `0A`–`0E` checkpoints are implementation-sized subdivisions of the plan's
single Phase 0. They do not alter the authoritative scope. Phase 0 remains
incomplete until every required Phase 0 foundation, executable spike, measured
result, and custom-engine go/no-go condition has been completed.

## Phase 0A — Repository and process skeleton

Status: **Complete**

- [x] Accept ADR 001 before repository conversion.
- [x] Create the pnpm monorepo foundation without speculative empty packages.
- [x] Establish the strict shared TypeScript safety baseline.
- [x] Add independently buildable NestJS API and standalone worker roles.
- [x] Parse API and worker configuration into immutable typed values.
- [x] Add conservative API liveness without false dependency-readiness claims.
- [x] Enable graceful process shutdown behavior.
- [x] Add formatting, linting, production/test type checking, tests, builds, and
      an applicable CI workflow.
- [x] Verify the compiled API health route and long-lived compiled worker.

Evidence:

- ADR: [ADR 001](./adr/001-modular-monolith-monorepo-api-worker.md)
- Commits: `8d064cd`, `c80a70c`
- Verification: `pnpm check`
- Tests: five API tests and four worker tests

## Phase 0B — PostgreSQL tenancy and RLS proof

Status: **Not started**

- [ ] Accept ADR 003 before the first tenant repository.
- [ ] Add local PostgreSQL infrastructure and typed database configuration.
- [ ] Create the database package and reviewed migration foundation.
- [ ] Define migration, owner, and restricted runtime roles.
- [ ] Implement transaction-scoped workspace context using `SET LOCAL`.
- [ ] Prove cross-workspace reads and writes fail.
- [ ] Prove pooled connections cannot leak workspace context.
- [ ] Prove runtime roles cannot own or bypass protected tables and policies.
- [ ] Add honest PostgreSQL readiness and migration compatibility checks.
- [ ] Record the executable fixture, automated failure tests, measured result,
      and ADR update required by the Phase 0 spike.

## Phase 0C — HTTP and observability foundation

Status: **Not started**

- [ ] Add request IDs and explicit actor/workspace request context.
- [ ] Add the global RFC 9457 problem-details mapping seam.
- [ ] Add structured logging and redaction rules.
- [ ] Add OpenTelemetry trace/metric bootstrap for API and worker roles.
- [ ] Add dependency-aware readiness and graceful drain behavior.
- [ ] Add package direction and server-only export enforcement as packages are
      introduced.

## Phase 0D — Queue, outbox, and duplicate-delivery proof

Status: **Not started**

- [ ] Accept ADR 005 before execution persistence.
- [ ] Add local Redis and BullMQ infrastructure.
- [ ] Add versioned identifier-only job contracts.
- [ ] Implement transactional outbox claiming and publication.
- [ ] Implement idempotent consumer/inbox behavior.
- [ ] Prove duplicate delivery cannot duplicate logical attempts, events, usage,
      or provider calls beyond documented retry semantics.
- [ ] Add local S3-compatible storage and bounded artifact plumbing.

## Phase 0E — Execution durability proofs and engine gate

Status: **Not started**

- [ ] Prove coordinator and node-attempt crash recovery.
- [ ] Prove checkpoint reconstruction from PostgreSQL-authoritative state.
- [ ] Prove waits survive worker and Redis restarts without occupying workers.
- [ ] Prove durable cancellation behavior.
- [ ] Prove deterministic branch, join, and bounded-loop recovery.
- [ ] Prove SSE reconstruction after Redis loss.
- [ ] Prove restricted JSONata evaluation limits and determinism.
- [ ] Record executable fixtures, automated failure tests, and measured results.
- [ ] Pass the custom-engine go/no-go gate or complete the required Temporal
      evaluation.

## Later phases

Use the delivery plan and vertical-slice completion rule as the checklist for
Phases 1–7. Expand the relevant phase here before implementation begins; do not
mark a phase complete from a high-level summary alone.

## Update protocol

When a checkpoint changes status:

1. Update its checklist and the summary table in the same logical change.
2. Record concrete evidence: ADRs, commits, commands, tests, measured results,
   or recovery exercises.
3. Leave incomplete or deferred requirements unchecked and explain blockers.
4. Never mark complete based only on generated files, passing unit tests, or a
   prose-only architecture proof.
5. Commit the tracker update with the implementation checkpoint or as its
   immediately following documentation commit.
