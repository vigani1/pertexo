import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { createUserStore } from '../../src/tenant-access/users/repository.js';
import { readIdentityDatabaseErrorCode } from '../../src/tenant-access/support.js';

describe('identity input admission', () => {
  it('reads only bounded nonthrowing PostgreSQL error codes', () => {
    expect(readIdentityDatabaseErrorCode({ code: '23505' })).toBe('23505');
    expect(
      readIdentityDatabaseErrorCode({ code: 'not-a-sqlstate' }),
    ).toBeUndefined();
    expect(
      readIdentityDatabaseErrorCode(
        Object.defineProperty({}, 'code', {
          get: () => {
            throw new Error('hostile getter');
          },
        }),
      ),
    ).toBeUndefined();
  });

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

      await expect(store.createUser(input)).rejects.toThrow();
      expect(query).not.toHaveBeenCalled();
    },
  );
});
