#!/usr/bin/env bash
set -Eeuo pipefail
[[ $# == 0 ]] || { echo 'usage: backup.sh' >&2; exit 64; }
source "$(dirname "$0")/release-operations.sh"
work=''
capture_pid=''
dump_pid=''
# A dead-man switch notices the night nothing arrives; /fail says so sooner.
report_outcome() {
  local url
  url=$(config_value BACKUP_HEARTBEAT_URL)
  [[ -n $url ]] || return 0
  url=${url%/}
  [[ $1 == 0 ]] || url+=/fail
  curl --fail --silent --show-error --max-time 10 --retry 3 --output /dev/null "$url" || echo 'The backup heartbeat could not be sent' >&2
}
finish() {
  result=$?
  trap - EXIT
  exec 8>&-
  [[ -z $dump_pid ]] || kill "$dump_pid" 2>/dev/null || true
  [[ -z $capture_pid ]] || kill "$capture_pid" 2>/dev/null || true
  [[ -z $capture_pid ]] || wait "$capture_pid" 2>/dev/null || true
  [[ -z $work ]] || rm -rf "$work"
  report_outcome "$result"
  exit "$result"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
operation_lock
clear_stale_backup_configs
[[ -f "$BETA_STATE_DIR/current" && ! -f "$BETA_STATE_DIR/migration-fence" && ! -f "$BETA_STATE_DIR/restore-fence" ]] || { echo 'A settled current release is required for backup' >&2; exit 1; }
select_release "$(cat "$BETA_STATE_DIR/current")"
require_no_ops
[[ -n $(config_value BACKUP_CRYPT_PASSWORD) && -n $(config_value BACKUP_CRYPT_SALT) ]] || { echo 'Provide BACKUP_CRYPT_PASSWORD and BACKUP_CRYPT_SALT from the separately held settings file' >&2; exit 1; }
work=$(mktemp -d "$BETA_STATE_DIR/.backup.XXXXXX")
prepare_backup
point=$(date -u +%Y%m%dT%H%M%SZ)
prefix="pertexo-beta/$point"
rclone lsf "backup:$backup_bucket/encrypted" --max-depth 1 > "$work/store"
if [[ ! -s "$work/store" ]]; then
  printf 'Pertexo encrypted backups\n' > "$work/KEYCHECK"
  rclone copyto /backup/KEYCHECK crypt:KEYCHECK
fi
verify_backup_key
rclone lsf "crypt:" --dirs-only --recursive --max-depth 2 > "$work/points"
rclone lsf "backup:$backup_bucket" --dirs-only --recursive --max-depth 2 >> "$work/points"
if grep -qx "$prefix/" "$work/points"; then
  echo 'That recovery point already exists; refusing overwrite' >&2; exit 1
fi
: > "$work/STARTED"
rclone copyto /backup/STARTED "crypt:$prefix/STARTED"
mkfifo "$work/owner.pipe"
# Only this shell owns the writer; neither the helper nor the dump inherits it.
backup_helper -i --cidfile "$work/capture.cid" capture.mjs capture /backup < "$work/owner.pipe" 9>&- &
capture_pid=$!
exec 8>"$work/owner.pipe"
while [[ ! -f "$work/capture.ready" ]]; do
  kill -0 "$capture_pid" 2>/dev/null || { wait "$capture_pid"; echo 'Artifact capture exited before the dump' >&2; exit 1; }
  sleep 0.1 8>&- 9>&-
done
compose exec -T postgres sh -c 'export PGPASSWORD="$POSTGRES_PASSWORD"; exec pg_dump --no-password --format=custom --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"' > "$work/database.dump" 8>&- 9>&- &
dump_pid=$!
while kill -0 "$dump_pid" 2>/dev/null; do
  kill -0 "$capture_pid" 2>/dev/null || { echo 'Artifact capture ended before the dump completed' >&2; exit 1; }
  sleep 0.1 8>&- 9>&-
done
wait "$dump_pid"
dump_pid=''
printf '%s\n' "$SERVICE_VERSION" > "$work/release.txt"
: > "$work/dump.done"
wait "$capture_pid"
exec 8>&-
capture_pid=''
payload=(database.dump release.txt objects.count objects.json)
(cd "$work"; sha256sum "${payload[@]}") > "$work/SHA256SUMS"
payload+=(SHA256SUMS)
filters=()
for file in "${payload[@]}"; do filters+=(--include "/$file"); done
# One container uploads only the recovery payload, never private operation files.
rclone copy /backup "crypt:$prefix" --max-depth 1 "${filters[@]}"
: > "$work/COMPLETE"
rclone copyto /backup/COMPLETE "crypt:$prefix/COMPLETE"
# check.sh reads this file's age. Nothing else depends on it.
printf '%s\n' "$point" > "$BETA_STATE_DIR/last-backup"
backup_helper capture.mjs collect
# Old plaintext points keep their existing expiry; shared objects belong to crypt.
recovery_points expired /backup/points > "$work/expired"
while IFS= read -r expired; do
  rclone purge "backup:$backup_bucket/$expired"
done < "$work/expired"
printf 'Completed recovery point: %s\n' "$point"

if ! bash "$(dirname "$0")/prune.sh"; then
  echo 'Local release cleanup deferred; rerun prune.sh after resolving its diagnostic.' >&2
fi
