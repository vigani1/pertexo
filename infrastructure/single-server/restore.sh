#!/usr/bin/env bash
set -Eeuo pipefail
[[ $# == 2 ]] || { echo 'usage: restore.sh <YYYYMMDDTHHMMSSZ> <full-commit>' >&2; exit 64; }
source "$(dirname "$0")/release-operations.sh"
check_commit "$2"
operation_lock
clear_stale_backup_configs
[[ ! -f "$BETA_STATE_DIR/current" ]] || { echo 'Restore requires a fresh stack' >&2; exit 1; }
require_no_ops
prepare_release "$2"
work=$(mktemp -d "$BETA_STATE_DIR/.restore.XXXXXX")
trap 'rm -rf "$work"' EXIT
prepare_backup
point=$(recovery_points validate "$1")
prefix="pertexo-beta/$point"
if [[ -f "$BETA_STATE_DIR/restore-fence" && $(cat "$BETA_STATE_DIR/restore-fence") != "$point" ]]; then
  echo 'A different restore is incomplete; use a fresh stack' >&2; exit 1
fi
running=$(compose ps --services --status running)
for service in "${runtime_services[@]}"; do
  if grep -qx "$service" <<< "$running"; then echo 'Serving containers must be absent for a fresh restore' >&2; exit 1; fi
done
# Read the off-server point before creating any target services or volumes.
backup_network=bridge
remote="backup:$backup_bucket/$prefix"
encrypted=false
# cat can succeed with no output for a missing S3 object; COMPLETE is empty.
if [[ $(rclone lsf "$remote" --files-only --max-depth 1 --include COMPLETE) != COMPLETE ]]; then
  verify_backup_key
  remote="crypt:$prefix"
  encrypted=true
  [[ $(rclone lsf "$remote" --files-only --max-depth 1 --include COMPLETE) == COMPLETE ]] || { echo 'Recovery point is incomplete: COMPLETE is missing' >&2; exit 1; }
fi
files=(database.dump release.txt objects.count)
[[ $encrypted == false ]] || files+=(objects.json)
for file in "${files[@]}" SHA256SUMS; do
  rclone copyto "$remote/$file" "/backup/$file"
done
# Compare only our fixed filenames, never paths supplied by a downloaded manifest.
(cd "$work"; sha256sum "${files[@]}") > "$work/checksums.actual"
cmp -s "$work/SHA256SUMS" "$work/checksums.actual" || { echo 'Recovery point checksum mismatch' >&2; exit 1; }
[[ $(cat "$work/release.txt") == "$SERVICE_VERSION" ]] || { echo 'The supplied commit does not match this recovery point' >&2; exit 1; }
expected=$(cat "$work/objects.count")
[[ "$expected" =~ ^[0-9]+$ ]] || { echo 'Recovery point object count is invalid' >&2; exit 1; }
if [[ $encrypted == true ]]; then
  actual=$(backup_helper restore-objects.mjs validate /backup)
  [[ $actual == "$expected" ]] || { echo 'Recovery point manifest count mismatch' >&2; exit 1; }
fi
compose up -d --wait --wait-timeout 120 postgres redis storage
unset backup_network
relations=$(compose exec -T postgres sh -c 'export PGPASSWORD="$POSTGRES_PASSWORD"; exec psql --no-password --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" -At -v ON_ERROR_STOP=1' <<'SQL'
SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_'
AND c.relkind IN ('r','p','v','m','S','f');
SQL
)
[[ "$relations" == 0 ]] || { echo 'The target database is not empty' >&2; exit 1; }
# Bucket and IAM setup are idempotent; there is no migration before restoration.
docker run --rm --read-only --tmpfs /tmp --user "$(id -u):$(id -g)" \
  --network pertexo-beta_private --env-file "$BETA_STATE_DIR/rc.env" \
  -v "$BETA_STATE_DIR:/prepared:ro" -v "$release/infrastructure/single-server/storage/bootstrap.sh:/bootstrap.sh:ro" \
  --entrypoint /bin/sh rustfs/rc:v0.1.37@sha256:7e93fd410a8fe51514f89373e093392c92095b98dc6140335fcfe956810c4c80 /bootstrap.sh
rclone lsf "source:$source_bucket" > "$work/existing-objects"
[[ ! -s "$work/existing-objects" ]] || { echo 'The target artifact bucket is not empty' >&2; exit 1; }
printf '%s\n' "$point" > "$BETA_STATE_DIR/restore-fence"
compose exec -T postgres sh -c 'export PGPASSWORD="$POSTGRES_PASSWORD"; exec pg_restore --no-password --clean --if-exists --single-transaction --exit-on-error --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"' < "$work/database.dump"
if [[ $encrypted == true ]]; then
  copied=$(backup_helper restore-objects.mjs restore /backup)
else
  copied=$(copy_objects restore "$point")
fi
[[ "$copied" == "$expected" ]] || { echo 'Recovery point object count mismatch' >&2; exit 1; }
if [[ $encrypted == false && "$copied" != 0 ]]; then
  rclone check --download "backup:$backup_bucket/$prefix/objects" "source:$source_bucket"
fi
if ! verify_encryption; then
  echo 'Restored keys could not be verified; restore fence remains in place' >&2; exit 1
fi
rm "$BETA_STATE_DIR/restore-fence"
printf 'Restored %s. Verify data, then deploy %s to resume serving.\n' "$point" "$SERVICE_VERSION"
