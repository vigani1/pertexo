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

## Configure once

Copy `infrastructure/single-server/.env.production.example` to
`/opt/pertexo/.env.production`, mode 600. Use Node 24 to run the generator on a
trusted machine, or run it with the pinned runtime image and a read-only bind
mount of the source file. Append its output once, without displaying it in
shared terminals or logs. Fill the owner-supplied public origins, Resend and
AWS KMS credentials. Keep the real environment outside Git and in secure owner
custody for recovery. Regenerating encryption keys makes retained tokens
unreadable; recovery also needs the original managed KMS key.

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
protection. Preserve the original production environment and KMS key separately;
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
bucket. Prepare the original mode-600 environment, repository and Docker as
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
leaves serving stopped so a drill cannot send mail or repeat provider effects.
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
