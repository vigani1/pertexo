import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { betterAuthIntegrationEnabled } from '../support/better-auth/real-api.support.js';
import {
  registerAccount,
  followVerificationLink,
  signIn,
  createWorkspace,
  PASSWORD,
  type Browser,
} from './actions.js';
import type * as StackModule from './stack.js';
import type { Reply, Stack } from './stack.js';

/*
 * What these state, for docs-deps-product-01 and ops-04: `AUTH_SIGN_UP_MODE`
 * is `invitation` unless set, the other value is `open`, and a refused sign-up
 * is a 403 with `auth.sign_up_closed`. The first verified account closes the
 * install; until then a mistyped address can't strand it.
 */
const CLOSED_CODE = 'auth.sign_up_closed';

function signUp(stack: Stack, email: string) {
  return stack.send('POST', '/v1/auth/sign-up/email', {
    address: `198.51.100.${String(1 + Math.floor(Math.random() * 250))}`,
    body: {
      name: 'Someone',
      email,
      password: PASSWORD,
      callbackURL: '/workspaces',
    },
  });
}

function signInReply(stack: Stack, email: string) {
  return stack.send('POST', '/v1/auth/sign-in/email', {
    body: { email, password: PASSWORD, callbackURL: '/workspaces' },
  });
}

async function accountCount(stack: Stack, email: string): Promise<number> {
  const rows = await stack.query<{ count: number }>(
    'select count(*)::int as count from app.users where email = $1',
    [email],
  );
  return rows.rows[0]?.count ?? 0;
}

function expectRefused(reply: Reply): void {
  expect(reply.status, reply.text).toBe(403);
  expect(reply.json()).toMatchObject({ code: CLOSED_CODE });
}

describe.runIf(betterAuthIntegrationEnabled)(
  'sign-up on a real API with default settings',
  () => {
    let startStack: typeof StackModule.startStack;
    beforeAll(async () => {
      ({ startStack } = await import('./stack.js'));
    });

    describe('the first run of a fresh install', () => {
      const FIRST = 'owner@integration.test';
      const MISTYPED = 'owner@integration.tset';
      let stack: Stack;
      let owner: Browser;

      beforeAll(async () => {
        stack = await startStack();
      }, 120_000);
      afterAll(async () => {
        await stack.close();
      }, 60_000);

      it('lets the first person sign up', async () => {
        const reply = await signUp(stack, MISTYPED);
        expect(reply.status, reply.text).toBe(200);
      });

      it('stays open while no one has verified, so a typo cannot strand the install', async () => {
        const reply = await signUp(stack, FIRST);
        expect(reply.status, reply.text).toBe(200);
      });

      it('makes the first verified person the owner of what they create', async () => {
        await followVerificationLink(stack, FIRST);
        owner = await signIn(stack, FIRST);
        const workspaceId = await createWorkspace(stack, owner);
        const members = await stack.query<{ role: string; email: string }>(
          `select m.role, u.email from app.workspace_memberships m
           join app.users u on u.id = m.user_id where m.workspace_id = $1`,
          [workspaceId],
        );
        expect(members.rows).toEqual([{ role: 'owner', email: FIRST }]);
      });

      it(
        'refuses a stranger once someone has verified, and keeps no trace',
        async () => {
          const email = 'stranger@integration.test';
          expectRefused(await signUp(stack, email));
          expect(await accountCount(stack, email)).toBe(0);
          expect(stack.api.logs).not.toContain(`verification for ${email}`);
        },
      );

      it(
        'gives an address with an account the same refusal',
        async () => {
          const taken = await signUp(stack, FIRST);
          const unknown = await signUp(stack, 'unknown@integration.test');
          expectRefused(taken);
          expectRefused(unknown);
        },
      );

      it(
        'does not turn the unverified second sign-up into a second account',
        async () => {
          await followVerificationLink(stack, MISTYPED);
          const reply = await signInReply(stack, MISTYPED);
          expect(reply.status, reply.text).not.toBe(200);
        },
      );

      it('keeps the owner signed in and working once closed', async () => {
        const me = await stack.send('GET', '/v1/users/me', { browser: owner });
        expect(me.status).toBe(200);
        const again = await signInReply(stack, FIRST);
        expect(again.status, again.text).toBe(200);
      });
    });

    describe('several people racing for the first account', () => {
      let stack: Stack;

      beforeAll(async () => {
        stack = await startStack();
      }, 120_000);
      afterAll(async () => {
        await stack.close();
      }, 60_000);

      it(
        'lets exactly one of them verify into an account',
        async () => {
          const emails = Array.from(
            { length: 5 },
            (_, index) => `racer-${String(index)}@integration.test`,
          );
          for (const email of emails)
            expect((await signUp(stack, email)).status).toBe(200);

          await Promise.all(
            emails.map((email) => followVerificationLink(stack, email)),
          );

          const signedIn = await Promise.all(
            emails.map((email) => signInReply(stack, email)),
          );
          expect(signedIn.filter((reply) => reply.status === 200)).toHaveLength(
            1,
          );
        },
        60_000,
      );
    });

    describe('invitations on a closed install', () => {
      let stack: Stack;
      let owner: Browser;
      let workspaceId: string;

      const invite = async (email: string) => {
        const reply = await stack.send(
          'POST',
          `/v1/workspaces/${workspaceId}/invitations`,
          {
            browser: owner,
            headers: { 'idempotency-key': randomUUID() },
            body: { email, role: 'builder' },
          },
        );
        expect(reply.status, reply.text).toBe(202);
        const rows = await stack.query<{ id: string; revision: number }>(
          `select id, revision from app.workspace_invitations
           where normalized_email = lower($1)`,
          [email],
        );
        const row = rows.rows[0];
        if (row === undefined) throw new Error('Invitation row is missing');
        return row;
      };

      beforeAll(async () => {
        stack = await startStack();
        await registerAccount(stack, 'owner@integration.test');
        owner = await signIn(stack, 'owner@integration.test');
        workspaceId = await createWorkspace(stack, owner);
      }, 120_000);
      afterAll(async () => {
        await stack.close();
      }, 60_000);

      it('lets an invited address sign up, verify and sign in', async () => {
        const email = 'invited@integration.test';
        await invite(email);

        expect((await signUp(stack, email)).status).toBe(200);
        await followVerificationLink(stack, email);
        expect((await signInReply(stack, email)).status).toBe(200);
      });

      it('matches the invitation whatever the capitals', async () => {
        await invite('capitals@integration.test');
        const reply = await signUp(stack, 'Capitals@Integration.Test');
        expect(reply.status, reply.text).toBe(200);
      });

      it('still refuses everyone else', async () => {
        await invite('someone-else@integration.test');
        expectRefused(await signUp(stack, 'not-invited@integration.test'));
      });

      it('refuses a revoked invitation', async () => {
        const email = 'revoked@integration.test';
        const invitation = await invite(email);
        const revoked = await stack.send(
          'POST',
          `/v1/workspaces/${workspaceId}/invitations/${invitation.id}/revoke`,
          {
            browser: owner,
            headers: { 'idempotency-key': randomUUID() },
            body: { expectedRevision: invitation.revision },
          },
        );
        expect(revoked.status, revoked.text).toBeLessThan(300);

        expectRefused(await signUp(stack, email));
      });

      it('refuses an expired invitation', async () => {
        const email = 'expired@integration.test';
        const invitation = await invite(email);
        await stack.query(
          `update app.workspace_invitations
           set expires_at = now() - interval '1 minute' where id = $1`,
          [invitation.id],
        );

        expectRefused(await signUp(stack, email));
      });
    });

    describe('an install that explicitly opens sign-up', () => {
      let stack: Stack;

      beforeAll(async () => {
        stack = await startStack({
          environment: { AUTH_SIGN_UP_MODE: 'open' },
        });
        await registerAccount(stack, 'owner@integration.test');
      }, 120_000);
      afterAll(async () => {
        await stack.close();
      }, 60_000);

      it('lets anyone sign up after the owner', async () => {
        const email = 'anyone@integration.test';
        const reply = await signUp(stack, email);
        expect(reply.status, reply.text).toBe(200);
        await followVerificationLink(stack, email);
        expect((await signInReply(stack, email)).status).toBe(200);
      });
    });

    describe('a production install, which is what a public address runs', () => {
      let stack: Stack;

      beforeAll(async () => {
        const key = Buffer.alloc(32, 0x41).toString('base64');
        stack = await startStack({
          webOrigin: 'https://app.integration.test',
          environment: {
            NODE_ENV: 'production',
            AUTH_MAIL_MODE: 'durable',
            AUTH_MAIL_FROM: 'security@integration.test',
            AUTH_MAIL_KEY: key,
            AUTH_MAIL_KEY_VERSION: 'v1',
            AUTH_MAIL_PREVIOUS_KEYS: '[]',
            SESSION_COOKIE_SECURE: 'true',
            CONNECTION_SELF_MANAGED_KEY: key,
            CONNECTION_SELF_MANAGED_KEY_VERSION: 'integration:v1',
            CALLBACK_TOKEN_KEY: Buffer.alloc(32, 0x42).toString('base64url'),
          },
        });
      }, 120_000);
      afterAll(async () => {
        await stack.close();
      }, 60_000);

      it(
        'is closed with no setting once someone has verified',
        async () => {
          expect((await signUp(stack, 'owner@integration.test')).status).toBe(
            200,
          );
          // Mail leaves through the worker here; the proof it carries is not the subject.
          await stack.query(
            'update app.users set email_verified = true where email = $1',
            ['owner@integration.test'],
          );

          const email = 'stranger@integration.test';
          expectRefused(await signUp(stack, email));
          expect(await accountCount(stack, email)).toBe(0);
        },
      );
    });
  },
);
