#!/usr/bin/env bash
set -Eeuo pipefail
[[ $# == 0 ]] || { echo 'usage: prune.sh' >&2; exit 64; }
source "$(dirname "$0")/release-operations.sh"
operation_lock
clear_stale_backup_configs
require_no_ops
[[ ! -f "$BETA_STATE_DIR/migration-fence" && ! -f "$BETA_STATE_DIR/restore-fence" ]] || { echo 'Cleanup deferred: migration or restore is incomplete.' >&2; exit 1; }
select_release "$(cat "$BETA_STATE_DIR/current")"
work=$(mktemp -d "$BETA_STATE_DIR/.prune.XXXXXX")
trap 'rm -rf "$work"' EXIT
# Protect the whole recovery catalogue before deleting anything. A failed or
# unavailable listing is uncertainty, never an empty set of references.
: > "$work/protected"
for reference in current previous; do
  if [[ -f "$BETA_STATE_DIR/$reference" ]]; then cat "$BETA_STATE_DIR/$reference" >> "$work/protected"; printf '\n' >> "$work/protected"; fi
done
if [[ -n $(config_value BACKUP_STORE_ENDPOINT) ]]; then
  backup_transport_image=$(rclone_image)
  : > "$work/rclone.conf"
  backup_helper catalogue-releases.mjs /backup >> "$work/protected"
elif [[ -f "$BETA_STATE_DIR/last-backup" ]]; then
  echo 'Cleanup deferred: restore backup settings to read retained recovery references.' >&2
  exit 1
fi
while IFS= read -r reference; do
  [[ -z "$reference" ]] || check_commit "$reference"
done < "$work/protected"
# Three most recently extracted releases supplement the explicit references.
# Only operator-owned SHA directories and their two exact product tags are eligible.
paths=()
for path in "$beta_root/releases/"*/; do
  [[ -d "$path" && ! -L "${path%/}" ]] || continue
  name=${path%/}; name=${name##*/}
  [[ $name =~ ^[0-9a-f]{40}$ ]] || continue
  paths+=("$path")
done
ls -1dt -- "${paths[@]}" > "$work/paths"
while IFS= read -r path; do
  path=${path%/}
  printf '%s\n' "${path##*/}"
done < "$work/paths" > "$work/candidates"
recent=0
while IFS= read -r candidate; do
  [[ $candidate =~ ^[0-9a-f]{40}$ ]] || continue
  if ((recent < 3)); then
    printf '%s\n' "$candidate" >> "$work/protected"
    recent=$((recent + 1))
  fi
done < "$work/candidates"
failed=false
while IFS= read -r candidate; do
  [[ $candidate =~ ^[0-9a-f]{40}$ ]] || continue
  if grep -Fxq "$candidate" "$work/protected"; then continue; fi
  removable=true
  images=()
  for product in pertexo pertexo-web; do
    image="ghcr.io/vigani1/$product:$candidate"
    identity=$(docker image ls --quiet --no-trunc "$image")
    if [[ -z "$identity" ]]; then continue; fi
    images+=("$image")
    containers=$(docker ps -aq --filter "ancestor=$image")
    if [[ -n "$containers" ]]; then removable=false; failed=true; fi
  done
  if [[ $removable == true ]]; then
    for image in "${images[@]}"; do
      if ! docker image rm "$image"; then removable=false; failed=true; fi
    done
  fi
  if [[ $removable == true ]]; then
    rm -rf -- "$beta_root/releases/$candidate"
    printf 'Removed local release: %s\n' "$candidate"
  fi
done < "$work/candidates"
[[ $failed == false ]] || { echo 'Some images are in use; their release sources were retained. Retry cleanup after their containers stop.' >&2; exit 1; }
