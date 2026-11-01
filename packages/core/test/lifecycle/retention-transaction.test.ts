import { z } from 'zod';
import { parseDatabaseConfig } from '@pertexo/database/platform';
import { createRetentionDatabase } from '../../src/lifecycle/retention/repository.js';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { inRetentionTransaction } from '../../src/lifecycle/retention/transactions.repository.js';

describe('retention transaction admission', () => {
  it.each([0, -1, 1.5, Number.NaN, 2_147_483_648])(
    'rejects invalid lock timeout configuration %s at construction',
    (lockTimeoutMs) => {
      const config = parseDatabaseConfig({
        connectionString: 'postgresql://fixture:fixture@127.0.0.1:1/fixture',
      });
      expect(() => createRetentionDatabase(config, { lockTimeoutMs })).toThrow(
        z.ZodError,
      );
    },
  );

  it('preserves the exact pre-aborted maintenance reason without checkout', async () => {
    const connect = vi.fn();
    const reason = new Error('maintenance stopping');
    await expect(
      inRetentionTransaction(
        { connect } as unknown as Pool,
        { lockTimeoutMs: 10_000, statementTimeoutMs: 30_000 },
        AbortSignal.abort(reason),
        vi.fn(),
      ),
    ).rejects.toBe(reason);
    expect(connect).not.toHaveBeenCalled();
  });
});
