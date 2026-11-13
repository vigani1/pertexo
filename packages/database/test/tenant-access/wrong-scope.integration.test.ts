import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  withMultiWorkspaceTransaction,
  withPlatformTransaction,
  withTenantScopedClient,
} from '../../src/tenant-access/transactions.js';
import { setOrganizationContext } from '../../src/tenant-access/transactions/scope.js';
import {
  POOL_ROLES,
  admin,
  captureRejection,
  contextSettings,
  productionPool,
  seedWorkspaces,
  setUpDatabase,
  tearDownDatabase,
} from './tenant-context-pools/fixture.js';

beforeAll(setUpDatabase, 60_000);
afterAll(tearDownDatabase);

let pool: Pool;
let workspaceA: string;
let workspaceB: string;

beforeAll(async () => {
  pool = productionPool('api', POOL_ROLES[0].url, 1);
  [workspaceA = '', workspaceB = ''] = await seedWorkspaces(2);
});

async function addTag(client: PoolClient, workspaceId: string, key: string) {
  await client.query(
    'insert into app.workflow_tags(workspace_id,id,key) values ($1,$2,$3)',
    [workspaceId, randomUUID(), key],
  );
}

async function storedTags(key: string): Promise<number | null> {
  return (
    await admin.query('select 1 from app.workflow_tags where key=$1', [key])
  ).rowCount;
}

describe('a wrong scope', () => {
  it.each([
    ['malformed', 'not-a-uuid'],
    ['missing', ''],
    ['injected', `${randomUUID()}' or true --`],
  ])(
    'with a %s second workspace keeps nothing the first scope wrote',
    async (_kind, wrongWorkspace) => {
      const key = `w${randomUUID().slice(0, 8)}`;
      let enteredSecond = false;
      const error = await captureRejection(() =>
        withMultiWorkspaceTransaction(pool, async (inWorkspace) => {
          await inWorkspace({ workspaceId: workspaceA }, (client) =>
            addTag(client, workspaceA, key),
          );
          await inWorkspace({ workspaceId: wrongWorkspace }, () => {
            enteredSecond = true;
            return Promise.resolve();
          });
        }),
      );
      expect(error).toMatchObject({ name: 'ZodError' });
      expect(enteredSecond).toBe(false);
      expect(await storedTags(key)).toBe(0);
    },
  );

  it('with a malformed organization is refused before it is installed, and nothing written stays', async () => {
    const key = `o${randomUUID().slice(0, 8)}`;
    let after = false;
    const error = await captureRejection(() =>
      withTenantScopedClient(
        pool,
        { workspaceId: workspaceA },
        async (client) => {
          await addTag(client, workspaceA, key);
          await setOrganizationContext(client, 'not-a-uuid');
          after = true;
        },
      ),
    );
    expect(error).toMatchObject({ name: 'ZodError' });
    expect(after).toBe(false);
    expect(await storedTags(key)).toBe(0);
    await expect(
      withPlatformTransaction(pool, contextSettings),
    ).resolves.toMatchObject({ organizationId: null });
  });

  it('for one workspace cannot write a row of another, and keeps nothing of the attempt', async () => {
    const key = `m${randomUUID().slice(0, 8)}`;
    const error = await captureRejection(() =>
      withTenantScopedClient(
        pool,
        { workspaceId: workspaceA },
        async (client) => {
          await addTag(client, workspaceA, key);
          await addTag(client, workspaceB, `${key}b`);
        },
      ),
    );
    expect(error).toMatchObject({ code: '42501' });
    expect(await storedTags(key)).toBe(0);
    expect(await storedTags(`${key}b`)).toBe(0);
  });
});
