#!/usr/bin/env bash
set -Eeuo pipefail
[[ $# == 1 ]] || { echo 'usage: deploy.sh <vX.Y.Z | latest | full-commit>' >&2; exit 64; }
source "$(dirname "$0")/common.sh"
check_release_name "$1"
operation_lock
[[ ! -f "$BETA_STATE_DIR/restore-fence" ]] || { echo 'Restore is incomplete; use a fresh stack' >&2; exit 1; }
require_no_ops
commit=$(resolve_release "$1")
prepare_release "$commit"
previous=''
[[ ! -f "$BETA_STATE_DIR/current" ]] || previous=$(cat "$BETA_STATE_DIR/current")
compose up -d --wait --wait-timeout 120 postgres redis storage
compose stop "${writer_services[@]}"
# This ephemeral administration client is never a serving service.
if ! docker run --rm --read-only --tmpfs /tmp --user "$(id -u):$(id -g)" \
  --network pertexo-beta_private --env-file "$BETA_STATE_DIR/rc.env" \
  -v "$BETA_STATE_DIR:/prepared:ro" -v "$release/infrastructure/single-server/storage/bootstrap.sh:/bootstrap.sh:ro" \
  --entrypoint /bin/sh rustfs/rc:v0.1.36@sha256:ab024bfebee49a750ce886b4c70963ccd9ddaa03f491704a90710641d7a26699 /bootstrap.sh; then
  if [[ -n "$previous" && ! -f "$BETA_STATE_DIR/migration-fence" ]]; then
    select_release "$previous"
    validate_rollback_configuration
    verify_encryption
    compose up -d --no-deps --wait --wait-timeout 180 "${runtime_services[@]}"
  fi
  echo 'Storage setup failed before migration' >&2; exit 1
fi
prior_fence=false
[[ ! -f "$BETA_STATE_DIR/migration-fence" ]] || prior_fence=true
# A failed runner can have committed earlier files. Preserve uncertainty across retries.
printf '%s\n' "$commit" > "$BETA_STATE_DIR/migration-fence"
if ! compose up --force-recreate --no-deps --abort-on-container-exit --exit-code-from migration migration; then
  echo 'Migration failed: serving remains stopped; fix forward' >&2; exit 1
fi
migration_log=$(compose logs --no-log-prefix migration)
no_migration=false
if [[ $prior_fence == false && "$migration_log" == 'Database already at migration head.' ]]; then
  no_migration=true
  rm "$BETA_STATE_DIR/migration-fence"
fi
if ! verify_encryption; then
  echo 'Encryption verification failed: serving remains stopped; correct the configured keys' >&2; exit 1
fi
if ! compose up -d --no-deps --wait --wait-timeout 180 "${runtime_services[@]}" || ! wait_for_app; then
  compose stop "${runtime_services[@]}"
  if [[ $no_migration == true && -n "$previous" && "$previous" != "$commit" ]]; then
    select_release "$previous"
    validate_rollback_configuration
    verify_encryption
    compose up -d --no-deps --wait --wait-timeout 180 "${runtime_services[@]}"
    wait_for_app
    echo "Unhealthy release returned to $previous" >&2
  else
    echo 'Unhealthy release: fix forward; serving remains stopped' >&2
  fi
  exit 1
fi
if [[ -n "$previous" && "$previous" != "$commit" ]]; then
  printf '%s\n' "$previous" > "$BETA_STATE_DIR/previous"
fi
printf '%s\n' "$commit" > "$BETA_STATE_DIR/current.next"
mv "$BETA_STATE_DIR/current.next" "$BETA_STATE_DIR/current"
rm -f "$BETA_STATE_DIR/migration-fence"
printf 'Healthy release: %s\n' "$commit"
