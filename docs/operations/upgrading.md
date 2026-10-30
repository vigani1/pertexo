# Upgrading

Pertexo publishes numbered releases. [CHANGELOG.md](../../CHANGELOG.md) says what each
one changed and anything you have to do. Read the entries between your version and the new
one before you start.

## How to upgrade

1. Take a backup, so you have a recovery point from just before the upgrade:

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

## What can go wrong

**The new release is unhealthy, with no migration.** `deploy.sh` goes back to the previous
release by itself and prints `Unhealthy release returned to <commit>`.

**The new release applied a migration.** There's no rollback across a schema change: the
older images can't use the newer schema. If the release then fails, serving stays stopped and
the script says so. Don't remove `state/migration-fence` to force it. Fix forward by deploying a
fixed release, or restore the backup from step 1 with [Recovery](recovery.md), which loses
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
