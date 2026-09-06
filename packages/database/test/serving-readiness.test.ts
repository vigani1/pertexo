import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import {
  checkDatabaseServingReadiness,
  EXPECTED_MIGRATION_HEAD,
} from '../src/platform/readiness.js';

describe('steady database serving readiness', () => {
  it('pins the reviewed migration head', () => {
    expect(EXPECTED_MIGRATION_HEAD).toBe('0081_schedule_claim_concurrency.sql');
  });

  it('checks only bounded live compatibility state', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          current_user: 'pertexo_api',
          migration_head: EXPECTED_MIGRATION_HEAD,
          postgres_major: 18,
        },
      ],
    });

    await expect(
      checkDatabaseServingReadiness({ query } as unknown as Pool),
    ).resolves.toEqual({
      migrationHead: EXPECTED_MIGRATION_HEAD,
      postgresMajor: 18,
      role: 'pertexo_api',
    });

    expect(query).toHaveBeenCalledOnce();
    const statement = String(query.mock.calls[0]?.[0]);
    expect(statement).toContain('schema_migrations');
    expect(statement).not.toMatch(
      /pg_(?:attribute|class|constraint|index|policy|proc|trigger)/u,
    );
    expect(statement).not.toContain('has_function_privilege');
    expect(statement).not.toContain('has_table_privilege');
  });
});
