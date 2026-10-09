#!/usr/bin/env bash

set -Eeuo pipefail

: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${POSTGRES_OWNER_USER:?POSTGRES_OWNER_USER is required}"
: "${POSTGRES_MIGRATION_USER:?POSTGRES_MIGRATION_USER is required}"
: "${POSTGRES_MIGRATION_PASSWORD:?POSTGRES_MIGRATION_PASSWORD is required}"
: "${POSTGRES_APP_USER:?POSTGRES_APP_USER is required}"
: "${POSTGRES_APP_PASSWORD:?POSTGRES_APP_PASSWORD is required}"
: "${POSTGRES_MAINTENANCE_USER:?POSTGRES_MAINTENANCE_USER is required}"
: "${POSTGRES_MAINTENANCE_PASSWORD:?POSTGRES_MAINTENANCE_PASSWORD is required}"

# The official image runs this script as the bootstrap superuser only when the
# data directory is empty. Identifiers and passwords are passed as psql
# variables so unusual local values are quoted safely by psql.
psql \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --set ON_ERROR_STOP=1 \
  --set owner_user="$POSTGRES_OWNER_USER" \
  --set migration_user="$POSTGRES_MIGRATION_USER" \
  --set migration_password="$POSTGRES_MIGRATION_PASSWORD" \
  --set app_user="$POSTGRES_APP_USER" \
  --set app_password="$POSTGRES_APP_PASSWORD" \
  --set maintenance_user="$POSTGRES_MAINTENANCE_USER" \
  --set maintenance_password="$POSTGRES_MAINTENANCE_PASSWORD" \
  --set database_name="$POSTGRES_DB" <<'SQL'
SELECT format(
  'CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
  :'owner_user'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'owner_user')\gexec

SELECT format(
  'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
  :'migration_user'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'migration_user')\gexec
ALTER ROLE :"migration_user" PASSWORD :'migration_password';

SELECT format(
  'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
  :'app_user'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_user')\gexec
ALTER ROLE :"app_user" PASSWORD :'app_password';

SELECT format(
  'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
  :'maintenance_user'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'maintenance_user')\gexec
ALTER ROLE :"maintenance_user" PASSWORD :'maintenance_password';

-- Migration must opt into ownership explicitly with SET ROLE; the app and
-- maintenance logins are deliberately not members of the owner role.
GRANT :"owner_user" TO :"migration_user";

ALTER DATABASE :"database_name" OWNER TO :"owner_user";
REVOKE ALL ON DATABASE :"database_name" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"database_name"
  TO :"migration_user", :"app_user", :"maintenance_user";

ALTER SCHEMA public OWNER TO :"owner_user";
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO :"owner_user";
GRANT USAGE ON SCHEMA public TO :"app_user", :"maintenance_user";

SQL
