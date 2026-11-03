import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { betterAuthIntegrationEnabled } from '../../support/better-auth/real-api.support.js';
import {
  databaseBarrier,
  waitForDatabaseBlock,
} from '../../support/postgres-barrier.js';
import { invitationApi } from './invitation-boundaries/fixture.js';

describe.runIf(betterAuthIntegrationEnabled)(
  'invitation contention and proof deadlines',
  () => {
    const api = invitationApi('invitation_contention');

    it.each(['complete', 'rename'] as const)(
      'resolves while %s waits without a foreign-key deadlock',
      async (operation) => {
        const world = await api.ready();
        const barrier = await databaseBarrier(api.database());
        let resolving: ReturnType<typeof api.resolve> | undefined;
        let changing: ReturnType<typeof api.send> | undefined;
        try {
          await barrier.holder.query(
            'lock table app.workspace_invitation_acceptance_intents in access exclusive mode',
          );
          resolving = api.resolve(world.invitation.token);
          await waitForDatabaseBlock(
            api.database(),
            barrier.pid,
            'workspace_invitation_acceptance_intents',
          );
          changing =
            operation === 'complete'
              ? world.complete()
              : api.send('PATCH', `/v1/workspaces/${world.workspaceId}`, {
                  browser: world.owner.browser,
                  headers: { 'idempotency-key': randomUUID() },
                  payload: {
                    name: 'Renamed under contention',
                    expectedRevision: 1,
                  },
                });
          await expect
            .poll(
              async () =>
                (
                  await api
                    .database()
                    .query<{ n: number }>(
                      "select count(*)::int n from pg_stat_activity where datname=current_database() and wait_event_type='Lock'",
                    )
                ).rows[0]?.n,
            )
            .toBeGreaterThanOrEqual(2);
          await barrier.holder.query('commit');
          const opened = await resolving;
          expect(opened.statusCode, opened.payload).toBe(201);
          const changed = await changing;
          expect(changed.statusCode, changed.payload).toBe(200);
          if (operation === 'complete') {
            expect(
              (
                await api
                  .database()
                  .query<{ status: string }>(
                    'select status from app.workspace_invitations where id=$1',
                    [world.invitation.id],
                  )
              ).rows,
            ).toEqual([{ status: 'accepted' }]);
            expect(
              (
                await api
                  .database()
                  .query<{ role: string }>(
                    'select role from app.workspace_memberships where workspace_id=$1 and user_id=$2',
                    [world.workspaceId, world.recipient.id],
                  )
              ).rows,
            ).toEqual([{ role: 'viewer' }]);
          } else {
            expect(
              (
                await api
                  .database()
                  .query<{ name: string; revision: number }>(
                    'select name,revision from app.workspaces where id=$1',
                    [world.workspaceId],
                  )
              ).rows,
            ).toEqual([{ name: 'Renamed under contention', revision: 2 }]);
          }
        } finally {
          await barrier.close();
          await Promise.allSettled([resolving, changing]);
        }
      },
    );

    it('refuses proof of a database-expired acceptance intent when the process clock is behind', async () => {
      const world = await api.ready();
      await api
        .database()
        .query(
          "update app.workspace_invitation_acceptance_intents set expires_at=clock_timestamp()-interval '30 seconds' where id=$1",
          [world.journey.intentId],
        );
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() - 60_000);
      try {
        const response = await api.send(
          'POST',
          '/v1/invitation-acceptance/session',
          {
            browser: world.bound,
            headers: { 'x-invitation-csrf-token': world.csrf },
            payload: {},
          },
        );
        expect(response.statusCode, response.payload).toBe(404);
        expect(response.json()).toMatchObject({
          code: 'workspace.invitation_unavailable',
        });
        expect(response.json()).not.toHaveProperty('errors');
        expect(
          (
            await api
              .database()
              .query(
                'select user_id from app.workspace_memberships where workspace_id=$1 and user_id=$2',
                [world.workspaceId, world.recipient.id],
              )
          ).rows,
        ).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('resends a database-valid invitation and creates its new deadline from database time while the process clock is ahead', async () => {
      const { owner, workspaceId } = await api.team();
      const invitation = await api.invite(
        workspaceId,
        owner.browser,
        `${randomUUID()}@example.test`,
      );
      await api
        .database()
        .query(
          "update app.workspace_invitation_delivery_attempts set status='submitted' where invitation_id=$1",
          [invitation.id],
        );
      await api
        .database()
        .query(
          "update app.workspace_invitations set delivery_status='submitted',expires_at=clock_timestamp()+interval '30 seconds' where id=$1",
          [invitation.id],
        );
      const before = (
        await api
          .database()
          .query<{ now: Date }>('select clock_timestamp() now')
      ).rows[0]?.now;
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 60_000);
      try {
        const response = await api.send(
          'POST',
          `/v1/workspaces/${workspaceId}/invitations/${invitation.id}/resend`,
          {
            browser: owner.browser,
            headers: { 'idempotency-key': randomUUID() },
            payload: { expectedRevision: 1 },
          },
        );
        expect(response.statusCode, response.payload).toBe(202);
      } finally {
        vi.useRealTimers();
      }
      const after = (
        await api
          .database()
          .query<{ now: Date }>('select clock_timestamp() now')
      ).rows[0]?.now;
      expect(
        (
          await api
            .database()
            .query<{ revision: number; bounded: boolean }>(
              "select revision,expires_at between $2::timestamptz+interval '7 days' and $3::timestamptz+interval '7 days' bounded from app.workspace_invitations where id=$1",
              [invitation.id, before, after],
            )
        ).rows,
      ).toEqual([{ revision: 2, bounded: true }]);
    });
  },
);
