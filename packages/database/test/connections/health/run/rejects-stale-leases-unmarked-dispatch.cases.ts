import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import { NodeAttemptReconciliationRequiredError } from '../../../../src/testing.js';

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
  asOwner,
  workspaceA,
  createHealthDispatcher,
  readAcceptedHealthExecution,
  withHealthWriteFailure,
} from '../run.fixture.js';
import { NodeAttemptStateCorruptError } from '../../../../src/attempts/errors.js';

export function registerRejectsStaleLeasesUnmarkedDispatch(): void {
  it('rejects stale leases and unmarked dispatch without committing evidence/outcome', async () => {
    const connection = await createHealthConnection();
    const lease = await claimHealthAttempt(connection);
    await expect(
      nodeAttemptStore.complete(healthCompletion(lease)),
    ).rejects.toBeInstanceOf(NodeAttemptStateCorruptError);
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
    await expect(markHealthDispatched(lease, other)).rejects.toThrow(
      'Connection dispatch published binding mismatch',
    );
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
}
