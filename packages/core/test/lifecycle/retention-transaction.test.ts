import { z } from 'zod';
import { parseDatabaseConfig } from '@pertexo/database/platform';
import { createRetentionStore } from '../../src/lifecycle/retention/retention.store.js';
import { describe, expect, it } from 'vitest';

describe('retention transaction admission', () => {
  it.each([0, -1, 1.5, Number.NaN, 2_147_483_648])(
    'rejects invalid lock timeout configuration %s at construction',
    (lockTimeoutMs) => {
      const config = parseDatabaseConfig({
        connectionString: 'postgresql://fixture:fixture@127.0.0.1:1/fixture',
      });
      expect(() => createRetentionStore(config, { lockTimeoutMs })).toThrow(
        z.ZodError,
      );
    },
  );
});
