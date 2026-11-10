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
- 4 GiB of memory
- 40 GB of disk

The supported minimum is **4 GiB and 2 vCPUs**, qualified on ARM64 Linux under
Docker cgroups with the example's **64 MiB Code heap and one Code slot**. The API
and worker each have a 512 MiB container cap, no additional swap allowance, and a
256 MiB V8 heap. The Code container ceiling for this preset is 1,872 MiB; it is not
reserved while idle. Existing installs retaining the 128 MiB / two-slot Code
preset need a larger memory budget: that runner ceiling alone is 2,912 MiB.

`POSTGRES_SHARED_BUFFERS` defaults to `128MB`. Budget the database together with
the other services rather than assigning it a quarter of total host RAM. A larger
host can raise it, for example to `256MB`, after checking free memory under load.
It takes effect when PostgreSQL is recreated. Keep `work_mem` at `4MB` until query
measurements justify changing it: that memory is allocated per operation.

### Qualification method and limits

The J1 qualification used a Compose override with these caps. They sum to exactly
4,096 MiB and 2 vCPUs, including the two serving-independent administration
services. Each memory+swap limit equalled its memory limit. API/worker heaps were
256 MiB. The defaults above retain the API/worker memory limits; the other caps
below describe the qualification fixture.

| Service | Memory (MiB) | CPU quota |
| --- | ---: | ---: |
| API | 512 | 0.50 |
| Worker | 512 | 0.30 |
| Code runner | 1,872 | 0.50 |
| PostgreSQL | 256 | 0.20 |
| Redis | 128 | 0.05 |
| Storage | 256 | 0.05 |
| Web | 32 | 0.05 |
| Proxy | 32 | 0.05 |
| Migration | 240 | 0.15 |
| Ops | 256 | 0.15 |
| **Total** | **4,096** | **2.00** |

The load publishes eight new webhook→Code→end workflows in two groups of four,
sends 40 signed webhook deliveries in bursts of ten, and saves/validates an editor
draft 15 times concurrently. Run completion is observed with one aggregate database
query every two seconds, avoiding 40 artificial run-page polling clients. Code
steps execute real JavaScript in the hardened runner. Docker stats are sampled
about every three seconds, Docker OOM events are recorded continuously, and the
API/worker native readiness probe results and restart counts are inspected.

The initial allocation gave Code only 0.25 vCPU and used 40 polling observers:
38/40 runs succeeded, two ended `code.runner_unavailable`, and no OOM occurred.
Reallocating the same 4 GiB / 2 vCPUs and reducing observer traffic completed all
40 runs in the defined load. No application deadline or revocation interval was
relaxed. With the authenticated browser editor open, all 40 runs completed during
a 74.27-second load phase; sampled peak aggregate working set was 752.62 MiB
(API 268.4 MiB, worker 162.3 MiB). All runs/publications/validations succeeded,
with zero OOM, restart or readiness-probe failures. These are sampled working-set
values, not reserved or worst-case resident memory. See the separate
[terminal-stream measurements](workflow-run-stream-capacity.md) for viewer costs. The retained evidence and reproducible load scripts are in the J1 audit's
`evidence/batch-j1/` directory.

This is a supported minimum for that bounded workload, not a maximum-capacity
claim. Cgroups constrain individual services, not an entire VM: they do not pin
cores or reproduce an operating system, disk bandwidth or every noisy neighbour.
Browser rendering, the test driver, operator bootstrap tools and off-server mail
and backup stand-ins are outside the serving-service budget. Stats sampling can
miss short peaks and excludes reclaimable file cache; OOM events cover cgroup
kills. Larger files, longer retention, larger graphs, more viewers, extra Code
packages or more Code slots need fresh capacity measurements and extra headroom.
The 40 GB disk starting size is for a small fresh install, not a measured storage
capacity guarantee. Keep the disk and backup-age alerts enabled.

Migration 0122 lowers autovacuum's size-dependent vacuum/insert factor to
`0.02` and analyze factor to `0.01` for `workflow_runs`, `node_runs`,
`node_attempts`, `run_checkpoints`, `run_events`, `outbox_events` and
`inbox_receipts`. Small-table thresholds stay at PostgreSQL defaults. For
150,000 estimated rows, ordinary vacuum becomes eligible after 3,050 changed
rows rather than 30,050, and analyze after 1,550 rather than 15,050. Eligibility
is not a time guarantee; workers still follow PostgreSQL's scheduling cycle.
Check `pg_stat_user_tables` for `n_dead_tup`, `last_autovacuum` and
`last_autoanalyze`, alongside host memory and disk latency, once a real workload
runs. The migration changes maintenance settings without rewriting rows.

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

The operator checkout needs Node 24 and pnpm 11 (the versions in `package.json`).
After installing those tools, build the self-contained migration inspector before deploying:

```sh
cd /opt/pertexo/repository
command pnpm install --frozen-lockfile
command pnpm build:packages
```

Repeat that build after updating the operator checkout. The compatibility gate
uses this built inspector against the **target image's** SQL/checksum and baseline
adoption manifests. It compares every recorded receipt before stopping writers,
including fenced retries and rollbacks. Existing receipts are inspected even
before a first healthy release marker exists; a missing receipt table is read as
an empty history. An adopted baseline cannot be rolled back
to the old receipt history. No receipt is changed by preflight. Baseline adoption
counts as a migration for recovery even when it applies no SQL: an unhealthy
release must fix forward because an older image may not recognize its receipts.

## 2. Point DNS at it

Pick two names, one for the app and one for files, and point both at the server with
A (and AAAA) records, for example `app.example.com` and `files.example.com`. They must
be different: uploaded files are served from their own origin so they can't act as the
app. Caddy gets public HTTPS certificates for both on the first deploy, which needs
these records in place and ports 80 and 443 open.

## 3. Configure

Create the settings file and add generated secrets with the bootstrapped Node runtime:

```sh
cd /opt/pertexo
install -m 600 repository/infrastructure/single-server/.env.production.example .env.production
node repository/infrastructure/single-server/generate-secrets.mjs >> .env.production
```

Deployment checks required Compose settings before pulling images. After pulling and
verifying the target image's revision and architecture, it runs the API, worker and
migration configuration parsers **inside that target image**, before stopping any
writers. This includes conditional SMTP, OAuth provider and encryption settings;
safe diagnostics name the setting without printing rejected values. Validation must
follow the pull so it uses the release's own schemas and installed dependencies;
no app schemas or dependency-bearing helpers execute in the operator checkout.
An invalid configuration can cost an image download, but leaves writers running.

Exported shell settings override `.env.production` for Compose interpolation,
including `ARTIFACT_STORE_ENDPOINT`. Validation and preparation read Compose-resolved service environments, including
defaults for empty exports. Secret-bearing JSON stays in a mode-600 temporary
file, mounted read-only into the helper and deleted on exit. Other settings written to the generated app env files come
from `.env.production`. Unset an exported setting to use the file's value. Run
deployment in the intended shell environment.

Do this once. **Never rerun the generator over installed keys:** a new encryption key
makes every stored credential unreadable. Save the file, or at least its encryption
keys and their versions, in your password manager. The database and files alone can't
restore encrypted credentials. The generator uses self-managed encryption keys; for
AWS KMS, see [Encryption keys](encryption-keys.md).

Then edit `.env.production` and fill in:

| Setting                                               | Value                                           |
| ----------------------------------------------------- | ----------------------------------------------- |
| `PUBLIC_WEB_ORIGIN`                                   | `https://app.example.com`                       |
| `ARTIFACT_STORE_ENDPOINT`                             | `https://files.example.com`                     |
| `AUTH_MAIL_FROM`, `INVITATION_EMAIL_FROM`             | Addresses your mail provider lets you send from |
| `AUTH_MAIL_EMAIL_API_KEY`, `INVITATION_EMAIL_API_KEY` | Your Resend API key, or see below for SMTP      |

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

Set both backup crypt keys described below before the first backup.

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

A backup runs at 03:00 UTC, and a missed one runs when the host returns. The app
keeps serving throughout. The first pass copies immutable objects not yet saved.
Then only artifact byte deletion pauses while an online consistent `pg_dump` and
a final object pass capture a matched point. Retention and workspace purge defer
erasure to their next pass; uploads and workflow execution continue.

Under the encrypted store, each `pertexo-beta/<YYYYMMDDTHHMMSSZ>/` prefix holds
`database.dump`, `release.txt`, `objects.count`, `objects.json`, `SHA256SUMS`, a
reservation marker and a `COMPLETE` marker published last. The manifest names
shared encrypted object bodies and their exact metadata and SHA-256 hashes.
Only completed points are usable; same-second retries refuse to overwrite a
reserved point. New objects are checked by downloading them once. Old objects
are not copied again. An empty artifact catalog is valid.

Retention removes known recovery points older than 14 days, including incomplete
attempts. Shared objects are deleted only when no kept completed point needs them.
A missing or damaged kept manifest stops collection before deletion.

OAuth2 connections are in the backup with their tokens, sealed like every other
credential. A service that rotates refresh tokens may have moved on since the backup
was taken: after a restore, the next renewal gets `invalid_grant` and the connection
shows **Needs reauthorization**. That is safe. Reconnect it, and the workflows that use
it carry on unchanged.

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

| Problem                                                                              | Setting (default)                 |
| ------------------------------------------------------------------------------------ | --------------------------------- |
| The disk holding the install or Docker's data is nearly full                         | `ALERT_DISK_PERCENT` (90)         |
| The last completed backup is too old, or there isn't one                             | `ALERT_BACKUP_MAX_AGE_HOURS` (30) |
| Runs queued or running with no change for too long: stuck work                       | `ALERT_STUCK_MINUTES` (30)        |
| A service has stopped                                                                |                                   |
| Readiness fails: `/health/ready` also proves the database can store new data         |                                   |
| The app can't reach the API through the proxy, which means 502s for signed-in people |                                   |

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

| What you see                                               | What it means, and what to do                                                                                                                                        |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `A mode-600 .env.production is required`                   | Run `chmod 600 /opt/pertexo/.env.production`.                                                                                                                        |
| `Image architecture/revision mismatch`                     | There's no image for this server's architecture at that commit. Use a release.                                                                                       |
| `manifest unknown` on pull                                 | That commit's images were never published. Use a release, or check its CI run.                                                                                       |
| `Another operation is running`                             | A deploy, backup, restore or operator command holds the lock. Wait for it.                                                                                           |
| `Storage setup failed before migration`                    | The storage service isn't working. Read `compose logs storage`.                                                                                                      |
| `Migration failed: serving remains stopped`                | Read `compose logs migration`, fix the cause and deploy again. Don't remove `state/migration-fence`.                                                                 |
| `Unhealthy release: fix forward`                           | The app didn't come up after a migration. Read the logs, then deploy again or deploy a fix.                                                                          |
| `Unhealthy release returned to <commit>`                   | The new release failed, and the old one is serving again.                                                                                                            |
| Deploy times out on the app, or HTTPS fails in the browser | Caddy couldn't get a certificate. Check DNS and that ports 80 and 443 are open from outside, read `compose logs proxy`, then deploy again.                           |
| 502 for signed-in people                                   | `check.sh` says which part failed. Read `compose logs api web`.                                                                                                      |
| No mail arrives                                            | Read `compose logs worker`, then your provider's dashboard and your sending domain's records.                                                                        |
| A run stays `running` or `queued`                          | See [Operator commands](operator-commands.md).                                                                                                                       |
| `Restore or migration is incomplete`                       | Finish it: see [Recovery](recovery.md), or deploy the fix for the migration.                                                                                         |
| Out of disk                                                | Remove old releases under `releases/` that are neither current nor previous, and run `docker image prune`. Postgres needs free space before it accepts writes again. |

## Logs and operator commands

Select the recorded release before using Compose, so images match the running version.
Use a shell you can throw away, since the scripts turn on `set -e`, which closes it on
the first failed command:

```sh
bash
export PERTEXO_BETA_ROOT=/opt/pertexo
source /opt/pertexo/repository/infrastructure/single-server/release-operations.sh
select_release "$(cat /opt/pertexo/state/current)"
compose ps
compose logs --tail 100 api worker proxy
```

For audited changes to stuck or uncertain work, use `run_ops` as described in
[Operator commands](operator-commands.md). Never run it as the bootstrap superuser.

### Redis outages and request limits

Sign-in, run starts and the other API request classes with a local fallback stay
available during a Redis outage. Their request counts start again in the fallback:
it has no record of requests already counted by Redis. A sign-in subject that
exhausted its Redis budget can receive another local budget (normally ten starts
per client address per minute, also subject to the account limit). Once that local
budget is exhausted, the process keeps refusing requests while that counter is retained
and until its window expires.

Each API process counts separately, even if several run on the same server.
Restarting a process clears its local counts. The bounded map holds 50,000 dimension
counters; after removing expired entries, it evicts the oldest when full, and an
evicted subject can receive a fresh budget. The distributed limit is therefore
weaker during an outage. Redis's own counts govern requests again after recovery.
Worker provider-call limits and the CSV export's exclusive slot still refuse when
their shared authority is unavailable. Accepted runs remain in PostgreSQL; restore
Redis to resume queue delivery. The policy and decision are recorded in
[ADR 012](../adr/012-fair-admission-backpressure-entitlements.md).

### Find stuck work

Workers recover stranded runs and lost jobs of every kind by themselves, so work
only stays stuck while no worker can act on it, or when Redis or Postgres is down.
[`stuck-work.list`](operator-commands.md#stuck-worklist) shows what's waiting.

A failed readiness check only reports: the worker stays up and reconnects by
itself, and an object store outage stops file steps, not other workflows. A
worker exits for good reason only: it can't start, it was told to stop, it ran
out of memory, or its recovery scan has stopped for 5 minutes. In that last case
the health check ends it and `restart` brings it back, because Docker never
restarts a container for being unhealthy. A scan that fails counts as running, so
a database outage doesn't restart anything. A stall shorter than that only logs
`worker.event_loop_delayed`.

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

## OAuth2 connections

Register `https://<your app host>/v1/connections/oauth2/callback` with each service as
the redirect address. The address comes from `PUBLIC_WEB_ORIGIN`, so changing that value
means registering the new one too. Token addresses must be public https addresses unless
their network is in `HTTP_ALLOWED_PRIVATE_NETWORKS`, which the API and worker both read.
The callback goes straight from Caddy to the API, so its code and state never reach a
proxy log. See [OAuth2 connections](../guides/oauth2-connections.md).

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

Google, GitHub, Microsoft and Apple are off until their client ID and secret
pairs are configured in the private installation environment. Follow the
[sign-in provider guide](../guides/single-sign-on.md) for registration and exact
callbacks. The public address is
`https://<app host>/v1/auth/federation/social/callback/<provider>`. Organization
OIDC is configured by the control workspace owner in **Settings → Single
sign-on**, after setting the private API `AUTH_FEDERATION_KEY` and its version.
The fresh-install generator includes them. Its public callback is
`https://<app host>/v1/auth/federation/oidc/callback`. Back up the encryption
key separately; restoring only the database cannot restore encrypted provider
secrets.

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

The example enables Code with a 64 MiB V8 heap, 30-second instance maximum,
5-second step default and one slot. `storage/prepare.mjs` derives container
memory, CPU and PID bounds from the `CODE_*` settings; the default memory ceiling
is 1,872 MiB for this preset, including native/V8 and manager headroom. This is a ceiling, not
reserved idle memory. Each process also has a hard data-memory bound and active
RSS monitoring; the heap setting alone does not bound native allocations.
Change settings through the normal deployment procedure so the API, worker and
runner agree. `CODE_STEPS_ENABLED=false` blocks publication and execution of
Code steps. Deploy first stops the worker and waits for its drain before stopping
the Code runner. The same ordering applies if an unhealthy deployment is stopped.
The drain is bounded: the worker waits up to 60 seconds for active steps, and
Compose stops it after 90 seconds. A Code step that needs longer (up to
`CODE_RUNNER_MAX_SECONDS`, 300 by default) is aborted at that point. If a
previously dispatched Code attempt loses its result, recovery ends that attempt
as `failed` with `code.interrupted` and an interrupted-execution diagnostic.
It does not execute the Code again automatically. Review the run before explicitly
rerunning it. A configured failure route can handle the failure; otherwise the
run ends as failed.

On default settings, the last heartbeat holds the attempt lease for at most
30 seconds, and recovery scans every 5 seconds. After the worker restarts, lease
expiry makes the interrupted attempt eligible for the next scan and queue
delivery; the real deploy regression requires it to reach failure within
150 seconds after restart. A custom `NODE_ATTEMPT_LEASE_SECONDS` increases the
lease bound. Database/queue outages or a backed-up queue delay recovery. Short
Code work that finishes during the drain keeps its successful result.

PostgreSQL init scripts are prepared under `state/postgres-init` and mounted from
that stable operator path. Changing release directories therefore does not change
the database mount. Preparation runs in the runtime image with the selected
release's `infrastructure/postgres/init` mounted read-only at
`/workspace/infrastructure/postgres/init`; the image does not bundle operator
sources. Runtime-image qualification supplies this same mount from its checkout.
Existing installs need one container recreation when moving
from the old release-relative mount; the data volume is preserved.

HTTP Request steps reach only public addresses unless
`HTTP_ALLOWED_PRIVATE_NETWORKS` lists CIDRs on your own network, such as
`10.0.0.0/8,192.168.1.20/32`. The worker reads it at startup and refuses a
malformed entry. Inside those networks plain `http` is allowed; elsewhere a
request must use `https`. Cloud metadata and host credential endpoints stay
blocked whatever the list says, including IPv4 embedded in IPv6:

| Provider or service                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Protected addresses                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| [AWS](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/retrieve-iid.html), [GCP](https://docs.cloud.google.com/compute/docs/metadata/overview), [Azure IMDS](https://learn.microsoft.com/en-us/azure/virtual-machines/instance-metadata-service), [DigitalOcean](https://docs.digitalocean.com/products/droplets/how-to/access-metadata/), [Hetzner](https://docs.hetzner.cloud/reference/cloud), [OpenStack](https://docs.openstack.org/nova/latest/admin/metadata-service.html) and other providers that use this address | `169.254.169.254`, covered by the protected `169.254.0.0/16` range                                         |
| [Alibaba](https://www.alibabacloud.com/help/en/ens/instance-metadata)                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `100.100.100.200`                                                                                          |
| [Azure WireServer](https://learn.microsoft.com/en-us/azure/virtual-network/what-is-ip-address-168-63-129-16)                                                                                                                                                                                                                                                                                                                                                                                                                   | `168.63.129.16` (host platform service, separate from IMDS)                                                |
| AWS IPv6 and [EKS Pod Identity](https://docs.aws.amazon.com/eks/latest/userguide/pod-identities.html)                                                                                                                                                                                                                                                                                                                                                                                                                          | `fd00:ec2::254`, `fd00:ec2::23`, covered by `fd00:ec2::/32`; `169.254.170.23` is covered by the IPv4 range |
| GCP IPv6                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `fd20:ce::254`                                                                                             |
| OpenStack IPv6                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `fe80::a9fe:a9fe`                                                                                          |
| [Akamai/Linode IPv6](https://techdocs.akamai.com/cloud-computing/docs/access-the-metadata-service-api)                                                                                                                                                                                                                                                                                                                                                                                                                         | `fd00:a9fe:a9fe::1`                                                                                        |
| Kubernetes link-local metadata proxies, including [GKE](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/workload-identity)                                                                                                                                                                                                                                                                                                                                                                                       | All of `169.254.0.0/16`, including `169.254.169.252`                                                       |

These restrictions apply to workflow HTTP requests, not host DNS or guest agents.
Loopback passes only when listed, and anything listed is reachable by every
workflow author, so list only services you mean to expose to workflows.

`pnpm dev` starts the development-only separate-process runner, which is weaker
than the deployed container and must not be used for untrusted production code.
The runtime and isolation decision is [ADR 082](../adr/082-isolated-code-tasks.md).

### Outbound HTTP credential masking

HTTP response data passes through credential masking before retention. This
includes retained response headers, inline text, parsed JSON, artifact bytes and
error excerpts. Logs and traces omit response contents and status text; they keep
method, status code, host and service correlation. No response-data path is exempt.

Masking covers admitted credential values literally, JSON escapes (including
Unicode escapes and strings nested inside strings, through **four successive
JSON-string decoding layers**), percent encoding, and base64 Basic credentials
(including their decoded username/password representation). Declared character
sets are decoded before scanning, including UTF-16; retained text uses UTF-8.
Unsupported or invalid declared character encodings refuse the response instead
of retaining unscanned bytes. Raw and retained byte limits still apply.

Decoding has a response-wide work budget: at most eight times the configured
response byte limit, with a 32 KiB minimum and a 1 MiB maximum. Each JSON or
percent decoding pass charges its entire input **before** decoding, including
buffered suffixes scanned again; retained headers share the budget. Once it is
exhausted, the response is refused with `response_redaction_limit`, and no
successful output or completed artifact is retained. This bounds expensive
nested-escape work independently of response contents. Request deadlines and
cancellation still apply. Four-layer support is subject to this work budget.

As with secret masking in CI systems, this is a bounded guarantee, not a promise
to recognize arbitrary transformations. Hashes, encryption, custom encodings and
more than four JSON-string escaping layers are not covered. A service must not
return credentials in those forms if the response will be retained.

## Interrupted backups and dump deadline

The capture helper keeps the deletion pause only while the backup shell owns an
open stdin pipe. If the shell is killed, including SIGKILL or an OOM kill, EOF
terminates the helper and closes its PostgreSQL session. Retention and purge can
then erase bytes on their next pass; an abandoned point is never completed.

`BACKUP_DUMP_TIMEOUT_SECONDS` limits the time from capture readiness until the
dump finishes. Its default is 3600 seconds (one hour); set an integer from 1 to
86400 in `.env.production` if a measured dump needs a different limit. On expiry,
the helper exits, releases deletion, and the backup fails without publishing
COMPLETE. The deadline is a backstop for a stalled dump, not a service stop.

## Backup encryption keys and rotation

`generate-secrets.mjs` generates `BACKUP_CRYPT_PASSWORD` and `BACKUP_CRYPT_SALT`.
For an existing installation, copy only these two new settings into the saved
settings; do not replace installed application keys with newly generated ones.
Put both in the server's mode-600 `.env.production` for unattended backup, and
keep the original settings file in your password manager or offline recovery
storage, separately from the backup bucket. Neither key is uploaded or logged.
The reversible `rclone.conf` is also secret. Its S3 remotes and obscured crypt
password/salt are read from a read-only file mount, never Docker environment
variables or arguments. Only the helper's UID can read the mode-600 file. Each operation creates it with mode
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

### Row-security upgrade (migration 0117)

Deploy normally with `deploy.sh`. After Postgres is ready and writers are stopped,
deployment uses the bootstrap superuser credentials already configured on the
Postgres container to grant the maintenance login `BYPASSRLS`. Fresh installs use
the same SQL definition. Repeated deployment safely repeats the grant. No new
service or credentials are needed.

If provisioning fails, writers remain stopped and migrations do not run. Correct
the Postgres bootstrap credentials or role configuration and rerun deployment.
Do not remove maintenance policies manually: migration 0117 checks BYPASSRLS before
removing them. For deployments outside this script, a database superuser must apply
`infrastructure/postgres/init/roles/maintenance.sql` with the `maintenance_user`
psql variable before running migrations. The migration owner cannot grant this
attribute. Keep the app login without BYPASSRLS; maintenance credentials are only
for cross-workspace jobs and operator commands. Serving requests, including
organization management, SSO/SAML and SCIM, keep the app login and use verified
transaction-local organization context. Do not inject maintenance credentials
into the API or expose either connection URL to the web client.

Backup transport runs from the official digest-pinned rclone image selected in
`infrastructure/single-server/backup/compose.yaml`; Dependabot updates this pin.
The operator resolves it once for each backup or restore.
No rclone executable is included in Pertexo images. Direct transport commands use
`docker run --rm` on the operation's backup network, with only its private
read-only `rclone.conf` and `/backup` mount. Each helper invocation reuses one short-lived
upstream container for its requests, avoiding a container start per retained
manifest. The host dispatches requests through the private operation directory;
the helper receives neither Docker socket access nor a Docker executable. Its database deletion lock, one-hour dump deadline
and stdin-EOF owner lifetime remain authoritative. Ending the helper removes its
runtime container, upstream transport container and dispatcher. Obscuring the crypt credentials
also uses the upstream container over stdin, without exposing passwords in argv.

## Local release and image retention

A successful deployment and a successful backup run `prune.sh` under the same
operation lock. It retains the three most recently extracted releases, the
recorded current and previous release, every release named by a retained encrypted
or legacy recovery point (including incomplete points), and images used by any
container. These references are exceptions to the three-release bound. Nightly
backup expiry removes old recovery references; its subsequent cleanup can then
remove those local releases. Remote recovery points and registry images are never
deleted by local cleanup.

Only SHA-named directories under `/opt/pertexo/releases` and their exact
`ghcr.io/vigani1/pertexo:<sha>` / `pertexo-web:<sha>` tags are eligible. Cleanup does
not run a global Docker prune or force-remove images. It refuses cleanup during
an unresolved restore or migration. A failed catalogue read, wrong backup key, or
removed backup configuration after a recorded backup defers all cleanup rather
than treating unknown recovery references as empty. In-use image removal failures
retain the source directory. The successful deploy/backup remains successful and
prints a cleanup diagnostic; resolve it before disk pressure builds up.

To retry independently as the operator:

```sh
bash /opt/pertexo/repository/infrastructure/single-server/prune.sh
```

Keep the off-server backup settings and keys available to read recovery references.
On an install that has never configured backups, current/previous and the three
recent releases are sufficient. Run the first configured backup to initialise its
key check before expecting catalogue-based cleanup to succeed.
Helpers carry `io.pertexo.backup.helper`, `project`, `operation` and `instance`
Docker labels. The installation root is the stable project identity; backup and
restore are separate operations. A restart removes stale helpers for that project
and operation before starting a replacement, even if its private CID file is
missing or belongs to a previous operation directory. Exit cleanup targets only
its own invocation, so an old dispatcher cannot remove its replacement or another
project's helpers. CID files are diagnostic records for new helpers. Migration of
a pre-label CID requires the pinned image and no conflicting Pertexo or Compose
ownership labels.

The five recovery payload files upload together through an explicit filename
allowlist; private operation files are excluded. `COMPLETE` is still uploaded
separately and last, after that copy succeeds.

The runtime helper starts only after transport readiness. Transport failure stops
its owned runtime helper, closes the database session and releases the deletion
pause; no recovery point is completed. Startup failure returns a clear nonzero
failure before a runtime helper can acquire a pause.

The backup image catalog belongs to the operator scripts, independently of the
selected installed release. This also permits backup-before-upgrade when that
older release predates the external transport. Its directory is covered by the
existing grouped Compose Dependabot entry.

Preparation and capture helpers also come from the operator checkout, while the
selected release supplies the compatible Node runtime and application dependencies.
This prevents a backup-before-upgrade from falling back to an older helper that
executes an embedded rclone binary.
