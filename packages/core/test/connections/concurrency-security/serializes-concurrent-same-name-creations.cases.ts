import type { PoolClient } from 'pg';
import { expect, it } from 'vitest';
import {
  ConnectionConflictError,
  ConnectionNotFoundError,
  ConnectionSecretVersionConflictError,
  Pool,
  apiBaseUrl,
  checkDatabaseReadiness,
  createHash,
  createInput,
  databaseUrl,
  migrationBaseUrl,
  ownerA,
  ownerB,
  randomUUID,
  sealed,
  workerBaseUrl,
  workspaceA,
  workspaceB,
} from '../../support/connections.js';
import { EXPECTED_MIGRATION_HEAD } from '@pertexo/database/testing';
import { connections } from './fixture.js';

export function registerSerializesConcurrentSameNameCreations(): void {
  it('serializes concurrent same-name creations so exactly one wins atomically', async () => {
    const sharedName = `HTTP concurrent ${randomUUID().slice(0, 8)}`;
    const first = createInput({ name: sharedName });
    const second = createInput({ name: sharedName });
    const [firstOutcome, secondOutcome] = await Promise.all([
      connections.api.createConnection(first).then(
        (value) => ({ kind: 'created' as const, value }),
        (error: unknown) => ({ kind: 'failed' as const, error }),
      ),
      connections.api.createConnection(second).then(
        (value) => ({ kind: 'created' as const, value }),
        (error: unknown) => ({ kind: 'failed' as const, error }),
      ),
    ]);
    const outcomes = [firstOutcome, secondOutcome];
    const created = outcomes.filter((outcome) => outcome.kind === 'created');
    const failed = outcomes.filter((outcome) => outcome.kind === 'failed');
    expect(created).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.kind === 'failed' && failed[0].error).toBeInstanceOf(
      ConnectionConflictError,
    );
    expect(created[0]?.kind === 'created' && created[0].value).toMatchObject({
      name: sharedName,
      status: 'active',
    });

    const owner = new Pool({ connectionString: databaseUrl(migrationBaseUrl) });
    let client: PoolClient | undefined;
    try {
      client = await owner.connect();
      await client.query('begin');
      await client.query('set local role pertexo_owner');
      await client.query("select set_config('app.workspace_id', $1, true)", [
        workspaceA,
      ]);
      const result = await client.query<{ rows: string }>(
        `select count(*)::text as rows from app.connection_secret_versions
         where id = any($1::uuid[])`,
        [[first.secretVersionId, second.secretVersionId]],
      );
      // The loser must not leave an orphaned immutable secret version behind.
      expect(result.rows[0]?.rows).toBe('1');
      await client.query('commit');
    } finally {
      await client?.query('rollback').catch(() => undefined);
      client?.release();
      await owner.end();
    }
  });

  it('admits exactly one concurrent rotation per expected current pointer', async () => {
    const input = createInput();
    await connections.api.createConnection(input);
    const candidateASecretVersionId = randomUUID();
    const candidateBSecretVersionId = randomUUID();
    const attempt = (secretVersionId: string) =>
      connections.api
        .rotateConnectionSecret({
          workspaceId: workspaceA,
          actorId: ownerA,
          connectionId: input.connectionId,
          expectedCurrentSecretVersionId: input.secretVersionId,
          secretVersionId,
          sealed: sealed(secretVersionId === candidateASecretVersionId ? 6 : 9),
          idempotencyKey: `rotate-race-${secretVersionId}`,
          requestHash: createHash('sha256')
            .update(secretVersionId)
            .digest('hex'),
        })
        .then(
          (value) => ({ kind: 'rotated' as const, value }),
          (error: unknown) => ({ kind: 'failed' as const, error }),
        );
    const [firstOutcome, secondOutcome] = await Promise.all([
      attempt(candidateASecretVersionId),
      attempt(candidateBSecretVersionId),
    ]);
    const outcomes = [firstOutcome, secondOutcome];
    const rotated = outcomes.filter((outcome) => outcome.kind === 'rotated');
    const conflicts = outcomes.filter((outcome) => outcome.kind === 'failed');
    expect(rotated).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    expect(
      conflicts[0]?.kind === 'failed' && conflicts[0].error,
    ).toBeInstanceOf(ConnectionSecretVersionConflictError);
    const winningVersionId =
      rotated[0]?.kind === 'rotated'
        ? rotated[0].value.currentSecretVersionId
        : undefined;
    const losingVersionId = [
      candidateASecretVersionId,
      candidateBSecretVersionId,
    ].find((candidate) => candidate !== winningVersionId);
    expect(winningVersionId).toBeDefined();
    expect(losingVersionId).toBeDefined();

    const owner = new Pool({ connectionString: databaseUrl(migrationBaseUrl) });
    let client: PoolClient | undefined;
    try {
      client = await owner.connect();
      await client.query('begin');
      await client.query('set local role pertexo_owner');
      await client.query("select set_config('app.workspace_id', $1, true)", [
        workspaceA,
      ]);
      const result = await client.query<{
        current_pointer: string;
        loser_rows: string;
      }>(
        `select
           (select current_secret_version_id::text from app.connections
             where id = $1) as current_pointer,
           (select count(*)::text from app.connection_secret_versions
             where id = $2) as loser_rows`,
        [input.connectionId, losingVersionId],
      );
      // The pointer advanced exactly once and the losing version never
      // persisted, regardless of which claim won the race.
      expect(result.rows[0]?.current_pointer).toBe(winningVersionId);
      expect(result.rows[0]?.loser_rows).toBe('0');
      await client.query('commit');
    } finally {
      await client?.query('rollback').catch(() => undefined);
      client?.release();
      await owner.end();
    }
  });

  it('forces RLS, hides other workspaces, and withholds history mutation from the app role', async () => {
    const input = createInput();
    await connections.api.createConnection(input);
    await expect(
      connections.api.getConnection(workspaceB, input.connectionId),
    ).resolves.toBeNull();
    await expect(
      connections.api.startConnectionTest({
        workspaceId: workspaceB,
        actorId: ownerB,
        connectionId: input.connectionId,
        expectedProviderKey: 'http',
        idempotencyKey: `cross-workspace-${input.connectionId}`,
        requestHash: 'b'.repeat(64),
        dispatchToken: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(ConnectionNotFoundError);

    const apiReadinessPool = new Pool({
      connectionString: databaseUrl(apiBaseUrl),
      max: 1,
    });
    const workerReadinessPool = new Pool({
      connectionString: databaseUrl(workerBaseUrl),
      max: 1,
    });
    try {
      await expect(
        checkDatabaseReadiness(apiReadinessPool),
      ).resolves.toMatchObject({
        migrationHead: EXPECTED_MIGRATION_HEAD,
      });
      await expect(
        checkDatabaseReadiness(workerReadinessPool),
      ).resolves.toMatchObject({
        migrationHead: EXPECTED_MIGRATION_HEAD,
      });
    } finally {
      await Promise.all([apiReadinessPool.end(), workerReadinessPool.end()]);
    }

    const migration = new Pool({
      connectionString: databaseUrl(migrationBaseUrl),
      max: 1,
    });
    let client: PoolClient | undefined;
    try {
      client = await migration.connect();
      await client.query('begin');
      await client.query('set local role pertexo_owner');
      await client.query("select set_config('app.workspace_id', $1, true)", [
        workspaceA,
      ]);
      const grants = await client.query<{
        api_secret_update: boolean;
        events_force_rls: boolean;
        events_rls: boolean;
        secrets_force_rls: boolean;
        secrets_rls: boolean;
        worker_secret_select: boolean;
      }>(`
        select
          has_table_privilege('pertexo_app', 'app.connection_secret_versions', 'UPDATE') as api_secret_update,
          has_table_privilege('pertexo_app', 'app.connection_secret_versions', 'SELECT') as worker_secret_select,
          secret.relrowsecurity as secrets_rls,
          secret.relforcerowsecurity as secrets_force_rls,
          event.relrowsecurity as events_rls,
          event.relforcerowsecurity as events_force_rls
        from pg_class secret, pg_class event
        where secret.oid = 'app.connection_secret_versions'::regclass
          and event.oid = 'app.connection_events'::regclass
      `);
      expect(grants.rows[0]).toEqual({
        api_secret_update: false,
        events_force_rls: true,
        events_rls: true,
        secrets_force_rls: true,
        secrets_rls: true,
        worker_secret_select: true,
      });
    } finally {
      await client?.query('rollback').catch(() => undefined);
      client?.release();
      await migration.end();
    }
  });
}
