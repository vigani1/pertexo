#!/usr/bin/env bash
set -Eeuo pipefail
[[ $# == 2 ]] || { echo 'usage: restore.sh <YYYYMMDDTHHMMSSZ> <full-commit>' >&2; exit 64; }
source "$(dirname "$0")/common.sh"
check_commit "$2"
operation_lock
[[ ! -f "$BETA_STATE_DIR/current" ]] || { echo 'Restore requires a fresh stack' >&2; exit 1; }
require_no_ops
prepare_release "$2"
prepare_backup
work=$(mktemp -d "$BETA_STATE_DIR/.restore.XXXXXX")
trap 'rm -rf "$work"' EXIT
point=$(recovery_points validate "$1")
prefix="pertexo-beta/$point"
if [[ -f "$BETA_STATE_DIR/restore-fence" && $(cat "$BETA_STATE_DIR/restore-fence") != "$point" ]]; then
  echo 'A different restore is incomplete; use a fresh stack' >&2; exit 1
fi
running=$(compose ps --services --status running)
for service in "${runtime_services[@]}"; do
  if grep -qx "$service" <<< "$running"; then echo 'Serving containers must be absent for a fresh restore' >&2; exit 1; fi
done
compose up -d --wait --wait-timeout 120 postgres redis storage
rclone cat "backup:$backup_bucket/$prefix/COMPLETE" >/dev/null
for file in database.dump release.txt objects.count SHA256SUMS; do
  rclone copyto "backup:$backup_bucket/$prefix/$file" "/backup/$file"
done
# Compare only our fixed filenames, never paths supplied by a downloaded manifest.
(cd "$work"; sha256sum database.dump release.txt objects.count) > "$work/checksums.actual"
cmp -s "$work/SHA256SUMS" "$work/checksums.actual" || { echo 'Recovery point checksum mismatch' >&2; exit 1; }
[[ $(cat "$work/release.txt") == "$SERVICE_VERSION" ]] || { echo 'The supplied commit does not match this recovery point' >&2; exit 1; }
expected=$(cat "$work/objects.count")
[[ "$expected" =~ ^[0-9]+$ ]] || { echo 'Recovery point object count is invalid' >&2; exit 1; }
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
  --entrypoint /bin/sh rustfs/rc:v0.1.36@sha256:ab024bfebee49a750ce886b4c70963ccd9ddaa03f491704a90710641d7a26699 /bootstrap.sh
rclone lsf "source:$source_bucket" > "$work/existing-objects"
[[ ! -s "$work/existing-objects" ]] || { echo 'The target artifact bucket is not empty' >&2; exit 1; }
printf '%s\n' "$point" > "$BETA_STATE_DIR/restore-fence"
compose exec -T postgres sh -c 'export PGPASSWORD="$POSTGRES_PASSWORD"; exec pg_restore --no-password --clean --if-exists --single-transaction --exit-on-error --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"' < "$work/database.dump"
copied=$(copy_objects restore "$point")
[[ "$copied" == "$expected" ]] || { echo 'Recovery point object count mismatch' >&2; exit 1; }
if [[ "$copied" != 0 ]]; then
  rclone check --download "backup:$backup_bucket/$prefix/objects" "source:$source_bucket"
fi
if ! verify_encryption; then
  echo 'Restored keys could not be verified; restore fence remains in place' >&2; exit 1
fi
rm "$BETA_STATE_DIR/restore-fence"
printf 'Restored %s. Verify data, then deploy %s to resume serving.\n' "$point" "$SERVICE_VERSION"
