import { randomUUID } from 'node:crypto';

import { createApplicationSecretEnvelope } from '@pertexo/secrets/server';
import { describe, expect, it } from 'vitest';

import {
  betterAuthIntegrationEnabled,
  browserFrom,
  expectProblem,
  invitationKeys,
  setCookie,
  useBetterAuthRealApi,
  type Browser,
} from '../../support/better-auth/real-api.support.js';

/*
 * Invitation acceptance with Better Auth as the only session authority and no
 * legacy OIDC: a fresh sign-in proves the session, then member removal and
 * rejoining through a new invitation (ADR 042/043).
 */
describe.runIf(betterAuthIntegrationEnabled)(
  'Better Auth-only invitation acceptance and member removal',
  () => {
    const api = useBetterAuthRealApi('api');
    const { send, signIn, signUp } = api;

    async function invitationToken(workspaceId: string, invitationId: string) {
      const rows = await api.database().query<{
        id: string;
        token_ciphertext: string;
        token_nonce: string;
        token_tag: string;
        token_key_version: string;
      }>(
        `select id,token_ciphertext,token_nonce,token_tag,token_key_version
         from app.workspace_invitation_delivery_attempts
        where workspace_id=$1 and invitation_id=$2`,
        [workspaceId, invitationId],
      );
      const row = rows.rows[0];
      if (row === undefined) throw new Error('No invitation delivery');
      return createApplicationSecretEnvelope(invitationKeys).open(
        {
          ciphertext: row.token_ciphertext,
          nonce: row.token_nonce,
          tag: row.token_tag,
          keyVersion: row.token_key_version,
        },
        `pertexo/workspace-invitation/${workspaceId}/${invitationId}/${row.id}`,
      );
    }

    /** Invites, resolves the link and verifies the recipient's fresh sign-in. */
    async function openInvitation(
      owner: Browser,
      workspaceId: string,
      email: string,
      recipient: Browser,
    ) {
      const invited = await send(
        'POST',
        `/v1/workspaces/${workspaceId}/invitations`,
        {
          browser: owner,
          headers: { 'idempotency-key': randomUUID() },
          payload: { email, role: 'viewer' },
        },
      );
      expect(invited.statusCode, invited.payload).toBe(202);
      const invitationId = invited.json<{ invitation: { id: string } }>()
        .invitation.id;
      const resolved = await send('POST', '/v1/invitation-acceptance/resolve', {
        headers: {
          'content-type': 'application/json',
          'x-pertexo-invitation-request': 'resolve',
        },
        payload: { token: await invitationToken(workspaceId, invitationId) },
      });
      expect(resolved.statusCode, resolved.payload).toBe(201);
      const journey = resolved.json<{ state: string; csrfToken: string }>();
      expect(journey.state).toBe('sign_in_required');
      const binding = setCookie(resolved, 'pertexo_invitation_intent');
      const bound: Browser = {
        ...recipient,
        cookie: `${recipient.cookie}; pertexo_invitation_intent=${binding}`,
      };
      return { journey, bound };
    }

    it('rejects invalid member cursors at the API boundary', async () => {
      const email = `${randomUUID()}@example.test`;
      await signUp(email, '/login?verified=true');
      const owner = await signIn(email);
      const created = await send('POST', '/v1/workspaces', {
        browser: owner,
        headers: { 'idempotency-key': randomUUID() },
        payload: {
          name: 'Cursor validation',
          slug: `cursor-${randomUUID().slice(0, 8)}`,
        },
      });
      expect(created.statusCode, created.payload).toBe(201);
      const workspaceId = created.json<{ id: string }>().id;
      for (const createdAt of [
        '2026-99-99T99:99:99.000000Z',
        '2026-02-30T12:00:00.000000Z',
        '0000-01-01T00:00:00.000000Z',
      ]) {
        const after = Buffer.from(
          JSON.stringify({
            kind: 'workspace_members',
            createdAt,
            userId: randomUUID(),
          }),
        ).toString('base64url');
        const reply = await send(
          'GET',
          `/v1/workspaces/${workspaceId}/members?after=${after}`,
          { browser: owner },
        );
        expectProblem(reply, 400, 'request.invalid');
      }
    });

    it('accepts an invitation from a fresh sign-in, removes the member and lets them rejoin', async () => {
      const ownerEmail = `${randomUUID()}@example.test`;
      const recipientEmail = `${randomUUID()}@example.test`;
      await signUp(ownerEmail, '/login?verified=true');
      await signUp(recipientEmail, '/login?verified=true');
      const owner = await signIn(ownerEmail);
      const created = await send('POST', '/v1/workspaces', {
        browser: owner,
        headers: { 'idempotency-key': randomUUID() },
        payload: {
          name: 'Better Auth team',
          slug: `ba-${randomUUID().slice(0, 8)}`,
        },
      });
      expect(created.statusCode, created.payload).toBe(201);
      const workspaceId = created.json<{ id: string }>().id;

      const staleRecipient = await signIn(recipientEmail);
      const { journey, bound } = await openInvitation(
        owner,
        workspaceId,
        recipientEmail,
        staleRecipient,
      );
      const legacyRoute = await send('POST', '/v1/invitation-acceptance/oidc', {
        browser: bound,
        headers: { 'x-invitation-csrf-token': journey.csrfToken },
        payload: {},
      });
      expect(legacyRoute.statusCode).toBe(404);
      await api.database().query(
        `update app.auth_sessions set created_at=created_at-interval '10 minutes'
        where user_id=(select id from app.users where email=$1)`,
        [recipientEmail],
      );
      const stale = await verifySession(bound, journey.csrfToken);
      expectProblem(stale, 409, 'workspace.invitation_proof_expired');

      const fresh = await signIn(recipientEmail);
      let freshBound: Browser = {
        ...fresh,
        cookie: `${fresh.cookie}; ${bound.cookie.split('; ').at(-1) ?? ''}`,
      };
      const ready = await verifySession(freshBound, journey.csrfToken);
      expect(ready.statusCode, ready.payload).toBe(200);
      const readyJourney = ready.json<{
        state: string;
        intentId: string;
        invitationRevision: number;
      }>();
      expect(readyJourney.state).toBe('ready');
      await send('POST', '/v1/auth/logout', {
        browser: freshBound,
        payload: {},
      });
      const replacement = await signIn(recipientEmail);
      freshBound = {
        ...replacement,
        cookie: `${replacement.cookie}; ${bound.cookie.split('; ').at(-1) ?? ''}`,
      };
      const afterSignIn = await send('GET', '/v1/invitation-acceptance', {
        browser: freshBound,
      });
      expect(afterSignIn.json()).toMatchObject({ state: 'sign_in_required' });
      const rebound = await verifySession(freshBound, journey.csrfToken);
      expect(rebound.statusCode, rebound.payload).toBe(200);
      expect(rebound.json()).toMatchObject({ state: 'ready' });
      const completed = await send(
        'POST',
        '/v1/invitation-acceptance/complete',
        {
          browser: freshBound,
          headers: {
            'idempotency-key': randomUUID(),
            'x-invitation-csrf-token': journey.csrfToken,
          },
          payload: {
            intentId: readyJourney.intentId,
            expectedRevision: readyJourney.invitationRevision,
          },
        },
      );
      expect(completed.statusCode, completed.payload).toBe(200);
      expect(completed.json()).toMatchObject({
        workspaceId,
        role: 'viewer',
        membershipCreated: true,
      });
      const member = browserFrom(completed);
      const bindingCookie = bound.cookie.split('; ').at(-1) ?? '';
      const receipt = await send('GET', '/v1/invitation-acceptance', {
        browser: { ...member, cookie: `${member.cookie}; ${bindingCookie}` },
      });
      expect(receipt.json()).toMatchObject({
        state: 'completed',
        membershipCreated: true,
      });
      const otherReader = await send('GET', '/v1/invitation-acceptance', {
        browser: { ...owner, cookie: `${owner.cookie}; ${bindingCookie}` },
      });
      expect(otherReader.json()).toEqual(
        expect.objectContaining({ state: 'wrong_account' }),
      );
      expect(otherReader.payload).not.toContain('membershipCreated');
      expect(
        (await send('GET', '/v1/users/me', { browser: fresh })).statusCode,
      ).toBe(401);
      const memberId = (
        await send('GET', '/v1/users/me', { browser: member })
      ).json<{ id: string }>().id;

      const removeUrl = `/v1/workspaces/${workspaceId}/members/${memberId}/remove`;
      const removeKey = { 'idempotency-key': `remove-${randomUUID()}` };
      const withoutCsrf = await send('POST', removeUrl, {
        headers: { cookie: owner.cookie, ...removeKey },
        payload: { expectedRoleRevision: 1 },
      });
      expect(withoutCsrf.statusCode).toBe(403);
      const strict = await send('POST', removeUrl, {
        browser: owner,
        headers: removeKey,
        payload: { expectedRoleRevision: 1, role: 'viewer' },
      });
      expect(strict.statusCode).toBe(400);
      const staleRemoval = await send('POST', removeUrl, {
        browser: owner,
        headers: { 'idempotency-key': randomUUID() },
        payload: { expectedRoleRevision: 2 },
      });
      expectProblem(
        staleRemoval,
        409,
        'workspace.member_role_revision_conflict',
      );
      const selfRemoval = await send(
        'POST',
        `/v1/workspaces/${workspaceId}/members/${memberId}/remove`,
        {
          browser: member,
          headers: { 'idempotency-key': randomUUID() },
          payload: { expectedRoleRevision: 1 },
        },
      );
      expect(selfRemoval.statusCode).toBe(403);
      const removed = await send('POST', removeUrl, {
        browser: owner,
        headers: removeKey,
        payload: { expectedRoleRevision: 1 },
      });
      expect(removed.statusCode, removed.payload).toBe(200);
      expect(removed.json()).toEqual({
        userId: memberId,
        roleRevision: 2,
        replayed: false,
      });
      const replayed = await send('POST', removeUrl, {
        browser: owner,
        headers: removeKey,
        payload: { expectedRoleRevision: 1 },
      });
      expect(replayed.json()).toMatchObject({ replayed: true });
      expect(
        (await send('GET', '/v1/users/me', { browser: member })).statusCode,
      ).toBe(401);
      const again = await send('POST', removeUrl, {
        browser: owner,
        headers: { 'idempotency-key': randomUUID() },
        payload: { expectedRoleRevision: 2 },
      });
      expectProblem(again, 409, 'workspace.member_removal_conflict');
      const members = await send(
        'GET',
        `/v1/workspaces/${workspaceId}/members`,
        {
          browser: owner,
        },
      );
      expect(
        members
          .json<{ items: { userId: string }[] }>()
          .items.map((item) => item.userId),
      ).not.toContain(memberId);

      const returning = await signIn(recipientEmail);
      const reopened = await openInvitation(
        owner,
        workspaceId,
        recipientEmail,
        returning,
      );
      const reverified = await verifySession(
        reopened.bound,
        reopened.journey.csrfToken,
      );
      const reverifiedJourney = reverified.json<{
        intentId: string;
        invitationRevision: number;
      }>();
      const rejoined = await send(
        'POST',
        '/v1/invitation-acceptance/complete',
        {
          browser: reopened.bound,
          headers: {
            'idempotency-key': randomUUID(),
            'x-invitation-csrf-token': reopened.journey.csrfToken,
          },
          payload: {
            intentId: reverifiedJourney.intentId,
            expectedRevision: reverifiedJourney.invitationRevision,
          },
        },
      );
      expect(rejoined.json()).toMatchObject({
        membershipCreated: true,
        role: 'viewer',
      });
      const workspaces = await send('GET', '/v1/workspaces', {
        browser: browserFrom(rejoined),
      });
      expect(workspaces.json()).toMatchObject({
        items: [{ id: workspaceId, role: 'viewer' }],
      });
    });

    it('keeps the invitation link private, rebinds a retried link the same way and refuses abandoned or unverified journeys', async () => {
      const ownerEmail = `${randomUUID()}@example.test`;
      const recipientEmail = `${randomUUID()}@example.test`;
      await signUp(ownerEmail, '/login?verified=true');
      await signUp(recipientEmail, '/login?verified=true');
      const owner = await signIn(ownerEmail);
      const created = await send('POST', '/v1/workspaces', {
        browser: owner,
        headers: { 'idempotency-key': randomUUID() },
        payload: {
          name: 'Invite links',
          slug: `inv-${randomUUID().slice(0, 8)}`,
        },
      });
      expect(created.statusCode, created.payload).toBe(201);
      const workspaceId = created.json<{ id: string }>().id;
      const invited = await send(
        'POST',
        `/v1/workspaces/${workspaceId}/invitations`,
        {
          browser: owner,
          headers: { 'idempotency-key': randomUUID() },
          payload: { email: recipientEmail.toUpperCase(), role: 'viewer' },
        },
      );
      expect(invited.statusCode, invited.payload).toBe(202);
      expect(invited.payload).not.toContain('wi1.');
      const invitation = invited.json<{
        invitation: { id: string; deliveryStatus: string };
      }>().invitation;
      expect(invitation.deliveryStatus).toBe('queued');
      const stored = await api
        .database()
        .query<{ normalized_email: string }>(
          'select normalized_email from app.workspace_invitations where id=$1',
          [invitation.id],
        );
      expect(stored.rows).toEqual([{ normalized_email: recipientEmail }]);

      const resolve = (token: string, binding?: string) =>
        send('POST', '/v1/invitation-acceptance/resolve', {
          headers: {
            'content-type': 'application/json',
            'x-pertexo-invitation-request': 'resolve',
            ...(binding === undefined
              ? {}
              : { cookie: `pertexo_invitation_intent=${binding}` }),
          },
          payload: { token },
        });
      const malformed = await resolve('x'.repeat(48));
      expect(malformed.statusCode, malformed.payload).toBeLessThan(300);
      expect(malformed.json()).toEqual({ state: 'unavailable' });
      expect(String(malformed.headers['set-cookie'] ?? '')).not.toContain(
        'pertexo_invitation_intent=',
      );

      const token = await invitationToken(workspaceId, invitation.id);
      const first = setCookie(
        await resolve(token),
        'pertexo_invitation_intent',
      );
      const rebound = await resolve(token, first);
      const retried = await resolve(token, first);
      expect(retried.json()).toEqual(rebound.json());
      expect(retried.headers['set-cookie']).toEqual(
        rebound.headers['set-cookie'],
      );
      expect(String(rebound.headers['set-cookie'])).toMatch(
        /^pertexo_invitation_intent=wb1\..+; HttpOnly;.* SameSite=Lax; Max-Age=900$/u,
      );
      const current = setCookie(rebound, 'pertexo_invitation_intent');
      expect(current).not.toBe(first);

      const recipient = await signIn(recipientEmail);
      const abandoned = await send('GET', '/v1/invitation-acceptance', {
        browser: {
          ...recipient,
          cookie: `${recipient.cookie}; pertexo_invitation_intent=${first}`,
        },
      });
      expect(abandoned.json()).toEqual({ state: 'unavailable' });

      await api
        .database()
        .query('update app.users set email_verified=false where email=$1', [
          recipientEmail,
        ]);
      const unverified = await verifySession(
        {
          ...recipient,
          cookie: `${recipient.cookie}; pertexo_invitation_intent=${current}`,
        },
        rebound.json<{ csrfToken: string }>().csrfToken,
      );
      expectProblem(unverified, 400, 'request.invalid');
    });

    function verifySession(browser: Browser, csrfToken: string) {
      return send('POST', '/v1/invitation-acceptance/session', {
        browser,
        headers: { 'x-invitation-csrf-token': csrfToken },
        payload: {},
      });
    }
  },
);
