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

export function registerIdempotentlyManagesImmutableFailureNotification(): void {
  it('idempotently manages immutable failure-notification destinations and workflow policy', async () => {
    const connection = createInput({
      providerKey: 'email',
      authType: 'resend_api_key',
      name: `Email ${randomUUID()}`,
    });
    await connections.api.createConnection(connection);
    expect(connection.connectionId[14]).toBe('7');
    const workflowId = randomUUID();
    const owner = new Pool({ connectionString: databaseUrl(migrationBaseUrl) });
    let ownerClient: PoolClient | undefined;
    try {
      ownerClient = await owner.connect();
      await ownerClient.query('begin');
      await ownerClient.query('set local role pertexo_owner');
      await ownerClient.query("select set_config('app.workspace_id',$1,true)", [
        workspaceA,
      ]);
      await ownerClient.query(
        `insert into app.workflows (id,workspace_id,name,created_by)
         values ($1,$2,'Notification policy',$3)`,
        [workflowId, workspaceA, ownerA],
      );
      await ownerClient.query('commit');
    } finally {
      await ownerClient?.query('rollback').catch(() => undefined);
      ownerClient?.release();
      await owner.end();
    }

    const destinationId = randomUUID();
    const create = {
      workspaceId: workspaceA,
      actorId: ownerA,
      destinationId,
      config: {
        kind: 'email' as const,
        connectionId: connection.connectionId,
        toEmail: 'Ops@example.test',
      },
      idempotencyKey: `destination-create-${destinationId}`,
      requestHash: '1'.repeat(64),
      requestId: `request-${destinationId}`,
    };
    const created = await connections.destinations.create(create);
    expect(created.config).toMatchObject({ toEmail: 'Ops@example.test' });
    expect(created.createdAt).toBeInstanceOf(Date);
    expect(created.updatedAt).toBeInstanceOf(Date);
    expect(Object.isFrozen(created)).toBe(true);
    expect(created).not.toHaveProperty('createdBy');
    expect(created.config.kind).toBe('email');
    await expect(
      connections.destinations.get({
        workspaceId: workspaceA,
        actorId: ownerA,
        destinationId,
      }),
    ).resolves.toEqual(created);
    await expect(
      connections.destinations.list({
        workspaceId: workspaceA,
        actorId: ownerA,
      }),
    ).resolves.toContainEqual(created);
    const replayed = await connections.destinations.create({
      ...create,
      destinationId: randomUUID(),
    });
    expect(replayed).toEqual(created);
    await expect(
      connections.destinations.create({
        ...create,
        requestHash: '2'.repeat(64),
      }),
    ).rejects.toMatchObject({
      code: 'idempotency_conflict',
      name: 'FailureNotificationDestinationError',
    });

    const append = {
      ...create,
      destinationId,
      expectedVersion: 1,
      config: { ...create.config, toEmail: 'alerts@example.test' },
      idempotencyKey: `destination-append-${destinationId}`,
      requestHash: '3'.repeat(64),
    };
    const appended = await connections.destinations.appendVersion(append);
    await expect(
      connections.destinations.appendVersion(append),
    ).resolves.toEqual(appended);
    expect(appended).toMatchObject({
      currentVersion: 2,
      config: { toEmail: 'alerts@example.test' },
    });

    const setPolicy = {
      workspaceId: workspaceA,
      actorId: ownerA,
      workflowId,
      destinationId,
      idempotencyKey: `policy-set-${workflowId}`,
      requestHash: '4'.repeat(64),
    };
    const readPolicy = { workspaceId: workspaceA, actorId: ownerA, workflowId };
    await expect(
      connections.destinations.getWorkflowPolicy(readPolicy),
    ).resolves.toBeNull();
    await connections.destinations.setWorkflowPolicy(setPolicy);
    await connections.destinations.setWorkflowPolicy(setPolicy);
    await expect(
      connections.destinations.getWorkflowPolicy(readPolicy),
    ).resolves.toEqual(appended);
    await expect(
      connections.destinations.getWorkflowPolicy({
        workspaceId: workspaceB,
        actorId: ownerB,
        workflowId,
      }),
    ).rejects.toMatchObject({
      code: 'not_found',
      name: 'FailureNotificationDestinationError',
    });
    const statusNoop = {
      workspaceId: workspaceA,
      actorId: ownerA,
      destinationId,
      status: 'enabled' as const,
      idempotencyKey: `destination-status-noop-${destinationId}`,
      requestHash: '7'.repeat(64),
    };
    await expect(
      connections.destinations.setStatus(statusNoop),
    ).resolves.toEqual(appended);
    const status = {
      workspaceId: workspaceA,
      actorId: ownerA,
      destinationId,
      status: 'disabled' as const,
      idempotencyKey: `destination-status-${destinationId}`,
      requestHash: '5'.repeat(64),
    };
    await connections.destinations.setStatus(status);
    await expect(
      connections.destinations.setStatus(status),
    ).resolves.toMatchObject({
      status: 'disabled',
    });
    // A disabled destination stays the workflow's current choice until changed.
    await expect(
      connections.destinations.getWorkflowPolicy(readPolicy),
    ).resolves.toMatchObject({ id: destinationId, status: 'disabled' });
    await expect(
      connections.destinations.list({
        workspaceId: workspaceB,
        actorId: ownerB,
      }),
    ).resolves.toEqual([]);
    const clearPolicy = {
      workspaceId: workspaceA,
      actorId: ownerA,
      workflowId,
      idempotencyKey: `policy-clear-${workflowId}`,
      requestHash: '6'.repeat(64),
    };
    await connections.destinations.clearWorkflowPolicy(clearPolicy);
    await connections.destinations.clearWorkflowPolicy(clearPolicy);
    await expect(
      connections.destinations.getWorkflowPolicy(readPolicy),
    ).resolves.toBeNull();
    await expect(
      connections.destinations.clearWorkflowPolicy({
        ...clearPolicy,
        idempotencyKey: `${clearPolicy.idempotencyKey}-absent`,
        requestHash: '8'.repeat(64),
      }),
    ).resolves.toBeUndefined();
    await expect(
      connections.destinations.create({
        ...create,
        destinationId: randomUUID(),
      }),
    ).resolves.toEqual(created);
    await expect(
      connections.destinations.appendVersion(append),
    ).resolves.toEqual(appended);
    const deletion = new Pool({
      connectionString: databaseUrl(migrationBaseUrl),
    });
    let deletionClient: PoolClient | undefined;
    try {
      deletionClient = await deletion.connect();
      await deletionClient.query('begin');
      await deletionClient.query('set local role pertexo_owner');
      await deletionClient.query(
        "select set_config('app.workspace_id',$1,true)",
        [workspaceA],
      );
      await deletionClient.query('delete from app.workflows where id=$1', [
        workflowId,
      ]);
      await deletionClient.query('commit');
    } finally {
      await deletionClient?.query('rollback').catch(() => undefined);
      deletionClient?.release();
      await deletion.end();
    }
    await expect(
      connections.destinations.clearWorkflowPolicy(clearPolicy),
    ).resolves.toBeUndefined();
    await expect(
      connections.destinations.clearWorkflowPolicy({
        ...clearPolicy,
        idempotencyKey: `${clearPolicy.idempotencyKey}-new`,
      }),
    ).rejects.toMatchObject({
      code: 'not_found',
      name: 'FailureNotificationDestinationError',
    });
    await expect(
      connections.destinations.getWorkflowPolicy(readPolicy),
    ).rejects.toMatchObject({ code: 'not_found' });

    const audit = new Pool({ connectionString: databaseUrl(migrationBaseUrl) });
    let auditClient: PoolClient | undefined;
    try {
      auditClient = await audit.connect();
      await auditClient.query('begin');
      await auditClient.query('set local role pertexo_owner');
      await auditClient.query("select set_config('app.workspace_id',$1,true)", [
        workspaceA,
      ]);
      const result = await auditClient.query<{
        action: string;
        actor_user_id: string;
        metadata: Record<string, unknown>;
        request_id: string | null;
        target_id: string;
        target_type: string;
        trace_id: string | null;
      }>(
        `select action,actor_user_id::text,target_type,target_id::text,
                request_id,trace_id,metadata
           from app.audit_events
          where target_id in ($1,$2)
            and action in (
              'failure_notification_destination.created',
              'failure_notification_destination.version_appended',
              'failure_notification_destination.enabled',
              'failure_notification_destination.disabled',
              'workflow.failure_notification_policy_set',
              'workflow.failure_notification_policy_cleared'
            )
          order by action`,
        [destinationId, workflowId],
      );
      expect(result.rows).toEqual([
        {
          action: 'failure_notification_destination.created',
          actor_user_id: ownerA,
          metadata: { kind: 'email', version: 1 },
          request_id: create.requestId,
          target_id: destinationId,
          target_type: 'failure_notification_destination',
          trace_id: null,
        },
        {
          action: 'failure_notification_destination.disabled',
          actor_user_id: ownerA,
          metadata: {},
          request_id: null,
          target_id: destinationId,
          target_type: 'failure_notification_destination',
          trace_id: null,
        },
        {
          action: 'failure_notification_destination.version_appended',
          actor_user_id: ownerA,
          metadata: { version: 2 },
          request_id: create.requestId,
          target_id: destinationId,
          target_type: 'failure_notification_destination',
          trace_id: null,
        },
        {
          action: 'workflow.failure_notification_policy_cleared',
          actor_user_id: ownerA,
          metadata: {},
          request_id: null,
          target_id: workflowId,
          target_type: 'workflow',
          trace_id: null,
        },
        {
          action: 'workflow.failure_notification_policy_set',
          actor_user_id: ownerA,
          metadata: { destinationId },
          request_id: null,
          target_id: workflowId,
          target_type: 'workflow',
          trace_id: null,
        },
      ]);
    } finally {
      await auditClient?.query('rollback').catch(() => undefined);
      auditClient?.release();
      await audit.end();
    }
  });
}
