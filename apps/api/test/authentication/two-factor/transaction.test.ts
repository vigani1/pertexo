import type { Pool } from 'pg';
import { expect, it, vi } from 'vitest';
import { securityTransaction } from '../../../src/authentication/better-auth/security-transaction.js';

it('does not fail a committed sign-in when the development mail observer throws or rejects', async () => {
  const query = vi
    .fn<(sql: string) => Promise<{ rows: never[] }>>()
    .mockResolvedValue({ rows: [] });
  const release = vi.fn();
  const pool = {
    connect: () => Promise.resolve({ query, release }),
  } as unknown as Pool;
  const response = await securityTransaction(pool, (_client, afterCommit) => {
    afterCommit(() => {
      throw new Error('Development observer failed');
    });
    afterCommit(() =>
      Promise.reject(new Error('Development observer rejected')),
    );
    return Promise.resolve(
      new Response('signed in', { headers: { 'set-cookie': 'session=valid' } }),
    );
  });
  expect(await response.text()).toBe('signed in');
  expect(response.headers.get('set-cookie')).toBe('session=valid');
  expect(query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'COMMIT']);
  expect(release).toHaveBeenCalledOnce();
});
