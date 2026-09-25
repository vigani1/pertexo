import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';

import {
  ConnectionConflictError,
  ConnectionNotFoundError,
  ConnectionSecretVersionConflictError,
  ConnectionUnavailableError,
  Pool,
  apiBaseUrl,
  checkDatabaseReadiness,
  createHash,
  createInput,
  databaseUrl,
  migrationBaseUrl,
  ownerA,
  ownerB,
  pgCode,
  randomUUID,
  registerCurrentConnectionsFixture,
  sealed,
  workerBaseUrl,
  workspaceA,
  workspaceB,
} from './support/connections.integration.support.js';

const connections = registerCurrentConnectionsFixture();

describe('connection concurrency and security', () => {
  it('lists and reads actor-scoped metadata with deterministic keyset pagination', async () => {
    const first = createInput({ name: `Readable ${randomUUID().slice(0, 8)}` });
    const second = createInput({
      name: `Readable ${randomUUID().slice(0, 8)}`,
    });
    await connections.api.createConnection(first);
    await connections.api.createConnection(second);

    const page = await connections.api.listConnections({
      workspaceId: workspaceA,
      actorId: ownerA,
      limit: 1,
    });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeDefined();
    expect(page.items[0]).not.toHaveProperty('sealed');

    if (page.nextCursor === undefined)
      throw new Error('Expected a cursor for the populated fixture');
    const nextPage = await connections.api.listConnections({
      workspaceId: workspaceA,
      actorId: ownerA,
      limit: 1,
      after: page.nextCursor,
    });
    expect(nextPage.items[0]?.id).not.toBe(page.items[0]?.id);
    await expect(
      connections.api.readConnection({
        workspaceId: workspaceA,
        actorId: ownerA,
        connectionId: first.connectionId,
      }),
    ).resolves.toMatchObject({
      id: first.connectionId,
      workspaceId: workspaceA,
    });
    await expect(
      connections.api.readConnection({
        workspaceId: workspaceB,
        actorId: ownerB,
        connectionId: first.connectionId,
      }),
    ).resolves.toBeNull();
  });

  it('paginates same-status rows within one millisecond without gaps or duplicates', async () => {
    const inputs = [createInput(), createInput(), createInput()];
    for (const input of inputs) await connections.api.createConnection(input);

    const owner = new Pool({ connectionString: databaseUrl(migrationBaseUrl) });
    try {
      await owner.query('begin');
      await owner.query('set local role pertexo_owner');
      await owner.query("select set_config('app.workspace_id',$1,true)", [
        workspaceA,
      ]);
      for (const [index, input] of inputs.entries()) {
        await owner.query(
          `update app.connections
           set created_at = ('2099-01-01T00:00:00.000100Z'::timestamptz
             + $2::integer * interval '100 microseconds')
           where workspace_id = $1 and id = $3`,
          [workspaceA, index, input.connectionId],
        );
      }
      await owner.query('commit');
    } finally {
      await owner.query('rollback').catch(() => undefined);
      await owner.end();
    }

    const seen: string[] = [];
    let after: Parameters<typeof connections.api.listConnections>[0]['after'];
    for (let pageNumber = 0; pageNumber < 3; pageNumber += 1) {
      const page = await connections.api.listConnections({
        workspaceId: workspaceA,
        actorId: ownerA,
        limit: 1,
        ...(after === undefined ? {} : { after }),
      });
      const item = page.items[0];
      if (item === undefined)
        throw new Error('Expected a connection page item');
      seen.push(item.id);
      after = page.nextCursor;
    }

    expect(new Set(seen).size).toBe(3);
    expect(seen.toSorted()).toEqual(
      inputs.map((input) => input.connectionId).toSorted(),
    );
  });

  it('uses capability roles and rejects inactive authority states', async () => {
    const roleActors = new Map([
      ['owner', ownerA],
      ...(['admin', 'builder', 'operator', 'viewer'] as const).map(
        (role) => [role, randomUUID()] as const,
      ),
    ] as const);
    const owner = new Pool({ connectionString: databaseUrl(migrationBaseUrl) });
    let client: PoolClient | undefined;
    try {
      client = await owner.connect();
      await client.query('begin');
      await client.query('set local role pertexo_owner');
      await client.query("select set_config('app.workspace_id',$1,true)", [
        workspaceA,
      ]);
      for (const [role, actorId] of roleActors) {
        if (role === 'owner') continue;
        await client.query(
          `insert into app.users (id,email,display_name,status)
           values ($1,$2,$3,'active')`,
          [actorId, `${actorId}@example.test`, `Connection ${role}`],
        );
        await client.query(
          `insert into app.workspace_memberships
             (workspace_id,user_id,role,status)
           values ($1,$2,$3,'active')`,
          [workspaceA, actorId, role],
        );
      }
      await client.query('commit');
    } finally {
      await client?.query('rollback').catch(() => undefined);
      client?.release();
      await owner.end();
    }

    for (const [role, actorId] of roleActors) {
      const command = createInput({ actorId });
      const creation = connections.api.createConnection(command);
      if (role === 'owner' || role === 'admin')
        await expect(creation).resolves.toMatchObject({ createdBy: actorId });
      else
        await expect(creation).rejects.toBeInstanceOf(ConnectionNotFoundError);
    }

    const shared = createInput();
    await connections.api.createConnection(shared);
    for (const [role, actorId] of roleActors) {
      const start = connections.api.startConnectionTest({
        workspaceId: workspaceA,
        actorId,
        connectionId: shared.connectionId,
        expectedProviderKey: 'http',
        idempotencyKey: `role-${role}-${shared.connectionId}`,
        requestHash: createHash('sha256').update(role).digest('hex'),
        dispatchToken: randomUUID(),
      });
      if (role === 'viewer')
        await expect(start).rejects.toBeInstanceOf(ConnectionNotFoundError);
      else await expect(start).resolves.toMatchObject({ kind: 'dispatch' });
    }

    const builderId = roleActors.get('builder');
    if (builderId === undefined) throw new Error('Builder fixture is missing');
    const authorityPool = new Pool({
      connectionString: databaseUrl(migrationBaseUrl),
    });
    try {
      await authorityPool.query('set role pertexo_owner');
      await authorityPool.query(
        "select set_config('app.workspace_id',$1,false)",
        [workspaceA],
      );
      const assertDenied = async (suffix: string): Promise<void> => {
        await expect(
          connections.api.startConnectionTest({
            workspaceId: workspaceA,
            actorId: builderId,
            connectionId: shared.connectionId,
            expectedProviderKey: 'http',
            idempotencyKey: `inactive-${suffix}-${shared.connectionId}`,
            requestHash: createHash('sha256').update(suffix).digest('hex'),
            dispatchToken: randomUUID(),
          }),
        ).rejects.toBeInstanceOf(ConnectionNotFoundError);
      };
      await authorityPool.query(
        `update app.workspace_memberships set status='suspended'
         where workspace_id=$1 and user_id=$2`,
        [workspaceA, builderId],
      );
      await assertDenied('membership');
      await authorityPool.query(
        `update app.workspace_memberships set status='active'
         where workspace_id=$1 and user_id=$2`,
        [workspaceA, builderId],
      );
      await authorityPool.query(
        `update app.users set status='suspended' where id=$1`,
        [builderId],
      );
      await assertDenied('user');
      await authorityPool.query(
        `update app.users set status='active' where id=$1`,
        [builderId],
      );
      await authorityPool.query(
        `update app.workspaces set status='suspended' where id=$1`,
        [workspaceA],
      );
      await assertDenied('workspace');
    } finally {
      await authorityPool
        .query(`update app.users set status='active' where id=$1`, [builderId])
        .catch(() => undefined);
      await authorityPool
        .query(`update app.workspaces set status='active' where id=$1`, [
          workspaceA,
        ])
        .catch(() => undefined);
      await authorityPool.end();
    }
  });

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

  it('forces RLS, hides other workspaces, and withholds history mutation', async () => {
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
    ).rejects.toBeInstanceOf(ConnectionUnavailableError);

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
        checkDatabaseReadiness(apiReadinessPool, {
          ownerRole: 'pertexo_owner',
          workerRuntimeRole: 'pertexo_worker',
        }),
      ).resolves.toMatchObject({
        migrationHead: '0115_webhook_delivery_log.sql',
      });
      await expect(
        checkDatabaseReadiness(workerReadinessPool, {
          ownerRole: 'pertexo_owner',
          workerRuntimeRole: 'pertexo_worker',
        }),
      ).resolves.toMatchObject({
        migrationHead: '0115_webhook_delivery_log.sql',
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
        worker_connection_insert: boolean;
        worker_secret_select: boolean;
      }>(`
        select
          has_table_privilege('pertexo_api', 'app.connection_secret_versions', 'UPDATE') as api_secret_update,
          has_table_privilege('pertexo_worker', 'app.connections', 'INSERT') as worker_connection_insert,
          has_table_privilege('pertexo_worker', 'app.connection_secret_versions', 'SELECT') as worker_secret_select,
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
        worker_connection_insert: false,
        worker_secret_select: true,
      });
      await expect(
        client.query(
          `update app.connection_secret_versions
           set ciphertext = ciphertext where id = $1`,
          [input.secretVersionId],
        ),
      ).rejects.toSatisfy(pgCode('55000'));
    } finally {
      await client?.query('rollback').catch(() => undefined);
      client?.release();
      await migration.end();
    }
  });
});
