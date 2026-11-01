import type { PoolClient } from 'pg';
import { expect, it } from 'vitest';
import {
  CONNECTION_AUTH_TYPE,
  ConnectionConflictError,
  ConnectionIdempotencyConflictError,
  ConnectionUnavailableError,
  Pool,
  createHash,
  createInput,
  databaseUrl,
  migrationBaseUrl,
  ownerA,
  randomUUID,
  sealed,
  workspaceA,
} from '../../support/connections.js';
import { connections } from './fixture.js';

export function registerCreatesResolvesFencesRotatesAudits(): void {
  it('creates, resolves, fences, rotates, audits, and revokes a Slack bot token connection', async () => {
    const input = createInput({
      providerKey: 'slack',
      authType: CONNECTION_AUTH_TYPE.slackBotToken,
      name: `Slack ${randomUUID().slice(0, 8)}`,
    });
    const created = await connections.api.createConnection(input);
    expect(created).toMatchObject({
      providerKey: 'slack',
      authType: 'slack_bot_token',
      status: 'active',
    });

    const resolved = await connections.worker.resolveConnectionSecret({
      workspaceId: workspaceA,
      connectionId: created.id,
      expectedProviderKey: 'slack',
      workerId: 'slack-worker',
      purpose: 'slack.send_message.execute',
    });
    expect(resolved).toMatchObject({ secretVersionId: input.secretVersionId });
    await connections.worker.assertConnectionSecretCurrent({
      workspaceId: workspaceA,
      connectionId: created.id,
      expectedProviderKey: 'slack',
      expectedAuthType: CONNECTION_AUTH_TYPE.slackBotToken,
      secretVersionId: input.secretVersionId,
    });

    const nextVersion = randomUUID();
    const rotated = await connections.api.rotateConnectionSecret({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: created.id,
      expectedCurrentSecretVersionId: input.secretVersionId,
      expectedAuthType: CONNECTION_AUTH_TYPE.slackBotToken,
      secretVersionId: nextVersion,
      sealed: sealed(9),
      idempotencyKey: `rotate-slack-${created.id}`,
      requestHash: createHash('sha256')
        .update(`rotate:${created.id}`)
        .digest('hex'),
    });
    expect(rotated.currentSecretVersionId).toBe(nextVersion);
    await expect(
      connections.worker.assertConnectionSecretCurrent({
        workspaceId: workspaceA,
        connectionId: created.id,
        expectedProviderKey: 'slack',
        expectedAuthType: CONNECTION_AUTH_TYPE.slackBotToken,
        secretVersionId: input.secretVersionId,
      }),
    ).rejects.toBeInstanceOf(ConnectionUnavailableError);

    await connections.api.revokeConnection({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: created.id,
    });
    await expect(
      connections.worker.resolveConnectionSecret({
        workspaceId: workspaceA,
        connectionId: created.id,
        expectedProviderKey: 'slack',
        workerId: 'slack-worker',
        purpose: 'slack.send_message.execute',
      }),
    ).rejects.toBeInstanceOf(ConnectionUnavailableError);

    const owner = new Pool({ connectionString: databaseUrl(migrationBaseUrl) });
    let ownerClient: PoolClient | undefined;
    let auditRows: { event_type: string }[] = [];
    try {
      ownerClient = await owner.connect();
      await ownerClient.query('begin');
      await ownerClient.query('set local role pertexo_owner');
      await ownerClient.query(
        "select set_config('app.workspace_id', $1, true)",
        [workspaceA],
      );
      const audit = await ownerClient.query<{ event_type: string }>(
        `select event_type from app.connection_events
         where workspace_id=$1 and connection_id=$2 order by created_at,id`,
        [workspaceA, created.id],
      );
      auditRows = audit.rows;
    } finally {
      await ownerClient?.query('rollback').catch(() => undefined);
      ownerClient?.release();
      await owner.end();
    }
    expect(auditRows.map(({ event_type }) => event_type)).toEqual([
      'connection.created',
      'connection.credential_accessed',
      'connection.secret_rotated',
      'connection.revoked',
    ]);
  });

  it('creates, resolves, fences, rotates, and revokes a Resend sending connection', async () => {
    const input = createInput({
      providerKey: 'email',
      authType: CONNECTION_AUTH_TYPE.resendApiKey,
      name: `Email ${randomUUID().slice(0, 8)}`,
    });
    const created = await connections.api.createConnection(input);
    expect(created).toMatchObject({
      providerKey: 'email',
      authType: 'resend_api_key',
      status: 'active',
    });
    await connections.worker.resolveConnectionSecret({
      workspaceId: workspaceA,
      connectionId: created.id,
      expectedProviderKey: 'email',
      workerId: 'email-worker',
      purpose: 'email.send_notification.execute',
    });
    await connections.worker.assertConnectionSecretCurrent({
      workspaceId: workspaceA,
      connectionId: created.id,
      expectedProviderKey: 'email',
      expectedAuthType: CONNECTION_AUTH_TYPE.resendApiKey,
      secretVersionId: input.secretVersionId,
    });
    const nextVersion = randomUUID();
    await connections.api.rotateConnectionSecret({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: created.id,
      expectedCurrentSecretVersionId: input.secretVersionId,
      expectedAuthType: CONNECTION_AUTH_TYPE.resendApiKey,
      secretVersionId: nextVersion,
      sealed: sealed(10),
      idempotencyKey: `rotate-email-${created.id}`,
      requestHash: createHash('sha256')
        .update(`rotate-email:${created.id}`)
        .digest('hex'),
    });
    await expect(
      connections.worker.assertConnectionSecretCurrent({
        workspaceId: workspaceA,
        connectionId: created.id,
        expectedProviderKey: 'email',
        expectedAuthType: CONNECTION_AUTH_TYPE.resendApiKey,
        secretVersionId: input.secretVersionId,
      }),
    ).rejects.toBeInstanceOf(ConnectionUnavailableError);
    await connections.api.revokeConnection({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: created.id,
    });
    await expect(
      connections.worker.resolveConnectionSecret({
        workspaceId: workspaceA,
        connectionId: created.id,
        expectedProviderKey: 'email',
        workerId: 'email-worker',
        purpose: 'email.send_notification.execute',
      }),
    ).rejects.toBeInstanceOf(ConnectionUnavailableError);
  });

  it('rejects conflicting idempotency and active provider/name reuse without partial rows', async () => {
    const input = createInput();
    await connections.api.createConnection(input);
    await expect(
      connections.api.createConnection({
        ...input,
        requestHash: 'f'.repeat(64),
      }),
    ).rejects.toBeInstanceOf(ConnectionIdempotencyConflictError);

    const duplicate = createInput({ name: input.name });
    await expect(
      connections.api.createConnection(duplicate),
    ).rejects.toBeInstanceOf(ConnectionConflictError);
    const owner = new Pool({ connectionString: databaseUrl(migrationBaseUrl) });
    let client: PoolClient | undefined;
    try {
      client = await owner.connect();
      await client.query('begin');
      await client.query('set local role pertexo_owner');
      await client.query("select set_config('app.workspace_id', $1, true)", [
        workspaceA,
      ]);
      const result = await client.query<{ count: string }>(
        `select count(*)::text as count from app.connection_secret_versions
         where id = $1`,
        [duplicate.secretVersionId],
      );
      expect(result.rows[0]?.count).toBe('0');
      await client.query('commit');
    } finally {
      await client?.query('rollback').catch(() => undefined);
      client?.release();
      await owner.end();
    }
  });
}
