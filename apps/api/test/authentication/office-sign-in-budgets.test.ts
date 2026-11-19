import { afterEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { LocalRateLimiter } from '@pertexo/rate-limit/server';
import {
  registerAuthenticationCapabilities,
  registerBetterAuthHandler,
} from '../../src/authentication/better-auth/better-auth-transport.js';
import {
  applications,
  cleanBetterAuthFastifyBridgeFixture,
} from './better-auth-transport.fixture.js';

const ORIGIN = 'https://pertexo.test';

/**
 * The sign-in routes as one office reaches them: every request comes from the
 * same address and is counted by the real policy and limiter, with only the
 * identity library behind them replaced.
 */
function officeServer() {
  const application = Fastify();
  applications.push(application);
  const limiter = new LocalRateLimiter(() => 1_000_000);
  const rateLimitConsumer = {
    consume: (decision: Parameters<LocalRateLimiter['consume']>[0]) =>
      Promise.resolve(limiter.consume(decision)),
  };
  registerAuthenticationCapabilities(
    application,
    {
      password: {
        enabled: true,
        minimumLength: 12,
        verificationRequired: true,
      },
      socialProviders: ['google'],
    },
    () => Promise.resolve(false),
    rateLimitConsumer,
  );
  registerBetterAuthHandler(application, {
    handler: () => Promise.resolve(Response.json({ ok: true })),
    publicOrigin: ORIGIN,
    rateLimitConsumer,
    sessionCookie: { secure: true, sameSite: 'lax', maxAgeSeconds: 3_600 },
  });
  const write = (url: string, payload: object = {}) =>
    application.inject({
      method: 'POST',
      url,
      headers: { origin: ORIGIN },
      payload,
    });
  return {
    readSignInPage: () =>
      application.inject({ method: 'GET', url: '/v1/auth/capabilities' }),
    findProviders: () =>
      application.inject({
        method: 'GET',
        url: '/v1/auth/federation/discover?domain=example.test',
      }),
    startOrganizationSignIn: () =>
      write('/v1/auth/federation/oidc/start', {
        providerId: 'provider',
        domain: 'example.test',
      }),
    finishOrganizationSignIn: () =>
      application.inject({
        method: 'GET',
        url: '/v1/auth/federation/oidc/callback?state=opaque&code=opaque',
      }),
    signInWithPassword: (email: string) =>
      write('/v1/auth/sign-in/email', { email, password: 'wrong-password' }),
    verifyTwoFactorCode: () =>
      write('/v1/auth/two-factor/verify-totp', { code: '000000' }),
  };
}

type Office = ReturnType<typeof officeServer>;

async function organizationSignIn(office: Office) {
  const steps = [
    await office.readSignInPage(),
    await office.findProviders(),
    await office.startOrganizationSignIn(),
    await office.finishOrganizationSignIn(),
  ];
  return steps.map((step) => step.statusCode);
}

type Answer = Readonly<{
  statusCode: number;
  headers: Readonly<Record<string, unknown>>;
}>;

/** A refusal, whether answered as a problem or as a landing on the sign-in page. */
const isRefusal = (response: Answer) =>
  response.statusCode === 429 ||
  String(response.headers.location).endsWith('?error=sign_in_limited');

/** How many times `request` is admitted before the first refusal. */
async function admittedBeforeRefusal(request: () => Promise<Answer>) {
  for (let admitted = 0; admitted <= MOST_REQUESTS_COUNTED; admitted += 1) {
    if (isRefusal(await request())) return admitted;
  }
  throw new Error(`Still admitted after ${String(MOST_REQUESTS_COUNTED)}`);
}

/** Far past any per-address sign-in budget. */
const MOST_REQUESTS_COUNTED = 5_000;

describe('sign-in budgets for many people behind one address', () => {
  afterEach(cleanBetterAuthFastifyBridgeFixture);

  it('lets an office of a hundred people sign in through their organization in one minute', async () => {
    const office = officeServer();
    for (let person = 0; person < 100; person += 1)
      expect(await organizationSignIn(office)).toEqual([200, 200, 200, 200]);
  });

  it('keeps password and two-factor guessing from one address at ten a minute, apart from organization sign-in', async () => {
    const office = officeServer();
    expect(
      await admittedBeforeRefusal(() =>
        office.signInWithPassword(
          `person-${String(Math.random())}@example.test`,
        ),
      ),
    ).toBe(10);
    expect((await office.verifyTwoFactorCode()).statusCode).toBe(429);
    expect(await organizationSignIn(office)).toEqual([200, 200, 200, 200]);
  });

  it('keeps the sign-in page and provider callbacks open when the address has spent its organization sign-in starts', async () => {
    const office = officeServer();
    const starts = await admittedBeforeRefusal(office.startOrganizationSignIn);
    expect(starts).toBeGreaterThanOrEqual(100);
    expect((await office.readSignInPage()).statusCode).toBe(200);
    expect((await office.findProviders()).statusCode).toBe(200);
    expect((await office.finishOrganizationSignIn()).statusCode).toBe(200);
    expect(
      (await office.signInWithPassword('ada@example.test')).statusCode,
    ).toBe(200);
  });

  it('refuses a start past the address ceiling and says when to try again', async () => {
    const office = officeServer();
    await admittedBeforeRefusal(office.startOrganizationSignIn);
    const refused = await office.startOrganizationSignIn();
    expect(refused.statusCode).toBe(429);
    expect(refused.headers['retry-after']).toBe('60');
    expect(refused.json()).toMatchObject({ code: 'request.rate_limited' });
  });

  it('sends a refused provider callback back to the sign-in page with the reason', async () => {
    const office = officeServer();
    await admittedBeforeRefusal(office.finishOrganizationSignIn);
    const refused = await office.finishOrganizationSignIn();
    expect(refused.statusCode).toBe(303);
    expect(refused.headers.location).toBe(
      `${ORIGIN}/login?error=sign_in_limited`,
    );
    expect(refused.headers['retry-after']).toBe('60');
  });

  it('counts the login page reads apart from provider callbacks', async () => {
    const office = officeServer();
    const callbacks = await admittedBeforeRefusal(
      office.finishOrganizationSignIn,
    );
    expect(callbacks).toBeGreaterThanOrEqual(100);
    expect((await office.readSignInPage()).statusCode).toBe(200);
    const reads = await admittedBeforeRefusal(office.readSignInPage);
    expect(reads).toBeGreaterThanOrEqual(2 * 100);
    expect((await office.readSignInPage()).statusCode).toBe(429);
  });
});
