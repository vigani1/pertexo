import type { PoolClient } from 'pg';
import { expect, it } from 'vitest';
import {
  CONNECTION_AUTH_TYPE,
  ConnectionIdempotencyConflictError,
  ConnectionSecretVersionConflictError,
  ConnectionUnavailableError,
  Pool,
  apiBaseUrl,
  createInput,
  databaseUrl,
  ownerA,
  pgCode,
  randomUUID,
  sealed,
  workspaceA,
} from '../../support/connections.js';
import { connections } from './fixture.js';

export function registerUsesCompareSwapRotationRejects(): void {
  it('uses a compare-and-swap rotation and rejects cross-connection pointers', async () => {
    const first = createInput();
    const second = createInput();
    const createdFirst = await connections.api.createConnection(first);
    await connections.api.createConnection(second);
    const nextSecretVersionId = randomUUID();
    const rotated = await connections.api.rotateConnectionSecret({
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
      connections.api.findConnectionCreateReplay({
        workspaceId: workspaceA,
        actorId: ownerA,
        idempotencyKey: first.idempotencyKey,
        requestHash: first.requestHash,
      }),
    ).resolves.toEqual(createdFirst);
    await expect(
      connections.api.findConnectionRotateReplay({
        workspaceId: workspaceA,
        actorId: ownerA,
        connectionId: first.connectionId,
        idempotencyKey: `rotate-${nextSecretVersionId}`,
        requestHash: '3'.repeat(64),
      }),
    ).resolves.toEqual(rotated);
    await expect(
      connections.api.findConnectionRotateReplay({
        workspaceId: workspaceA,
        actorId: ownerA,
        connectionId: first.connectionId,
        idempotencyKey: `rotate-${nextSecretVersionId}`,
        requestHash: '8'.repeat(64),
      }),
    ).rejects.toBeInstanceOf(ConnectionIdempotencyConflictError);
    await expect(
      connections.api.rotateConnectionSecret({
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
      connections.api.rotateConnectionSecret({
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
      connections.api.rotateConnectionSecret({
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
    await connections.api.rotateConnectionSecret({
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
      connections.api.findConnectionRotateReplay({
        workspaceId: workspaceA,
        actorId: ownerA,
        connectionId: first.connectionId,
        idempotencyKey: `rotate-${nextSecretVersionId}`,
        requestHash: '3'.repeat(64),
      }),
    ).resolves.toEqual(rotated);

    const pool = new Pool({ connectionString: databaseUrl(apiBaseUrl) });
    let client: PoolClient | undefined;
    try {
      client = await pool.connect();
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
      await client?.query('rollback').catch(() => undefined);
      client?.release();
      await pool.end();
    }
  });

  it('resolves only the active exact-provider current secret and audits worker access', async () => {
    const input = createInput();
    await connections.api.createConnection(input);
    const resolved = await connections.worker.resolveConnectionSecret({
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
      connections.worker.assertConnectionSecretCurrent({
        workspaceId: workspaceA,
        connectionId: input.connectionId,
        expectedProviderKey: 'http',
        expectedAuthType: CONNECTION_AUTH_TYPE.httpHeaders,
        secretVersionId: input.secretVersionId,
      }),
    ).resolves.toBeUndefined();
    await expect(
      connections.worker.assertConnectionSecretCurrent({
        workspaceId: workspaceA,
        connectionId: input.connectionId,
        expectedProviderKey: 'http',
        expectedAuthType: CONNECTION_AUTH_TYPE.httpHeaders,
        secretVersionId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(ConnectionUnavailableError);
    await expect(
      connections.worker.resolveConnectionSecret({
        workspaceId: workspaceA,
        connectionId: input.connectionId,
        expectedProviderKey: 'slack',
        workerId: 'worker-connection-test',
        purpose: 'http.request.execute',
      }),
    ).rejects.toBeInstanceOf(ConnectionUnavailableError);

    await connections.api.revokeConnection({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: input.connectionId,
    });
    await expect(
      connections.worker.resolveConnectionSecret({
        workspaceId: workspaceA,
        connectionId: input.connectionId,
        expectedProviderKey: 'http',
        workerId: 'worker-connection-test',
        purpose: 'http.request.execute',
      }),
    ).rejects.toBeInstanceOf(ConnectionUnavailableError);
    await expect(
      connections.worker.assertConnectionSecretCurrent({
        workspaceId: workspaceA,
        connectionId: input.connectionId,
        expectedProviderKey: 'http',
        expectedAuthType: CONNECTION_AUTH_TYPE.httpHeaders,
        secretVersionId: input.secretVersionId,
      }),
    ).rejects.toBeInstanceOf(ConnectionUnavailableError);
  });
}
