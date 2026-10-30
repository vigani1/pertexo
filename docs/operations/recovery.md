# Recovery

How to get a backup back, on a spare machine as a drill or on a replacement server.
[Setting up backups](single-server.md#7-set-up-backups) covers taking them.

## Restore drill or replacement server

Use a fresh disposable Docker host or a replacement server with no serving
containers, no recorded current release, an empty database and an empty artifact
bucket. Supply the original callback key ring separately from your password
manager. For connections, supply the original self-managed key ring or access to
the original KMS key. Then prepare the mode-600 environment, repository and Docker
as above. The Compose project and volume names are stable: a second drill on the
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
authenticates all retained self-managed wrapped data keys before clearing the
restore fence. Wrong key bytes or a missing historical version keep the fence
and serving stopped. Master keys and the production env file are never copied
into the recovery point. It leaves serving stopped so a drill cannot send mail
or repeat provider effects.
Verify ownership, workspace isolation, expected run history and artifacts with
read-only tools. Then deploy the matching commit to resume serving and perform
the HTTPS smoke checks. Keep the old server stopped during replacement; two
writers would duplicate effects. A drill must isolate provider access before
starting serving processes, and must never receive live traffic.

If restoration fails after writes begin, `state/restore-fence` blocks deployment,
backup and operator commands. Preserve the error evidence and retry on a new
fresh target; populated-target guards deliberately refuse partial-data retries.
Never remove the fence to serve partial data. A successful restore clears it.
Note the point, commit, checks and how long recovery took: that duration is your real
recovery time. Repository CI runs a restore on a stand-in store, not on yours.

The repository recovery qualification downloads the matched dump from storage
and restores it into fresh PostgreSQL targets. It checks retained connection
and webhook secrets under current/previous keys, wrong and missing keys,
webhook-only inventory, schema ownership, RLS and artifact bytes/metadata. It
also verifies that only the fixed recovery files and object tree were uploaded.
Restricted folder and connection modes, grants, original member identities,
workflow relationships and sharing revisions must survive the same restore, with
forced workspace isolation intact. Callback material is reopened with the
separately supplied versioned token keys.
The existing production-image check exercises both encryption configurations.
These isolated fixtures verify repository behavior; only a drill proves your own backup
provider and server.
