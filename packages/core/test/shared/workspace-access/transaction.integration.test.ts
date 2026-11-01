import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { withWorkspaceAccess } from '../../../src/shared/index.js';

import { userId } from '../../../../database/test/lifecycle/retention.support.js';
import {
  afterAllFixture2,
  beforeAllFixture1,
  fixture,
  pool,
} from '../../variables/configuration/fixture.js';
import {
  anyMember,
  MODES,
  RENAME,
  withImpatientClient,
  workspaceName,
} from './support.js';

beforeAll(beforeAllFixture1);
afterAll(afterAllFixture2);

describe('read mode', () => {
  it('cannot write, whatever the operation tries', async () => {
    const { workspaceId } = await fixture();
    const before = await workspaceName(workspaceId);
    await expect(
      withWorkspaceAccess(
        pool,
        { workspaceId, actorId: userId },
        { mode: 'read', ...anyMember },
        (client) => client.query(RENAME, [workspaceId]),
      ),
    ).rejects.toMatchObject({ code: '25006' });
    expect(await workspaceName(workspaceId)).toBe(before);
  });

  it('sees one snapshot from start to end', async () => {
    const { workspaceId } = await fixture();
    const before = await workspaceName(workspaceId);
    const names = await withWorkspaceAccess(
      pool,
      { workspaceId, actorId: userId },
      { mode: 'read', ...anyMember },
      async (client) => {
        const read = async () =>
          (
            await client.query<{ name: string }>(
              'select name from app.workspaces where id=$1',
              [workspaceId],
            )
          ).rows[0]?.name;
        const first = await read();
        await withImpatientClient((other) =>
          other.query(RENAME, [workspaceId]),
        );
        return [first, await read()];
      },
    );
    expect(names).toEqual([before, before]);
    expect(await workspaceName(workspaceId)).toBe('Renamed');
  });
});

describe('change mode', () => {
  it('commits what the operation wrote', async () => {
    const { workspaceId } = await fixture();
    await withWorkspaceAccess(
      pool,
      { workspaceId, actorId: userId },
      { mode: 'change', ...anyMember },
      (client) => client.query(RENAME, [workspaceId]),
    );
    expect(await workspaceName(workspaceId)).toBe('Renamed');
  });

  it('takes it all back when the operation fails', async () => {
    const { workspaceId } = await fixture();
    const before = await workspaceName(workspaceId);
    const failure = new Error('Operation failed');
    await expect(
      withWorkspaceAccess(
        pool,
        { workspaceId, actorId: userId },
        { mode: 'change', ...anyMember },
        async (client) => {
          await client.query(RENAME, [workspaceId]);
          throw failure;
        },
      ),
    ).rejects.toBe(failure);
    expect(await workspaceName(workspaceId)).toBe(before);
  });
});

describe('what reaches the transaction', () => {
  it.each(MODES)(
    'takes no timeout from a larger input, such as a request body, in %s mode',
    async (mode) => {
      const { workspaceId } = await fixture();
      const body = {
        workspaceId,
        actorId: userId,
        statementTimeoutMillis: 1,
      };
      // At 1 ms this sleep would be cancelled, if the field got through.
      await expect(
        withWorkspaceAccess(pool, body, { mode, ...anyMember }, (client) =>
          client.query('select pg_sleep(0.05)'),
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
    },
  );
});

describe('the signal', () => {
  it.each(MODES)(
    'stops %s work before it starts when already aborted',
    async (mode) => {
      const { workspaceId } = await fixture();
      const operation = vi.fn(() => Promise.resolve());
      await expect(
        withWorkspaceAccess(
          pool,
          {
            workspaceId,
            actorId: userId,
            signal: AbortSignal.abort(),
          },
          { mode, ...anyMember },
          operation,
        ),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(operation).not.toHaveBeenCalled();
    },
  );

  it('cancels a read in progress', async () => {
    const { workspaceId } = await fixture();
    const controller = new AbortController();
    await expect(
      withWorkspaceAccess(
        pool,
        { workspaceId, actorId: userId, signal: controller.signal },
        { mode: 'read', ...anyMember },
        async (client) => {
          const sleeping = client.query('select pg_sleep(30)');
          controller.abort();
          return sleeping;
        },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('cancels a change in progress and keeps nothing of it', async () => {
    const { workspaceId } = await fixture();
    const before = await workspaceName(workspaceId);
    const controller = new AbortController();
    await expect(
      withWorkspaceAccess(
        pool,
        { workspaceId, actorId: userId, signal: controller.signal },
        { mode: 'change', ...anyMember },
        async (client) => {
          await client.query(RENAME, [workspaceId]);
          const sleeping = client.query('select pg_sleep(30)');
          controller.abort();
          return sleeping;
        },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await expect.poll(() => workspaceName(workspaceId)).toBe(before);
  });
});
