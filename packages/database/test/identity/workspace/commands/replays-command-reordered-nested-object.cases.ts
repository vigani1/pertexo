import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';

import { expect, it } from 'vitest';

import {claimCommand, completeCommand, findCommandResult, IdempotencyConflictError} from '../../../../src/platform/idempotency/repository.js';
import { withTenantScopedClient } from '../../../../src/tenant-access/transactions.js';

import {
  adminDatabaseUrl,
  apiUrl,
  identityDatabase,
  ownerUserId,
  workspaceId,
} from '../fixture.js';

export function registerReplaysCommandReorderedNestedObject(): void {
  it('replays a command with reordered nested object keys, while changed values conflict', async () => {
    const pool = new Pool({ connectionString: apiUrl, max: 1 });
    const identity = {
      workspaceId,
      scope: ownerUserId,
      operation: 'test.canonical',
      idempotencyKey: randomUUID(),
    };
    try {
      await withTenantScopedClient(pool, { workspaceId }, async (client) => {
        const request = {
          settings: { left: 1, right: 2 },
          values: [{ first: true, second: false }],
        };
        expect(
          await findCommandResult(client, { ...identity, request }),
        ).toBeNull();
        expect(
          await claimCommand(client, {
            ...identity,
            request,
            resourceId: workspaceId,
          }),
        ).toBeNull();
        expect(
          await findCommandResult(client, { ...identity, request }),
        ).toBeNull();
        await completeCommand(client, identity, { receipt: 'first-command' });
        expect(
          await findCommandResult(client, { ...identity, request }),
        ).toEqual({ receipt: 'first-command' });
        expect(
          await claimCommand(client, {
            ...identity,
            resourceId: workspaceId,
            request: {
              values: [{ second: false, first: true }],
              settings: { right: 2, left: 1 },
            },
          }),
        ).toEqual({ receipt: 'first-command' });
        await expect(
          claimCommand(client, {
            ...identity,
            resourceId: workspaceId,
            request: { ...request, settings: { left: 2, right: 2 } },
          }),
        ).rejects.toBeInstanceOf(IdempotencyConflictError);
      });
    } finally {
      await pool.end();
    }
  });

  it('discovers only the actor active workspaces with stable keyset pagination', async () => {
    const second = await identityDatabase.createWorkspaceWithOwner({
      name: 'Second Accessible Workspace',
      slug: `second-${randomUUID().slice(0, 12)}`,
      ownerUserId,
    });
    const outsider = await identityDatabase.createUser({
      email: `${randomUUID()}@example.test`,
      displayName: 'Workspace Outsider',
    });
    const hidden = await identityDatabase.createWorkspaceWithOwner({
      name: 'Hidden Workspace',
      slug: `hidden-${randomUUID().slice(0, 12)}`,
      ownerUserId: outsider.id,
    });

    const discovered: string[] = [];
    let after: string | undefined;
    do {
      const page = await identityDatabase.listAccessibleWorkspaces(
        ownerUserId,
        { limit: 1, ...(after === undefined ? {} : { after }) },
      );
      discovered.push(...page.items.map((workspace) => workspace.id));
      for (const accessibleWorkspace of page.items) {
        expect(accessibleWorkspace).toMatchObject({
          role: 'owner',
          status: 'active',
        });
      }
      after = page.nextCursor;
    } while (after !== undefined);

    expect(discovered).toContain(workspaceId);
    expect(discovered).toContain(second.id);
    expect(discovered).not.toContain(hidden.id);
    expect(discovered).toEqual([...discovered].sort());

    const outsiderPage = await identityDatabase.listAccessibleWorkspaces(
      outsider.id,
    );
    expect(outsiderPage.items.map((workspace) => workspace.id)).toEqual([
      hidden.id,
    ]);
  });

  it('does not apply actor discovery inside an ordinary workspace transaction', async () => {
    const second = await identityDatabase.createWorkspaceWithOwner({
      name: 'Same actor isolated workspace',
      slug: `same-actor-${randomUUID().slice(0, 12)}`,
      ownerUserId,
    });
    const pool = new Pool({ connectionString: apiUrl, max: 1 });
    try {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query(
          `select set_config('app.workspace_id', $1, true),
                  set_config('app.actor_id', $2, true)`,
          [workspaceId, ownerUserId],
        );
        const rows = await client.query<{ workspace_id: string }>(
          'select workspace_id from app.workspace_memberships order by workspace_id',
        );
        expect(rows.rows.map((row) => row.workspace_id)).toEqual([workspaceId]);
        expect(rows.rows.map((row) => row.workspace_id)).not.toContain(
          second.id,
        );
        await client.query('commit');
      } finally {
        await client.query('rollback').catch(() => undefined);
        client.release();
      }
    } finally {
      await pool.end();
    }
  });

  it('renames conditionally, replays exact commands, and never reapplies an old result', async () => {
    const target = await identityDatabase.createWorkspaceWithOwner({
      name: 'Rename target',
      slug: `rename-${randomUUID().slice(0, 12)}`,
      ownerUserId,
    });
    const firstKey = `rename-${randomUUID()}`;
    const first = await identityDatabase.renameWorkspace({
      workspaceId: target.id,
      actorUserId: ownerUserId,
      name: 'First authoritative name',
      expectedRevision: 1,
      idempotencyKey: firstKey,
      requestId: 'rename-first',
    });
    expect(first).toMatchObject({
      changed: true,
      replayed: false,
      workspace: { name: 'First authoritative name', revision: 2 },
    });

    const replay = await identityDatabase.renameWorkspace({
      workspaceId: target.id,
      actorUserId: ownerUserId,
      name: 'First authoritative name',
      expectedRevision: 1,
      idempotencyKey: firstKey,
      requestId: 'rename-first-retry',
    });
    expect(replay).toMatchObject({
      changed: true,
      replayed: true,
      workspace: { name: 'First authoritative name', revision: 2 },
    });

    await identityDatabase.renameWorkspace({
      workspaceId: target.id,
      actorUserId: ownerUserId,
      name: 'Newer tab name',
      expectedRevision: 2,
      idempotencyKey: `rename-${randomUUID()}`,
    });
    const historicalReplay = await identityDatabase.renameWorkspace({
      workspaceId: target.id,
      actorUserId: ownerUserId,
      name: 'First authoritative name',
      expectedRevision: 1,
      idempotencyKey: firstKey,
    });
    expect(historicalReplay).toMatchObject({ replayed: true });

    const discovered =
      await identityDatabase.listAccessibleWorkspaces(ownerUserId);
    expect(
      discovered.items.find((item) => item.id === target.id),
    ).toMatchObject({ name: 'Newer tab name', revision: 3 });
    await expect(
      identityDatabase.renameWorkspace({
        workspaceId: target.id,
        actorUserId: ownerUserId,
        name: 'Stale overwrite',
        expectedRevision: 2,
        idempotencyKey: `rename-${randomUUID()}`,
      }),
    ).rejects.toMatchObject({ reason: 'revision_conflict' });
    await expect(
      identityDatabase.renameWorkspace({
        workspaceId: target.id,
        actorUserId: ownerUserId,
        name: 'Changed body',
        expectedRevision: 1,
        idempotencyKey: firstKey,
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);

    const owner = new Pool({ connectionString: adminDatabaseUrl, max: 1 });
    try {
      const audit = await owner.query<{ count: string }>(
        `select count(*)::text count from app.audit_events
         where workspace_id=$1 and action='workspace.renamed'`,
        [target.id],
      );
      expect(audit.rows[0]?.count).toBe('2');
    } finally {
      await owner.end();
    }
  });
}
