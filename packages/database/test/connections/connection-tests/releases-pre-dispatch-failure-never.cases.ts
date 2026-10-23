import { expect, it } from 'vitest';
import {
  ConnectionTestInProgressError,
  ConnectionUnavailableError,
  Pool,
  createInput,
  databaseUrl,
  migrationBaseUrl,
  ownerA,
  randomUUID,
  sealed,
  workspaceA,
} from '../../support/connections.js';
import { connections } from './fixture.js';

export function registerReleasesPreDispatchFailureNever(): void {
  it('releases a pre-dispatch failure and never revives health after a revocation race', async () => {
    const input = createInput();
    await connections.api.createConnection(input);
    const requestHash = 'a'.repeat(64);
    const idempotencyKey = `test-failure-${input.connectionId}`;
    const firstToken = randomUUID();
    await connections.api.startConnectionTest({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: input.connectionId,
      expectedProviderKey: 'http',
      idempotencyKey,
      requestHash,
      dispatchToken: firstToken,
    });
    await connections.api.abandonConnectionTest({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: input.connectionId,
      idempotencyKey,
      requestHash,
      dispatchToken: firstToken,
    });
    const secondToken = randomUUID();
    await expect(
      connections.api.startConnectionTest({
        workspaceId: workspaceA,
        actorId: ownerA,
        connectionId: input.connectionId,
        expectedProviderKey: 'http',
        idempotencyKey,
        requestHash,
        dispatchToken: secondToken,
      }),
    ).resolves.toMatchObject({ kind: 'dispatch', dispatchToken: secondToken });
    await connections.api.resolveConnectionTestSecret({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: input.connectionId,
      expectedProviderKey: 'http',
      idempotencyKey,
      requestHash,
      dispatchToken: secondToken,
    });
    await connections.api.markConnectionTestDispatched({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: input.connectionId,
      idempotencyKey,
      requestHash,
      dispatchToken: secondToken,
      secretVersionId: input.secretVersionId,
    });
    await connections.api.revokeConnection({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: input.connectionId,
    });
    const completed = await connections.api.completeConnectionTest({
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
    await connections.api.createConnection(revokedBeforeResolution);
    const revokedToken = randomUUID();
    const revokedKey = `test-revoked-${revokedBeforeResolution.connectionId}`;
    await connections.api.startConnectionTest({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: revokedBeforeResolution.connectionId,
      expectedProviderKey: 'http',
      idempotencyKey: revokedKey,
      requestHash,
      dispatchToken: revokedToken,
    });
    await connections.api.revokeConnection({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: revokedBeforeResolution.connectionId,
    });
    await expect(
      connections.api.resolveConnectionTestSecret({
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
    await connections.api.createConnection(rotatedAfterDispatch);
    const rotatedToken = randomUUID();
    const rotatedKey = `test-rotated-${rotatedAfterDispatch.connectionId}`;
    await connections.api.startConnectionTest({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: rotatedAfterDispatch.connectionId,
      expectedProviderKey: 'http',
      idempotencyKey: rotatedKey,
      requestHash,
      dispatchToken: rotatedToken,
    });
    await connections.api.resolveConnectionTestSecret({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: rotatedAfterDispatch.connectionId,
      expectedProviderKey: 'http',
      idempotencyKey: rotatedKey,
      requestHash,
      dispatchToken: rotatedToken,
    });
    await connections.api.markConnectionTestDispatched({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: rotatedAfterDispatch.connectionId,
      idempotencyKey: rotatedKey,
      requestHash,
      dispatchToken: rotatedToken,
      secretVersionId: rotatedAfterDispatch.secretVersionId,
    });
    await connections.api.abandonConnectionTest({
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
      connections.api.startConnectionTest({
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
    await connections.api.rotateConnectionSecret({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: rotatedAfterDispatch.connectionId,
      expectedCurrentSecretVersionId: rotatedAfterDispatch.secretVersionId,
      secretVersionId: newSecretVersionId,
      sealed: sealed(7),
      idempotencyKey: `rotate-during-test-${rotatedAfterDispatch.connectionId}`,
      requestHash: '7'.repeat(64),
    });
    const staleCompletion = await connections.api.completeConnectionTest({
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
}
