#!/usr/bin/env bash

set -Eeuo pipefail

: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${POSTGRES_OWNER_USER:?POSTGRES_OWNER_USER is required}"
: "${POSTGRES_MIGRATION_USER:?POSTGRES_MIGRATION_USER is required}"
: "${POSTGRES_MIGRATION_PASSWORD:?POSTGRES_MIGRATION_PASSWORD is required}"
: "${POSTGRES_MAINTENANCE_USER:?POSTGRES_MAINTENANCE_USER is required}"
: "${POSTGRES_MAINTENANCE_PASSWORD:?POSTGRES_MAINTENANCE_PASSWORD is required}"
: "${POSTGRES_LIFECYCLE_COMMAND_USER:?POSTGRES_LIFECYCLE_COMMAND_USER is required}"
: "${POSTGRES_LIFECYCLE_COMMAND_PASSWORD:?POSTGRES_LIFECYCLE_COMMAND_PASSWORD is required}"
: "${POSTGRES_API_RUNTIME_USER:?POSTGRES_API_RUNTIME_USER is required}"
: "${POSTGRES_API_RUNTIME_PASSWORD:?POSTGRES_API_RUNTIME_PASSWORD is required}"
: "${POSTGRES_WORKER_RUNTIME_USER:?POSTGRES_WORKER_RUNTIME_USER is required}"
: "${POSTGRES_WORKER_RUNTIME_PASSWORD:?POSTGRES_WORKER_RUNTIME_PASSWORD is required}"
: "${POSTGRES_DISPATCHER_RUNTIME_USER:?POSTGRES_DISPATCHER_RUNTIME_USER is required}"
: "${POSTGRES_DISPATCHER_RUNTIME_PASSWORD:?POSTGRES_DISPATCHER_RUNTIME_PASSWORD is required}"

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
  --set maintenance_user="$POSTGRES_MAINTENANCE_USER" \
  --set maintenance_password="$POSTGRES_MAINTENANCE_PASSWORD" \
  --set lifecycle_command_user="$POSTGRES_LIFECYCLE_COMMAND_USER" \
  --set lifecycle_command_password="$POSTGRES_LIFECYCLE_COMMAND_PASSWORD" \
  --set api_runtime_user="$POSTGRES_API_RUNTIME_USER" \
  --set api_runtime_password="$POSTGRES_API_RUNTIME_PASSWORD" \
  --set worker_runtime_user="$POSTGRES_WORKER_RUNTIME_USER" \
  --set worker_runtime_password="$POSTGRES_WORKER_RUNTIME_PASSWORD" \
  --set dispatcher_runtime_user="$POSTGRES_DISPATCHER_RUNTIME_USER" \
  --set dispatcher_runtime_password="$POSTGRES_DISPATCHER_RUNTIME_PASSWORD" \
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
  'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS',
  :'maintenance_user'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'maintenance_user')\gexec
ALTER ROLE :"maintenance_user" PASSWORD :'maintenance_password';

SELECT format(
  'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
  :'lifecycle_command_user'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'lifecycle_command_user')\gexec
ALTER ROLE :"lifecycle_command_user" PASSWORD :'lifecycle_command_password';

SELECT format(
  'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
  :'api_runtime_user'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'api_runtime_user')\gexec
ALTER ROLE :"api_runtime_user" PASSWORD :'api_runtime_password';

SELECT format(
  'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
  :'worker_runtime_user'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'worker_runtime_user')\gexec
ALTER ROLE :"worker_runtime_user" PASSWORD :'worker_runtime_password';

SELECT format(
  'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
  :'dispatcher_runtime_user'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'dispatcher_runtime_user')\gexec
ALTER ROLE :"dispatcher_runtime_user" PASSWORD :'dispatcher_runtime_password';

-- Migration must opt into ownership explicitly with SET ROLE; serving roles
-- are deliberately not members of the owner or migration roles.
GRANT :"owner_user" TO :"migration_user";

ALTER DATABASE :"database_name" OWNER TO :"owner_user";
REVOKE ALL ON DATABASE :"database_name" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"database_name"
  TO :"migration_user", :"maintenance_user", :"lifecycle_command_user", :"api_runtime_user", :"worker_runtime_user", :"dispatcher_runtime_user";

ALTER SCHEMA public OWNER TO :"owner_user";
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO :"owner_user";
GRANT USAGE ON SCHEMA public TO :"api_runtime_user", :"worker_runtime_user";

-- pg_monitor is read-only monitoring access; it does not grant application
-- table access or ownership.
GRANT pg_monitor TO :"maintenance_user";
SQL
