import { describe, expect, it } from 'vitest';

import {
  CONNECTION_AUTH_TYPE,
  ConnectionConflictError,
  ConnectionIdempotencyConflictError,
  ConnectionSecretVersionConflictError,
  ConnectionUnavailableError,
  Pool,
  api,
  apiBaseUrl,
  createHash,
  createInput,
  databaseUrl,
  migrationBaseUrl,
  ownerA,
  pgCode,
  randomUUID,
  sealed,
  worker,
  workspaceA,
} from './support/connections.integration.support.js';

describe('connection lifecycle persistence', () => {
  it('atomically creates one current immutable secret and replays an exact request', async () => {
    const input = createInput();
    const created = await api.createConnection(input);
    const replayed = await api.createConnection({
      ...input,
      connectionId: randomUUID(),
      secretVersionId: randomUUID(),
      sealed: sealed(2),
    });

    expect(replayed).toEqual(created);
    expect(created).toMatchObject({
      id: input.connectionId,
      workspaceId: workspaceA,
      providerKey: 'http',
      authType: 'http_headers',
      status: 'active',
      currentSecretVersionId: input.secretVersionId,
    });
    expect(JSON.stringify(created)).not.toContain('encrypted');

    const owner = new Pool({ connectionString: databaseUrl(migrationBaseUrl) });
    const client = await owner.connect();
    try {
      await client.query('begin');
      await client.query('set local role pertexo_owner');
      await client.query("select set_config('app.workspace_id', $1, true)", [
        workspaceA,
      ]);
      const result = await client.query<{
        connection_count: string;
        event_count: string;
        secret_count: string;
        plaintext_columns: string;
      }>(
        `select
           (select count(*)::text from app.connections where id = $1) as connection_count,
           (select count(*)::text from app.connection_secret_versions where connection_id = $1) as secret_count,
           (select count(*)::text from app.connection_events where connection_id = $1) as event_count,
           (select count(*)::text from information_schema.columns
             where table_schema = 'app'
               and table_name = 'connection_secret_versions'
               and column_name ~ '(plaintext|credential|secret_value)') as plaintext_columns`,
        [input.connectionId],
      );
      expect(result.rows[0]).toEqual({
        connection_count: '1',
        event_count: '1',
        secret_count: '1',
        plaintext_columns: '0',
      });
      await client.query('commit');
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
      await owner.end();
    }
  });

  it('creates, resolves, fences, rotates, audits, and revokes a Slack bot token connection', async () => {
    const input = createInput({
      providerKey: 'slack',
      authType: CONNECTION_AUTH_TYPE.slackBotToken,
      name: `Slack ${randomUUID().slice(0, 8)}`,
    });
    const created = await api.createConnection(input);
    expect(created).toMatchObject({
      providerKey: 'slack',
      authType: 'slack_bot_token',
      status: 'active',
    });

    const resolved = await worker.resolveConnectionSecret({
      workspaceId: workspaceA,
      connectionId: created.id,
      expectedProviderKey: 'slack',
      workerId: 'slack-worker',
      purpose: 'slack.send_message.execute',
    });
    expect(resolved).toMatchObject({ secretVersionId: input.secretVersionId });
    await worker.assertConnectionSecretCurrent({
      workspaceId: workspaceA,
      connectionId: created.id,
      expectedProviderKey: 'slack',
      expectedAuthType: CONNECTION_AUTH_TYPE.slackBotToken,
      secretVersionId: input.secretVersionId,
    });

    const nextVersion = randomUUID();
    const rotated = await api.rotateConnectionSecret({
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
      worker.assertConnectionSecretCurrent({
        workspaceId: workspaceA,
        connectionId: created.id,
        expectedProviderKey: 'slack',
        expectedAuthType: CONNECTION_AUTH_TYPE.slackBotToken,
        secretVersionId: input.secretVersionId,
      }),
    ).rejects.toBeInstanceOf(ConnectionUnavailableError);

    await api.revokeConnection({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: created.id,
    });
    await expect(
      worker.resolveConnectionSecret({
        workspaceId: workspaceA,
        connectionId: created.id,
        expectedProviderKey: 'slack',
        workerId: 'slack-worker',
        purpose: 'slack.send_message.execute',
      }),
    ).rejects.toBeInstanceOf(ConnectionUnavailableError);

    const owner = new Pool({ connectionString: databaseUrl(migrationBaseUrl) });
    const ownerClient = await owner.connect();
    await ownerClient.query('begin');
    await ownerClient.query('set local role pertexo_owner');
    await ownerClient.query("select set_config('app.workspace_id', $1, true)", [
      workspaceA,
    ]);
    const audit = await ownerClient.query<{ event_type: string }>(
      `select event_type from app.connection_events
       where workspace_id=$1 and connection_id=$2 order by created_at,id`,
      [workspaceA, created.id],
    );
    await ownerClient.query('rollback');
    ownerClient.release();
    await owner.end();
    expect(audit.rows.map(({ event_type }) => event_type)).toEqual([
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
    const created = await api.createConnection(input);
    expect(created).toMatchObject({
      providerKey: 'email',
      authType: 'resend_api_key',
      status: 'active',
    });
    await worker.resolveConnectionSecret({
      workspaceId: workspaceA,
      connectionId: created.id,
      expectedProviderKey: 'email',
      workerId: 'email-worker',
      purpose: 'email.send_notification.execute',
    });
    await worker.assertConnectionSecretCurrent({
      workspaceId: workspaceA,
      connectionId: created.id,
      expectedProviderKey: 'email',
      expectedAuthType: CONNECTION_AUTH_TYPE.resendApiKey,
      secretVersionId: input.secretVersionId,
    });
    const nextVersion = randomUUID();
    await api.rotateConnectionSecret({
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
      worker.assertConnectionSecretCurrent({
        workspaceId: workspaceA,
        connectionId: created.id,
        expectedProviderKey: 'email',
        expectedAuthType: CONNECTION_AUTH_TYPE.resendApiKey,
        secretVersionId: input.secretVersionId,
      }),
    ).rejects.toBeInstanceOf(ConnectionUnavailableError);
    await api.revokeConnection({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: created.id,
    });
    await expect(
      worker.resolveConnectionSecret({
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
    await api.createConnection(input);
    await expect(
      api.createConnection({
        ...input,
        requestHash: 'f'.repeat(64),
      }),
    ).rejects.toBeInstanceOf(ConnectionIdempotencyConflictError);

    const duplicate = createInput({ name: input.name });
    await expect(api.createConnection(duplicate)).rejects.toBeInstanceOf(
      ConnectionConflictError,
    );
    const owner = new Pool({ connectionString: databaseUrl(migrationBaseUrl) });
    const client = await owner.connect();
    try {
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
      await client.query('rollback').catch(() => undefined);
      client.release();
      await owner.end();
    }
  });

  it('uses a compare-and-swap rotation and rejects cross-connection pointers', async () => {
    const first = createInput();
    const second = createInput();
    const createdFirst = await api.createConnection(first);
    await api.createConnection(second);
    const nextSecretVersionId = randomUUID();
    const rotated = await api.rotateConnectionSecret({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: first.connectionId,
      expectedCurrentSecretVersionId: first.secretVersionId,
      secretVersionId: nextSecretVersionId,
      sealed: sealed(3),
      idempotencyKey: `rotate-${nextSecretVersionId}`,
      requestHash: '3'.repeat(64),
    });
    expect(rotated.currentSecretVersionId).toBe(nextSecretVersionId);
    await expect(
      api.findConnectionCreateReplay({
        workspaceId: workspaceA,
        actorId: ownerA,
        idempotencyKey: first.idempotencyKey,
        requestHash: first.requestHash,
      }),
    ).resolves.toEqual(createdFirst);
    await expect(
      api.findConnectionRotateReplay({
        workspaceId: workspaceA,
        actorId: ownerA,
        connectionId: first.connectionId,
        idempotencyKey: `rotate-${nextSecretVersionId}`,
        requestHash: '3'.repeat(64),
      }),
    ).resolves.toEqual(rotated);
    await expect(
      api.findConnectionRotateReplay({
        workspaceId: workspaceA,
        actorId: ownerA,
        connectionId: first.connectionId,
        idempotencyKey: `rotate-${nextSecretVersionId}`,
        requestHash: '8'.repeat(64),
      }),
    ).rejects.toBeInstanceOf(ConnectionIdempotencyConflictError);
    await expect(
      api.rotateConnectionSecret({
        workspaceId: workspaceA,
        actorId: ownerA,
        connectionId: first.connectionId,
        expectedCurrentSecretVersionId: first.secretVersionId,
        secretVersionId: randomUUID(),
        sealed: sealed(9),
        idempotencyKey: `rotate-${nextSecretVersionId}`,
        requestHash: '3'.repeat(64),
      }),
    ).resolves.toEqual(rotated);
    await expect(
      api.rotateConnectionSecret({
        workspaceId: workspaceA,
        actorId: ownerA,
        connectionId: first.connectionId,
        expectedCurrentSecretVersionId: first.secretVersionId,
        secretVersionId: randomUUID(),
        sealed: sealed(8),
        idempotencyKey: `rotate-${nextSecretVersionId}`,
        requestHash: '8'.repeat(64),
      }),
    ).rejects.toBeInstanceOf(ConnectionIdempotencyConflictError);
    await expect(
      api.rotateConnectionSecret({
        workspaceId: workspaceA,
        actorId: ownerA,
        connectionId: first.connectionId,
        expectedCurrentSecretVersionId: first.secretVersionId,
        secretVersionId: randomUUID(),
        sealed: sealed(4),
        idempotencyKey: `rotate-stale-${first.connectionId}`,
        requestHash: '4'.repeat(64),
      }),
    ).rejects.toBeInstanceOf(ConnectionSecretVersionConflictError);
    await api.rotateConnectionSecret({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: first.connectionId,
      expectedCurrentSecretVersionId: nextSecretVersionId,
      secretVersionId: randomUUID(),
      sealed: sealed(5),
      idempotencyKey: `rotate-later-${first.connectionId}`,
      requestHash: '5'.repeat(64),
    });
    await expect(
      api.findConnectionRotateReplay({
        workspaceId: workspaceA,
        actorId: ownerA,
        connectionId: first.connectionId,
        idempotencyKey: `rotate-${nextSecretVersionId}`,
        requestHash: '3'.repeat(64),
      }),
    ).resolves.toEqual(rotated);

    const pool = new Pool({ connectionString: databaseUrl(apiBaseUrl) });
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query("select set_config('app.workspace_id', $1, true)", [
        workspaceA,
      ]);
      await client.query(
        `update app.connections set current_secret_version_id = $1
         where id = $2`,
        [second.secretVersionId, first.connectionId],
      );
      await expect(client.query('commit')).rejects.toSatisfy(pgCode('23503'));
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
      await pool.end();
    }
  });

  it('resolves only the active exact-provider current secret and audits worker access', async () => {
    const input = createInput();
    await api.createConnection(input);
    const resolved = await worker.resolveConnectionSecret({
      workspaceId: workspaceA,
      connectionId: input.connectionId,
      expectedProviderKey: 'http',
      workerId: 'worker-connection-test',
      purpose: 'http.request.execute',
      traceId: 'trace-worker',
    });
    expect(resolved).toMatchObject({
      connection: { id: input.connectionId, status: 'active' },
      secretVersionId: input.secretVersionId,
      sealed: input.sealed,
    });
    await expect(
      worker.assertConnectionSecretCurrent({
        workspaceId: workspaceA,
        connectionId: input.connectionId,
        expectedProviderKey: 'http',
        expectedAuthType: CONNECTION_AUTH_TYPE.httpHeaders,
        secretVersionId: input.secretVersionId,
      }),
    ).resolves.toBeUndefined();
    await expect(
      worker.assertConnectionSecretCurrent({
        workspaceId: workspaceA,
        connectionId: input.connectionId,
        expectedProviderKey: 'http',
        expectedAuthType: CONNECTION_AUTH_TYPE.httpHeaders,
        secretVersionId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(ConnectionUnavailableError);
    await expect(
      worker.resolveConnectionSecret({
        workspaceId: workspaceA,
        connectionId: input.connectionId,
        expectedProviderKey: 'slack',
        workerId: 'worker-connection-test',
        purpose: 'http.request.execute',
      }),
    ).rejects.toBeInstanceOf(ConnectionUnavailableError);

    await api.revokeConnection({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: input.connectionId,
    });
    await expect(
      worker.resolveConnectionSecret({
        workspaceId: workspaceA,
        connectionId: input.connectionId,
        expectedProviderKey: 'http',
        workerId: 'worker-connection-test',
        purpose: 'http.request.execute',
      }),
    ).rejects.toBeInstanceOf(ConnectionUnavailableError);
    await expect(
      worker.assertConnectionSecretCurrent({
        workspaceId: workspaceA,
        connectionId: input.connectionId,
        expectedProviderKey: 'http',
        expectedAuthType: CONNECTION_AUTH_TYPE.httpHeaders,
        secretVersionId: input.secretVersionId,
      }),
    ).rejects.toBeInstanceOf(ConnectionUnavailableError);
  });

  it('records bounded health truth and reauthorization state through worker grants', async () => {
    const input = createInput();
    await api.createConnection(input);
    const healthy = await worker.recordConnectionHealth({
      workspaceId: workspaceA,
      connectionId: input.connectionId,
      actorKind: 'worker',
      actorId: 'worker-connection-test',
      result: { ok: true },
    });
    expect(healthy.lastHealthyAt).toBeInstanceOf(Date);
    expect(healthy.lastErrorCode).toBeNull();
    const failed = await worker.recordConnectionHealth({
      workspaceId: workspaceA,
      connectionId: input.connectionId,
      actorKind: 'worker',
      actorId: 'worker-connection-test',
      result: {
        ok: false,
        errorCode: 'connection.credential_rejected',
        reauthorizationRequired: true,
      },
    });
    expect(failed).toMatchObject({
      status: 'reauthorization_required',
      lastErrorCode: 'connection.credential_rejected',
    });
  });
});
