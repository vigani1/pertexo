#!/bin/sh
# Generates the quick try's secrets once, using the same generator as a real install.
set -eu
secrets=/quickstart/secrets.env
if [ -s "$secrets" ]; then exit 0; fi
# Keys for mail and invitations would turn on delivery, and there's no mail here.
node /generate-secrets.mjs 2>/dev/null \
  | grep -v -E '^(AUTH_MAIL_KEY|INVITATION_TOKEN_KEY)' > "$secrets.new"
. "$secrets.new"
# What these images call the values the generator already made.
cat >> "$secrets.new" <<VALUES
POSTGRES_PASSWORD='$POSTGRES_SUPERUSER_PASSWORD'
RUSTFS_ACCESS_KEY='$ARTIFACT_STORE_ACCESS_KEY_ID'
RUSTFS_SECRET_KEY='$ARTIFACT_STORE_SECRET_ACCESS_KEY'
VALUES
# Services run as different users, and the code runner doesn't mount this at all.
chmod 644 "$secrets.new"
mv "$secrets.new" "$secrets"
