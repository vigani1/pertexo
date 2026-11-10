#!/usr/bin/env bash
# The installation root identifies a project across releases and operation directories.
backup_helper_identity() {
  local item
  backup_labels=(
    'io.pertexo.backup.helper=true'
    "io.pertexo.backup.project=$1"
    "io.pertexo.backup.operation=$2"
  )
  [[ -z ${3:-} ]] || backup_labels+=("io.pertexo.backup.instance=$3")
  backup_label_args=()
  backup_filters=()
  for item in "${backup_labels[@]}"; do
    backup_label_args+=(--label "$item")
    backup_filters+=(--filter "label=$item")
  done
}

remove_backup_helpers() (
  local containers
  backup_helper_identity "$@"
  containers=$(docker ps --all --quiet "${backup_filters[@]}") || return 1
  [[ -n $containers ]] || return 0
  # Docker supplies these IDs; a second query distinguishes an exit race from failure.
  if docker rm -f $containers >/dev/null; then return 0; fi
  local deadline=$((SECONDS + 5))
  while :; do
    containers=$(docker ps --all --quiet "${backup_filters[@]}") || return 1
    [[ -n $containers ]] || return 0
    [[ $SECONDS -lt $deadline ]] || return 1
    sleep 0.05
  done
)

remove_legacy_backup_transport() {
  local saved metadata
  [[ -f "$1/transport.cid" ]] || return 0
  saved=$(cat "$1/transport.cid")
  [[ $saved =~ ^[0-9a-f]{12,64}$ ]] || return 0
  metadata=$(docker inspect --format '{{.Config.Image}}|{{with index .Config.Labels "io.pertexo.backup.helper"}}{{.}}{{end}}|{{with index .Config.Labels "io.pertexo.backup.project"}}{{.}}{{end}}|{{with index .Config.Labels "io.pertexo.backup.operation"}}{{.}}{{end}}|{{with index .Config.Labels "io.pertexo.backup.instance"}}{{.}}{{end}}|{{with index .Config.Labels "com.docker.compose.project"}}{{.}}{{end}}' "$saved" 2>/dev/null) || return 0
  # Migrate a private pre-label ownership record, never a conflicting labelled owner.
  [[ $metadata != "$2|||||" ]] || docker rm -f "$saved" >/dev/null
}
