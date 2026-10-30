# Single-server beta deployment

Status: accepted 2026-10-12; implementation in progress. The owner wants a private beta that costs nothing,
or close to it, before any paid hosting. ADR 015 and ADR 028 stay the target
for paying customers: AWS in Frankfurt with Terraform and startup credits. This
plan adds a cheaper first home behind the same image, settings and migrations.
Nothing here changes application behaviour.

## Outcome

Pertexo runs on any one Linux server with Docker, x86-64 or ARM64, at an HTTPS
address, with the following:

- one command to deploy, roll back, back up and restore;
- nightly off-server backups;
- deploys from GitHub after CI passes on `main`, turned on once the first
  launch has run cleanly for a week.

## What the beta gives up

Recorded in ADR 071 (slice 1):

- **Availability:** one server, so there's no failover and a reboot means
  downtime. The 99.9% SLO in ADR 015 doesn't apply to the beta.
- **Recovery point:** nightly backups, not a five-minute RPO.
- **Previews:** no per-PR preview deployments.
- **Monitoring:** containers and logs only. The OpenTelemetry exporter stays
  unset until a free backend is chosen; `OTEL_EXPORTER_OTLP_ENDPOINT` is the
  seam.

## Owner prerequisites

Implementation can start before these exist; the first launch can't.

1. **A server.**
   - Any Linux server with Docker, x86-64 or ARM64, of the size the runbook states.
   - Its firewall open for 22, 80 and 443.
2. **An address.** A DuckDNS name works for a private test (`<name>.duckdns.org`
   with `files.<name>.duckdns.org`). Emailing anyone but the owner needs a real
   domain (about €10 a year), because the selected mail provider needs authorized sending-domain DNS.
3. **System mail.** Resend remains the default: an account, a verified sending
   domain and one API key. The completed SMTP portability feature also permits
   an existing authenticated TLS submission server; see
   [SMTP system mail](smtp-delivery.md) and its operator instructions. Provider
   accounts, DNS and real receipt checks remain owner slice 6.
4. **AWS, when choosing KMS encryption.**
   - One symmetric customer-managed key in `eu-central-1` (about $1 a month;
     calls fit the free request allowance).
   - One IAM user limited to `kms:GenerateDataKey` and `kms:Decrypt` on that
     key, with access keys.
   - The accepted self-managed encryption plan amends the original KMS-only
     restriction. Private self-managed keys also work with deployment, worker
     startup and restore verification; public dev keys remain refused.
5. **Optional:** a Slack app for Slack connections, and Google, GitHub,
   Microsoft or Apple sign-in apps.

## Topology

Docker Compose on the server, one private network, nothing but the proxy
published:

| Service | Image | Role |
| --- | --- | --- |
| `proxy` | Caddy (pinned) | TLS for two hostnames with Let's Encrypt. `<app host>` routes `/hooks/*` and one-click unsubscribe directly to `api`, other paths to `web`; `<files host>` goes to `storage`. |
| `web` | New `web` target of the root Dockerfile | The existing `apps/web/deployment/nginx.conf.template` serving `apps/web/dist` and passing `/v1` to `api` |
| `api` | Root image | `node apps/api/dist/main.js` |
| `worker` | Root image | `node apps/worker/dist/main.js` |
| `migration` | Root image | One-shot `node packages/database/dist/migrate.js`. `api` and `worker` depend on it completing successfully. |
| `ops` | Root image | On demand: `docker compose run --rm ops …` |
| `postgres` | `postgres:18` (as in `compose.yaml`) | Reuses `infrastructure/postgres/init/10-roles.sh` for the owner, migration, app and maintenance roles |
| `redis` | Redis (as in `compose.yaml`) | Password, AOF, `noeviction` |
| `storage` | RustFS 1.0.1 (pinned) | One-process S3-compatible file storage; only its S3 port reaches the proxy |

Health checks and `restart: unless-stopped` follow `infrastructure/ecs/workloads.json`:
- `api` checks `/health/ready`.
- `worker` checks its ready marker, the absence of its not-ready marker, and PID 1.

Logs use the json-file driver with size rotation.

### Details that must be right

- **Forwarded scheme.**
  - TLS ends at a front proxy (Caddy here, the load balancer on AWS), but the
    template sets `X-Forwarded-Proto $scheme`, which is `http` behind it.
  - Change the template to keep an incoming `X-Forwarded-Proto` and fall back
    to `$scheme` (an nginx `map`). Extend `apps/web/test/deployment-proxy.test.ts`.
  - Verify a sign-in over HTTPS sets secure cookies.
  - `TRUST_PROXY_CIDRS` is the Compose network's subnet, pinned in the Compose
    file.
- **Live updates.** Caddy must not buffer `/v1` streams (`flush_interval -1`
  for the app host). nginx already sets `proxy_buffering off` and a one-hour
  read timeout.
- **Files.** Browsers use presigned links signed for `ARTIFACT_STORE_ENDPOINT`.
  - So the endpoint is `https://<files host>`, and `ARTIFACT_STORE_FORCE_PATH_STYLE=true`.
  - The `proxy` service carries both hostnames as network aliases, so `api` and
    `worker` reach storage by the same name and certificate.
  - Storage allows CORS only from `https://<app host>`.
  - A setup step creates the bucket.
- **ARM.** Since 2026-10-31 every merged commit publishes `amd64` and `arm64`
  images under one tag, and `deploy.sh` checks them against the server's own
  architecture. The notes here record how ARM publishing started.
  - The Dockerfile already installs both `amd64` and `arm64` security patches.
  - Images are built natively on GitHub's `ubuntu-24.04-arm` runner, free for
    public repositories. CI keeps building `amd64`.

## Storage revision approved by the owner

The original MinIO image and `mc` choices are replaced: the official
[MinIO server repository](https://github.com/minio/minio) and
[client repository](https://github.com/minio/mc) are archived. The owner approved
revising storage rather than deploying their unmaintained legacy binaries.

Use pinned [RustFS 1.0.1](https://github.com/rustfs/rustfs/releases/tag/1.0.1)
image as the single storage container. Use the existing AWS SDK for streaming
artifact backup and restore copies with exact metadata, and pinned
[rclone](https://rclone.org/s3/#metadata) for database files, byte verification
and retention. RustFS and rclone publish ARM64 images. Keep the existing S3 adapter and settings; qualify
conditional uploads, SHA-256 checks, presigned links, user metadata, workspace
purging and CORS against the pinned provider in slice 3. Publish only the S3
endpoint through Caddy; storage administration remains private. A pinned RustFS `rc` client performs
the idempotent bucket, CORS and application-policy setup; it is an ephemeral
command, not a serving service. No storage cluster, extra database or provider account is added.

The owner approved the SDK copier after real round trips showed that rclone
and `rc` add user metadata that the artifact adapter correctly rejects. The
adapter and its stored format remain unchanged.

Backups preserve user metadata and content type. They do not depend on provider
version IDs: Pertexo's artifact identities and immutable object keys remain the
existing authority. The backup endpoint, bucket, region and dedicated S3
credentials are owner-supplied in slice 6, from any S3-compatible store.

## Settings

Keep `.env.production.example` (names and comments, no values) in
`infrastructure/single-server/`. The real file lives only on the server
(`/opt/pertexo/.env.production`, mode 600) and is never committed.

- **From the owner:**
  - `PUBLIC_WEB_ORIGIN`;
  - `AUTH_MAIL_EMAIL_API_KEY` and `INVITATION_EMAIL_API_KEY` (one Resend key);
  - `AUTH_MAIL_FROM` and `INVITATION_EMAIL_FROM`;
  - `CONNECTION_KMS_KEY_REFERENCE` and `CONNECTION_KMS_REGION` when choosing KMS;
  - `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`;
  - optional `AUTH_<PROVIDER>_CLIENT_ID` and `AUTH_<PROVIDER>_CLIENT_SECRET`.
- **Generated by `generate-secrets.mjs`:**
  - encryption mode, plus a private current master key/version when selecting
    `--encryption=self-managed` (save separately for recovery);
  - `BETTER_AUTH_SECRET`;
  - `AUTH_MAIL_KEY`;
  - `INVITATION_TOKEN_KEY`;
  - the Postgres superuser, migration, app and maintenance passwords;
  - `REDIS_PASSWORD`;
  - the storage administrator and application credentials.

  It prints them once in the format each schema expects; check each against
  its parser. Version variables start at 1.
- **Fixed in the example:**
  - `NODE_ENV=production`, `AUTH_MAIL_MODE=durable` and
    `SESSION_COOKIE_SECURE=true`;
  - the three `DATABASE_*_URL` values and `REDIS_URL`;
  - the `ARTIFACT_STORE_*` values;
  - `PERTEXO_API_UPSTREAM=http://api:3000`;
  - `SERVICE_VERSION`, set by the deploy script to the commit.

Fix the same gap in `infrastructure/ecs/workloads.json`: the worker needs the
`INVITATION_*` settings and `PUBLIC_WEB_ORIGIN`, or invitation emails wait in
the outbox forever.

## Slices

One PR each, in order. The first PR also adds this plan.

### Implementation tracker

Checked items have their repository implementation and local checks complete;
their PR records CI and merge. This tracker does not claim a live launch or a
restore drill without the owner's accounts.

- [x] 1. ADR 071 and this plan.
- [x] 2. Runtime and web images, proxy scheme, worker settings and ARM publishing.
- [x] 3. Single-server stack, secrets, deploy command and runbook.
- [x] 4. Nightly backups, fresh-stack restore and timer.
- [x] 5. Manual deployment workflow with CI and SSH verification.
- [ ] 6. Owner-assisted first launch, smoke tests and restore drill; automatic
      deploys only after a stable week. Not part of the current implementation.

### Slice details

Slice 2 merged as #260. Main CI and the native ARM publisher passed for
`f0a1bdd71d578419fb57514d23f448b36e559941`; both commit-tagged GHCR images
are available. Runtime roles and the real web proxy passed the checks recorded
in that PR. Owner HTTPS sign-in and provider smoke evidence remain slice 6.

Slice 3 implements the private Compose stack, deployed-parser secret generation,
serialized deployment and migration-aware recovery. The owner approved replacing
SeaweedFS after its unconfigured bucket omitted version acknowledgements and
its suspended bucket retained deleted markers. Pinned RustFS 1.0.1 passes the
unchanged adapter's uploads, checksums, presigned links, metadata, CORS and
workspace purge checks with restricted application credentials. A pinned `rc`
client performs idempotent bucket, CORS and IAM setup; public storage admin paths
are blocked. Tests cover health rollback and uncertainty across migration retries.
Production permits logs without an optional OTLP exporter; deployed mail,
secure-cookie and encryption gates remain enforced (the later self-managed
plan amends the original KMS-only production restriction). HTTPS sign-in and real provider
smoke tests still belong to owner-assisted slice 6.

Slice 4 implements matched recovery points, exact-metadata SDK object transfers,
rclone byte verification, 14-day retention, a nightly systemd timer and a guarded
fresh-stack restore. Capture pauses API, worker and public ingress under the
same lock as deploy and operator commands, and resumes the previously running
services on failure. Hashes, release identity and object count accompany a
completion marker published last. An incomplete restore blocks serving until a
fresh recovery succeeds. Local qualification restores the repository schema,
all workspace rows, grants and forced RLS into a fresh PostgreSQL instance, and
checks artifact bytes and metadata through the unchanged adapter. The later
self-managed encryption qualification restores retained connection/webhook
secrets under two private key versions, verifies separately supplied keys and
rejects wrong/missing keys before serving. Recovery payloads contain no master
keys or private env files. The real
backup endpoint, installed timer and owner restore drill remain slice 6.

Slice 5 adds manual-only main dispatch with a full commit SHA, verifies the latest
successful main push CI run and its native ARM publisher, and sends only a
literal deploy command over SSH with dedicated credentials and pinned host
trust. The restricted server dispatcher uses the installed trusted control
scripts so older image rollbacks retain current recovery fences; the image tags
and extracted Compose/configuration sources still match the selected commit.
Tests cover refused evidence, command injection, private key cleanup and SSH
trust options. No real SSH connection, repository secret, launch or automatic
deployment is configured here; those remain owner-assisted slice 6.

1. **ADR 071, single-server beta.** Records the topology, what the beta gives
   up, and that AWS remains the paid target.
2. **Images.**
   - A `web` Dockerfile target: pinned unprivileged nginx, `apps/web/dist`,
     and the template rendered by nginx's `envsubst` templates.
   - The forwarded-scheme fix with its test.
   - The `workloads.json` gap.
   - CI builds both targets.
   - A `main`-only job builds `arm64` images natively and pushes them to GHCR
     as `ghcr.io/vigani1/pertexo` and `ghcr.io/vigani1/pertexo-web`, tagged by
     commit.
3. **`infrastructure/single-server/`:**
   - `compose.yaml`;
   - `Caddyfile`;
   - `.env.production.example`;
   - `generate-secrets.mjs` with a test;
   - `deploy.sh <commit>`: pull, run migration, start, wait for health, record
     the release. If a new release has no migration and comes up unhealthy, it
     returns to the previous one; a release with a migration fixes forward.
   - `docs/operations/single-server.md`: server setup (Docker, firewall
     including Ubuntu's iptables rules for 80 and 443, SSH keys only,
     unattended upgrades), first launch, deploy, rollback and `ops` commands.
4. **Backups.**
   - `backup.sh`: nightly `pg_dump` (custom format, superuser) and an exact-metadata
     streaming copy of the bucket using the existing AWS SDK to any S3-compatible
     store. Pinned rclone uploads database files, compares
     downloaded bytes and removes expired recovery points. Each recovery point has its own dated prefix. Pause serving
     writers and public storage ingress while capturing the matching database
     and objects, then resume them even if backup fails. Publish a completion
     marker only after both copies succeed; incomplete copies are not restore
     candidates.
   - Keep 14 days.
   - `restore.sh` into a fresh stack.
   - A systemd timer.
   - The runbook gains a restore drill.
5. **Deploy workflow.**
   - `.github/workflows/deploy.yml`, manual dispatch only.
   - SSH with a dedicated key and pinned host key, both from repository
     secrets.
   - It runs `deploy.sh` for a chosen commit that passed CI on `main`.
6. **First launch, with the owner.**
   - Server setup and first deploy.
   - A smoke run:
     - sign-up with the verification email;
     - create, publish and run a workflow;
     - a webhook, a schedule, a file upload and download, and the inbox;
     - an invitation and live run updates.
   - A restore drill from the latest backup.
   - After a week without incidents, a small PR triggers the workflow on CI
     success on `main`.

## Out of scope

- Terraform or anything on AWS beyond the KMS key.
- Several servers, previews, autoscaling or a managed database.
- A hosted uptime or metrics service. `check.sh` alerts from the server itself, and
  the runbook points to an outside monitor.
- Any change to application rules, schemas or stored formats.

## Done when

- Each slice's checks pass in CI.
- The owner reaches the beta over HTTPS and the smoke run passes.
- A backup restores into a fresh stack and the restored workspace opens.
- A deploy of a bad build returns to the previous release by itself.

## Public ingress follow-up (2026-10-17)

Webhook addresses are `https://<app host>/hooks/<key>`, on the application
host. Caddy routes every `/hooks/*` method directly to the API, including POST
and OPTIONS; nginx never receives credential paths. The existing one-click
route keeps the same direct path. Replace the entire URI in Caddy's default
log encoder, preserving status and operational errors without paths, query
capabilities or request headers.

The existing image qualification now always runs the pinned Caddy with the
real nginx image and production webhook ingress/controller, using isolated
storage/admission ports. Prove Signed and Secret URL acceptance, invalid-signature
refusal, CORS preflight, existing one-click behavior, and API-down privacy in
Caddy/nginx logs. Reuse the image jobs, production Caddyfile and Compose image
pin; no new service, role, dependency or CI job. Owner-assisted slice 6 stays open.
