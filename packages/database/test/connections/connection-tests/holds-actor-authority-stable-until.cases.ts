import type { PoolClient } from 'pg';
import { expect, it } from 'vitest';
import {
  Pool,
  adminUrl,
  apiBaseUrl,
  createInput,
  databaseUrl,
  migrationBaseUrl,
  ownerA,
  randomUUID,
  workspaceA,
} from '../../support/connections.js';
import { connections } from './fixture.js';

export function registerHoldsActorAuthorityStableUntil(): void {
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
                 and exists(select 1 from pg_locks waiting where waiting.pid=pg_stat_activity.pid and not waiting.granted and waiting.relation='app.audit_events'::regclass)
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
}
