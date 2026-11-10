#!/usr/bin/env bash
set -Eeuo pipefail
# Only the host owns Docker; one upstream container serves this helper's requests.
work=$1
network=$2
image=$3
trap '[[ ! -f "$work/transport.cid" ]] || docker rm -f "$(cat "$work/transport.cid")" >/dev/null 2>&1; exit' EXIT
options=(--network "$network")
[[ $network == none ]] || options+=(--env-file "$work/rclone.env")
rm -f "$work/transport.cid"
status=0
docker run --rm --cidfile "$work/transport.cid" --read-only --tmpfs /tmp \
  --user "$(id -u):$(id -g)" "${options[@]}" -v "$work:/backup" \
  --entrypoint sh "$image" -c '
set -eu
directory=$1
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
' sh /backup || status=$?
# A failed container start must reach the waiting helper as well as the operator.
rm -f "$work/transport.input"
: > "$work/transport.stdout"
printf 'Upstream rclone container exited %s' "$status" > "$work/transport.stderr"
[[ $status != 0 ]] || status=1
printf '%s' "$status" > "$work/transport.status.tmp"
mv "$work/transport.status.tmp" "$work/transport.status"
