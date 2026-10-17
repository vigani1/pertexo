# ADR 084 — Durable trigger event coordination

Status: accepted. Date: 2026-10-17. Feature: [F25](../feature-plans/25-event-coordination.md).

## Context

The owner authorized per-webhook and per-form deduplication, trailing debounce and
throttling. Existing transport replay and queue delivery do not define business
keys or durable pending input. A restart must not lose accepted events or start
one pending event twice. Concurrency still applies when a run is admitted.

## Decision

Use shared workspace-scoped PostgreSQL key windows and event rows, not Redis
truth or a second execution engine. One event row owns bounded pending input and
its eventual metadata history. Store typed canonical key hashes only. Scope
windows by workflow/root node/policy fingerprint so forms and webhooks share one
rule without inventing materialized form triggers.

Choose one published policy per trigger. Use database processing-time fixed
windows for deduplication/throttling and trailing-edge latest-input debounce.
Throttle delayed events in FIFO order per key and charge tokens at actual run
admission. The short plan owns exact ranges, safety bounds and safe reasons.

After the existing shared workspace admission fence, a transaction-scoped
workspace coordination advisory lock serializes first-key creation and workspace
budgets before publication/state locks. State, usage and normal run/outbox
acceptance commit in one transaction. Stable event identity and pending-row locking
make repeated scans/restarts safe. Extend the existing worker trigger scanner;
a narrow due-discovery fence returns identities only. No new service, role,
queue, package or CI job. Use the existing isolated bounded expression evaluator.

A pending event acknowledges asynchronously. It can be refused visibly by expiry,
capacity or trigger/publication invalidation. Clear its input as soon as it is
no longer pending; retain metadata for the ordinary 90-day trigger window. The
same lifecycle owners remove keys/history and purge workspace data. Test runs
never pass through external event coordination.

## Consequences

One shared coordinator serves two ingress paths and the worker. Durable atomic
run admission is exactly once for an accepted pending event; external workflow
effects retain their existing delivery/retry semantics. Fixed windows are simple
and inspectable but allow boundary bursts; they are not sliding-rate guarantees.
Changing a published trigger can refuse pending events rather than executing old
input against new code. No payload archive or recovery subsystem is introduced.
