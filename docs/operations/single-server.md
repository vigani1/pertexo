# Single-server beta

Implementation is in progress under [the plan](../feature-plans/single-server-beta.md)
and ADR 071. RustFS replaces SeaweedFS after real-provider qualification. First launch and provider smoke tests require the
owner's accounts (slice 6).

## Prepare Ubuntu 24.04 ARM

Use one Ampere A1 instance and attach its persistent disk. Allow TCP 22 only
from the operator's address; allow public TCP 80 and 443 in the Oracle VCN
security list. Do not expose database, Redis or storage administration ports.

Install Docker Engine and the Compose plugin using the
[official Ubuntu repository instructions](https://docs.docker.com/engine/install/ubuntu/).
Check `uname -m` returns `aarch64` and `docker compose version` succeeds. Use a
dedicated `pertexo` Unix login with SSH keys and access to Docker. Docker access
is equivalent to root; do not grant it to application users. Disable password
and root SSH login after verifying a second key-authenticated session.

Oracle Ubuntu images can also have iptables REJECT rules. Inspect
`sudo iptables -L INPUT --line-numbers -n`, insert ACCEPT rules for TCP 80 and
443 **before** the REJECT rule, and persist them with `netfilter-persistent`.
Keep the SSH rule while changing the firewall. Docker-published ports can
bypass UFW, so only Caddy publishes ports in Compose; verify from outside the
server that 3000, 5432, 6379, 9000, 9001 and storage administration are closed.
Enable Ubuntu unattended security upgrades and plan for reboot downtime.

Create `/opt/pertexo`, owned by the deployment login, mode 700. Clone the
repository into `/opt/pertexo/repository`. Leave that checkout for control
scripts; `deploy.sh` extracts each chosen commit into `releases/<commit>`.
Persistent Compose volumes belong to the stable `pertexo-beta` project. Never
run `down -v` on a serving installation.

## Public webhook address

Send webhooks to `https://<app host>/hooks/<key>`, for example
`https://app.example.com/hooks/<key>`, using the exact address shown in
**Triggers**. Use the app host, not the files host, and do not add `/v1`.
POST and browser OPTIONS go directly from Caddy to the API. Authentication
(`/v1/auth/*`) and one-click unsubscribe also bypass the web container; other
application traffic goes through it.

Webhook paths can contain credentials. They never reach nginx. Caddy replaces
the entire request URI in its default log encoder and removes request headers;
API-down errors retain their status and diagnostic information without the
credential. Preserve these rules when customizing the proxy or adding access
logging. See [webhook authentication and browser callers](../guides/webhooks.md).

## Optional sign-in providers

Google and GitHub are off until their client ID and secret pairs are configured
in the private installation environment. Follow the [sign-in provider guide](../guides/single-sign-on.md)
for registration and exact callbacks. The public address is
`https://<app host>/v1/auth/federation/social/callback/<provider>`.
Organization OIDC is configured by the control workspace owner in **Settings →
Single sign-on**, after setting the private API `AUTH_FEDERATION_KEY` and its
version. The fresh-install generator includes them. Its public callback is
`https://<app host>/v1/auth/federation/oidc/callback`. Back up the encryption key
separately; restoring only the database cannot restore encrypted provider secrets.
SAML and directory provisioning follow in the remaining F28 slices.

Keep `/v1/auth/*` routed directly from Caddy to the API: codes, state and email
proofs must never enter nginx request/error logs. Preserve Caddy's full-URI,
request-header and Location-header redaction when adding logging.

## Code runner

Code steps use the same runtime image in a separate `code-runner` service.
Only the worker shares its Unix socket volume. The runner receives no database,
Redis, storage, mail or encryption settings; it has no network, a read-only root
and private noexec tmpfs. Its root manager has only SETUID, SETGID and KILL;
single-use task processes drop to separate unprivileged users with an inherited
syscall filter, Node permissions and hard resource limits. Linux cgroup v2 and
the supported AMD64 or ARM64 image are required. A missing hardening prerequisite
refuses startup; a deployed worker refuses a development process runner before
sending run data.

The example enables Code with a 128 MB V8 heap, 30-second instance maximum,
5-second step default and two slots. `storage/prepare.mjs` derives container
memory, CPU and PID bounds from the `CODE_*` settings; the default memory ceiling
is 2,912 MiB, including native/V8 and manager headroom. This is a ceiling, not
reserved idle memory. Each process also has a hard data-memory bound and active
RSS monitoring; the heap setting alone does not bound native allocations.
Change settings through the normal deployment procedure so the API, worker and
runner agree. `CODE_STEPS_ENABLED=false` blocks publication and execution of
Code steps. Runner unavailability follows the ordinary safe retry path.

`pnpm dev` starts the development-only separate-process runner, which is weaker
than the deployed container and must not be used for untrusted production code.
The runtime and isolation decision is [ADR 082](../adr/082-isolated-code-tasks.md).

## Configure once

Copy `infrastructure/single-server/.env.production.example` to
`/opt/pertexo/.env.production`, mode 600. Use Node 24 to run the generator on a
trusted machine, or run it with the pinned runtime image and a read-only bind
mount of the source file. Append its output once, without displaying it in
shared terminals or logs. Choose encryption explicitly:

- `node infrastructure/single-server/generate-secrets.mjs --encryption=kms`
  (the default): supply the KMS reference and region; use the AWS credential
  chain, with an IAM role or privately supplied credentials.
- `node infrastructure/single-server/generate-secrets.mjs --encryption=self-managed`:
  generate a private 32-byte master key and version `1`, with no AWS encryption
  credentials. Save the key and its version in your password manager.

Fill the owner-supplied public origins and your selected system mail credentials. Keep the real
environment outside Git. Never rerun the generator over installed keys.
Regenerating keys makes retained credentials unreadable. Public development
keys are refused in production, including in previous keys.

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
decryptability; retain the existing provider smoke test.

`PUBLIC_WEB_ORIGIN` and `ARTIFACT_STORE_ENDPOINT` must be distinct HTTPS origins
on port 443. Point both DNS names at the server before launch. Caddy obtains
public certificates; private network aliases make API and worker reach files
through that same public name and certificate. The ephemeral pinned `rc` client
creates the bucket, restricts its CORS to the app and binds separate application
credentials to a bucket-only policy. The console is disabled and Caddy blocks
public admin paths. Do not put an internal hostname
in the artifact endpoint: it is embedded in browser presigned links.

The private subnet is `172.30.42.0/24`; select a server without an overlapping
network. Secure cookies, durable mail and production mode are fixed in Compose.
Optional provider pairs and previous application key rings are read from the
same environment. OTLP is optional for this beta; logs remain active. The paid
ECS definitions still supply their collector endpoint.

Generated configuration is placed in the private `/opt/pertexo/state`
directory. Compose reads dotenv as data; scripts never source the secret file.

## Deploy and recover a release

After every CI gate and ARM publication succeeds for a main commit:

```sh
/opt/pertexo/repository/infrastructure/single-server/deploy.sh <full-40-character-commit>
```

The command holds an exclusive operation lock, fetches main, verifies commit
ancestry, pulls both immutable commit tags, checks ARM/revision labels and
validates deployed configuration with the actual application parsers. It starts
private data services, stops serving writers and public ingress, completes the
one-shot migration, and waits for API, worker and web health before recording
`state/current`.

If the release applied no migration and fails health, it returns to the previous
release automatically. If migration changed the database, failed partway through,
or an earlier attempt has an unresolved migration fence, it leaves serving
stopped and requires a forward fix. Do not remove `state/migration-fence` to
force rollback. The fence persists across retries; a second attempt seeing the
migration head does not make a changed database safe for the older image.

Use an approved earlier commit with the same schema for an intentional rollback
through the same command. Never roll an image back across a schema change.
A successful command confirms container health, not an external HTTPS smoke
run. Check Caddy logs and perform the owner-assisted smoke tests before inviting
any beta users.

Images must be readable by the server. Commit-tagged packages are currently
publicly readable; if registry visibility changes, resolve it before deployment.
No registry password is embedded in this stack.

## Logs and operator commands

Select the recorded release before using Compose so images match the running
version:

```sh
export PERTEXO_BETA_ROOT=/opt/pertexo
source /opt/pertexo/repository/infrastructure/single-server/common.sh
select_release "$(cat /opt/pertexo/state/current)"
compose ps
compose logs --tail 100 api worker proxy
run_ops \
  -e OPERATOR_COMMAND_TYPE=operator.status \
  -e OPERATOR_COMMAND_ID=<new-uuid> \
  -e OPERATOR_ACTOR_REF=<operator-reference> \
  -e OPERATOR_WORKSPACE_ID=<workspace-uuid> \
  -e OPERATOR_REASON='Investigate beta workflow'
```

The ops CLI receives command fields as environment variables. Refer to the
existing operator runbooks for mutation commands, dry-run fields and evidence;
never run it as the bootstrap superuser. Containers rotate json-file logs at
10 MB with three retained files each.


## Nightly recovery points

Before first launch, create a private Oracle Object Storage backup bucket in the
owner's Oracle account and supply its S3 compatibility HTTPS endpoint, region,
bucket and dedicated credentials in `BACKUP_STORE_*`. Keep these separate from
RustFS's application credentials. The backup account must list, read, write and
delete objects only in this backup bucket; neither anonymous reads nor public
writes are needed. The endpoint must differ from the public artifact endpoint.
The local checks use disposable S3 servers; they do not prove Oracle access.

Run a capture manually before installing the timer:

```sh
/opt/pertexo/repository/infrastructure/single-server/backup.sh
```

The operation lock excludes deploy, restore and `run_ops`. The command refuses
an unresolved migration or restore. It pauses API, worker and public ingress,
captures a custom-format PostgreSQL dump as the bootstrap superuser (including
all rows behind RLS, ownership and grants), and streams artifacts with their
exact metadata using the existing AWS SDK. Rclone uploads the database and
manifest files and downloads both object sets to compare bytes. The previously
running services resume even when capture fails. Expect downtime proportional
to capture size; retention runs after serving resumes. Do not run direct
Compose mutation or database/storage commands concurrently.

Each `pertexo-beta/<YYYYMMDDTHHMMSSZ>/` prefix contains `database.dump`,
`release.txt`, `objects.count`, `SHA256SUMS`, `objects/` and a `COMPLETE` marker
published last. Only completed points are usable. A new point never overwrites
an existing prefix. Retention deletes known dated prefixes older than 14 days,
including incomplete attempts, using the point date rather than artifact mtime.
An empty artifact catalog is valid. Backup files are private, not encrypted by
these scripts: keep the bucket private and enable the provider's at-rest
protection. Preserve the production environment and required encryption keys separately;
the database and object copy alone cannot recover encrypted credentials.

Install the repository's units under their operational names:

```sh
sudo install -m 644 /opt/pertexo/repository/infrastructure/single-server/systemd/backup.service /etc/systemd/system/pertexo-backup.service
sudo install -m 644 /opt/pertexo/repository/infrastructure/single-server/systemd/backup.timer /etc/systemd/system/pertexo-backup.timer
sudo systemctl daemon-reload
sudo systemctl enable --now pertexo-backup.timer
systemctl list-timers pertexo-backup.timer
journalctl -u pertexo-backup.service --since yesterday
```

Capture runs at 03:00 UTC; a missed timer runs after the host returns. Failures
are visible in the journal. This plan adds no uptime or backup alert service.

## Restore drill or replacement server

Use a fresh disposable Docker host or a replacement server with no serving
containers, no recorded current release, an empty database and an empty artifact
bucket. Supply the original key ring separately from your password manager (or
access to the original KMS key), then prepare the mode-600 environment, repository and Docker as
above. The Compose project and volume names are stable: a second drill on the
same live host would share its data, so do not do that. Do not delete production
volumes to create a drill target.

Choose a completed point and the full commit recorded in its `release.txt`:

```sh
/opt/pertexo/repository/infrastructure/single-server/restore.sh <YYYYMMDDTHHMMSSZ> <full-40-character-commit>
```

Restore verifies the completion marker, fixed-file SHA-256 hashes and matching
release before writing. It bootstraps roles and storage permissions, restores
PostgreSQL in one transaction before any application migration, copies artifact
bytes and metadata, checks the object count and compares downloaded bytes. It
authenticates all retained self-managed wrapped data keys before clearing the
restore fence. Wrong key bytes or a missing historical version keep the fence
and serving stopped. Master keys and the production env file are never copied
into the recovery point. It leaves serving stopped so a drill cannot send mail
or repeat provider effects.
Verify ownership, workspace isolation, expected run history and artifacts with
read-only tools. Then deploy the matching commit to resume serving and perform
the HTTPS smoke checks. Keep the old server stopped during replacement; two
writers would duplicate effects. A drill must isolate provider access before
starting serving processes, and must never receive live traffic.

If restoration fails after writes begin, `state/restore-fence` blocks deployment,
backup and operator commands. Preserve the error evidence and retry on a new
fresh target; populated-target guards deliberately refuse partial-data retries.
Never remove the fence to serve partial data. A successful restore clears it.
Record the point, commit, checks and recovery duration in the owner-assisted
slice 6 drill; repository CI alone does not complete that drill.

The repository recovery qualification downloads the matched dump from storage
and restores it into fresh PostgreSQL targets. It checks retained connection
and webhook secrets under current/previous keys, wrong and missing keys,
webhook-only inventory, schema ownership, RLS and artifact bytes/metadata. It
also verifies that only the fixed recovery files and object tree were uploaded.
The existing production-image check exercises both encryption configurations.
These isolated fixtures verify repository behavior; the remote drill above
remains necessary for the owner's actual backup provider and server.



## Manual GitHub deployment (configure in slice 6)

The `Deploy beta` workflow runs only through `workflow_dispatch` from `main`.
Supply a full lowercase 40-character main commit SHA. It verifies ancestry and
queries the latest push run of `ci.yml` for that exact SHA; the entire run and
`publish-arm-images` job must have succeeded. A PR check, scheduled run, pending
publisher or previous successful run followed by a failed retry is insufficient.
No deployment follows a push automatically.

First update the server's clean control checkout with `git pull --ff-only origin
main`. Keep these installed scripts trusted and current when applying
operational fixes. They enforce current recovery fences even when deploying an
older image; release images, Compose and configuration parsers come from the
selected immutable commit. The dispatcher delegates ancestry, image identity,
locking, migration and health checks to the same `deploy.sh` used manually.

Generate a dedicated Ed25519 SSH key without a passphrase on a trusted owner
machine. Store its private half only as repository Actions secret
`BETA_SSH_PRIVATE_KEY`. Restrict the public half in the `pertexo` login's
mode-600 `~/.ssh/authorized_keys`:

```text
restrict,command="/opt/pertexo/repository/infrastructure/single-server/dispatch.sh" ssh-ed25519 <public-key> pertexo-github-beta
```

Keep a separate owner key for interactive maintenance. The `restrict` option
blocks forwarding, PTY allocation and user SSH rc execution; the forced command
accepts only `deploy <full-SHA>`. See the
[OpenSSH authorized-key documentation](https://man.openbsd.org/sshd#AUTHORIZED_KEYS_FILE_FORMAT).
Do not enable user-controlled environment loading or accept deployment path and
shell startup environment variables in sshd.

Set repository secrets `BETA_SSH_HOST` (DNS name or IP) and `BETA_SSH_USER`
(`pertexo`). Retrieve the server's public host key through the trusted Oracle
console or an already verified owner session. Compare its fingerprint through
that trusted channel, then put its known_hosts line, with the same host name
used by `BETA_SSH_HOST`, in `BETA_SSH_KNOWN_HOSTS`. Hashed known_hosts entries also
work. Do not trust a fresh key scan over the deployment connection as the source
of identity. If a replacement server changes its key, verify and update the
secret explicitly.

The client uses batch public-key authentication, `StrictHostKeyChecking=yes`,
only the pinned known_hosts file, no DNS trust or host-key updates, no agent or
port forwarding, and no user SSH configuration. Temporary key files are mode
600 and removed after success or failure. SSH secrets are available only to the
send step after CI verification. Workflow deployments serialize without
canceling a running command; the server operation lock also excludes backups,
restore and operator mutations.

During first launch, run the workflow and inspect its health result and server
logs, then complete the HTTPS smoke and restore drill. A failed SSH session is
not proof of rollback: inspect `state/current` and any migration/restore fence
before retrying. Configuring these secrets, installing the authorized key and
making the first real connection need the owner's accounts and remain slice 6.
After a stable week, automatic deployment may be proposed in a separate PR.


## System mail: Resend or SMTP

Pertexo sends verification, password reset, email-change confirmation and
workspace invitation mail through its worker. `SYSTEM_MAIL_TRANSPORT` defaults
to `resend`: configure `AUTH_MAIL_EMAIL_API_KEY` and `INVITATION_EMAIL_API_KEY`
with your verified provider key. Existing configurations remain valid.

For an existing SMTP submission server, set:

```dotenv
SYSTEM_MAIL_TRANSPORT=smtp
SYSTEM_MAIL_SMTP_HOST=smtp.example.com
SYSTEM_MAIL_SMTP_PORT=587
SYSTEM_MAIL_SMTP_TLS=starttls
SYSTEM_MAIL_SMTP_USER=your-provider-username
SYSTEM_MAIL_SMTP_PASSWORD=your-provider-password
```

Omit both Resend API keys in SMTP mode. Keep `AUTH_MAIL_FROM`,
`INVITATION_EMAIL_FROM`, `AUTH_MAIL_MODE=durable` and all generated encryption
keys. Use `implicit` for TLS from the start (default port 465). STARTTLS is
mandatory in `starttls` mode; certificate verification cannot be disabled.
Staging and production refuse plaintext. Username and password must be supplied
together; omit both only for a TLS relay you control that authorizes this server.
The generator does not create SMTP credentials; your provider issues them.

Keep the environment outside the checkout, mode 600, with a separate password
manager recovery copy. Preparation validates settings before stopping the
release and copies selected mail credentials only to the worker's private
configuration. SMTP settings do not go to API, migration or ops. Configuration
validation does not connect to the relay or prove its credentials. Deploy and
then request a verification or reset link for your own account; verify receipt
and invitation delivery before allowing real users. The owner configures the
provider's sending-domain verification, SPF, DKIM and DMARC records and any
host outbound-network rules. Portability does not mean running your own mail
server or guaranteeing deliverability.

A submitted status means the relay accepted the message, not that a mailbox
received it. Explicit temporary SMTP rejection can retry the same immutable
command; permanent rejection records failure. If the final acknowledgement is
lost, or a worker crashes while a dispatch is unresolved, SMTP cannot promise
deduplication. Pertexo leaves account mail `reconciliation_required` and
invitation attempts `unknown`; it never blindly resends them. A person can
request another account link. An unresolved invitation keeps the existing
resend restriction and requires operator reconciliation of its provider outcome.
Do not clear unknown records merely to enable resend; confirm acceptance or
nonacceptance with the relay operator first. No new reconciliation UI or command
is included in this feature.

To change transport, stop workers and establish outcomes for all unresolved
commands before changing the private environment and deploying. This includes
Resend retry rows: a scheduled retry can follow a lost acknowledgement, not just
a definite rejection. Retryable rows can use the replacement transport only
after definite nonacceptance. Keep the sender
addresses authorized at the new provider. Do not switch an unresolved Resend
command to SMTP and assume its Message-ID prevents duplicate delivery. Restores
remain fenced and stopped; supply mail credentials separately from backups and
verify the selected relay before reopening serving. Actual mail accounts and
real-server launch remain beta slice 6.

### Personal notification email upgrades

Migration 0017 renames the existing delivery queue to `system_mail_deliveries`
without rewriting its messages or permissions. Stop old API/workers before
migrating and start the matching release afterwards. Keep encrypted payloads and
the application key ring; uncertain SMTP deliveries remain in reconciliation.

The supplied Caddyfile routes RFC 8058 one-click unsubscribe directly to the API
and redacts tokens/headers in runtime errors. Keep that route and filter when
customizing the proxy; nginx request/error logs must not see its query token.
Configure the external relay to DKIM-sign both unsubscribe headers. See the
[notification guide](../guides/notifications.md#mail-operator-requirements).
