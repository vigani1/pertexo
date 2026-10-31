#!/usr/bin/env bash
# Runs a step that only talks to registries and the Docker daemon, and runs it once more
# if it fails. Never wrap a test or a qualification: a second chance hides the flake it
# should have shown.
set -uo pipefail
"$@" && exit 0
echo "::warning title=Retrying a step outside the code::$*"
sleep 30
exec "$@"
