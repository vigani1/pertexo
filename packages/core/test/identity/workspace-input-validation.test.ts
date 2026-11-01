import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

import { createUserStore } from '../../src/tenant-access/users/repository.js';

describe('identity input admission', () => {
  it.each([
    [
      'email',
      { email: `${'a'.repeat(309)}@example.test`, displayName: 'Name' },
    ],
    [
      'display name',
      { email: 'user@example.test', displayName: 'n'.repeat(257) },
    ],
  ])(
    'rejects an overlength direct user %s before SQL',
    async (_field, input) => {
      const query = vi.fn();
      const store = createUserStore({
        query,
      } as unknown as Pool);

      await expect(store.createUser(input)).rejects.toBeInstanceOf(ZodError);
      expect(query).not.toHaveBeenCalled();
    },
  );
});
