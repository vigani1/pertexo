import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  InboxChecksumMismatchError,
  InboxReceiptUnavailableError,
} from '../../../src/outbox/index.js';

import {
  createNodeAttemptRunStore,
  NodeAttemptStateCorruptError,
  NodeAttemptReconciliationRequiredError,
  NodeAttemptConnectionFenceError,
} from '../../../src/testing.js';
import { asAdmin, parseDatabaseConfig } from '../../runs/run-store/fixtures.js';
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
  withConnectionLock,
  asOwner,
  databaseUrl,
  workerBaseUrl,
  workspaceA,
  createHealthDispatcher,
  readAcceptedHealthExecution,
  withHealthWriteFailure,
} from './run-health.fixture.js';

describe('durable revision-fenced Slack run health (ADR059)', () => {
  it('rejects a legacy primary slot instead of the published Slack bot-token contract', async () => {
    const connection = await createHealthConnection('primary');
    const lease = await claimHealthAttempt(connection);
    await expect(markHealthDispatched(lease, connection)).rejects.toThrow(
      'published binding mismatch',
    );
    const state = await asOwner(workspaceA, (client) =>
      client.query<{
        dispatch_marked_at: Date | null;
        dispatch_count: number;
      }>(
        `select attempt.dispatch_marked_at,
        (select count(*)::int from app.node_attempt_connection_dispatches where workspace_id=$1 and attempt_id=$2) dispatch_count
       from app.node_attempts attempt where workspace_id=$1 and id=$2`,
        [workspaceA, lease.attemptId],
      ),
    );
    expect(state.rows[0]).toEqual({
      dispatch_marked_at: null,
      dispatch_count: 0,
    });
    await expect(
      nodeAttemptStore.complete(healthCompletion(lease)),
    ).rejects.toThrow();
    expect(await readHealth(connection.connectionId)).toMatchObject({
      status: 'active',
      health_revision: '1',
    });
  });
  it('accepts completion once and applies from persisted ID after store reopen/redelivery', async () => {
    const connection = await createHealthConnection();
    const lease = await claimHealthAttempt(connection);
    await markHealthDispatched(lease, connection);
    const input = healthCompletion(lease);
    await expect(nodeAttemptStore.complete(input)).resolves.toMatchObject({
      kind: 'committed',
    });
    await expect(nodeAttemptStore.complete(input)).resolves.toMatchObject({
      kind: 'duplicate',
    });
    await expect(
      nodeAttemptStore.complete({
        ...input,
        connectionHealthObservation: { kind: 'healthy' },
      }),
    ).rejects.toBeInstanceOf(NodeAttemptStateCorruptError);
    const command = await healthCommand(lease);
    const reopened = createNodeAttemptRunStore(
      parseDatabaseConfig({ connectionString: databaseUrl(workerBaseUrl) }),
    );
    try {
      await expect(reopened.complete(input)).resolves.toMatchObject({
        kind: 'duplicate',
      });
    } finally {
      await reopened.close();
    }
    expect(await readHealth(connection.connectionId)).toMatchObject({
      status: 'active',
      health_revision: '1',
      last_tested_at: null,
    });
    await expect(applyHealthCommand(command)).resolves.toEqual({
      kind: 'applied',
    });
    await expect(applyHealthCommand(command)).resolves.toEqual({
      kind: 'duplicate',
    });
    expect(await readHealth(connection.connectionId)).toMatchObject({
      status: 'reauthorization_required',
      health_revision: '2',
      last_error_code: 'connection.slack_token_revoked',
      last_tested_at: null,
    });
    expect(await countHealthTransitions(connection.connectionId)).toBe(1);
  });

  it('serializes concurrent rejection under a held connection lock and creates one transition', async () => {
    const connection = await createHealthConnection();
    const first = await claimHealthAttempt(connection);
    const second = await claimHealthAttempt(connection);
    await markHealthDispatched(first, connection);
    await markHealthDispatched(second, connection);
    await nodeAttemptStore.complete(healthCompletion(first));
    await nodeAttemptStore.complete(healthCompletion(second));
    const commands = await Promise.all([
      healthCommand(first),
      healthCommand(second),
    ]);
    const acquired = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const gate = withConnectionLock(connection.connectionId, async () => {
      acquired.resolve(undefined);
      await release.promise;
    });
    await acquired.promise;
    const applications = commands.map((command) => applyHealthCommand(command));
    for (const application of applications)
      void application.catch(() => undefined);
    try {
      await expect
        .poll(async () =>
          asAdmin(async (client) => {
            const waiting = await client.query<{
              count: number;
            }>(`select count(*)::int count from pg_stat_activity
          where datname=current_database() and usename='pertexo_app' and wait_event_type='Lock'
            and query like '%from app.connections%for update%'`);
            return waiting.rows[0]?.count;
          }),
        )
        .toBe(2);
    } finally {
      release.resolve(undefined);
      await gate;
    }
    expect(
      (await Promise.all(applications)).map(({ kind }) => kind).sort(),
    ).toEqual(['applied', 'stale']);
    expect(await countHealthTransitions(connection.connectionId)).toBe(1);
    expect(await readHealth(connection.connectionId)).toMatchObject({
      status: 'reauthorization_required',
      health_revision: '2',
    });
  });

  it('held old success completed after rejection cannot clear the transition', async () => {
    const connection = await createHealthConnection();
    const success = await claimHealthAttempt(connection);
    const rejection = await claimHealthAttempt(connection);
    await markHealthDispatched(success, connection);
    await markHealthDispatched(rejection, connection);
    await nodeAttemptStore.complete(healthCompletion(rejection));
    await applyHealthCommand(await healthCommand(rejection));
    await nodeAttemptStore.complete(healthCompletion(success, 'healthy'));
    await expect(
      applyHealthCommand(await healthCommand(success)),
    ).resolves.toEqual({ kind: 'stale' });
    expect(await readHealth(connection.connectionId)).toMatchObject({
      status: 'reauthorization_required',
      health_revision: '2',
      last_error_code: 'connection.slack_token_revoked',
      last_healthy_at: null,
    });
  });

  it('same-revision success does not suppress a later definitive rejection', async () => {
    const connection = await createHealthConnection();
    const success = await claimHealthAttempt(connection);
    const rejection = await claimHealthAttempt(connection);
    await markHealthDispatched(success, connection);
    await markHealthDispatched(rejection, connection);
    await nodeAttemptStore.complete(healthCompletion(success, 'healthy'));
    await applyHealthCommand(await healthCommand(success));
    expect(await readHealth(connection.connectionId)).toMatchObject({
      status: 'active',
      health_revision: '1',
      last_tested_at: null,
    });
    await nodeAttemptStore.complete(healthCompletion(rejection));
    await expect(
      applyHealthCommand(await healthCommand(rejection)),
    ).resolves.toEqual({ kind: 'applied' });
    expect(await readHealth(connection.connectionId)).toMatchObject({
      status: 'reauthorization_required',
      health_revision: '2',
    });
  });

  it('new manual test recovers all layers and fences an older rejection', async () => {
    const connection = await createHealthConnection();
    const old = await claimHealthAttempt(connection);
    await markHealthDispatched(old, connection);
    const rejection = await claimHealthAttempt(connection);
    await markHealthDispatched(rejection, connection);
    await nodeAttemptStore.complete(healthCompletion(rejection));
    await applyHealthCommand(await healthCommand(rejection));
    await testHealthConnection(connection);
    expect(await readHealth(connection.connectionId)).toMatchObject({
      status: 'active',
      health_revision: '3',
      last_error_code: null,
    });
    await nodeAttemptStore.complete(healthCompletion(old));
    await expect(applyHealthCommand(await healthCommand(old))).resolves.toEqual(
      { kind: 'stale' },
    );
    expect(await readHealth(connection.connectionId)).toMatchObject({
      status: 'active',
      health_revision: '3',
      last_error_code: null,
    });
  });

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
      ).rejects.toThrow();
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

  it('rejects stale leases and unmarked dispatch without committing evidence/outcome', async () => {
    const connection = await createHealthConnection();
    const lease = await claimHealthAttempt(connection);
    await expect(
      nodeAttemptStore.complete(healthCompletion(lease)),
    ).rejects.toThrow();
    await markHealthDispatched(lease, connection);
    await expect(
      nodeAttemptStore.complete(
        healthCompletion({ ...lease, fenceToken: lease.fenceToken + 1 }),
      ),
    ).rejects.toBeInstanceOf(NodeAttemptReconciliationRequiredError);
    const rows = await asOwner(workspaceA, (client) =>
      client.query<{ status: string; count: number }>(
        `select attempt.status,
      (select count(*)::int from app.connection_health_observations where attempt_id=attempt.id) count
      from app.node_attempts attempt where workspace_id=$1 and id=$2`,
        [workspaceA, lease.attemptId],
      ),
    );
    expect(rows.rows[0]).toEqual({ status: 'running', count: 0 });
  });

  it('captures the accepted worker/fence identity and rejects a caller-chosen connection binding', async () => {
    const connection = await createHealthConnection();
    const other = await createHealthConnection();
    const lease = await claimHealthAttempt(connection);
    await expect(markHealthDispatched(lease, other)).rejects.toThrow();
    await markHealthDispatched(lease, connection);
    const dispatched = await asOwner(workspaceA, (client) =>
      client.query<{
        worker_id: string;
        fence_token: string;
        connection_id: string;
        secret_version_id: string;
        health_revision: string;
      }>(
        `select worker_id,fence_token,connection_id,secret_version_id,health_revision
         from app.node_attempt_connection_dispatches where workspace_id=$1 and attempt_id=$2`,
        [workspaceA, lease.attemptId],
      ),
    );
    expect(dispatched.rows[0]).toEqual({
      worker_id: lease.workerId,
      fence_token: String(lease.fenceToken),
      connection_id: connection.connectionId,
      secret_version_id: connection.secretVersionId,
      health_revision: '1',
    });
    await expect(
      nodeAttemptStore.complete(
        healthCompletion({ ...lease, workerId: 'forged-worker' }),
      ),
    ).rejects.toBeInstanceOf(NodeAttemptReconciliationRequiredError);
    await expect(
      nodeAttemptStore.complete(healthCompletion(lease)),
    ).resolves.toMatchObject({ kind: 'committed' });
    await expect(
      applyHealthCommand(await healthCommand(lease)),
    ).resolves.toEqual({ kind: 'applied' });
    expect(await readHealth(other.connectionId)).toMatchObject({
      status: 'active',
      health_revision: '1',
      last_run_observed_at: null,
    });
  });

  it('retries interrupted publication and a failed durable publish mark without replaying accepted execution', async () => {
    const connection = await createHealthConnection();
    const lease = await claimHealthAttempt(connection);
    await markHealthDispatched(lease, connection);
    await nodeAttemptStore.complete(healthCompletion(lease));
    const command = await healthCommand(lease);
    const accepted = await readAcceptedHealthExecution(lease);
    const dispatcher = createHealthDispatcher();
    const deliveries: (typeof command)[] = [];
    let publishCalls = 0;
    const publish = async (payload: unknown) => {
      publishCalls += 1;
      if (publishCalls === 1)
        throw new Error('controlled interrupted publication');
      expect(payload).toEqual({
        schemaVersion: 1,
        workspaceId: command.workspaceId,
        outboxEventId: command.delivery.outboxEventId,
        observationId: command.observationId,
      });
      deliveries.push(command);
      await Promise.resolve();
    };
    const claim = async () => {
      // Fair dispatch leases one row per workspace per round. Earlier cases
      // leave already-asserted commands unpublished; hold those leases while
      // advancing through the bounded fixture backlog to this command.
      for (let round = 0; round < 100; round += 1) {
        const result = await dispatcher.claimBatch({
          enabledJobNames: ['apply-connection-health-observation'],
          leaseDurationMillis: 300_000,
          leaseOwner: 'f30-publication-proof',
          leaseToken: randomUUID(),
          limit: 100,
          maxAttempts: 10,
        });
        const event = result.events.find(
          (row) => row.id === command.delivery.outboxEventId,
        );
        if (event !== undefined) return event;
        if (result.events.length === 0) break;
      }
      throw new Error('Expected authoritative health outbox claim');
    };
    const release = async (event: Awaited<ReturnType<typeof claim>>) => {
      await expect(
        dispatcher.releaseOrFail({
          id: event.id,
          leaseToken: event.leaseToken,
          errorCode: 'queue.publish_failed',
          maxAttempts: 10,
          retryAt: new Date(0),
        }),
      ).resolves.toBe('retry_scheduled');
    };
    try {
      const interrupted = await claim();
      await expect(publish(interrupted.payload)).rejects.toThrow(
        'interrupted publication',
      );
      await release(interrupted);
      const unmarked = await claim();
      await publish(unmarked.payload);
      await withHealthWriteFailure(
        'publication',
        command.delivery.outboxEventId,
        async () => {
          await expect(
            dispatcher.markPublished(unmarked.id, unmarked.leaseToken),
          ).rejects.toThrow('controlled F30 write failure');
        },
      );
      await release(unmarked);
      expect(await readAcceptedHealthExecution(lease)).toEqual(accepted);
      const retried = await claim();
      await publish(retried.payload);
      await expect(
        dispatcher.markPublished(retried.id, retried.leaseToken),
      ).resolves.toBe(true);
      expect(publishCalls).toBe(3);
      expect(deliveries).toHaveLength(2);
      const [firstDelivery, duplicateDelivery] = deliveries;
      if (firstDelivery === undefined || duplicateDelivery === undefined)
        throw new Error('Expected both controlled health deliveries');
      await expect(applyHealthCommand(firstDelivery)).resolves.toEqual({
        kind: 'applied',
      });
      await expect(applyHealthCommand(duplicateDelivery)).resolves.toEqual({
        kind: 'duplicate',
      });
      expect(await countHealthTransitions(connection.connectionId)).toBe(1);
      expect(await readAcceptedHealthExecution(lease)).toEqual(accepted);
    } finally {
      await dispatcher.close();
    }
  });

  it('rolls back failed health application independently of the accepted run outcome and succeeds on redelivery', async () => {
    const connection = await createHealthConnection();
    const lease = await claimHealthAttempt(connection);
    await markHealthDispatched(lease, connection);
    await nodeAttemptStore.complete(healthCompletion(lease));
    const command = await healthCommand(lease);
    const accepted = await readAcceptedHealthExecution(lease);
    const before = await readHealth(connection.connectionId);
    await withHealthWriteFailure(
      'transition',
      connection.connectionId,
      async () => {
        await expect(applyHealthCommand(command)).rejects.toMatchObject({
          cause: { code: '40001', message: 'controlled F30 write failure' },
        });
        expect(await readHealth(connection.connectionId)).toEqual(before);
        expect(await countHealthTransitions(connection.connectionId)).toBe(0);
        const state = await asOwner(workspaceA, (client) =>
          client.query<{ applied_at: Date | null; receipts: number }>(
            `select applied_at,(select count(*)::int from app.inbox_receipts where workspace_id=$1
         and consumer_name='connection-health-worker' and message_id=$3) receipts
         from app.connection_health_observations where workspace_id=$1 and id=$2`,
            [workspaceA, command.observationId, command.delivery.outboxEventId],
          ),
        );
        expect(state.rows[0]).toEqual({ applied_at: null, receipts: 0 });
        expect(await readAcceptedHealthExecution(lease)).toEqual(accepted);
      },
    );
    await expect(applyHealthCommand(command)).resolves.toEqual({
      kind: 'applied',
    });
    await expect(applyHealthCommand(command)).resolves.toEqual({
      kind: 'duplicate',
    });
    expect(await countHealthTransitions(connection.connectionId)).toBe(1);
    expect(await readAcceptedHealthExecution(lease)).toEqual(accepted);
  });
});
