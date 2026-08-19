# ADR 006: Coordinator checkpoints and separate node-attempt jobs

- **Status:** accepted
- **Date:** 2026-08-20

## Context

The first durable run needs one serialization point that survives process and
Redis loss without turning a coordinator into a provider executor. Combining
graph advancement and external work in one job would make checkpoint recovery,
retry ownership, and ambiguous provider outcomes depend on worker timing.

## Decision

Each run references one immutable workflow version and has one durable
checkpoint revision. A workflow-coordinator delivery loads the pinned version,
checkpoint, persisted node state, and bounded output references from
PostgreSQL. It computes a transition plan without calling providers. One short
workspace transaction compares the expected checkpoint revision and atomically
persists the next checkpoint, run/node transitions, gapless run events, newly
admitted node attempts, and their outbox events. Losing the revision race means
reload and recompute; coordinators never merge stale plans or blindly replay
writes.

Node work is delivered separately by identifier-only node-attempt jobs. An
attempt worker claims or reconciles one persisted logical attempt, resolves its
pinned executor and referenced input, executes outside a long transaction, and
then atomically records its bounded outcome, events, and coordinator-
continuation outbox event. A lease or heartbeat establishes ownership only; it
never proves completion. Provider retry and `outcome_unknown` policy remain the
state-machine decision recorded by ADR 007, not BullMQ transport retry.

Initial run acceptance uses the same boundary: one transaction claims the
workspace-scoped request key/hash and inserts the queued run, sequence-1
accepted event, revision-0 checkpoint, and `advance-workflow-run` outbox event.
An exact request retry returns that run; a different hash under the same key is
rejected. The API may return `202` only after this transaction commits.

## Consequences

Coordinator and attempt consumers stay thin and idempotent, Redis can be
rebuilt from PostgreSQL, and crash tests can target named pre/post-commit
boundaries. The cost is explicit checkpoint-CAS handling, separate queue
traffic, and more PostgreSQL writes. The custom engine remains provisional
until every Phase 0E failure proof passes ADR 005's go/no-go gate.
