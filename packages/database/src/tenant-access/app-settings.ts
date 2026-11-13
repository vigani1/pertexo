import { TENANT_SETTING_NAMES } from './transactions/scope.js';

/**
 * Every app.* setting the database reads: the tenant settings a transaction
 * installs, and the run-admission switches its functions read. A fresh
 * pooled connection must carry none of them. The database integration test
 * scans the whole catalog and fails when it reads a name missing here.
 */
export const APP_SETTING_NAMES: readonly string[] = Object.freeze([
  ...TENANT_SETTING_NAMES,
  'app.workflow_concurrency_protocol',
  'app.workflow_concurrency_skip_protocol',
]);
