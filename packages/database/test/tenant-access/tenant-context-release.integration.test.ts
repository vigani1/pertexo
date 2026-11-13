import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  withActorDiscoveryScope,
  withActorScopedClient,
  withMultiWorkspaceTransaction,
  withPlatformTransaction,
  withTenantScopedClient,
  withWorkspaceScope,
} from '../../src/tenant-access/transactions.js';
import { setOrganizationContext } from '../../src/tenant-access/transactions/scope.js';
import {
  afterAllFixture2,
  apiPool,
  backendId,
  beforeAllFixture1,
  captureRejection,
} from './tenant-context-hygiene/fixture.js';

beforeAll(beforeAllFixture1, 60_000);
afterAll(afterAllFixture2);

const CLEAN = Object.freeze({
  workspaceId: null,
  actorId: null,
  discoveryScope: null,
  organizationId: null,
  statementTimeout: '0',
});

/** What the next transaction on the pool's only client starts with. */
async function nextTransaction(): Promise<
  Readonly<{ backend: number; settings: unknown }>
> {
  return withPlatformTransaction(apiPool, async (client) => ({
    backend: await backendId(client),
    settings: await settings(client),
  }));
}

async function settings(client: PoolClient) {
  const result = await client.query<Record<string, string | null>>(
    `select nullif(current_setting('app.workspace_id', true), '') workspace_id,
            nullif(current_setting('app.actor_id', true), '') actor_id,
            nullif(current_setting('app.discovery_scope', true), '') discovery_scope,
            nullif(current_setting('app.organization_id', true), '') organization_id,
            current_setting('statement_timeout') statement_timeout`,
  );
  const row = result.rows[0];
  return {
    workspaceId: row?.workspace_id ?? null,
    actorId: row?.actor_id ?? null,
    discoveryScope: row?.discovery_scope ?? null,
    organizationId: row?.organization_id ?? null,
    statementTimeout: row?.statement_timeout ?? null,
  };
}

describe('a released pooled client', () => {
  it('carries no setting into its next transaction after a commit', async () => {
    const workspaceId = randomUUID();
    const actorId = randomUUID();
    const used = await withTenantScopedClient(
      apiPool,
      { workspaceId, actorId },
      async (client) => {
        expect(await settings(client)).toEqual({
          ...CLEAN,
          workspaceId,
          actorId,
          statementTimeout: '5s',
        });
        return backendId(client);
      },
      { statementTimeoutMillis: 5_000 },
    );

    await expect(nextTransaction()).resolves.toEqual({
      backend: used,
      settings: CLEAN,
    });
  });

  it('carries no actor discovery or organization setting after a commit', async () => {
    const actorId = randomUUID();
    const organizationId = randomUUID();
    const discovered = await withActorScopedClient(
      apiPool,
      actorId,
      async (client) => {
        expect(await settings(client)).toMatchObject({
          actorId,
          discoveryScope: 'workspace_memberships',
        });
        await setOrganizationContext(client, organizationId);
        return backendId(client);
      },
      { statementTimeoutMillis: 1_500 },
    );

    await expect(nextTransaction()).resolves.toEqual({
      backend: discovered,
      settings: CLEAN,
    });
  });

  it('carries no setting after its operation fails and the transaction rolls back', async () => {
    const original = new Error('operation failed');
    let used: number | undefined;
    const error = await captureRejection(() =>
      withTenantScopedClient(
        apiPool,
        { workspaceId: randomUUID(), actorId: randomUUID() },
        async (client) => {
          used = await backendId(client);
          throw original;
        },
        { statementTimeoutMillis: 2_000 },
      ),
    );

    expect(error).toBe(original);
    await expect(nextTransaction()).resolves.toEqual({
      backend: used,
      settings: CLEAN,
    });
  });

  it('carries no setting after a failed statement aborts the transaction', async () => {
    let used: number | undefined;
    const error = await captureRejection(() =>
      withActorScopedClient(apiPool, randomUUID(), async (client) => {
        used = await backendId(client);
        await client.query('select 1/0');
      }),
    );

    expect(error).toMatchObject({ code: '22012' });
    await expect(nextTransaction()).resolves.toEqual({
      backend: used,
      settings: CLEAN,
    });
  });

  it('carries no nested workspace scope out of a multi-workspace transaction', async () => {
    const used = await withMultiWorkspaceTransaction(
      apiPool,
      async (inWorkspace) => {
        await inWorkspace({ workspaceId: randomUUID() }, (client) =>
          setOrganizationContext(client, randomUUID()),
        );
        return inWorkspace(
          { workspaceId: randomUUID(), actorId: randomUUID() },
          backendId,
        );
      },
    );

    await expect(nextTransaction()).resolves.toEqual({
      backend: used,
      settings: CLEAN,
    });
  });
});

describe('a scoped transaction', () => {
  it('states its whole context over anything the client carried in, organization included', async () => {
    const leaked = await apiPool.connect();
    const backend = await backendId(leaked);
    // Session-level on purpose: what a leak would leave behind.
    await leaked.query(
      `select set_config('app.workspace_id',$1,false),
              set_config('app.actor_id',$2,false),
              set_config('app.discovery_scope','workspace_memberships',false),
              set_config('app.organization_id',$3,false)`,
      [randomUUID(), randomUUID(), randomUUID()],
    );
    leaked.release();
    try {
      const workspaceId = randomUUID();
      await expect(
        withTenantScopedClient(apiPool, { workspaceId }, async (client) => ({
          backend: await backendId(client),
          settings: await settings(client),
        })),
      ).resolves.toEqual({ backend, settings: { ...CLEAN, workspaceId } });
      const actorId = randomUUID();
      await expect(
        withActorScopedClient(apiPool, actorId, settings),
      ).resolves.toEqual({
        ...CLEAN,
        actorId,
        discoveryScope: 'workspace_memberships',
      });
    } finally {
      const contaminated = await apiPool.connect();
      contaminated.release(true);
    }
  });
});

describe('a wrong or mismatched scope', () => {
  it('fails before the operation runs and leaves the client reusable', async () => {
    const { backend } = await nextTransaction();
    let entered = false;
    const operation = () => {
      entered = true;
      return Promise.resolve();
    };

    await expect(
      withTenantScopedClient(apiPool, { workspaceId: 'not-a-uuid' }, operation),
    ).rejects.toMatchObject({ name: 'ZodError' });
    await expect(
      withTenantScopedClient(
        apiPool,
        { workspaceId: randomUUID() },
        operation,
        {
          statementTimeoutMillis: 0,
        },
      ),
    ).rejects.toThrow('Invalid PostgreSQL statement timeout');

    expect(entered).toBe(false);
    await expect(nextTransaction()).resolves.toEqual({
      backend,
      settings: CLEAN,
    });
  });

  it('refuses a workspace scope while actor discovery is installed', async () => {
    let entered = false;
    await withPlatformTransaction(apiPool, async (client) => {
      await withActorDiscoveryScope(client, randomUUID(), async (scoped) => {
        await expect(
          withWorkspaceScope(scoped, { workspaceId: randomUUID() }, () => {
            entered = true;
            return Promise.resolve();
          }),
        ).rejects.toThrow('retained actor context');
      });
    });

    expect(entered).toBe(false);
    await expect(nextTransaction()).resolves.toMatchObject({
      settings: CLEAN,
    });
  });
});
