# Production Data Policy

## Status

What the software does with data today on a [single-server install](single-server.md):
engineering defaults, not legal advice, legal certification or a claim of regulatory
compliance. Whoever runs an install decides whether these suit their data and law.

## Retention

| Data | Default retention |
| --- | ---: |
| Detailed node attempts, events, logs, and run input | 30 days |
| Run artifacts | 30 days unless referenced by a longer-retained record |
| Preview runs | 7 days |
| Run and trigger summaries | 90 days |
| Audit and security events | 365 days, subject to approved legal policy |
| Off-server backups (database dump and file copies) | 14 days |

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

Workspace deletion has a 30-day recovery window before purge. The request
revokes the workspace's sessions and API tokens; a restore brings the workspace
back `suspended` and revives neither, and the workspace owner lifts the suspension
with Reactivate, which leaves tokens revoked and triggers and connections off. Purge
removes serving data explicitly across PostgreSQL, objects, encrypted secrets,
indexes, and external subscriptions. A deleted workspace stays in backups until they
expire: `backup.sh` removes each recovery point older than 14 days, the next time it runs.
So purged data can stay recoverable for up to 14 days afterward.

Recovery points are private but **not encrypted by the scripts**. They hold full database
dumps, including run history and personal data, and copies of files. Keep the bucket private
and use your storage provider's encryption at rest. Encrypted connection credentials stay
encrypted inside the dump, and their keys are never copied into a backup. Any copy you make
by hand is yours to track and delete. Shared KMS keys follow their own controlled lifecycle
and are not evidence that retained ciphertext still exists.

A restored database carries its own record of workspace deletion commands.
Restoring an older backup can bring back a workspace whose later deletion is
lost; repeat the deletion request after a restore.
