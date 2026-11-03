import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SocialProviderGateway } from '../../../src/authentication/social-provider.types.js';
import { useSocialProviderGateway } from '../../support/better-auth/social-provider.js';
import {
  betterAuthIntegrationEnabled,
  setCookie,
  type Reply,
} from '../../support/better-auth/real-api.support.js';
import { useOrganizationApi } from './organization/fixture.js';

const CANARY = 'private-proof-bearer-SQL-exception-canary';

describe.runIf(betterAuthIntegrationEnabled)(
  'owned authentication failure diagnostics',
  () => {
    const privateValues = new Set([CANARY]);
    const authorizations = new Map<
      string,
      Parameters<SocialProviderGateway['authorize']>[0]
    >();
    let failure: 'authorize' | 'verify' | 'refuse' | undefined;
    let email = '',
      subject = '';
    const gateway: SocialProviderGateway = {
      available: ['google', 'github'],
      authorize: (input) => {
        if (failure === 'authorize') return Promise.reject(new Error(CANARY));
        privateValues.add(input.state);
        privateValues.add(input.codeVerifier);
        privateValues.add(input.nonce);
        authorizations.set(input.state, input);
        return Promise.resolve(
          `https://provider.test/authorize?state=${input.state}`,
        );
      },
      verify: () => {
        if (failure === 'verify') return Promise.reject(new Error(CANARY));
        return Promise.resolve(
          failure === 'refuse'
            ? undefined
            : {
                accountId: subject,
                email,
                emailVerified: true,
                displayName: 'Diagnostic Person',
              },
        );
      },
    };
    useSocialProviderGateway(gateway);
    const api = useOrganizationApi('diagnostics', {
      socialProviders: {
        google: { clientId: 'fixture', clientSecret: 'secret' },
        github: { clientId: 'fixture', clientSecret: 'secret' },
      },
    });
    afterEach(() => {
      failure = undefined;
    });
    async function observe(
      action: () => Promise<Reply>,
      flow: string,
      reason: string,
      kind = 'failed',
    ) {
      const errors = vi.spyOn(Logger.prototype, 'error'),
        warnings = vi.spyOn(Logger.prototype, 'warn');
      try {
        const reply = await action();
        const owned = [...errors.mock.calls, ...warnings.mock.calls]
          .flat()
          .filter(
            (value: unknown) =>
              typeof value === 'string' && value.startsWith('Authentication '),
          );
        expect(owned).toEqual([
          `Authentication ${kind}: ${flow} ${reason} requestId=${String(reply.headers['x-request-id'])}`,
        ]);
        const appropriate = kind === 'failed' ? errors : warnings;
        expect(appropriate.mock.calls.flat()).toContain(owned[0]);
        const written =
          JSON.stringify([...errors.mock.calls, ...warnings.mock.calls]) +
          reply.payload +
          JSON.stringify(reply.headers);
        for (const value of privateValues) expect(written).not.toContain(value);
        return reply;
      } finally {
        errors.mockRestore();
        warnings.mockRestore();
      }
    }
    async function social() {
      email = `diagnostic-${randomUUID()}@example.test`;
      subject = randomUUID();
      const reply = await api.send('POST', '/v1/auth/sign-in/social', {
        payload: { provider: 'google' },
      });
      expect(reply.statusCode, reply.payload).toBe(200);
      const state = new URL(reply.json<{ url: string }>().url).searchParams.get(
        'state',
      );
      return {
        callback: `/v1/auth/federation/social/callback/google?state=${String(state)}&code=${CANARY}`,
        cookie: `pertexo_signin=${setCookie(reply, 'pertexo_signin')}`,
      };
    }
    it('logs a rejected social authorization once without its exception', async () => {
      failure = 'authorize';
      const reply = await observe(
        () =>
          api.send('POST', '/v1/auth/sign-in/social', {
            payload: { provider: 'google' },
          }),
        'social_start',
        'provider_unavailable',
      );
      expect(reply.statusCode).toBe(503);
    });
    it.each(['verify', 'refuse'] as const)(
      'distinguishes social %s from a dependency failure',
      async (mode) => {
        const journey = await social();
        failure = mode;
        const reply = await observe(
          () =>
            api.send('GET', journey.callback, {
              headers: { cookie: journey.cookie },
            }),
          'social_callback',
          mode === 'verify' ? 'provider_unavailable' : 'proof_refused',
          mode === 'verify' ? 'failed' : 'refused',
        );
        expect(reply.headers.location).toContain('socialError=true');
      },
    );
    it('logs a real storage failure once without SQL values', async () => {
      await api
        .database()
        .query(
          `create function app.fail_social_start() returns trigger language plpgsql as $$ begin raise exception '${CANARY}'; end $$`,
        );
      await api
        .database()
        .query(
          'create trigger fail_social_start before insert on app.auth_sign_in_attempts for each row execute function app.fail_social_start()',
        );
      try {
        const reply = await observe(
          () =>
            api.send('POST', '/v1/auth/sign-in/social', {
              payload: { provider: 'google' },
            }),
          'social_start',
          'storage_unavailable',
        );
        expect(reply.statusCode).toBe(503);
      } finally {
        await api
          .database()
          .query('drop trigger fail_social_start on app.auth_sign_in_attempts');
        await api.database().query('drop function app.fail_social_start()');
      }
    });
    it('logs organization start gateway failure once with response correlation', async () => {
      const f = await api.setup();
      const reject = vi
        .spyOn(api.gateway, 'authorize')
        .mockRejectedValueOnce(new Error(CANARY));
      try {
        const reply = await observe(
          () =>
            api.send('POST', '/v1/auth/federation/oidc/start', {
              payload: { providerId: f.providerId, domain: f.domain },
            }),
          'oidc_start',
          'provider_unavailable',
        );
        expect(reply.statusCode).toBe(503);
      } finally {
        reject.mockRestore();
      }
    });
    it.each(['authorize', 'verify', 'refuse'] as const)(
      'logs link %s once without disclosing proofs',
      async (mode) => {
        const address = `link-log-${randomUUID()}@example.test`;
        await api.signUp(address, '/workspaces');
        const browser = await api.signIn(address);
        privateValues.add(browser.session);
        const start = () =>
          api.send('POST', '/v1/auth/account-security/methods/link/start', {
            browser,
            payload: {
              provider: 'google',
              existingMethod: {
                kind: 'password',
                password: 'a long enough integration password',
              },
            },
          });
        if (mode === 'authorize') {
          failure = mode;
          expect(
            (await observe(start, 'link_start', 'provider_unavailable'))
              .statusCode,
          ).toBe(503);
          return;
        }
        const begun = await start();
        expect(begun.statusCode, begun.payload).toBe(200);
        const state = new URL(
          begun.json<{ authorizationUrl: string }>().authorizationUrl,
        ).searchParams.get('state');
        failure = mode;
        const reply = await observe(
          () =>
            api.send(
              'GET',
              `/v1/auth/account-security/methods/link/callback/google?state=${String(state)}&code=${CANARY}`,
              {
                headers: {
                  cookie: `${browser.cookie}; pertexo_link=${setCookie(begun, 'pertexo_link')}`,
                },
              },
            ),
          'link_callback',
          mode === 'verify' ? 'provider_unavailable' : 'proof_refused',
          mode === 'verify' ? 'failed' : 'refused',
        );
        expect(reply.headers.location).toContain('linkError=true');
      },
    );

    it('logs source-to-target link authorization failure without losing the source method', async () => {
      email = `source-log-${randomUUID()}@example.test`;
      subject = randomUUID();
      await api.signUp(email, '/workspaces');
      const browser = await api.signIn(email);
      await api
        .database()
        .query(
          "insert into app.auth_accounts(id,user_id,provider_id,account_id) select $1,id,'google',$2 from app.users where email=$3",
          [randomUUID(), subject, email],
        );
      const begun = await api.send(
        'POST',
        '/v1/auth/account-security/methods/link/start',
        {
          browser,
          payload: {
            provider: 'github',
            existingMethod: { kind: 'social', provider: 'google' },
          },
        },
      );
      expect(begun.statusCode, begun.payload).toBe(200);
      const state = new URL(
        begun.json<{ authorizationUrl: string }>().authorizationUrl,
      ).searchParams.get('state');
      failure = 'authorize';
      const reply = await observe(
        () =>
          api.send(
            'GET',
            `/v1/auth/account-security/methods/link/callback/google?state=${String(state)}&code=${CANARY}`,
            {
              headers: {
                cookie: `${browser.cookie}; pertexo_link=${setCookie(begun, 'pertexo_link')}`,
              },
            },
          ),
        'link_callback',
        'provider_unavailable',
      );
      expect(reply.headers.location).toContain('linkError=true');
      expect(
        (
          await api
            .database()
            .query(
              'select provider_id from app.auth_accounts where account_id=$1',
              [subject],
            )
        ).rows,
      ).toEqual([{ provider_id: 'google' }]);
    });
    it('logs unexpected provisioning storage failure once without exposing the bearer or SQL exception', async () => {
      const f = await api.setup();
      const created = await api.send(
        'POST',
        `/v1/workspaces/${f.workspaceId}/sso/directory/credentials`,
        {
          browser: f.owner,
          headers: { 'idempotency-key': randomUUID() },
          payload: { name: 'Diagnostic credential', expectedRevision: 4 },
        },
      );
      expect(created.statusCode, created.payload).toBe(201);
      const credential = created.json<{ secret: string }>();
      privateValues.add(credential.secret);
      await api
        .database()
        .query(
          `create function app.fail_directory_write() returns trigger language plpgsql as $$ begin raise exception '${CANARY}'; end $$`,
        );
      await api
        .database()
        .query(
          'create trigger fail_directory_write before insert on app.auth_directory_users for each row execute function app.fail_directory_write()',
        );
      try {
        const reply = await observe(
          () =>
            api.send(
              'POST',
              `/v1/auth/federation/scim/${String(f.settings.organization?.id)}/v2/Users`,
              {
                headers: {
                  authorization: `Bearer ${credential.secret}`,
                  'content-type': 'application/scim+json',
                },
                payload: {
                  schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
                  userName: `person@${f.domain}`,
                  emails: [{ value: `person@${f.domain}`, primary: true }],
                  active: true,
                },
              },
            ),
          'directory',
          'internal_failure',
        );
        expect(reply.statusCode, reply.payload).toBe(500);
        expect(reply.payload).not.toContain(credential.secret);
      } finally {
        await api
          .database()
          .query(
            'drop trigger fail_directory_write on app.auth_directory_users',
          );
        await api.database().query('drop function app.fail_directory_write()');
      }
    });
    it('logs session delivery failure after a committed social account change once', async () => {
      const journey = await social();
      await api
        .database()
        .query(
          `create function app.fail_session_delivery() returns trigger language plpgsql as $$ begin new.token='delivery-failed:'||new.token; return new; end $$`,
        );
      await api
        .database()
        .query(
          'create trigger fail_session_delivery before insert on app.auth_sessions for each row execute function app.fail_session_delivery()',
        );
      try {
        const reply = await observe(
          () =>
            api.send('GET', journey.callback, {
              headers: { cookie: journey.cookie },
            }),
          'social_callback',
          'session_delivery_failed',
        );
        expect(reply.headers.location).toContain('socialError=true');
        expect(reply.headers['set-cookie']).not.toEqual(
          expect.arrayContaining([
            expect.stringMatching(/^pertexo_session=[^;]/u),
          ]),
        );
        expect(
          (
            await api
              .database()
              .query(
                'select provider_id from app.auth_accounts where account_id=$1',
                [subject],
              )
          ).rows,
        ).toEqual([{ provider_id: 'google' }]);
      } finally {
        await api
          .database()
          .query('drop trigger fail_session_delivery on app.auth_sessions');
        await api.database().query('drop function app.fail_session_delivery()');
      }
    });

    it('keeps committed linking and logs one reauthentication instruction when session delivery fails', async () => {
      email = `delivery-link-${randomUUID()}@example.test`;
      subject = randomUUID();
      await api.signUp(email, '/workspaces');
      const browser = await api.signIn(email);
      const begun = await api.send(
        'POST',
        '/v1/auth/account-security/methods/link/start',
        {
          browser,
          payload: {
            provider: 'google',
            existingMethod: {
              kind: 'password',
              password: 'a long enough integration password',
            },
          },
        },
      );
      expect(begun.statusCode, begun.payload).toBe(200);
      const state = new URL(
        begun.json<{ authorizationUrl: string }>().authorizationUrl,
      ).searchParams.get('state');
      await api
        .database()
        .query(
          `create function app.fail_link_delivery() returns trigger language plpgsql as $$ begin new.token='delivery-failed:'||new.token; return new; end $$`,
        );
      await api
        .database()
        .query(
          'create trigger fail_link_delivery before insert on app.auth_sessions for each row execute function app.fail_link_delivery()',
        );
      try {
        const reply = await observe(
          () =>
            api.send(
              'GET',
              `/v1/auth/account-security/methods/link/callback/google?state=${String(state)}&code=${CANARY}`,
              {
                headers: {
                  cookie: `${browser.cookie}; pertexo_link=${setCookie(begun, 'pertexo_link')}`,
                },
              },
            ),
          'link_callback',
          'session_delivery_failed',
        );
        expect(reply.headers.location).toContain('link_reauthenticate');
        expect(
          (
            await api
              .database()
              .query(
                'select provider_id from app.auth_accounts where account_id=$1',
                [subject],
              )
          ).rows,
        ).toEqual([{ provider_id: 'google' }]);
        expect(
          (await api.send('GET', '/v1/users/me', { browser })).statusCode,
        ).toBe(401);
      } finally {
        await api
          .database()
          .query('drop trigger fail_link_delivery on app.auth_sessions');
        await api.database().query('drop function app.fail_link_delivery()');
      }
    });
  },
);
