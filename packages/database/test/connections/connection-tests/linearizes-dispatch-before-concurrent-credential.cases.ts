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
  sealed,
  workspaceA,
} from '../../support/connections.js';
import { connections } from './fixture.js';

export function registerLinearizesDispatchBeforeConcurrentCredential(): void {
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
      let markerPid: number | undefined;
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
            const result = await observerPool.query<{ pid: number }>(
              `select activity.pid from pg_stat_activity activity
               join pg_locks waiting on waiting.pid=activity.pid and not waiting.granted
               where activity.datname=current_database() and activity.usename=$1
                 and waiting.relation='app.audit_events'::regclass limit 1`,
              [apiUser],
            );
            markerPid = result.rows[0]?.pid;
            return markerPid !== undefined;
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
                   and $2::integer=any(pg_blocking_pids(pid))
               ) as blocked`,
              [apiUser, markerPid],
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
}
