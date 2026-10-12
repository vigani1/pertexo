#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
[[ ${BETA_COMMIT:-} =~ ^[0-9a-f]{40}$ ]] || { echo 'A full lowercase commit SHA is required' >&2; exit 64; }
[[ ${BETA_SSH_HOST:-} =~ ^[a-zA-Z0-9][a-zA-Z0-9.:-]*$ && ${BETA_SSH_USER:-} =~ ^[a-z_][a-z0-9_-]*$ ]] || { echo 'A valid SSH host and Unix login are required' >&2; exit 64; }
[[ -n ${BETA_SSH_PRIVATE_KEY:-} && -n ${BETA_SSH_KNOWN_HOSTS:-} ]] || { echo 'The dedicated key and pinned known_hosts are required' >&2; exit 1; }
private=$(mktemp -d "${RUNNER_TEMP:?}/pertexo-ssh.XXXXXX")
trap 'rm -rf "$private"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
printf '%s\n' "$BETA_SSH_PRIVATE_KEY" > "$private/key"
printf '%s\n' "$BETA_SSH_KNOWN_HOSTS" > "$private/known_hosts"
unset BETA_SSH_PRIVATE_KEY BETA_SSH_KNOWN_HOSTS
ssh-keygen -F "$BETA_SSH_HOST" -f "$private/known_hosts" >/dev/null || { echo 'The pinned known_hosts must contain this host' >&2; exit 1; }
ssh -F /dev/null -T -i "$private/key" -l "$BETA_SSH_USER" \
  -o BatchMode=yes -o IdentitiesOnly=yes -o PreferredAuthentications=publickey \
  -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$private/known_hosts" \
  -o GlobalKnownHostsFile=/dev/null -o UpdateHostKeys=no -o VerifyHostKeyDNS=no \
  -o ForwardAgent=no -o ClearAllForwardings=yes \
  -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
  "$BETA_SSH_HOST" "deploy $BETA_COMMIT"
