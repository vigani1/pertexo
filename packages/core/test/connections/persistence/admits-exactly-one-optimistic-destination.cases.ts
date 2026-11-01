import { expect, it } from 'vitest';
import {
  Pool,
  createInput,
  databaseUrl,
  migrationBaseUrl,
  ownerA,
  randomUUID,
  workspaceA,
} from '../../support/connections.js';
import { connections } from './fixture.js';

export function registerAdmitsExactlyOneOptimisticDestination(): void {
  it('admits exactly one optimistic destination append at a version boundary', async () => {
    const connection = createInput({
      providerKey: 'email',
      authType: 'resend_api_key',
      name: `Destination append ${randomUUID()}`,
    });
    await connections.api.createConnection(connection);
    const destinationId = randomUUID();
    const base = {
      workspaceId: workspaceA,
      actorId: ownerA,
      destinationId,
      config: {
        kind: 'email' as const,
        connectionId: connection.connectionId,
        toEmail: 'base@example.test',
      },
    };
    await connections.destinations.create({
      ...base,
      idempotencyKey: `append-base-${destinationId}`,
      requestHash: '1'.repeat(64),
    });
    const append = (suffix: string) =>
      connections.destinations
        .appendVersion({
          ...base,
          expectedVersion: 1,
          config: { ...base.config, toEmail: `${suffix}@example.test` },
          idempotencyKey: `append-race-${suffix}-${destinationId}`,
          requestHash: suffix.repeat(64),
        })
        .then(
          (value) => ({ kind: 'appended' as const, value }),
          (error: unknown) => ({ kind: 'failed' as const, error }),
        );
    const outcomes = await Promise.all([append('a'), append('b')]);
    const appended = outcomes.filter((outcome) => outcome.kind === 'appended');
    const failed = outcomes.filter((outcome) => outcome.kind === 'failed');
    expect(appended).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.kind === 'failed' && failed[0].error).toMatchObject({
      code: 'conflict',
      name: 'FailureNotificationDestinationError',
    });
    await expect(
      connections.destinations.get({
        workspaceId: workspaceA,
        actorId: ownerA,
        destinationId,
      }),
    ).resolves.toMatchObject({
      currentVersion: 2,
      config: appended[0]?.kind === 'appended' ? appended[0].value.config : {},
    });

    const owner = new Pool({ connectionString: databaseUrl(migrationBaseUrl) });
    try {
      await owner.query('set role pertexo_owner');
      await owner.query("select set_config('app.workspace_id',$1,false)", [
        workspaceA,
      ]);
      await expect(
        owner.query<{ version_count: number }>(
          `select count(*)::int version_count
             from app.failure_notification_destination_versions
            where workspace_id=$1 and destination_id=$2`,
          [workspaceA, destinationId],
        ),
      ).resolves.toMatchObject({ rows: [{ version_count: 2 }] });
    } finally {
      await owner.end();
    }
  });
}
