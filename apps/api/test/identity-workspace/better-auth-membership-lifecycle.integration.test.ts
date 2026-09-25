import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  betterAuthIntegrationEnabled,
  expectProblem,
  useBetterAuthRealApi,
  type Browser,
} from '../support/better-auth-real-api.integration.support.js';

/*
 * ADR 047 through the whole HTTP stack with Better Auth as the only session
 * authority: suspension and reactivation, an ownership transfer that needs a
 * fresh sign-in, and leaving — each ending the affected sessions.
 */
describe.runIf(betterAuthIntegrationEnabled)(
  'Better Auth-only membership lifecycle',
  () => {
    const api = useBetterAuthRealApi('member');
    const { send, signIn, signUp } = api;

    function command(
      browser: Browser,
      url: string,
      payload: object,
      key = randomUUID(),
    ) {
      return send('POST', url, {
        browser,
        headers: { 'idempotency-key': key },
        payload,
      });
    }

    async function userId(browser: Browser): Promise<string> {
      return (await send('GET', '/v1/users/me', { browser })).json<{
        id: string;
      }>().id;
    }

    async function workspacesOf(email: string) {
      const browser = await signIn(email);
      return (await send('GET', '/v1/workspaces', { browser })).json<{
        items: { id: string; role: string }[];
      }>().items;
    }

    it('suspends, reactivates, transfers ownership and leaves', async () => {
      const ownerEmail = `${randomUUID()}@example.test`;
      const memberEmail = `${randomUUID()}@example.test`;
      await signUp(ownerEmail, '/login?verified=true');
      await signUp(memberEmail, '/login?verified=true');
      const owner = await signIn(ownerEmail);
      const created = await command(owner, '/v1/workspaces', {
        name: 'Lifecycle team',
        slug: `lc-${randomUUID().slice(0, 8)}`,
      });
      expect(created.statusCode, created.payload).toBe(201);
      const workspaceId = created.json<{ id: string }>().id;
      const ownerId = await userId(owner);
      const memberId = await userId(await signIn(memberEmail));
      await api.database().query(
        `insert into app.workspace_memberships(workspace_id,user_id,role,status)
           values($1,$2,'builder','active')`,
        [workspaceId, memberId],
      );
      const member = await signIn(memberEmail);
      const base = `/v1/workspaces/${workspaceId}/members/${memberId}`;

      // Suspension: CSRF, strict body, stale revision, authority, replay.
      const key = `suspend-${randomUUID()}`;
      const withoutCsrf = await send('POST', `${base}/suspend`, {
        headers: { cookie: owner.cookie, 'idempotency-key': key },
        payload: { expectedRoleRevision: 1 },
      });
      expect(withoutCsrf.statusCode).toBe(403);
      const strict = await command(
        owner,
        `${base}/suspend`,
        { expectedRoleRevision: 1, status: 'suspended' },
        key,
      );
      expect(strict.statusCode).toBe(400);
      expectProblem(
        await command(owner, `${base}/suspend`, { expectedRoleRevision: 2 }),
        409,
        'workspace.member_role_revision_conflict',
      );
      const byMember = await command(
        member,
        `/v1/workspaces/${workspaceId}/members/${ownerId}/suspend`,
        { expectedRoleRevision: 1 },
      );
      expect(byMember.statusCode).toBe(403);
      const suspended = await command(
        owner,
        `${base}/suspend`,
        { expectedRoleRevision: 1 },
        key,
      );
      expect(suspended.statusCode, suspended.payload).toBe(200);
      expect(suspended.json()).toEqual({
        userId: memberId,
        roleRevision: 2,
        membershipStatus: 'suspended',
        replayed: false,
      });
      expect(
        (
          await command(
            owner,
            `${base}/suspend`,
            { expectedRoleRevision: 1 },
            key,
          )
        ).json(),
      ).toMatchObject({ replayed: true });
      expect(
        (await send('GET', '/v1/users/me', { browser: member })).statusCode,
      ).toBe(401);
      await expect(workspacesOf(memberEmail)).resolves.toEqual([]);
      expectProblem(
        await command(owner, `${base}/suspend`, { expectedRoleRevision: 2 }),
        409,
        'workspace.member_status_conflict',
      );
      const listed = await send(
        'GET',
        `/v1/workspaces/${workspaceId}/members`,
        { browser: owner },
      );
      expect(
        listed.json<{ items: { userId: string; membershipStatus: string }[] }>()
          .items,
      ).toContainEqual(
        expect.objectContaining({
          userId: memberId,
          membershipStatus: 'suspended',
        }),
      );

      const reactivated = await command(owner, `${base}/reactivate`, {
        expectedRoleRevision: 2,
      });
      expect(reactivated.json()).toMatchObject({
        roleRevision: 3,
        membershipStatus: 'active',
      });
      await expect(workspacesOf(memberEmail)).resolves.toEqual([
        expect.objectContaining({ id: workspaceId, role: 'builder' }),
      ]);

      // Ownership transfer needs a sign-in from the last five minutes.
      await api.database().query(
        `update app.auth_sessions set created_at=created_at-interval '10 minutes'
            where user_id=$1`,
        [ownerId],
      );
      const transfer = {
        expectedRoleRevision: 3,
        expectedOwnerRoleRevision: 1,
      };
      expectProblem(
        await command(owner, `${base}/transfer-ownership`, transfer),
        403,
        'auth.session_not_fresh',
      );
      const freshOwner = await signIn(ownerEmail);
      const transferred = await command(
        freshOwner,
        `${base}/transfer-ownership`,
        transfer,
      );
      expect(transferred.statusCode, transferred.payload).toBe(200);
      expect(transferred.json()).toEqual({
        ownerUserId: memberId,
        ownerRoleRevision: 4,
        previousOwnerUserId: ownerId,
        previousOwnerRoleRevision: 2,
        replayed: false,
      });
      expect(
        (await send('GET', '/v1/users/me', { browser: freshOwner })).statusCode,
      ).toBe(401);
      await expect(workspacesOf(memberEmail)).resolves.toEqual([
        expect.objectContaining({ role: 'owner' }),
      ]);

      // The new owner cannot leave; the previous owner, now admin, can.
      const newOwner = await signIn(memberEmail);
      expectProblem(
        await command(newOwner, `/v1/workspaces/${workspaceId}/leave`, {}),
        403,
        'auth.forbidden',
      );
      const admin = await signIn(ownerEmail);
      expect(
        (
          await command(admin, `/v1/workspaces/${workspaceId}/leave`, {
            expectedRoleRevision: 2,
          })
        ).statusCode,
      ).toBe(400);
      const left = await command(
        admin,
        `/v1/workspaces/${workspaceId}/leave`,
        {},
      );
      expect(left.statusCode, left.payload).toBe(200);
      expect(left.json()).toEqual({
        userId: ownerId,
        roleRevision: 3,
        replayed: false,
      });
      expect(
        (await send('GET', '/v1/users/me', { browser: admin })).statusCode,
      ).toBe(401);
      await expect(workspacesOf(ownerEmail)).resolves.toEqual([]);
    });
  },
);
