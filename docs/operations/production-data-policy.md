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
| Audit log and connection events, including each credential use | The workspace's "Keep audit events" setting: 365 days by default, 30 to 2,555 |
| Sign-in and message-transport security facts | 365 days. Evidence for incidents: read by an operator, not shown in the app |
| Off-server backups (encrypted dump and shared objects) | 14 days |

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

New recovery points use rclone crypt to encrypt the full database dump, artifact
bodies, metadata and file names before upload. Points share immutable objects;
retention deletes a shared object only when no kept completed point references
it. Deleted workspace data can therefore remain recoverable until the final
referencing point expires. The bucket stays private. Application encryption keys
and the private settings file are never copied into recovery points. Hand-made
copies and retired backup buckets are the owner's responsibility to track and
delete. Shared KMS keys follow their own controlled lifecycle.

A restored database carries its own record of workspace deletion commands.
Restoring an older backup can bring back a workspace whose later deletion is
lost; repeat the deletion request after a restore.

## Backup encryption keys and rotation

`generate-secrets.mjs` generates `BACKUP_CRYPT_PASSWORD` and `BACKUP_CRYPT_SALT`.
For an existing installation, copy only these two new settings into the saved
settings; do not replace installed application keys with newly generated ones.
Put both in the server's mode-600 `.env.production` for unattended backup, and
keep the original settings file in your password manager or offline recovery
storage, separately from the backup bucket. Neither key is uploaded or logged.
The reversible rclone config is also secret. Each operation creates it with mode
0600 inside its private `state/.backup.*` or `state/.restore.*` directory, then
removes that directory on success or error, including failed preparation. Capture
also removes its config on shell EOF or dump-deadline expiry. The next backup or
restore removes legacy `state/rclone.env` and config files left in abandoned
operation directories; the operation lock makes this cleanup safe. These keys encrypt backup contents and file names through standard
[rclone crypt](https://rclone.org/crypt/), layered over the existing S3 remote.
Keep the application encryption key rings separately too.

To rotate, create a new empty backup bucket, change `BACKUP_STORE_BUCKET`, and
replace both crypt settings with newly generated values in the server and offline
settings. Take a backup and verify a restore before retiring the old store.
Rotation starts a new store; it does not re-encrypt old points. Retain each old
bucket's settings and keys until its recovery points are deleted. Do not change
keys in a populated bucket. Retention runs only on the currently configured store;
track and delete retired stores yourself after their recovery window.

On a fresh replacement or drill host, supply the settings for the chosen bucket
and its original crypt keys, then run `restore.sh <UTC-point> <full-commit>` as
shown in [Recovery](recovery.md). Missing or wrong crypt keys refuse before target
services start or data is restored, naming `BACKUP_CRYPT_PASSWORD` and
`BACKUP_CRYPT_SALT`. Lost keys cannot be recovered from the bucket.

Points created before this change remain readable from their old plaintext
`pertexo-beta/<UTC-point>/` prefix with the same restore command and original
application keys; they do not require crypt keys. New points are always encrypted.
This is a one-way recovery path: delete old unencrypted points once an encrypted
point has been restored and verified. Keep the bucket private while they remain.
