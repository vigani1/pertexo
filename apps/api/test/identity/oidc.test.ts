import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  IdentityError,
  OidcLoginService,
  type OidcAuthorizationRequest,
  type OidcLoginTransaction,
  type OidcLoginTransactionStore,
  type OidcProviderPort,
  type OidcTokenResponse,
} from '../../src/identity/index.js';

const configuration = {
  issuer: 'https://issuer.example.test',
  authorizationEndpoint: 'https://issuer.example.test/authorize',
  clientId: 'pertexo-web',
  redirectUri: 'https://app.example.test/auth/callback',
  scopes: ['openid'],
  transactionTtlMillis: 300_000,
} as const;
const userId = '11111111-1111-4111-8111-111111111111';

function defined<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('test fixture value is missing');
  return value;
}

class FakeClock {
  current = new Date('2026-08-20T12:00:00.000Z');
  now = (): Date => new Date(this.current);
}

class FakeTransactions implements OidcLoginTransactionStore {
  readonly records = new Map<string, OidcLoginTransaction>();
  readonly consumed = new Set<string>();

  create(transaction: OidcLoginTransaction): Promise<void> {
    this.records.set(transaction.stateDigest, transaction);
    return Promise.resolve();
  }

  consume(stateDigest: string, browserBindingDigest: string, now: Date) {
    const transaction = this.records.get(stateDigest);
    if (transaction === undefined)
      return Promise.resolve({ status: 'missing' as const });
    if (this.consumed.has(stateDigest))
      return Promise.resolve({ status: 'replayed' as const });
    if (now >= transaction.expiresAt)
      return Promise.resolve({ status: 'expired' as const });
    if (browserBindingDigest !== transaction.browserBindingDigest)
      return Promise.resolve({ status: 'binding_mismatch' as const });
    this.consumed.add(stateDigest);
    return Promise.resolve({ status: 'ok' as const, transaction });
  }
}

class FakeProvider implements OidcProviderPort {
  request?: OidcAuthorizationRequest;
  response: OidcTokenResponse = {
    issuer: configuration.issuer,
    subject: 'subject-123',
    audience: configuration.clientId,
    nonce: 'not-set',
    email: 'person@example.test',
    displayName: 'Test Person',
    emailVerified: true,
  };

  authorizationUrl(request: OidcAuthorizationRequest): string {
    this.request = request;
    const url = new URL(configuration.authorizationEndpoint);
    url.searchParams.set('state', request.state);
    url.searchParams.set('nonce', request.nonce);
    url.searchParams.set('code_challenge', request.codeChallenge);
    url.searchParams.set('code_challenge_method', request.codeChallengeMethod);
    return url.toString();
  }

  exchangeCode(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }) {
    expect(input.code).toBe('one-time-code');
    expect(input.redirectUri).toBe(configuration.redirectUri);
    expect(input.codeVerifier).toBe(this.requestVerifier);
    return Promise.resolve(this.response);
  }

  requestVerifier = '';
}

function service(
  clock: FakeClock,
  transactions = new FakeTransactions(),
  provider = new FakeProvider(),
) {
  const mapper = {
    mapExternalIdentity: (
      identity: { issuer: string; subject: string },
      profile: { email: string; displayName: string },
    ) => {
      expect(identity.subject).toBe('subject-123');
      expect(profile.email).toBe('person@example.test');
      return Promise.resolve({
        userId,
        authenticationIdentityId: '22222222-2222-4222-8222-222222222222',
      });
    },
  };
  const app = new OidcLoginService(
    configuration,
    transactions,
    provider,
    mapper,
    { clock },
  );
  return { app, transactions, provider };
}

describe('managed OIDC application service', () => {
  it('starts authorization with random state, nonce, and S256 PKCE while storing only state digest', async () => {
    const setup = service(new FakeClock());
    const start = await setup.app.startLogin();
    const request = setup.provider.request;

    expect(request).toBeDefined();
    expect(request?.state).toBeTruthy();
    expect(request?.nonce).toBeTruthy();
    expect(request?.codeChallengeMethod).toBe('S256');
    expect(request?.codeChallenge).toBe(
      createHash('sha256')
        .update(
          setup.transactions.records.values().next().value?.codeVerifier ?? '',
        )
        .digest('base64url'),
    );
    expect(start.authorizationUrl).toContain('code_challenge_method=S256');
    const transaction = setup.transactions.records.values().next().value;
    expect(transaction?.stateDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(transaction?.stateDigest).not.toBe(request?.state);
    expect(transaction?.stateDigest).not.toContain(request?.state ?? 'never');
    expect(transaction?.browserBindingDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(transaction?.browserBindingDigest).not.toBe(start.browserBinding);
    expect(transaction?.codeVerifier).not.toBe(request?.codeChallenge);
  });

  it('verifies issuer, audience, nonce, subject and maps the stable external identity', async () => {
    const setup = service(new FakeClock());
    const start = await setup.app.startLogin();
    const transaction = defined(
      setup.transactions.records.values().next().value,
    );
    setup.provider.requestVerifier = transaction.codeVerifier;
    setup.provider.response = {
      ...setup.provider.response,
      nonce: transaction.nonce,
    };

    const result = await setup.app.completeLogin(
      {
        code: 'one-time-code',
        state: defined(setup.provider.request).state,
      },
      start.browserBinding,
    );
    expect(result).toEqual({
      externalIdentity: {
        issuer: configuration.issuer,
        subject: 'subject-123',
      },
      internalIdentity: {
        userId,
        authenticationIdentityId: '22222222-2222-4222-8222-222222222222',
      },
      verifiedProfile: {
        email: 'person@example.test',
        displayName: 'Test Person',
        emailVerified: true,
      },
    });
  });

  it.each([
    ['tampered state', 'state', 'identity.transaction_missing'],
    ['expired transaction', 'expired', 'identity.transaction_expired'],
    ['replayed transaction', 'replayed', 'identity.transaction_replayed'],
  ])('rejects %s', async (_name, mode, expected) => {
    const clock = new FakeClock();
    const setup = service(clock);
    const start = await setup.app.startLogin();
    const state = defined(setup.provider.request).state;
    if (mode === 'expired')
      clock.current = new Date('2026-08-20T12:10:00.000Z');
    const callbackState = mode === 'state' ? `${state}tampered` : state;
    if (mode === 'replayed') {
      await expect(
        setup.app.completeLogin(
          { code: 'one-time-code', state },
          start.browserBinding,
        ),
      ).rejects.toMatchObject({
        code: 'identity.provider_unavailable',
      });
    }
    await expect(
      setup.app.completeLogin(
        { code: 'one-time-code', state: callbackState },
        start.browserBinding,
      ),
    ).rejects.toMatchObject({
      code: expected,
    });
    expect(start.authorizationUrl).toBeTruthy();
  });

  it('rejects a different browser binding without consuming the transaction', async () => {
    const setup = service(new FakeClock());
    const start = await setup.app.startLogin();
    const state = defined(setup.provider.request).state;

    await expect(
      setup.app.completeLogin(
        { code: 'one-time-code', state },
        'wrong-browser',
      ),
    ).rejects.toMatchObject({ code: 'identity.callback_rejected' });

    const transaction = defined(
      setup.transactions.records.values().next().value,
    );
    setup.provider.requestVerifier = transaction.codeVerifier;
    setup.provider.response = {
      ...setup.provider.response,
      nonce: transaction.nonce,
    };
    await expect(
      setup.app.completeLogin(
        { code: 'one-time-code', state },
        start.browserBinding,
      ),
    ).resolves.toMatchObject({ internalIdentity: { userId } });
  });

  it.each([
    [
      'issuer',
      { issuer: 'https://evil.example.test' },
      'identity.issuer_mismatch',
    ],
    ['audience', { audience: 'another-client' }, 'identity.audience_mismatch'],
    ['nonce', { nonce: 'wrong-nonce' }, 'identity.nonce_mismatch'],
    ['subject', { subject: '' }, 'identity.subject_missing'],
  ])('rejects a tampered %s claim', async (_name, change, expected) => {
    const setup = service(new FakeClock());
    const start = await setup.app.startLogin();
    const transaction = defined(
      setup.transactions.records.values().next().value,
    );
    setup.provider.requestVerifier = transaction.codeVerifier;
    setup.provider.response = {
      ...setup.provider.response,
      nonce: transaction.nonce,
      ...change,
    };
    await expect(
      setup.app.completeLogin(
        {
          code: 'one-time-code',
          state: defined(setup.provider.request).state,
        },
        start.browserBinding,
      ),
    ).rejects.toMatchObject({
      code: expected,
    });
  });

  it('classifies opaque provider failures as unavailable without exposing secret values', async () => {
    const setup = service(new FakeClock());
    const start = await setup.app.startLogin();
    setup.provider.exchangeCode = () => {
      throw new Error('provider-token-should-never-escape');
    };
    const login = setup.app.completeLogin(
      {
        code: 'one-time-code',
        state: defined(setup.provider.request).state,
      },
      start.browserBinding,
    );
    await expect(login).rejects.toBeInstanceOf(IdentityError);
    await expect(login).rejects.toMatchObject({
      code: 'identity.provider_unavailable',
      status: 503,
    });
    await expect(login).rejects.not.toThrow('provider-token');
  });

  it('requires bounded verified profile fields for first-user mapping', async () => {
    const setup = service(new FakeClock());
    const start = await setup.app.startLogin();
    const transaction = defined(
      setup.transactions.records.values().next().value,
    );
    setup.provider.requestVerifier = transaction.codeVerifier;
    const responseWithoutEmail = {
      issuer: setup.provider.response.issuer,
      subject: setup.provider.response.subject,
      audience: setup.provider.response.audience,
      nonce: setup.provider.response.nonce,
    };
    setup.provider.response = {
      ...responseWithoutEmail,
      nonce: transaction.nonce,
    };
    await expect(
      setup.app.completeLogin(
        {
          code: 'one-time-code',
          state: defined(setup.provider.request).state,
        },
        start.browserBinding,
      ),
    ).rejects.toMatchObject({
      code: 'identity.profile_incomplete',
    });

    const bounded = service(new FakeClock());
    const boundedStart = await bounded.app.startLogin();
    const boundedTransaction = defined(
      bounded.transactions.records.values().next().value,
    );
    bounded.provider.requestVerifier = boundedTransaction.codeVerifier;
    bounded.provider.response = {
      ...bounded.provider.response,
      nonce: boundedTransaction.nonce,
      displayName: 'x'.repeat(257),
    };
    await expect(
      bounded.app.completeLogin(
        {
          code: 'one-time-code',
          state: defined(bounded.provider.request).state,
        },
        boundedStart.browserBinding,
      ),
    ).rejects.toMatchObject({
      code: 'identity.callback_rejected',
    });
  });

  it('rejects malformed mapper identities and unsafe provider authorization URLs', async () => {
    const malformedMapper = {
      mapExternalIdentity: () => Promise.resolve({ userId: 'not-a-uuid' }),
    };

    const mapperTransactions = new FakeTransactions();
    const mapperProvider = new FakeProvider();
    const mapperService = new OidcLoginService(
      configuration,
      mapperTransactions,
      mapperProvider,
      malformedMapper,
    );
    const mapperStart = await mapperService.startLogin();
    const transaction = defined(
      mapperTransactions.records.values().next().value,
    );
    mapperProvider.requestVerifier = transaction.codeVerifier;
    mapperProvider.response = {
      ...mapperProvider.response,
      nonce: transaction.nonce,
    };
    await expect(
      mapperService.completeLogin(
        {
          code: 'one-time-code',
          state: defined(mapperProvider.request).state,
        },
        mapperStart.browserBinding,
      ),
    ).rejects.toMatchObject({ code: 'identity.mapping_failed' });

    const unsafeProvider = new FakeProvider();
    unsafeProvider.authorizationUrl = () =>
      'ftp://issuer.example.test/authorize';
    const unsafeService = new OidcLoginService(
      configuration,
      new FakeTransactions(),
      unsafeProvider,
      { mapExternalIdentity: () => Promise.resolve({ userId }) },
    );
    await expect(unsafeService.startLogin()).rejects.toMatchObject({
      code: 'identity.provider_rejected',
    });
  });
});
