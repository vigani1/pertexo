#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
beta_root=${PERTEXO_BETA_ROOT:-/opt/pertexo}
export BETA_STATE_DIR="$beta_root/state"
mkdir -p "$BETA_STATE_DIR" "$beta_root/releases"
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
}
compose() {
  docker compose --project-name pertexo-beta --env-file "$config" --env-file "$BETA_STATE_DIR/hosts.env" \
    -f "$release/infrastructure/single-server/compose.yaml" "$@"
}
