import type { Pool } from 'pg';
import { expect, it, vi } from 'vitest';
import { securityTransaction } from '../../../src/authentication/better-auth/transactions/response.js';

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
  expect(
    query.mock.calls
      .map(([sql]) => sql.toUpperCase())
      .filter((sql) => ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)),
  ).toEqual(['BEGIN', 'COMMIT']);
  expect(release).toHaveBeenCalledOnce();
});

it.each([
  [401, 'INVALID_BACKUP_CODE', true],
  [400, 'TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE', true],
  [429, 'ACCOUNT_TEMPORARILY_LOCKED', true],
  [409, 'AUTHENTICATION_CHANGED', false],
  [401, 'UNAUTHORIZED', false],
] as const)(
  'retains only lockout-budget refusals: %i %s',
  async (status, code, commit) => {
    const query = vi
      .fn<(sql: string) => Promise<{ rows: never[] }>>()
      .mockResolvedValue({ rows: [] });
    const deliver = vi.fn(() => Promise.resolve());
    const pool = {
      connect: () => Promise.resolve({ query, release: vi.fn() }),
    } as unknown as Pool;
    const response = await securityTransaction(pool, (_client, afterCommit) => {
      if (!commit) afterCommit(deliver);
      return Promise.resolve(
        Response.json(
          { code },
          { status, headers: { 'set-cookie': 'session=candidate' } },
        ),
      );
    });
    expect(
      query.mock.calls
        .map(([sql]) => sql.toUpperCase())
        .filter((sql) => ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)),
    ).toEqual(['BEGIN', commit ? 'COMMIT' : 'ROLLBACK']);
    expect(response.status).toBe(status);
    expect(response.headers.get('set-cookie')).toBe(
      commit ? 'session=candidate' : null,
    );
    expect(deliver).not.toHaveBeenCalled();
  },
);
