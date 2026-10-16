#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
beta_root=${PERTEXO_BETA_ROOT:-/opt/pertexo}
export BETA_STATE_DIR="$beta_root/state"
mkdir -p "$BETA_STATE_DIR" "$beta_root/releases"
chmod 700 "$BETA_STATE_DIR"
config="$beta_root/.env.production"
if [[ ! -f "$config" || $(stat -c %a "$config") != 600 ]]; then
  echo 'A mode-600 .env.production is required' >&2; exit 1
fi
check_commit() {
  [[ $1 =~ ^[0-9a-f]{40}$ ]] || { echo 'A full lowercase commit SHA is required' >&2; exit 64; }
}
select_release() {
  check_commit "$1"
  export SERVICE_VERSION=$1
  release="$beta_root/releases/$SERVICE_VERSION"
  [[ -f "$release/infrastructure/single-server/compose.yaml" ]] || { echo 'Release sources missing' >&2; exit 1; }
  runtime_services=(api worker web proxy)
  writer_services=(api worker proxy)
  if [[ -f "$release/apps/code-runner/package.json" ]]; then
    runtime_services+=(code-runner)
    writer_services+=(code-runner)
  fi
}
compose() {
  docker compose --project-name pertexo-beta --env-file "$config" --env-file "$BETA_STATE_DIR/hosts.env" \
    -f "$release/infrastructure/single-server/compose.yaml" "$@"
}

operation_lock() {
  exec 9>"$BETA_STATE_DIR/operation.lock"
  flock -n 9 || { echo 'Another operation is running' >&2; exit 1; }
}

select_encryption_release() {
  encryption_release="$release"
  encryption_version="$SERVICE_VERSION"
  if [[ ! -f "$release/infrastructure/single-server/encryption/verify.mjs" && -f "$BETA_STATE_DIR/current" ]]; then
    current_encryption_version=$(cat "$BETA_STATE_DIR/current")
    check_commit "$current_encryption_version"
    current_encryption_release="$beta_root/releases/$current_encryption_version"
    [[ -f "$current_encryption_release/infrastructure/single-server/compose.yaml" ]] || { echo 'Current release sources missing' >&2; exit 1; }
    if [[ -f "$current_encryption_release/infrastructure/single-server/encryption/verify.mjs" ]]; then
      encryption_release="$current_encryption_release"
      encryption_version="$current_encryption_version"
    fi
  fi
}
verify_encryption() (
  # Pre-feature KMS installations cannot have produced self-managed secrets.
  [[ -f "$encryption_release/infrastructure/single-server/encryption/verify.mjs" ]] || return 0
  target_release="$release"
  select_release "$encryption_version"
  compose --profile ops run --rm --no-deps --env-from-file "$BETA_STATE_DIR/encryption.env" \
    -v "$encryption_release/infrastructure/single-server/encryption:/workspace/infrastructure/single-server/encryption:ro" \
    -v "$target_release:/selected-release:ro" \
    ops node infrastructure/single-server/encryption/verify.mjs /selected-release/infrastructure/single-server/encryption/verify.mjs
)

prepare_configuration() {
  local prepared_directory=$1 parser_release=$2 parser_version=$3
  docker run --rm --network none --read-only --user "$(id -u):$(id -g)" \
    -v "$config:/run/pertexo.env:ro" -e SERVICE_VERSION="$SERVICE_VERSION" \
    -v "$prepared_directory:/prepared" -v "$release:/selected-release:ro" -v "$parser_release/infrastructure/single-server:/workspace/infrastructure/single-server:ro" \
    "ghcr.io/vigani1/pertexo:$parser_version" node --env-file=/run/pertexo.env infrastructure/single-server/storage/prepare.mjs /prepared /selected-release/infrastructure/single-server/encryption/verify.mjs
}

validate_rollback_configuration() (
  # Interim images can ship a verifier while still refusing production self-managed keys.
  prepared=$(mktemp -d "$BETA_STATE_DIR/.rollback-configuration.XXXXXX")
  trap 'rm -rf "$prepared"' EXIT
  prepare_configuration "$prepared" "$release" "$SERVICE_VERSION"
  compose config --quiet
)

prepare_release() {
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
  select_encryption_release
  # An installed verifier keeps older KMS rollbacks from bypassing retained-key checks.
  prepare_configuration "$BETA_STATE_DIR" "$encryption_release" "$encryption_version"
  compose config --quiet
}

prepare_backup() {
  docker run --rm --network none --read-only --user "$(id -u):$(id -g)" \
    -v "$config:/run/pertexo.env:ro" -v "$BETA_STATE_DIR:/prepared" \
    -v "$release/infrastructure/single-server/backup:/workspace/infrastructure/single-server/backup:ro" \
    "ghcr.io/vigani1/pertexo:$SERVICE_VERSION" node --env-file=/run/pertexo.env infrastructure/single-server/backup/prepare.mjs /prepared
  source_bucket=$(cat "$BETA_STATE_DIR/source-bucket")
  backup_bucket=$(cat "$BETA_STATE_DIR/backup-bucket")
}
rclone() {
  docker run --rm --read-only --tmpfs /tmp --user "$(id -u):$(id -g)" \
    --network pertexo-beta_private --env-file "$BETA_STATE_DIR/rclone.env" \
    -v "$work:/backup" \
    rclone/rclone:1.75.2@sha256:2687085f718d3c628f7fdfb77c52a1d344332aed543110bb88088f2c70d43eb5 "$@"
}
recovery_points() {
  docker run --rm --read-only --network none --user "$(id -u):$(id -g)" \
    -v "$work:/backup:ro" -v "$release/infrastructure/single-server/backup/recovery-points.mjs:/recovery-points.mjs:ro" \
    "ghcr.io/vigani1/pertexo:$SERVICE_VERSION" node /recovery-points.mjs "$@"
}
require_no_ops() {
  if [[ -n $(docker ps -q --filter label=com.docker.compose.project=pertexo-beta --filter label=com.docker.compose.service=ops) ]]; then
    echo 'An operator command is running' >&2; exit 1
  fi
}
run_ops() {
  operation_lock
  [[ ! -f "$BETA_STATE_DIR/restore-fence" && ! -f "$BETA_STATE_DIR/migration-fence" ]] || { echo 'Restore or migration is incomplete' >&2; return 1; }
  select_release "$(cat "$BETA_STATE_DIR/current")"
  compose --profile ops run --rm --no-deps "$@" ops
}

copy_objects() {
  docker run --rm --read-only --user "$(id -u):$(id -g)" \
    --network pertexo-beta_private -v "$config:/run/pertexo.env:ro" \
    -v "$release/infrastructure/single-server/backup:/workspace/infrastructure/single-server/backup:ro" \
    "ghcr.io/vigani1/pertexo:$SERVICE_VERSION" node --env-file=/run/pertexo.env infrastructure/single-server/backup/copy-objects.mjs "$@"
}
