# ADR 071: Single-server private beta

- **Status:** accepted
- **Date:** 2026-10-12
- **Plan:** [single-server beta](../feature-plans/single-server-beta.md)

Pertexo needs a low-cost private beta before paid hosting. Run that beta on one
Oracle Cloud Always Free ARM Ubuntu server with Docker Compose. AWS Frankfurt
remains the paid target in ADR 015 and ADR 028, subject to ADR 069's architecture
reset. This exception changes deployment guarantees, not application rules.

Caddy terminates HTTPS for the app and files hostnames. Only its ports are
published. The web image serves the existing frontend and proxies the API;
separate API, worker, migration and on-demand ops containers share a private
network with PostgreSQL, Redis and RustFS. Reuse the existing database roles,
migrations, artifact-store interface and health contracts. Deployed encryption
uses AWS KMS or private self-managed master keys, as amended below.

Use immutable commit-tagged ARM images. Migrations complete before serving
processes start. An unhealthy release without a migration can return to the
previous release; a release that applied a migration must fix forward. Deploys
start as manual GitHub dispatches. Automatic deploys require a separate change
after the owner has completed the launch checks and observed a stable week.

The owner approved replacing MinIO after its community server and `mc` client
were archived. Use pinned RustFS and rclone releases with ARM64 images,
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
  chosen; `OTEL_EXPORTER_OTLP_ENDPOINT` remains the seam. Uptime alerts are
  outside this plan.

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
