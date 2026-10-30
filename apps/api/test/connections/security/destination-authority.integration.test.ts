import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import {
  betterAuthIntegrationEnabled,
  useBetterAuthRealApi,
  type Reply,
} from '../../support/better-auth/real-api.support.js';

describe.skipIf(!betterAuthIntegrationEnabled)(
  'destination command authority',
  () => {
    const api = useBetterAuthRealApi('destination_authority', {
      connections: {
        config: {
          mode: 'self-managed',
          encryption: {
            current: {
              version: 'fixture-v1',
              key: Buffer.alloc(32, 77).toString('base64'),
            },
            previous: [],
          },
        },
      },
    });

    it('serializes a destination edit with demotion, so an admitted edit cannot outlive a committed demotion', async () => {
      const ownerEmail = `destination-owner-${randomUUID()}@example.test`;
      await api.signUp(ownerEmail, '/workspaces');
      const owner = await api.signIn(ownerEmail);
      const workspace = await api.send('POST', '/v1/workspaces', {
        browser: owner,
        headers: { 'Idempotency-Key': randomUUID() },
        payload: {
          name: 'Destination authority',
          slug: `authority-${randomUUID().slice(0, 8)}`,
        },
      });
      expect(workspace.statusCode, workspace.payload).toBe(201);
      const { id: workspaceId } = workspace.json<{ id: string }>();
      const adminEmail = `destination-admin-${randomUUID()}@example.test`;
      await api.signUp(adminEmail, '/workspaces');
      const admin = await api.signIn(adminEmail);
      const users = await api
        .database()
        .query<{ id: string; email: string }>(
          'select id,email from app.users where email=any($1::text[])',
          [[ownerEmail, adminEmail]],
        );
      const ownerId = users.rows.find((row) => row.email === ownerEmail)?.id;
      const adminId = users.rows.find((row) => row.email === adminEmail)?.id;
      if (ownerId === undefined || adminId === undefined)
        throw new Error('Fixture users were not created');
      await api
        .database()
        .query(
          "insert into app.workspace_memberships(workspace_id,user_id,role) values($1,$2,'admin')",
          [workspaceId, adminId],
        );
      const destinationId = randomUUID();
      const pool = new Pool({
        connectionString: api.database().options.connectionString,
        max: 1,
      });
      const blocker = await pool.connect();
      let edit: Promise<Reply> | undefined;
      let demotion: Promise<Reply> | undefined;
      try {
        await blocker.query('begin');
        await blocker.query("select set_config('app.workspace_id',$1,true)", [
          workspaceId,
        ]);
        await blocker.query(
          "insert into app.failure_notification_destinations(id,workspace_id,kind,created_by) values($1,$2,'slack',$3)",
          [destinationId, workspaceId, ownerId],
        );
        await blocker.query(
          `insert into app.failure_notification_destination_versions(workspace_id,destination_id,version,kind,side_effect_class,config,created_by)
         values($1,$2,1,'slack','unsafe',$3::jsonb,$4)`,
          [
            workspaceId,
            destinationId,
            JSON.stringify({ connectionId: randomUUID(), channelId: 'C123' }),
            ownerId,
          ],
        );
        await blocker.query('commit');
        await blocker.query('begin');
        await blocker.query(
          'select id from app.failure_notification_destinations where id=$1 for update',
          [destinationId],
        );
        const backend = await blocker.query<{ pid: number }>(
          'select pg_backend_pid() pid',
        );
        const blockerPid = backend.rows[0]?.pid;
        expect(blockerPid).toBeDefined();
        const path = `/v1/workspaces/${workspaceId}/failure-notification-destinations/${destinationId}/status`;
        edit = api.send('PUT', path, {
          browser: admin,
          headers: { 'Idempotency-Key': randomUUID() },
          payload: { status: 'disabled' },
        });
        let editorPid: number | undefined;
        await expect
          .poll(
            async () => {
              const waiting = await api
                .database()
                .query<{ pid: number }>(
                  'select pid from pg_stat_activity where $1::int=any(pg_blocking_pids(pid))',
                  [blockerPid],
                );
              editorPid = waiting.rows[0]?.pid;
              return editorPid;
            },
            { timeout: 10_000 },
          )
          .toBeDefined();
        let demotionFinished = false;
        demotion = api.send(
          'POST',
          `/v1/workspaces/${workspaceId}/members/${adminId}/role`,
          {
            browser: owner,
            headers: { 'Idempotency-Key': randomUUID() },
            payload: { role: 'viewer', expectedRoleRevision: 1 },
          },
        );
        void demotion.then(() => {
          demotionFinished = true;
        });
        let demotionBlocked = false;
        await expect
          .poll(
            async () => {
              const waiting = await api
                .database()
                .query(
                  'select pid from pg_stat_activity where $1::int=any(pg_blocking_pids(pid))',
                  [editorPid],
                );
              demotionBlocked = waiting.rows.length > 0;
              return demotionBlocked || demotionFinished;
            },
            { timeout: 10_000 },
          )
          .toBe(true);
        expect(
          demotionBlocked,
          'demotion must wait for the admitted edit to release its authority fence',
        ).toBe(true);
        await blocker.query('commit');
        const edited = await edit;
        expect(edited.statusCode, edited.payload).toBe(200);
        const demoted = await demotion;
        expect(demoted.statusCode, demoted.payload).toBe(200);
        const refused = await api.send('PUT', path, {
          browser: admin,
          headers: { 'Idempotency-Key': randomUUID() },
          payload: { status: 'enabled' },
        });
        expect([401, 404]).toContain(refused.statusCode);
        const status = await api
          .database()
          .query<{ status: string }>(
            'select status from app.failure_notification_destinations where id=$1',
            [destinationId],
          );
        expect(status.rows[0]?.status).toBe('disabled');
      } finally {
        await blocker.query('rollback');
        blocker.release();
        await pool.end();
        await Promise.allSettled([edit, demotion]);
      }
    });
  },
);
