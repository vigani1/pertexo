import { randomBytes, randomUUID } from 'node:crypto';

import { createIdentityWorkspaceStore } from '@pertexo/core/tenant-access';
import { parseDatabaseConfig } from '@pertexo/database/testing';

import { Pool } from 'pg';
import { expect, it } from 'vitest';

import { BetterAuthSessionService } from '../../../../src/authentication/better-auth/session-service.js';

import {
  adminUrl,
  databaseUrl,
  apiUrl,
  runtime,
  signInVerifiedUser,
  cookieValue,
  sha256Hex,
  createInvitationProofSession,
} from '../fixture.js';

export function registerRevokesSessionsAtomicallyCanonicalEmailUpdate(): void {
  it('revokes sessions atomically with a canonical email update under the API role', async () => {
    const userId = randomUUID();
    const owner = new Pool({ connectionString: databaseUrl(adminUrl), max: 1 });
    const api = new Pool({ connectionString: apiUrl, max: 1 });
    try {
      await owner.query(
        `insert into app.users(id,email,display_name,email_verified)
         values($1,'before-email@example.test','Email Change',true)`,
        [userId],
      );
      await owner.query(
        `insert into app.auth_sessions(id,expires_at,token,user_id)
         values($1,clock_timestamp()+interval '1 hour',$2,$3)`,
        [randomUUID(), randomUUID(), userId],
      );
      await api.query(
        `update app.users set email='after-email@example.test' where id=$1`,
        [userId],
      );
      const committed = await owner.query<{
        email: string;
        session_count: number;
      }>(
        `select users.email,
                (select count(*)::integer from app.auth_sessions where user_id=users.id) session_count
           from app.users users where users.id=$1`,
        [userId],
      );
      expect(committed.rows).toEqual([
        { email: 'after-email@example.test', session_count: 0 },
      ]);

      await owner.query(
        `insert into app.auth_sessions(id,expires_at,token,user_id)
         values($1,clock_timestamp()+interval '1 hour',$2,$3)`,
        [randomUUID(), randomUUID(), userId],
      );
      await owner.query(`create function app.test_fail_email_revocation()
        returns trigger language plpgsql as $$
        begin raise exception 'test email revocation failure'; end;
        $$`);
      await owner.query(`create trigger test_fail_email_revocation
        before delete on app.auth_sessions for each row
        execute function app.test_fail_email_revocation()`);
      try {
        await expect(
          api.query(
            `update app.users set email='should-rollback@example.test' where id=$1`,
            [userId],
          ),
        ).rejects.toThrow();
      } finally {
        await owner.query(
          'drop trigger if exists test_fail_email_revocation on app.auth_sessions',
        );
        await owner.query(
          'drop function if exists app.test_fail_email_revocation()',
        );
      }
      const rolledBack = await owner.query<{
        email: string;
        session_count: number;
      }>(
        `select users.email,
                (select count(*)::integer from app.auth_sessions where user_id=users.id) session_count
           from app.users users where users.id=$1`,
        [userId],
      );
      expect(rolledBack.rows).toEqual([
        { email: 'after-email@example.test', session_count: 1 },
      ]);
    } finally {
      await Promise.all([api.end(), owner.end()]);
    }
  });

  it('lands an accepted invitation on one delivered Better Auth replacement session', async () => {
    const email = 'invitation-recipient@example.test';
    const { cookie, authenticated } = await signInVerifiedUser(
      email,
      'Invitation Recipient',
    );
    const recipientId = authenticated?.userId ?? '';
    const identity = createIdentityWorkspaceStore(
      parseDatabaseConfig({
        connectionString: apiUrl,
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 5_000,
        max: 2,
        ownerRole: 'pertexo_owner',
      }),
    );
    try {
      const owner = await identity.createUser({
        email: 'invitation-owner@example.test',
        displayName: 'Invitation Owner',
      });
      const workspace = await identity.createWorkspaceWithOwner({
        name: 'Better Auth invitation',
        slug: `better-auth-invite-${randomUUID().slice(0, 8)}`,
        ownerUserId: owner.id,
      });
      const tokenDigest = sha256Hex(randomUUID());
      const created = await identity.createWorkspaceInvitation({
        workspaceId: workspace.id,
        actorUserId: owner.id,
        email,
        role: 'viewer',
        idempotencyKey: randomUUID(),
        tokenDigest,
        sealedToken: {
          ciphertext: 'sealed-token',
          nonce: 'nonce',
          tag: 'tag',
          keyVersion: 'test-v1',
        },
        expiresAt: new Date(Date.now() + 60 * 60_000),
      });
      const intentId = randomUUID();
      const bindingDigest = sha256Hex(randomUUID());
      await identity.resolveInvitationAcceptance({
        workspaceId: workspace.id,
        invitationId: created.invitation.id,
        tokenDigest,
        intentId,
        bindingDigest,
        csrfDigest: sha256Hex(randomUUID()),
        expiresAt: new Date(Date.now() + 15 * 60_000),
      });
      await identity.recordInvitationAcceptanceProof({
        workspaceId: workspace.id,
        intentId,
        bindingDigest,
        userId: recipientId,
        sessionId: await createInvitationProofSession(recipientId),
        verifiedEmail: email,
        verifiedAt: new Date(),
      });
      const sessions = new BetterAuthSessionService(runtime, {
        secure: false,
        sameSite: 'lax',
        ttlSeconds: 3_600,
      });
      const replacementToken = randomBytes(32).toString('base64url');
      const command = {
        workspaceId: workspace.id,
        intentId,
        invitationRevision: 1,
        actorUserId: recipientId,
        idempotencyKey: randomUUID(),
        replacementSession: {
          id: randomUUID(),
          token: replacementToken,
          expiresAt: new Date(Date.now() + 60 * 60_000),
        },
      };

      await expect(
        identity.completeInvitationAcceptance(command),
      ).resolves.toMatchObject({
        membershipCreated: true,
        replacementSessionCreated: true,
      });
      await expect(
        runtime.sessions.authenticate(cookie ?? ''),
      ).resolves.toBeUndefined();
      const delivered: string[] = [];
      await sessions.deliver(replacementToken, {
        writeSessionCookieHeaders: (setCookies) => {
          delivered.push(...setCookies);
        },
      });
      const replacementCookie = cookieValue(delivered) ?? '';
      await expect(
        sessions.authenticate(decodeURIComponent(replacementCookie)),
      ).resolves.toMatchObject({ userId: recipientId });
      await expect(
        identity.completeInvitationAcceptance(command),
      ).resolves.toMatchObject({
        replayed: true,
        replacementSessionCreated: false,
      });
      await expect(
        sessions.authenticate(decodeURIComponent(replacementCookie)),
      ).resolves.toMatchObject({ userId: recipientId });
      const admin = new Pool({
        connectionString: databaseUrl(adminUrl),
        max: 1,
      });
      try {
        const sessionRows = await admin.query<{ count: number }>(
          'select count(*)::int count from app.auth_sessions where user_id=$1',
          [recipientId],
        );
        expect(sessionRows.rows).toEqual([{ count: 1 }]);
      } finally {
        await admin.end();
      }
    } finally {
      await identity.close();
    }
  });
}
