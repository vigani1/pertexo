import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DurableAuthenticationMail,
  GenericOidcProviderAdapter,
  disabledAuthenticationMail,
  type AuthenticationMail,
  type BetterAuthRuntime,
} from '../../src/identity-infrastructure/index.js';
import type { BetterAuthRuntimeConfig } from '../../src/identity-infrastructure/better-auth.js';
import type * as IdentityInfrastructure from '../../src/identity-infrastructure/index.js';
import type { ApiIdentityConfig } from '../../src/platform/config/identity-config.js';
import { composeBetterAuthRuntime } from '../../src/platform/identity/better-auth-composition.js';

const created = vi.hoisted(() => [] as BetterAuthRuntimeConfig[]);

vi.mock(
  '../../src/identity-infrastructure/index.js',
  async (importOriginal) => ({
    ...(await importOriginal<typeof IdentityInfrastructure>()),
    createBetterAuthRuntime: (config: BetterAuthRuntimeConfig) => {
      created.push(config);
      return {
        auth: { handler: () => Promise.resolve(new Response(null)) },
        sessions: {},
        close: () => Promise.resolve(),
      } as unknown as BetterAuthRuntime;
    },
  }),
);

const databaseConfig = {
  connectionString: 'postgresql://api:secret@localhost:5432/pertexo',
  connectionTimeoutMillis: 1_000,
  idleTimeoutMillis: 1_000,
  max: 2,
  ownerRole: 'pertexo_owner',
  workerRuntimeRole: 'pertexo_worker',
};
const session = {
  ttlMillis: 90_000,
  secureCookie: true,
  sameSite: 'lax' as const,
};
const oidc: NonNullable<ApiIdentityConfig['oidc']> = {
  issuer: 'https://identity.example.test',
  authorizationEndpoint: 'https://identity.example.test/authorize',
  tokenEndpoint: 'https://identity.example.test/token',
  jwksUri: 'https://identity.example.test/jwks',
  clientId: 'client',
  redirectUri: 'https://api.example.test/v1/auth/oidc/callback',
  scopes: ['openid'],
  allowedAlgorithms: ['RS256'],
  timeoutMillis: 1_000,
  transactionTtlMillis: 300_000,
  allowInsecureHttpForTests: false,
};
const transactions = {
  create: () => Promise.resolve(),
  consume: () => Promise.resolve({ status: 'missing' as const }),
};

function betterAuth(
  mailMode: 'local' | 'durable' | 'disabled',
): NonNullable<ApiIdentityConfig['betterAuth']> {
  return {
    secret: 'composition-runtime-secret-at-least-32-characters',
    mailMode,
    providers: {},
  };
}

function compose(
  input: Partial<Parameters<typeof composeBetterAuthRuntime>[0]> & {
    betterAuth: NonNullable<ApiIdentityConfig['betterAuth']>;
  },
) {
  const acquired: unknown[] = [];
  const runtime = composeBetterAuthRuntime({
    config: {
      publicWebOrigin: 'https://app.example.test',
      session,
      betterAuth: input.betterAuth,
    },
    databaseConfig,
    runtime: undefined,
    transactions: undefined,
    provider: undefined,
    authenticationMail: undefined,
    acquire: (resource) => {
      acquired.push(resource);
      return resource;
    },
    ...input,
  });
  return { runtime, acquired };
}

afterEach(() => {
  created.length = 0;
});

describe('Better Auth runtime composition', () => {
  it('lets an injected mailer win over the configured mail mode', () => {
    const mail: AuthenticationMail = {
      sendVerification: () => Promise.resolve(),
      sendPasswordReset: () => Promise.resolve(),
      sendEmailChangeConfirmation: () => Promise.resolve(),
    };

    const { runtime, acquired } = compose({
      betterAuth: betterAuth('durable'),
      authenticationMail: mail,
    });

    expect(created).toHaveLength(1);
    expect(created[0]?.mail).toBe(mail);
    expect(created[0]).toMatchObject({
      baseUrl: 'https://app.example.test',
      trustedOrigins: ['https://app.example.test'],
      secureCookies: true,
      sessionTtlSeconds: 90,
    });
    expect(created[0]?.legacyOidc).toBeUndefined();
    expect(acquired).toEqual([runtime]);
  });

  it('refuses authentication mail delivery when mail is disabled', () => {
    compose({ betterAuth: betterAuth('disabled') });

    expect(created[0]?.mail).toBe(disabledAuthenticationMail);
  });

  it('seals durable mail with the configured key and owns its enqueue store', async () => {
    const { runtime, acquired } = compose({
      betterAuth: {
        ...betterAuth('durable'),
        durableMail: {
          fromEmail: 'security@example.test',
          encryption: {
            current: {
              version: 'auth-mail-v7',
              key: Buffer.alloc(32, 9).toString('base64'),
            },
            previous: [],
          },
        },
      },
    });

    const mail = created[0]?.mail;
    expect(mail).toBeInstanceOf(DurableAuthenticationMail);
    const prepared = mail?.prepareProof?.({
      purpose: 'verification',
      recipient: 'person@example.test',
      displayName: 'Person',
      url: 'https://app.example.test/v1/auth/verify-email?token=proof',
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(prepared?.sealedPayload.keyVersion).toBe('auth-mail-v7');
    expect(prepared?.sealedPayload.ciphertext).not.toContain('person@');
    expect(acquired).toHaveLength(2);
    expect(acquired[1]).toBe(runtime);
    await (acquired[0] as { close(): Promise<void> }).close();
  });

  it('fails before creating a runtime when durable mail has no settings', () => {
    expect(() => compose({ betterAuth: betterAuth('durable') })).toThrow(
      'Durable authentication mail is not configured',
    );
    expect(created).toEqual([]);
  });

  it('serves the legacy OIDC origin and binds legacy proof to its migration callback', () => {
    compose({
      betterAuth: betterAuth('local'),
      config: { oidc, session, betterAuth: betterAuth('local') },
      transactions,
    });

    const config = created[0];
    expect(config?.baseUrl).toBe('https://api.example.test');
    expect(config?.trustedOrigins).toEqual(['https://api.example.test']);
    expect(config?.legacyOidc?.configuration).toEqual({
      issuer: oidc.issuer,
      authorizationEndpoint: oidc.authorizationEndpoint,
      clientId: oidc.clientId,
      redirectUri:
        'https://api.example.test/v1/auth/legacy-migration/oidc/callback',
      scopes: oidc.scopes,
      transactionTtlMillis: oidc.transactionTtlMillis,
    });
    expect(config?.legacyOidc?.transactions).toBe(transactions);
    expect(config?.legacyOidc?.provider).toBeInstanceOf(
      GenericOidcProviderAdapter,
    );
  });

  it('requires a browser origin for Better Auth', () => {
    expect(() =>
      compose({
        betterAuth: betterAuth('local'),
        config: { session, betterAuth: betterAuth('local') },
      }),
    ).toThrow('Identity public web origin is not configured');
    expect(created).toEqual([]);
  });
});
