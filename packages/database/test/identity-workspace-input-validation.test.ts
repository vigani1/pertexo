import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { createUserStore } from '../src/tenant-access/users/store.js';
import {
  parseIdentityMetadata,
  readIdentityDatabaseErrorCode,
} from '../src/tenant-access/support.js';

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

  it('accepts nested ordinary arrays and the exact 8 KiB metadata boundary', () => {
    const exact = { value: 'x'.repeat(8_192 - 12) };
    expect(Buffer.byteLength(JSON.stringify(exact), 'utf8')).toBe(8_192);
    expect(parseIdentityMetadata(exact)).toEqual(exact);
    expect(parseIdentityMetadata({ nested: [{ ok: true }, null, 3] })).toEqual({
      nested: [{ ok: true }, null, 3],
    });
  });

  it.each([
    ['over byte limit', { value: 'x'.repeat(8_192 - 11) }],
    [
      'forbidden nested key',
      { nested: [{ authorizationToken: 'must-not-be-admitted' }] },
    ],
    [
      'wide object',
      Object.fromEntries(
        Array.from({ length: 1_025 }, (_, index) => [
          `k${String(index)}`,
          index,
        ]),
      ),
    ],
  ])('rejects %s metadata with a controlled error', (_label, metadata) => {
    expect(() => parseIdentityMetadata(metadata)).toThrow();
  });

  it('rejects cyclic and deeply nested metadata without recursive overflow', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let depth = 0; depth < 4_000; depth += 1) {
      const child: Record<string, unknown> = {};
      deep.child = child;
      deep = child;
    }

    expect(() => parseIdentityMetadata(cyclic)).toThrow(
      'must not repeat object references',
    );
    expect(() => parseIdentityMetadata(root)).toThrow('depth limit exceeded');
  });
});
