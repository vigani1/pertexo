# ADR 021: PostgreSQL-authoritative durable Wait

- **Status:** accepted
- **Date:** 2026-08-24

## Context

The runtime already persists delayed retries and scans due node rows, but it
does not define a V1 Wait node or preserve whether a waiting invocation is a
semantic suspension or retry backoff. A run whose deadline precedes a long wait
also needs an independent PostgreSQL wake source. Redis or worker wall-clock
state cannot fill either gap.

## Decision

`core.wait@1` is a `logic`, `cpu`, `safe` node under executor ABI 1, with `in`
and `out` ports, no credentials or connections, and the `suspends_run`
capability. Its strict config is `{ durationSeconds: integer }`, from one through
2,592,000 seconds (30 days). Its input and output are the same bounded canonical
JSON value. V1 has no absolute timestamp, dynamic duration, cron, callback,
approval, or external signal mode. Preview validation is supported, but
`test_execute` rejects Wait with a stable suspension-not-supported error rather
than sleeping or creating production scheduler state.

The first Wait attempt validates and returns its input. The platform recognizes
the pinned suspension capability and commits the attempt as succeeded while the
logical node becomes `waiting`. PostgreSQL computes `resumeAt` from database
time in that same transaction, persists the output, appends `node.waiting`, and
inserts an immediate coordinator outbox event so checkpoint state observes the
suspension promptly. The transaction clears retry timing and leaves no worker
lease or BullMQ delayed job.

Checkpoint and attempt history preserve the reason for delayed work. Waiting
invocations carry `waitKind: "node_wait" | "retry_backoff"`; new attempts carry
`admissionKind: "execute" | "retry" | "wait_resume"`. Existing attempts
backfill to `execute`. A due semantic wait admits one new immutable
`wait_resume` attempt, while due retry admits `retry`. The resume attempt returns
the preserved Wait output and cannot arm the duration again. Duplicate due
facts, queue deliveries, and stale coordinators remain inert through the due
generation marker, outbox/inbox, checkpoint CAS, invocation identity, and
attempt uniqueness.

Exactly one of `resume_at` and `retry_due_at` is present for a waiting node, and
neither is present otherwise. The existing global due-node scanner remains the
authoritative node-delay scanner: row locks claim a generation, `due_wakeup_at`
records publication for that due timestamp, and outbox leasing owns transport
retry. Multiple due nodes may emit multiple physical coordinator outboxes for
one run; checkpoint CAS still permits one logical transition.

A new PostgreSQL-authoritative deadline scanner also emits one immediate
coordinator outbox when a nonterminal run deadline becomes due, independently
of later node resume times. It uses an additive durable publication marker and
transactional outbox; no in-process timer is authoritative. If deadline and
resume are simultaneously due, coordinator control facts are evaluated before
due admission. A committed cancellation request wins for a purely waiting safe
invocation when cancellation and deadline are first observed together;
otherwise deadline produces `timed_out`. Existing `outcome_unknown` truth from
possibly dispatched unsafe effects retains higher precedence.

Cancellation after suspension clears Wait timing and prevents a resume attempt.
Cancellation or deadline committed before the suspension transaction prevents
waiting state from being created. Redis loss, worker restart, process drain, or
duplicate scanner execution cannot lose or resume a Wait early. PostgreSQL loss
fails closed.

Wait uses additive staged and active compatibility releases after For Each.
It remains outside serving cohorts until boundary-duration, no-early-resume,
duplicate, cancellation, deadline, crash, Redis-loss, process-drain,
fresh-worker, retained-release, and staged/active rollout proofs pass. Legacy
delay helpers may remain only as explicitly isolated recovery fixtures; the
production node-attempt, coordinator, and scanner stores are the one serving
implementation.

## Consequences

Wait releases worker capacity and survives transport loss while retaining
truthful immutable attempts. Explicit delay and admission kinds prevent a
resume from looping or being mistaken for retry. The trade-off is one additive
attempt for resume and a separate run-deadline wake source.

## Rejected alternatives

- BullMQ delayed jobs, sleeping workers, or process timers as wait authority.
- Worker-computed or user-supplied absolute `resumeAt`.
- Inferring semantic resume from attempt number or timing columns.
- Completing Wait directly in the coordinator without an immutable resume
  attempt.
- Letting a resume attempt arm the original duration again.
- Waiting until a later node resume to discover an earlier run deadline.
- Durable suspension during V1 preview execution.
