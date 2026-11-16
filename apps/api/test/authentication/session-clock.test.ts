import type { Pool } from 'pg';
import { expect, it } from 'vitest';
import { FRESH_SIGN_IN_WINDOW_MILLIS } from '@pertexo/workflow-model';
import { createTrustedSessionPlugin } from '../../src/authentication/better-auth/session-plugin.js';
import { twoFactorRouteGuard } from '../../src/authentication/better-auth/two-factor.js';

// The database boundary returns an active personal account with password sign-in.
const facts = {
  status: 'active',
  email_verified: true,
  organization_id: null,
  require_sso: false,
  authentication_method: 'credential',
  provider_organization_id: null,
  provider_revision: null,
  provider_id: 'credential',
  password_configured: true,
};
const client = {
  query: (query: { rowMode?: string; text?: string }) =>
    Promise.resolve({
      rows:
        query.rowMode === 'array'
          ? [
              query.text?.includes('provider_id')
                ? ['credential', true]
                : ['active', true, null, false, null],
            ]
          : [facts],
    }),
  release: () => undefined,
};
const pool = {
  ...client,
  connect: () => Promise.resolve(client),
} as unknown as Pool;
it.each(['factor', 'email'] as const)(
  'checks %s session freshness on either side of its window',
  async (kind) => {
    let currentTime = 1000000000000;
    const now = () => currentTime;
    const plugin = createTrustedSessionPlugin(
      pool,
      [],
      {
        mail: { sendSecurityNotice: () => Promise.resolve() },
        transactions: undefined,
        accountUrl: 'https://example.test',
        organizationProtocols: [],
      },
      now,
    );
    const guard =
      kind === 'factor'
        ? twoFactorRouteGuard(pool, undefined, now)
        : plugin.hooks.before.find((hook) =>
            hook.matcher({ path: '/change-email' } as Parameters<
              typeof hook.matcher
            >[0]),
          );
    if (guard === undefined) throw new Error('Expected the email guard');
    const token = 'a'.repeat(43);
    const context = {
      path: kind === 'factor' ? '/two-factor/disable' : '/change-email',
      headers: new Headers({
        cookie: `pertexo_csrf=${token}`,
        'x-csrf-token': token,
      }),
      context: {
        options: {},
        sessionConfig: { freshAge: FRESH_SIGN_IN_WINDOW_MILLIS / 1000 },
        session: {
          session: { id: 'session', createdAt: new Date(currentTime) },
          user: { id: 'user' },
        },
      },
    };
    currentTime += FRESH_SIGN_IN_WINDOW_MILLIS - 1;
    await expect(
      guard.handler(context as Parameters<typeof guard.handler>[0]),
    ).resolves.toBeUndefined();
    currentTime += 2;
    await expect(
      guard.handler(context as Parameters<typeof guard.handler>[0]),
    ).rejects.toMatchObject({ body: { code: 'SESSION_NOT_FRESH' } });
  },
);
