import type { PoolClient } from 'pg';
import { expect, it } from 'vitest';
import {
  ConnectionIdempotencyConflictError,
  ConnectionTestInProgressError,
  Pool,
  createHash,
  createInput,
  databaseUrl,
  migrationBaseUrl,
  ownerA,
  randomUUID,
  workspaceA,
} from '../../support/connections.js';
import { connections } from './fixture.js';

export function registerDurablyOwnsMarksCompletesExactly(): void {
  it('durably owns, marks, completes, and exactly replays a safe connection test', async () => {
    const input = createInput();
    await connections.api.createConnection(input);
    const idempotencyKey = `test-${input.connectionId}`;
    const requestHash = createHash('sha256')
      .update('https://provider.example.test/health')
      .digest('hex');
    const dispatchToken = randomUUID();
    const started = await connections.api.startConnectionTest({
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
    const resolved = await connections.api.resolveConnectionTestSecret({
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
      connections.api.startConnectionTest({
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
      connections.api.startConnectionTest({
        workspaceId: workspaceA,
        actorId: ownerA,
        connectionId: input.connectionId,
        expectedProviderKey: 'http',
        idempotencyKey,
        requestHash: 'f'.repeat(64),
        dispatchToken: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(ConnectionIdempotencyConflictError);

    await connections.api.markConnectionTestDispatched({
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
    await expect(
      connections.api.markConnectionTestDispatched({
        workspaceId: workspaceA,
        actorId: ownerA,
        connectionId: input.connectionId,
        idempotencyKey,
        requestHash,
        dispatchToken,
        secretVersionId: input.secretVersionId,
      }),
    ).rejects.toBeInstanceOf(ConnectionTestInProgressError);
    await expect(
      connections.api.completeConnectionTest({
        workspaceId: workspaceA,
        actorId: ownerA,
        connectionId: input.connectionId,
        idempotencyKey,
        requestHash,
        dispatchToken,
        secretVersionId: randomUUID(),
        outcome: { ok: true, httpStatus: 204 },
      }),
    ).rejects.toBeInstanceOf(ConnectionTestInProgressError);
    const completed = await connections.api.completeConnectionTest({
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
      connections.api.startConnectionTest({
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
    let client: PoolClient | undefined;
    try {
      client = await owner.connect();
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
      await client?.query('rollback').catch(() => undefined);
      client?.release();
      await owner.end();
    }
  });
}
