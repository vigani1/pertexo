#!/bin/sh
set -eu

mc alias set ledger "${LEDGER_ENDPOINT}" "${LEDGER_ADMIN_ACCESS_KEY_ID}" "${LEDGER_ADMIN_SECRET_ACCESS_KEY}"
mc admin user add ledger "${LEDGER_ACCESS_KEY_ID}" "${LEDGER_SECRET_ACCESS_KEY}"
mc admin policy create ledger pertexo-control-ledger "/bootstrap/${LEDGER_POLICY_FILE}"
mc admin policy attach ledger pertexo-control-ledger --user "${LEDGER_ACCESS_KEY_ID}"
