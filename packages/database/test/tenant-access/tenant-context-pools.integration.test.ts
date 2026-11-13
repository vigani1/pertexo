import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  withActorScopedClient,
  withMultiWorkspaceTransaction,
  withPlatformTransaction,
  withTenantScopedClient,
  withTenantScopedReadClient,
} from '../../src/tenant-access/transactions.js';
import { setOrganizationContext } from '../../src/tenant-access/transactions/scope.js';
import {
  POOL_ROLES,
  admin,
  backendId,
  captureRejection,
  contextSettings,
  productionPool,
  seedWorkspaces,
  setUpDatabase,
  tearDownDatabase,
  waitForStatement,
} from './tenant-context-pools/fixture.js';

beforeAll(setUpDatabase, 60_000);
afterAll(tearDownDatabase);

/** Leaves every kind of context behind, if any of it could outlive the transaction. */
async function fillContext(client: PoolClient): Promise<number> {
  await setOrganizationContext(client, randomUUID());
  return backendId(client);
}

const scope = () => ({ workspaceId: randomUUID(), actorId: randomUUID() });

describe.each(POOL_ROLES)(
  'the next user of a $role pool connection',
  ({ role, url, defaultTimeoutMillis }) => {
    let pool: Pool;
    const clean = {
      workspaceId: null,
      actorId: null,
      discoveryScope: null,
      organizationId: null,
      statementTimeoutMillis: defaultTimeoutMillis,
    };

    beforeAll(() => {
      pool = productionPool(role, url, 1);
    });

    /** What a plain query on the pool's only connection sees, outside any helper. */
    async function nextUser() {
      const client = await pool.connect();
      try {
        return {
          backend: await backendId(client),
          settings: await contextSettings(client),
        };
      } finally {
        client.release();
      }
    }

    it('sees no context after a commit', async () => {
      const used = await withTenantScopedClient(pool, scope(), fillContext, {
        statementTimeoutMillis: 4_000,
      });
      await expect(nextUser()).resolves.toEqual({
        backend: used,
        settings: clean,
      });
      const discovered = await withActorScopedClient(
        pool,
        randomUUID(),
        fillContext,
        { statementTimeoutMillis: 3_000 },
      );
      await expect(nextUser()).resolves.toEqual({
        backend: discovered,
        settings: clean,
      });
    });

    it('sees no context after a rollback', async () => {
      let used: number | undefined;
      const failure = new Error('operation failed');
      await expect(
        withTenantScopedClient(
          pool,
          scope(),
          async (client) => {
            used = await fillContext(client);
            throw failure;
          },
          { statementTimeoutMillis: 4_000 },
        ),
      ).rejects.toBe(failure);
      await expect(nextUser()).resolves.toEqual({
        backend: used,
        settings: clean,
      });
    });

    it('sees no context after a failed statement', async () => {
      let used: number | undefined;
      await expect(
        withTenantScopedReadClient(
          pool,
          scope(),
          async (client) => {
            used = await fillContext(client);
            await client.query('select 1/0');
          },
          { statementTimeoutMillis: 4_000 },
        ),
      ).rejects.toMatchObject({ code: '22012' });
      await expect(nextUser()).resolves.toEqual({
        backend: used,
        settings: clean,
      });
    });

    it('sees no context after the COMMIT itself fails', async () => {
      let used: number | undefined;
      const marker = Math.floor(Math.random() * 1_000_000_000);
      await expect(
        withTenantScopedClient(
          pool,
          scope(),
          async (client) => {
            used = await fillContext(client);
            await client.query(
              'insert into commit_probe.deferred_unique(id) values ($1),($1)',
              [marker],
            );
          },
          { statementTimeoutMillis: 4_000 },
        ),
      ).rejects.toMatchObject({ code: '23505' });
      await expect(nextUser()).resolves.toEqual({
        backend: used,
        settings: clean,
      });
      const kept = await admin.query(
        'select 1 from commit_probe.deferred_unique where id=$1',
        [marker],
      );
      expect(kept.rowCount).toBe(0);
    });

    it('sees no context or shortened timeout after a statement timeout', async () => {
      let used: number | undefined;
      await expect(
        withTenantScopedClient(
          pool,
          scope(),
          async (client) => {
            used = await fillContext(client);
            await client.query('select pg_sleep(5)');
          },
          { statementTimeoutMillis: 150 },
        ),
      ).rejects.toMatchObject({ code: '57014' });
      await expect(nextUser()).resolves.toEqual({
        backend: used,
        settings: clean,
      });
    });

    it('sees no context after its query is cancelled from outside', async () => {
      let used: number | undefined;
      let entered: (pid: number) => void = () => undefined;
      const backend = new Promise<number>((resolve) => {
        entered = resolve;
      });
      const running = withMultiWorkspaceTransaction(pool, (inWorkspace) =>
        inWorkspace(scope(), async (client) => {
          used = await fillContext(client);
          entered(used);
          await client.query('select pg_sleep(5) /* cancel-me */');
        }),
      );
      const pid = await backend;
      await waitForStatement(pid, 'cancel-me');
      await admin.query('select pg_cancel_backend($1)', [pid]);
      // The nested scope's cleanup also fails in the aborted transaction, so the
      // cancellation arrives as the first of an aggregate.
      expect(await captureRejection(() => running)).toMatchObject({
        errors: [{ code: '57014' }, { code: '25P02' }],
      });
      await expect(nextUser()).resolves.toEqual({
        backend: used,
        settings: clean,
      });
    });

    it('gets a fresh, clean connection after the connection dies mid-transaction', async () => {
      let entered: (pid: number) => void = () => undefined;
      const backend = new Promise<number>((resolve) => {
        entered = resolve;
      });
      const running = withTenantScopedClient(pool, scope(), async (client) => {
        entered(await fillContext(client));
        await client.query('select pg_sleep(5) /* terminate-me */');
      });
      const pid = await backend;
      await waitForStatement(pid, 'terminate-me');
      await admin.query('select pg_terminate_backend($1)', [pid]);
      expect(await captureRejection(() => running)).toBeInstanceOf(Error);
      const next = await nextUser();
      expect(next.backend).not.toBe(pid);
      expect(next.settings).toEqual(clean);
    });

    it('sees no context after a nested multi-workspace scope', async () => {
      const used = await withMultiWorkspaceTransaction(
        pool,
        async (inWorkspace) => {
          await inWorkspace(scope(), fillContext);
          return inWorkspace(scope(), backendId);
        },
        { statementTimeoutMillis: 4_000 },
      );
      await expect(nextUser()).resolves.toEqual({
        backend: used,
        settings: clean,
      });
    });

    it('sees no context after a platform transaction sets an organization', async () => {
      const used = await withPlatformTransaction(pool, fillContext);
      await expect(nextUser()).resolves.toEqual({
        backend: used,
        settings: clean,
      });
    });
  },
);

describe('many workspaces sharing a small pool', () => {
  it('each transaction sees and writes only its own workspace, and unscoped ones see none', async () => {
    const pool = productionPool('api', POOL_ROLES[0].url, 3);
    const workspaces = await seedWorkspaces(6);
    const committed = new Map<string, Set<string>>(
      workspaces.map((workspaceId) => [workspaceId, new Set()]),
    );
    const violations: string[] = [];
    const unexpected: unknown[] = [];

    const scoped = async (index: number) => {
      const workspaceId = workspaces[index % workspaces.length] ?? '';
      const id = randomUUID();
      const outcome = index % 4;
      const run = withTenantScopedClient(
        pool,
        { workspaceId, actorId: randomUUID() },
        async (client) => {
          await client.query(
            'insert into app.workflow_tags(workspace_id,id,key) values ($1,$2,$3)',
            [workspaceId, id, `t${String(index)}`],
          );
          await client.query('select pg_sleep($1)', [Math.random() / 50]);
          const seen = await client.query<{ workspace_id: string }>(
            'select workspace_id from app.workflow_tags',
          );
          const { workspaceId: installed } = await contextSettings(client);
          if (installed !== workspaceId)
            violations.push(`${String(index)} ran as ${String(installed)}`);
          for (const row of seen.rows)
            if (row.workspace_id !== workspaceId)
              violations.push(`${String(index)} saw ${row.workspace_id}`);
          // Writing another workspace's row must be refused, never stored.
          const foreign = workspaces[(index + 1) % workspaces.length] ?? '';
          await client
            .query('savepoint foreign_write')
            .then(() =>
              client.query(
                'insert into app.workflow_tags(workspace_id,id,key) values ($1,$2,$3)',
                [foreign, randomUUID(), `f${String(index)}`],
              ),
            )
            .then(
              () => violations.push(`${String(index)} wrote ${foreign}`),
              () => client.query('rollback to savepoint foreign_write'),
            );
          if (outcome === 1) throw new Error('rolled back');
          if (outcome === 2) await client.query('select 1/0');
        },
      );
      try {
        await run;
        committed.get(workspaceId)?.add(id);
      } catch (error: unknown) {
        // Rolled back on purpose; its row must be gone.
        if (outcome === 0 || outcome === 3) unexpected.push(error);
      }
    };

    const unscoped = async (index: number) => {
      const seen = await withPlatformTransaction(pool, async (client) => ({
        settings: await contextSettings(client),
        rows: (await client.query('select 1 from app.workflow_tags')).rowCount,
      }));
      if (seen.settings.workspaceId !== null || seen.rows !== 0)
        violations.push(
          `platform ${String(index)} saw ${String(seen.settings.workspaceId)} and ${String(seen.rows)} rows`,
        );
    };

    await Promise.all(
      Array.from({ length: 120 }, (_, index) =>
        index % 5 === 4 ? unscoped(index) : scoped(index),
      ),
    );

    expect(violations).toEqual([]);
    expect(unexpected).toEqual([]);
    const stored = await admin.query<{ workspace_id: string; id: string }>(
      'select workspace_id, id from app.workflow_tags where workspace_id = any($1)',
      [workspaces],
    );
    const actual = new Map<string, Set<string>>(
      workspaces.map((workspaceId) => [workspaceId, new Set()]),
    );
    for (const row of stored.rows) actual.get(row.workspace_id)?.add(row.id);
    expect(actual).toEqual(committed);
    expect([...committed.values()].every((ids) => ids.size > 0)).toBe(true);
  }, 60_000);
});
