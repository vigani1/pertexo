import { afterAll, beforeAll, expect, it } from 'vitest';
import { withTenantScopedReadClient } from '../../../src/testing.js';
import {
  admin,
  closeWorld,
  openWorld,
  pool,
  team,
} from '../../tenant-access/access/world.js';

beforeAll(openWorld);
afterAll(closeWorld);

it('keeps one worker read snapshot while another transaction commits a workspace change', async () => {
  const { workspaceId } = await team();
  const read = async () =>
    (
      await admin.query<{ name: string }>(
        'select name from app.workspaces where id=$1',
        [workspaceId],
      )
    ).rows[0]?.name;
  const before = await read();
  const observed = await withTenantScopedReadClient(
    pool,
    { workspaceId },
    async (client) => {
      const name = async () =>
        (
          await client.query<{ name: string }>(
            'select name from app.workspaces where id=$1',
            [workspaceId],
          )
        ).rows[0]?.name;
      const first = await name();
      await admin.query(
        "update app.workspaces set name='Committed during snapshot' where id=$1",
        [workspaceId],
      );
      return [first, await name()];
    },
  );
  expect(observed).toEqual([before, before]);
  expect(await read()).toBe('Committed during snapshot');
});
