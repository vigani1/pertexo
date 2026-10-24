import { insertTestMember } from '../../support/user.js';
import type { PoolClient } from 'pg';
import { expect, it } from 'vitest';
import {
  ConnectionNotFoundError,
  Pool,
  createHash,
  createInput,
  databaseUrl,
  migrationBaseUrl,
  ownerA,
  ownerB,
  randomUUID,
  workspaceA,
  workspaceB,
} from '../../support/connections.js';

import { connections } from './fixture.js';

export function registerListsReadsActorScopedMetadata(): void {
  it('lists and reads actor-scoped metadata with deterministic keyset pagination', async () => {
    const first = createInput({ name: `Readable ${randomUUID().slice(0, 8)}` });
    const second = createInput({
      name: `Readable ${randomUUID().slice(0, 8)}`,
    });
    await connections.api.createConnection(first);
    await connections.api.createConnection(second);

    const page = await connections.api.listConnections({
      workspaceId: workspaceA,
      actorId: ownerA,
      limit: 1,
    });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeDefined();
    expect(page.items[0]).not.toHaveProperty('sealed');

    if (page.nextCursor === undefined)
      throw new Error('Expected a cursor for the populated fixture');
    const nextPage = await connections.api.listConnections({
      workspaceId: workspaceA,
      actorId: ownerA,
      limit: 1,
      after: page.nextCursor,
    });
    expect(nextPage.items[0]?.id).not.toBe(page.items[0]?.id);
    const stored = await connections.api.readConnection({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: first.connectionId,
    });
    expect(stored).toMatchObject({
      id: first.connectionId,
      workspaceId: workspaceA,
      lastRunObservedAt: null,
      lastHealthTransitionAt: null,
      lastHealthTransitionSource: null,
    });
    expect(stored?.createdAt).toBeInstanceOf(Date);
    expect(Object.isFrozen(stored)).toBe(true);
    for (const privateField of [
      'sealed',
      'healthRevision',
      'sharingRevision',
      'ciphertext',
    ])
      expect(stored).not.toHaveProperty(privateField);
    await expect(
      connections.api.readConnection({
        workspaceId: workspaceB,
        actorId: ownerB,
        connectionId: first.connectionId,
      }),
    ).resolves.toBeNull();
  });

  it('paginates same-status rows within one millisecond without gaps or duplicates', async () => {
    const inputs = [createInput(), createInput(), createInput()];
    for (const input of inputs) await connections.api.createConnection(input);

    const owner = new Pool({ connectionString: databaseUrl(migrationBaseUrl) });
    try {
      await owner.query('begin');
      await owner.query('set local role pertexo_owner');
      await owner.query("select set_config('app.workspace_id',$1,true)", [
        workspaceA,
      ]);
      for (const [index, input] of inputs.entries()) {
        await owner.query(
          `update app.connections
           set created_at = ('2099-01-01T00:00:00.000100Z'::timestamptz
             + $2::integer * interval '100 microseconds')
           where workspace_id = $1 and id = $3`,
          [workspaceA, index, input.connectionId],
        );
      }
      await owner.query('commit');
    } finally {
      await owner.query('rollback').catch(() => undefined);
      await owner.end();
    }

    const seen: string[] = [];
    let after: Parameters<typeof connections.api.listConnections>[0]['after'];
    for (let pageNumber = 0; pageNumber < 3; pageNumber += 1) {
      const page = await connections.api.listConnections({
        workspaceId: workspaceA,
        actorId: ownerA,
        limit: 1,
        ...(after === undefined ? {} : { after }),
      });
      const item = page.items[0];
      if (item === undefined)
        throw new Error('Expected a connection page item');
      seen.push(item.id);
      after = page.nextCursor;
    }

    expect(new Set(seen).size).toBe(3);
    expect(seen.toSorted()).toEqual(
      inputs.map((input) => input.connectionId).toSorted(),
    );
  });

  it('uses capability roles and rejects inactive authority states', async () => {
    const roleActors = new Map([
      ['owner', ownerA],
      ...(['admin', 'builder', 'operator', 'viewer'] as const).map(
        (role) => [role, randomUUID()] as const,
      ),
    ] as const);
    const owner = new Pool({ connectionString: databaseUrl(migrationBaseUrl) });
    let client: PoolClient | undefined;
    try {
      client = await owner.connect();
      await client.query('begin');
      await client.query('set local role pertexo_owner');
      await client.query("select set_config('app.workspace_id',$1,true)", [
        workspaceA,
      ]);
      for (const [role, actorId] of roleActors) {
        if (role === 'owner') continue;
        await insertTestMember(client.query.bind(client), {
          userId: actorId,
          workspaceId: workspaceA,
          displayName: `Connection ${role}`,
          role,
        });
      }
      await client.query('commit');
    } finally {
      await client?.query('rollback').catch(() => undefined);
      client?.release();
      await owner.end();
    }

    for (const [role, actorId] of roleActors) {
      const command = createInput({ actorId });
      const creation = connections.api.createConnection(command);
      if (role === 'owner' || role === 'admin')
        await expect(creation).resolves.toMatchObject({ createdBy: actorId });
      else
        await expect(creation).rejects.toBeInstanceOf(ConnectionNotFoundError);
    }

    const shared = createInput();
    await connections.api.createConnection(shared);
    for (const [role, actorId] of roleActors) {
      const start = connections.api.startConnectionTest({
        workspaceId: workspaceA,
        actorId,
        connectionId: shared.connectionId,
        expectedProviderKey: 'http',
        idempotencyKey: `role-${role}-${shared.connectionId}`,
        requestHash: createHash('sha256').update(role).digest('hex'),
        dispatchToken: randomUUID(),
      });
      if (role === 'viewer')
        await expect(start).rejects.toBeInstanceOf(ConnectionNotFoundError);
      else await expect(start).resolves.toMatchObject({ kind: 'dispatch' });
    }

    const builderId = roleActors.get('builder');
    if (builderId === undefined) throw new Error('Builder fixture is missing');
    const authorityPool = new Pool({
      connectionString: databaseUrl(migrationBaseUrl),
    });
    try {
      await authorityPool.query('set role pertexo_owner');
      await authorityPool.query(
        "select set_config('app.workspace_id',$1,false)",
        [workspaceA],
      );
      const assertDenied = async (suffix: string): Promise<void> => {
        await expect(
          connections.api.startConnectionTest({
            workspaceId: workspaceA,
            actorId: builderId,
            connectionId: shared.connectionId,
            expectedProviderKey: 'http',
            idempotencyKey: `inactive-${suffix}-${shared.connectionId}`,
            requestHash: createHash('sha256').update(suffix).digest('hex'),
            dispatchToken: randomUUID(),
          }),
        ).rejects.toBeInstanceOf(ConnectionNotFoundError);
      };
      await authorityPool.query(
        `update app.workspace_memberships set status='suspended'
         where workspace_id=$1 and user_id=$2`,
        [workspaceA, builderId],
      );
      await assertDenied('membership');
      await authorityPool.query(
        `update app.workspace_memberships set status='active'
         where workspace_id=$1 and user_id=$2`,
        [workspaceA, builderId],
      );
      await authorityPool.query(
        `update app.users set status='suspended' where id=$1`,
        [builderId],
      );
      await assertDenied('user');
      await authorityPool.query(
        `update app.users set status='active' where id=$1`,
        [builderId],
      );
      await authorityPool.query(
        `update app.workspaces set status='suspended' where id=$1`,
        [workspaceA],
      );
      await assertDenied('workspace');
    } finally {
      await authorityPool
        .query(`update app.users set status='active' where id=$1`, [builderId])
        .catch(() => undefined);
      await authorityPool
        .query(`update app.workspaces set status='active' where id=$1`, [
          workspaceA,
        ])
        .catch(() => undefined);
      await authorityPool.end();
    }
  });
}
