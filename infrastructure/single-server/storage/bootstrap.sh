#!/bin/sh
set -eu
rc bucket create --quiet --ignore-existing "internal/$ARTIFACT_STORE_BUCKET" >/dev/null
rc cors set --quiet "internal/$ARTIFACT_STORE_BUCKET" /prepared/cors.json >/dev/null
rc admin user add --quiet internal/ "$ARTIFACT_STORE_ACCESS_KEY_ID" "$ARTIFACT_STORE_SECRET_ACCESS_KEY" >/dev/null
rc admin policy create --quiet internal/ pertexo-artifacts /prepared/policy.json >/dev/null
rc admin policy attach --quiet internal/ pertexo-artifacts --user "$ARTIFACT_STORE_ACCESS_KEY_ID" >/dev/null
