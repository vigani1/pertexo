# Changelog

Each release says what changed for someone running Pertexo, and what they have
to do to upgrade. See [Upgrading](docs/operations/upgrading.md). Versions follow
`vMAJOR.MINOR.PATCH`; until `v1.0.0`, any minor version can need steps of its
own.

## Unreleased

- Squash migrations through 0122 into one catalog-equivalent baseline. Existing
  installations with the complete matching history are adopted without
  recreating their database or changing data and sessions. Older installations
  must first upgrade through **[RELEASE TO BE TAGGED]**, the final pre-baseline
  release; see
  [Upgrading](docs/operations/upgrading.md#baseline-transition-required-release-stop).
- Record the full PostgreSQL catalog in `packages/database/schema.sql` and
  compare every fresh migration with it in the existing database integration CI
  job.

## v0.2.0 - 2026-11-09

### Upgrade steps

This release changes the database schema. Read
[Upgrading](docs/operations/upgrading.md) before starting; do not roll older
images back across these migrations.

- Update the control-script checkout before deploying. Existing installations
  now need working off-server backups and a fresh encrypted recovery point
  whenever migrations are pending. Deployment refuses to proceed if that backup
  fails; fresh installs and deployments without pending migrations skip it. A
  fenced retry keeps the original pre-migration point.
- Add newly generated `BACKUP_CRYPT_PASSWORD` and `BACKUP_CRYPT_SALT` to the
  mode-600 `.env.production` and keep a separate offline copy. Copy only these
  new settings from `generate-secrets.mjs`; preserve existing application keys.
  Never change crypt keys in a populated encrypted backup bucket. Older
  plaintext points remain restorable with their original application keys. See
  [backup keys and rotation](docs/operations/single-server.md#backup-encryption-keys-and-rotation).
- Plan downtime with API, workers and serving stopped throughout migration.
  Migration **0110** indexes references in every retained artifact-owner
  document in one transaction; rehearse on a restored backup and reserve disk
  for indexes and WAL. Its default five-minute statement limit can be too short.
  Follow the
  [sizing and longer-retry instructions](docs/operations/upgrading.md#migration-0110-artifact-reference-backfill)
  rather than repeatedly retrying the default. The Inbox history backfill is
  **0112_inbox_failure_days.sql** and also needs writers stopped; its cost
  depends on retained failures. Migration **0117** takes policy DDL locks. Keep
  serving stopped after any failure; retry the same release or restore the
  recovery point, and never remove the migration fence to start older images.
- Deployment now grants the maintenance database login **BYPASSRLS** using the
  existing bootstrap superuser before migrations. Ensure those credentials still
  work. Custom deployments must apply
  `infrastructure/postgres/init/roles/maintenance.sql` as a superuser with
  psql's `maintenance_user` variable set before migrating. A failed grant or
  missing attribute blocks migration 0117. Keep the API on `DATABASE_URL` only;
  `DATABASE_MAINTENANCE_URL` belongs to workers and operators.
- Custom Compose or process setups must pass `HTTP_ALLOWED_PRIVATE_NETWORKS` to
  both API and worker for OAuth2 token endpoints and SMTP relays on private
  networks. Invalid CIDRs now prevent both processes from starting. Workflow
  SMTP defaults to encrypted transport; only enable `SMTP_ALLOW_PLAINTEXT=true`
  in both processes if a trusted relay needs security mode None. The shipped
  Compose file supplies both settings. Existing system-mail TLS rules are
  unchanged; see [mail setup](docs/operations/system-mail.md).
- PostgreSQL now exposes optional `POSTGRES_SHARED_BUFFERS` (default `128MB`).
  Budget it alongside the Code runner and serving processes before raising it;
  recreate the PostgreSQL container to apply a change. Online backup dumps have
  an optional `BACKUP_DUMP_TIMEOUT_SECONDS` (default `3600`, range `1`–`86400`);
  adjust it only if measured dump duration requires it.
- Preserve all retained application encryption keys, including keys used only by
  queued mail or saved public form links. Deployment and restore now include
  saved form links in stored-key verification. After deployment, run the
  [smoke check](docs/operations/single-server.md#6-smoke-check) and keep the
  recovery point until the upgraded application is verified.

### Added

- OAuth2 workflow connections for HTTP Request steps, with renewable grants,
  reconnect, and Google and Microsoft setup presets.
- SMTP workflow email connections and shared failure alerts sent through the
  server's existing mail transport. Undelivered alerts appear in the Inbox with
  a path to repair their setup.
- A visual Condition rule builder and real earlier-step fields in Insert data.
- Public form links can be shown again to workflow editors when connection
  encryption is configured. Legacy links keep working; without encryption, new
  links are shown once. Regeneration asks before invalidating an existing link.
- A served public API specification, rate-limit information, and scoped
  API-token access to workflow creation and editing, connections, retained run
  outputs, published triggers, lifecycle and pause controls, data tables and tag
  assignment.
- Encrypted incremental off-server backups while the application keeps serving.
  Shared immutable files are copied once; interrupted backups release their
  deletion pause and never publish an incomplete recovery point.

### Changed

- Variable reference checks walk all pages automatically and keep removal closed
  until the check completes, including after an offline or failed read.
- Run history, retention, artifact ownership and Inbox failure summaries use
  bounded, indexed reads to reduce database work on larger installations.
- Workspace row security uses indexed UUID comparisons. Cross-workspace worker
  scans use the maintenance login; organization requests remain on the
  restricted app login, with isolation on organization workspace links and
  directory mappings.
- Worker readiness now tracks Redis queue consumers as well as scans; a stopped
  consumer can trigger the Compose restart policy. Queue write refusals report
  unavailable readiness instead of silently appearing healthy.
- Workflow publication rejects invalid mappings and execution sizes earlier,
  with field-specific repair guidance. Incomplete pagination and uncertain
  provider effects remain explicit rather than appearing as complete success.

### Fixed

- Editor saves, publication, sharing and restore dialogs preserve unfinished
  input through failed reads, revision conflicts, session expiry and lost
  responses. Retry actions recover in place; data disappears when access is
  revoked.
- Step copying preserves JSONata item references, and version restoration
  protects unpublished edits. Public forms retain refused submissions for
  correction.
- Run recovery, cancellation, deadlines and automatic failure pauses follow
  durable outcomes, preserving confirmed provider success and uncertainty across
  retries. Live run views recover missing updates; CLI waits honor their
  deadline.
- Schedule state survives publication, invalid schedules show actionable health,
  and capacity counters are repaired during upgrade. Webhook bursts wait without
  exhausting the shared database pool and report retryable throttling or
  outages.
- Session renewal reaches browser cookies, logout waits for revocation, password
  reset links cannot outlive identity changes, and SSO/SCIM refusals give safe
  recovery guidance. Directory reads avoid conflicting locks.
- HTTP responses and diagnostics mask credentials more consistently, including
  encoded values. Private URLs, OAuth2 callbacks and failed query parameters
  stay out of logs; outbound network checks remain enforced after DNS
  resolution.
- Queued mail survives missing encryption keys during its recovery window
  without blocking workflow execution or other recipients. Failure-alert retries
  preserve delivery uncertainty and the destination used by a possibly completed
  send.
- Workspace deletion keeps membership visible until object erasure finishes,
  cleans up retained descendants in the right order and revokes OAuth2 grants.
  Recovery can restore onto a fresh server and refuses missing or incorrect keys
  before restoring data.

### Removed

- Database owner and maintenance row-security policies and forced row security;
  application row security remains enabled. Maintenance access now requires the
  explicit BYPASSRLS provisioning described above.

## v0.1.0 - 2026-10-31

The first release anyone can install.

### Added

- x86-64 and ARM64 images for every merged commit, and tags for releases.
- `deploy.sh vX.Y.Z` and `deploy.sh latest`.
- Alerts: `check.sh` and its timer, and a backup heartbeat.
- A one-command quick try for one machine.
- A runbook for any Linux server, plus pages for upgrades, recovery, keys, mail
  and operator commands.

### Changed

- `generate-secrets.mjs` now defaults to self-managed encryption keys.
- `/health/ready` now proves the database can store new data.

### Fixed

- A first deploy as the non-root login no longer fails with unreadable files.
- A restarted API no longer leaves signed-in people on a 502.
- SMTP with a login no longer crashes the worker on every message.

### Upgrading

There's nothing to upgrade from: this is the first release. Follow
[the runbook](docs/operations/single-server.md) for a new install.
