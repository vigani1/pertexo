import { READINESS_IDENTITY_AUTHORING_SQL } from './readiness-probe-1.sql.js';
import { READINESS_EXECUTION_SQL } from './readiness-probe-2.sql.js';
import { READINESS_CONNECTIONS_PREVIEW_SQL } from './readiness-probe-3.sql.js';
import { READINESS_TRIGGERS_MIGRATION_SQL } from './readiness-probe-4.sql.js';

export const DATABASE_READINESS_SQL = [
  READINESS_IDENTITY_AUTHORING_SQL,
  READINESS_EXECUTION_SQL,
  READINESS_CONNECTIONS_PREVIEW_SQL,
  READINESS_TRIGGERS_MIGRATION_SQL,
].join('');
