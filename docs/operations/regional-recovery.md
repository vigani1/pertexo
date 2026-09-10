# Regional recovery runbook

This runbook implements the dependency order in ADR 015. It is an operator
procedure, not evidence that a regional restore drill has passed.

Live use requires completed E01-13 and E01-14 fields in the
[external qualification approval packet](./external-platform-contract.md#e01-13--backup-restore-and-point-in-time-recovery),
including exact resource selectors, synthetic markers, spend/window limits,
operators, cleanup owner and approvals. The repository does not supply those
deployment-specific values.

## Preconditions

- Declare and audit the recovery attempt.
- Fence public ingress and every durable writer in both regions. This includes
  API, worker, dispatcher, schedule, webhook, and operator command processes.
- Keep API and worker desired counts at zero, or otherwise prove that traffic
  and queue consumption cannot open during recovery.
- Confirm that no workspace creation or control-ledger command writer remains.
  The recovery executable cannot prove this deployment-wide fence itself.

## Recovery order

1. Promote the selected PostgreSQL recovery point and complete integrity checks.
2. Apply compatible migrations as a separate release job.
3. Provide the dedicated maintenance database credential and independent primary
   and recovery control-ledger credentials through the deployment secret manager.
4. Run `pnpm restore:before-serve` as a unique one-shot job. Do not run it in an
   API or worker container startup path.
5. Require a fresh exit code 0 from this recovery attempt before continuing. A
   timeout, signal, database capability mismatch, ledger readiness failure,
   regional disagreement, reconciliation bound, or cleanup failure keeps the
   gate closed.
6. Rebuild Redis from PostgreSQL-authoritative durable work.
7. Start workers with queue consumption closed, then open consumption.
8. Start the API behind closed traffic, verify role readiness, and perform the
   audited traffic cutover.

## Gate semantics

The one-shot job verifies the exact migration head and restricted maintenance
role, proves both immutable ledger buckets ready, enumerates every PostgreSQL
workspace anchor in bounded keyset pages, and reconciles each workspace through
the dual-region ledger. Every inventory sweep restarts at the beginning. The job
succeeds only after two consecutive complete sweeps have the same ordered
workspace/high-water digest and the later sweep projects zero records.

The sweep algorithm detects lower-sorting workspaces and ledger commands that
appear between sweeps, but it does not make concurrent writers safe. If the
deployment-wide fence is absent or uncertain, stop and keep serving closed.
Normal restore reconciliation never repairs a one-sided ledger tail; exact
operator command retry is the only path that may heal its own matching tail.

Record the job identity, immutable image version, start/end times, selected
PostgreSQL recovery point, inventory digest, workspace count, sweep count, and
exit status in the recovery evidence. Do not record credentials or tenant data.
Also record the latest recoverable synthetic PostgreSQL/object marker versus the
fault time and the time from declared regional loss to restored audited traffic.
ADR 015 remains authoritative: measured loss must be at most five minutes (RPO)
and traffic restoration at most 24 hours (RTO). A successful process exit alone
does not establish either bound.
