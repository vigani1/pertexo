import { describe, expect, it } from 'vitest';
import {
  checkDatabaseReadiness,
  EXPECTED_MIGRATION_HEAD,
} from '../../src/platform/readiness.repository.js';
import { DatabaseNotReadyError } from '../../src/platform/readiness.errors.js';

function poolReturning(rows: readonly object[]) {
  return {
    query: () => Promise.resolve({ rows }),
  } as unknown as Parameters<typeof checkDatabaseReadiness>[0];
}

const ready = {
  current_user: 'pertexo_app',
  migration_head: EXPECTED_MIGRATION_HEAD,
  postgres_major: 18,
};

describe('database readiness', () => {
  it('reports the head, major version and role of a ready database', async () => {
    await expect(
      checkDatabaseReadiness(poolReturning([ready])),
    ).resolves.toEqual({
      migrationHead: EXPECTED_MIGRATION_HEAD,
      postgresMajor: 18,
      role: 'pertexo_app',
    });
  });

  it.each([
    ['metadata_unavailable', [], 'Database readiness metadata is unavailable'],
    [
      'postgres_unsupported',
      [{ ...ready, postgres_major: 17 }],
      'PostgreSQL major version is unsupported',
    ],
    [
      'migration_head_mismatch',
      [{ ...ready, migration_head: '9999_future.sql' }],
      'Database migration head is incompatible',
    ],
  ] as const)(
    'refuses %s with its named error and message',
    async (reason, rows, message) => {
      const refusal = checkDatabaseReadiness(poolReturning(rows));
      await expect(refusal).rejects.toThrow(DatabaseNotReadyError);
      await expect(refusal).rejects.toMatchObject({ reason, message });
    },
  );
});
