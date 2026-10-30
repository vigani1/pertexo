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

## Worker file scratch

Set `ARTIFACT_SCRATCH_DIRECTORY=/var/lib/pertexo/artifact-scratch` in the
installation environment when updating an existing beta. Each worker container has its own disk-backed volume mounted at
`/var/lib/pertexo/artifact-scratch` (`ARTIFACT_SCRATCH_DIRECTORY`). The image
creates it for UID 10001 with mode 0700; spool files use 0600. Do not replace it
with tmpfs, share it between workers or include it in backups. Files are
immutable in the artifact store; scratch is disposable and is verified again
on retry. Startup removes only owned abandoned spools before consumers start.

Allow 1 GiB of scratch per worker plus at least 64 MiB filesystem headroom.
Each attempt is limited to 20 MiB across its live spools. File steps stop after
60 seconds without byte progress or at the existing run deadline. A failed
cleanup retains its charge and makes file readiness fail; correct the storage
problem, then restart that worker for startup cleanup. Ordinary capacity,
checkpoint and inline-data limits stay unchanged. Local non-container workers
use a private `.pertexo/worker-scratch` under their working directory by
default; give simultaneously running workers separate absolute paths.

ECS workers mount task-local ephemeral storage at the same path. Keep the
matching Dockerfile `VOLUME` and task `containerPath`: ECS copies the image
volume's owner and mode when preparing the mount. It is not shared storage.

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

HTTP Request steps reach only public addresses unless
`HTTP_ALLOWED_PRIVATE_NETWORKS` lists CIDRs on your own network, such as
`10.0.0.0/8,192.168.1.20/32`. The worker reads it at startup and refuses a
malformed entry. Inside those networks plain `http` is allowed; elsewhere a
request must use `https`. Cloud metadata addresses (`169.254.0.0/16`,
`fd00:ec2::/32`) stay blocked whatever the list says. Loopback passes only when
listed, and anything listed is reachable by every workflow author, so list
only services you mean to expose to workflows.

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

