# Single-server beta deployment

Status: proposed 2026-10-12. The owner wants a private beta that costs nothing,
or close to it, before any paid hosting. ADR 015 and ADR 028 stay the target
for paying customers: AWS in Frankfurt with Terraform and startup credits. This
plan adds a cheaper first home behind the same image, settings and migrations.
Nothing here changes application behaviour.

## Outcome

Pertexo runs on one Oracle Cloud Always Free ARM server (4 CPUs, 24 GB memory,
200 GB disk) at an HTTPS address, with the following:

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

1. **Oracle Cloud Always Free account.**
   - An Ubuntu 24.04 ARM (Ampere A1) instance.
   - The VCN security list open for 22, 80 and 443.
2. **An address.** A DuckDNS name works for a private test (`<name>.duckdns.org`
   with `files.<name>.duckdns.org`). Emailing anyone but the owner needs a real
   domain (about €10 a year), because Resend has to verify DNS records.
3. **Resend.** An account, a verified sending domain and one API key.
4. **AWS, for KMS only.**
   - One symmetric customer-managed key in `eu-central-1` (about $1 a month;
     calls fit the free request allowance).
   - One IAM user limited to `kms:GenerateDataKey` and `kms:Decrypt` on that
     key, with access keys.
   - Deployed mode refuses local connection encryption (`NODE_ENV=production`
     requires KMS), and this plan keeps that rule.
5. **Optional:** a Slack app for Slack connections, and Google, GitHub,
   Microsoft or Apple sign-in apps.

## Topology

Docker Compose on the server, one private network, nothing but the proxy
published:

| Service | Image | Role |
| --- | --- | --- |
| `proxy` | Caddy (pinned) | TLS for two hostnames with Let's Encrypt. `<app host>` goes to `web`, `<files host>` goes to `storage`. |
| `web` | New `web` target of the root Dockerfile | The existing `apps/web/deployment/nginx.conf.template` serving `apps/web/dist` and passing `/v1` to `api` |
| `api` | Root image | `node apps/api/dist/main.js` |
| `worker` | Root image | `node apps/worker/dist/main.js` |
| `migration` | Root image | One-shot `node packages/database/dist/migrate.js`. `api` and `worker` depend on it completing successfully. |
| `ops` | Root image | On demand: `docker compose run --rm ops …` |
| `postgres` | `postgres:18` (as in `compose.yaml`) | Reuses `infrastructure/postgres/init/10-roles.sh` for the owner, migration, app and maintenance roles |
| `redis` | Redis (as in `compose.yaml`) | Password, AOF, `noeviction` |
| `storage` | MinIO (pinned) | S3-compatible file storage |

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
  - MinIO allows CORS only from `https://<app host>`.
  - A setup step creates the bucket.
- **ARM.**
  - The Dockerfile already installs both `amd64` and `arm64` security patches.
  - Images are built natively on GitHub's `ubuntu-24.04-arm` runner, free for
    public repositories. CI keeps building `amd64`.

## Settings

Keep `.env.production.example` (names and comments, no values) in
`infrastructure/single-server/`. The real file lives only on the server
(`/opt/pertexo/.env.production`, mode 600) and is never committed.

- **From the owner:**
  - `PUBLIC_WEB_ORIGIN`;
  - `AUTH_MAIL_EMAIL_API_KEY` and `INVITATION_EMAIL_API_KEY` (one Resend key);
  - `AUTH_MAIL_FROM` and `INVITATION_EMAIL_FROM`;
  - `CONNECTION_KMS_KEY_REFERENCE` and `CONNECTION_KMS_REGION`;
  - `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`;
  - optional `AUTH_<PROVIDER>_CLIENT_ID` and `AUTH_<PROVIDER>_CLIENT_SECRET`.
- **Generated by `generate-secrets.mjs`:**
  - `BETTER_AUTH_SECRET`;
  - `AUTH_MAIL_KEY`;
  - `INVITATION_TOKEN_KEY`;
  - the Postgres superuser, migration, app and maintenance passwords;
  - `REDIS_PASSWORD`;
  - the MinIO root and application credentials.

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
   - `backup.sh`: nightly `pg_dump` (custom format, superuser) and an `mc
     mirror` of the bucket to Oracle Object Storage through its S3 API.
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
- Uptime alerts.
- Any change to application rules, schemas or stored formats.

## Done when

- Each slice's checks pass in CI.
- The owner reaches the beta over HTTPS and the smoke run passes.
- A backup restores into a fresh stack and the restored workspace opens.
- A deploy of a bad build returns to the previous release by itself.
