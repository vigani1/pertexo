# Production Data Policy Inputs

## Status

These are operated launch inputs for engineering controls, not legal advice,
legal certification, or a claim of regulatory compliance.

## Retention

| Data | Default retention |
| --- | ---: |
| Detailed node attempts, events, logs, and run input | 30 days |
| Run artifacts | 30 days unless referenced by a longer-retained record |
| Preview runs | 7 days |
| Run and trigger summaries | 90 days |
| Audit and security events | 365 days, subject to approved legal policy |
| Recoverable encrypted tenant backup material | 35 days |

Idempotency and replay records remain at least as long as their operation's
retry or replay window.

## Legal Hold

Legal hold is parked until enterprise or compliance work needs it ([ADR
069](../adr/069-architecture-reset.md)). Until then no destructive processing is
paused for a legal case.

## Data Minimization

The product data inventory assigns a documented purpose and accountable owner to
each retained category before production. Deletion tombstones and retained
audit facts contain only workspace pseudonymous identity, command and
policy references, actor role/reference, timestamps, and outcome. They exclude
workflow payloads, artifact bytes, secrets, authorization headers, email
addresses, connection credentials, and provider response bodies. Billing facts
are reduced to non-content aggregates and are anonymized when tenant identity is
no longer required by the approved finance policy. Any exception requires a
recorded purpose, owner, retention period, and legal approval before collection.

## Deletion And Backups

Workspace deletion has a 30-day recovery window before purge. Purge removes
serving data explicitly across PostgreSQL, objects, encrypted secrets, indexes,
and external subscriptions. Backup copies are beyond serving use and become
ineligible for recovery through normal encrypted rotation at 35 days. This
applies to automated PostgreSQL backups, WAL archives, snapshots, manual recovery
points, tenant-object versions, and cross-region copies. Lifecycle removal is
asynchronous; inventory records the logical expiry and actual deletion lag.
Manual copies require an owner and expiry, and untracked copies are prohibited.
Shared KMS keys follow their own controlled lifecycle and are not evidence that
retained ciphertext still exists.

A restored database carries its own record of workspace deletion commands.
Restoring an older backup can bring back a workspace whose later deletion is
lost; repeat the deletion request after a restore.
