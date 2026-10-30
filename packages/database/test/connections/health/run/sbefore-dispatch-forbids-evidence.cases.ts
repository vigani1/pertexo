import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  InboxChecksumMismatchError,
  InboxReceiptUnavailableError,
} from '../../../../src/outbox/index.js';
import { NodeAttemptConnectionFenceError } from '../../../../src/testing.js';
import { actorId } from '../../../runs/run-store/fixtures.js';
import {
  applyHealthCommand,
  claimHealthAttempt,
  countHealthTransitions,
  createHealthConnection,
  healthCommand,
  healthCompletion,
  markHealthDispatched,
  nodeAttemptStore,
  readHealth,
  rotateHealthConnection,
  revokeHealthConnection,
  testHealthConnection,
  asOwner,
  workspaceA,
  withHealthApi,
} from '../run.fixture.js';
import { NodeAttemptStateCorruptError } from '../../../../src/attempts/errors.js';

export function registerSBeforeDispatchForbidsEvidence(): void {
  it.each(['rotate', 'revoke'] as const)(
    '%s before dispatch forbids evidence and does not replace accepted dispatch identity',
    async (mutation) => {
      const connection = await createHealthConnection();
      const lease = await claimHealthAttempt(connection);
      if (mutation === 'rotate') await rotateHealthConnection(connection);
      else await revokeHealthConnection(connection);
      await expect(
        markHealthDispatched(lease, connection),
      ).rejects.toBeInstanceOf(NodeAttemptConnectionFenceError);
      await expect(
        nodeAttemptStore.complete(healthCompletion(lease)),
      ).rejects.toBeInstanceOf(NodeAttemptStateCorruptError);
      const rows = await asOwner(workspaceA, (client) =>
        client.query(
          'select id from app.connection_health_observations where workspace_id=$1 and attempt_id=$2',
          [workspaceA, lease.attemptId],
        ),
      );
      expect(rows.rowCount).toBe(0);
    },
  );

  it.each(['rotate', 'revoke'] as const)(
    '%s after dispatch before completion fences accepted old evidence',
    async (mutation) => {
      const connection = await createHealthConnection();
      const lease = await claimHealthAttempt(connection);
      await markHealthDispatched(lease, connection);
      if (mutation === 'rotate') await rotateHealthConnection(connection);
      else await revokeHealthConnection(connection);
      const expected = await readHealth(connection.connectionId);
      await expect(
        nodeAttemptStore.complete(healthCompletion(lease)),
      ).resolves.toMatchObject({ kind: 'committed' });
      await expect(
        applyHealthCommand(await healthCommand(lease)),
      ).resolves.toEqual({ kind: 'stale' });
      expect(await readHealth(connection.connectionId)).toEqual(expected);
      expect(await countHealthTransitions(connection.connectionId)).toBe(0);
    },
  );

  it('a completion without health evidence records no observation or health command', async () => {
    const connection = await createHealthConnection();
    const lease = await claimHealthAttempt(connection);
    await markHealthDispatched(lease, connection);
    const { connectionHealthObservation: ignored, ...input } = healthCompletion(
      lease,
      'healthy',
    );
    expect(ignored).toEqual({ kind: 'healthy' });
    await expect(nodeAttemptStore.complete(input)).resolves.toMatchObject({
      kind: 'committed',
    });
    const rows = await asOwner(workspaceA, (client) =>
      client.query<{ count: number }>(
        'select count(*)::int count from app.connection_health_observations where workspace_id=$1 and attempt_id=$2',
        [workspaceA, lease.attemptId],
      ),
    );
    expect(rows.rows[0]?.count).toBe(0);
    expect(await readHealth(connection.connectionId)).toMatchObject({
      status: 'active',
      health_revision: '1',
      last_run_observed_at: null,
    });
  });

  it('manual success already dispatched before a newer rejection cannot clear it', async () => {
    const connection = await createHealthConnection();
    const lease = await claimHealthAttempt(connection);
    await markHealthDispatched(lease, connection);
    await testHealthConnection(connection, 'success', async () => {
      await nodeAttemptStore.complete(healthCompletion(lease));
      await applyHealthCommand(await healthCommand(lease));
    });
    expect(await readHealth(connection.connectionId)).toMatchObject({
      status: 'reauthorization_required',
      health_revision: '2',
      last_error_code: 'connection.slack_token_revoked',
      last_tested_at: null,
    });
  });

  it('a pre-dispatch test failure cannot replace a newer run rejection', async () => {
    const connection = await createHealthConnection();
    const common = {
      workspaceId: workspaceA,
      actorId,
      connectionId: connection.connectionId,
      secretVersionId: connection.secretVersionId,
      idempotencyKey: `preflight-${randomUUID()}`,
      dispatchToken: randomUUID(),
      requestHash: 'b'.repeat(64),
    };
    await withHealthApi(async (api) => {
      await api.startConnectionTest({
        ...common,
        expectedProviderKey: 'slack',
      });
      await api.resolveConnectionTestSecret({
        ...common,
        expectedProviderKey: 'slack',
      });
      const lease = await claimHealthAttempt(connection);
      await markHealthDispatched(lease, connection);
      await nodeAttemptStore.complete(healthCompletion(lease));
      await applyHealthCommand(await healthCommand(lease));
      const current = await readHealth(connection.connectionId);
      await api.completeConnectionTest({
        ...common,
        outcome: {
          ok: false,
          httpStatus: null,
          errorCode: 'connection.test.dns_failed',
          reauthorizationRequired: false,
        },
      });
      expect(await readHealth(connection.connectionId)).toEqual(current);
      expect(current).toMatchObject({
        status: 'reauthorization_required',
        last_error_code: 'connection.slack_token_revoked',
        last_tested_at: null,
      });
    });
  });

  it('inconclusive manual test cannot erase authoritative reauthorization evidence', async () => {
    const connection = await createHealthConnection();
    const lease = await claimHealthAttempt(connection);
    await markHealthDispatched(lease, connection);
    await nodeAttemptStore.complete(healthCompletion(lease));
    await applyHealthCommand(await healthCommand(lease));
    await testHealthConnection(connection, 'inconclusive');
    expect(await readHealth(connection.connectionId)).toMatchObject({
      status: 'reauthorization_required',
      health_revision: '2',
      last_error_code: 'connection.slack_token_revoked',
    });
  });

  it('rejects forged observation/checksum before receipt and then applies the authoritative command', async () => {
    const connection = await createHealthConnection();
    const lease = await claimHealthAttempt(connection);
    await markHealthDispatched(lease, connection);
    await nodeAttemptStore.complete(healthCompletion(lease));
    const command = await healthCommand(lease);
    await expect(
      applyHealthCommand({ ...command, observationId: randomUUID() }),
    ).rejects.toBeInstanceOf(InboxReceiptUnavailableError);
    await expect(
      applyHealthCommand({
        ...command,
        delivery: { ...command.delivery, payloadChecksum: 'f'.repeat(64) },
      }),
    ).rejects.toBeInstanceOf(InboxReceiptUnavailableError);
    expect(await readHealth(connection.connectionId)).toMatchObject({
      status: 'active',
      health_revision: '1',
    });
    await expect(applyHealthCommand(command)).resolves.toEqual({
      kind: 'applied',
    });
    await expect(
      applyHealthCommand({
        ...command,
        delivery: { ...command.delivery, payloadChecksum: 'f'.repeat(64) },
      }),
    ).rejects.toBeInstanceOf(InboxChecksumMismatchError);
    expect(await countHealthTransitions(connection.connectionId)).toBe(1);
  });

  it.each(['rotate', 'revoke'] as const)(
    '%s after dispatch/completion makes old evidence an idempotent no-op',
    async (mutation) => {
      const connection = await createHealthConnection();
      const lease = await claimHealthAttempt(connection);
      await markHealthDispatched(lease, connection);
      await nodeAttemptStore.complete(healthCompletion(lease));
      if (mutation === 'rotate') await rotateHealthConnection(connection);
      else await revokeHealthConnection(connection);
      const expected = await readHealth(connection.connectionId);
      const command = await healthCommand(lease);
      await expect(applyHealthCommand(command)).resolves.toEqual({
        kind: 'stale',
      });
      await expect(applyHealthCommand(command)).resolves.toEqual({
        kind: 'duplicate',
      });
      expect(await readHealth(connection.connectionId)).toEqual(expected);
      expect(await countHealthTransitions(connection.connectionId)).toBe(0);
    },
  );
}
