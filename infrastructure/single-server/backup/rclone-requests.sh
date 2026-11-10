#!/usr/bin/env bash
set -Eeuo pipefail
# Only the host owns Docker; one upstream container serves this helper's requests.
work=$1
network=$2
image=$3
source "$(dirname "$0")/helper-lifecycle.sh"
project=${4:-$work}
operation=${5:-transport}
instance=${6:-$$-$RANDOM-$RANDOM}
container_pid=''
failure='Unable to remove stale backup helpers'
finish_transport() {
  result=$?
  trap - EXIT
  remove_backup_helpers "$project" "$operation" "$instance" || result=1
  [[ -z $container_pid ]] || { kill "$container_pid" 2>/dev/null || true; wait "$container_pid" 2>/dev/null || true; }
  [[ $result != 0 ]] || result=1
  if [[ $(cat "$work/transport.ready" 2>/dev/null || true) == "$instance" ]]; then failure='Upstream rclone helper stopped'; fi
  if [[ -d $work ]]; then
    rm -f "$work/transport.input"
    : > "$work/transport.stdout"
    printf '%s (exit %s)' "$failure" "$result" > "$work/transport.stderr"
    printf '%s' "$result" > "$work/transport.status.tmp"
    mv "$work/transport.status.tmp" "$work/transport.status"
  fi
  [[ $result == 143 || $result == 130 ]] || echo "$failure (exit $result)" >&2
  exit "$result"
}
trap finish_transport EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
remove_backup_helpers "$project" "$operation"
remove_legacy_backup_transport "$work" "$image"
backup_helper_identity "$project" "$operation" "$instance"
rm -f "$work/transport.ready"
failure='Unable to start upstream rclone helper'
options=(--network "$network")
[[ $network == none ]] || options+=(--env-file "$work/rclone.env")
rm -f "$work/transport.cid"
docker run --rm --cidfile "$work/transport.cid" --read-only --tmpfs /tmp \
  --user "$(id -u):$(id -g)" "${options[@]}" -v "$work:/backup" \
  "${backup_label_args[@]}" --entrypoint sh "$image" -c '
set -eu
directory=$1
printf "%s" "$2" > "$directory/transport.ready"
while :; do
  if [ -f "$directory/transport.request" ]; then
    mv "$directory/transport.request" "$directory/transport.running"
    input=/dev/null
    if [ -f "$directory/transport.input" ]; then input="$directory/transport.input"; fi
    xargs -0 sh -c '\''
      input=$1
      directory=$2
      shift 2
      status=0
      rclone "$@" < "$input" > "$directory/transport.stdout" 2> "$directory/transport.stderr" || status=$?
      printf "%s" "$status" > "$directory/transport.status.tmp"
    '\'' rclone "$input" "$directory" < "$directory/transport.running"
    rm -f "$directory/transport.running" "$directory/transport.input"
    mv "$directory/transport.status.tmp" "$directory/transport.status"
  fi
  sleep 0.05
done
' sh /backup "$instance" &
container_pid=$!
wait "$container_pid"
