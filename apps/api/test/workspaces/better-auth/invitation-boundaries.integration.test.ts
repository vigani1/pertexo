import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  betterAuthIntegrationEnabled,
  browserFrom,
  expectProblem,
} from '../../support/better-auth/real-api.support.js';
import {
  databaseBarrier,
  waitForDatabaseBlock,
} from '../../support/postgres-barrier.js';
import { invitationApi } from './invitation-boundary-fixture.js';

describe.runIf(betterAuthIntegrationEnabled)(
  'invitation authority at HTTP and database boundaries',
  () => {
    const api = invitationApi('invite_boundaries');

    it.each(['suspended', 'deleted'])(
      'refuses a %s creator after authentication while creation waits, including exact-key replay',
      async (status) => {
        const person = await api.person();
        const key = randomUUID();
        const payload = {
          name: 'Must not exist',
          slug: `refused-${randomUUID()}`,
        };
        const barrier = await databaseBarrier(api.database());
        let pending: ReturnType<typeof api.send> | undefined;
        const snapshot = async () =>
          (
            await api.database().query<Record<string, unknown>>(
              `select
      (select count(*)::int from app.workspaces where created_by=$1) workspaces,
      (select count(*)::int from app.workspace_memberships where user_id=$1) memberships,
      (select count(*)::int from app.workspace_creation_idempotency_records where actor_user_id=$1) receipts`,
              [person.id],
            )
          ).rows;
        try {
          await barrier.holder.query<Record<string, unknown>>(
            'update app.users set status=$2 where id=$1',
            [person.id, status],
          );
          const before = await snapshot();
          pending = api.send('POST', '/v1/workspaces', {
            browser: person.browser,
            headers: { 'idempotency-key': key },
            payload,
          });
          await waitForDatabaseBlock(api.database(), barrier.pid, 'users');
          await barrier.holder.query('commit');
          const refused = await pending;
          expect(refused.statusCode, refused.payload).toBeGreaterThanOrEqual(
            400,
          );
          expect(refused.statusCode).toBeLessThan(500);
          expect(await snapshot()).toEqual(before);
          const replay = await api.send('POST', '/v1/workspaces', {
            browser: person.browser,
            headers: { 'idempotency-key': key },
            payload,
          });
          expect(replay.statusCode).toBe(401);
          expect(await snapshot()).toEqual(before);
        } finally {
          await barrier.close();
          await pending;
        }
      },
    );

    it('reports malformed invitation cursors as client input errors', async () => {
      const { owner, workspaceId } = await api.team();
      for (const after of [
        'not-a-cursor',
        Buffer.from(
          JSON.stringify({
            kind: 'workspace_invitations',
            createdAt: '2026-99-99T99:99:99.000000Z',
            invitationId: randomUUID(),
          }),
        ).toString('base64url'),
      ])
        expectProblem(
          await api.send(
            'GET',
            `/v1/workspaces/${workspaceId}/invitations?after=${after}`,
            { browser: owner.browser },
          ),
          400,
          'request.invalid',
        );
    });

    it('resolves and revokes concurrently without an invitation/workspace foreign-key deadlock', async () => {
      const { owner, workspaceId } = await api.team();
      const invitation = await api.invite(
        workspaceId,
        owner.browser,
        `${randomUUID()}@example.test`,
      );
      const barrier = await databaseBarrier(api.database());
      let resolving: ReturnType<typeof api.resolve> | undefined;
      let revoking: ReturnType<typeof api.send> | undefined;
      try {
        await barrier.holder.query<Record<string, unknown>>(
          'lock table app.workspace_invitation_acceptance_intents in access exclusive mode',
        );
        resolving = api.resolve(invitation.token);
        await waitForDatabaseBlock(
          api.database(),
          barrier.pid,
          'workspace_invitation_acceptance_intents',
        );
        revoking = api.send(
          'POST',
          `/v1/workspaces/${workspaceId}/invitations/${invitation.id}/revoke`,
          {
            browser: owner.browser,
            headers: { 'idempotency-key': randomUUID() },
            payload: { expectedRevision: 1 },
          },
        );
        await expect
          .poll(
            async () =>
              (
                await api
                  .database()
                  .query<Record<string, unknown>>(
                    `select count(*)::int n from pg_stat_activity where datname=current_database() and wait_event_type='Lock'`,
                  )
              ).rows[0]?.n,
          )
          .toBeGreaterThanOrEqual(2);
        await barrier.holder.query('commit');
        expect((await resolving).statusCode).toBe(201);
        const revoked = await revoking;
        expect(revoked.statusCode, revoked.payload).toBe(202);
        expect(
          (
            await api
              .database()
              .query<Record<string, unknown>>(
                'select status from app.workspace_invitations where id=$1',
                [invitation.id],
              )
          ).rows,
        ).toEqual([{ status: 'revoked' }]);
        expect(
          (
            await api
              .database()
              .query<Record<string, unknown>>(
                'select status from app.workspace_invitation_acceptance_intents where invitation_id=$1',
                [invitation.id],
              )
          ).rows,
        ).toEqual([{ status: 'superseded' }]);
      } finally {
        await barrier.close();
        await Promise.allSettled([resolving, revoking]);
      }
    });

    it('uses database expiry during completion even when the process clock is behind', async () => {
      const world = await api.ready();
      await api
        .database()
        .query<Record<string, unknown>>(
          "update app.workspace_invitations set expires_at=clock_timestamp()-interval '30 seconds' where id=$1",
          [world.invitation.id],
        );
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() - 60_000);
      try {
        const refused = await world.complete();
        expect(refused.statusCode, refused.payload).toBe(409);
        expect(
          (
            await api
              .database()
              .query<Record<string, unknown>>(
                'select * from app.workspace_memberships where workspace_id=$1 and user_id=$2',
                [world.workspaceId, world.recipient.id],
              )
          ).rows,
        ).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('allows revoking a database-valid invitation when the process clock is ahead', async () => {
      const { owner, workspaceId } = await api.team();
      const invitation = await api.invite(
        workspaceId,
        owner.browser,
        `${randomUUID()}@example.test`,
      );
      await api
        .database()
        .query<Record<string, unknown>>(
          "update app.workspace_invitations set expires_at=clock_timestamp()+interval '30 seconds' where id=$1",
          [invitation.id],
        );
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 60_000);
      try {
        const revoked = await api.send(
          'POST',
          `/v1/workspaces/${workspaceId}/invitations/${invitation.id}/revoke`,
          {
            browser: owner.browser,
            headers: { 'idempotency-key': randomUUID() },
            payload: { expectedRevision: 1 },
          },
        );
        expect(revoked.statusCode, revoked.payload).toBe(202);
        expect(
          (
            await api
              .database()
              .query<Record<string, unknown>>(
                'select status from app.workspace_invitations where id=$1',
                [invitation.id],
              )
          ).rows,
        ).toEqual([{ status: 'revoked' }]);
      } finally {
        vi.useRealTimers();
      }
    });

    it.each(['intent', 'command'])(
      'keeps accepted membership and sessions unchanged when the stored %s receipt is damaged',
      async (damaged) => {
        const world = await api.ready();
        const completed = await world.complete();
        expect(completed.statusCode, completed.payload).toBe(200);
        const member = browserFrom(completed);
        const bound = {
          ...member,
          cookie: `${member.cookie}; ${world.bound.cookie.split('; ').at(-1) ?? ''}`,
        };
        const snapshot = async () =>
          (
            await api.database().query<Record<string, unknown>>(
              `select
      (select jsonb_agg(to_jsonb(m) order by user_id) from app.workspace_memberships m where workspace_id=$1) memberships,
      (select jsonb_agg(to_jsonb(s) order by id) from app.auth_sessions s where user_id=$2) sessions`,
              [world.workspaceId, world.recipient.id],
            )
          ).rows;
        const before = await snapshot();
        if (damaged === 'intent')
          await api
            .database()
            .query<Record<string, unknown>>(
              "update app.workspace_invitation_acceptance_intents set receipt='{}' where id=$1",
              [world.journey.intentId],
            );
        else
          await api
            .database()
            .query<Record<string, unknown>>(
              "update app.idempotency_records set result_ref='{}' where resource_id=$1 and operation='workspace.invitation.accept'",
              [world.journey.intentId],
            );
        const response =
          damaged === 'intent'
            ? await api.send('GET', '/v1/invitation-acceptance', {
                browser: bound,
              })
            : await world.complete(bound);
        expect(response.statusCode, response.payload).toBe(409);
        expect(response.json()).not.toHaveProperty('errors');
        expect(await snapshot()).toEqual(before);
      },
    );
  },
);
