#!/usr/bin/env bash
set -Eeuo pipefail
[[ $# == 0 ]] || { echo 'usage: backup.sh' >&2; exit 64; }
source "$(dirname "$0")/common.sh"
work=''
serving=()
resume_serving() {
  [[ ${#serving[@]} -gt 0 ]] || return 0
  local resumed=("${serving[@]}") wait_app=true
  [[ ${#resumed[@]} == "${#writer_services[@]}" ]] || wait_app=false
  serving=()
  compose up -d --no-deps --wait --wait-timeout 180 "${resumed[@]}" && { [[ $wait_app == false ]] || wait_for_app; }
}
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
  resume_serving || result=1
  [[ -z $work ]] || rm -rf "$work"
  report_outcome "$result"
  exit "$result"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
operation_lock
[[ -f "$BETA_STATE_DIR/current" && ! -f "$BETA_STATE_DIR/migration-fence" && ! -f "$BETA_STATE_DIR/restore-fence" ]] || { echo 'A settled current release is required for backup' >&2; exit 1; }
select_release "$(cat "$BETA_STATE_DIR/current")"
require_no_ops
prepare_backup
work=$(mktemp -d "$BETA_STATE_DIR/.backup.XXXXXX")
point=$(date -u +%Y%m%dT%H%M%SZ)
prefix="pertexo-beta/$point"
rclone lsf "backup:$backup_bucket" --dirs-only --recursive --max-depth 2 > "$work/points"
if grep -qx "$prefix/" "$work/points"; then
  echo 'That recovery point already exists; refusing overwrite' >&2; exit 1
fi
running=$(compose ps --services --status running)
for service in "${writer_services[@]}"; do
  if grep -qx "$service" <<< "$running"; then serving+=("$service"); fi
done
compose stop "${writer_services[@]}"
# No serving writer or public presigned upload can change the matched snapshot.
compose exec -T postgres sh -c 'export PGPASSWORD="$POSTGRES_PASSWORD"; exec pg_dump --no-password --format=custom --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"' > "$work/database.dump"
printf '%s\n' "$SERVICE_VERSION" > "$work/release.txt"
copied=$(copy_objects backup "$point")
printf '%s\n' "$copied" > "$work/objects.count"
(cd "$work"; sha256sum database.dump release.txt objects.count) > "$work/SHA256SUMS"
for file in database.dump release.txt objects.count SHA256SUMS; do
  rclone copyto "/backup/$file" "backup:$backup_bucket/$prefix/$file"
done
if [[ "$copied" != 0 ]]; then
  rclone check --download "source:$source_bucket" "backup:$backup_bucket/$prefix/objects"
fi
: > "$work/COMPLETE"
rclone copyto /backup/COMPLETE "backup:$backup_bucket/$prefix/COMPLETE"
# check.sh reads this file's age. Nothing else depends on it.
printf '%s\n' "$point" > "$BETA_STATE_DIR/last-backup"
resume_serving
# Artifact mtimes can predate this snapshot; retention uses the recovery-point date.
recovery_points expired /backup/points > "$work/expired"
while IFS= read -r expired; do
  rclone purge "backup:$backup_bucket/$expired"
done < "$work/expired"
printf 'Completed recovery point: %s\n' "$point"
