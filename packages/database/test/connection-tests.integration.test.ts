import { describe, expect, it } from 'vitest';

import {
  ConnectionIdempotencyConflictError,
  ConnectionTestInProgressError,
  ConnectionUnavailableError,
  Pool,
  api,
  createHash,
  createInput,
  databaseUrl,
  migrationBaseUrl,
  ownerA,
  randomUUID,
  sealed,
  workspaceA,
} from './support/connections.integration.support.js';

describe('connection test ownership', () => {
  it('durably owns, marks, completes, and exactly replays a safe connection test', async () => {
    const input = createInput();
    await api.createConnection(input);
    const idempotencyKey = `test-${input.connectionId}`;
    const requestHash = createHash('sha256')
      .update('https://provider.example.test/health')
      .digest('hex');
    const dispatchToken = randomUUID();
    const started = await api.startConnectionTest({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: input.connectionId,
      expectedProviderKey: 'http',
      idempotencyKey,
      requestHash,
      dispatchToken,
      requestId: 'request-connection-test',
      traceId: 'trace-connection-test',
    });
    expect(started).toMatchObject({
      kind: 'dispatch',
      dispatchToken,
    });
    const resolved = await api.resolveConnectionTestSecret({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: input.connectionId,
      expectedProviderKey: 'http',
      idempotencyKey,
      requestHash,
      dispatchToken,
      requestId: 'request-connection-test',
      traceId: 'trace-connection-test',
    });
    expect(resolved).toMatchObject({
      connection: { id: input.connectionId },
      secretVersionId: input.secretVersionId,
      sealed: input.sealed,
    });
    await expect(
      api.startConnectionTest({
        workspaceId: workspaceA,
        actorId: ownerA,
        connectionId: input.connectionId,
        expectedProviderKey: 'http',
        idempotencyKey,
        requestHash,
        dispatchToken: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(ConnectionTestInProgressError);
    await expect(
      api.startConnectionTest({
        workspaceId: workspaceA,
        actorId: ownerA,
        connectionId: input.connectionId,
        expectedProviderKey: 'http',
        idempotencyKey,
        requestHash: 'f'.repeat(64),
        dispatchToken: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(ConnectionIdempotencyConflictError);

    await api.markConnectionTestDispatched({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: input.connectionId,
      idempotencyKey,
      requestHash,
      dispatchToken,
      secretVersionId: input.secretVersionId,
      requestId: 'request-connection-test',
      traceId: 'trace-connection-test',
    });
    const completed = await api.completeConnectionTest({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: input.connectionId,
      idempotencyKey,
      requestHash,
      dispatchToken,
      secretVersionId: input.secretVersionId,
      outcome: { ok: true, httpStatus: 204 },
      requestId: 'request-connection-test',
      traceId: 'trace-connection-test',
    });
    expect(completed).toMatchObject({
      connection: {
        id: input.connectionId,
        status: 'active',
        lastErrorCode: null,
      },
      outcome: { ok: true, httpStatus: 204 },
    });
    expect(completed.connection.lastHealthyAt).toBeInstanceOf(Date);
    await expect(
      api.startConnectionTest({
        workspaceId: workspaceA,
        actorId: ownerA,
        connectionId: input.connectionId,
        expectedProviderKey: 'http',
        idempotencyKey,
        requestHash,
        dispatchToken: randomUUID(),
      }),
    ).resolves.toEqual({ kind: 'replay', result: completed });

    const owner = new Pool({ connectionString: databaseUrl(migrationBaseUrl) });
    const client = await owner.connect();
    try {
      await client.query('begin');
      await client.query('set local role pertexo_owner');
      await client.query("select set_config('app.workspace_id', $1, true)", [
        workspaceA,
      ]);
      const evidence = await client.query<{
        credential_accesses: string;
        dispatch_audits: string;
        succeeded_events: string;
      }>(
        `select
           (select count(*)::text from app.connection_events
             where connection_id = $1
               and event_type = 'connection.credential_accessed')
             as credential_accesses,
           (select count(*)::text from app.connection_events
             where connection_id = $1
               and event_type = 'connection.test_succeeded')
             as succeeded_events,
           (select count(*)::text from app.audit_events
             where target_id = $1 and action = 'connection.test_dispatched')
             as dispatch_audits`,
        [input.connectionId],
      );
      expect(evidence.rows[0]).toEqual({
        credential_accesses: '1',
        dispatch_audits: '1',
        succeeded_events: '1',
      });
      await client.query('commit');
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
      await owner.end();
    }
  });

  it('releases a pre-dispatch failure and never revives health after a revocation race', async () => {
    const input = createInput();
    await api.createConnection(input);
    const requestHash = 'a'.repeat(64);
    const idempotencyKey = `test-failure-${input.connectionId}`;
    const firstToken = randomUUID();
    await api.startConnectionTest({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: input.connectionId,
      expectedProviderKey: 'http',
      idempotencyKey,
      requestHash,
      dispatchToken: firstToken,
    });
    await api.abandonConnectionTest({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: input.connectionId,
      idempotencyKey,
      requestHash,
      dispatchToken: firstToken,
    });
    const secondToken = randomUUID();
    await expect(
      api.startConnectionTest({
        workspaceId: workspaceA,
        actorId: ownerA,
        connectionId: input.connectionId,
        expectedProviderKey: 'http',
        idempotencyKey,
        requestHash,
        dispatchToken: secondToken,
      }),
    ).resolves.toMatchObject({ kind: 'dispatch', dispatchToken: secondToken });
    await api.resolveConnectionTestSecret({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: input.connectionId,
      expectedProviderKey: 'http',
      idempotencyKey,
      requestHash,
      dispatchToken: secondToken,
    });
    await api.markConnectionTestDispatched({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: input.connectionId,
      idempotencyKey,
      requestHash,
      dispatchToken: secondToken,
      secretVersionId: input.secretVersionId,
    });
    await api.revokeConnection({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: input.connectionId,
    });
    const completed = await api.completeConnectionTest({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: input.connectionId,
      idempotencyKey,
      requestHash,
      dispatchToken: secondToken,
      secretVersionId: input.secretVersionId,
      outcome: { ok: true, httpStatus: 200 },
    });
    expect(completed.connection).toMatchObject({
      status: 'revoked',
      lastHealthyAt: null,
    });

    const revokedBeforeResolution = createInput();
    await api.createConnection(revokedBeforeResolution);
    const revokedToken = randomUUID();
    const revokedKey = `test-revoked-${revokedBeforeResolution.connectionId}`;
    await api.startConnectionTest({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: revokedBeforeResolution.connectionId,
      expectedProviderKey: 'http',
      idempotencyKey: revokedKey,
      requestHash,
      dispatchToken: revokedToken,
    });
    await api.revokeConnection({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: revokedBeforeResolution.connectionId,
    });
    await expect(
      api.resolveConnectionTestSecret({
        workspaceId: workspaceA,
        actorId: ownerA,
        connectionId: revokedBeforeResolution.connectionId,
        expectedProviderKey: 'http',
        idempotencyKey: revokedKey,
        requestHash,
        dispatchToken: revokedToken,
      }),
    ).rejects.toBeInstanceOf(ConnectionUnavailableError);

    const rotatedAfterDispatch = createInput();
    await api.createConnection(rotatedAfterDispatch);
    const rotatedToken = randomUUID();
    const rotatedKey = `test-rotated-${rotatedAfterDispatch.connectionId}`;
    await api.startConnectionTest({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: rotatedAfterDispatch.connectionId,
      expectedProviderKey: 'http',
      idempotencyKey: rotatedKey,
      requestHash,
      dispatchToken: rotatedToken,
    });
    await api.resolveConnectionTestSecret({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: rotatedAfterDispatch.connectionId,
      expectedProviderKey: 'http',
      idempotencyKey: rotatedKey,
      requestHash,
      dispatchToken: rotatedToken,
    });
    await api.markConnectionTestDispatched({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: rotatedAfterDispatch.connectionId,
      idempotencyKey: rotatedKey,
      requestHash,
      dispatchToken: rotatedToken,
      secretVersionId: rotatedAfterDispatch.secretVersionId,
    });
    await api.abandonConnectionTest({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: rotatedAfterDispatch.connectionId,
      idempotencyKey: rotatedKey,
      requestHash,
      dispatchToken: rotatedToken,
    });
    const owner = new Pool({ connectionString: databaseUrl(migrationBaseUrl) });
    try {
      await owner.query('begin');
      await owner.query('set local role pertexo_owner');
      await owner.query("select set_config('app.workspace_id',$1,true)", [
        workspaceA,
      ]);
      await owner.query(
        `update app.idempotency_records
         set updated_at=clock_timestamp()-interval '25 hours'
         where workspace_id=$1 and operation='connection.test'
           and resource_id=$2 and result_ref->>'state'='dispatched'`,
        [workspaceA, rotatedAfterDispatch.connectionId],
      );
      await owner.query('commit');
    } finally {
      await owner.query('rollback').catch(() => undefined);
      await owner.end();
    }
    await expect(
      api.startConnectionTest({
        workspaceId: workspaceA,
        actorId: ownerA,
        connectionId: rotatedAfterDispatch.connectionId,
        expectedProviderKey: 'http',
        idempotencyKey: rotatedKey,
        requestHash,
        dispatchToken: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(ConnectionTestInProgressError);
    const newSecretVersionId = randomUUID();
    await api.rotateConnectionSecret({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: rotatedAfterDispatch.connectionId,
      expectedCurrentSecretVersionId: rotatedAfterDispatch.secretVersionId,
      secretVersionId: newSecretVersionId,
      sealed: sealed(7),
      idempotencyKey: `rotate-during-test-${rotatedAfterDispatch.connectionId}`,
      requestHash: '7'.repeat(64),
    });
    const staleCompletion = await api.completeConnectionTest({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: rotatedAfterDispatch.connectionId,
      idempotencyKey: rotatedKey,
      requestHash,
      dispatchToken: rotatedToken,
      secretVersionId: rotatedAfterDispatch.secretVersionId,
      outcome: {
        ok: false,
        httpStatus: 401,
        errorCode: 'connection.credential_rejected',
        reauthorizationRequired: true,
      },
    });
    expect(staleCompletion.connection).toMatchObject({
      status: 'active',
      currentSecretVersionId: newSecretVersionId,
      lastTestedAt: null,
      lastErrorCode: null,
    });
  });
});
