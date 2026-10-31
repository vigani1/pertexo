# Run Pertexo on your own server

This page takes you from an empty server to a working, backed-up install, in order.
It works on any Linux server with Docker, x86-64 or ARM64. Everything after
[Monitoring and alerts](#monitoring-and-alerts) is reference for later.

To look around first, the [quick try](../../README.md#try-it-on-your-machine) runs on your
own machine in one command. It isn't for production.

You'll end up with eight containers on one server: Caddy, the web app, the API, a
worker, a Code runner, PostgreSQL, Redis and S3-compatible file storage. One server
means no failover: a reboot or maintenance is downtime.

Other pages: [Upgrading](upgrading.md), [Operator commands](operator-commands.md),
[Recovery](recovery.md), [Encryption keys](encryption-keys.md),
[System mail](system-mail.md), [Deploying from GitHub](github-deployment.md).

## 1. Prepare a server

You need one server with at least:

- 2 vCPUs
- 4 GB of memory
- 40 GB of disk

The memory leaves room for the Code runner's default ceiling of 2,912 MiB, a limit
that isn't reserved while idle, plus about 1 GB for everything else. These sizes are
a starting point, not a load-tested promise: watch memory and disk once real work
runs, and allow more for lots of files or long retention.

Use a recent Linux with cgroup v2; Ubuntu 24.04 is what this is tested on. Then:

1. Install Docker Engine and the Compose plugin using
   [Docker's instructions](https://docs.docker.com/engine/install/), plus `git` and
   `curl`. Check that `docker compose version` works.
2. Allow inbound TCP 80 and 443 from anywhere, and 22 only from your own address.
   Use your provider's network firewall if it has one. Some server images also ship
   host firewall rules that reject traffic: check `sudo iptables -L INPUT -n`, and
   keep your SSH rule while changing it. Docker-published ports can bypass UFW, so
   only Caddy publishes ports here.
3. Create a dedicated login. Docker access is equivalent to root, so don't give it to
   application users. Use SSH keys, and disable password and root SSH login after
   checking a second session works. Turn on unattended security upgrades.
4. Create the install's private directory and clone the repository into it:

```sh
sudo useradd --create-home --shell /bin/bash pertexo
sudo usermod -aG docker pertexo
sudo install -d -o pertexo -g pertexo -m 700 /opt/pertexo
sudo -iu pertexo git clone https://github.com/vigani1/pertexo.git /opt/pertexo/repository
```

Run everything below as the `pertexo` login. The checkout holds the control scripts;
`deploy.sh` extracts each release into `/opt/pertexo/releases/<commit>`. Data lives in
Docker volumes of the `pertexo-beta` Compose project, so never run `down -v` on a
serving install.

## 2. Point DNS at it

Pick two names, one for the app and one for files, and point both at the server with
A (and AAAA) records, for example `app.example.com` and `files.example.com`. They must
be different: uploaded files are served from their own origin so they can't act as the
app. Caddy gets public HTTPS certificates for both on the first deploy, which needs
these records in place and ports 80 and 443 open.

## 3. Configure

Create the settings file and add generated secrets to it. A fresh server has no Node,
so the generator runs in a container:

```sh
cd /opt/pertexo
install -m 600 repository/infrastructure/single-server/.env.production.example .env.production
docker run --rm --read-only --network none --user "$(id -u)" \
  -v "$PWD/repository/infrastructure/single-server/generate-secrets.mjs:/generate-secrets.mjs:ro" \
  --entrypoint node ghcr.io/vigani1/pertexo:stable /generate-secrets.mjs >> .env.production
```

Do this once. **Never rerun the generator over installed keys:** a new encryption key
makes every stored credential unreadable. Save the file, or at least its encryption
keys and their versions, in your password manager. The database and files alone can't
restore encrypted credentials. The generator uses self-managed encryption keys; for
AWS KMS, see [Encryption keys](encryption-keys.md).

Then edit `.env.production` and fill in:

| Setting | Value |
| --- | --- |
| `PUBLIC_WEB_ORIGIN` | `https://app.example.com` |
| `ARTIFACT_STORE_ENDPOINT` | `https://files.example.com` |
| `AUTH_MAIL_FROM`, `INVITATION_EMAIL_FROM` | Addresses your mail provider lets you send from |
| `AUTH_MAIL_EMAIL_API_KEY`, `INVITATION_EMAIL_API_KEY` | Your Resend API key, or see below for SMTP |

Mail is required: nobody can sign in until they've verified their address. To use any
SMTP server instead of Resend, delete those two API key lines and set
`SYSTEM_MAIL_TRANSPORT=smtp` and the `SYSTEM_MAIL_SMTP_*` settings. Both are described
in [System mail](system-mail.md). Your provider also has to verify your sending domain.

Both origins must be HTTPS on port 443, and the artifact endpoint must be the public
name: it's embedded in the links browsers use. API and worker reach files through that
same name. The private network is `172.30.42.0/24`, so a server with an overlapping
network needs that changed. Secure cookies, durable mail and production mode are fixed
in Compose. Keep the real file out of Git; the scripts read it as data, never as a
script.

## 4. Deploy

```sh
/opt/pertexo/repository/infrastructure/single-server/deploy.sh latest
```

The first run takes a few minutes. `latest` is the newest [release](upgrading.md);
`deploy.sh v1.2.3` or a full 40-character commit also work. The script holds a lock,
pulls images for this server's architecture, checks their revision and validates your
settings with the application's own parsers before stopping anything. It then starts
the data services, runs the migration, starts the app, and waits until a request gets
through Caddy and nginx to the API. `Healthy release: <commit>` means all of that
worked. If it stops, see [Troubleshooting](#troubleshooting).

Images are public, so no registry password is needed.

## 5. Create the first account

Open `https://app.example.com` (your app host) and sign up with your own address. Open
the verification link from the mail, then sign in and create your first workspace.

The first account to verify its address owns the install. After that, sign-up is closed:
new people need an invitation (`AUTH_SIGN_UP_MODE=invitation`, the default). Set
`AUTH_SIGN_UP_MODE=open` in `.env.production` and deploy again only if you really want
anyone who can reach the server to create an account and run workflows on it.

An address that signed up before someone else verified stays unverified, and its link says
why, until it is invited. Organization sign-in on a verified domain isn't affected: the
organization vouches for its own people. A new person arriving through a social provider
follows the same rule as sign-up.

If no mail arrives, check the worker's log (see
[Logs and operator commands](#logs-and-operator-commands)) and your provider's dashboard.
The verification link can't be fetched any other way.

## 6. Smoke check

Before inviting anyone, check these by hand:

1. `https://app.example.com` loads with a valid certificate, and so does a sign-in in a
   second browser.
2. A workflow with a webhook trigger and a Code step, published, runs when you send
   the webhook shown under **Triggers**, and the run succeeds.
3. A file step or upload stores a file, and it downloads with the same bytes.
4. An invitation to a second address arrives, and that person can join.
5. From outside the server, ports 3000, 5432, 6379, 9000 and 9001 are closed.
6. `/opt/pertexo/repository/infrastructure/single-server/check.sh` prints
   `All checks passed` (it will mention backups until the next step is done).

## 7. Set up backups

Backups go to a private bucket on any S3-compatible store, off this server. Create the
bucket and a dedicated account that can list, read, write and delete only in it. Add
to `.env.production`:

```dotenv
BACKUP_STORE_ENDPOINT=https://s3.example.net
BACKUP_STORE_REGION=us-east-1
BACKUP_STORE_BUCKET=your-backup-bucket
BACKUP_STORE_ACCESS_KEY_ID=
BACKUP_STORE_SECRET_ACCESS_KEY=
```

The endpoint must differ from your artifact endpoint. Take one backup by hand, then
turn on the nightly timer:

```sh
/opt/pertexo/repository/infrastructure/single-server/backup.sh
sudo install -m 644 /opt/pertexo/repository/infrastructure/single-server/systemd/backup.service /etc/systemd/system/pertexo-backup.service
sudo install -m 644 /opt/pertexo/repository/infrastructure/single-server/systemd/backup.timer /etc/systemd/system/pertexo-backup.timer
sudo systemctl daemon-reload
sudo systemctl enable --now pertexo-backup.timer
systemctl list-timers pertexo-backup.timer
```

A backup runs at 03:00 UTC, and a missed one runs when the host returns. **The app stops
for the length of each backup**, because the database and files have to match. Plan for
that; its length grows with your data. It resumes on its own, even if the backup fails.

Each `pertexo-beta/<YYYYMMDDTHHMMSSZ>/` prefix contains `database.dump`, `release.txt`,
`objects.count`, `SHA256SUMS`, `objects/` and a `COMPLETE` marker published last. Only
completed points are usable, and a new point never overwrites an existing prefix.
Retention deletes known dated prefixes older than 14 days, including incomplete attempts,
using the point's date rather than the file's. An empty artifact catalog is valid.

**These backups aren't encrypted by the scripts**, and they hold run history and personal
data. Keep the bucket private and turn on your provider's encryption at rest. Keep the
settings file and encryption keys separately: the backup alone can't recover encrypted
credentials. A deleted workspace stays in the backups until they expire.

A backup you haven't restored is a hope. Practise once on a spare machine with
[Recovery](recovery.md).

The operation lock excludes deploy, restore and `run_ops`. Do not run direct Compose
mutations or database or storage commands during a backup.

## Monitoring and alerts

A health check on a timer tells you about the problems a one-server install really has.
Turn it on:

1. Add a webhook to `.env.production`. Slack, Discord and Mattermost webhooks work as
   they are; anything else gets JSON with `text` and `content` fields.

   ```dotenv
   ALERT_WEBHOOK_URL=https://hooks.example.com/your-webhook
   ```

2. Install the timer:

   ```sh
   sudo install -m 644 /opt/pertexo/repository/infrastructure/single-server/systemd/check.service /etc/systemd/system/pertexo-check.service
   sudo install -m 644 /opt/pertexo/repository/infrastructure/single-server/systemd/check.timer /etc/systemd/system/pertexo-check.timer
   sudo systemctl daemon-reload
   sudo systemctl enable --now pertexo-check.timer
   ```

Every five minutes `check.sh` looks at the following, and sends one alert per problem,
again every six hours while it lasts. With no webhook it only writes to the journal
(`journalctl -u pertexo-check.service`). It stays quiet during a deploy or backup.

| Problem | Setting (default) |
| --- | --- |
| The disk holding the install or Docker's data is nearly full | `ALERT_DISK_PERCENT` (90) |
| The last completed backup is too old, or there isn't one | `ALERT_BACKUP_MAX_AGE_HOURS` (30) |
| Runs queued or running with no change for too long: stuck work | `ALERT_STUCK_MINUTES` (30) |
| A service has stopped | |
| Readiness fails: `/health/ready` also proves the database can store new data | |
| The app can't reach the API through the proxy, which means 502s for signed-in people | |

A long-running step or a full concurrency queue can also trigger the stuck-work alert, so
treat it as a prompt to look. See [Operator commands](operator-commands.md) for what to do.

Two things it can't tell you, and what to use for each:

- **The server is down, so nothing can send an alert.** Point a free outside uptime monitor
  at `https://app.example.com/v1/workspaces`, expecting status 401: that answer comes from
  the API through the whole path. If yours can only expect 200, use `https://app.example.com/v1/auth/ok`,
  which proves Caddy and the API but not the web tier between them.
- **Backups quietly stopped running.** Create a check at a dead-man switch service such as
  healthchecks.io and set `BACKUP_HEARTBEAT_URL` to its address. `backup.sh` requests it
  on success and `<url>/fail` on failure, and the service tells you when neither arrives.

Containers rotate logs at 10 MB, keeping three files. Metrics are optional:
`OTEL_EXPORTER_OTLP_ENDPOINT` sends them to a collector, and
[Observability alerts](observability-alerts.md) describes the rules for those who run one.

## Troubleshooting

Start with `check.sh` and [the logs](#logs-and-operator-commands).

| What you see | What it means, and what to do |
| --- | --- |
| `A mode-600 .env.production is required` | Run `chmod 600 /opt/pertexo/.env.production`. |
| `Image architecture/revision mismatch` | There's no image for this server's architecture at that commit. Use a release. |
| `manifest unknown` on pull | That commit's images were never published. Use a release, or check its CI run. |
| `Another operation is running` | A deploy, backup, restore or operator command holds the lock. Wait for it. |
| `Storage setup failed before migration` | The storage service isn't working. Read `compose logs storage`. |
| `Migration failed: serving remains stopped` | Read `compose logs migration`, fix the cause and deploy again. Don't remove `state/migration-fence`. |
| `Unhealthy release: fix forward` | The app didn't come up after a migration. Read the logs, then deploy again or deploy a fix. |
| `Unhealthy release returned to <commit>` | The new release failed, and the old one is serving again. |
| Deploy times out on the app, or HTTPS fails in the browser | Caddy couldn't get a certificate. Check DNS and that ports 80 and 443 are open from outside, read `compose logs proxy`, then deploy again. |
| 502 for signed-in people | `check.sh` says which part failed. Read `compose logs api web`. |
| No mail arrives | Read `compose logs worker`, then your provider's dashboard and your sending domain's records. |
| A run stays `running` or `queued` | See [Operator commands](operator-commands.md). |
| `Restore or migration is incomplete` | Finish it: see [Recovery](recovery.md), or deploy the fix for the migration. |
| Out of disk | Remove old releases under `releases/` that are neither current nor previous, and run `docker image prune`. Postgres needs free space before it accepts writes again. |

## Logs and operator commands

Select the recorded release before using Compose, so images match the running version.
Use a shell you can throw away, since the scripts turn on `set -e`, which closes it on
the first failed command:

```sh
bash
export PERTEXO_BETA_ROOT=/opt/pertexo
source /opt/pertexo/repository/infrastructure/single-server/common.sh
select_release "$(cat /opt/pertexo/state/current)"
compose ps
compose logs --tail 100 api worker proxy
```

For audited changes to stuck or uncertain work, use `run_ops` as described in
[Operator commands](operator-commands.md). Never run it as the bootstrap superuser.

## Worker file scratch

Each worker container has its own disk-backed volume mounted at
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
