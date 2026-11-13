# Upgrading

Pertexo publishes numbered releases. [CHANGELOG.md](../../CHANGELOG.md) says what each
one changed and anything you have to do. Read the entries between your version and the new
one before you start.

For the baseline release, complete the [required release stop](#baseline-transition-required-release-stop)
before deploying it.

## How to upgrade

1. Check that encrypted backups are configured and working. `deploy.sh` checks
   the selected image’s pending migrations against recorded history under the
   operation lock, before stopping writers. When migrations are pending, it requires
   a fresh encrypted recovery point; missing backup configuration or a failed backup
   stops the upgrade. With no pending migrations, application-only and same-commit
   deployments skip the backup. A fresh install has nothing to capture. A retry
   with a migration fence keeps the original pre-migration recovery point.

   To also take a manual recovery point before updating the control scripts:

   ```sh
   /opt/pertexo/repository/infrastructure/single-server/backup.sh
   ```

2. Update the control scripts. Each release's images and Compose file come from that
   release; the scripts that run them come from this checkout:

   ```sh
   git -C /opt/pertexo/repository pull --ff-only origin main
   ```

3. Deploy the newest release, or a specific one:

   ```sh
   /opt/pertexo/repository/infrastructure/single-server/deploy.sh latest
   /opt/pertexo/repository/infrastructure/single-server/deploy.sh v1.2.3
   ```

Expect downtime of about a minute without a migration, and longer with one: serving stops
before migrations run and starts after them. Versions sort as numbers, so `v0.10.0` is
newer than `v0.9.0`. Check with [the smoke check](single-server.md#6-smoke-check) afterwards.

## Migration 0001: ordinary-run history index

`0001_ordinary_run_history.sql` is the first migration after the new baseline.
It builds a partial index of ordinary (non-test) workflow runs so workflow-list
status summaries can skip retained draft-test history.

Schedule a maintenance window for existing installations with a large
`app.workflow_runs` table. The migration scans the whole table, sorts/indexes the
ordinary rows, writes the index and WAL, and needs temporary/disk space for that
work. Its duration depends on table size, storage throughput and ordinary-run
volume; the normal roughly-one-minute application-only upgrade estimate does
not apply. Allow time and disk headroom for the build before starting deployment.

The runner wraps each migration in a transaction and cannot run `CREATE INDEX
CONCURRENTLY`. This migration therefore uses normal `CREATE INDEX`, which blocks
writes to the table until its transaction commits. The supported deploy already
stops writers before migrations and leaves serving stopped until they complete;
keep that maintenance window in place. Do not run this migration alongside live
writers or edit a recorded migration to add `CONCURRENTLY`.

## Migration 0002: queue-head run admission

`0002_queue_head_admission.sql` replaces SQL functions only: the dispatcher now
checks the head of each limited queue and the workspace's free slots instead of
every queued run. It changes no table or data and runs in well under a second, so
the normal upgrade estimate applies.

## Migration 0003: ordered-start wake

`0003_ordered_start_wakeup.sql` also replaces and adds SQL functions only. When
a queued run of a limited workflow leaves the queue (it starts, or is canceled,
times out or fails first), the next run granted behind it starts straight away
instead of after a 5-second retry. It changes no table or data and runs in well
under a second, so the normal upgrade estimate applies.

## Baseline transition: required release stop

**Required stop: v0.2.0 — the final release containing migrations
0000 through 0122.** Install that release successfully before upgrading an older server to a
release containing the new baseline. This includes v0.1.0 servers and databases
that recorded only the old `0000_baseline.sql`. Update the control scripts before
both deployments, and keep the required encrypted recovery points.

The baseline release does not recreate an existing database. If all 123 recorded
names and SHA-256 checksums exactly match the frozen pre-baseline manifest, the
runner adopts it: under the existing migration advisory lock, one transaction
replaces only the migration receipts with the new baseline receipt. Stored data,
sessions, schema, privileges and sequences remain unchanged. Any later migration
then runs normally. Deployment treats this adoption as pending migration work and
requires its encrypted recovery point before stopping writers.

Partial history is refused without changing its receipts or application data,
with a message to upgrade through **v0.2.0** first. Unknown files
and checksum mismatches are also refused. Do not edit migration receipts or
checksums to bypass the check. If the history is unexpected, resolve it against
the installed release and its recovery point before retrying. A new, empty
installation applies `0000_baseline.sql` normally.

The [database migration guide](database-migrations.md) explains how subsequent
migrations update the committed catalog snapshot.

## Migration 0117: maintenance row security

Update the control scripts before deployment. `deploy.sh` now uses the existing
Postgres bootstrap superuser credentials to grant the maintenance login BYPASSRLS,
after stopping writers and before migrating. The grant is idempotent and fresh
initialization uses the same SQL. If it fails, serving remains stopped and no
migration runs; fix the credentials or role configuration and rerun deployment.
The required pre-baseline release checks the attribute in migration 0117 before
removing maintenance policies, leaving those policies intact on failure. A fresh
baseline installation also refuses a maintenance role without BYPASSRLS.

For custom deployment flows, apply
`infrastructure/postgres/init/roles/maintenance.sql` as a database superuser with
psql's `maintenance_user` variable set to the maintenance login before migrating.
The migration owner cannot grant BYPASSRLS. Keep app credentials unprivileged.
This upgrade preserves retained rows; allow a maintenance window for policy DDL
and keep writers stopped until migration completes.

## Migration 0110: artifact reference backfill

An upgrade crossing `0110_artifact_owner_references.sql` needs a maintenance window.
It reads every retained artifact-owner document and builds a derived reference index in one
transaction. Pages of 16 documents limit working memory; they do not release locks or commit
partial progress. Trigger installation blocks owner writes, and the RLS DDL takes exclusive
locks that can block reads too. These locks last until the migration commits or rolls back.
Keep API, workers and serving stopped throughout. `deploy.sh` does this before migration and
starts the application only after migration and encryption verification succeed.

### Estimate the window and disk space

Count owner rows, not artifacts: drafts, versions, snapshots, frozen suite inputs, input-case
payload revisions, step samples, previews, runs, nodes, attempts, events, checkpoints and task
responses all contribute. Old revisions and expired rows still present in those tables count.
Document size, nesting and distinct references per slot affect the cost. Rehearse the upgrade
on a restored backup with the production machine's CPU, storage and PostgreSQL settings.

Measured locally with PostgreSQL 18 in an ARM64 Docker VM (10 CPUs, 12 GB RAM), using retained
versions and run events containing about 34 KiB of JSON and ten file references each, plus
drafts, runs and populated examples of every other family:

| Owner rows | Derived reference rows | Migration elapsed | Added index/table size | WAL generated |
| ---: | ---: | ---: | ---: | ---: |
| 20,253 | 201,058 | 72.4 seconds | 59.6 MiB | 597 MiB |
| 101,053 | 1,005,058 | 13.6 minutes | 297.4 MiB | 4.23 GiB |

The measurements exclude fixture creation and include the full 0110 migration through
commit. These are sizing examples, not throughput guarantees: about 1.2 minutes at 20,000
owner rows and 14 minutes at 100,000 on this file-heavy workload. Cost grew faster than row
count, so do not extrapolate a fixed seconds-per-row rate. Verification work shared the host
during the last part of the larger run; it had already exceeded five minutes before that.

The 100,000-row backfill took longer than the default **300 seconds**, even without lock
contention. A large installation retaining 1,000 runs/day with 100 owner records/run for
14 days has about 1.4 million owner rows. Do not assume the default limit, or the retry limit
in the example below, can handle that installation: measure its full backup rehearsal and
budget accordingly. Small documents with no files can be much faster; larger or more deeply
nested documents, slower disks, competing work and replication can take longer.

Reserve space for the derived table and its indexes, WAL and any replication/archive backlog,
in addition to the pre-upgrade backup. A failed attempt also generates WAL. Paging does not
bound total disk growth. The source JSON is preserved; the new table is derived storage.

### Timeouts and a longer retry

The runner defaults to a **300-second statement timeout** and a **10-second lock timeout**.
The complete backfill is one `DO` statement: the five-minute limit does not restart for each
page. Lock timeout means another session is preventing migration; stop or drain that session
instead of treating it as slow backfill. The runner sets both timeouts itself, so changing
`PGOPTIONS` or a database/role default does not override them.

If a timeout aborts 0110, PostgreSQL rolls back its table, triggers, backfill and migration
receipt together and releases its locks. Earlier migration files may already have committed.
`deploy.sh` exits with serving still stopped and keeps `state/migration-fence`; it does not
restart an older release. Do not remove the fence or edit an applied migration. Correct the
cause and retry the same release, or use [Recovery](recovery.md) to restore the pre-upgrade
backup if abandoning the upgrade.

For a backfill that needs longer, use the runner's existing `statementTimeoutMs` option.
After `deploy.sh` has stopped on the migration timeout, run this **Bash** command as the same
operator, with the same `PERTEXO_BETA_ROOT` if you use a custom installation path. It selects
the release recorded by the failed deployment and runs only its migration service, with a
two-hour statement limit and the normal lock limit:

```bash
(
  source /opt/pertexo/repository/infrastructure/single-server/release-operations.sh
  operation_lock
  require_no_ops
  select_release "$(cat "$BETA_STATE_DIR/migration-fence")"
  compose run --rm --no-deps migration node --input-type=module -e '
    import { parseMigrationConfig } from "./packages/database/dist/config.js";
    import { migrateDatabase } from "./packages/database/dist/migrations.js";
    const applied = await migrateDatabase(parseMigrationConfig(), undefined, {
      statementTimeoutMs: 7_200_000,
    });
    console.log(applied.length
      ? `Applied migrations: ${applied.join(", ")}`
      : "Database already at migration head.");
  '
)
```

Choose a limit from the rehearsal, with margin; it is milliseconds, between 1,000 and
2,147,483,647. This option is already supported by the runner; no migration or deployment
script changes are needed. The default deploy attempt can consume five minutes before this
retry, so include that and rollback time in the maintenance window. Avoid repeated default
retries on a dataset known to exceed the limit.

The application remains down even after this one-off succeeds. Run `deploy.sh` again with the
**same release** to complete verification, start the application and clear the fence, then
perform the smoke check. It skips migration files whose receipts already committed. Keep the
backup until the upgraded application is verified.

## What can go wrong

**The new release is unhealthy, with no migration.** `deploy.sh` goes back to the previous
release by itself and prints `Unhealthy release returned to <commit>`.

**The new release applied a migration.** There's no rollback across a schema change: the
older images can't use the newer schema. If the release then fails, serving stays stopped and
the script says so. Don't remove `state/migration-fence` to force it. Fix forward by deploying a
fixed release, or restore the pre-deploy recovery point with [Recovery](recovery.md), which loses
what happened since.

**You want to go back on purpose.** Roll back to an earlier version with the same schema
through the same command: `deploy.sh v1.2.2`. The changelog says which releases change the
schema. Never roll an image back across one.

## Skipping versions

Migrations run in order and only go forward, so going straight from an older version to the
newest one works, unless a changelog entry says otherwise. Read every entry you're skipping.

## How releases are made

Every merged commit publishes multi-architecture images tagged with the full commit. A release
is a commit with a green CI run, a `vX.Y.Z` tag and a changelog entry. The release workflow adds
`vX.Y.Z` and `stable` to images that already exist, rebuilding nothing, and publishes the notes.
To release: add the `## vX.Y.Z - YYYY-MM-DD` entry on `main` with an `### Upgrading` section, wait
for its CI, then tag that commit and push the tag.

Between releases you can deploy any commit with images (`deploy.sh <full-commit>`). Those are
tested less: nothing promises a commit's tests passed unless you check its CI run.

## Migration 0112: Inbox failure-day history

Stop the API and workers before applying `0112_inbox_failure_days.sql` and keep
them stopped until the new build is ready. The migration holds a share lock on
retained runs while it backfills the last 30 UTC days into the daily projection.
It reads all matching retained failures once; allow time proportional to that
history. It preserves existing runs and Inbox threads. Subsequent terminal writes
and run cleanup maintain the projection in their existing transactions; Inbox
pages read at most 30 rows per displayed workflow instead of recounting runs.
The migration is transactional, so a timeout leaves the old data and migration
head intact. Restart with the new build only after migration succeeds.

Organization request isolation: the API uses only `DATABASE_URL`.
`DATABASE_MAINTENANCE_URL` remains a worker/operator credential and must not be
injected into the API. Unreleased migrations 0118/0119 were revised before any
production release: 0118 retires the rejected presence lookup without granting
request privileges to maintenance; 0119 adds organization-scoped app policies to
the two authentication workspace relations. Recreate test stacks built from the
previous unreleased migration files. Normal deployments still stop writers and
provision maintenance BYPASSRLS for worker/ops workloads before migrating.
