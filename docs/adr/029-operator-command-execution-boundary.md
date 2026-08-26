# ADR 029: Operator command execution boundary

- **Status:** accepted
- **Date:** 2026-08-26

## Context

V1 requires supported recovery commands for durable transport, leases, waits,
unknown outcomes, runs, triggers, retention, and purge. Reusing the tenant API
would make recovery unavailable during an API outage and would put broad
cross-workspace authority in an internet-facing process. Reusing a normal worker
would let queue payloads exercise operator authority. Direct SQL editing cannot
provide stable idempotency, dry-run, reason, authorization, or audit semantics.

## Decision

Operator recovery uses a separate one-shot, no-listener executable and a distinct
`pertexo_operator` PostgreSQL role. Production invocation is admitted by the
deployment control plane's authenticated platform-operator identity and recorded
in its immutable invocation audit; the executable also records the bounded actor
reference, required reason, command material, and result in PostgreSQL. Local and
CI execution uses an explicit test identity and cannot be presented as production
authentication evidence.

The executable may call only narrow command-specific database functions. It owns
no tables, cannot assume serving, migration, maintenance, lifecycle-command, or
owner roles, and receives no tenant API/session credential. Every command has a
durable UUID and canonical request fingerprint before mutation, exact replay is
idempotent, conflicting replay is rejected, and status is queryable. Dry-run is
required when the command can safely inventory its effect; commands that merely
record recovery evidence state why dry-run is not meaningful. Every invocation
has bounded work, timeouts, structured cardinality-safe telemetry, and an audit
event. Destructive retention and purge still execute under their existing
maintenance/ledger fences; the operator command can only request or rerun that
work.

## Consequences

Recovery remains usable while API and queue consumers are stopped, and compromise
of a serving process does not grant platform-wide repair authority. Production
proof depends on deployment IAM admission, secret injection, and immutable cloud
invocation logs; repository tests can prove only the executable, database
privileges, command durability, and audit behavior.

The trade-off is another image command, database login, deployment task
definition, and access-review surface. Run replay remains a new run with explicit
lineage rather than mutation of historical truth. Unknown-outcome commands append
evidence and wake reconciliation; they never overwrite an attempt outcome.

## Rejected Alternatives

- Tenant or platform-admin HTTP endpoints, because recovery must work during API
  outage and must not place cross-workspace credentials in a public process.
- Normal queue workers, because untrusted or stale delivery cannot imply operator
  authorization.
- Shell scripts that update rows directly, because they bypass invariants,
  idempotency, dry-run, and audit.
