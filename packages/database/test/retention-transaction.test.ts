import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { inRetentionTransaction } from '../src/lifecycle/retention-transaction.js';

describe('retention transaction admission', () => {
  it.each([0, -1, 1.5, Number.NaN, 2_147_483_648])(
    'rejects invalid lock timeout %s before pool checkout',
    async (lockTimeoutMs) => {
      const connect = vi.fn();
      await expect(
        inRetentionTransaction(
          { connect } as unknown as Pool,
          { lockTimeoutMs, statementTimeoutMs: 30_000 },
          undefined,
          vi.fn(),
        ),
      ).rejects.toThrow('Invalid PostgreSQL lock timeout');
      expect(connect).not.toHaveBeenCalled();
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
