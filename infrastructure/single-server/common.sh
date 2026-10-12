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

operation_lock() {
  exec 9>"$BETA_STATE_DIR/operation.lock"
  flock -n 9 || { echo 'Another operation is running' >&2; exit 1; }
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
}
