#!/usr/bin/env bash
set -Eeuo pipefail
[[ $# == 1 ]] || { echo 'usage: deploy.sh <vX.Y.Z | latest | full-commit>' >&2; exit 64; }
source "$(dirname "$0")/release-operations.sh"
check_release_name "$1"
operation_lock
[[ ! -f "$BETA_STATE_DIR/restore-fence" ]] || { echo 'Restore is incomplete; use a fresh stack' >&2; exit 1; }
require_no_ops
commit=$(resolve_release "$1")
prepare_release "$commit"
previous=''
[[ ! -f "$BETA_STATE_DIR/current" ]] || previous=$(cat "$BETA_STATE_DIR/current")
compose up -d --wait --wait-timeout 120 postgres redis storage
# A fenced retry keeps the recovery point from before the first migration attempt.
# A fresh install has no settled release to capture.
if [[ -f "$BETA_STATE_DIR/current" && ! -f "$BETA_STATE_DIR/migration-fence" ]]; then
  recorded_migrations=$(compose exec -T postgres sh -c 'export PGPASSWORD="$POSTGRES_PASSWORD"; exec psql --no-password --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --tuples-only --no-align --set ON_ERROR_STOP=1 --command="SELECT coalesce(json_agg(name ORDER BY name), '\''[]'\''::json) FROM pertexo_internal.schema_migrations"')
  pending_migrations=$(compose run --rm --no-deps -T \
    -v "$(dirname "$0")/read-pending-migrations.mjs:/workspace/infrastructure/single-server/read-pending-migrations.mjs:ro" \
    migration node infrastructure/single-server/read-pending-migrations.mjs <<< "$recorded_migrations")
  if [[ -n "$pending_migrations" ]] && ! bash "$(dirname "$0")/backup.sh"; then
    echo 'Pending migrations require a successful encrypted recovery point; configure or repair backups before deploying.' >&2
    exit 1
  fi
fi
compose stop "${writer_services[@]}"
# Existing volumes skip initdb scripts. Grant before migrations can remove policies.
# ON_ERROR_STOP and the deploy's errexit keep writers stopped if provisioning fails.
compose exec -T postgres sh -c 'export PGPASSWORD="$POSTGRES_PASSWORD"; exec psql --no-password --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --set ON_ERROR_STOP=1 --set maintenance_user="$POSTGRES_MAINTENANCE_USER" --file=-' < "$(dirname "$0")/../postgres/init/roles/maintenance.sql"

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
