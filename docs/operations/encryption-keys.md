# Encryption keys

Pertexo encrypts stored connection and webhook credentials and saved public
form links. A fresh install uses self-managed keys from `generate-secrets.mjs`: a private 32-byte master key and version
`1`, with no AWS account. Save the key and its version in your password manager.

To use AWS KMS instead, generate with `--encryption=kms`, supply
`CONNECTION_KMS_KEY_REFERENCE` and `CONNECTION_KMS_REGION`, and use the AWS credential
chain, with an IAM role or privately supplied credentials. Choose before storing any
secret: switching providers with retained secrets fails verification. Public development
keys are refused in production, including as previous keys.

The generator also creates `CALLBACK_TOKEN_KEY` and `CALLBACK_TOKEN_KEY_VERSION`
for machine callback Waits. API and worker share that pair and optional
`CALLBACK_TOKEN_PREVIOUS_KEYS` (the same version/key JSON shape as invitation
keys). Save these separately in your password manager. Keep previous versions configured while live callbacks need them
(prepared, pending, or submitted but not consumed); startup checks one live hash
per version and refuses missing or wrong keys. Finished history needs no key.
Keep retired keys offline for backups containing live callbacks. The public development callback key is refused when deployed. See the
[callback guide](../guides/callbacks.md) for rotation and authentication.

To rotate self-managed keys, save a new random key with a new version, move the
old current pair into `CONNECTION_SELF_MANAGED_PREVIOUS_KEYS` (JSON
`[{"version":"1","key":"<old key>"}]`), then use the normal deployment procedure.
Deployment stops writers and verifies retained wrapped data keys before
restarting both processes with the same ring. This inventory includes connection
secret versions, OAuth tokens, webhook secrets, unexpired webhook test events,
and saved public form link capabilities. Form links use the connection encryption
purpose and are included in the connection-key count. Legacy hash-only links
have no encrypted copy and need no retained encryption key. Keep all versions
needed by live rows and by retained backups; the ring allows at most eight previous keys.
Rewrapping, retirement and provider migration are deferred. Switching providers
with retained secrets fails verification.

Prepared `api.env` and `worker.env` contain the same selected encryption fields.
The private `encryption.env` adds maintenance authority for read-only preflight;
the API never receives that URL. Docker Compose must support
`run --env-from-file`. Deployment verifies after migrations; restoration
verifies before clearing its fence. The worker checks on every startup before
background work. The API checks configuration independently and does not wait
for worker health. A plain Compose boot is not an installation-wide key-value
check; operators must use the supported deploy/restore sequence.

Self-managed configuration requires a release with the verifier. Older KMS-only
targets are refused before stopping serving with self-managed settings. For
KMS rollback, a currently installed compatible verifier checks retained data
even when the target predates verification. Automatic rollback first runs the
target image's own compiled configuration parsers in a private temporary
directory; this also refuses interim images whose verifier exists but whose
production policy still disallows self-managed keys. Failed checks keep serving
stopped.
KMS verification checks provider compatibility, not IAM access or remote
decryptability, so test a stored credential after your first deploy.

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
