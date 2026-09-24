import type { IdentityWorkspaceDatabase } from '@pertexo/database/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { countLegacyOnlyUsers } from '../../src/platform/identity/better-auth-composition.js';
import { createApiIdentityRuntime } from '../../src/platform/identity/identity-runtime.module.js';

const pg = vi.hoisted(() => {
  const state = {
    pools: [] as {
      options: Record<string, unknown>;
      queries: string[];
      ended: boolean;
    }[],
    legacyOnlyUsers: 0 as number | undefined,
    failure: undefined as Error | undefined,
  };
  class Pool {
    private readonly record: (typeof state.pools)[number];

    public constructor(options: Record<string, unknown>) {
      this.record = { options, queries: [], ended: false };
      state.pools.push(this.record);
    }

    public query(text: string) {
      this.record.queries.push(text);
      if (state.failure !== undefined) return Promise.reject(state.failure);
      return Promise.resolve({
        rows:
          state.legacyOnlyUsers === undefined
            ? []
            : [{ affected: state.legacyOnlyUsers }],
      });
    }

    public end() {
      this.record.ended = true;
      return Promise.resolve();
    }
  }
  return { state, Pool };
});

vi.mock('pg', () => ({ Pool: pg.Pool, default: { Pool: pg.Pool } }));

const databaseConfig = {
  connectionString: 'postgresql://api:secret@localhost:5432/pertexo',
  connectionTimeoutMillis: 1_000,
  idleTimeoutMillis: 2_000,
  max: 4,
  ownerRole: 'pertexo_owner',
  workerRuntimeRole: 'pertexo_worker',
};

afterEach(() => {
  pg.state.pools.length = 0;
  pg.state.legacyOnlyUsers = 0;
  pg.state.failure = undefined;
});

describe('standalone Better Auth cutover guard', () => {
  it('counts active legacy-only users on one dedicated connection', async () => {
    pg.state.legacyOnlyUsers = 3;

    await expect(countLegacyOnlyUsers(databaseConfig)).resolves.toBe(3);

    expect(pg.state.pools).toHaveLength(1);
    const [pool] = pg.state.pools;
    expect(pool?.options).toEqual({
      connectionString: databaseConfig.connectionString,
      connectionTimeoutMillis: 1_000,
      idleTimeoutMillis: 2_000,
      max: 1,
    });
    expect(pool?.queries).toHaveLength(1);
    expect(pool?.queries[0]).toMatch(/users\.status='active'/u);
    expect(pool?.queries[0]).toMatch(
      /exists \(\s+select 1 from app\.auth_identities/u,
    );
    expect(pool?.queries[0]).toMatch(
      /not exists \(\s+select 1 from app\.auth_accounts/u,
    );
    expect(pool?.ended).toBe(true);
  });

  it('reports no legacy-only users when the count returns no row', async () => {
    pg.state.legacyOnlyUsers = undefined;

    await expect(countLegacyOnlyUsers(databaseConfig)).resolves.toBe(0);
    expect(pg.state.pools[0]?.ended).toBe(true);
  });

  it('releases its connection when counting fails', async () => {
    pg.state.failure = new Error('database unavailable');

    await expect(countLegacyOnlyUsers(databaseConfig)).rejects.toThrow(
      'database unavailable',
    );
    expect(pg.state.pools[0]?.ended).toBe(true);
  });

  it('blocks standalone runtime composition through the production counter', async () => {
    pg.state.legacyOnlyUsers = 2;
    const close = vi.fn().mockResolvedValue(undefined);

    await expect(
      createApiIdentityRuntime(
        {
          publicWebOrigin: 'https://app.example.test',
          session: { ttlMillis: 60_000, secureCookie: true, sameSite: 'lax' },
          betterAuth: {
            secret: 'standalone-runtime-secret-at-least-32-characters',
            mailMode: 'local',
            providers: {},
          },
        },
        databaseConfig,
        {
          persistence: {
            database: { close } as unknown as IdentityWorkspaceDatabase,
          },
        },
      ),
    ).rejects.toThrow(
      'Standalone Better Auth cutover blocked: 2 active legacy-only user(s) require an approved recovery mapping',
    );
    expect(pg.state.pools).toHaveLength(1);
    expect(pg.state.pools[0]?.ended).toBe(true);
    expect(close).not.toHaveBeenCalled();
  });
});
