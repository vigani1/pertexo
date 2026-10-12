#!/usr/bin/env bash
set -Eeuo pipefail
export PATH=/usr/bin:/bin
if [[ ${SSH_ORIGINAL_COMMAND:-} =~ ^deploy\ ([0-9a-f]{40})$ ]]; then
  # Keep the installed recovery fences even when rolling back an older image.
  exec "$(dirname "$0")/deploy.sh" "${BASH_REMATCH[1]}"
fi
echo 'This key permits only: deploy <full-40-character-commit>' >&2
exit 64
