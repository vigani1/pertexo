import { expect, it } from 'vitest';

import {
  createNodeAttemptRunStore,
  NodeAttemptStateCorruptError,
} from '../../../../src/testing.js';
import {
  asAdmin,
  parseDatabaseConfig,
} from '../../../runs/run-store/fixtures.js';
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
  testHealthConnection,
  withConnectionLock,
  asOwner,
  databaseUrl,
  workerBaseUrl,
  workspaceA,
} from '../run.fixture.js';

export function registerRejectsLegacyPrimarySlotInstead(): void {
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
    ).rejects.toBeInstanceOf(NodeAttemptStateCorruptError);
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
            and exists(select 1 from pg_locks held where held.pid=pg_stat_activity.pid and held.granted and held.relation='app.connections'::regclass and held.mode='RowShareLock')`);
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
}
