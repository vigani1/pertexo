# ADR 071: Single-server private beta

- **Status:** accepted
- **Date:** 2026-10-12
- **Plan:** [single-server beta](../feature-plans/single-server-beta.md)

Pertexo needs a low-cost private beta before paid hosting. Run that beta on any
Linux server with Docker Compose, x86-64 or ARM64, as amended below. AWS Frankfurt
remains the paid target in ADR 015 and ADR 028, subject to ADR 069's architecture
reset. This exception changes deployment guarantees, not application rules.

Caddy terminates HTTPS for the app and files hostnames. Only its ports are
published. The web image serves the existing frontend and proxies the API;
separate API, worker, migration and on-demand ops containers share a private
network with PostgreSQL, Redis and RustFS. Reuse the existing database roles,
migrations, artifact-store interface and health contracts. Deployed encryption
uses AWS KMS or private self-managed master keys, as amended below.

Use immutable commit-tagged multi-architecture images. Migrations complete before serving
processes start. An unhealthy release without a migration can return to the
previous release; a release that applied a migration must fix forward. Deploys
start as manual GitHub dispatches. Automatic deploys require a separate change
after the owner has completed the launch checks and observed a stable week.

The owner approved replacing MinIO after its community server and `mc` client
were archived. Use pinned RustFS and rclone releases with x86-64 and ARM64 images,
qualifying the unchanged S3 adapter against the chosen release. The owner then
approved RustFS after SeaweedFS failed workspace purge qualification; no
application compatibility workaround was accepted. Its pinned `rc` client is
used only for idempotent storage setup. Only S3 reaches
the files proxy; storage administration and internal ports stay private. Backup
copies use the existing AWS SDK to preserve exact artifact metadata. The owner
approved this adjustment after rclone and `rc` round trips added metadata that
the unchanged adapter rejects. Rclone handles database files, downloaded byte
comparisons and retention. Backups capture the database and objects while
serving writers and public storage ingress are paused.

The beta accepts these trade-offs:

- One server has no failover. Reboots and maintenance cause downtime; ADR 015's
  99.9% availability target does not apply to this beta.
- Nightly off-server PostgreSQL and artifact backups, retained for 14 days,
  replace the five-minute recovery-point objective. Recovery requires a restore
  into a fresh stack and a measured drill before launch.
- There are no per-PR preview deployments, managed database or autoscaling.
- Rotated container logs and health checks provide the initial operational
  evidence. The OpenTelemetry exporter remains unset until a free backend is
  chosen; `OTEL_EXPORTER_OTLP_ENDPOINT` remains the seam. Alerts come from the
  server itself, as amended below.

The owner supplies cloud accounts, DNS, mail and deployment credentials, plus
KMS access when selecting that encryption provider.
Repository implementation can proceed without them. The first HTTPS launch,
provider smoke tests and live restore drill remain owner-assisted slice 6;
configuration and CI alone do not establish that those checks passed.


## Amendment: self-managed encryption, 2026-10-13

The owner accepted [self-managed encryption](../feature-plans/self-managed-encryption.md)
to make credential encryption independent of an AWS account. Reuse the existing
AES-GCM envelope and current/previous-key pattern for connections and webhooks;
KMS remains recommended for hosted Pertexo. Production refuses the public
development key. Owners choosing self-managed keys must generate them securely
and preserve all required versions separately from database/object backups.

Installation-wide verification runs after migrations before serving and after
restore before clearing the restore fence. The worker also verifies before
constructing its background runtimes. API startup remains independent with its
existing app-role authority; extra Compose ordering is deferred. Retained secrets
prevent switching providers without a later migration procedure. Rewrapping and
key retirement are deferred; previous-key support allows rotation without them.


## Amendment: any server, releases and alerts, 2026-10-31

The owner can't use Oracle, and neither can many self-hosters, so nothing here may
depend on one provider. The beta runs on any Linux server with Docker, and backups go
to any S3-compatible store.

Images are multi-architecture: every merged commit publishes x86-64 and ARM64 under one
commit tag, each built natively and qualified before it's pushed. `deploy.sh` compares
an image with the server's own architecture. Publishing no longer waits for test jobs,
because one flaky job left commits with nothing to pull. Tests decide what ships instead:
a release is a commit with a green CI run, a `vX.Y.Z` tag and a changelog entry, and it
adds `vX.Y.Z` and `stable` to images that already exist. This ends ADR 069's "one version
until launch" for this stack; upgrades go forward through migrations only.

A server reports on itself, since an unattended install otherwise learns about outages
from its users: a timer runs `check.sh`, which alerts one webhook about disk, backups,
stopped services, readiness, the proxy path and stuck runs, and `backup.sh` pings a
dead-man switch. Readiness proves the database can store new data, and a deploy or backup
is finished only when a request gets through the proxy to the API. This is deliberately
not Prometheus on the beta server. The outside monitor for a dead server stays the
operator's choice.

A one-command quick try runs the same images on one machine in development mode, on
loopback only. It's the only thing allowed to relax production's rules, and only because
it can't be reached from another machine.
