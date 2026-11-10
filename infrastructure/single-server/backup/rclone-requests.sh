#!/usr/bin/env bash
set -Eeuo pipefail
# Only the host owns Docker. The private operation directory is the transport boundary.
work=$1
network=$2
image=$3
trap '[[ ! -f "$work/transport.cid" ]] || docker rm -f "$(cat "$work/transport.cid")" >/dev/null 2>&1; exit' EXIT
while :; do
  if [[ -f "$work/transport.request" ]]; then
    arguments=()
    while IFS= read -r -d '' argument; do arguments+=("$argument"); done < "$work/transport.request"
    rm "$work/transport.request"
    rm -f "$work/transport.cid"
    status=0
    docker run --rm --cidfile "$work/transport.cid" --read-only --tmpfs /tmp \
      --user "$(id -u):$(id -g)" --network "$network" \
      --env-file "$work/rclone.env" -v "$work:/backup" "$image" "${arguments[@]}" \
      > "$work/transport.stdout" 2> "$work/transport.stderr" || status=$?
    printf '%s' "$status" > "$work/transport.status.tmp"
    mv "$work/transport.status.tmp" "$work/transport.status"
  fi
  sleep 0.05
done
