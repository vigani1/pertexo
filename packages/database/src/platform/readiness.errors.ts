export type DatabaseNotReadyReason =
  'metadata_unavailable' | 'postgres_unsupported' | 'migration_head_mismatch';

const MESSAGES: Readonly<Record<DatabaseNotReadyReason, string>> = {
  metadata_unavailable: 'Database readiness metadata is unavailable',
  postgres_unsupported: 'PostgreSQL major version is unsupported',
  migration_head_mismatch: 'Database migration head is incompatible',
};

/** The database is reachable but not one this build can serve from. */
export class DatabaseNotReadyError extends Error {
  public override readonly name = 'DatabaseNotReadyError';
  public constructor(readonly reason: DatabaseNotReadyReason) {
    super(MESSAGES[reason]);
  }
}
