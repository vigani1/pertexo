#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
operator_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
beta_root=${PERTEXO_BETA_ROOT:-/opt/pertexo}
export BETA_STATE_DIR="$beta_root/state"
mkdir -p "$BETA_STATE_DIR" "$beta_root/releases"
chmod 700 "$BETA_STATE_DIR"
config="$beta_root/.env.production"
if [[ ! -f "$config" || $(stat -c %a "$config") != 600 ]]; then
  echo 'A mode-600 .env.production is required' >&2; exit 1
fi
# Scripts never source the secret file: this reads one plain setting from it, and
# the process environment wins. Prints nothing when it isn't set.
config_value() {
  local name=$1 line
  if [[ -n ${!name+set} ]]; then printf '%s\n' "${!name}"; return; fi
  line=$(grep -E "^$name=" "$config" | tail -n 1) || true
  line=${line#*=}
  line=${line#[\"\']}
  printf '%s\n' "${line%[\"\']}"
}
check_commit() {
  [[ $1 =~ ^[0-9a-f]{40}$ ]] || { echo 'A full lowercase commit SHA is required' >&2; exit 64; }
}
release_tag_pattern='^v[0-9]+\.[0-9]+\.[0-9]+$'
check_release_name() {
  [[ $1 == latest || $1 =~ $release_tag_pattern || $1 =~ ^[0-9a-f]{40}$ ]] || {
    echo 'A version such as v1.2.3, latest, or a full lowercase commit SHA is required' >&2; exit 64
  }
}
# Prints the commit a checked release name stands for. Tags only name commits:
# prepare_release still applies its ancestry and image checks to the result.
resolve_release() {
  local repository="$beta_root/repository" tag=$1 tags
  if [[ $tag =~ ^[0-9a-f]{40}$ ]]; then printf '%s\n' "$tag"; return; fi
  git -C "$repository" fetch --quiet --force --tags origin
  if [[ $tag == latest ]]; then
    tags=$(git -C "$repository" tag --list 'v*' --sort=-version:refname)
    tag=$(grep -m 1 -E "$release_tag_pattern" <<< "$tags") || { echo 'No release has been published yet' >&2; exit 1; }
  fi
  git -C "$repository" rev-parse --verify --quiet "refs/tags/$tag^{commit}" || { echo "No such release: $tag" >&2; exit 1; }
}
select_release() {
  check_commit "$1"
  export SERVICE_VERSION=$1
  release="$beta_root/releases/$SERVICE_VERSION"
  [[ -f "$release/infrastructure/single-server/compose.yaml" ]] || { echo 'Release sources missing' >&2; exit 1; }
  runtime_services=(api worker web proxy)
  writer_services=(api proxy)
  if [[ -f "$release/apps/code-runner/package.json" ]]; then
    runtime_services+=(code-runner)
    writer_services+=(code-runner)
  fi
}
compose() {
  docker compose --project-name pertexo-beta --env-file "$config" --env-file "$BETA_STATE_DIR/hosts.env" \
    -f "$release/infrastructure/single-server/compose.yaml" "$@"
}

# The path a signed-in browser takes: through Caddy and nginx to the API. Container
# health can't see a break in it, and only the API answers this request with a 401.
app_reaches_api() {
  compose exec -T api node -e "fetch(process.env.PUBLIC_WEB_ORIGIN + '/v1/workspaces', { redirect: 'manual', signal: AbortSignal.timeout(5000) }).then((response) => { if (response.status !== 401) throw new Error('The app answered ' + response.status + ' instead of reaching the API'); process.exit(0); }).catch((error) => { console.error(error.cause?.message ?? error.message); process.exit(1); })"
}
# Two seconds apart, by default long enough for a new server's first HTTPS certificate.
wait_for_app() {
  local attempts=${1:-60} attempt
  for ((attempt = 1; attempt < attempts; attempt++)); do
    if app_reaches_api 2>/dev/null; then return 0; fi
    sleep 2
  done
  app_reaches_api
}

operation_lock() {
  # Deploy's backup inherits this descriptor, retaining one lock through capture
  # and migration. Reopening the file would contend with our own parent shell.
  if [[ ! /dev/fd/9 -ef "$BETA_STATE_DIR/operation.lock" ]]; then
    exec 9>"$BETA_STATE_DIR/operation.lock"
  fi
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

# Generated mounts/capacity values are not needed to resolve app settings.
# Compose owns interpolation; its secret-bearing output stays in private state.
resolve_application_configuration() {
  resolved_configuration=$(mktemp "$BETA_STATE_DIR/.configuration.XXXXXX")
  chmod 600 "$resolved_configuration"
  trap 'rm -f "$resolved_configuration" "$resolved_configuration.errors"' EXIT
  local hosts_file="$BETA_STATE_DIR/hosts.env"
  [[ -f "$hosts_file" ]] || hosts_file=/dev/null
  if ! APP_HOST=configuration.invalid FILES_HOST=files.configuration.invalid \
    CODE_RUNNER_CONTAINER_MEMORY_MB=128 CODE_RUNNER_CONTAINER_CPUS=1 \
    CODE_RUNNER_CONTAINER_PIDS=128 CODE_RUNNER_MANAGER_HEAP_MB=32 \
    docker compose --project-name pertexo-beta --env-file "$config" --env-file "$hosts_file" \
      -f "$release/infrastructure/single-server/compose.yaml" config --no-env-resolution --format json > "$resolved_configuration" 2> "$resolved_configuration.errors"; then
    rm -f "$resolved_configuration" "$resolved_configuration.errors"
    echo 'Compose configuration could not be resolved; check .env.production.' >&2; return 1
  fi
  rm -f "$resolved_configuration.errors"
}

validate_application_configuration() (
  resolve_application_configuration
  trap 'rm -f "$resolved_configuration"' EXIT
  docker run --rm --network none --read-only --user "$(id -u):$(id -g)" \
    -v "$resolved_configuration:/run/resolved.json:ro" -e PERTEXO_RESOLVED_CONFIG=/run/resolved.json -v "$config:/run/pertexo.env:ro" \
    -v "$operator_root/infrastructure/single-server/storage:/workspace/infrastructure/single-server/storage:ro" \
    "ghcr.io/vigani1/pertexo:$SERVICE_VERSION" node --env-file=/run/pertexo.env infrastructure/single-server/storage/preflight.mjs /run/pertexo.env
)

prepare_configuration() (
  local prepared_directory=$1 parser_version=$2
  resolve_application_configuration
  trap 'rm -f "$resolved_configuration"' EXIT
  docker run --rm --network none --read-only --user "$(id -u):$(id -g)" \
    -v "$resolved_configuration:/run/resolved.json:ro" -e PERTEXO_RESOLVED_CONFIG=/run/resolved.json -v "$config:/run/pertexo.env:ro" \
    -v "$release/infrastructure/postgres/init:/workspace/infrastructure/postgres/init:ro" \
    -v "$prepared_directory:/prepared" -v "$release:/selected-release:ro" -v "$operator_root/infrastructure/single-server:/workspace/infrastructure/single-server:ro" \
    "ghcr.io/vigani1/pertexo:$parser_version" node --env-file=/run/pertexo.env infrastructure/single-server/storage/prepare.mjs /prepared /selected-release/infrastructure/single-server/encryption/verify.mjs
)

validate_rollback_configuration() (
  # Interim images can ship a verifier while still refusing production self-managed keys.
  prepared=$(mktemp -d "$BETA_STATE_DIR/.rollback-configuration.XXXXXX")
  trap 'rm -rf "$prepared"' EXIT
  prepare_configuration "$prepared" "$SERVICE_VERSION"
  compose config --quiet
)

# Read required names from Compose so adding a setting also adds its preflight.
preflight_settings() {
  local name missing=false
  while IFS= read -r name; do
    # These values are derived by storage/prepare.mjs, never supplied by operators.
    case "$name" in
      SERVICE_VERSION|APP_HOST|FILES_HOST|CODE_RUNNER_CONTAINER_*|CODE_RUNNER_MANAGER_HEAP_MB) continue ;;
    esac
    if [[ -z $(config_value "$name") ]]; then
      printf '%s: set a non-empty value in %s before deploying.\n' "$name" "$config" >&2
      missing=true
    fi
  done < <(grep -oE '\$\{[A-Z_0-9]+:\?' "$release/infrastructure/single-server/compose.yaml" | sed 's/^..//; s/:?$//' | sort -u)
  [[ $missing == false ]]
}

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
    # Released sources are public, and containers read them as their own users
    # (Postgres its init scripts, the ops image the verifier). The umask above is
    # for state, and the private root keeps other logins out of both.
    chmod -R a+rX "$staging"
    mv "$staging" "$beta_root/releases/$commit"
  fi
  select_release "$commit"
  preflight_settings
  host_architecture=$(docker version --format '{{.Server.Arch}}')
  for image in pertexo pertexo-web; do
    reference="ghcr.io/vigani1/$image:$commit"
    docker pull "$reference"
    [[ $(docker image inspect --format '{{.Architecture}} {{index .Config.Labels "org.opencontainers.image.revision"}}' "$reference") == "$host_architecture $commit" ]] || { echo "Image architecture/revision mismatch: this server needs $host_architecture images of $commit" >&2; exit 1; }
  done
  validate_application_configuration
  select_encryption_release
  # An installed verifier keeps older KMS rollbacks from bypassing retained-key checks.
  prepare_configuration "$BETA_STATE_DIR" "$encryption_version"
  compose config --quiet
}

prepare_backup() {
  docker run --rm --network none --read-only --user "$(id -u):$(id -g)" \
    -v "$config:/run/pertexo.env:ro" -v "$work:/prepared" \
    -v "$release/infrastructure/single-server/backup:/workspace/infrastructure/single-server/backup:ro" \
    "ghcr.io/vigani1/pertexo:$SERVICE_VERSION" node --env-file=/run/pertexo.env infrastructure/single-server/backup/prepare.mjs /prepared
  source_bucket=$(cat "$work/source-bucket")
  backup_bucket=$(cat "$work/backup-bucket")
}
rclone() {
  docker run --rm --read-only --tmpfs /tmp --user "$(id -u):$(id -g)" \
    --network "${backup_network:-pertexo-beta_private}" --env-file "$work/rclone.env" \
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

# The helper image contains the same pinned rclone transport as the shell wrapper.
backup_helper() {
  local options=(--env-file "$work/rclone.env")
  if [[ ${1:-} == -i ]]; then options+=(-i); shift; fi
  if [[ ${1:-} == --cidfile ]]; then options+=("$1" "$2"); shift 2; fi
  local script=$1
  shift
  docker run --rm --read-only --tmpfs /tmp --user "$(id -u):$(id -g)" \
    "${options[@]}" --network "${backup_network:-pertexo-beta_private}" \
    -v "$config:/run/pertexo.env:ro" -v "$work:/backup" \
    -v "$release/infrastructure/single-server/backup:/workspace/infrastructure/single-server/backup:ro" \
    "ghcr.io/vigani1/pertexo:$SERVICE_VERSION" node --env-file=/run/pertexo.env "infrastructure/single-server/backup/$script" "$@"
}

verify_backup_key() {
  [[ -n $(config_value BACKUP_CRYPT_PASSWORD) && -n $(config_value BACKUP_CRYPT_SALT) ]] || { echo 'Provide BACKUP_CRYPT_PASSWORD and BACKUP_CRYPT_SALT from the separately held settings file' >&2; return 1; }
  backup_helper key-check.mjs
}

# The operation lock excludes any reader before stale secret copies are removed.
clear_stale_backup_configs() {
  rm -f "$BETA_STATE_DIR/rclone.env" \
    "$BETA_STATE_DIR"/.backup.*/rclone.env "$BETA_STATE_DIR"/.restore.*/rclone.env
}
