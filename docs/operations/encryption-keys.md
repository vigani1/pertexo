# Encryption keys

Pertexo encrypts stored connection and webhook credentials. A fresh install uses
self-managed keys from `generate-secrets.mjs`: a private 32-byte master key and version
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
restarting both processes with the same ring. Keep all versions needed by live
rows and by retained backups; the ring allows at most eight previous keys.
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
