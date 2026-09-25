import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  betterAuthIntegrationEnabled,
  expectProblem,
  origin,
  useBetterAuthRealApi,
} from '../support/better-auth-real-api.integration.support.js';

/*
 * Better Auth-only self-service (ADR 043): sign-up and resent verification
 * links keep only an allowlisted return path, and the signed-in person renames
 * themselves at the profile revision they saw.
 */
describe.runIf(betterAuthIntegrationEnabled)(
  'Better Auth-only self-service',
  () => {
    const api = useBetterAuthRealApi('self');

    it('carries only an allowlisted return path through email verification', async () => {
      const hostile = await api.signUp(
        `${randomUUID()}@example.test`,
        '/login?verified=true&returnTo=%2F%2Fevil.example%2Faccount%2Fsecurity',
      );
      expect(hostile.link.searchParams.has('returnTo')).toBe(false);
      expect(hostile.landing.searchParams.has('returnTo')).toBe(false);
      const invited = await api.signUp(
        `${randomUUID()}@example.test`,
        '/login?verified=true&returnTo=%2Finvitations%2Faccept',
      );
      expect(invited.link.searchParams.get('returnTo')).toBe(
        '/invitations/accept',
      );
      expect(`${invited.landing.origin}${invited.landing.pathname}`).toBe(
        `${origin}/login`,
      );
      expect(invited.landing.searchParams.get('verified')).toBe('true');
      expect(invited.landing.searchParams.get('returnTo')).toBe(
        '/invitations/accept',
      );
    });

    it('keeps an allowlisted return path on a resent verification link', async () => {
      const email = `${randomUUID()}@example.test`;
      const created = await api.send('POST', '/v1/auth/sign-up/email', {
        payload: {
          name: 'New Person',
          email,
          password: 'a long enough integration password',
          callbackURL: '/login?verified=true',
        },
      });
      expect(created.statusCode, created.payload).toBe(200);
      expect(
        api.mailedLink(email, 'verification').searchParams.has('returnTo'),
      ).toBe(false);

      for (const [callbackURL, returnTo] of [
        ['/login?verified=true&returnTo=%2F%2Fevil.example', null],
        [
          '/login?verified=true&returnTo=%2Faccount%2Fsecurity',
          '/account/security',
        ],
      ] as const) {
        const resent = await api.send(
          'POST',
          '/v1/auth/send-verification-email',
          { payload: { email, callbackURL } },
        );
        expect(resent.statusCode, resent.payload).toBe(200);
        expect(
          api.mailedLink(email, 'verification').searchParams.get('returnTo'),
        ).toBe(returnTo);
      }
    });

    it('renames the signed-in user at the profile revision they saw', async () => {
      const email = `${randomUUID()}@example.test`;
      await api.signUp(email, '/login?verified=true');
      const browser = await api.signIn(email);
      const url = '/v1/users/me';
      const key = { 'idempotency-key': `profile-${randomUUID()}` };

      const missingCsrf = await api.send('PATCH', url, {
        headers: { cookie: browser.cookie, ...key },
        payload: { displayName: 'Ada Lovelace', expectedRevision: 1 },
      });
      expect(missingCsrf.statusCode).toBe(403);
      const invalid = await api.send('PATCH', url, {
        browser,
        headers: key,
        payload: { displayName: 'Ada\nLovelace', expectedRevision: 1 },
      });
      expect(invalid.statusCode).toBe(400);
      const renamed = await api.send('PATCH', url, {
        browser,
        headers: key,
        payload: { displayName: ' Ada Lovelace ', expectedRevision: 1 },
      });
      expect(renamed.statusCode, renamed.payload).toBe(200);
      expect(renamed.json()).toMatchObject({
        profile: { displayName: 'Ada Lovelace', revision: 2 },
        changed: true,
        replayed: false,
      });
      const replay = await api.send('PATCH', url, {
        browser,
        headers: key,
        payload: { displayName: ' Ada Lovelace ', expectedRevision: 1 },
      });
      expect(replay.json()).toMatchObject({ replayed: true });
      const stale = await api.send('PATCH', url, {
        browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: { displayName: 'Someone Else', expectedRevision: 1 },
      });
      expectProblem(stale, 412, 'user.profile_revision_conflict');
      const current = await api.send('GET', url, { browser });
      expect(current.json()).toMatchObject({
        email,
        displayName: 'Ada Lovelace',
        revision: 2,
      });
    });
  },
);
