import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  betterAuthIntegrationEnabled,
  expectProblem,
} from '../../support/better-auth/real-api.support.js';
import {
  databaseBarrier,
  waitForDatabaseBlock,
} from '../../support/postgres-barrier.js';
import { invitationApi } from './invitation-boundaries/fixture.js';

describe.runIf(betterAuthIntegrationEnabled)(
  'current authority and invitation deadlines',
  () => {
    const api = invitationApi('current_authority');

    it('refuses a stale owner-authorized rename after the owner becomes admin', async () => {
      const { owner, workspaceId } = await api.team();
      const successor = await api.person();
      await api
        .database()
        .query<Record<string, unknown>>(
          "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'admin','active')",
          [workspaceId, successor.id],
        );
      const barrier = await databaseBarrier(api.database());
      let renaming: ReturnType<typeof api.send> | undefined;
      try {
        await barrier.holder.query<Record<string, unknown>>(
          'select id from app.workspaces where id=$1 for update',
          [workspaceId],
        );
        // Uncommitted transfer: the HTTP guard can still see the original owner.
        await barrier.holder.query<Record<string, unknown>>(
          "update app.workspace_memberships set role='admin',role_revision=role_revision+1 where workspace_id=$1 and user_id=$2",
          [workspaceId, owner.id],
        );
        await barrier.holder.query<Record<string, unknown>>(
          "update app.workspace_memberships set role='owner',role_revision=role_revision+1 where workspace_id=$1 and user_id=$2",
          [workspaceId, successor.id],
        );
        renaming = api.send('PATCH', `/v1/workspaces/${workspaceId}`, {
          browser: owner.browser,
          headers: { 'idempotency-key': randomUUID() },
          payload: { name: 'Unauthorized rename', expectedRevision: 1 },
        });
        await waitForDatabaseBlock(api.database(), barrier.pid, 'workspaces');
        await barrier.holder.query('commit');
        const refused = await renaming;
        expect(refused.statusCode, refused.payload).toBe(403);
        expect(
          (
            await api
              .database()
              .query('select name,revision from app.workspaces where id=$1', [
                workspaceId,
              ])
          ).rows,
        ).toEqual([{ name: 'Invitation boundaries', revision: 1 }]);
        expectProblem(
          await api.send('PATCH', `/v1/workspaces/${workspaceId}`, {
            browser: owner.browser,
            headers: { 'idempotency-key': randomUUID() },
            payload: { name: 'Still forbidden', expectedRevision: 1 },
          }),
          403,
          'auth.forbidden',
        );
      } finally {
        await barrier.close();
        await renaming;
      }
    });

    it.each(['email', 'password'] as const)(
      'gives safe recovery-owner preparation guidance for missing %s, then transfers after preparation',
      async (missing) => {
        const { owner, workspaceId } = await api.team();
        const candidate = await api.person();
        await api
          .database()
          .query<Record<string, unknown>>(
            "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'admin','active')",
            [workspaceId, candidate.id],
          );
        const org = randomUUID();
        await api
          .database()
          .query<Record<string, unknown>>(
            "insert into app.auth_organizations(id,control_workspace_id,name) values($1,$2,'Required SSO')",
            [org, workspaceId],
          );
        await api
          .database()
          .query<Record<string, unknown>>(
            'insert into app.auth_domains(id,organization_id,domain,verified_at,require_sso) values($1,$2,$3,clock_timestamp(),true)',
            [randomUUID(), org, `${randomUUID()}.example.test`],
          );
        const saved = (
          await api
            .database()
            .query<{ password: string }>(
              "select * from app.auth_accounts where user_id=$1 and provider_id='credential'",
              [candidate.id],
            )
        ).rows[0];
        if (missing === 'email')
          await api
            .database()
            .query('update app.users set email_verified=false where id=$1', [
              candidate.id,
            ]);
        else
          await api
            .database()
            .query<Record<string, unknown>>(
              "update app.auth_accounts set password=null where user_id=$1 and provider_id='credential'",
              [candidate.id],
            );
        const transfer = () =>
          api.send(
            'POST',
            `/v1/workspaces/${workspaceId}/members/${candidate.id}/transfer-ownership`,
            {
              browser: owner.browser,
              headers: { 'idempotency-key': randomUUID() },
              payload: {
                expectedRoleRevision: 1,
                expectedOwnerRoleRevision: 1,
              },
            },
          );
        const refused = await transfer();
        expectProblem(refused, 409, 'workspace.recovery_owner_ineligible');
        expect(refused.payload).toMatch(/verify.*email/iu);
        expect(refused.payload).toMatch(/password/iu);
        expect(refused.payload).toMatch(/Account security/u);
        expect(
          (
            await api
              .database()
              .query<Record<string, unknown>>(
                "select user_id from app.workspace_memberships where workspace_id=$1 and role='owner'",
                [workspaceId],
              )
          ).rows,
        ).toEqual([{ user_id: owner.id }]);
        await api
          .database()
          .query('update app.users set email_verified=true where id=$1', [
            candidate.id,
          ]);
        await api
          .database()
          .query<Record<string, unknown>>(
            "update app.auth_accounts set password=$2 where user_id=$1 and provider_id='credential'",
            [candidate.id, saved?.password],
          );
        const accepted = await transfer();
        expect(accepted.statusCode, accepted.payload).toBe(200);
        expect(accepted.json()).toMatchObject({ ownerUserId: candidate.id });
      },
    );

    it('samples expiry after an acceptance intent lock wait and leaves committed membership/session truth unchanged on refusal', async () => {
      const world = await api.ready();
      const barrier = await databaseBarrier(api.database());
      let accepting: ReturnType<typeof world.complete> | undefined;
      const snapshot = async () =>
        (
          await api.database().query<Record<string, unknown>>(
            `select
      (select jsonb_agg(to_jsonb(m) order by user_id) from app.workspace_memberships m where workspace_id=$1) memberships,
      (select jsonb_agg(to_jsonb(s) order by id) from app.auth_sessions s where user_id=$2) sessions,
      (select count(*)::int from app.idempotency_records where resource_id=$3) receipts`,
            [world.workspaceId, world.recipient.id, world.journey.intentId],
          )
        ).rows;
      try {
        await barrier.holder.query<Record<string, unknown>>(
          "update app.workspace_invitation_acceptance_intents set expires_at=clock_timestamp()-interval '1 second' where id=$1",
          [world.journey.intentId],
        );
        const before = await snapshot();
        accepting = world.complete();
        await waitForDatabaseBlock(
          api.database(),
          barrier.pid,
          'workspace_invitation_acceptance_intents',
        );
        await barrier.holder.query('commit');
        expect((await accepting).statusCode).toBe(409);
        expect(await snapshot()).toEqual(before);
      } finally {
        await barrier.close();
        await accepting;
      }
    });

    it('uses database time to create and resolve invitation deadlines under process clock skew', async () => {
      const { owner, workspaceId } = await api.team();
      const before = (
        await api
          .database()
          .query<{ now: Date }>('select clock_timestamp() now')
      ).rows[0]?.now;
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 60_000);
      let invitation: Awaited<ReturnType<typeof api.invite>>;
      try {
        invitation = await api.invite(
          workspaceId,
          owner.browser,
          `${randomUUID()}@example.test`,
        );
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
            .query<Record<string, unknown>>(
              "select expires_at between $2::timestamptz+interval '7 days' and $3::timestamptz+interval '7 days' bounded from app.workspace_invitations where id=$1",
              [invitation.id, before, after],
            )
        ).rows,
      ).toEqual([{ bounded: true }]);
      await api
        .database()
        .query<Record<string, unknown>>(
          "update app.workspace_invitations set expires_at=clock_timestamp()-interval '30 seconds' where id=$1",
          [invitation.id],
        );
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() - 60_000);
      try {
        const refused = await api.resolve(invitation.token);
        expect(refused.statusCode, refused.payload).toBe(201);
        expect(refused.json()).toMatchObject({ state: 'unavailable' });
        expect(
          (
            await api
              .database()
              .query<Record<string, unknown>>(
                'select id from app.workspace_invitation_acceptance_intents where invitation_id=$1',
                [invitation.id],
              )
          ).rows,
        ).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });
  },
);
