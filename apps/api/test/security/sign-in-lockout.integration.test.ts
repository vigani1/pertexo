import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { betterAuthIntegrationEnabled } from '../support/better-auth/real-api.support.js';
import { registerAccount, PASSWORD } from './actions.js';
import type { Stack } from './stack.js';

const VICTIM = 'victim@integration.test';
const ATTACKED = 'attacked@integration.test';
const WRONG = 'not the right password at all';

function address(octet: number): string {
  return `198.51.100.${String(octet)}`;
}

describe.runIf(betterAuthIntegrationEnabled)(
  'sign-in rate limits on the real API and Redis',
  () => {
    let stack: Stack;

    const failedSignIn = (from: string, email = ATTACKED) =>
      stack.send('POST', '/v1/auth/sign-in/email', {
        address: from,
        body: { email, password: WRONG, callbackURL: '/workspaces' },
      });

    /** The failed sign-ins of a small attack: each address stays within its own limit. */
    async function lockoutAttempt() {
      for (const octet of [1, 2, 3])
        for (let attempt = 0; attempt < 10; attempt++)
          await failedSignIn(address(octet));
    }

    beforeAll(async () => {
      const { startStack } = await import('./stack.js');
      stack = await startStack({
        environment: { AUTH_SIGN_UP_MODE: 'open' },
      });
      await registerAccount(stack, VICTIM);
      await registerAccount(stack, ATTACKED);
    }, 120_000);
    afterAll(async () => {
      await stack.close();
    }, 60_000);
    beforeEach(async () => {
      await stack.flushRedis();
    });

    // sec-03: every browser shares one origin bucket, 30 starts a minute.
    it.fails(
      'lets a stranger sign in after three addresses use up their limits',
      async () => {
        await lockoutAttempt();

        const signedIn = await stack.send('POST', '/v1/auth/sign-in/email', {
          address: address(200),
          body: {
            email: VICTIM,
            password: PASSWORD,
            callbackURL: '/workspaces',
          },
        });
        expect(signedIn.status, signedIn.text).toBe(200);
      },
      60_000,
    );

    // sec-03: the same bucket also stops password resets.
    it.fails(
      'lets a stranger ask for a password reset after the same attack',
      async () => {
        await lockoutAttempt();

        const reset = await stack.send(
          'POST',
          '/v1/auth/request-password-reset',
          {
            address: address(201),
            body: { email: VICTIM, redirectTo: '/reset-password' },
          },
        );
        expect(reset.status, reset.text).toBe(200);
      },
      60_000,
    );

    // sec-03: and new accounts.
    it.fails(
      'lets a stranger sign up after the same attack, where sign-up is open',
      async () => {
        await lockoutAttempt();

        const created = await stack.send('POST', '/v1/auth/sign-up/email', {
          address: address(202),
          body: {
            name: 'Fresh',
            email: 'fresh@integration.test',
            password: PASSWORD,
            callbackURL: '/workspaces',
          },
        });
        expect(created.status, created.text).toBe(200);
      },
      60_000,
    );

    // sec-03: identity_callback has the same shared bucket, 60 a minute.
    it.fails(
      'keeps email links and SSO returns working after two addresses use up theirs',
      async () => {
        const visit = (from: string) =>
          stack.send('GET', '/v1/auth/verify-email?token=not-a-real-token', {
            address: from,
          });
        for (const octet of [11, 12])
          for (let attempt = 0; attempt < 30; attempt++)
            await visit(address(octet));

        const reply = await visit(address(203));
        expect(reply.status, reply.text).not.toBe(429);
      },
      60_000,
    );

    it('still stops one address guessing passwords', async () => {
      const replies = [];
      for (let attempt = 0; attempt < 11; attempt++)
        replies.push(await failedSignIn(address(21)));

      expect(replies.slice(0, 10).map((reply) => reply.status)).toEqual(
        Array.from({ length: 10 }, () => 401),
      );
      const limited = replies.at(-1);
      expect(limited?.status).toBe(429);
      expect(Number(limited?.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(limited?.json()).toMatchObject({ code: 'request.rate_limited' });
    }, 60_000);

    it('still stops many addresses guessing one account', async () => {
      const statuses = [];
      for (let octet = 30; octet < 90; octet++)
        statuses.push((await failedSignIn(address(octet))).status);

      expect(statuses).toContain(429);
      expect(
        statuses.filter((status) => status === 401).length,
      ).toBeLessThanOrEqual(30);
    }, 60_000);

    it('still stops many addresses flooding one mailbox with reset mail', async () => {
      const statuses = [];
      for (let octet = 90; octet < 150; octet++)
        statuses.push(
          (
            await stack.send('POST', '/v1/auth/request-password-reset', {
              address: address(octet),
              body: { email: ATTACKED, redirectTo: '/reset-password' },
            })
          ).status,
        );

      expect(statuses).toContain(429);
      expect(
        statuses.filter((status) => status === 200).length,
      ).toBeLessThanOrEqual(30);
    }, 60_000);

    // sec-03: guessing one account must not cost the people on other accounts.
    it.fails(
      'lets another account sign in while one account is being guessed from everywhere',
      async () => {
        for (let octet = 150; octet < 190; octet++)
          await failedSignIn(address(octet));

        const signedIn = await stack.send('POST', '/v1/auth/sign-in/email', {
          address: address(204),
          body: {
            email: VICTIM,
            password: PASSWORD,
            callbackURL: '/workspaces',
          },
        });
        expect(signedIn.status, signedIn.text).toBe(200);
      },
      60_000,
    );
  },
);
