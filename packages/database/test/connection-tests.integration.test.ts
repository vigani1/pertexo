import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';

import {
  ConnectionIdempotencyConflictError,
  ConnectionTestInProgressError,
  ConnectionUnavailableError,
  Pool,
  adminUrl,
  apiBaseUrl,
  createHash,
  createInput,
  databaseUrl,
  migrationBaseUrl,
  ownerA,
  randomUUID,
  registerCurrentConnectionsFixture,
  sealed,
  workspaceA,
} from './support/connections.integration.support.js';

const connections = registerCurrentConnectionsFixture();

describe('connection test ownership', () => {
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

  it.each(['rotate', 'revoke'] as const)(
    'linearizes dispatch before a concurrent credential %s and writes one marker',
    async (mutation) => {
      const input = createInput();
      await connections.api.createConnection(input);
      const idempotencyKey = `ordered-test-${input.connectionId}`;
      const requestHash = 'd'.repeat(64);
      const dispatchToken = randomUUID();
      await connections.api.startConnectionTest({
        workspaceId: workspaceA,
        actorId: ownerA,
        connectionId: input.connectionId,
        expectedProviderKey: 'http',
        idempotencyKey,
        requestHash,
        dispatchToken,
      });
      await connections.api.resolveConnectionTestSecret({
        workspaceId: workspaceA,
        actorId: ownerA,
        connectionId: input.connectionId,
        expectedProviderKey: 'http',
        idempotencyKey,
        requestHash,
        dispatchToken,
      });

      const gatePool = new Pool({
        connectionString: databaseUrl(migrationBaseUrl),
      });
      const observerPool = new Pool({
        connectionString: databaseUrl(adminUrl),
      });
      let gate: PoolClient | undefined;
      let gateOpen = false;
      let mark: Promise<void> | undefined;
      let mutate: Promise<unknown> | undefined;
      const apiUser = new URL(databaseUrl(apiBaseUrl)).username;
      try {
        gate = await gatePool.connect();
        await gate.query('begin');
        gateOpen = true;
        await gate.query('set local role pertexo_owner');
        await gate.query(
          'lock table app.audit_events in access exclusive mode',
        );
        mark = connections.api.markConnectionTestDispatched({
          workspaceId: workspaceA,
          actorId: ownerA,
          connectionId: input.connectionId,
          idempotencyKey,
          requestHash,
          dispatchToken,
          secretVersionId: input.secretVersionId,
        });
        void mark.catch(() => undefined);
        await expect
          .poll(async () => {
            const result = await observerPool.query<{ blocked: boolean }>(
              `select exists(
                 select 1 from pg_stat_activity
                 where datname = current_database() and usename = $1
                   and wait_event_type = 'Lock'
                   and query like '%insert into app.audit_events%'
               ) as blocked`,
              [apiUser],
            );
            return result.rows[0]?.blocked;
          })
          .toBe(true);

        mutate =
          mutation === 'rotate'
            ? connections.api.rotateConnectionSecret({
                workspaceId: workspaceA,
                actorId: ownerA,
                connectionId: input.connectionId,
                expectedCurrentSecretVersionId: input.secretVersionId,
                secretVersionId: randomUUID(),
                sealed: sealed(9),
                idempotencyKey: `ordered-rotate-${input.connectionId}`,
                requestHash: 'e'.repeat(64),
              })
            : connections.api.revokeConnection({
                workspaceId: workspaceA,
                actorId: ownerA,
                connectionId: input.connectionId,
              });
        void mutate.catch(() => undefined);
        await expect
          .poll(async () => {
            const result = await observerPool.query<{ blocked: boolean }>(
              `select exists(
                 select 1 from pg_stat_activity
                 where datname = current_database() and usename = $1
                   and wait_event_type = 'Lock'
                   and query like '%from app.connections%for update%'
               ) as blocked`,
              [apiUser],
            );
            return result.rows[0]?.blocked;
          })
          .toBe(true);
        await gate.query('rollback');
        gateOpen = false;
        await expect(mark).resolves.toBeUndefined();
        const changed = await mutate;
        expect(changed).toMatchObject(
          mutation === 'rotate' ? { status: 'active' } : { status: 'revoked' },
        );

        const evidence = await observerPool.query<{ count: string }>(
          `select count(*)::text as count from app.audit_events
           where target_id = $1 and action = 'connection.test_dispatched'`,
          [input.connectionId],
        );
        expect(evidence.rows[0]?.count).toBe('1');
      } finally {
        if (gateOpen) await gate?.query('rollback').catch(() => undefined);
        await Promise.allSettled(
          [mark, mutate].filter((value) => value !== undefined),
        );
        gate?.release();
        await Promise.all([gatePool.end(), observerPool.end()]);
      }
    },
    15_000,
  );

  it('holds actor authority stable until the dispatch marker commits', async () => {
    const input = createInput();
    await connections.api.createConnection(input);
    const idempotencyKey = `authority-order-${input.connectionId}`;
    const requestHash = 'a'.repeat(64);
    const dispatchToken = randomUUID();
    await connections.api.startConnectionTest({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: input.connectionId,
      expectedProviderKey: 'http',
      idempotencyKey,
      requestHash,
      dispatchToken,
    });
    await connections.api.resolveConnectionTestSecret({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: input.connectionId,
      expectedProviderKey: 'http',
      idempotencyKey,
      requestHash,
      dispatchToken,
    });

    const gatePool = new Pool({
      connectionString: databaseUrl(migrationBaseUrl),
    });
    const authorityPool = new Pool({
      connectionString: databaseUrl(migrationBaseUrl),
    });
    const observer = new Pool({ connectionString: databaseUrl(adminUrl) });
    let gate: PoolClient | undefined;
    let authority: PoolClient | undefined;
    let mark: Promise<void> | undefined;
    let suspension: Promise<unknown> | undefined;
    let gateOpen = false;
    let authorityOpen = false;
    try {
      gate = await gatePool.connect();
      authority = await authorityPool.connect();
      await gate.query('begin');
      gateOpen = true;
      await gate.query('set local role pertexo_owner');
      await gate.query('lock table app.audit_events in access exclusive mode');
      mark = connections.api.markConnectionTestDispatched({
        workspaceId: workspaceA,
        actorId: ownerA,
        connectionId: input.connectionId,
        idempotencyKey,
        requestHash,
        dispatchToken,
        secretVersionId: input.secretVersionId,
      });
      void mark.catch(() => undefined);
      await expect
        .poll(async () => {
          const result = await observer.query<{ blocked: boolean }>(
            `select exists(
               select 1 from pg_stat_activity
               where datname=current_database() and usename=$1
                 and wait_event_type='Lock'
                 and query like '%insert into app.audit_events%'
             ) blocked`,
            [new URL(databaseUrl(apiBaseUrl)).username],
          );
          return result.rows[0]?.blocked;
        })
        .toBe(true);

      await authority.query('begin');
      authorityOpen = true;
      await authority.query('set local role pertexo_owner');
      await authority.query("select set_config('app.workspace_id',$1,true)", [
        workspaceA,
      ]);
      suspension = authority.query(
        `update app.workspace_memberships set status='suspended'
         where workspace_id=$1 and user_id=$2`,
        [workspaceA, ownerA],
      );
      void suspension.catch(() => undefined);
      await expect
        .poll(async () => {
          const result = await observer.query<{ blocked: boolean }>(
            `select exists(
               select 1 from pg_stat_activity
               where datname=current_database() and usename=$1
                 and wait_event_type='Lock'
                 and query like '%update app.workspace_memberships%'
             ) blocked`,
            [new URL(databaseUrl(migrationBaseUrl)).username],
          );
          return result.rows[0]?.blocked;
        })
        .toBe(true);
      await gate.query('rollback');
      gateOpen = false;
      await expect(mark).resolves.toBeUndefined();
      await expect(suspension).resolves.toMatchObject({ rowCount: 1 });
      await authority.query('rollback');
      authorityOpen = false;
    } finally {
      if (gateOpen) await gate?.query('rollback').catch(() => undefined);
      if (authorityOpen)
        await authority?.query('rollback').catch(() => undefined);
      await Promise.allSettled(
        [mark, suspension].filter((value) => value !== undefined),
      );
      gate?.release();
      authority?.release();
      await Promise.all([gatePool.end(), authorityPool.end(), observer.end()]);
    }
  }, 15_000);

  it('rejects a completed replay whose stored connection identity is corrupt', async () => {
    const input = createInput();
    await connections.api.createConnection(input);
    const idempotencyKey = `corrupt-replay-${input.connectionId}`;
    const requestHash = '9'.repeat(64);
    const dispatchToken = randomUUID();
    const command = {
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: input.connectionId,
      idempotencyKey,
      requestHash,
      dispatchToken,
      secretVersionId: input.secretVersionId,
    } as const;
    await connections.api.startConnectionTest({
      ...command,
      expectedProviderKey: 'http',
    });
    await connections.api.resolveConnectionTestSecret({
      ...command,
      expectedProviderKey: 'http',
    });
    await connections.api.markConnectionTestDispatched(command);
    await connections.api.completeConnectionTest({
      ...command,
      outcome: { ok: true, httpStatus: 204 },
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
         set result_ref = jsonb_set(
           result_ref, '{connection,id}', to_jsonb($2::text), false
         )
         where workspace_id = $1 and operation = 'connection.test'
           and resource_id = $3`,
        [workspaceA, randomUUID(), input.connectionId],
      );
      await owner.query('commit');
    } finally {
      await owner.query('rollback').catch(() => undefined);
      await owner.end();
    }
    await expect(
      connections.api.startConnectionTest({
        ...command,
        expectedProviderKey: 'http',
        dispatchToken: randomUUID(),
      }),
    ).rejects.toThrow('Connection test idempotency result is corrupt');
  });

  it.each(['rotate', 'revoke'] as const)(
    'rejects dispatch without audit evidence when credential %s commits first',
    async (mutation) => {
      const input = createInput();
      await connections.api.createConnection(input);
      const idempotencyKey = `mutation-first-${input.connectionId}`;
      const requestHash = 'f'.repeat(64);
      const dispatchToken = randomUUID();
      await connections.api.startConnectionTest({
        workspaceId: workspaceA,
        actorId: ownerA,
        connectionId: input.connectionId,
        expectedProviderKey: 'http',
        idempotencyKey,
        requestHash,
        dispatchToken,
      });
      await connections.api.resolveConnectionTestSecret({
        workspaceId: workspaceA,
        actorId: ownerA,
        connectionId: input.connectionId,
        expectedProviderKey: 'http',
        idempotencyKey,
        requestHash,
        dispatchToken,
      });
      if (mutation === 'rotate') {
        await connections.api.rotateConnectionSecret({
          workspaceId: workspaceA,
          actorId: ownerA,
          connectionId: input.connectionId,
          expectedCurrentSecretVersionId: input.secretVersionId,
          secretVersionId: randomUUID(),
          sealed: sealed(8),
          idempotencyKey: `mutation-first-rotate-${input.connectionId}`,
          requestHash: '8'.repeat(64),
        });
      } else {
        await connections.api.revokeConnection({
          workspaceId: workspaceA,
          actorId: ownerA,
          connectionId: input.connectionId,
        });
      }
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
      ).rejects.toBeInstanceOf(ConnectionUnavailableError);

      const verifier = new Pool({ connectionString: databaseUrl(adminUrl) });
      try {
        const evidence = await verifier.query<{ count: string }>(
          `select count(*)::text as count from app.audit_events
           where target_id = $1 and action = 'connection.test_dispatched'`,
          [input.connectionId],
        );
        expect(evidence.rows[0]?.count).toBe('0');
      } finally {
        await verifier.end();
      }
    },
  );

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
});
