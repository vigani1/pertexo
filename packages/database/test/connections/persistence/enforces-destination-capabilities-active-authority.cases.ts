import type { PoolClient } from 'pg';
import { expect, it } from 'vitest';
import {
  Pool,
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

export function registerEnforcesDestinationCapabilitiesActiveAuthority(): void {
  it('enforces destination capabilities, active authority, and workflow visibility', async () => {
    const connection = createInput({
      providerKey: 'email',
      authType: 'resend_api_key',
      name: `Destination roles ${randomUUID()}`,
    });
    await connections.api.createConnection(connection);
    const roleActors = new Map([
      ['owner', ownerA],
      ...(['admin', 'builder', 'operator', 'viewer'] as const).map(
        (role) => [role, randomUUID()] as const,
      ),
    ] as const);
    const workflowIds = new Map(
      [...roleActors.keys()].map((role) => [role, randomUUID()] as const),
    );
    const otherWorkspaceWorkflowId = randomUUID();
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
        if (role !== 'owner') {
          await client.query(
            `insert into app.users (id,email,display_name,status)
             values ($1,$2,$3,'active')`,
            [actorId, `${actorId}@example.test`, `Destination ${role}`],
          );
          await client.query(
            `insert into app.workspace_memberships
               (workspace_id,user_id,role,status)
             values ($1,$2,$3,'active')`,
            [workspaceA, actorId, role],
          );
        }
        await client.query(
          `insert into app.workflows (id,workspace_id,name,created_by)
           values ($1,$2,$3,$4)`,
          [
            workflowIds.get(role),
            workspaceA,
            `Destination role ${role}`,
            ownerA,
          ],
        );
      }
      await client.query("select set_config('app.workspace_id',$1,true)", [
        workspaceB,
      ]);
      await client.query(
        `insert into app.workflows (id,workspace_id,name,created_by)
         values ($1,$2,'Other workspace policy',$3)`,
        [otherWorkspaceWorkflowId, workspaceB, ownerB],
      );
      await client.query('commit');
    } finally {
      await client?.query('rollback').catch(() => undefined);
      client?.release();
      await owner.end();
    }

    const destinationId = randomUUID();
    const destinationConfig = {
      kind: 'email' as const,
      connectionId: connection.connectionId,
      toEmail: 'roles@example.test',
    };
    const destination = await connections.destinations.create({
      workspaceId: workspaceA,
      actorId: ownerA,
      destinationId,
      config: destinationConfig,
      idempotencyKey: `role-base-${destinationId}`,
      requestHash: '9'.repeat(64),
    });

    for (const [role, actorId] of roleActors) {
      const readable = ['owner', 'admin', 'builder'].includes(role);
      if (readable) {
        await expect(
          connections.destinations.get({
            workspaceId: workspaceA,
            actorId,
            destinationId,
          }),
        ).resolves.toEqual(destination);
        await expect(
          connections.destinations.list({
            workspaceId: workspaceA,
            actorId,
          }),
        ).resolves.toContainEqual(destination);
      } else {
        await expect(
          connections.destinations.get({
            workspaceId: workspaceA,
            actorId,
            destinationId,
          }),
        ).rejects.toMatchObject({ code: 'not_found' });
        await expect(
          connections.destinations.list({
            workspaceId: workspaceA,
            actorId,
          }),
        ).rejects.toMatchObject({ code: 'not_found' });
      }

      const candidateId = randomUUID();
      const create = connections.destinations.create({
        workspaceId: workspaceA,
        actorId,
        destinationId: candidateId,
        config: destinationConfig,
        idempotencyKey: `role-create-${role}-${candidateId}`,
        requestHash: 'a'.repeat(64),
      });
      if (role === 'owner' || role === 'admin')
        await expect(create).resolves.toMatchObject({ id: candidateId });
      else await expect(create).rejects.toMatchObject({ code: 'not_found' });

      const workflowId = workflowIds.get(role);
      if (workflowId === undefined) throw new Error('Role workflow missing');
      const policy = {
        workspaceId: workspaceA,
        actorId,
        workflowId,
        destinationId,
        idempotencyKey: `role-policy-${role}-${workflowId}`,
        requestHash: 'b'.repeat(64),
      };
      const read = connections.destinations.getWorkflowPolicy({
        workspaceId: workspaceA,
        actorId,
        workflowId,
      });
      if (readable) {
        await expect(read).resolves.toBeNull();
        await expect(
          connections.destinations.setWorkflowPolicy(policy),
        ).resolves.toBeUndefined();
        await expect(
          connections.destinations.getWorkflowPolicy({
            workspaceId: workspaceA,
            actorId,
            workflowId,
          }),
        ).resolves.toEqual(destination);
        await expect(
          connections.destinations.clearWorkflowPolicy({
            ...policy,
            idempotencyKey: `role-policy-clear-${role}-${workflowId}`,
            requestHash: 'c'.repeat(64),
          }),
        ).resolves.toBeUndefined();
      } else {
        await expect(read).rejects.toMatchObject({ code: 'not_found' });
        await expect(
          connections.destinations.setWorkflowPolicy(policy),
        ).rejects.toMatchObject({ code: 'not_found' });
        await expect(
          connections.destinations.clearWorkflowPolicy({
            ...policy,
            idempotencyKey: `role-policy-clear-${role}-${workflowId}`,
            requestHash: 'c'.repeat(64),
          }),
        ).rejects.toMatchObject({ code: 'not_found' });
      }
    }

    const adminId = roleActors.get('admin');
    const builderId = roleActors.get('builder');
    if (adminId === undefined || builderId === undefined)
      throw new Error('Destination authority fixtures are missing');
    await expect(
      connections.destinations.appendVersion({
        workspaceId: workspaceA,
        actorId: adminId,
        destinationId,
        expectedVersion: 1,
        config: { ...destinationConfig, toEmail: 'admin@example.test' },
        idempotencyKey: `admin-append-${destinationId}`,
        requestHash: 'd'.repeat(64),
      }),
    ).resolves.toMatchObject({ currentVersion: 2 });
    await expect(
      connections.destinations.appendVersion({
        workspaceId: workspaceA,
        actorId: builderId,
        destinationId,
        expectedVersion: 2,
        config: { ...destinationConfig, toEmail: 'builder@example.test' },
        idempotencyKey: `builder-append-${destinationId}`,
        requestHash: 'e'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      connections.destinations.setStatus({
        workspaceId: workspaceA,
        actorId: builderId,
        destinationId,
        status: 'disabled',
        idempotencyKey: `builder-status-${destinationId}`,
        requestHash: 'f'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    const adminReplayCommand = {
      workspaceId: workspaceA,
      actorId: adminId,
      destinationId,
      status: 'enabled' as const,
      idempotencyKey: `admin-status-replay-${destinationId}`,
      requestHash: '1'.repeat(64),
    };
    await expect(
      connections.destinations.setStatus(adminReplayCommand),
    ).resolves.toMatchObject({ status: 'enabled' });
    await expect(
      connections.destinations.setWorkflowPolicy({
        workspaceId: workspaceA,
        actorId: builderId,
        workflowId: otherWorkspaceWorkflowId,
        destinationId,
        idempotencyKey: `foreign-workflow-${otherWorkspaceWorkflowId}`,
        requestHash: '0'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      connections.destinations.get({
        workspaceId: workspaceB,
        actorId: ownerB,
        destinationId,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      connections.destinations.getWorkflowPolicy({
        workspaceId: workspaceA,
        actorId: builderId,
        workflowId: otherWorkspaceWorkflowId,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });

    const authority = new Pool({
      connectionString: databaseUrl(migrationBaseUrl),
    });
    try {
      await authority.query('set role pertexo_owner');
      await authority.query("select set_config('app.workspace_id',$1,false)", [
        workspaceA,
      ]);
      const assertInactiveDenied = async (): Promise<void> => {
        await expect(
          connections.destinations.get({
            workspaceId: workspaceA,
            actorId: adminId,
            destinationId,
          }),
        ).rejects.toMatchObject({ code: 'not_found' });
        await expect(
          connections.destinations.setStatus(adminReplayCommand),
        ).rejects.toMatchObject({ code: 'not_found' });
      };
      await authority.query(
        `update app.workspace_memberships set status='suspended'
          where workspace_id=$1 and user_id=$2`,
        [workspaceA, adminId],
      );
      await assertInactiveDenied();
      await authority.query(
        `update app.workspace_memberships set status='active'
          where workspace_id=$1 and user_id=$2`,
        [workspaceA, adminId],
      );
      await authority.query(
        `update app.users set status='suspended' where id=$1`,
        [adminId],
      );
      await assertInactiveDenied();
      await authority.query(
        `update app.users set status='active' where id=$1`,
        [adminId],
      );
      await authority.query(
        `update app.workspaces set status='suspended' where id=$1`,
        [workspaceA],
      );
      // A suspended workspace still reads its destinations (ADR 013/027).
      await expect(
        connections.destinations.get({
          workspaceId: workspaceA,
          actorId: adminId,
          destinationId,
        }),
      ).resolves.toMatchObject({ id: destinationId });
      await expect(
        connections.destinations.setStatus(adminReplayCommand),
      ).rejects.toMatchObject({ code: 'not_found' });
    } finally {
      await authority
        .query(
          `update app.workspace_memberships set status='active'
            where workspace_id=$1 and user_id=$2`,
          [workspaceA, adminId],
        )
        .catch(() => undefined);
      await authority
        .query(`update app.users set status='active' where id=$1`, [adminId])
        .catch(() => undefined);
      await authority
        .query(`update app.workspaces set status='active' where id=$1`, [
          workspaceA,
        ])
        .catch(() => undefined);
      await authority.end();
    }
  });
}
