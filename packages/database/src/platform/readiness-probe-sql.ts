import { READINESS_IDENTITY_AUTHORING_SQL } from './readiness-probe-1.sql.js';
import { READINESS_EXECUTION_SQL } from './readiness-probe-2.sql.js';
import { READINESS_CONNECTIONS_PREVIEW_SQL } from './readiness-probe-3.sql.js';
import { READINESS_TRIGGERS_MIGRATION_SQL } from './readiness-probe-4.sql.js';

// The numbered source files retain their migration-era filenames, while these
// capability names are the stable ownership map: identity/authoring,
// execution, connections/preview, and triggers/admission/migration metadata.
export const DATABASE_READINESS_SQL = [
  READINESS_IDENTITY_AUTHORING_SQL,
  READINESS_EXECUTION_SQL,
  READINESS_CONNECTIONS_PREVIEW_SQL,
  READINESS_TRIGGERS_MIGRATION_SQL,
].join('');
