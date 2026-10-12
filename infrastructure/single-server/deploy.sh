#!/usr/bin/env bash
set -Eeuo pipefail
[[ $# == 1 ]] || { echo 'usage: deploy.sh <full-commit>' >&2; exit 64; }
source "$(dirname "$0")/common.sh"
check_commit "$1"
exec 9>"$BETA_STATE_DIR/operation.lock"
flock -n 9 || { echo 'Another operation is running' >&2; exit 1; }
commit=$1
repository="$beta_root/repository"
git -C "$repository" fetch origin main
git -C "$repository" merge-base --is-ancestor "$commit" origin/main
if [[ ! -d "$beta_root/releases/$commit" ]]; then
  staging=$(mktemp -d "$beta_root/releases/.extract.XXXXXX")
  if ! git -C "$repository" archive "$commit" | tar -x -C "$staging"; then
    rm -rf "$staging"; exit 1
  fi
  mv "$staging" "$beta_root/releases/$commit"
fi
select_release "$commit"
for image in pertexo pertexo-web; do
  reference="ghcr.io/vigani1/$image:$commit"
  docker pull "$reference"
  [[ $(docker image inspect --format '{{.Architecture}} {{index .Config.Labels "org.opencontainers.image.revision"}}' "$reference") == "arm64 $commit" ]] || { echo 'Image architecture/revision mismatch' >&2; exit 1; }
done
# Run the selected image's compiled parsers without printing credentials.
docker run --rm --network none --read-only --user "$(id -u):$(id -g)" \
  -v "$config:/run/pertexo.env:ro" -e SERVICE_VERSION="$commit" \
  -v "$BETA_STATE_DIR:/prepared" -v "$release/infrastructure/single-server/storage/prepare.mjs:/app/infrastructure/single-server/storage/prepare.mjs:ro" \
  "ghcr.io/vigani1/pertexo:$commit" node --env-file=/run/pertexo.env infrastructure/single-server/storage/prepare.mjs /prepared
compose config --quiet
previous=''
[[ ! -f "$BETA_STATE_DIR/current" ]] || previous=$(cat "$BETA_STATE_DIR/current")
compose up -d --wait --wait-timeout 120 postgres redis storage
compose stop api worker proxy
# This ephemeral administration client is never a serving service.
if ! docker run --rm --read-only --tmpfs /tmp --user "$(id -u):$(id -g)" \
  --network pertexo-beta_private --env-file "$BETA_STATE_DIR/rc.env" \
  -v "$BETA_STATE_DIR:/prepared:ro" -v "$release/infrastructure/single-server/storage/bootstrap.sh:/bootstrap.sh:ro" \
  --entrypoint /bin/sh rustfs/rc:v0.1.36@sha256:ab024bfebee49a750ce886b4c70963ccd9ddaa03f491704a90710641d7a26699 /bootstrap.sh; then
  if [[ -n "$previous" && ! -f "$BETA_STATE_DIR/migration-fence" ]]; then
    select_release "$previous"
    compose up -d --no-deps --wait --wait-timeout 180 api worker web proxy
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
if ! compose up -d --no-deps --wait --wait-timeout 180 api worker web proxy; then
  compose stop api worker web proxy
  if [[ $no_migration == true && -n "$previous" && "$previous" != "$commit" ]]; then
    select_release "$previous"
    compose up -d --no-deps --wait --wait-timeout 180 api worker web proxy
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
