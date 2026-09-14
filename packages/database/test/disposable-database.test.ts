import { describe, expect, it, vi } from 'vitest';

import {
  createDisposableDatabaseFixture,
  type DisposableDatabaseAdmin,
} from './support/disposable-database.js';

function fixtureWithAdmin(
  admin: DisposableDatabaseAdmin,
  databaseName: string,
) {
  return createDisposableDatabaseFixture(
    {
      adminUrl: 'postgresql://admin@example.test/postgres',
      connectRoles: ['runtime_role'],
      databaseName,
      ownerRole: 'owner_role',
    },
    { createAdmin: () => admin },
  );
}

describe('disposable database fixture', () => {
  it('accepts only an owned test namespace before querying', async () => {
    const query = vi.fn((text: string) => {
      void text;
      return Promise.resolve({ rows: [] });
    });
    const end = vi.fn(() => Promise.resolve());
    const admin = { end, query } as DisposableDatabaseAdmin;
    await fixtureWithAdmin(admin, 'pertexo_test_quoted_database').create();
    expect(query.mock.calls[0]?.[0]).toContain(
      '"pertexo_test_quoted_database"',
    );

    query.mockClear();
    expect(() => fixtureWithAdmin(admin, 'production')).toThrow(
      'Disposable database name is outside the test namespace',
    );
    expect(() =>
      fixtureWithAdmin(admin, 'pertexo_test_invalid\0database'),
    ).toThrow('Disposable database name is outside the test namespace');
    expect(() =>
      fixtureWithAdmin(admin, `pertexo_test_${'x'.repeat(51)}`),
    ).toThrow('Disposable database name is outside the test namespace');
    expect(query).not.toHaveBeenCalled();
    expect(end).toHaveBeenCalledOnce();
  });

  it('drops only a database created by this attempt when later setup fails', async () => {
    const statements: string[] = [];
    const setupError = new Error('revoke failed');
    const query = (text: string) => {
      statements.push(text);
      if (text.startsWith('revoke all')) return Promise.reject(setupError);
      if (text.includes('from pg_stat_activity'))
        return Promise.resolve({ rows: [{ connections: 0 }] });
      return Promise.resolve({ rows: [] });
    };
    const admin: DisposableDatabaseAdmin = {
      end: vi.fn(() => Promise.resolve()),
      query: query as DisposableDatabaseAdmin['query'],
    };

    await expect(
      fixtureWithAdmin(admin, 'pertexo_test_created_then_failed').create(),
    ).rejects.toBe(setupError);
    expect(statements).toContain(
      'drop database if exists "pertexo_test_created_then_failed"',
    );
  });

  it('does not drop when database creation itself fails', async () => {
    const creationError = new Error('create failed');
    const query = vi.fn(() => Promise.reject(creationError));
    const admin = {
      end: vi.fn(() => Promise.resolve()),
      query,
    } as DisposableDatabaseAdmin;

    await expect(
      fixtureWithAdmin(admin, 'pertexo_test_never_created').create(),
    ).rejects.toBe(creationError);
    expect(query).toHaveBeenCalledOnce();
  });

  it('preserves setup, compensating-drop, and admin-close failures in order', async () => {
    const setupError = new Error('grant failed');
    const dropError = new Error('connection inventory failed');
    const closeError = new Error('admin close failed');
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(setupError)
      .mockRejectedValueOnce(dropError);
    const end = vi.fn().mockRejectedValue(closeError);
    const admin = {
      end,
      query,
    } as DisposableDatabaseAdmin;

    await expect(
      fixtureWithAdmin(admin, 'pertexo_test_multi_failure').create(),
    ).rejects.toMatchObject({ errors: [setupError, dropError, closeError] });
    expect(end).toHaveBeenCalledOnce();
  });

  it('preserves a drop failure when admin close also fails', async () => {
    const dropError = new Error('drop failed');
    const closeError = new Error('close failed');
    const end = vi.fn().mockRejectedValue(closeError);
    const admin = {
      end,
      query: vi.fn().mockRejectedValue(dropError),
    } as DisposableDatabaseAdmin;

    await expect(
      fixtureWithAdmin(admin, 'pertexo_test_drop_failure').drop(),
    ).rejects.toMatchObject({ errors: [dropError, closeError] });
    expect(end).toHaveBeenCalledOnce();
  });
});
