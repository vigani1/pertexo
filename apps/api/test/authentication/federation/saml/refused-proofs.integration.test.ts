import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { federationFailureReasonSchema } from '@pertexo/contracts';
import { betterAuthIntegrationEnabled } from '../../../support/better-auth/real-api.support.js';
import { useSamlApi } from './api.fixture.js';
import type { ResponseOptions } from './fixture.js';

const SAML = 'urn:oasis:names:tc:SAML:2.0';
/** Text only an assertion could hold, to look for wherever a refusal leaves a trace. */
const MARKER = 'leak-canary-7f3a';

const REFUSALS: readonly (readonly [
  (typeof federationFailureReasonSchema)['options'][number],
  (domain: string) => ResponseOptions,
])[] = [
  ['saml_destination', () => ({ destination: `https://${MARKER}.test/cb` })],
  ['saml_request', () => ({ requestId: `_${MARKER}` })],
  ['saml_issuer', () => ({ responseIssuer: `urn:${MARKER}` })],
  ['saml_status', () => ({ status: `${SAML}:status:Responder` })],
  [
    'saml_assertion_count',
    () => ({
      additionalAttributes: `<saml:Attribute Name="note"><saml:AttributeValue><saml:Assertion ID="_nested" Version="2.0"/></saml:AttributeValue></saml:Attribute>`,
    }),
  ],
  ['saml_signature_count', () => ({ signResponse: false })],
  ['saml_signature_algorithm', () => ({ sha1: true })],
  ['saml_time', () => ({ expiresAt: '2020-01-01T00:00:00.000Z' })],
  ['saml_audience', () => ({ audience: `https://${MARKER}.test/sp` })],
  ['saml_name_id', () => ({ nameIdFormat: `${SAML}:nameid-format:transient` })],
  [
    'saml_subject_confirmation',
    () => ({ recipient: `https://${MARKER}.test` }),
  ],
  ['saml_unreadable', () => ({ omitConfirmation: true })],
  ['identity_claims', () => ({ email: `${MARKER} is not an address` })],
  ['email_domain', () => ({ email: `${MARKER}@elsewhere.example.test` })],
];

describe.skipIf(!betterAuthIntegrationEnabled)(
  'a refused SAML proof, through the real API',
  () => {
    const api = useSamlApi('saml_refused_proofs');
    let fixture: Awaited<ReturnType<typeof api.setup>>;
    let warnings: ReturnType<typeof vi.spyOn>;

    beforeAll(async () => {
      fixture = await api.setup();
      warnings = vi.spyOn(Logger.prototype, 'warn');
    }, 60_000);
    afterAll(() => {
      warnings.mockRestore();
    });

    const sessionCount = async () => {
      const { rows } = await api
        .database()
        .query<{ count: string }>('select count(*) from app.auth_sessions');
      return Number(rows[0]?.count);
    };
    const userCount = async () => {
      const { rows } = await api
        .database()
        .query<{ count: string }>('select count(*) from app.users');
      return Number(rows[0]?.count);
    };
    const loggedSince = (mark: number) =>
      warnings.mock.calls
        .slice(mark)
        .flat()
        .map((value: unknown) => String(value));

    it.each(REFUSALS)(
      '%s tells the owner testing why',
      async (reason, options) => {
        const journey = await api.start(fixture, true);
        const mark = warnings.mock.calls.length;
        const reply = await api.finish(
          fixture,
          journey,
          options(fixture.domain),
        );
        const landing = new URL(String(reply.headers.location));
        expect(landing.searchParams.get('ssoTest')).toBe('failed');
        expect(landing.searchParams.get('ssoReason')).toBe(reason);
        expect(loggedSince(mark)).toEqual([
          `Organization test failed: saml ${reason}`,
        ]);
      },
    );

    it.each(REFUSALS)(
      '%s signs nobody in, shows a generic page and logs only the code',
      async (reason, options) => {
        const journey = await api.start(fixture);
        const before = {
          sessions: await sessionCount(),
          users: await userCount(),
        };
        const mark = warnings.mock.calls.length;

        const reply = await api.finish(
          fixture,
          journey,
          options(fixture.domain),
        );

        const landing = new URL(String(reply.headers.location));
        expect(landing.pathname).toBe('/login');
        expect(landing.searchParams.get('ssoError')).toBe('true');
        expect(landing.searchParams.has('ssoReason')).toBe(false);
        expect(landing.searchParams.has('ssoTest')).toBe(false);
        expect(reply.headers.location).not.toContain(MARKER);
        expect(reply.payload).not.toContain(MARKER);
        expect(reply.headers['set-cookie'] ?? '').not.toContain(
          'session_token=',
        );
        expect({
          sessions: await sessionCount(),
          users: await userCount(),
        }).toEqual(before);
        const logged = loggedSince(mark);
        expect(logged).toEqual([`Organization sign-in failed: saml ${reason}`]);
        expect(logged.join()).not.toContain(MARKER);
        expect(logged.join()).not.toContain(fixture.domain);
      },
    );

    it('refuses a response altered after signing, naming only the signature', async () => {
      const journey = await api.start(fixture);
      const form = new URLSearchParams(
        api.form(fixture, journey, { subject: `person-${MARKER}` }),
      );
      const before = await sessionCount();
      const mark = warnings.mock.calls.length;
      form.set(
        'SAMLResponse',
        Buffer.from(
          Buffer.from(form.get('SAMLResponse') ?? '', 'base64')
            .toString()
            .replace(`person-${MARKER}`, `victim-${MARKER}`),
        ).toString('base64'),
      );

      const reply = await api.send(
        'POST',
        '/v1/auth/federation/saml/callback',
        {
          headers: {
            cookie: journey.cookie,
            origin: 'https://idp.example.test',
            'content-type': 'application/x-www-form-urlencoded',
          },
          payload: form.toString(),
        },
      );

      expect(new URL(String(reply.headers.location)).pathname).toBe('/login');
      expect(await sessionCount()).toBe(before);
      expect(loggedSince(mark)).toEqual([
        'Organization sign-in failed: saml saml_signature_invalid',
      ]);
    });

    it('refuses a callback with no browser cookie, and one for a journey that is not there', async () => {
      const journey = await api.start(fixture);
      const before = await sessionCount();
      const mark = warnings.mock.calls.length;
      const send = (cookie: string, form: string) =>
        api.send('POST', '/v1/auth/federation/saml/callback', {
          headers: {
            cookie,
            origin: 'https://idp.example.test',
            'content-type': 'application/x-www-form-urlencoded',
          },
          payload: form,
        });
      const form = api.form(fixture, journey);
      await send('', form);
      const elsewhere = new URLSearchParams(form);
      elsewhere.set('RelayState', 'x'.repeat(43));
      await send(journey.cookie, elsewhere.toString());

      expect(loggedSince(mark)).toEqual([
        'Organization sign-in failed: saml callback_invalid',
        'Organization sign-in failed: saml attempt_unavailable',
      ]);
      expect(await sessionCount()).toBe(before);
    });

    it('calls a good proof core refuses account_refused, for a person it knows and has shut out', async () => {
      const email = `shut-out@${fixture.domain}`;
      await api.signUp(email, '/workspaces');
      await api
        .database()
        .query("update app.users set status='suspended' where email=$1", [
          email,
        ]);
      const before = await sessionCount();
      const mark = warnings.mock.calls.length;
      const journey = await api.start(fixture);
      const reply = await api.finish(fixture, journey, { email });
      const landing = new URL(String(reply.headers.location));
      expect(landing.pathname).toBe('/login');
      expect(landing.searchParams.has('ssoReason')).toBe(false);
      expect(loggedSince(mark)).toEqual([
        'Organization sign-in failed: saml account_refused',
      ]);
      expect(await sessionCount()).toBe(before);
    });

    it('still signs in the same person when the proof is good, or these prove nothing', async () => {
      const journey = await api.start(fixture);
      const before = await sessionCount();
      const reply = await api.finish(fixture, journey);
      const landing = new URL(String(reply.headers.location));
      expect(landing.pathname).toBe('/account/security');
      expect(await sessionCount()).toBe(before + 1);
    });
  },
);
