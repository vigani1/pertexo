import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  authorizeCredentialSignIn,
  isAuthenticationSessionAllowed,
} from '@pertexo/core/identity';
import { Pool } from 'pg';
import { useSocialProviderGateway } from '../../../support/better-auth/social-provider.js';
import {
  betterAuthIntegrationEnabled,
  browserFrom,
  setCookie,
} from '../../../support/better-auth/real-api.support.js';
import { useOrganizationApi } from './fixture.js';

const wide = (value: string) =>
  value.replace(/[!-~]/gu, (character) =>
    String.fromCodePoint(character.charCodeAt(0) + 0xfee0),
  );

describe.runIf(betterAuthIntegrationEnabled)(
  'required SSO for legacy email identities',
  () => {
    let providerEmail = '',
      providerSubject = '';
    useSocialProviderGateway({
      available: ['google'],
      authorize: ({ state }) =>
        Promise.resolve(`https://provider.test/authorize?state=${state}`),
      verify: () =>
        Promise.resolve({
          accountId: providerSubject,
          email: providerEmail,
          emailVerified: true,
          displayName: 'Legacy Person',
        }),
    });
    const api = useOrganizationApi('legacy_email', {
      socialProviders: {
        google: { clientId: 'fixture-client', clientSecret: 'fixture-secret' },
      },
    });
    it.each([false, true])(
      'applies canonical policy without rewriting the legacy address; recovery owner=%s',
      async (owner) => {
        const f = await api.setup(owner);
        const email = owner ? f.ownerEmail : `member@${f.domain}`;
        if (!owner) await api.signUp(email, '/workspaces');
        const signedIn = owner ? f.owner : await api.signIn(email);
        const {
          rows: [user],
        } = await api
          .database()
          .query<{ id: string }>('select id from app.users where email=$1', [
            email,
          ]);
        if (user === undefined) throw new Error('Legacy fixture user missing');
        providerEmail = email;
        providerSubject = randomUUID();
        await api
          .database()
          .query(
            `insert into app.auth_accounts(id,user_id,provider_id,account_id) values($1,$2,'google',$3)`,
            [randomUUID(), user.id, providerSubject],
          );
        await api.ready(f);
        const legacy = wide(email);
        await api
          .database()
          .query('update app.users set email=$1 where id=$2', [
            legacy,
            user.id,
          ]);
        // Email updates revoke sessions. Issue a genuine signed replacement for the same person.
        const issued = await api.identity().betterAuth.sessions.issue(user.id);
        await api
          .database()
          .query(
            "update app.auth_sessions set authentication_method='credential' where id=$1",
            [issued.sessionId],
          );
        const cookie =
          issued.setCookies.map((value) => value.split(';')[0]).join('; ') +
          `; pertexo_csrf=${encodeURIComponent(signedIn.csrf)}`;
        const before = await api.send('GET', '/v1/users/me', {
          headers: { cookie },
        });
        expect(before.statusCode, before.payload).toBe(200);
        const sessionIds = (
          await api
            .database()
            .query<{ id: string }>(
              'select id from app.auth_sessions where user_id=$1',
              [user.id],
            )
        ).rows;
        // The owner whose stored email changed needs the newly issued cookie for enforcement.
        await api.enforce(owner ? { ...f, owner: { ...signedIn, cookie } } : f);
        const appUrl = new URL(api.database().options.connectionString ?? '');
        const base = new URL(process.env.DATABASE_URL ?? '');
        base.pathname = appUrl.pathname;
        const pool = new Pool({ connectionString: base.toString(), max: 1 });
        try {
          expect(await authorizeCredentialSignIn(pool, user.id)).toBe(
            owner ? 'recovery' : 'sso_required',
          );
          const probe = randomUUID();
          await api
            .database()
            .query(
              "insert into app.auth_sessions(id,user_id,token,expires_at) values($1,$2,$3,clock_timestamp()+interval '1 hour')",
              [probe, user.id, randomUUID()],
            );
          try {
            expect(await isAuthenticationSessionAllowed(pool, probe)).toBe(
              owner,
            );
          } finally {
            await api
              .database()
              .query('delete from app.auth_sessions where id=$1', [probe]);
          }
        } finally {
          await pool.end();
        }
        const after = await api.send('GET', '/v1/users/me', {
          headers: { cookie },
        });
        expect(after.statusCode).toBe(401);
        const retained = (
          await api
            .database()
            .query<{ id: string }>(
              'select id from app.auth_sessions where user_id=$1',
              [user.id],
            )
        ).rows;
        expect(sessionIds).toHaveLength(1);
        expect(retained).toEqual([]);
        const social = await api.send('POST', '/v1/auth/sign-in/social', {
          payload: { provider: 'google', callbackURL: '/workspaces' },
        });
        expect(social.statusCode, social.payload).toBe(200);
        const state = new URL(
          social.json<{ url: string }>().url,
        ).searchParams.get('state');
        const completed = await api.send(
          'GET',
          `/v1/auth/federation/social/callback/google?state=${String(state)}&code=fixture`,
          {
            headers: {
              cookie: `pertexo_signin=${setCookie(social, 'pertexo_signin')}`,
            },
          },
        );
        expect(completed.headers.location).toContain('socialError=true');
        const organization = await api.finish(
          await api.start(f, api.person(email)),
        );
        expect(organization.headers.location).toBe(
          'https://app.integration.test/account/security',
        );
        expect(
          (
            await api.send('GET', '/v1/users/me', {
              browser: browserFrom(organization),
            })
          ).statusCode,
        ).toBe(200);
        expect(
          (
            await api
              .database()
              .query('select email from app.users where id=$1', [user.id])
          ).rows,
        ).toEqual([{ email: legacy }]);
        expect(
          (
            await api
              .database()
              .query(
                'select id from app.users where lower(normalize(email::text,NFKC))=$1',
                [email],
              )
          ).rows,
        ).toEqual([{ id: user.id }]);
      },
    );
  },
);
